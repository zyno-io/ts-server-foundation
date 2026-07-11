import { ws } from './ws';

export interface OverviewData {
    name: string;
    version: string;
    uptime: number;
    env: string;
    counts: {
        httpEntries: number;
        srpcMessages: number;
        srpcActiveConnections: number;
        srpcDisconnected: number;
    };
}

export interface ErrorInfo {
    name: string;
    message: string;
    stack?: string;
    cause?: ErrorInfo;
    [key: string]: unknown;
}

export interface HttpEntry {
    id: string;
    timestamp: number;
    method: string;
    url: string;
    remoteAddress: string;
    requestHeaders: Record<string, string | string[] | undefined>;
    requestBody: string | null;
    statusCode: number;
    responseHeaders: Record<string, string | string[] | undefined>;
    responseBody: string | null;
    durationMs: number;
    error?: ErrorInfo;
}

export interface SrpcConnection {
    streamId: string;
    clientId: string;
    clientStreamId: string;
    appVersion: string;
    address: string;
    connectedAt: number;
    lastPingAt: number;
    meta: Record<string, unknown>;
    messageCount: number;
}

export interface SrpcDisconnection {
    streamId: string;
    clientId: string;
    disconnectedAt: number;
    cause: string;
}

export interface SrpcData {
    active: SrpcConnection[];
    recentDisconnections: SrpcDisconnection[];
}

export interface SrpcMessage {
    id: string;
    timestamp: number;
    streamId: string;
    clientId: string;
    direction: 'inbound' | 'outbound';
    messageType: string;
    isReply: boolean;
    data: Record<string, unknown>;
    error?: string;
    isUserError?: boolean;
}

export interface RouteInfo {
    methods: string[];
    path: string;
    controller?: string;
    methodName?: string;
}

export interface ProcessInfo {
    pid: number;
    memory: {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    };
    cpu: {
        user: number;
        system: number;
    };
    uptime: number;
    nodeVersion: string;
    platform: string;
    arch: string;
}

export interface WorkerJob {
    id: string;
    queue: string;
    queueId: string;
    name: string;
    data: unknown;
    status: 'active' | 'waiting' | 'delayed' | 'completed' | 'failed';
    result?: unknown;
    attempt: number;
    traceId?: string | null;
    createdAt: number;
    shouldExecuteAt: number;
    executedAt: number | null;
    completedAt?: number | null;
}

export interface WorkerJobsData {
    live: WorkerJob[];
    history: WorkerJob[];
}

export interface EntityInfo {
    name: string;
    table: string;
    columns: string[];
    quotedTable: string;
}

export interface QueryResult {
    columns: string[];
    rows: Record<string, string>[];
    rowCount: number;
    affectedRows?: number;
    error?: string;
}

export interface HealthCheckResult {
    name: string;
    status: 'ok' | 'error';
    error?: string;
}

export interface MutexEntry {
    id: string;
    key: string;
    status: 'pending' | 'acquired' | 'released' | 'error' | 'failed';
    startedAt: number;
    acquiredAt?: number;
    releasedAt?: number;
    durationMs?: number;
    waitDurationMs?: number;
    waited?: boolean;
    error?: string;
}

export interface MutexData {
    active: MutexEntry[];
    history: MutexEntry[];
}

export interface DatabaseQueryEntry {
    id: string;
    timestamp: number;
    sql: string;
    params: unknown[];
    status: 'running' | 'ok' | 'error';
    durationMs?: number;
    error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resp(reply: any, key: string) {
    const responseKey = `${key}Response`;
    return reply[responseKey];
}

export const api = {
    overview: async (): Promise<OverviewData> => {
        const reply = await ws.invoke('uGetOverview', {});
        const r = resp(reply, 'uGetOverview');
        return {
            name: r.name,
            version: r.version,
            uptime: Number(r.uptime),
            env: r.env,
            counts: {
                httpEntries: r.httpEntries,
                srpcMessages: r.srpcMessages,
                srpcActiveConnections: r.srpcActiveConnections,
                srpcDisconnected: r.srpcDisconnected
            }
        };
    },

    process: async (): Promise<ProcessInfo> => {
        const reply = await ws.invoke('uGetProcess', {});
        const r = resp(reply, 'uGetProcess');
        return {
            pid: r.pid,
            memory: {
                rss: Number(r.rss),
                heapTotal: Number(r.heapTotal),
                heapUsed: Number(r.heapUsed),
                external: Number(r.external),
                arrayBuffers: Number(r.arrayBuffers)
            },
            cpu: {
                user: Number(r.cpuUser),
                system: Number(r.cpuSystem)
            },
            uptime: r.uptime,
            nodeVersion: r.nodeVersion,
            platform: r.platform,
            arch: r.arch
        };
    },

    env: async (): Promise<Record<string, unknown>> => {
        const reply = await ws.invoke('uGetEnv', {});
        return JSON.parse(resp(reply, 'uGetEnv').jsonData);
    },

    requests: async (): Promise<HttpEntry[]> => {
        const reply = await ws.invoke('uGetRequests', {});
        return JSON.parse(resp(reply, 'uGetRequests').jsonData);
    },

    routes: async (): Promise<RouteInfo[]> => {
        const reply = await ws.invoke('uGetRoutes', {});
        return resp(reply, 'uGetRoutes').routes;
    },

    srpc: async (): Promise<SrpcData> => {
        const reply = await ws.invoke('uGetSrpc', {});
        return JSON.parse(resp(reply, 'uGetSrpc').jsonData);
    },

    srpcMessages: async (): Promise<SrpcMessage[]> => {
        const reply = await ws.invoke('uGetSrpcMessages', {});
        return JSON.parse(resp(reply, 'uGetSrpcMessages').jsonData);
    },

    srpcMessagesByStream: async (streamId: string): Promise<SrpcMessage[]> => {
        const reply = await ws.invoke('uGetSrpcMessages', { streamId });
        return JSON.parse(resp(reply, 'uGetSrpcMessages').jsonData);
    },

    workers: async (): Promise<Record<string, unknown>> => {
        const reply = await ws.invoke('uGetWorkers', {});
        return JSON.parse(resp(reply, 'uGetWorkers').jsonData);
    },

    workersJobs: async (): Promise<WorkerJobsData> => {
        const reply = await ws.invoke('uGetWorkersJobs', {});
        return JSON.parse(resp(reply, 'uGetWorkersJobs').jsonData);
    },

    databaseEntities: async (): Promise<EntityInfo[]> => {
        const reply = await ws.invoke('uGetDatabaseEntities', {});
        return resp(reply, 'uGetDatabaseEntities').entities;
    },

    databaseQuery: async (sql: string): Promise<QueryResult> => {
        const reply = await ws.invoke('uDatabaseQuery', { sql });
        const r = resp(reply, 'uDatabaseQuery');
        const columns: string[] = r.columns ?? [];
        const rows = (r.rows ?? []).map((row: { values: string[] }) => {
            const obj: Record<string, string> = {};
            columns.forEach((col, i) => {
                obj[col] = row.values[i] ?? '';
            });
            return obj;
        });
        return {
            columns,
            rows,
            rowCount: r.rowCount ?? 0,
            affectedRows: r.affectedRows ?? undefined,
            error: r.error ?? undefined
        };
    },

    healthChecks: async (): Promise<HealthCheckResult[]> => {
        const reply = await ws.invoke('uGetHealthChecks', {});
        return JSON.parse(resp(reply, 'uGetHealthChecks').jsonData);
    },

    mutexes: async (): Promise<MutexData> => {
        const reply = await ws.invoke('uGetMutexes', {});
        return JSON.parse(resp(reply, 'uGetMutexes').jsonData);
    },

    clearRequests: async (): Promise<void> => {
        await ws.invoke('uClearRequests', {});
    },

    clearSrpcMessages: async (): Promise<void> => {
        await ws.invoke('uClearSrpcMessages', {});
    },

    databaseQueries: async (): Promise<DatabaseQueryEntry[]> => {
        const reply = await ws.invoke('uGetDatabaseQueries', {});
        return JSON.parse(resp(reply, 'uGetDatabaseQueries').jsonData);
    },

    clearDatabaseQueries: async (): Promise<void> => {
        await ws.invoke('uClearDatabaseQueries', {});
    }
};
