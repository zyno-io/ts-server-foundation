import { entity, PrimaryKey } from '../src';
import createDebug from 'debug';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import {
    BaseEntity,
    BaseDatabase,
    createApp,
    createLogger,
    createPersistedEntity,
    DatabaseDriver,
    DecoratedError,
    DriverConnection,
    Env,
    ExecuteResult,
    ExtendedLogger,
    LeaderService,
    Logger,
    LoggerLevel,
    LogEntry,
    MailService,
    MeshBroadcastIndeterminateDeliveryError,
    MeshService,
    MeshClientService,
    MeshClientRegistry,
    type MeshClientRegistryBackend,
    QueryResult,
    resetLogSink,
    ScopedLogger,
    setGlobalErrorReporter,
    setLogSink,
    withLoggerContext
} from '../src';
import type { RenderedSql } from '../src';
import { installSentry, resetSentryForTests } from '../src/telemetry/sentry';

const requireFromTest = createRequire(__filename);
const Sentry = requireFromTest('@sentry/node') as {
    captureException: (error: unknown, context?: unknown) => string;
};

afterEach(() => {
    resetLogSink();
    setGlobalErrorReporter(() => {});
    resetSentryForTests();
    delete Env.ALERTS_SLACK_WEBHOOK_URL;
    createDebug.disable();
    mock.restoreAll();
});

class FakeConnection implements DriverConnection {
    constructor(private driver: FakeDriver) {}
    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        this.driver.queries.push(query);
        return { rows: this.driver.rows as T[] };
    }
    async execute(query: RenderedSql): Promise<ExecuteResult> {
        this.driver.executes.push(query);
        return this.driver.executeResult;
    }
    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {}
}

class FakeDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    rows: Record<string, unknown>[] = [{ id: 5 }];
    executeResult: ExecuteResult = { affectedRows: 1 };
    queries: RenderedSql[] = [];
    executes: RenderedSql[] = [];
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        return new FakeConnection(this);
    }
}

@entity.name('service_records')
class ServiceRecord extends BaseEntity {
    id!: number & PrimaryKey;
    name!: string;
}

class ServiceDatabase extends BaseDatabase {
    constructor(readonly fakeDriver: FakeDriver = new FakeDriver()) {
        super(fakeDriver, [ServiceRecord]);
    }
}

interface MeshRegistryTestMeta {
    role: string;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class InMemoryMeshClientBackend<TMeta> implements MeshClientRegistryBackend<TMeta> {
    readonly clients = new Map<string, { nodeId: number; connectionId: string; connectedAt: number; metadata: TMeta }>();

    async register(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        _allowSupersede: boolean,
        connectionId: string
    ): Promise<{ status: 'ok'; supersededNodeId: number | null; supersededConnectionId?: string }> {
        const existing = this.clients.get(clientId);
        this.clients.set(clientId, { nodeId, connectionId, connectedAt: Date.now(), metadata });
        return {
            status: 'ok',
            supersededNodeId: existing && existing.nodeId !== nodeId ? existing.nodeId : null,
            ...(existing && existing.nodeId !== nodeId && existing.connectionId ? { supersededConnectionId: existing.connectionId } : {})
        };
    }

    async reserve(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        connectionId: string
    ): Promise<{ status: 'ok'; supersededNodeId: number | null; supersededConnectionId?: string }> {
        return this.register(clientId, nodeId, metadata, allowSupersede, connectionId);
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId || existing.connectionId !== connectionId) return false;
        this.clients.set(clientId, {
            nodeId,
            connectionId: existing.connectionId,
            connectedAt: existing.connectedAt,
            metadata
        });
        return true;
    }

    async unregister(clientId: string, nodeId: number, connectionId: string): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId || existing.connectionId !== connectionId) return false;
        this.clients.delete(clientId);
        return true;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId || existing.connectionId !== connectionId) return false;
        this.clients.set(clientId, { ...existing, metadata });
        return true;
    }

    async getClient(clientId: string) {
        const existing = this.clients.get(clientId);
        return existing ? { clientId, ...existing } : undefined;
    }

    async listClients() {
        return [...this.clients.entries()].map(([clientId, existing]) => ({ clientId, ...existing }));
    }

    async listClientsForNode(nodeId: number) {
        return (await this.listClients()).filter(client => client.nodeId === nodeId);
    }

    async cleanupNode(nodeId: number) {
        const removed = await this.listClientsForNode(nodeId);
        for (const client of removed) this.clients.delete(client.clientId);
        return removed;
    }
}

describe('services', () => {
    it('uses plain JSON Redis envelopes and validates timer limits', async () => {
        const service = new MeshService('secure-envelope', {
            heartbeatIntervalMs: 1_000,
            nodeTtlMs: 3_000
        }) as any;
        const payload = service.encodeEnvelope({
            requestId: 'request-1',
            senderInstanceId: 1,
            targetInstanceId: 2,
            type: 'test',
            data: { ok: true }
        });
        const envelope = JSON.parse(payload) as Record<string, unknown>;
        assert.equal(envelope.protocolVersion, 2);
        assert.equal('mac' in envelope, false);
        assert.equal('messageSignature' in envelope, false);
        assert.throws(() => new MeshService('invalid-timer', { heartbeatIntervalMs: 1_000, nodeTtlMs: 2_147_483_648 }), /timer/);
    });

    it('delivers broadcasts locally in the exact JSON form sent to Redis', async () => {
        const service = new MeshService<{ changed: { when: Date; value: number } }>('wire-json-broadcast') as any;
        service._instanceId = 1;
        service.running = true;
        service.leaseLost = false;
        service.leaseSafeUntil = Number.POSITIVE_INFINITY;
        service.getPublisher = () => ({ publish: async () => 1 });
        let received: unknown;
        service.registerBroadcastHandler('changed', (data: unknown) => {
            received = data;
        });

        const when = new Date('2026-07-29T12:34:56.000Z');
        await service.broadcast('changed', { when, value: Number.NaN });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(received, { when: when.toJSON(), value: null });
    });

    it('dispatches only valid remote broadcast envelopes', async () => {
        const service = new MeshService<{ refreshed: { key: string } }>('remote-broadcast') as any;
        service._instanceId = 1;
        service.running = true;
        service.generation = 1;
        service.leaseLost = false;
        service.leaseSafeUntil = Number.POSITIVE_INFINITY;
        service.validateIncomingSender = async () => true;
        const received: string[] = [];
        service.registerBroadcastHandler('refreshed', (data: { key: string }) => {
            received.push(data.key);
        });

        await service.handleBroadcastIncoming(
            JSON.stringify({ protocolVersion: 2, broadcast: true, senderInstanceId: 2, type: 'refreshed', data: { key: 'users' } }),
            1
        );
        await service.handleBroadcastIncoming(
            JSON.stringify({ protocolVersion: 2, senderInstanceId: 2, requestId: 'not-a-broadcast', type: 'refreshed', data: { key: 'ignored' } }),
            1
        );
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepEqual(received, ['users']);
    });

    it('fences a mesh lease on its absolute boundary even while renewal remains in flight', async () => {
        const service = new MeshService('hung-heartbeat-fence', {
            heartbeatIntervalMs: 1_000,
            nodeTtlMs: 3_000
        }) as any;
        let fenced = 0;
        service.running = true;
        service.generation = 1;
        service.leaseLost = false;
        service.heartbeatGeneration = 1; // Model a renewal promise that never settles.
        service.leaseSafeUntil = performance.now() + 10;
        service.leaseLostCallback = () => {
            fenced++;
        };

        service.armLeaseSafetyTimer(1);
        await new Promise<void>(resolve => setTimeout(resolve, 30));

        assert.equal(service.running, false);
        assert.equal(service.leaseLost, true);
        assert.equal(fenced, 1);
        assert.throws(() => service.assertLeaseSafe(), /no longer safe/);
    });

    it('fences and relinquishes leadership instead of silently suppressing cleanup at stale-drain saturation', async () => {
        const service = new MeshService('cleanup-drain-saturation', {
            heartbeatIntervalMs: 1_000,
            nodeTtlMs: 3_000
        }) as any;
        let stopped = 0;
        service.running = true;
        service.generation = 9;
        service.leaderEpoch = 4;
        service.leaseLost = false;
        service.leaseSafeUntil = Number.POSITIVE_INFINITY;
        service.leaderService = {
            isLeader: true,
            stop: async () => {
                stopped++;
            }
        };
        for (let index = 0; index < 8; index++) {
            service.cleanupDrains.set(`stale-${index}`, new Promise<void>(() => {}));
        }
        service.startCleanup();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(service.running, false);
        assert.equal(service.leaseLost, true);
        assert.equal(service.leaderService, null);
        assert.equal(stopped, 1);
    });
    it('rejects unsafe mesh-client invocation timers eagerly', async () => {
        const service = new MeshClientService<object>({
            key: 'invalid-invoke-timer',
            clientInvokeFn: async () => undefined
        });
        for (const timeout of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0x80000000]) {
            await assert.rejects(service.invoke('client-1', 'notify', {}, timeout), /safe positive integer/);
        }
    });

    it('registers logger providers by default and scopes injected loggers to the consuming class', async () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        process.env.APP_ENV = 'test';

        class UsesLogger {
            constructor(readonly logger: ScopedLogger) {}

            run() {
                this.logger.info('started', { attempt: 2 });
            }
        }

        const app = createApp({ providers: [UsesLogger] });
        const rootLogger = app.get(ScopedLogger);

        assert.strictEqual(app.get(Logger), app.get(ExtendedLogger));
        assert.strictEqual(rootLogger, app.get(ExtendedLogger));

        await withLoggerContext({ requestId: 'req-1' }, async () => {
            app.get(UsesLogger).logger.scoped('worker', { jobId: 7 }).info('started', { attempt: 2 });
        });

        assert.equal(entries.length, 1);
        assert.equal(entries[0].scope, 'UsesLogger:worker');
        assert.deepStrictEqual(entries[0].data, { requestId: 'req-1', jobId: 7, attempt: 2 });
    });

    it('supports variadic logger calls, level checks, child level inheritance, and app overrides', () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        process.env.APP_ENV = 'test';

        class CustomLogger extends ExtendedLogger {
            constructor() {
                super();
            }
        }

        const app = createApp({
            providers: [{ provide: Logger, useClass: CustomLogger }]
        });
        const logger = new ExtendedLogger();
        logger.level = LoggerLevel.debug2;
        logger.scoped('child').debug2(new Error('boom'), 'failed', { task: 'sync' }, 'again');
        logger.info('keeps err data', { err: 'timeout' });

        assert.equal(app.get(Logger) instanceof CustomLogger, true);
        assert.equal(logger.is(LoggerLevel.debug2), true);
        assert.equal(entries[0].level, LoggerLevel.debug2);
        assert.equal(entries[0].scope, 'child');
        assert.equal(entries[0].message, 'failed');
        assert.ok(entries[0].error instanceof Error);
        assert.equal(entries[0].error.message, 'boom');
        assert.deepStrictEqual(entries[0].data, { arg0: { task: 'sync' }, arg1: 'again' });
        assert.equal(entries[1].error, 'timeout');
        assert.equal(entries[1].data, undefined);
    });

    it('scopes injected loggers to concrete useClass targets and honors ExtendedLogger overrides', () => {
        const entries: LogEntry[] = [];
        const SERVICE = Symbol('service');
        setLogSink(entry => entries.push(entry));
        process.env.APP_ENV = 'test';

        class CustomLogger extends ExtendedLogger {
            constructor() {
                super();
            }
        }

        class ConcreteService {
            constructor(readonly logger: ScopedLogger) {}
            run() {
                this.logger.info('from service');
            }
        }

        const app = createApp({
            providers: [
                { provide: ExtendedLogger, useClass: CustomLogger },
                { provide: SERVICE, useClass: ConcreteService }
            ]
        });

        assert.equal(app.get(ExtendedLogger) instanceof CustomLogger, true);
        (app.get(SERVICE) as ConcreteService).run();

        assert.equal(entries[0].scope, 'ConcreteService');
    });

    it('registers MailService by default and prepares DKSF-compatible message headers', () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            defaultConfig: {
                MAIL_FROM: 'noreply@example.com',
                MAIL_FROM_NAME: 'Example App',
                MAIL_PROVIDER: 'smtp'
            }
        });

        const mail = app.get(MailService);
        const prepared = mail.prepare({
            to: { name: 'Alice', address: 'alice@example.com' },
            replyTo: { name: 'Support', address: 'support@example.com' },
            subject: 'Welcome',
            message: '<p>Hello</p>',
            plainMessage: 'Hello'
        });

        assert.equal(prepared.from, '"Example App (test) " <noreply@example.com>');
        assert.equal(prepared.to, '"Alice" <alice@example.com>');
        assert.equal(prepared.replyTo, '"Support" <support@example.com>');
        assert.equal(prepared.subject, '[test] Welcome');
    });

    it('constructs LeaderService Redis keys from the configured mutex/default Redis prefix', () => {
        process.env.APP_ENV = 'test';
        process.env.REDIS_PREFIX = 'default-prefix';
        const defaultPrefixApp = createApp({});
        const defaultPrefixLeader = new LeaderService('main');
        assert.equal((defaultPrefixLeader as unknown as { key: string }).key, 'default-prefix:leader:main');

        process.env.APP_ENV = 'test';
        process.env.MUTEX_REDIS_PREFIX = 'mutex-prefix';
        createApp({});
        const mutexPrefixLeader = new LeaderService('main');
        assert.equal((mutexPrefixLeader as unknown as { key: string }).key, 'mutex-prefix:leader:main');

        process.env.APP_ENV = 'test';
        process.env.BULL_REDIS_PREFIX = 'bull-prefix';
        createApp({});
        const bullPrefixLeader = new LeaderService('worker-recorder:default', { redisConfigPrefix: 'BULL' });
        assert.equal((bullPrefixLeader as unknown as { key: string }).key, 'bull-prefix:leader:worker-recorder:default');

        void defaultPrefixApp;
    });

    it('delegates MeshClientRegistry operations with its bound node id', async () => {
        const backend = new InMemoryMeshClientBackend<MeshRegistryTestMeta>();
        const registry = new MeshClientRegistry<MeshRegistryTestMeta>(7, backend);

        await registry.register('client-1', { role: 'admin' }, false, 'connection-1');
        assert.deepStrictEqual(await registry.getClient('client-1'), {
            clientId: 'client-1',
            nodeId: 7,
            connectionId: 'connection-1',
            connectedAt: (await registry.getClient('client-1'))?.connectedAt,
            metadata: { role: 'admin' }
        });

        assert.equal(await registry.updateMetadata('client-1', { role: 'user' }, 'connection-1'), true);
        assert.deepStrictEqual(
            (await registry.listClientsForNode()).map(client => client.clientId),
            ['client-1']
        );
        assert.equal(await registry.unregister('client-1', 'connection-1'), true);
        assert.equal(await registry.getClient('client-1'), undefined);
    });

    it('creates scoped loggers without an app and active-record entities through the owned base class', async () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        new ServiceDatabase();

        createLogger('manual', { source: 'test' }).info('hello');
        const entity = await createPersistedEntity(ServiceRecord, { id: 5, name: 'Alice' });
        const reference = ServiceRecord.reference(5);

        assert.equal(entries[0].scope, 'manual');
        assert.deepStrictEqual(entries[0].data, { source: 'test' });
        assert.equal(entity.name, 'Alice');
        assert.equal(reference.id, 5);
    });

    it('matches DKSF message, data, scope, context, and debug log shaping', async () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        process.env.APP_ENV = 'test';

        const logger = new ExtendedLogger('ShapeScope', { shared: 'scope', scopeOnly: true });
        logger.info('<green>hello</green>', { shared: 'message', messageOnly: true });
        logger.info('first', 'second', { third: true });
        logger.debug('hidden debug');
        createDebug.enable('ShapeScope');
        logger.debug('visible debug', { debugData: true });
        await withLoggerContext({ requestId: 'req-1' }, async () => logger.info('context'));

        assert.deepStrictEqual(entries[0], {
            level: LoggerLevel.info,
            levelName: 'info',
            scope: 'ShapeScope',
            message: 'hello',
            data: { shared: 'scope', messageOnly: true, scopeOnly: true },
            error: undefined,
            timestamp: entries[0].timestamp
        });
        assert.deepStrictEqual(entries[1].data, {
            arg0: 'second',
            arg1: { third: true },
            shared: 'scope',
            scopeOnly: true
        });
        assert.equal(entries[2].message, 'visible debug');
        assert.deepStrictEqual(entries[2].data, { debugData: true, shared: 'scope', scopeOnly: true });
        assert.equal(entries[3].data?.requestId, 'req-1');
        assert.equal(entries.length, 4);
    });

    it('matches DKSF error argument extraction and reporter wrapping', () => {
        const entries: LogEntry[] = [];
        const reports: { level: number; error: DecoratedError; context: Record<string, unknown> }[] = [];
        setLogSink(entry => entries.push(entry));
        setGlobalErrorReporter((level, error, context) => reports.push({ level, error: error as DecoratedError, context }));
        process.env.APP_ENV = 'test';

        const logger = new ExtendedLogger('ErrorScope', { scopeId: 7 });
        const cause = new Error('test logger error message');
        const structuredCause = {
            isAxiosError: true,
            code: 'E_HTTP',
            message: 'axios failed',
            stack: 'stack',
            config: { url: '/x' },
            response: { status: 502 }
        };

        logger.error(new Error('something failed'));
        logger.error(cause, 'something failed');
        logger.warn('something failed', cause);
        logger.error('something failed', { err: cause, recordId: 123 });
        logger.error('Controller error', cause);
        logger.alert('alert message');
        logger.error('structured failed', { err: structuredCause });

        assert.equal(entries[0].message, '');
        const firstError = entries[0].error;
        assert.ok(firstError instanceof Error);
        assert.equal(firstError.message, 'something failed');
        assert.deepStrictEqual(entries[0].data, { scopeId: 7 });

        assert.equal(entries[1].message, 'something failed');
        assert.strictEqual(entries[1].error, cause);
        assert.deepStrictEqual(entries[1].data, { scopeId: 7 });

        assert.equal(entries[2].level, LoggerLevel.warning);
        assert.equal(entries[2].message, 'something failed');
        assert.strictEqual(entries[2].error, cause);

        assert.equal(entries[3].message, 'something failed');
        assert.strictEqual(entries[3].error, cause);
        assert.deepStrictEqual(entries[3].data, { recordId: 123, scopeId: 7 });

        assert.equal(reports[0].level, LoggerLevel.error);
        assert.equal(reports[0].error.message, 'something failed');
        assert.equal(reports[0].error.cause, undefined);
        assert.equal(reports[0].context.scope, 'ErrorScope');
        assert.deepStrictEqual(reports[0].context.scopeData, { scopeId: 7 });

        assert.equal(reports[1].error.message, 'something failed');
        assert.strictEqual(reports[1].error.cause, cause);
        assert.equal(reports[2].level, LoggerLevel.warning);
        assert.strictEqual(reports[2].error.cause, cause);
        assert.deepStrictEqual(reports[3].context.data, { recordId: 123, scopeId: 7 });
        assert.strictEqual(reports[4].error, cause);
        assert.equal(reports[4].error.cause, undefined);
        assert.equal(reports[5].level, LoggerLevel.alert);
        assert.equal(reports[5].error.message, 'alert message');
        assert.equal(reports[6].error.message, 'structured failed');
        assert.deepStrictEqual(reports[6].error.cause, {
            code: 'E_HTTP',
            message: 'axios failed',
            stack: 'stack',
            request: {
                url: '/x',
                method: undefined,
                headers: undefined,
                data: undefined
            },
            response: {
                status: 502,
                headers: undefined,
                data: undefined
            }
        });
        assert.equal(reports.length, 7);
    });

    it('sanitizes Axios error diagnostics without mutating the original error', () => {
        const reports: { error: DecoratedError }[] = [];
        setGlobalErrorReporter((_level, error) => reports.push({ error: error as DecoratedError }));
        class FormData {}
        class Readable {
            toJSON(): never {
                throw new Error('streams must not be serialized');
            }
        }
        const headers = {
            toJSON: () => ({
                Authorization: 'Bearer request-token',
                Cookie: 'session=request-cookie',
                'x-request-id': 'request-123',
                'X-Intuit-Tid': 'intuit-123'
            })
        };
        const axiosError = {
            isAxiosError: true,
            message: 'provider rejected request',
            config: {
                url: 'https://client:password@example.test/path?access_token=top-secret&X-Amz-Signature=signed&code=oauth-code&email=person%40example.test&phone=5551234567&keep=visible#access_token=fragment-token',
                method: 'post',
                headers,
                data: JSON.stringify({ token: 'body-token', keep: 'visible', nested: { apiKey: 'nested-key' }, code: 'provider-error-code' })
            },
            response: {
                status: 401,
                headers: { 'set-cookie': 'session=response-cookie', traceparent: '00-abc' },
                data: {
                    message: 'bad credentials',
                    refreshToken: 'response-token',
                    nested: { password: 'secret' },
                    email: 'person@example.test',
                    passcode: '123456',
                    pin: '1234',
                    ssn: '111-22-3333',
                    cardNumber: '4111 1111 1111 1111',
                    code: 'provider-error-code',
                    form: new FormData(),
                    stream: new Readable(),
                    buffer: Buffer.from('secret binary payload')
                }
            }
        };

        new ExtendedLogger('AxiosScope').error('request failed', { err: axiosError });

        const cause = reports[0].error.cause as Record<string, unknown>;
        assert.deepStrictEqual(cause.request, {
            url: 'https://example.test/path?access_token=[REDACTED]&X-Amz-Signature=[REDACTED]&code=[REDACTED]&email=[REDACTED]&phone=[REDACTED]&keep=visible',
            method: 'post',
            headers: { 'x-request-id': 'request-123', 'X-Intuit-Tid': 'intuit-123' },
            data: {
                token: '[REDACTED]',
                keep: 'visible',
                nested: { apiKey: '[REDACTED]' },
                code: 'provider-error-code'
            }
        });
        assert.deepStrictEqual(cause.response, {
            status: 401,
            headers: { traceparent: '00-abc' },
            data: {
                message: 'bad credentials',
                refreshToken: '[REDACTED]',
                nested: { password: '[REDACTED]' },
                email: '[REDACTED]',
                passcode: '[REDACTED]',
                pin: '[REDACTED]',
                ssn: '[REDACTED]',
                cardNumber: '[REDACTED]',
                code: 'provider-error-code',
                form: '[FormData]',
                stream: '[Readable]',
                buffer: '[Buffer]'
            }
        });
        assert.equal((axiosError.config.headers.toJSON() as Record<string, string>).Authorization, 'Bearer request-token');
        assert.equal(axiosError.config.data.includes('body-token'), true);

        new ExtendedLogger('AxiosScope').error('request failed', {
            err: { isAxiosError: true, message: 'provider rejected request', config: { url: 'http://[invalid#access_token=fragment-token' } }
        });
        const malformedUrlCause = reports[1].error.cause as { request: { url: string } };
        assert.equal(malformedUrlCause.request.url, 'http://[invalid');
    });

    it('bounds Axios error payload output without traversing every property', () => {
        const reports: { error: DecoratedError }[] = [];
        setGlobalErrorReporter((_level, error) => reports.push({ error: error as DecoratedError }));
        const payload: Record<string, string> = {};
        for (let index = 0; index < 1_000; index++) payload[`property-${index}`] = 'x'.repeat(4_096);

        new ExtendedLogger('AxiosScope').error('request failed', {
            err: { isAxiosError: true, message: 'provider rejected request', response: { data: payload } }
        });

        const cause = reports[0].error.cause as { response: { data: Record<string, unknown> } };
        assert.equal(cause.response.data._truncated, 'additional properties');
        assert.ok(JSON.stringify(cause).length <= 33_000);
    });

    it('does not retain an unparsed oversized JSON-looking Axios body', () => {
        const reports: { error: DecoratedError }[] = [];
        setGlobalErrorReporter((_level, error) => reports.push({ error: error as DecoratedError }));
        const secret = 'very-sensitive-token';
        const oversizedJson = `{"token":"${secret}","padding":"${'x'.repeat(33_000)}"}`;

        new ExtendedLogger('AxiosScope').error('request failed', {
            err: { isAxiosError: true, message: 'provider rejected request', config: { data: oversizedJson } }
        });

        const cause = reports[0].error.cause as { request: { data: string } };
        assert.equal(cause.request.data, `[TRUNCATED JSON body: ${oversizedJson.length} chars]`);
        assert.equal(JSON.stringify(cause).includes(secret), false);
    });

    it('does not retain malformed JSON-looking Axios bodies', () => {
        const reports: { error: DecoratedError }[] = [];
        setGlobalErrorReporter((_level, error) => reports.push({ error: error as DecoratedError }));
        const malformedJson = '{"password":"very-sensitive-token",';

        new ExtendedLogger('AxiosScope').error('request failed', {
            err: { isAxiosError: true, message: 'provider rejected request', config: { data: malformedJson } }
        });

        const cause = reports[0].error.cause as { request: { data: string } };
        assert.equal(cause.request.data, '[UNPARSEABLE JSON body]');
        assert.equal(JSON.stringify(cause).includes('very-sensitive-token'), false);
    });

    it('reports logged errors to Sentry and suppresses Slack alerts in test environments', async () => {
        const capture = mock.method(Sentry, 'captureException', () => 'event-id');
        const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
        Env.ALERTS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/test';
        installSentry({ dsn: 'https://public@example.com/1', enabled: false });
        process.env.APP_ENV = 'test';

        const logger = new ExtendedLogger('ReporterScope', { scopeId: 7 });
        await withLoggerContext({ requestId: 'req-1' }, async () => logger.error('reported', new Error('cause'), { recordId: 123 }));
        logger.alert('alerted', { alertId: 456 });
        await new Promise(resolve => setImmediate(resolve));

        const firstCaptureError = capture.mock.calls[0].arguments[0] as Error;
        const firstCaptureContext = capture.mock.calls[0].arguments[1] as Record<string, unknown>;
        const secondCaptureContext = capture.mock.calls[1].arguments[1] as Record<string, unknown>;
        assert.equal(capture.mock.callCount(), 2);
        assert.equal(firstCaptureError.message, 'reported');
        assert.deepStrictEqual(firstCaptureContext, {
            tags: {},
            extra: {
                Details: {
                    data: { recordId: 123, scopeId: 7 },
                    scope: 'ReporterScope',
                    scopeData: { scopeId: 7 },
                    requestId: 'req-1',
                    loggerContext: {}
                }
            },
            level: 'error'
        });
        assert.equal(secondCaptureContext.level, 'fatal');
        assert.equal(fetchMock.mock.callCount(), 0);
    });

    it('uses the DKSF pino-pretty configuration in enabled test mode', () => {
        const result = spawnSync(
            process.execPath,
            [
                '-e',
                `
                const foundation = require(${JSON.stringify(join(process.cwd(), 'dist/src'))});
                foundation.createLogger('PrettyScope').info('hello pretty', { answer: 42 });
                foundation.pinoLogger.flush?.();
                `
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    APP_ENV: 'test',
                    ENABLE_PINO_PRETTY: 'true',
                    ENABLE_PINO_SINGLE_LINE: 'true'
                }
            }
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /INFO/);
        assert.match(result.stdout, new RegExp(`${result.pid} `));
        assert.match(result.stdout, /PrettyScope/);
        assert.match(result.stdout, /hello pretty/);
        assert.doesNotMatch(result.stdout, /"scope"/);
    });

    it('emits DKSF-style JSON log records when pino-pretty is disabled', () => {
        const result = spawnSync(
            process.execPath,
            [
                '-e',
                `
                const foundation = require(${JSON.stringify(join(process.cwd(), 'dist/src'))});
                foundation.createLogger('JsonScope').log('notice json', { answer: 42 });
                foundation.pinoLogger.flush?.();
                `
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    APP_ENV: 'production',
                    ENABLE_PINO_PRETTY: 'false'
                }
            }
        );

        assert.equal(result.status, 0, result.stderr);
        const record = JSON.parse(result.stdout.trim());
        assert.equal(record.severity, 'NOTICE');
        assert.equal(record.message, 'notice json');
        assert.equal(record.scope, 'JsonScope');
        assert.equal(record.answer, 42);
        assert.equal('pid' in record, false);
        assert.equal('hostname' in record, false);
        assert.equal('timestamp' in record, false);
    });

    it('emits DKSF-style JSON error records when pino-pretty is disabled', () => {
        const result = spawnSync(
            process.execPath,
            [
                '-e',
                `
                const foundation = require(${JSON.stringify(join(process.cwd(), 'dist/src'))});
                foundation.createLogger('JsonErrorScope').error(new Error('json failed'));
                foundation.pinoLogger.flush?.();
                `
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    APP_ENV: 'production',
                    ENABLE_PINO_PRETTY: 'false'
                }
            }
        );

        assert.equal(result.status, 0, result.stderr);
        const record = JSON.parse(result.stdout.trim());
        assert.equal(record.severity, 'ERROR');
        assert.equal(record.message, '');
        assert.equal(record.scope, 'JsonErrorScope');
        assert.equal(record.err.message, 'json failed');
        assert.match(record.err.stack, /json failed/);
    });

    it('serializes validation errors without recursing through their self-referential error list', () => {
        const result = spawnSync(
            process.execPath,
            [
                '-e',
                `
                const foundation = require(${JSON.stringify(join(process.cwd(), 'dist/src'))});
                const error = new foundation.ValidatorError('required', 'The value cannot be null.', 'data.0.vanity_format');
                foundation.createLogger('ValidationScope').error(error);
                foundation.pinoLogger.flush?.();
                `
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    APP_ENV: 'production',
                    ENABLE_PINO_PRETTY: 'false'
                }
            }
        );

        assert.equal(result.status, 0, result.stderr);
        const record = JSON.parse(result.stdout.trim());
        assert.equal(record.severity, 'ERROR');
        assert.equal(record.err.type, 'ValidatorError');
        assert.equal(record.err.code, 'required');
        assert.equal(record.err.path, 'data.0.vanity_format');
        assert.equal(record.err.message, 'The value cannot be null.');
    });

    it('keeps non-request logs visible in test mode', () => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            APP_ENV: 'test',
            ENABLE_PINO_PRETTY: 'false'
        };

        const result = spawnSync(
            process.execPath,
            [
                '-e',
                `
                const foundation = require(${JSON.stringify(join(process.cwd(), 'dist/src'))});
                foundation.createLogger('TestModeScope').info('hidden info', { hidden: true });
                foundation.createLogger('TestModeScope').error(new Error('visible error'), { payload: { id: 12 } });
                foundation.pinoLogger.flush?.();
                `
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env
            }
        );

        assert.equal(result.status, 0, result.stderr);
        const records = result.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line));
        assert.equal(records.length, 2);
        assert.equal(records[0].severity, 'INFO');
        assert.equal(records[0].scope, 'TestModeScope');
        assert.equal(records[0].message, 'hidden info');
        assert.equal(records[0].hidden, true);
        assert.equal(records[1].severity, 'ERROR');
        assert.equal(records[1].scope, 'TestModeScope');
        assert.equal(records[1].err.message, 'visible error');
        assert.deepEqual(records[1].payload, { id: 12 });
    });
});
