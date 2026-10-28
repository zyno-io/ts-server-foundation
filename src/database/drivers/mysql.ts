import { createPool, PoolOptions } from 'mysql2/promise';

import type { RenderedSql } from '../sql';
import type { DatabaseDriver, DriverConnection, ExecuteResult, QueryResult } from '../driver';
import { registerMySQLCleanup } from './mysql-lifecycle';

// A node can accept connections before Galera allows application statements.
// After an explicit readiness rejection, retry connection errors only while
// acquiring a replacement: a lost SQL response can leave a write outcome unknown.
// Cover the operator's two 10-second HAProxy health checks while trying a
// healthy backend quickly when one is already available.
const WSREP_RETRY_DELAYS_MS = [100, 200, 300, 400, ...Array<number>(40).fill(500)];
const WSREP_RETRY_BUDGET_MS = 21_000;

function isWsrepNotReady(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { message?: unknown; sqlMessage?: unknown };
    return [candidate.sqlMessage, candidate.message].some(
        message => typeof message === 'string' && /\bwsrep\b.*\b(?:has not yet prepared|not ready)\b.*\b(?:node|application use)\b/i.test(message)
    );
}

function isTransientConnectionError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown };
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'PROTOCOL_CONNECTION_LOST'].includes(String(candidate.code));
}

async function retryWsrepNotReady<T>(operation: () => Promise<T>, isRetryable = isWsrepNotReady): Promise<T> {
    const deadline = Date.now() + WSREP_RETRY_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const delay = WSREP_RETRY_DELAYS_MS[attempt];
            if (delay === undefined || !isRetryable(error) || Date.now() + delay > deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

export interface MySQLPoolLike {
    getConnection(): Promise<MySQLConnectionLike>;
    end(): Promise<void>;
}

export interface MySQLConnectionLike {
    query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
    execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
    destroy?(): void;
    release(): void | Promise<void>;
}

export class MySQLDriver implements DatabaseDriver {
    readonly dialect = 'mysql' as const;
    private pool: MySQLPoolLike;
    private readonly unregisterCleanup: () => void;
    private closing?: Promise<void>;

    constructor(configOrPool: PoolOptions | MySQLPoolLike) {
        this.pool = isMySQLPoolLike(configOrPool)
            ? configOrPool
            : (createPool({
                  decimalNumbers: true,
                  ...configOrPool,
                  timezone: configOrPool.timezone ?? 'Z'
              }) as unknown as MySQLPoolLike);
        this.unregisterCleanup = registerMySQLCleanup(() => this.close());
    }

    async connect(): Promise<void> {
        const connection = await this.acquire();
        await connection.release();
    }

    async close(): Promise<void> {
        this.closing ??= Promise.resolve()
            .then(() => this.pool.end())
            .finally(() => this.unregisterCleanup());
        await this.closing;
    }

    async acquire(): Promise<DriverConnection> {
        let recovering = false;
        const connection = await retryWsrepNotReady(
            () => this.acquireRaw(),
            error => {
                if (isWsrepNotReady(error)) recovering = true;
                return isWsrepNotReady(error) || (recovering && isTransientConnectionError(error));
            }
        );
        return new MySQLConnection(connection, () => this.acquireRaw());
    }

    private acquireRaw(): Promise<MySQLConnectionLike> {
        if (this.closing) throw new Error('MySQL pool is closed');
        return this.pool.getConnection();
    }
}

class MySQLConnection implements DriverConnection {
    private transactional = false;
    // Callers can also change session state or start a transaction through raw
    // SQL. Once a statement succeeds, its state cannot safely be reconstructed.
    private statementSucceeded = false;

    constructor(
        private connection: MySQLConnectionLike | undefined,
        private readonly acquire: () => Promise<MySQLConnectionLike>
    ) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        const [rows] = await this.runStatement(connection => connection.query<T[]>(query.sql, query.bindings));
        this.statementSucceeded = true;
        return { rows: Array.isArray(rows) ? rows : [] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        const [result] = await this.runStatement(connection =>
            connection.execute<{ affectedRows?: number; insertId?: number | string; warningStatus?: number }>(query.sql, query.bindings)
        );
        this.statementSucceeded = true;
        return {
            affectedRows: Number(result?.affectedRows ?? 0),
            insertId: result?.insertId,
            warningStatus: result?.warningStatus,
            rowCount: Number(result?.affectedRows ?? 0)
        };
    }

    async begin(): Promise<void> {
        await this.runStatement(connection => connection.query('START TRANSACTION'));
        this.transactional = true;
        this.statementSucceeded = true;
    }

    async commit(): Promise<void> {
        await this.getConnection().query('COMMIT');
        this.transactional = false;
    }

    async rollback(): Promise<void> {
        await this.getConnection().query('ROLLBACK');
        this.transactional = false;
    }

    async savepoint(name: string): Promise<void> {
        await this.getConnection().query(`SAVEPOINT ${quoteSavepoint(name)}`);
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        await this.getConnection().query(`ROLLBACK TO SAVEPOINT ${quoteSavepoint(name)}`);
    }

    async release(): Promise<void> {
        await this.connection?.release();
    }

    private getConnection(): MySQLConnectionLike {
        if (!this.connection) throw new Error('MySQL connection is unavailable');
        return this.connection;
    }

    private async runStatement<T>(operation: (connection: MySQLConnectionLike) => Promise<T>): Promise<T> {
        if (this.transactional || this.statementSucceeded) return operation(this.getConnection());
        let retryableAcquireError = false;
        return retryWsrepNotReady(
            async () => {
                retryableAcquireError = false;
                if (!this.connection) {
                    try {
                        this.connection = await this.acquire();
                    } catch (error) {
                        retryableAcquireError = isTransientConnectionError(error);
                        throw error;
                    }
                }
                try {
                    return await operation(this.connection);
                } catch (error) {
                    if (isWsrepNotReady(error) && this.connection.destroy) {
                        this.connection.destroy();
                        this.connection = undefined;
                    }
                    throw error;
                }
            },
            error => isWsrepNotReady(error) || retryableAcquireError
        );
    }
}

function isMySQLPoolLike(value: PoolOptions | MySQLPoolLike): value is MySQLPoolLike {
    return typeof (value as MySQLPoolLike).getConnection === 'function' && typeof (value as MySQLPoolLike).end === 'function';
}

function quoteSavepoint(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
}
