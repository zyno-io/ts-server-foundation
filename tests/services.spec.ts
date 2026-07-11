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

class InMemoryMeshClientBackend<TMeta> implements MeshClientRegistryBackend<TMeta> {
    readonly clients = new Map<string, { nodeId: number; connectedAt: number; metadata: TMeta }>();

    async register(clientId: string, nodeId: number, metadata: TMeta): Promise<{ status: 'ok'; supersededNodeId: number | null }> {
        const existing = this.clients.get(clientId);
        this.clients.set(clientId, { nodeId, connectedAt: Date.now(), metadata });
        return {
            status: 'ok',
            supersededNodeId: existing && existing.nodeId !== nodeId ? existing.nodeId : null
        };
    }

    async reserve(clientId: string, nodeId: number, metadata: TMeta): Promise<{ status: 'ok'; supersededNodeId: number | null }> {
        return this.register(clientId, nodeId, metadata);
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        this.clients.set(clientId, {
            nodeId,
            connectedAt: this.clients.get(clientId)?.connectedAt ?? Date.now(),
            metadata
        });
        return true;
    }

    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        if (this.clients.get(clientId)?.nodeId !== nodeId) return false;
        this.clients.delete(clientId);
        return true;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId) return false;
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

        void defaultPrefixApp;
    });

    it('delegates MeshClientRegistry operations with its bound node id', async () => {
        const backend = new InMemoryMeshClientBackend<MeshRegistryTestMeta>();
        const registry = new MeshClientRegistry<MeshRegistryTestMeta>(7, backend);

        await registry.register('client-1', { role: 'admin' });
        assert.deepStrictEqual(await registry.getClient('client-1'), {
            clientId: 'client-1',
            nodeId: 7,
            connectedAt: (await registry.getClient('client-1'))?.connectedAt,
            metadata: { role: 'admin' }
        });

        assert.equal(await registry.updateMetadata('client-1', { role: 'user' }), true);
        assert.deepStrictEqual(
            (await registry.listClientsForNode()).map(client => client.clientId),
            ['client-1']
        );
        assert.equal(await registry.unregister('client-1'), true);
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

    it('reports logged errors to Sentry and alert logs to Slack with DKSF-compatible context', async () => {
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
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://hooks.slack.test/services/test');
        const webhookBody = JSON.parse((fetchMock.mock.calls[0].arguments[1] as RequestInit).body as string);
        assert.match(webhookBody.text, /alerted/);
        assert.equal(webhookBody.attachments[0].fields.find((field: { title: string }) => field.title === 'Scope').value, 'ReporterScope');
        assert.match(webhookBody.attachments[0].fields.find((field: { title: string }) => field.title === 'Alert Data').value, /456/);
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
