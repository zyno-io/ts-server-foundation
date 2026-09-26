import { randomUUID } from 'node:crypto';

import { Env } from '../../env';
import type { MySQLConnectionLike, MySQLPoolLike } from './mysql';
import { RpcPeer, connectRpc } from './mysql-session-rpc';

export interface SharedMySQLSessionManagerConfig {
    port: number;
    token: string;
}

export interface SharedMySQLSessionDatabaseOptions {
    key: string;
    prefix: string;
    keepDatabase: boolean;
}

export interface SharedMySQLSessionDatabase {
    databaseName: string;
    leaseId: string;
}

export interface SharedMySQLSessionSchemaPreparation {
    run: boolean;
    preparationId?: string;
}

interface ManagerRequestParams {
    token: string;
    [key: string]: unknown;
}

export function getSharedMySQLSessionManagerConfig(): SharedMySQLSessionManagerConfig | undefined {
    const port = Env.TSF_TEST_MYSQL_SESSION_MANAGER_PORT ? Number(Env.TSF_TEST_MYSQL_SESSION_MANAGER_PORT) : undefined;
    const token = Env.TSF_TEST_MYSQL_SESSION_MANAGER_TOKEN;
    if (!port || !token) return undefined;
    return { port, token };
}

export async function ensureSharedMySQLSessionDatabase(options: SharedMySQLSessionDatabaseOptions): Promise<SharedMySQLSessionDatabase> {
    return withManagerPeer(peer =>
        callManager<SharedMySQLSessionDatabase>(peer, 'ensureDatabase', {
            key: options.key,
            prefix: options.prefix,
            keepDatabase: options.keepDatabase
        })
    );
}

export async function releaseSharedMySQLSessionDatabase(key: string, leaseId: string | undefined): Promise<void> {
    await withManagerPeer(peer => callManager(peer, 'releaseDatabase', { key, leaseId }));
}

export async function prepareSharedMySQLSessionSchema(key: string, leaseId?: string): Promise<SharedMySQLSessionSchemaPreparation> {
    return withManagerPeer(peer => callManager<SharedMySQLSessionSchemaPreparation>(peer, 'prepareSchema', { key, leaseId }));
}

export async function completeSharedMySQLSessionSchema(
    key: string,
    leaseId: string | undefined,
    preparationId: string | undefined,
    error?: unknown
): Promise<void> {
    await withManagerPeer(peer =>
        callManager(peer, 'completeSchema', {
            key,
            leaseId,
            preparationId,
            ok: error === undefined,
            error: error instanceof Error ? error.message : error === undefined ? undefined : String(error)
        })
    );
}

export function createSharedMySQLSessionPool(
    key: string,
    clientId = `${process.pid}:${randomUUID()}`,
    leaseId = Env.TSF_TEST_MYSQL_SESSION_LEASE_ID
): MySQLPoolLike {
    const manager = getSharedMySQLSessionManagerConfig();
    if (!manager) throw new Error('Shared MySQL session manager is not configured');
    return new SharedMySQLSessionPool(manager, key, clientId, leaseId);
}

async function withManagerPeer<T>(worker: (peer: RpcPeer) => Promise<T>): Promise<T> {
    const manager = getSharedMySQLSessionManagerConfig();
    if (!manager) throw new Error('Shared MySQL session manager is not configured');
    const peer = await connectRpc(manager.port);
    try {
        return await worker(peer);
    } finally {
        peer.close();
    }
}

function callManager<T = unknown>(peer: RpcPeer, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const manager = getSharedMySQLSessionManagerConfig();
    if (!manager) throw new Error('Shared MySQL session manager is not configured');
    return peer.call<T>(method, { ...params, token: manager.token } satisfies ManagerRequestParams);
}

class SharedMySQLSessionPool implements MySQLPoolLike {
    private readonly pendingPeers = new Set<RpcPeer>();
    private readonly connections = new Set<SharedMySQLSessionConnection>();
    private ending?: Promise<void>;

    constructor(
        private readonly manager: SharedMySQLSessionManagerConfig,
        private readonly key: string,
        private readonly clientId: string,
        private readonly leaseId: string | undefined
    ) {}

    async getConnection(): Promise<MySQLConnectionLike> {
        if (this.ending) throw new Error('Shared MySQL session pool is closed');
        const peer = await connectRpc(this.manager.port);
        if (this.ending) {
            peer.close();
            throw new Error('Shared MySQL session pool is closed');
        }
        this.pendingPeers.add(peer);
        try {
            await this.call(peer, 'acquire', { key: this.key, leaseId: this.leaseId, clientId: this.clientId });
            if (this.ending) throw new Error('Shared MySQL session pool is closed');
            const connection = new SharedMySQLSessionConnection(peer, this);
            this.connections.add(connection);
            peer.once('close', () => this.connections.delete(connection));
            return connection;
        } catch (error) {
            peer.close();
            throw error;
        } finally {
            this.pendingPeers.delete(peer);
        }
    }

    async end(): Promise<void> {
        this.ending ??= Promise.resolve().then(() => this.closeConnections());
        await this.ending;
    }

    private async closeConnections(): Promise<void> {
        for (const peer of this.pendingPeers) peer.close();
        this.pendingPeers.clear();
        const results = await Promise.allSettled([...this.connections].map(connection => connection.release()));
        this.connections.clear();
        const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Shared MySQL session pool cleanup failed');
    }

    call<T = unknown>(peer: RpcPeer, method: string, params: Record<string, unknown> = {}): Promise<T> {
        return peer.call<T>(method, { ...params, token: this.manager.token });
    }
}

class SharedMySQLSessionConnection implements MySQLConnectionLike {
    private released = false;

    constructor(
        private readonly peer: RpcPeer,
        private readonly pool: SharedMySQLSessionPool
    ) {}

    async query<T = unknown>(sql: string, values: unknown[] = []): Promise<[T, unknown]> {
        const result = await this.pool.call<T>(this.peer, 'query', { sql, values });
        return [result, undefined];
    }

    async execute<T = unknown>(sql: string, values: unknown[] = []): Promise<[T, unknown]> {
        const result = await this.pool.call<T>(this.peer, 'execute', { sql, values });
        return [result, undefined];
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        try {
            await this.pool.call(this.peer, 'release');
        } finally {
            this.peer.close();
        }
    }
}
