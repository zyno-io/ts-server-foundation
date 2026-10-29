import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { Worker } from 'bullmq';
import Redis from 'ioredis';

import {
    closeRedisClient,
    createApp,
    createRedis,
    createRecoveringRedisClient,
    disconnectAllRedis,
    sleepMs,
    withMutex,
    WorkerQueueRegistry,
    WorkerRecorderService
} from '../src';
import { registerRedisStateReset } from '../src/helpers/redis/lifecycle';
import { createWorkerRedisBackend } from '../src/services/worker/redis';

const redisOptions = { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379), retryStrategy: () => null };

async function endConnection(client: Redis): Promise<void> {
    client.options.retryStrategy = () => null;
    const ended = new Promise<void>(resolve => client.once('end', resolve));
    // Exhaust ioredis's reconnect policy without explicitly stopping the client.
    client.stream.destroy();
    await ended;
    assert.equal(client.status, 'end');
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt++) {
        if (check()) return;
        await sleepMs(20);
    }
    assert.fail('Timed out waiting for Redis recovery');
}

it('closes non-ready custom clients without waiting for a QUIT response', async () => {
    for (const status of ['end', 'connecting', 'reconnecting', 'wait'] as const) {
        let disconnects = 0;
        await closeRedisClient({
            status,
            async quit() {
                assert.fail(`QUIT must not be attempted in ${status} status`);
            },
            disconnect() {
                disconnects++;
            }
        });
        assert.equal(disconnects, 1);
    }
});

it('releases a ready custom client when QUIT fails during shutdown', async () => {
    const calls: string[] = [];
    await closeRedisClient({
        status: 'ready',
        async quit() {
            calls.push('quit');
            throw new Error('Connection is closed.');
        },
        disconnect() {
            calls.push('disconnect');
        }
    });
    assert.deepEqual(calls, ['quit', 'disconnect']);
});

it('continues retrying when an explicit reconnect overlaps the background timer and fails', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let rejectConnection!: (error: Error) => void;
    const connecting = new Promise<void>((_resolve, reject) => {
        rejectConnection = reject;
    });
    let attempts = 0;
    t.mock.method(Redis.prototype, 'connect', function (this: Redis) {
        if (++attempts === 1) {
            this.status = 'connecting';
            return connecting;
        }
        this.status = 'ready';
        this.emit('ready');
        return Promise.resolve();
    });
    const client = createRecoveringRedisClient({ lazyConnect: true });
    try {
        client.status = 'end';
        client.emit('end');
        const manualConnect = client.connect();
        t.mock.timers.tick(1_000);
        client.status = 'end';
        client.emit('end');
        rejectConnection(new Error('Connection is closed.'));
        await assert.rejects(manualConnect, /Connection is closed/);
        t.mock.timers.tick(2_000);
        assert.equal(attempts, 2);
        assert.equal(client.status, 'ready');
    } finally {
        client.disconnect();
    }
});

describe(
    'Redis terminal recovery',
    { skip: process.env.REDIS_HOST ? false : 'set REDIS_HOST to run Redis recovery integration', timeout: 15_000 },
    () => {
        it('recovers the same shared client and mutex without invalidating cached state', async () => {
            const app = createApp({ enableHealthcheck: false, defaultConfig: { REDIS_PREFIX: randomUUID() } });
            const connection = createRedis();
            let resets = 0;
            registerRedisStateReset(connection.client, () => resets++);
            try {
                await connection.client.ping();
                await endConnection(connection.client);
                assert.equal(resets, 0);
                const result = await withMutex({ key: 'recovery', mode: 'redis', redis: () => connection, fn: async () => 'acquired' });
                assert.equal(result, 'acquired');
                assert.equal(connection.client.status, 'ready');
                assert.equal(resets, 0);
            } finally {
                await app.stop();
            }
            assert.equal(resets, 1);
            await waitFor(() => connection.client.status === 'end');
        });

        it('shares one reconnect for concurrent commands and executes each command once', async () => {
            const client = createRecoveringRedisClient(redisOptions);
            const key = `recovery:${randomUUID()}`;
            let connects = 0;
            client.on('connect', () => connects++);
            try {
                await client.ping();
                await endConnection(client);
                const values = await Promise.all(Array.from({ length: 20 }, () => client.incr(key)));
                assert.deepEqual(
                    values,
                    Array.from({ length: 20 }, (_, index) => index + 1)
                );
                assert.equal(connects, 2);
                await client.del(key);
            } finally {
                client.disconnect();
            }
        });

        it('retries repeated terminal failures in the background without a command', async () => {
            const server = createServer();
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            await new Promise<void>(resolve => server.close(() => resolve()));
            const client = createRecoveringRedisClient(redisOptions);
            client.on('error', () => {});
            try {
                await client.ping();
                client.options.port = address.port;
                await endConnection(client);
                const failedAgain = new Promise<void>(resolve => client.once('end', resolve));
                await failedAgain;
                client.options.port = redisOptions.port;
                await waitFor(() => client.status === 'ready');
                const response = await client.ping();
                assert.equal(response, 'PONG');
            } finally {
                client.disconnect();
            }
        });

        it('preserves recovery on duplicates and respects QUIT and disconnect', async () => {
            const client = createRecoveringRedisClient(redisOptions);
            const duplicate = client.duplicate();
            try {
                await Promise.all([client.ping(), duplicate.ping()]);
                await endConnection(duplicate);
                const duplicateResponse = await duplicate.ping();
                assert.equal(duplicateResponse, 'PONG');
                await closeRedisClient(duplicate);
                await waitFor(() => duplicate.status === 'end');
                await assert.rejects(duplicate.ping(), /Connection is closed/);
                client.disconnect();
                await waitFor(() => client.status === 'end');
                await assert.rejects(client.ping(), /Connection is closed/);
                await sleepMs(1_100);
                assert.equal(client.status, 'end');
                assert.equal(duplicate.status, 'end');
                await client.connect();
                await endConnection(client);
                const response = await client.ping();
                assert.equal(response, 'PONG');
            } finally {
                client.disconnect();
                duplicate.disconnect();
            }
        });

        it('cancels recovery when closing an already-ended custom client', async () => {
            const client = createRecoveringRedisClient(redisOptions);
            try {
                await client.ping();
                await endConnection(client);
                await closeRedisClient(client);
                await sleepMs(1_100);
                assert.equal(client.status, 'end');
                await assert.rejects(client.ping(), /Connection is closed/);
            } finally {
                client.disconnect();
            }
        });

        it('cancels recovery during application shutdown even when already ended', async () => {
            const app = createApp({ enableHealthcheck: false });
            const { client } = createRedis();
            await client.ping();
            await endConnection(client);
            await disconnectAllRedis();
            await app.stop();
            await sleepMs(1_100);
            assert.equal(client.status, 'end');
            await assert.rejects(client.ping(), /Connection is closed/);
        });

        it('recovers BullMQ command, event, and blocking clients and records later terminal jobs', async () => {
            const app = createApp({ enableHealthcheck: false, defaultConfig: { REDIS_PREFIX: `recovery:${randomUUID()}` } });
            const registry = new WorkerQueueRegistry(app.config);
            const recorder = new WorkerRecorderService();
            const queueName = 'recovery';
            const queue = registry.getBullQueue(queueName);
            const worker = new Worker(queueName, async job => job.data.data, registry.getBullMqOptions(), createWorkerRedisBackend);
            worker.on('error', () => {});
            try {
                await worker.waitUntilReady();
                await recorder.start(queueName, registry);
                const observerMap = (recorder as unknown as { observers: Map<string, { getBackend(): typeof queue.backend }> }).observers;
                const observer = observerMap.get(queueName)!;
                const clients = await Promise.all([
                    queue.getBackend().client,
                    observer.getBackend().client,
                    worker.getBackend().client,
                    worker.getBackend().blockingClient!
                ]);
                await Promise.all(clients.map(client => endConnection(client as unknown as Redis)));
                await queue.add('RecoveredJob', { data: 'recovered', options: {} });
                await waitFor(() => recorder.getRecords().length === 1);
                const records = recorder.getRecords();
                assert.equal(records[0].status, 'completed');
                assert.equal(records[0].result, 'recovered');
                const remaining = await queue.getCompleted();
                assert.equal(remaining.length, 0);
            } finally {
                await worker.close();
                await recorder.stop();
                await queue.obliterate({ force: true });
                await registry.shutdown();
                await app.stop();
            }
        });
    }
);
