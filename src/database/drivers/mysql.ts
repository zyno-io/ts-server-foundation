import { createPool, PoolOptions } from 'mysql2/promise';

import type { RenderedSql } from '../sql';
import type { DatabaseDriver, DriverConnection, ExecuteResult, QueryResult } from '../driver';
import { registerMySQLCleanup } from './mysql-lifecycle';

import {
    isReplayableMySQLRead,
    isSingleMySQLStatement,
    isRetryableMySQLAcquisitionError,
    isTransientMySQLConnectionError,
    isWsrepNotReady,
    retryMySQL
} from './mysql-recovery';

export interface MySQLPoolLike {
    getConnection(): Promise<MySQLConnectionLike>;
    end(): Promise<void>;
}

export interface MySQLConnectionLike {
    query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
    execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
    ping?(): Promise<void>;
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
        const connection = await retryMySQL(() => this.acquireRaw(), isRetryableMySQLAcquisitionError);
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
    private failure?: unknown;
    private released = false;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(
        private connection: MySQLConnectionLike | undefined,
        private readonly acquire: () => Promise<MySQLConnectionLike>
    ) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        const [rows] = await this.runStatement(
            connection => connection.query<T[]>(query.sql, query.bindings),
            isReplayableMySQLRead(query.sql),
            isSingleMySQLStatement(query.sql)
        );
        return { rows: Array.isArray(rows) ? rows : [] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        const [result] = await this.runStatement(
            connection =>
                connection.execute<{ affectedRows?: number; insertId?: number | string; warningStatus?: number }>(query.sql, query.bindings),
            false,
            isSingleMySQLStatement(query.sql)
        );
        return {
            affectedRows: Number(result?.affectedRows ?? 0),
            insertId: result?.insertId,
            warningStatus: result?.warningStatus,
            rowCount: Number(result?.affectedRows ?? 0)
        };
    }

    async begin(): Promise<void> {
        await this.runStatement(connection => connection.query('START TRANSACTION'), true);
        this.transactional = true;
        this.statementSucceeded = true;
    }

    async commit(): Promise<void> {
        await this.runStatement(connection => connection.query('COMMIT'));
        this.transactional = false;
    }

    async rollback(): Promise<void> {
        // Destroying a failed connection rolls its transaction back server-side.
        if (this.failure) return;
        await this.runStatement(connection => connection.query('ROLLBACK'));
        this.transactional = false;
    }

    async savepoint(name: string): Promise<void> {
        await this.runStatement(connection => connection.query(`SAVEPOINT ${quoteSavepoint(name)}`));
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        await this.runStatement(connection => connection.query(`ROLLBACK TO SAVEPOINT ${quoteSavepoint(name)}`));
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        await this.connection?.release();
        this.connection = undefined;
    }

    private getConnection(): MySQLConnectionLike {
        if (this.failure) throw this.failure;
        if (this.released) throw new Error('MySQL connection is released');
        if (!this.connection) throw new Error('MySQL connection is unavailable');
        return this.connection;
    }

    private runStatement<T>(
        operation: (connection: MySQLConnectionLike) => Promise<T>,
        replayLostResponse = false,
        replayRejection = true
    ): Promise<T> {
        // mysql2 serializes commands too. Keep replacement and state tracking in
        // the same order when a scoped connection is used with Promise.all().
        const result = this.pending.then(() => this.runStatementNow(operation, replayLostResponse, replayRejection));
        this.pending = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    private async runStatementNow<T>(
        operation: (connection: MySQLConnectionLike) => Promise<T>,
        replayLostResponse = false,
        replayRejection = true
    ): Promise<T> {
        if (this.failure) throw this.failure;
        if (this.released) throw new Error('MySQL connection is released');
        const canReplace = !this.transactional && !this.statementSucceeded;
        let retryable = false;
        return retryMySQL(
            async () => {
                retryable = false;
                if (!this.connection) {
                    try {
                        this.connection = await this.acquire();
                    } catch (error) {
                        retryable = canReplace && isRetryableMySQLAcquisitionError(error);
                        throw error;
                    }
                }
                let sent = false;
                try {
                    // Check a stale lease before sending a non-replayable write.
                    // A failed ping has no ambiguous application side effect.
                    if (canReplace && !replayLostResponse) await this.connection.ping?.();
                    sent = true;
                    const result = await operation(this.getConnection());
                    this.statementSucceeded = true;
                    return result;
                } catch (error) {
                    const disconnected = isTransientMySQLConnectionError(error);
                    const rejected = isWsrepNotReady(error);
                    retryable = canReplace && ((rejected && replayRejection) || (disconnected && (replayLostResponse || !sent)));
                    if (disconnected || rejected) {
                        if (this.connection?.destroy) {
                            this.connection.destroy();
                            this.connection = undefined;
                        }
                        if (!retryable) this.failure = error;
                    }
                    throw error;
                }
            },
            () => retryable
        );
    }
}

function isMySQLPoolLike(value: PoolOptions | MySQLPoolLike): value is MySQLPoolLike {
    return typeof (value as MySQLPoolLike).getConnection === 'function' && typeof (value as MySQLPoolLike).end === 'function';
}

function quoteSavepoint(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
}
