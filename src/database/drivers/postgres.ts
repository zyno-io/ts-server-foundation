import { Pool, PoolConfig, PoolClient } from 'pg';

import type { DatabaseDriver, DriverConnection, ExecuteResult, QueryResult } from '../driver';
import type { RenderedSql } from '../sql';

export interface PgPoolLike {
    connect(): Promise<PgClientLike>;
    end(): Promise<void>;
}

export interface PgClientLike {
    query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
    release(): void;
}

export class PostgresDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    private pool: PgPoolLike;

    constructor(configOrPool: PoolConfig | PgPoolLike) {
        this.pool = isPgPoolLike(configOrPool) ? configOrPool : new Pool(configOrPool);
    }

    async connect(): Promise<void> {
        const connection = await this.acquire();
        await connection.release();
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    async acquire(): Promise<DriverConnection> {
        return new PostgresConnection(await this.pool.connect());
    }
}

class PostgresConnection implements DriverConnection {
    constructor(private client: PgClientLike) {}

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
        this.client.release();
    }
}

function isPgPoolLike(value: PoolConfig | PgPoolLike): value is PgPoolLike {
    return typeof (value as PgPoolLike).connect === 'function' && typeof (value as PgPoolLike).end === 'function';
}

function quoteSavepoint(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}
