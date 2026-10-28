import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BaseDatabase,
    createApp,
    MySQLConnectionLike,
    MySQLDriver,
    MySQLPoolLike,
    PgClientLike,
    PgPoolLike,
    PostgresDriver,
    registerDatabaseQueryObserver
} from '../src';

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
    it('retries WSREP readiness errors on acquisition, statements, and transaction start', async () => {
        const pool = new FakeMySQLPool();
        const driver = new MySQLDriver(pool);
        const error = wsrepNotReady();
        let acquisitions = 0;
        pool.getConnection = async () => {
            if (++acquisitions === 1) throw error;
            return pool.connection;
        };
        const originalQuery = pool.connection.query.bind(pool.connection);
        const originalExecute = pool.connection.execute.bind(pool.connection);
        let queryFailures = 2;
        let executeFailures = 1;
        pool.connection.query = async (sql, values) => {
            if (queryFailures-- > 0) throw error;
            return originalQuery(sql, values);
        };
        pool.connection.execute = async (sql, values) => {
            if (executeFailures-- > 0) throw error;
            return originalExecute(sql, values);
        };

        try {
            const queryConnection = await driver.acquire();
            const rows = await queryConnection.query({ sql: 'SELECT ?', bindings: [1] });
            assert.deepStrictEqual(rows.rows, [{ id: 1 }]);
            await queryConnection.release();
            const executeConnection = await driver.acquire();
            const result = await executeConnection.execute({ sql: 'UPDATE t SET x=?', bindings: [2] });
            assert.equal(result.affectedRows, 2);
            await executeConnection.release();
            queryFailures = 1;
            const transactionConnection = await driver.acquire();
            await transactionConnection.begin();
            await transactionConnection.rollback();
            await transactionConnection.release();
            assert.equal(acquisitions, 4);
            assert.equal(pool.connection.released, true);
        } finally {
            await driver.close();
        }
    });

    it('surfaces the last readiness error after bounded retries', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const pool = new FakeMySQLPool();
        const driver = new MySQLDriver(pool);
        let calls = 0;
        const error = wsrepNotReady();
        pool.connection.query = async () => {
            calls++;
            throw error;
        };
        try {
            const connection = await driver.acquire();
            const result = connection.query({ sql: 'SELECT 1', bindings: [] });
            const rejection = assert.rejects(result, caught => caught === error);
            const delays = [100, 200, 300, 400, ...Array<number>(40).fill(500)];
            for (const delay of delays) {
                await new Promise<void>(resolve => setImmediate(resolve));
                t.mock.timers.tick(delay);
            }
            await rejection;
            assert.equal(calls, 45);
            await connection.release();
        } finally {
            await driver.close();
        }
    });

    it('discards a rejected pooled connection and reconnects after a temporary acquisition failure', async () => {
        const pool = new FakeMySQLPool();
        const original = pool.connection;
        const replacement = new FakeMySQLConnection();
        const error = wsrepNotReady();
        let destroyed = 0;
        let acquisitions = 0;
        let attempts = 0;
        const rejected: MySQLConnectionLike = {
            query: async () => {
                attempts++;
                throw error;
            },
            execute: original.execute.bind(original),
            release: () => assert.fail('rejected connection was returned to the pool'),
            destroy: () => {
                destroyed++;
            }
        };
        pool.getConnection = async () => {
            acquisitions++;
            if (acquisitions === 1) return rejected;
            if (acquisitions === 2) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
            return replacement;
        };
        const driver = new MySQLDriver(pool);
        try {
            const connection = await driver.acquire();
            const rows = await connection.query({ sql: 'SELECT ?', bindings: [42] });
            assert.deepStrictEqual(rows.rows, [{ id: 1 }]);
            assert.deepStrictEqual(replacement.calls, [{ method: 'query', sql: 'SELECT ?', bindings: [42] }]);
            assert.equal(attempts, 1);
            assert.equal(acquisitions, 3);
            assert.equal(destroyed, 1);
            await connection.release();
            assert.equal(replacement.released, true);
        } finally {
            await driver.close();
        }
    });

    it('recovers after a proxy health-check window longer than ten seconds', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const pool = new FakeMySQLPool();
        const start = Date.now();
        let destroyed = 0;
        let acquisitions = 0;
        let accepted: FakeMySQLConnection | undefined;
        pool.getConnection = async () => {
            acquisitions++;
            const connection = new FakeMySQLConnection();
            if (Date.now() - start < 12_000) {
                connection.query = async () => {
                    throw wsrepNotReady();
                };
            } else {
                accepted = connection;
            }
            return Object.assign(connection, {
                destroy: () => {
                    destroyed++;
                }
            });
        };
        const driver = new MySQLDriver(pool);
        try {
            const connection = await driver.acquire();
            const pending = connection.query({ sql: 'SELECT 1', bindings: [] });
            for (let elapsed = 0; elapsed < 12_000; elapsed += 500) {
                await new Promise<void>(resolve => setImmediate(resolve));
                t.mock.timers.tick(500);
            }
            const result = await pending;
            assert.deepStrictEqual(result.rows, [{ id: 1 }]);
            assert.equal(acquisitions, destroyed + 1);
            assert.ok(destroyed > 1);
            await connection.release();
            assert.equal(accepted?.released, true);
        } finally {
            await driver.close();
        }
    });

    it('does not retry a connection failure after a statement was sent on the replacement', async () => {
        const pool = new FakeMySQLPool();
        const first = pool.connection;
        const replacement = new FakeMySQLConnection();
        const disconnected = Object.assign(new Error('lost response'), { code: 'ECONNRESET' });
        let acquisitions = 0;
        first.query = async () => {
            throw wsrepNotReady();
        };
        const rejected = Object.assign(first, { destroy: () => {} });
        replacement.query = async () => {
            throw disconnected;
        };
        pool.getConnection = async () => (++acquisitions === 1 ? rejected : replacement);
        const driver = new MySQLDriver(pool);
        try {
            const connection = await driver.acquire();
            await assert.rejects(
                () => connection.query({ sql: 'UPDATE t SET x=x+1', bindings: [] }),
                caught => caught === disconnected
            );
            assert.equal(acquisitions, 2);
            await connection.release();
        } finally {
            await driver.close();
        }
    });

    it('reconnects for a rejected execute or transaction start', async () => {
        for (const operation of ['execute', 'begin'] as const) {
            const pool = new FakeMySQLPool();
            const replacement = new FakeMySQLConnection();
            let destroyed = 0;
            let acquisitions = 0;
            const rejected = Object.assign(pool.connection, {
                destroy: () => {
                    destroyed++;
                }
            });
            rejected.query = async () => {
                throw wsrepNotReady();
            };
            rejected.execute = async () => {
                throw wsrepNotReady();
            };
            pool.getConnection = async () => (++acquisitions === 1 ? rejected : replacement);
            const driver = new MySQLDriver(pool);
            try {
                const connection = await driver.acquire();
                if (operation === 'execute') await connection.execute({ sql: 'UPDATE t SET x=?', bindings: [1] });
                else await connection.begin();
                assert.equal(destroyed, 1);
                assert.equal(acquisitions, 2);
                assert.equal(replacement.calls[0].sql, operation === 'execute' ? 'UPDATE t SET x=?' : 'START TRANSACTION');
                if (operation === 'begin') await connection.rollback();
                await connection.release();
            } finally {
                await driver.close();
            }
        }
    });

    it('reports a recovered query as successful to database observers', async () => {
        const pool = new FakeMySQLPool();
        const driver = new MySQLDriver(pool);
        const db = new BaseDatabase(driver);
        const observations: { phase: string; error?: unknown }[] = [];
        const unregister = registerDatabaseQueryObserver(entry => {
            if (entry.db === db) observations.push({ phase: entry.phase, error: entry.error });
        });
        const query = pool.connection.query.bind(pool.connection);
        let calls = 0;
        pool.connection.query = async (sql, values) => {
            if (++calls === 1) throw { sqlMessage: 'WSREP node is not ready for application use' };
            return query(sql, values);
        };
        try {
            const rows = await db.rawQuery('SELECT 1');
            assert.deepStrictEqual(rows, [{ id: 1 }]);
            assert.equal(calls, 2);
            assert.deepStrictEqual(observations, [
                { phase: 'start', error: undefined },
                { phase: 'finish', error: undefined }
            ]);
        } finally {
            unregister();
            await driver.close();
        }
    });

    it('does not retry generic 1047, connection failures, or statements in an active transaction', async () => {
        const pool = new FakeMySQLPool();
        const driver = new MySQLDriver(pool);
        const connection = await driver.acquire();
        try {
            for (const error of [
                Object.assign(new Error('Unknown command'), { errno: 1047, code: 'ER_UNKNOWN_COM_ERROR', sqlState: '08S01' }),
                Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' })
            ]) {
                let calls = 0;
                pool.connection.query = async () => {
                    calls++;
                    throw error;
                };
                await assert.rejects(
                    () => connection.query({ sql: 'SELECT 1', bindings: [] }),
                    caught => caught === error
                );
                assert.equal(calls, 1);
            }
            pool.connection.query = async () => [[], undefined] as never;
            await connection.begin();
            let calls = 0;
            const error = wsrepNotReady();
            pool.connection.execute = async () => {
                calls++;
                throw error;
            };
            await assert.rejects(
                () => connection.execute({ sql: 'UPDATE t SET x=1', bindings: [] }),
                caught => caught === error
            );
            assert.equal(calls, 1);
            await connection.rollback();
            await connection.release();
        } finally {
            await driver.close();
        }
    });

    it('does not retry after raw SQL has changed a connection session', async () => {
        const pool = new FakeMySQLPool();
        const driver = new MySQLDriver(pool);
        try {
            const connection = await driver.acquire();
            await connection.query({ sql: 'START TRANSACTION', bindings: [] });
            const error = wsrepNotReady();
            let calls = 0;
            pool.connection.query = async () => {
                calls++;
                throw error;
            };
            await assert.rejects(
                () => connection.query({ sql: 'SELECT 1', bindings: [] }),
                caught => caught === error
            );
            assert.equal(calls, 1);
            await connection.release();
        } finally {
            await driver.close();
        }
    });

    it('closes app-owned pools once, including pools outside the database provider', async () => {
        const app = createApp({ enableHealthcheck: false });
        const pool = new FakeMySQLPool();
        let endCalls = 0;
        pool.end = async () => {
            endCalls++;
            pool.ended = true;
        };
        const driver = new MySQLDriver(pool);

        await driver.connect();
        await app.stop();
        await driver.close();
        await app.stop();

        assert.equal(pool.ended, true);
        assert.equal(endCalls, 1);
        await assert.rejects(() => driver.acquire(), /MySQL pool is closed/);
    });

    it('joins concurrent pool shutdowns and unregisters pools closed before app shutdown', async () => {
        const app = createApp({ enableHealthcheck: false });
        const pool = new FakeMySQLPool();
        let endCalls = 0;
        let finishClose!: () => void;
        pool.end = () => {
            endCalls++;
            return new Promise<void>(resolve => {
                finishClose = resolve;
            });
        };
        const driver = new MySQLDriver(pool);

        const firstClose = driver.close();
        const secondClose = driver.close();
        await Promise.resolve();
        assert.equal(endCalls, 1);
        finishClose();
        await Promise.all([firstClose, secondClose]);
        await app.stop();
        assert.equal(endCalls, 1);
    });

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

function wsrepNotReady(): Error {
    return Object.assign(new Error('WSREP has not yet prepared node for application use'), {
        errno: 1047,
        code: 'ER_UNKNOWN_COM_ERROR',
        sqlState: '08S01'
    });
}

function getMySQLDriverTimezone(driver: MySQLDriver): string | undefined {
    const promisePool = Reflect.get(driver, 'pool') as {
        pool?: { config?: { connectionConfig?: { timezone?: string } } };
    };
    return promisePool.pool?.config?.connectionConfig?.timezone;
}
