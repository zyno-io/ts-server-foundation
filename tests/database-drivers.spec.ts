import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MySQLConnectionLike, MySQLDriver, MySQLPoolLike, PgClientLike, PgPoolLike, PostgresDriver } from '../src';

class FakePgClient implements PgClientLike {
    released = false;
    calls: { sql: string; bindings?: unknown[] }[] = [];

    async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
        this.calls.push({ sql: text, bindings: values });
        return { rows: [{ id: 1 }] as T[], rowCount: 3 };
    }

    release(): void {
        this.released = true;
    }
}

class FakePgPool implements PgPoolLike {
    ended = false;
    client = new FakePgClient();

    async connect(): Promise<PgClientLike> {
        return this.client;
    }

    async end(): Promise<void> {
        this.ended = true;
    }
}

class FakeMySQLConnection implements MySQLConnectionLike {
    released = false;
    calls: { method: 'query' | 'execute'; sql: string; bindings?: unknown[] }[] = [];

    async query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
        this.calls.push({ method: 'query', sql, bindings: values });
        return [[{ id: 1 }] as T, undefined];
    }

    async execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
        this.calls.push({ method: 'execute', sql, bindings: values });
        return [{ affectedRows: 2, insertId: 9, warningStatus: 0 } as T, undefined];
    }

    release(): void {
        this.released = true;
    }
}

class FakeMySQLPool implements MySQLPoolLike {
    ended = false;
    connection = new FakeMySQLConnection();

    async getConnection(): Promise<MySQLConnectionLike> {
        return this.connection;
    }

    async end(): Promise<void> {
        this.ended = true;
    }
}

describe('PostgresDriver', () => {
    it('maps query and execute calls', async () => {
        const pool = new FakePgPool();
        const driver = new PostgresDriver(pool);
        const connection = await driver.acquire();

        assert.deepStrictEqual(await connection.query({ sql: 'SELECT $1', bindings: [1] }), {
            rows: [{ id: 1 }]
        });
        assert.deepStrictEqual(await connection.execute({ sql: 'UPDATE users SET name=$1', bindings: ['A'] }), {
            affectedRows: 3,
            rowCount: 3
        });
        await connection.release();
        await driver.close();

        assert.equal(pool.client.released, true);
        assert.equal(pool.ended, true);
        assert.deepStrictEqual(pool.client.calls.slice(0, 2), [
            { sql: 'SELECT $1', bindings: [1] },
            { sql: 'UPDATE users SET name=$1', bindings: ['A'] }
        ]);
    });

    it('emits transaction and savepoint commands', async () => {
        const pool = new FakePgPool();
        const connection = await new PostgresDriver(pool).acquire();

        await connection.begin();
        await connection.savepoint('sp"1');
        await connection.rollbackToSavepoint('sp"1');
        await connection.commit();

        assert.deepStrictEqual(
            pool.client.calls.map(call => call.sql),
            ['BEGIN', 'SAVEPOINT "sp""1"', 'ROLLBACK TO SAVEPOINT "sp""1"', 'COMMIT']
        );
    });
});

describe('MySQLDriver', () => {
    it('uses UTC when an internal pool timezone is omitted or undefined', async () => {
        for (const config of [{}, { timezone: undefined }]) {
            const driver = new MySQLDriver(config);
            try {
                assert.equal(getMySQLDriverTimezone(driver), 'Z');
            } finally {
                await driver.close();
            }
        }
    });

    it('preserves explicit timezone overrides for internally created pools', async () => {
        const driver = new MySQLDriver({ timezone: '+02:00' });
        try {
            assert.equal(getMySQLDriverTimezone(driver), '+02:00');
        } finally {
            await driver.close();
        }
    });

    it('maps query and execute calls', async () => {
        const pool = new FakeMySQLPool();
        const driver = new MySQLDriver(pool);
        const connection = await driver.acquire();

        assert.deepStrictEqual(await connection.query({ sql: 'SELECT ?', bindings: [1] }), {
            rows: [{ id: 1 }]
        });
        assert.deepStrictEqual(await connection.execute({ sql: 'UPDATE users SET name=?', bindings: ['A'] }), {
            affectedRows: 2,
            insertId: 9,
            warningStatus: 0,
            rowCount: 2
        });
        await connection.release();
        await driver.close();

        assert.equal(pool.connection.released, true);
        assert.equal(pool.ended, true);
        assert.deepStrictEqual(pool.connection.calls.slice(0, 2), [
            { method: 'query', sql: 'SELECT ?', bindings: [1] },
            { method: 'execute', sql: 'UPDATE users SET name=?', bindings: ['A'] }
        ]);
    });

    it('emits transaction and savepoint commands', async () => {
        const pool = new FakeMySQLPool();
        const connection = await new MySQLDriver(pool).acquire();

        await connection.begin();
        await connection.savepoint('sp`1');
        await connection.rollbackToSavepoint('sp`1');
        await connection.rollback();

        assert.deepStrictEqual(
            pool.connection.calls.map(call => call.sql),
            ['START TRANSACTION', 'SAVEPOINT `sp``1`', 'ROLLBACK TO SAVEPOINT `sp``1`', 'ROLLBACK']
        );
    });
});

function getMySQLDriverTimezone(driver: MySQLDriver): string | undefined {
    const promisePool = Reflect.get(driver, 'pool') as {
        pool?: { config?: { connectionConfig?: { timezone?: string } } };
    };
    return promisePool.pool?.config?.connectionConfig?.timezone;
}
