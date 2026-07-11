import type { Dialect, RenderedSql } from './sql';

export interface ExecuteResult {
    affectedRows: number;
    insertId?: number | string;
    warningStatus?: number;
    rowCount?: number;
}

export interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    executeResult?: ExecuteResult;
}

export interface DriverConnection {
    query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>>;
    execute(query: RenderedSql): Promise<ExecuteResult>;
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    savepoint(name: string): Promise<void>;
    rollbackToSavepoint(name: string): Promise<void>;
    release(): Promise<void>;
}

export interface DatabaseDriver {
    readonly dialect: Dialect;
    connect(): Promise<void>;
    close(): Promise<void>;
    acquire(): Promise<DriverConnection>;
}
