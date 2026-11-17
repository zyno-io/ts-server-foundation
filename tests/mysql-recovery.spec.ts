import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { BaseDatabase, MySQLDriver, registerDatabaseQueryObserver, type MySQLConnectionLike, type MySQLPoolLike } from '../src';
import { isReplayableMySQLRead } from '../src/database/drivers/mysql-recovery';

const lost = () => Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });

function fixture(fail: (sql: string) => unknown) {
    const calls: string[] = [];
    let acquisitions = 0;
    let destroyed = 0;
    let released = 0;
    const pool: MySQLPoolLike = {
        async getConnection() {
            acquisitions++;
            const query: MySQLConnectionLike['query'] = async <T>(sql: string) => {
                calls.push(sql);
                const error = fail(sql);
                if (error) throw error;
                return [[{ id: 1 }] as T, undefined];
            };
            return {
                query,
                execute: query,
                destroy: () => {
                    destroyed++;
                },
                release: () => {
                    released++;
                }
            };
        },
        async end() {}
    };
    return { driver: new MySQLDriver(pool), pool, calls, stats: () => ({ acquisitions, destroyed, released }) };
}

async function tick(t: TestContext, delay = 100) {
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(delay);
}

describe('MySQL disconnect recovery', () => {
    it('discards PROTOCOL_CONNECTION_LOST and retries a read before observers see a failure', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        let failures = 1;
        const f = fixture(() => (failures-- > 0 ? lost() : undefined));
        const db = new BaseDatabase(f.driver);
        const observations: unknown[] = [];
        const unregister = registerDatabaseQueryObserver(entry => {
            if (entry.db === db && entry.phase === 'finish') observations.push(entry.error);
        });
        try {
            const pending = db.rawQuery('SELECT id FROM users WHERE id = 1');
            await tick(t);
            const result = await pending;
            assert.deepEqual(result, [{ id: 1 }]);
            assert.deepEqual(f.stats(), { acquisitions: 2, destroyed: 1, released: 1 });
            assert.deepEqual(observations, [undefined]);
        } finally {
            unregister();
            await f.driver.close();
        }
    });

    it('retries initial acquisition and reconnect failures, without sending a write twice', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const f = fixture(() => undefined);
        const acquire = f.pool.getConnection.bind(f.pool);
        let attempts = 0;
        f.pool.getConnection = async () => {
            if (++attempts < 3) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
            return acquire();
        };
        try {
            const pending = new BaseDatabase(f.driver).rawExecute('UPDATE counters SET value = value + 1');
            await tick(t, 100);
            await tick(t, 200);
            await pending;
            assert.equal(attempts, 3);
            assert.equal(f.calls.length, 1);
        } finally {
            await f.driver.close();
        }
    });

    it('replaces a stale connection on ping before sending a write', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const f = fixture(() => undefined);
        const acquire = f.pool.getConnection.bind(f.pool);
        let attempts = 0;
        f.pool.getConnection = async () => {
            const connection = await acquire();
            if (++attempts === 1)
                connection.ping = async () => {
                    throw lost();
                };
            return connection;
        };
        try {
            const pending = new BaseDatabase(f.driver).rawExecute('UPDATE counters SET value=value+1');
            await tick(t);
            await pending;
            assert.deepEqual(f.calls, ['UPDATE counters SET value=value+1']);
            assert.deepEqual(f.stats(), { acquisitions: 2, destroyed: 1, released: 1 });
        } finally {
            await f.driver.close();
        }
    });

    it('surfaces persistent disconnects after the bounded recovery window', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const error = lost();
        const f = fixture(() => error);
        try {
            const pending = new BaseDatabase(f.driver).rawQuery('SELECT 1');
            const rejected = assert.rejects(pending, caught => caught === error);
            for (const delay of [100, 200, 300, 400, ...Array<number>(40).fill(500)]) await tick(t, delay);
            await rejected;
            assert.equal(f.calls.length, 45);
            assert.deepEqual(f.stats(), { acquisitions: 45, destroyed: 45, released: 0 });
        } finally {
            await f.driver.close();
        }
    });

    it('immediately surfaces permanent SQL and authentication failures', async () => {
        for (const code of ['ER_PARSE_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR']) {
            const error = Object.assign(new Error(code), { code });
            const f = fixture(() => error);
            try {
                await assert.rejects(
                    () => new BaseDatabase(f.driver).rawQuery('SELECT 1'),
                    caught => caught === error
                );
                assert.equal(f.calls.length, 1);
            } finally {
                await f.driver.close();
            }
        }
    });

    it('does not replay ambiguous writes, locking reads, or stateful reads', async () => {
        for (const sql of [
            'UPDATE counters SET value=value+1',
            'SELECT id FROM users FOR UPDATE',
            'SELECT GET_LOCK(?, 1)',
            'SELECT custom_function()',
            'SELECT @x := 1'
        ]) {
            const error = lost();
            const f = fixture(() => error);
            try {
                await assert.rejects(
                    () => new BaseDatabase(f.driver).rawQuery(sql),
                    caught => caught === error
                );
                assert.equal(f.calls.length, 1);
                assert.equal(f.stats().destroyed, 1);
            } finally {
                await f.driver.close();
            }
        }
    });

    it('preserves transaction failures without replaying the callback or masking them with rollback errors', async () => {
        for (const failedSql of ['SELECT 1', 'COMMIT']) {
            const error = lost();
            const f = fixture(sql => (sql === failedSql ? error : undefined));
            let callbacks = 0;
            try {
                const db = new BaseDatabase(f.driver);
                await assert.rejects(
                    () =>
                        db.transaction(async session => {
                            callbacks++;
                            await db.rawQuery('SELECT 1', session);
                        }),
                    caught => caught === error
                );
                assert.equal(callbacks, 1);
                assert.equal(f.stats().acquisitions, 1);
                assert.equal(f.stats().destroyed, 1);
                assert.equal(f.calls.includes('ROLLBACK'), false);
            } finally {
                await f.driver.close();
            }
        }
    });

    it('does not recreate session state after a successful statement', async () => {
        const error = lost();
        const f = fixture(sql => (sql === 'SELECT 1' ? error : undefined));
        try {
            const db = new BaseDatabase(f.driver);
            await assert.rejects(
                () =>
                    db.withConnection(async scoped => {
                        await scoped.rawQuery('SET @x = 1');
                        await scoped.rawQuery('SELECT 1');
                    }),
                caught => caught === error
            );
            assert.equal(f.stats().acquisitions, 1);
        } finally {
            await f.driver.close();
        }
    });

    it('preserves session boundaries for concurrent scoped commands', async () => {
        const error = lost();
        const f = fixture(sql => (sql === 'SELECT 1' ? error : undefined));
        try {
            const db = new BaseDatabase(f.driver);
            await assert.rejects(
                () =>
                    db.withConnection(async scoped => {
                        await Promise.all([scoped.rawQuery('SET @x=1'), scoped.rawQuery('SELECT 1')]);
                    }),
                caught => caught === error
            );
            assert.equal(f.stats().acquisitions, 1);
            assert.deepEqual(f.calls, ['SET @x=1', 'SELECT 1']);
        } finally {
            await f.driver.close();
        }
    });

    it('never replays a partially rejected WSREP batch', async () => {
        const error = new Error('WSREP node is not ready for application use');
        const f = fixture(() => error);
        try {
            const connection = await f.driver.acquire();
            await assert.rejects(
                () => connection.query({ sql: 'UPDATE counters SET value=value+1; SELECT 1', bindings: [] }),
                caught => caught === error
            );
            await connection.release();
            assert.equal(f.calls.length, 1);
        } finally {
            await f.driver.close();
        }
    });

    it('does not reopen a pool closed during recovery', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const f = fixture(() => lost());
        const pending = new BaseDatabase(f.driver).rawQuery('SELECT 1');
        const rejected = assert.rejects(pending, /MySQL pool is closed/);
        await new Promise<void>(resolve => setImmediate(resolve));
        await f.driver.close();
        await tick(t);
        await rejected;
        assert.equal(f.stats().acquisitions, 1);
    });

    it('conservatively classifies replayable SELECT statements', () => {
        for (const sql of [
            'SELECT 1',
            'SELECT `id` FROM `users` WHERE `id` IN (?, ?)',
            'SELECT COUNT(*) FROM `users`;',
            'SELECT COALESCE(SUM(`value`), ?) FROM `counters`'
        ])
            assert.equal(isReplayableMySQLRead(sql), true, sql);
        for (const sql of [
            'SELECT 1; DELETE FROM users',
            'SELECT 1 /*! INTO OUTFILE ? */',
            'SELECT RELEASE_LOCK(?)',
            'SELECT LAST_INSERT_ID(?)',
            'SELECT * INTO OUTFILE ?',
            'SELECT * FROM users LOCK IN SHARE MODE',
            'WITH x AS (SELECT 1) SELECT * FROM x',
            'SELECT db.COUNT(*)',
            'SELECT `custom_function`()'
        ])
            assert.equal(isReplayableMySQLRead(sql), false, sql);
    });
});
