import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';

import {
    type App,
    Cache,
    ClientDisconnectedError,
    ClientInvocationError,
    createApp,
    createDistributedMethod,
    createRedis,
    createLogger,
    LeaderService,
    MeshClientRedisRegistry,
    MeshClientRegistry,
    MeshClientService,
    MeshHandlerError,
    MeshNoHandlerError,
    MeshRequestTimeoutError,
    MeshService,
    MeshSrpcServer,
    setCurrentApp,
    sleepMs,
    SrpcClient,
    withMutex
} from '../src';
import type { BaseMessage, SrpcMessageFns, SrpcMeta } from '../src';

const redisEnv = {
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PREFIX: process.env.REDIS_PREFIX
};

const redisSkip = redisEnv.REDIS_HOST ? false : 'set REDIS_HOST to run Redis-backed service integration tests';

type MeshTestMessages = {
    echo: { request: { text: string }; response: { text: string } };
    fail: { request: { message: string }; response: never };
    missing: { request: Record<string, never>; response: never };
};

type MeshTestBroadcasts = {
    refresh: { key: string };
};

const meshOptions = {
    heartbeatIntervalMs: 100,
    nodeTtlMs: 500,
    requestTimeoutMs: 500,
    leaderOptions: {
        ttlMs: 500,
        renewalIntervalMs: 150,
        retryDelayMs: 100
    }
};

const JsonMessage: SrpcMessageFns<BaseMessage> = {
    encode(message) {
        return Buffer.from(JSON.stringify(message));
    },
    decode(input) {
        return JSON.parse(Buffer.from(input).toString('utf8')) as BaseMessage;
    }
};

describe('Redis-backed services', { skip: redisSkip }, () => {
    let app: App;

    before(() => {
        restoreRedisEnv();
        process.env.APP_ENV = 'test';
        app = createApp({});
    });

    after(async () => {
        await app.stop();
        restoreRedisEnv();
    });

    it('acquires leader ownership through Redis', async () => {
        const leader = new LeaderService(`test-${Date.now()}-${process.pid}`, {
            ttlMs: 500,
            renewalIntervalMs: 150,
            retryDelayMs: 100
        });
        const becameLeader = mock.fn();
        leader.setBecameLeaderCallback(becameLeader);

        try {
            leader.start();
            await sleepMs(250);

            assert.equal(leader.isLeader, true);
            assert.equal(becameLeader.mock.callCount(), 1);
        } finally {
            await leader.stop();
        }
    });

    it('detects lease loss and re-enters leader election', async () => {
        const key = `lease-loss-${Date.now()}-${process.pid}`;
        const leader = new LeaderService(key, {
            ttlMs: 500,
            renewalIntervalMs: 50,
            retryDelayMs: 50
        });
        const lostLeader = mock.fn();
        leader.setLostLeaderCallback(lostLeader);

        try {
            leader.start();
            await waitFor(() => leader.isLeader);

            const { client, prefix } = createRedis('MUTEX');
            await client.set(`${prefix}:leader:${key}`, 'replacement-owner', 'PX', 500);
            await waitFor(() => lostLeader.mock.callCount() === 1);

            assert.equal(leader.isLeader, false);
        } finally {
            await leader.stop();
        }
    });

    it('routes mesh requests between Redis-backed nodes', async () => {
        const key = `test-${Date.now()}-${process.pid}`;
        const manualCleanupOptions = {
            ...meshOptions,
            heartbeatIntervalMs: 60_000,
            nodeTtlMs: 60_000
        };
        const first = new MeshService<MeshTestMessages, MeshTestBroadcasts>(key, manualCleanupOptions);
        const second = new MeshService<MeshTestMessages, MeshTestBroadcasts>(key, manualCleanupOptions);
        first.registerHandler('echo', data => ({ text: `first:${data.text}` }));
        second.registerHandler('echo', data => ({ text: `second:${data.text}` }));
        first.registerHandler('fail', data => {
            throw new Error(data.message);
        });
        const firstBroadcasts: Array<{ key: string; sender: number }> = [];
        const secondBroadcasts: Array<{ key: string; sender: number }> = [];
        first.registerBroadcastHandler('refresh', (data, sender) => {
            firstBroadcasts.push({ ...data, sender });
        });
        second.registerBroadcastHandler('refresh', (data, sender) => {
            secondBroadcasts.push({ ...data, sender });
        });

        try {
            await first.start();
            await second.start();
            await sleepMs(100);

            assert.deepStrictEqual(await second.invoke(first.instanceId, 'echo', { text: 'hello' }), {
                text: 'first:hello'
            });
            assert.deepStrictEqual(await first.invoke(second.instanceId, 'echo', { text: 'world' }), {
                text: 'second:world'
            });
            await assert.rejects(second.invoke(first.instanceId, 'fail', { message: 'remote boom' }), MeshHandlerError);
            await assert.rejects(second.invoke(first.instanceId, 'missing', {}), MeshNoHandlerError);
            await assert.rejects(second.invoke(999_999, 'echo', { text: 'missing' }, 25), MeshRequestTimeoutError);

            await first.broadcast('refresh', { key: 'all' });
            await waitFor(() => secondBroadcasts.length === 1);
            assert.deepStrictEqual(firstBroadcasts, [{ key: 'all', sender: first.instanceId }]);
            assert.deepStrictEqual(secondBroadcasts, [{ key: 'all', sender: first.instanceId }]);

            await first.broadcast('refresh', { key: 'remote-only' }, { skipSelf: true });
            await waitFor(() => secondBroadcasts.length === 2);
            assert.equal(firstBroadcasts.length, 1);

            const cleanedNodes: number[] = [];
            first.setNodeCleanedUpCallback(instanceId => {
                cleanedNodes.push(instanceId);
            });
            const { client, prefix } = createRedis('MESH');
            const staleNodeId = 987_654;
            await client.zadd(`${prefix}:mesh:${key}:heartbeats`, Date.now() - manualCleanupOptions.nodeTtlMs - 1_000, String(staleNodeId));
            await client.hset(`${prefix}:mesh:${key}:nodes`, String(staleNodeId), 'stale-host');
            assert.equal(
                (await first.getNodes()).some(node => node.instanceId === staleNodeId),
                true
            );
            await (first as unknown as { doCleanup(): Promise<void> }).doCleanup();
            assert.equal(
                (await first.getNodes()).some(node => node.instanceId === staleNodeId),
                false
            );
            assert.deepStrictEqual(cleanedNodes, [staleNodeId]);
        } finally {
            await second.stop();
            await first.stop();
        }
    });

    it('stores mesh client registrations in Redis', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`test-${Date.now()}-${process.pid}`);
        const first = new MeshClientRegistry(1, backend);
        const second = new MeshClientRegistry(2, backend);

        await first.register('client-1', { role: 'admin' });
        assert.equal((await first.getClient('client-1'))?.nodeId, 1);

        const moved = await second.register('client-1', { role: 'user' });
        assert.deepStrictEqual(moved, { status: 'ok', supersededNodeId: 1 });
        assert.deepStrictEqual(await first.listClientsForNode(1), []);
        assert.equal((await first.getClient('client-1'))?.metadata.role, 'user');

        const removed = await second.cleanupNode(2);
        assert.deepStrictEqual(
            removed.map(client => client.clientId),
            ['client-1']
        );

        await first.register('conflict-client', { role: 'first' });
        assert.deepStrictEqual(await second.register('conflict-client', { role: 'second' }, false), {
            status: 'conflict',
            ownerNodeId: 1
        });
        assert.equal((await first.getClient('conflict-client'))?.metadata.role, 'first');

        assert.deepStrictEqual(await first.reserve('pending-client', { role: 'pending' }), {
            status: 'ok',
            supersededNodeId: null
        });
        assert.equal(await first.getClient('pending-client'), undefined);
        assert.equal(
            (await first.listClients()).some(client => client.clientId === 'pending-client'),
            false
        );
        assert.equal(await first.activate('pending-client', { role: 'active' }), true);
        assert.equal((await first.getClient('pending-client'))?.metadata.role, 'active');
    });

    it('recreates default Redis helper clients after their owning app stops', async () => {
        const key = `lifecycle-${Date.now()}-${process.pid}`;
        const firstApp = createApp({ enableHealthcheck: false });
        await Cache.set(key, 'first');
        await withMutex({ key, mode: 'redis', fn: async () => undefined });
        await firstApp.stop();

        const secondApp = createApp({ enableHealthcheck: false });
        try {
            assert.equal(await Cache.get(key), 'first');
            await withMutex({ key, mode: 'redis', fn: async () => undefined });
        } finally {
            await secondApp.stop();
            setCurrentApp(app);
        }
    });

    it('routes mesh-client delivery, persistence, conflicts, and supersession between nodes', async () => {
        const key = `client-service-${Date.now()}-${process.pid}`;
        const firstDeliveries: string[] = [];
        let firstMetadata = { role: 'initial' };
        const superseded: string[] = [];
        const first = new MeshClientService<{ role: string }>({
            key,
            meshOptions,
            clientInvokeFn: async (clientId, type) => {
                firstDeliveries.push(`${clientId}:${type}`);
                if (type === 'disconnect') throw new ClientDisconnectedError(clientId);
                if (type === 'fail') throw new Error('delivery failed');
                return { deliveredBy: 'first' };
            },
            clientUpdateMetaFn: (_clientId, metadata) => {
                firstMetadata = metadata;
                return true;
            }
        });
        const second = new MeshClientService<{ role: string }>({
            key,
            meshOptions,
            clientInvokeFn: async () => ({ deliveredBy: 'second' })
        });
        first.onClientSuperseded(clientId => {
            superseded.push(clientId);
        });

        try {
            assert.equal(await first.registerClient('before-start', { role: 'ignored' }), true);
            await assert.rejects(first.invoke('before-start', 'notify', {}), /Client not found/);

            await first.start();
            await second.start();
            assert.equal(await first.registerClient('client-1', firstMetadata, false), true);
            assert.equal(await second.registerClient('client-1', { role: 'conflict' }, false), false);

            assert.deepStrictEqual(await second.invoke('client-1', 'notify', {}), { deliveredBy: 'first' });
            assert.deepStrictEqual(firstDeliveries, ['client-1:notify']);
            await assert.rejects(second.invoke('client-1', 'disconnect', {}), ClientDisconnectedError);
            await assert.rejects(second.invoke('client-1', 'fail', {}), ClientInvocationError);

            assert.equal(await second.updateClientMetadata('client-1', { role: 'updated' }), true);
            assert.deepStrictEqual(firstMetadata, { role: 'updated' });
            assert.deepStrictEqual((await second.clientRegistry.getClient('client-1'))?.metadata, { role: 'updated' });

            assert.equal(await second.registerClient('client-1', { role: 'second' }), true);
            await waitFor(() => superseded.includes('client-1'));
            assert.equal((await second.clientRegistry.getClient('client-1'))?.nodeId, second.instanceId);
        } finally {
            await second.stop();
            await first.stop();
        }
    });

    it('tracks MeshSrpcServer activation, metadata synchronization, and lifecycle callbacks', async () => {
        const key = `mesh-srpc-${Date.now()}-${process.pid}`;
        const nestedApp = createApp({ enableHealthcheck: false });
        const server = new MeshSrpcServer<SrpcMeta, BaseMessage, BaseMessage, { role: string }>({
            logger: createLogger('MeshSrpcIntegration'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/mesh-srpc',
            logLevel: false,
            meshKey: key,
            meshOptions
        });
        server.setClientAuthorizer(() => true);
        const connected: Array<{ clientId: string; role: string }> = [];
        const disconnected: Array<{ clientId: string; role: string }> = [];
        server.onClientConnected((clientId, metadata) => {
            connected.push({ clientId, role: metadata.role });
        });
        server.onClientDisconnected((clientId, metadata) => {
            disconnected.push({ clientId, role: metadata.role });
        });

        await server.meshStart();
        const httpServer = await nestedApp.http.listen(0, '127.0.0.1');
        const port = (httpServer.address() as AddressInfo).port;
        const client = new SrpcClient<BaseMessage, BaseMessage>(
            createLogger('MeshSrpcClient'),
            `ws://127.0.0.1:${port}/mesh-srpc`,
            JsonMessage,
            JsonMessage,
            'mesh-client',
            { role: 'initial' },
            'custom-authorizer-does-not-read-this',
            { enableReconnect: false }
        );

        try {
            await client.connect();
            await waitFor(() => connected.length === 1);
            await waitFor(async () => (await server.clientRegistry.getClient('mesh-client'))?.metadata.role === 'initial');

            const stream = server.streamsByClientId.get('mesh-client');
            assert.ok(stream);
            (stream.meta as Record<string, unknown>).role = 'mutated';
            await waitFor(async () => (await server.clientRegistry.getClient('mesh-client'))?.metadata.role === 'mutated');

            assert.equal(await server.updateClientMetadata('mesh-client', { role: 'explicit' }), true);
            assert.equal((stream.meta as Record<string, unknown>).role, 'explicit');
            assert.equal((await server.clientRegistry.getClient('mesh-client'))?.metadata.role, 'explicit');

            client.disconnect();
            await waitFor(() => disconnected.length === 1);
            await waitFor(async () => (await server.clientRegistry.getClient('mesh-client')) === undefined);
            assert.deepStrictEqual(connected, [{ clientId: 'mesh-client', role: 'initial' }]);
            assert.deepStrictEqual(disconnected, [{ clientId: 'mesh-client', role: 'explicit' }]);
        } finally {
            client.disconnect();
            await server.meshStop();
            server.close();
            try {
                await nestedApp.stop();
            } finally {
                setCurrentApp(app);
            }
        }
    });

    it('executes distributed methods locally and logs handler failures', async () => {
        const error = new Error('boom');
        const logger = { error: mock.fn() };
        const handled = mock.fn(async (_data: { value: string }) => {});
        const local = createDistributedMethod<{ value: string }>({ name: `test-local-${Date.now()}` }, handled);
        const failing = createDistributedMethod<{ value: string }>({ name: `test-failing-${Date.now()}`, logger: () => logger }, async () => {
            throw error;
        });

        await local({ value: 'ok' });
        await failing({ value: 'bad' });

        assert.equal(handled.mock.callCount(), 1);
        assert.deepStrictEqual(handled.mock.calls[0].arguments[0], { value: 'ok' });
        assert.equal(logger.error.mock.callCount(), 1);
        assert.strictEqual(logger.error.mock.calls[0].arguments[1], error);
    });
});

function restoreRedisEnv(): void {
    setEnv('REDIS_HOST', redisEnv.REDIS_HOST);
    setEnv('REDIS_PORT', redisEnv.REDIS_PORT);
    setEnv('REDIS_PREFIX', redisEnv.REDIS_PREFIX ?? `tsf-test-${process.pid}`);
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await sleepMs(10);
    }
}
