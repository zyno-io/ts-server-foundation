export class RingBuffer<T> {
    private buffer: Array<T | undefined>;
    private head = 0;
    private count = 0;

    constructor(private readonly capacity: number) {
        this.buffer = Array.from({ length: capacity });
    }

    push(item: T): T | undefined {
        const evicted = this.count === this.capacity ? this.buffer[this.head] : undefined;
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
        return evicted;
    }

    toArray(): T[] {
        if (this.count === 0) return [];
        if (this.count < this.capacity) return this.buffer.slice(0, this.count) as T[];
        return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)] as T[];
    }

    clear(): void {
        this.buffer = Array.from({ length: this.capacity });
        this.head = 0;
        this.count = 0;
    }

    get length(): number {
        return this.count;
    }
}

export interface DevConsoleErrorInfo {
    name: string;
    message: string;
    stack?: string;
    cause?: DevConsoleErrorInfo;
    [key: string]: unknown;
}

export interface DevConsoleHttpEntry {
    id: string;
    timestamp: number;
    method: string;
    url: string;
    remoteAddress: string;
    requestHeaders: Record<string, string | string[] | undefined>;
    requestBody: string | null;
    statusCode: number;
    responseHeaders: Record<string, string | number | string[] | undefined>;
    responseBody: string | null;
    durationMs: number;
    error?: DevConsoleErrorInfo;
}

export interface DevConsoleSrpcMessage {
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

export interface DevConsoleSrpcConnection {
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

export interface DevConsoleSrpcDisconnection {
    streamId: string;
    clientId: string;
    disconnectedAt: number;
    cause: string;
}

export interface DevConsoleDatabaseQueryEntry {
    id: string;
    timestamp: number;
    sql: string;
    params: unknown[];
    status: 'running' | 'ok' | 'error';
    durationMs?: number;
    error?: string;
}

export interface DevConsoleMutexEntry {
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

export class DevConsoleStore {
    readonly httpEntries = new RingBuffer<DevConsoleHttpEntry>(500);
    readonly srpcMessages = new RingBuffer<DevConsoleSrpcMessage>(500);
    readonly srpcConnections = new Map<string, DevConsoleSrpcConnection>();
    readonly srpcDisconnected = new RingBuffer<DevConsoleSrpcDisconnection>(50);
    readonly dbQueries = new RingBuffer<DevConsoleDatabaseQueryEntry>(500);
    private readonly dbQueriesById = new Map<string, DevConsoleDatabaseQueryEntry>();
    readonly mutexEntries = new RingBuffer<DevConsoleMutexEntry>(200);
    readonly activeMutexes = new Map<string, DevConsoleMutexEntry>();
    readonly startedAt = Date.now();

    onEvent?: (type: string, data: unknown) => void;

    addHttpEntry(entry: DevConsoleHttpEntry): void {
        this.httpEntries.push(entry);
        this.onEvent?.('http:entry', entry);
    }

    clearHttpEntries(): void {
        this.httpEntries.clear();
    }

    addSrpcConnection(conn: DevConsoleSrpcConnection): void {
        this.srpcConnections.set(conn.streamId, conn);
        this.onEvent?.('srpc:connection', conn);
    }

    removeSrpcConnection(streamId: string, clientId: string, cause: string): void {
        this.srpcConnections.delete(streamId);
        const disconnection = { streamId, clientId, disconnectedAt: Date.now(), cause };
        this.srpcDisconnected.push(disconnection);
        this.onEvent?.('srpc:disconnection', disconnection);
    }

    addSrpcMessage(message: DevConsoleSrpcMessage): void {
        this.srpcMessages.push(message);
        const connection = this.srpcConnections.get(message.streamId);
        if (connection) {
            connection.messageCount++;
            connection.lastPingAt = Date.now();
        }
        this.onEvent?.('srpc:message', message);
    }

    clearSrpcMessages(): void {
        this.srpcMessages.clear();
        this.srpcDisconnected.clear();
    }

    addDatabaseQuery(entry: DevConsoleDatabaseQueryEntry): void {
        const evicted = this.dbQueries.push(entry);
        if (evicted) this.dbQueriesById.delete(evicted.id);
        this.dbQueriesById.set(entry.id, entry);
        this.onEvent?.('db:query', entry);
    }

    completeDatabaseQuery(entry: DevConsoleDatabaseQueryEntry): void {
        const existing = this.dbQueriesById.get(entry.id);
        const completed = existing ?? entry;
        Object.assign(completed, entry);
        if (!existing) {
            const evicted = this.dbQueries.push(completed);
            if (evicted) this.dbQueriesById.delete(evicted.id);
            this.dbQueriesById.set(completed.id, completed);
        }
        this.onEvent?.('db:query:complete', completed);
    }

    clearDatabaseQueries(): void {
        this.dbQueries.clear();
        this.dbQueriesById.clear();
    }

    addMutexPending(entry: DevConsoleMutexEntry): void {
        this.mutexEntries.push(entry);
        this.activeMutexes.set(entry.id, entry);
        this.onEvent?.('mutex:pending', entry);
    }

    updateMutexAcquired(id: string, waited: boolean | undefined, at: number): void {
        const entry = this.activeMutexes.get(id);
        if (!entry) return;
        entry.status = 'acquired';
        entry.acquiredAt = at;
        entry.waitDurationMs = at - entry.startedAt;
        entry.waited = waited;
        this.onEvent?.('mutex:acquired', entry);
    }

    updateMutexReleased(id: string, at: number): void {
        const entry = this.activeMutexes.get(id);
        if (!entry) return;
        entry.status = 'released';
        entry.releasedAt = at;
        entry.durationMs = at - (entry.acquiredAt ?? entry.startedAt);
        this.activeMutexes.delete(id);
        this.onEvent?.('mutex:released', entry);
    }

    updateMutexError(id: string, error: unknown, at: number): void {
        const entry = this.activeMutexes.get(id);
        if (!entry) return;
        entry.status = 'error';
        entry.releasedAt = at;
        entry.durationMs = at - (entry.acquiredAt ?? entry.startedAt);
        entry.error = stringifyErrorMessage(error);
        this.activeMutexes.delete(id);
        this.onEvent?.('mutex:error', entry);
    }

    addMutexFailed(entry: DevConsoleMutexEntry): void {
        this.mutexEntries.push(entry);
        this.onEvent?.('mutex:failed', entry);
    }

    broadcastWorkerEvent(type: 'added' | 'active' | 'delayed' | 'job', data: unknown): void {
        this.onEvent?.(`worker:${type}`, data);
    }
}

export function serializeErrorInfo(error: unknown): DevConsoleErrorInfo | undefined {
    if (!error) return undefined;
    if (!(error instanceof Error)) return { name: 'Error', message: String(error) };

    const info: DevConsoleErrorInfo = {
        name: error.name,
        message: error.message
    };
    if (error.stack) info.stack = error.stack;
    const cause = (error as Error & { cause?: unknown }).cause;
    const serializedCause = serializeErrorInfo(cause);
    if (serializedCause) info.cause = serializedCause;
    return info;
}

function stringifyErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
