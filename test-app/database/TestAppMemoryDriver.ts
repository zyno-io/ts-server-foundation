import type { DatabaseDriver, DriverConnection, ExecuteResult, QueryResult, RenderedSql } from '../../src';

export interface CapturedStatement {
    mode: 'query' | 'execute';
    sql: string;
    bindings: unknown[];
}

export interface TestAppUserRow {
    id: number;
    name: string;
    role: string | null;
}

export interface TestAppJobRow {
    id: string;
    queue: string;
    queueId: string;
    attempt: number;
    name: string;
    data: unknown;
    traceId: string | null;
    status: 'completed' | 'failed';
    result: unknown;
    createdAt: Date;
    shouldExecuteAt: Date;
    executedAt: Date;
    completedAt: Date;
}

export class TestAppMemoryDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    readonly statements: CapturedStatement[] = [];
    readonly commands: string[] = [];
    readonly users: TestAppUserRow[] = [];
    readonly jobs: TestAppJobRow[] = [];
    activeConnections = 0;
    private nextUserId = 1;

    reset(): void {
        this.statements.length = 0;
        this.commands.length = 0;
        this.users.length = 0;
        this.jobs.length = 0;
        this.activeConnections = 0;
        this.nextUserId = 1;
    }

    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    async acquire(): Promise<DriverConnection> {
        this.activeConnections++;
        return new TestAppConnection(this);
    }

    queryRows(query: RenderedSql): Record<string, unknown>[] {
        this.capture('query', query);
        const text = normalizeSql(query.sql);

        if (text === 'SELECT $1 AS tag') {
            return [{ tag: query.bindings[0] }];
        }

        if (text.startsWith('INSERT INTO "test_app_users"')) {
            const [name, role] = query.bindings;
            const returnsId = /\bRETURNING "id"$/.test(text);
            const row: TestAppUserRow = {
                id: this.nextUserId++,
                name: String(name),
                role: role === null || role === undefined ? null : String(role)
            };
            this.users.push(row);
            return returnsId ? [{ id: row.id }] : [];
        }

        if (text.includes('FROM "test_app_users"') || text.includes('FROM test_app_users')) {
            return this.selectUsers(text, query.bindings);
        }

        if (text.includes('FROM "_jobs"') || text.includes('FROM _jobs')) {
            return this.jobs.slice(-1) as unknown as Record<string, unknown>[];
        }

        return [];
    }

    executeStatement(query: RenderedSql): ExecuteResult {
        this.capture('execute', query);
        const text = normalizeSql(query.sql);

        if (text.startsWith('SELECT pg_advisory_xact_lock(')) {
            return { affectedRows: 0, rowCount: 1 };
        }

        if (text.startsWith('INSERT INTO "_jobs"')) {
            this.jobs.push(toJobRow(query.bindings));
            return { affectedRows: 1, rowCount: 1 };
        }

        if (isUpdateFor(text, 'name')) {
            return this.updateUsers('name', query);
        }

        if (isUpdateFor(text, 'role')) {
            return this.updateUsers('role', query);
        }

        if (text.startsWith('DELETE FROM "test_app_users"') || text.startsWith('DELETE FROM test_app_users')) {
            return this.deleteUsers(query);
        }

        return { affectedRows: 0, rowCount: 0 };
    }

    private capture(mode: CapturedStatement['mode'], query: RenderedSql): void {
        this.statements.push({
            mode,
            sql: query.sql,
            bindings: [...query.bindings]
        });
    }

    private selectUsers(sql: string, bindings: readonly unknown[]): Record<string, unknown>[] {
        let rows = this.users.map(row => ({ ...row }));

        if (sql.includes('WHERE "id" =') || sql.includes('WHERE id =')) {
            const id = Number(bindings[0]);
            rows = rows.filter(row => row.id === id);
        }

        if (sql.includes('"role" IS NOT NULL')) {
            rows = rows.filter(row => row.role !== null);
        }

        if (sql.includes('ORDER BY "name" ASC')) {
            rows.sort((a, b) => a.name.localeCompare(b.name));
        }

        if (sql.includes('COUNT(*) AS "count"')) {
            return [{ count: rows.length }];
        }

        if (sql.startsWith('SELECT "id" FROM')) {
            return rows.map(row => ({ id: row.id }));
        }

        if (sql.startsWith('SELECT "name" FROM')) {
            return rows.map(row => ({ name: row.name }));
        }

        return rows;
    }

    private updateUsers(field: 'name' | 'role', query: RenderedSql): ExecuteResult {
        const ids = getWhereIds(query);
        let affectedRows = 0;

        for (const row of this.users) {
            if (!ids.includes(row.id)) continue;
            if (field === 'name') row.name = String(query.bindings[0]);
            else row.role = query.bindings[0] === null || query.bindings[0] === undefined ? null : String(query.bindings[0]);
            affectedRows++;
        }

        return { affectedRows, rowCount: affectedRows };
    }

    private deleteUsers(query: RenderedSql): ExecuteResult {
        const ids = getWhereIds(query);
        const before = this.users.length;

        for (let index = this.users.length - 1; index >= 0; index--) {
            if (ids.includes(this.users[index]!.id)) this.users.splice(index, 1);
        }

        const affectedRows = before - this.users.length;
        return { affectedRows, rowCount: affectedRows };
    }
}

class TestAppConnection implements DriverConnection {
    constructor(private readonly driver: TestAppMemoryDriver) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        return { rows: this.driver.queryRows(query) as T[] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        return this.driver.executeStatement(query);
    }

    async begin(): Promise<void> {
        this.driver.commands.push('begin');
    }

    async commit(): Promise<void> {
        this.driver.commands.push('commit');
    }

    async rollback(): Promise<void> {
        this.driver.commands.push('rollback');
    }

    async savepoint(name: string): Promise<void> {
        this.driver.commands.push(`savepoint:${name}`);
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        this.driver.commands.push(`rollbackToSavepoint:${name}`);
    }

    async release(): Promise<void> {
        this.driver.commands.push('release');
        this.driver.activeConnections--;
    }
}

function normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

function isUpdateFor(sql: string, field: 'name' | 'role'): boolean {
    return (
        sql.startsWith(`UPDATE "test_app_users" SET "${field}" =`) ||
        sql.startsWith(`UPDATE test_app_users SET ${field} =`) ||
        sql.startsWith(`UPDATE test_app_users SET "${field}" =`)
    );
}

function getWhereIds(query: RenderedSql): number[] {
    const sql = normalizeSql(query.sql);
    if (sql.includes(' IN (')) return query.bindings.slice(1).map(Number);
    return [Number(query.bindings[1])];
}

function toJobRow(bindings: readonly unknown[]): TestAppJobRow {
    return {
        id: String(bindings[0]),
        queue: String(bindings[1]),
        queueId: String(bindings[2]),
        attempt: Number(bindings[3]),
        name: String(bindings[4]),
        data: parseJsonBinding(bindings[5]),
        traceId: bindings[6] === null || bindings[6] === undefined ? null : String(bindings[6]),
        status: bindings[7] as 'completed' | 'failed',
        result: parseJsonBinding(bindings[8]),
        createdAt: bindings[9] as Date,
        shouldExecuteAt: bindings[10] as Date,
        executedAt: bindings[11] as Date,
        completedAt: bindings[12] as Date
    };
}

function parseJsonBinding(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}
