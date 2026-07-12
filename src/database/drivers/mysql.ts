import { createPool, PoolOptions } from 'mysql2/promise';

import type { RenderedSql } from '../sql';
import type { DatabaseDriver, DriverConnection, ExecuteResult, QueryResult } from '../driver';

export interface MySQLPoolLike {
    getConnection(): Promise<MySQLConnectionLike>;
    end(): Promise<void>;
}

export interface MySQLConnectionLike {
    query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
    execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
    release(): void | Promise<void>;
}

export class MySQLDriver implements DatabaseDriver {
    readonly dialect = 'mysql' as const;
    private pool: MySQLPoolLike;

    constructor(configOrPool: PoolOptions | MySQLPoolLike) {
        this.pool = isMySQLPoolLike(configOrPool)
            ? configOrPool
            : (createPool({
                  decimalNumbers: true,
                  ...configOrPool,
                  timezone: configOrPool.timezone ?? 'Z'
              }) as unknown as MySQLPoolLike);
    }

    async connect(): Promise<void> {
        const connection = await this.acquire();
        await connection.release();
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    async acquire(): Promise<DriverConnection> {
        return new MySQLConnection(await this.pool.getConnection());
    }
}

class MySQLConnection implements DriverConnection {
    constructor(private connection: MySQLConnectionLike) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        const [rows] = await this.connection.query<T[]>(query.sql, query.bindings);
        return { rows: Array.isArray(rows) ? rows : [] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        const [result] = await this.connection.execute<any>(query.sql, query.bindings);
        return {
            affectedRows: Number(result?.affectedRows ?? 0),
            insertId: result?.insertId,
            warningStatus: result?.warningStatus,
            rowCount: Number(result?.affectedRows ?? 0)
        };
    }

    async begin(): Promise<void> {
        await this.connection.query('START TRANSACTION');
    }

    async commit(): Promise<void> {
        await this.connection.query('COMMIT');
    }

    async rollback(): Promise<void> {
        await this.connection.query('ROLLBACK');
    }

    async savepoint(name: string): Promise<void> {
        await this.connection.query(`SAVEPOINT ${quoteSavepoint(name)}`);
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        await this.connection.query(`ROLLBACK TO SAVEPOINT ${quoteSavepoint(name)}`);
    }

    async release(): Promise<void> {
        await this.connection.release();
    }
}

function isMySQLPoolLike(value: PoolOptions | MySQLPoolLike): value is MySQLPoolLike {
    return typeof (value as MySQLPoolLike).getConnection === 'function' && typeof (value as MySQLPoolLike).end === 'function';
}

function quoteSavepoint(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
}
