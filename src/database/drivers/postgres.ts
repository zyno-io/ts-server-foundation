import { Pool, PoolConfig } from 'pg';

import { createLogger } from '../../services/logger';

import type { DatabaseDriver, DriverConnection, ExecuteResult, QueryResult } from '../driver';
import type { RenderedSql } from '../sql';

export interface PgPoolLike {
    connect(): Promise<PgClientLike>;
    end(): Promise<void>;
    on?(event: 'error', listener: (error: Error) => void): unknown;
    on?(event: 'connect', listener: (client: PgClientLike) => void): unknown;
}

export interface PgClientLike {
    query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
    release(error?: Error | boolean): void;
    on?(event: 'error', listener: (error: Error) => void): unknown;
}

export class PostgresDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    private pool: PgPoolLike;
    private logger = createLogger('PostgresDriver');
    private clientErrors = new WeakMap<PgClientLike, { error?: Error }>();

    constructor(configOrPool: PoolConfig | PgPoolLike) {
        this.pool = isPgPoolLike(configOrPool)
            ? configOrPool
            : new Pool({ ...configOrPool, connectionTimeoutMillis: configOrPool.connectionTimeoutMillis ?? 5000 });
        // pg-pool removes failed idle clients before forwarding their errors.
        this.pool.on?.('error', error => this.logConnectionError('pool', error));
        this.pool.on?.('connect', client => this.watchClient(client));
    }

    async connect(): Promise<void> {
        const connection = await this.acquire();
        await connection.release();
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    async acquire(): Promise<DriverConnection> {
        const client = await this.pool.connect();
        return new PostgresConnection(client, this.watchClient(client));
    }

    private watchClient(client: PgClientLike): { error?: Error } {
        let state = this.clientErrors.get(client);
        if (!state) {
            state = {};
            this.clientErrors.set(client, state);
            const clientState = state;
            // Keep this listener while idle and between transaction queries.
            client.on?.('error', error => {
                clientState.error = error;
                this.logConnectionError('client', error);
            });
        }
        return state;
    }

    private logConnectionError(source: 'pool' | 'client', error: Error): void {
        // Pool errors can contain a client with credentials and query bindings.
        this.logger.error('PostgreSQL connection error', { source, message: error.message });
    }
}

class PostgresConnection implements DriverConnection {
    constructor(
        private client: PgClientLike,
        private state: { error?: Error }
    ) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        const result = await this.client.query<T>(query.sql, query.bindings);
        return { rows: result.rows };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        const result = await this.client.query(query.sql, query.bindings);
        return {
            affectedRows: result.rowCount ?? 0,
            rowCount: result.rowCount ?? 0
        };
    }

    async begin(): Promise<void> {
        await this.client.query('BEGIN');
    }

    async commit(): Promise<void> {
        await this.client.query('COMMIT');
    }

    async rollback(): Promise<void> {
        await this.client.query('ROLLBACK');
    }

    async savepoint(name: string): Promise<void> {
        await this.client.query(`SAVEPOINT ${quoteSavepoint(name)}`);
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${quoteSavepoint(name)}`);
    }

    async release(): Promise<void> {
        this.client.release(this.state.error);
    }
}

function isPgPoolLike(value: PoolConfig | PgPoolLike): value is PgPoolLike {
    return typeof (value as PgPoolLike).connect === 'function' && typeof (value as PgPoolLike).end === 'function';
}

function quoteSavepoint(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}
