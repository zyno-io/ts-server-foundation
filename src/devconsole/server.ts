import type { Server } from 'node:http';

import { BaseDatabase, getEntityMetadata, renderSql, sql } from '../database';
import { HealthcheckService } from '../health';
import { getPackageName, getPackageVersion, safeJsonStringify } from '../helpers';
import { WorkerQueueRegistry, WorkerRecorderService, type WorkerJobRecord } from '../services/worker';
import type { ScopedLogger } from '../services';
import { SrpcServer, type SrpcMeta } from '../srpc';
import type { App } from '../app';
import type { Token } from '../di';
import {
    DevConsoleClientMessage,
    DevConsoleServerMessage,
    type UReplCompleteItem,
    type DevConsoleClientMessage as DCClientMsg,
    type DevConsoleServerMessage as DCServerMsg
} from './generated/devconsole';
import { isLocalhostIncomingMessage } from './security';
import { createReplContext, evaluateReplCode } from './repl';
import type { DevConsoleStore } from './store';

const SECRET_MASK_PATTERNS = ['SECRET', 'PASSWORD', 'DSN', 'TOKEN', 'KEY'];

export class DevConsoleSrpcServer {
    private readonly server: SrpcServer<SrpcMeta, DCClientMsg, DCServerMsg>;
    private readonly replContext: Record<string, unknown>;

    constructor(
        private readonly app: App<any>,
        private readonly store: DevConsoleStore,
        logger: ScopedLogger,
        httpServer: Server
    ) {
        this.replContext = createReplContext(app);
        this.server = new SrpcServer<SrpcMeta, DCClientMsg, DCServerMsg>({
            logger,
            clientMessage: DevConsoleClientMessage,
            serverMessage: DevConsoleServerMessage,
            wsPath: '/_devconsole/ws',
            httpServer,
            logLevel: false
        });
        this.server.setClientAuthorizer((_meta, req) => (isLocalhostIncomingMessage(req) ? { devconsole: true } : false));
        this.registerHandlers();
    }

    close(): void {
        this.server.close();
    }

    private registerHandlers(): void {
        this.server.registerMessageHandler('uReplEval', async (_stream, data) => this.handleReplEval(data.code));
        this.server.registerMessageHandler('uReplComplete', (_stream, data) => this.handleReplComplete(data.code, data.cursorPos));
        this.server.registerMessageHandler('uGetOverview', () => ({
            name: getPackageName() ?? '',
            version: getPackageVersion() ?? '',
            uptime: Date.now() - this.store.startedAt,
            env: this.app.config.APP_ENV,
            httpEntries: this.store.httpEntries.length,
            srpcMessages: this.store.srpcMessages.length,
            srpcActiveConnections: this.store.srpcConnections.size,
            srpcDisconnected: this.store.srpcDisconnected.length
        }));
        this.server.registerMessageHandler('uGetProcess', () => {
            const mem = process.memoryUsage();
            const cpu = process.cpuUsage();
            return {
                pid: process.pid,
                rss: mem.rss,
                heapTotal: mem.heapTotal,
                heapUsed: mem.heapUsed,
                external: mem.external,
                arrayBuffers: mem.arrayBuffers,
                cpuUser: cpu.user,
                cpuSystem: cpu.system,
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            };
        });
        this.server.registerMessageHandler('uGetEnv', () => ({
            jsonData: safeJsonStringify(maskSecrets(this.app.config as unknown as Record<string, unknown>))
        }));
        this.server.registerMessageHandler('uGetRequests', () => ({
            jsonData: safeJsonStringify(this.store.httpEntries.toArray().reverse())
        }));
        this.server.registerMessageHandler('uGetRoutes', () => ({
            routes: this.app.router
                .listRoutes()
                .filter(route => !route.path.startsWith('/_devconsole'))
                .map(route => ({
                    methods: [route.method],
                    path: route.path,
                    controller: route.controllerClass.name,
                    methodName: route.methodName
                }))
        }));
        this.server.registerMessageHandler('uGetSrpc', () => ({
            jsonData: safeJsonStringify({
                active: [...this.store.srpcConnections.values()],
                recentDisconnections: this.store.srpcDisconnected.toArray().reverse()
            })
        }));
        this.server.registerMessageHandler('uGetSrpcMessages', (_stream, data) => {
            let messages = this.store.srpcMessages.toArray();
            if (data.streamId) messages = messages.filter(message => message.streamId === data.streamId);
            return { jsonData: safeJsonStringify(messages.reverse()) };
        });
        this.server.registerMessageHandler('uGetWorkers', () => this.getWorkers());
        this.server.registerMessageHandler('uGetWorkersJobs', () => this.getWorkerJobs());
        this.server.registerMessageHandler('uGetDatabaseEntities', () => this.getDatabaseEntities());
        this.server.registerMessageHandler('uDatabaseQuery', (_stream, data) => this.runDatabaseQuery(data.sql));
        this.server.registerMessageHandler('uGetHealthChecks', async () => ({
            jsonData: safeJsonStringify((await tryGet(this.app, HealthcheckService)?.checkIndividual()) ?? [])
        }));
        this.server.registerMessageHandler('uGetDatabaseQueries', () => ({
            jsonData: safeJsonStringify(this.store.dbQueries.toArray().reverse())
        }));
        this.server.registerMessageHandler('uClearDatabaseQueries', () => {
            this.store.clearDatabaseQueries();
            this.broadcast('db:cleared', {});
            return {};
        });
        this.server.registerMessageHandler('uClearRequests', () => {
            this.store.clearHttpEntries();
            this.broadcast('http:cleared', {});
            return {};
        });
        this.server.registerMessageHandler('uClearSrpcMessages', () => {
            this.store.clearSrpcMessages();
            this.broadcast('srpc:cleared', {});
            return {};
        });
        this.server.registerMessageHandler('uGetMutexes', () => ({
            jsonData: safeJsonStringify({
                active: [...this.store.activeMutexes.values()],
                history: this.store.mutexEntries.toArray().reverse()
            })
        }));
    }

    private async getWorkers(): Promise<{ jsonData: string }> {
        const registry = tryGet(this.app, WorkerQueueRegistry);
        if (!registry) return { jsonData: safeJsonStringify({}) };

        if (registry.usesBullMq()) {
            const result: Record<string, unknown> = {};
            for (const { name, queue } of registry.getBullQueues()) {
                try {
                    result[name] = await queue.getJobCounts();
                } catch {
                    result[name] = { error: 'Failed to fetch job counts' };
                }
            }
            return { jsonData: safeJsonStringify(result) };
        }

        const result: Record<string, Record<string, number>> = {};
        for (const job of registry.getAllQueuedJobs()) {
            const counts = (result[job.queue] ??= {});
            counts[job.status] = (counts[job.status] ?? 0) + 1;
        }
        return { jsonData: safeJsonStringify(result) };
    }

    private async getWorkerJobs(): Promise<{ jsonData: string }> {
        const registry = tryGet(this.app, WorkerQueueRegistry);
        const recorder = tryGet(this.app, WorkerRecorderService);
        const live = registry ? await this.getLiveWorkerJobs(registry) : [];
        const history = recorder ? recorder.getRecords().map(recordToWorkerJob).reverse().slice(0, 200) : [];
        return { jsonData: safeJsonStringify({ live, history }) };
    }

    private async getLiveWorkerJobs(registry: WorkerQueueRegistry): Promise<unknown[]> {
        if (!registry.usesBullMq()) {
            return registry.getAllQueuedJobs().map(job => ({
                id: `${job.queue}:${job.id}`,
                queue: job.queue,
                queueId: job.id,
                name: job.name,
                data: job.data,
                status: job.shouldExecuteAt.getTime() > Date.now() ? 'delayed' : 'waiting',
                attempt: job.attemptsMade,
                createdAt: job.createdAt.getTime(),
                shouldExecuteAt: job.shouldExecuteAt.getTime(),
                executedAt: null
            }));
        }

        const live: unknown[] = [];
        for (const { name: queueName, queue } of registry.getBullQueues()) {
            try {
                const [active, waiting, delayed] = await Promise.all([queue.getActive(), queue.getWaiting(), queue.getDelayed()]);
                for (const job of active) live.push(bullJobToDevConsoleJob(queueName, job, 'active'));
                for (const job of waiting) live.push(bullJobToDevConsoleJob(queueName, job, 'waiting'));
                for (const job of delayed) live.push(bullJobToDevConsoleJob(queueName, job, 'delayed'));
            } catch {
                // A queue can disappear or Redis can be unavailable while the panel is open.
            }
        }
        return live;
    }

    private getDatabaseEntities(): {
        entities: Array<{ name: string; table: string; columns: string[]; quotedTable: string }>;
    } {
        const db = tryGet(this.app, BaseDatabase);
        if (!db) return { entities: [] };

        const entities = db.entityRegistry
            .map(entity => {
                const metadata = getEntityMetadata(entity);
                return {
                    name: metadata.classType.name,
                    table: metadata.tableName,
                    columns: metadata.columns.map(column => column.propertyName),
                    quotedTable: renderSql(sql`${sql.identifier(metadata.tableName)}`, db.driver.dialect).sql
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        return { entities };
    }

    private async runDatabaseQuery(text: string): Promise<{
        columns: string[];
        rows: Array<{ values: string[] }>;
        rowCount: number;
        affectedRows?: number;
        error?: string;
    }> {
        const db = tryGet(this.app, BaseDatabase);
        if (!db) return { columns: [], rows: [], rowCount: 0, error: 'No database is configured' };

        const query = text.trim();
        if (!query) return { columns: [], rows: [], rowCount: 0, error: 'Empty query' };

        try {
            if (/^\s*(select|show|describe|explain|with)\b/i.test(query)) {
                const rawRows = await db.rawFindUnsafe<Record<string, unknown>>(query);
                const columns = rawRows[0] ? Object.keys(rawRows[0]) : [];
                const rows = rawRows.map(row => ({
                    values: columns.map(column => stringifyCell(row[column]))
                }));
                return { columns, rows, rowCount: rawRows.length };
            }

            const result = await db.rawExecuteUnsafe(query);
            return {
                columns: [],
                rows: [],
                rowCount: result.rowCount ?? result.affectedRows,
                affectedRows: result.affectedRows
            };
        } catch (error) {
            return {
                columns: [],
                rows: [],
                rowCount: 0,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private async handleReplEval(code: string): Promise<{ output: string; error?: string }> {
        return evaluateReplCode(this.replContext, code);
    }

    private handleReplComplete(code: string, cursorPos: number): { items: UReplCompleteItem[]; replaceStart: number; replaceEnd: number } {
        const beforeCursor = code.slice(0, cursorPos);
        const match = beforeCursor.match(/((?:\$|r|resolve|app|config|db|container|[a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*)*(?:\.\w*)?)$/);
        if (!match) return { items: [], replaceStart: cursorPos, replaceEnd: cursorPos };

        const fullExpression = match[1];
        const parts = fullExpression.split('.');
        const prefix = parts.pop() ?? '';
        const replaceStart = cursorPos - prefix.length;

        if (parts.length === 0) {
            return {
                items: completeTopLevel(this.replContext, prefix),
                replaceStart,
                replaceEnd: cursorPos
            };
        }

        const target = this.resolveReplExpression(parts.join('.'));
        return {
            items: target == null ? [] : collectProperties(target, prefix).slice(0, 50),
            replaceStart,
            replaceEnd: cursorPos
        };
    }

    private resolveReplExpression(expression: string): unknown {
        try {
            const fn = new Function('context', `with (context) { return ${expression} }`);
            return fn(this.replContext);
        } catch {
            return undefined;
        }
    }

    broadcast(type: string, data: unknown): void {
        const jsonData = safeJsonStringify(data);
        for (const stream of this.server.streamsByClientId.values()) {
            this.server.invoke(stream, 'dEvent', { type, jsonData }).catch(() => {});
        }
    }
}

function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
        const upper = key.toUpperCase();
        masked[key] = SECRET_MASK_PATTERNS.some(pattern => upper.includes(pattern)) ? '****' : value;
    }
    return masked;
}

function tryGet<T>(app: App<any>, token: Token<T>): T | undefined {
    try {
        return app.get(token);
    } catch {
        return undefined;
    }
}

function completeTopLevel(context: Record<string, unknown>, prefix: string): UReplCompleteItem[] {
    const globals = [
        ...Object.keys(context),
        'console',
        'process',
        'Buffer',
        'Promise',
        'JSON',
        'Math',
        'Date',
        'Array',
        'Object',
        'String',
        'Number',
        'Boolean',
        'Map',
        'Set',
        'RegExp',
        'Error',
        'undefined',
        'null',
        'true',
        'false',
        'async',
        'await'
    ];
    return [...new Set(globals)]
        .filter(label => label.startsWith(prefix))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 50)
        .map(label => ({ label, kind: Object.hasOwn(context, label) ? 'context' : 'global' }));
}

export function collectProperties(value: unknown, prefix: string): UReplCompleteItem[] {
    const seen = new Set<string>();
    const items: UReplCompleteItem[] = [];
    let current = value;

    while (current != null) {
        for (const name of Object.getOwnPropertyNames(current)) {
            if (!name.startsWith(prefix) || seen.has(name) || name.startsWith('__')) continue;
            seen.add(name);
            let kind = 'property';
            try {
                const descriptor = Object.getOwnPropertyDescriptor(current, name);
                if (typeof descriptor?.value === 'function') kind = 'method';
                else if (descriptor?.get || descriptor?.set) kind = 'accessor';
            } catch {
                // Ignore exotic property descriptors.
            }
            items.push({ label: name, kind });
        }
        current = Object.getPrototypeOf(current);
        if (current === Object.prototype) break;
    }

    return items.sort((a, b) => a.label.localeCompare(b.label));
}

function bullJobToDevConsoleJob(
    queueName: string,
    job: {
        id?: string | number;
        name: string;
        data: unknown;
        timestamp: number;
        opts: { delay?: number };
        attemptsMade: number;
        processedOn?: number;
    },
    status: string
): unknown {
    const data = isBullWorkerJobData(job.data) ? job.data.data : job.data;
    return {
        id: `${queueName}:${job.id ?? ''}`,
        queue: queueName,
        queueId: String(job.id ?? ''),
        name: job.name,
        data,
        status,
        attempt: job.attemptsMade,
        createdAt: job.timestamp,
        shouldExecuteAt: job.timestamp + (job.opts.delay ?? 0),
        executedAt: job.processedOn ?? null
    };
}

function isBullWorkerJobData(value: unknown): value is { data: unknown } {
    return !!value && typeof value === 'object' && 'data' in value;
}

function recordToWorkerJob(record: WorkerJobRecord): unknown {
    return {
        id: record.id,
        queue: record.queue,
        queueId: record.queueId,
        name: record.name,
        data: record.data,
        status: record.status,
        result: record.result,
        attempt: record.attempt,
        traceId: record.traceId,
        createdAt: record.createdAt.getTime(),
        shouldExecuteAt: record.shouldExecuteAt.getTime(),
        executedAt: record.executedAt.getTime(),
        completedAt: record.completedAt.getTime()
    };
}

function stringifyCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('base64');
    return typeof value === 'object' ? safeJsonStringify(value) : String(value);
}
