import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { it, TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Pool } from 'pg';

import { PgClientLike, PostgresDriver } from '../src/database/drivers/postgres';

// Real pg/pg-pool connections against a minimal wire server. Unlike an emitter
// mock, this exercises pg's socket failure state and pg-pool's eviction paths.
async function fixture(t: TestContext, stalled = false, injected = false) {
    const sockets = new Set<Socket>();
    const writes: string[] = [];
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        let startup = true;
        let buffer = Buffer.alloc(0);
        socket.on('data', data => {
            if (stalled) return;
            buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data]);
            while (buffer.length >= (startup ? 4 : 5)) {
                const length = startup ? buffer.readInt32BE(0) : buffer.readInt32BE(1) + 1;
                if (buffer.length < length) return;
                const packet = buffer.subarray(0, length);
                buffer = buffer.subarray(length);
                if (startup) {
                    startup = false;
                    socket.write(Buffer.from('5200000008000000005a0000000549', 'hex')); // AuthenticationOk + ReadyForQuery
                } else if (packet[0] === 0x58) {
                    socket.end(); // Terminate
                } else if (packet.toString().includes('INSERT')) {
                    writes.push(packet.toString());
                    socket.end(); // Drop an in-flight write; its outcome is unknown.
                } else {
                    socket.write(Buffer.from('430000000d53454c4543542031005a0000000549', 'hex')); // SELECT 1 + ReadyForQuery
                }
            }
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const config = { host: '127.0.0.1', port: address.port, user: 'test', database: 'test', max: 1, connectionTimeoutMillis: stalled ? 50 : 1000 };
    const driver = new PostgresDriver(injected ? new Pool(config) : config);
    const pool = Reflect.get(driver, 'pool') as Pool;
    const logs: unknown[][] = [];
    t.mock.method(Reflect.get(driver, 'logger'), 'error', (...args: unknown[]) => logs.push(args));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await pool.end();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    return { pool, driver, sockets, logs, writes };
}

it('handles idle pool disconnects and acquires a fresh connection', async t => {
    const { pool, driver, sockets, logs } = await fixture(t);
    const connection = await driver.acquire();
    const broken = Reflect.get(connection, 'client');
    await connection.release();
    const removed = once(pool, 'remove');
    for (const socket of sockets) socket.end();
    await removed;
    await setImmediate();
    assert(logs.some(args => (args[1] as { source: string }).source === 'pool'));
    for (const args of logs) {
        assert.deepEqual(Object.keys(args[1] as object).sort(), ['message', 'source']);
    }
    assert.equal(pool.totalCount, 0);
    const replacement = await driver.acquire();
    assert.notEqual(Reflect.get(replacement, 'client'), broken);
    assert.equal((await replacement.execute({ sql: 'SELECT 1', bindings: [] })).rowCount, 1);
    await replacement.release();
});

it('handles a disconnect between transaction queries and never reuses the failed client', async t => {
    const { pool, driver, sockets, logs } = await fixture(t);
    const connection = await driver.acquire();
    const broken = Reflect.get(connection, 'client');
    await connection.begin();
    const ended = new Promise<void>(resolve => broken.once('end', resolve));
    for (const socket of sockets) socket.end();
    await ended;
    assert(logs.some(args => (args[1] as { source: string }).source === 'client'));
    await assert.rejects(connection.commit(), /not queryable/);
    await connection.release();
    assert.equal(pool.totalCount, 0);
    const replacement = await driver.acquire();
    assert.notEqual(Reflect.get(replacement, 'client'), broken);
    assert.equal((await replacement.execute({ sql: 'SELECT 1', bindings: [] })).rowCount, 1);
    await replacement.release();
});

it('rejects an in-flight query on disconnect and replaces its client without retrying the query', async t => {
    const { pool, driver, writes } = await fixture(t);
    const connection = await driver.acquire();
    const broken = Reflect.get(connection, 'client');
    await assert.rejects(connection.execute({ sql: 'INSERT INTO events VALUES (1)', bindings: [] }), /Connection terminated unexpectedly/);
    assert.equal(writes.length, 1);
    await connection.release();
    assert.equal(pool.totalCount, 0);
    const replacement = await driver.acquire();
    assert.notEqual(Reflect.get(replacement, 'client'), broken);
    assert.equal((await replacement.execute({ sql: 'SELECT 1', bindings: [] })).rowCount, 1);
    await replacement.release();
});

it('keeps one lifetime client listener across repeated checkouts', async t => {
    const { driver } = await fixture(t, false, true);
    const first = await driver.acquire();
    const client = Reflect.get(first, 'client');
    const listeners = client.listenerCount('error');
    await first.release();
    const second = await driver.acquire();
    assert.equal(Reflect.get(second, 'client'), client);
    assert.equal(client.listenerCount('error'), listeners);
    await second.release();
});

it('defaults the connect timeout while preserving explicit overrides', async () => {
    for (const timeout of [undefined, 1234, 0]) {
        const driver = new PostgresDriver({ connectionTimeoutMillis: timeout });
        try {
            assert.equal(Reflect.get(driver, 'pool').options.connectionTimeoutMillis, timeout ?? 5000);
        } finally {
            await driver.close();
        }
    }
});

it('times out a stalled handshake without retaining a pool client', async t => {
    const { driver, pool } = await fixture(t, true);
    await assert.rejects(driver.acquire(), /timeout/);
    assert.equal(pool.totalCount, 0);
});

it('passes the recorded client error to destructive release for custom pools', async t => {
    const client = new EventEmitter() as EventEmitter & PgClientLike;
    client.query = async () => ({ rows: [], rowCount: 0 });
    let releasedWith: Error | boolean | undefined;
    client.release = error => {
        releasedWith = error;
    };
    const pool = { connect: async () => client, end: async () => {} };
    const driver = new PostgresDriver(pool);
    t.mock.method(Reflect.get(driver, 'logger'), 'error', () => {});
    const connection = await driver.acquire();
    const error = new Error('server disconnected');
    client.emit('error', error);
    await connection.release();
    assert.equal(releasedWith, error);
    await driver.close();
});
