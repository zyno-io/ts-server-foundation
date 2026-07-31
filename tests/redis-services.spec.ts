import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
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
    MeshService,
    MeshSrpcServer,
    setCurrentApp,
    sleepMs,
    SrpcByteStream,
    SrpcClient,
    SrpcError,
    withMutex
} from '../src';
import type { BaseMessage, SrpcMessageFns, SrpcMeta } from '../src';

const redisEnv = {
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PREFIX: process.env.REDIS_PREFIX
};

const redisSkip = redisEnv.REDIS_HOST ? false : 'set REDIS_HOST to run Redis-backed service integration tests';

type MeshTestBroadcasts = {
    refresh: { key: string };
};

const meshOptions = {
    heartbeatIntervalMs: 100,
    nodeTtlMs: 500,
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

interface DirectClientMessage extends BaseMessage {
    dConsumeResponse?: { bytes: number };
    dProduceResponse?: { streamId: number };
    dFailResponse?: { ok: boolean };
}

interface DirectServerMessage extends BaseMessage {
    dConsumeRequest?: { streamId: number };
    dProduceRequest?: { content: string };
    dFailRequest?: { message: string };
}

const DirectClientCodec = createBinaryJsonCodec<DirectClientMessage>();
const DirectServerCodec = createBinaryJsonCodec<DirectServerMessage>();

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
    it('bounds each expired-member cleanup and recovery pass and completes through later passes', async () => {
        const key = `bounded-mesh-cleanup-${Date.now()}-${process.pid}`;
        const service = new MeshService(key, {
            heartbeatIntervalMs: 100,
            nodeTtlMs: 1_000,
            cleanupBatchSize: 2
        }) as any;
        const { client, prefix } = createRedis('MESH');
        service.prefix = prefix;
        const heartbeatsKey = `${prefix}:mesh:${key}:heartbeats`;
        const nodesKey = `${prefix}:mesh:${key}:nodes`;
        const cleanupKey = `${prefix}:mesh:${key}:cleanup`;
        const processingKey = `${cleanupKey}:processing`;
        const cleaned: number[] = [];
        service.setNodeCleanedUpCallback((nodeId: number) => {
            cleaned.push(nodeId);
        });

        // Recovery of a prior leader's in-flight obligations is bounded too.
        await client.lpush(processingKey, '103', '102', '101');
        await service.doCleanup();
        assert.equal(await client.llen(processingKey), 1);
        assert.equal(cleaned.length, 2);
        await service.doCleanup();
        assert.equal(await client.llen(processingKey), 0);
        assert.equal(cleaned.length, 3);

        for (let index = 0; index < 5; index++) {
            const nodeId = 200 + index;
            await client.zadd(heartbeatsKey, Date.now() - 10_000, String(nodeId));
            await client.hset(nodesKey, String(nodeId), JSON.stringify({ hostname: `stale-${nodeId}` }));
        }
        await service.doCleanup();
        assert.equal(await client.zcard(heartbeatsKey), 3);
        assert.equal(cleaned.length, 5);
        await service.doCleanup();
        assert.equal(await client.zcard(heartbeatsKey), 1);
        assert.equal(cleaned.length, 7);
        await service.doCleanup();
        assert.equal(await client.zcard(heartbeatsKey), 0);
        assert.equal(await client.hlen(nodesKey), 0);
        assert.equal(cleaned.length, 8);

        const callbackOrder: number[] = [];
        service.setNodeCleanedUpCallback((nodeId: number) => {
            callbackOrder.push(nodeId);
            if (nodeId === 301) throw new Error('retry this obligation later');
        });
        await client.rpush(cleanupKey, '302', '301');
        await service.doCleanup();
        assert.deepEqual(callbackOrder, [301]);
        await service.doCleanup();
        assert.deepEqual(callbackOrder, [301, 302, 301]);
    });

    it('leaves a blocked cleanup obligation recoverable when its leader generation is fenced', async () => {
        const key = `fenced-mesh-cleanup-${Date.now()}-${process.pid}`;
        const service = new MeshService(key, { ...meshOptions, cleanupBatchSize: 1 }) as any;
        const { client, prefix } = createRedis('MESH');
        service.prefix = prefix;
        service.running = true;
        service.generation = 1;
        service.leaseSafeUntil = Number.POSITIVE_INFINITY;
        service.leaderService = { isLeader: true };
        const cleanupKey = `${prefix}:mesh:${key}:cleanup`;
        const processingKey = `${cleanupKey}:processing`;
        await client.lpush(cleanupKey, '712');
        let release!: () => void;
        const blocked = new Promise<void>(resolve => {
            release = resolve;
        });
        service.setNodeCleanedUpCallback(async () => blocked);
        const cleanup = service.doCleanup();
        await waitFor(async () => (await client.llen(processingKey)) === 1);
        service.generation++;
        service.leaderEpoch++;
        const recoveredByHealthyEpoch = service.doCleanup();
        release();
        await Promise.all([cleanup, recoveredByHealthyEpoch]);
        assert.equal(await client.llen(processingKey), 0);
        assert.equal(await client.llen(cleanupKey), 0);
    });

    it('uses exact cleanup claim tokens so stale ACK and NACK cannot affect a reclaimed node ID', async () => {
        const key = `token-cleanup-${Date.now()}-${process.pid}`;
        const service = new MeshService(key, meshOptions) as any;
        const { client, prefix } = createRedis('MESH');
        service.prefix = prefix;
        service.running = true;
        service.generation = 1;
        service.leaseSafeUntil = Number.POSITIVE_INFINITY;
        service.leaderService = { isLeader: true };
        const cleanupKey = `${prefix}:mesh:${key}:cleanup`;
        const processingKey = `${cleanupKey}:processing`;
        await client.lpush(cleanupKey, '811');

        let callbackCount = 0;
        let releaseOld!: () => void;
        const oldBlocked = new Promise<void>(resolve => {
            releaseOld = resolve;
        });
        let releaseNew!: () => void;
        const newBlocked = new Promise<void>(resolve => {
            releaseNew = resolve;
        });
        service.setNodeCleanedUpCallback(async () => {
            callbackCount++;
            await (callbackCount === 1 ? oldBlocked : newBlocked);
        });

        const oldCleanup = service.doCleanup();
        await waitFor(async () => (await client.llen(processingKey)) === 1);
        const oldClaim = await client.lindex(processingKey, 0);
        assert.ok(oldClaim?.startsWith('811|'));

        service.generation++;
        service.leaderEpoch++;
        const newCleanup = service.doCleanup();
        await waitFor(async () => {
            const claim = await client.lindex(processingKey, 0);
            return claim !== null && claim !== oldClaim;
        });
        const newClaim = await client.lindex(processingKey, 0);
        assert.ok(newClaim?.startsWith('811|'));
        assert.notEqual(oldClaim, newClaim);

        // ACK and NACK both begin with an exact-token LREM. A delayed old
        // claimant therefore cannot remove or requeue the successor claim.
        assert.equal(await client.lrem(processingKey, 1, oldClaim!), 0);
        const staleNackRemoved = await client.lrem(processingKey, 1, oldClaim!);
        if (staleNackRemoved > 0) await client.lpush(cleanupKey, '811');
        assert.equal(staleNackRemoved, 0);
        assert.deepEqual(await client.lrange(processingKey, 0, -1), [newClaim]);

        releaseOld();
        await oldCleanup;
        releaseNew();
        await newCleanup;
        assert.equal(await client.llen(processingKey), 0);
        assert.equal(await client.llen(cleanupKey), 0);
    });

    it('does not recreate node metadata after a concurrent deregistration', async () => {
        const key = `metadata-cas-${Date.now()}-${process.pid}`;
        const service = new MeshService(key, meshOptions);
        await service.start();
        try {
            const { client, prefix } = createRedis('MESH');
            const id = service.instanceId;
            await client.multi().zrem(`${prefix}:mesh:${key}:heartbeats`, String(id)).hdel(`${prefix}:mesh:${key}:nodes`, String(id)).exec();
            await assert.rejects(service.updateNodeMetadata({ processId: 'late-metadata' }), /membership disappeared/);
            assert.equal(await client.zscore(`${prefix}:mesh:${key}:heartbeats`, String(id)), null);
            assert.equal(await client.hget(`${prefix}:mesh:${key}:nodes`, String(id)), null);
        } finally {
            await service.stop();
        }
    });

    it('stores mesh client registrations in Redis', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`test-${Date.now()}-${process.pid}`);
        const first = new MeshClientRegistry(1, backend);
        const second = new MeshClientRegistry(2, backend);

        await first.register('client-1', { role: 'admin' }, true, 'connection-1');
        assert.equal((await first.getClient('client-1'))?.nodeId, 1);

        const moved = await second.register('client-1', { role: 'user' }, true, 'connection-2');
        assert.deepStrictEqual(moved, { status: 'conflict', ownerNodeId: 1 });
        assert.equal((await first.getClient('client-1'))?.metadata.role, 'admin');

        const removed = await first.cleanupNode(1);
        assert.deepStrictEqual(
            removed.map(client => client.clientId),
            ['client-1']
        );

        await first.register('conflict-client', { role: 'first' }, true, 'conflict-connection-1');
        assert.deepStrictEqual(await second.register('conflict-client', { role: 'second' }, false, 'conflict-connection-2'), {
            status: 'conflict',
            ownerNodeId: 1
        });
        assert.equal((await first.getClient('conflict-client'))?.metadata.role, 'first');

        assert.deepStrictEqual(await first.reserve('pending-client', { role: 'pending' }, false, 'pending-connection'), {
            status: 'ok',
            supersededNodeId: null
        });
        assert.equal(await first.getClient('pending-client'), undefined);
        assert.equal(
            (await first.listClients()).some(client => client.clientId === 'pending-client'),
            false
        );
        assert.equal(await first.activate('pending-client', { role: 'active' }, 'pending-connection'), true);
        assert.equal((await first.getClient('pending-client'))?.metadata.role, 'active');

        await first.register('fenced-client', { role: 'old' }, true, 'connection-old');
        assert.deepEqual(await first.register('fenced-client', { role: 'current' }, true, 'connection-current'), {
            status: 'conflict',
            ownerNodeId: 1
        });
        assert.equal(await first.updateMetadata('fenced-client', { role: 'stale-update' }, 'connection-current'), false);
        assert.equal((await first.getClient('fenced-client'))?.connectionId, 'connection-old');
        assert.equal((await first.getClient('fenced-client'))?.metadata.role, 'old');
        assert.equal(await first.unregister('fenced-client', 'connection-old'), true);
    });

    it('commits a takeover after the fenced owner unregisters before claim commit', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`claim-unregister-${Date.now()}-${process.pid}`);
        const oldOwner = new MeshClientRegistry(31, backend);
        const claimant = new MeshClientRegistry(32, backend);
        await oldOwner.register('handoff-client', { role: 'old' }, false, 'connection-old');

        const claim = await claimant.claim('handoff-client', { role: 'new' }, 'active', true, 'connection-new');
        assert.equal(claim?.status, 'ok');
        assert.equal(claim?.status === 'ok' && claim.previous?.connectionId, 'connection-old');
        assert.equal(await oldOwner.unregister('handoff-client', 'connection-old'), true);
        assert.equal(claim?.status === 'ok' && (await claimant.commitClaim('handoff-client', claim.claimId)), true);
        const current = await claimant.getClient('handoff-client');
        assert.equal(current?.nodeId, 32);
        assert.equal(current?.connectionId, 'connection-new');
        assert.deepEqual(current?.metadata, { role: 'new' });
    });

    it('exactly serializes pending claim preimages that stay pending, activate, or disappear', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`pending-preimage-${Date.now()}-${process.pid}`);
        const oldOwner = new MeshClientRegistry(41, backend);
        const claimant = new MeshClientRegistry(42, backend);

        for (const outcome of ['pending', 'activated', 'absent'] as const) {
            const clientId = `pending-preimage-${outcome}`;
            await oldOwner.reserve(clientId, { role: 'old-pending' }, false, 'connection-old');
            const claim = await claimant.claim(clientId, { role: 'new-active' }, 'active', true, 'connection-new');
            assert.equal(claim?.status, 'ok');
            assert.equal(claim?.status === 'ok' && claim.previous?.state, 'pending');
            assert.ok(claim?.status === 'ok' && claim.previous?.claimId);
            if (!claim || claim.status !== 'ok') continue;

            if (outcome === 'activated') {
                assert.equal(await oldOwner.activate(clientId, { role: 'old-active' }, 'connection-old'), true);
                assert.equal(await claimant.commitClaim(clientId, claim.claimId), 'previous-changed');
                assert.equal(await claimant.removeClaimPrevious(clientId, claim.claimId), true);
            } else if (outcome === 'absent') {
                assert.equal(await oldOwner.unregister(clientId, 'connection-old'), true);
            }
            assert.equal(await claimant.commitClaim(clientId, claim.claimId), true);
            const current = await claimant.getClientIncludingPending(clientId);
            assert.equal(current?.nodeId, 42);
            assert.equal(current?.connectionId, 'connection-new');
            assert.equal(current?.state, 'active');
        }
    });

    it('idempotently reconciles and exactly removes a committed claim', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`claim-idempotent-${Date.now()}-${process.pid}`);
        const registry = new MeshClientRegistry(33, backend);
        const claim = await registry.claim('pending-client', { role: 'pending' }, 'pending', true, 'pending-connection');
        assert.equal(claim?.status, 'ok');
        assert.equal(claim?.status === 'ok' && (await registry.commitClaim('pending-client', claim.claimId)), true);
        // Models a retry after Redis committed but the first response was lost.
        assert.equal(claim?.status === 'ok' && (await registry.commitClaim('pending-client', claim.claimId)), true);
        const raw = await registry.getClientIncludingPending('pending-client');
        assert.equal(raw?.claimId, claim?.status === 'ok' ? claim.claimId : undefined);
        assert.equal(claim?.status === 'ok' && (await registry.removeClaimResult('pending-client', claim.claimId)), true);
        assert.equal(await registry.getClientIncludingPending('pending-client'), undefined);
    });

    it('deduplicates concurrent Redis claims only for the exact caller operation and payload', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`claim-operation-${Date.now()}-${process.pid}`);
        const first = new MeshClientRegistry(34, backend, 'process-a');
        const second = new MeshClientRegistry(34, backend, 'process-a');
        const operationId = randomUUID();
        const identical = await Promise.all([
            first.claim('same-operation', { role: 'identical' }, 'pending', true, 'connection', operationId),
            second.claim('same-operation', { role: 'identical' }, 'pending', true, 'connection', operationId)
        ]);
        assert.equal(
            identical.every(result => result?.status === 'ok'),
            true
        );
        assert.equal(identical[0]?.status === 'ok' && identical[1]?.status === 'ok' && identical[0].claimId === identical[1].claimId, true);

        const conflictingOperationId = randomUUID();
        const differing = await Promise.all([
            first.claim('different-payload', { role: 'first' }, 'pending', true, 'connection', conflictingOperationId),
            second.claim('different-payload', { role: 'second' }, 'pending', true, 'connection', conflictingOperationId)
        ]);
        assert.equal(differing.filter(result => result?.status === 'ok').length, 1);
        assert.equal(differing.filter(result => result?.status === 'conflict').length, 1);

        const distinctOperations = await Promise.all([
            first.claim('different-operation', { role: 'identical' }, 'pending', true, 'connection', randomUUID()),
            second.claim('different-operation', { role: 'identical' }, 'pending', true, 'connection', randomUUID())
        ]);
        assert.equal(distinctOperations.filter(result => result?.status === 'ok').length, 1);
        assert.equal(distinctOperations.filter(result => result?.status === 'conflict').length, 1);
    });

    it('retries a response-lost claim with one byte-identical metadata snapshot', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`claim-snapshot-${Date.now()}-${process.pid}`);
        const originalClaim = backend.claim.bind(backend);
        let claimCalls = 0;
        backend.claim = async (...args) => {
            const result = await originalClaim(...args);
            claimCalls++;
            if (claimCalls === 1) throw new Error('claim response lost after Redis mutation');
            return result;
        };
        let serializations = 0;
        const metadata = {
            toJSON() {
                serializations++;
                return { role: `snapshot-${serializations}` };
            }
        } as unknown as { role: string };
        const service = new MeshClientService<{ role: string }>({
            key: `claim-snapshot-service-${Date.now()}-${process.pid}`,
            meshOptions,
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });

        try {
            await service.start();
            assert.equal(await service.registerClient('snapshot-client', metadata, true, 'snapshot-connection'), true);
            const registered = await service.clientRegistry.getClientIncludingPending('snapshot-client');
            assert.equal(registered?.connectionId, 'snapshot-connection');
            assert.equal(claimCalls, 2);
        } finally {
            await service.stop();
        }
    });

    it('enforces registry record limits and paginates listings and dead-node cleanup', async () => {
        const backend = new MeshClientRedisRegistry<{ value: string }>(`bounded-registry-${Date.now()}-${process.pid}`, {
            maxClientIdBytes: 16,
            maxMetadataBytes: 32,
            maxClientsPerNode: 3,
            scanBatchSize: 1,
            cleanupBatchSize: 1
        });
        const registry = new MeshClientRegistry(41, backend);
        await registry.register('client-a', { value: 'a' }, false, 'connection-a');
        await registry.register('client-b', { value: 'b' }, false, 'connection-b');
        await registry.register('client-c', { value: 'c' }, false, 'connection-c');
        await assert.rejects(registry.register('client-d', { value: 'd' }, false, 'connection-d'), /per-node registration limit/);
        await assert.rejects(registry.register('client-id-is-too-long', { value: 'x' }, false, 'connection-x'), /client ID/i);
        await assert.rejects(registry.updateMetadata('client-a', { value: 'x'.repeat(40) }, 'connection-a'), /metadata exceeds/i);

        assert.deepEqual((await registry.listClients()).map(client => client.clientId).sort(), ['client-a', 'client-b', 'client-c']);
        assert.deepEqual((await registry.listClientsForNode()).map(client => client.clientId).sort(), ['client-a', 'client-b', 'client-c']);
        const paged: string[] = [];
        let cursor: string | undefined = '0';
        do {
            const page = await registry.listClientsPage(cursor);
            paged.push(...page.clients.map(client => client.clientId));
            cursor = page.cursor;
        } while (cursor !== undefined);
        assert.deepEqual([...new Set(paged)].sort(), ['client-a', 'client-b', 'client-c']);
        await assert.rejects(registry.listClientsPage('not-a-cursor'), /cursor is invalid/);

        const removed = await backend.cleanupNodeAndEnqueueOrphaned?.(41);
        assert.deepEqual(removed?.map(client => client.clientId).sort(), ['client-a', 'client-b', 'client-c']);
        const delivered: string[] = [];
        for (;;) {
            const orphan = await backend.claimOrphaned?.('bounded-cleanup-worker');
            if (!orphan) break;
            assert.equal(orphan.clients.length, 1);
            delivered.push(orphan.clients[0].clientId);
            assert.equal(await backend.ackOrphaned?.(orphan.id, orphan.claimToken), true);
        }
        assert.deepEqual(delivered.sort(), ['client-a', 'client-b', 'client-c']);
    });

    it('durably claims, nacks, recovers, and acknowledges orphan snapshots', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`orphans-${Date.now()}-${process.pid}`);
        const client = { clientId: 'orphan-1', nodeId: 7, connectionId: 'connection-1', connectedAt: Date.now(), metadata: { role: 'orphan' } };
        await backend.enqueueOrphaned?.(7, [client]);
        const first = await backend.claimOrphaned?.('worker-a');
        assert.ok(first);
        assert.equal(first.clients[0].clientId, client.clientId);
        assert.equal(await backend.nackOrphaned?.(first.id, first.claimToken), true);
        const recovered = await backend.claimOrphaned?.('worker-b');
        assert.ok(recovered);
        assert.notEqual(recovered.claimToken, first.claimToken);
        assert.equal(await backend.ackOrphaned?.(recovered.id, recovered.claimToken), true);
        assert.equal(await backend.claimOrphaned?.('worker-c'), undefined);
    });

    it('bounds durable orphan admission globally and resumes after acknowledgement', async () => {
        const key = `bounded-orphans-${Date.now()}-${process.pid}`;
        const maxOrphanBytes = 1_024;
        const backend = new MeshClientRedisRegistry<{ role: string }>(key, {
            maxOrphanItems: 2,
            maxOrphanBytes
        });
        const firstClient = {
            clientId: 'first',
            nodeId: 7,
            connectionId: 'first-connection',
            connectedAt: Date.now(),
            metadata: { role: 'first'.repeat(80) }
        };
        const secondClient = {
            clientId: 'second',
            nodeId: 8,
            connectionId: 'second-connection',
            connectedAt: Date.now(),
            metadata: { role: 'second'.repeat(40) }
        };
        await backend.enqueueOrphaned?.(7, [firstClient]);

        const claimed = await backend.claimOrphaned?.('bounded-worker');
        assert.ok(claimed);
        assert.equal(claimed.clients[0].clientId, 'first');
        const { client: accountingClient, prefix: accountingPrefix } = createRedis('MESH');
        const orphanKey = `${accountingPrefix}:mesh:${key}:orphaned`;
        const accounted = Number(await accountingClient.hget(`${accountingPrefix}:mesh:${key}:orphaned:accounting`, 'bytes'));
        assert.ok(accounted <= maxOrphanBytes);
        assert.ok((await accountingClient.hstrlen(orphanKey, claimed.id)) <= maxOrphanBytes);
        assert.equal(await backend.nackOrphaned?.(claimed.id, claimed.claimToken), true);
        // Claim/NACK rewrites the snapshot; the byte counter must track that
        // exact mutation and still reject a second large admission.
        await assert.rejects(backend.enqueueOrphaned?.(8, [secondClient]), /orphan queue is full/);
        const reclaimed = await backend.claimOrphaned?.('bounded-worker');
        assert.ok(reclaimed);
        assert.equal(await backend.ackOrphaned?.(reclaimed.id, reclaimed.claimToken), true);

        await backend.enqueueOrphaned?.(8, [secondClient]);
        const resumed = await backend.claimOrphaned?.('bounded-worker-2');
        assert.equal(resumed?.clients[0].clientId, 'second');
        assert.equal(await backend.ackOrphaned?.(resumed!.id, resumed!.claimToken), true);
    });

    it('drains malformed accounted orphan state and reopens bounded admission', async () => {
        const key = `malformed-orphans-${Date.now()}-${process.pid}`;
        const backend = new MeshClientRedisRegistry<{ role: string }>(key, { maxOrphanItems: 1, maxOrphanBytes: 2_048 });
        const { client, prefix } = createRedis('MESH');
        const orphanKey = `${prefix}:mesh:${key}:orphaned`;
        const indexKey = `${orphanKey}:index`;
        const accountingKey = `${orphanKey}:accounting`;
        const malformed = ['{bad json', '"string"', '1', 'true', 'null', '[]'];
        for (let index = 0; index < malformed.length; index++) {
            await client.hset(orphanKey, `malformed-${index}`, malformed[index]);
            await client.zadd(indexKey, 0, `malformed-${index}`);
        }
        await client.hset(
            accountingKey,
            'items',
            String(malformed.length),
            'bytes',
            String(malformed.reduce((total, item) => total + Buffer.byteLength(item), 0))
        );
        assert.equal(await backend.claimOrphaned?.('migration-worker'), undefined);
        assert.equal(await client.hlen(orphanKey), 0);
        await backend.enqueueOrphaned?.(1, [
            { clientId: 'new', nodeId: 1, connectionId: 'new-connection', connectedAt: 1, metadata: { role: 'new' } }
        ]);
        assert.ok(await backend.claimOrphaned?.('healthy-worker'));
    });

    it('atomically removes active clients into a redeliverable orphan snapshot', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`atomic-orphans-${Date.now()}-${process.pid}`);
        const registry = new MeshClientRegistry(17, backend);
        await registry.register('active-client', { role: 'active' }, false, 'connection-active');
        await registry.reserve('pending-client', { role: 'pending' }, false, 'connection-pending');

        const removed = await backend.cleanupNodeAndEnqueueOrphaned?.(17);
        assert.deepEqual(
            removed?.map(client => client.clientId),
            ['active-client']
        );
        assert.equal(await registry.getClient('active-client'), undefined);

        const first = await backend.claimOrphaned?.('worker-a');
        assert.ok(first);
        assert.deepEqual(
            first.clients.map(client => client.clientId),
            ['active-client']
        );
        assert.equal(await backend.nackOrphaned?.(first.id, first.claimToken), true);
        const retry = await backend.claimOrphaned?.('worker-b');
        assert.ok(retry);
        assert.equal(retry.id, first.id);
        assert.equal(await backend.ackOrphaned?.(retry.id, retry.claimToken), true);
    });

    it('rejects dead-node orphan cleanup without mutating node state when the orphan queue is full', async () => {
        const key = `full-cleanup-orphans-${Date.now()}-${process.pid}`;
        const backend = new MeshClientRedisRegistry<{ role: string }>(key, { maxOrphanItems: 1 });
        const registry = new MeshClientRegistry(17, backend);
        await backend.enqueueOrphaned?.(99, [
            {
                clientId: 'existing-orphan',
                nodeId: 99,
                connectionId: 'existing-orphan-connection',
                connectedAt: Date.now(),
                metadata: { role: 'held' }
            }
        ]);
        await registry.register('active-client', { role: 'active' }, false, 'connection-active');
        await registry.reserve('pending-client', { role: 'pending' }, false, 'connection-pending');

        const { client, prefix } = createRedis('MESH');
        const clientsKey = `${prefix}:mesh:${key}:clients`;
        const nodeSetKey = `${prefix}:mesh:${key}:node:17:clients`;
        const nodeClaimsKey = `${prefix}:mesh:${key}:node:17:claims`;
        assert.equal(await client.scard(nodeSetKey), 2);
        // Direct registry reservations are already persisted as pending
        // records. Two-phase claims are owned by MeshClientService instead.
        assert.equal(await client.scard(nodeClaimsKey), 0);
        assert.ok((await client.ttl(clientsKey)) > 0);
        assert.ok((await client.ttl(nodeSetKey)) > 0);

        await assert.rejects(backend.cleanupNodeAndEnqueueOrphaned?.(17), /orphan queue is full/);

        assert.equal((await registry.getClient('active-client'))?.connectionId, 'connection-active');
        const pending = await registry.getClientIncludingPending('pending-client');
        assert.equal(pending?.state, 'pending');
        assert.equal(pending?.connectionId, 'connection-pending');
        assert.equal(await client.sismember(nodeSetKey, 'active-client'), 1);
        assert.equal(await client.sismember(nodeSetKey, 'pending-client'), 1);
        assert.equal(await client.sismember(nodeClaimsKey, 'pending-client'), 0);
        assert.ok((await client.ttl(clientsKey)) > 0);
        assert.ok((await client.ttl(nodeSetKey)) > 0);
    });

    it('atomically rejects cross-instance auth nonce replay and enforces per-principal quota', async () => {
        const key = `auth-nonces-${Date.now()}-${process.pid}`;
        const first = new MeshClientRedisRegistry<object>(key);
        const second = new MeshClientRedisRegistry<object>(key);
        const expiresAt = Date.now() + 60_000;

        assert.equal(await first.consumeAuthNonce?.('principal-a', 'shared-nonce', expiresAt), true);
        assert.equal(await second.consumeAuthNonce?.('principal-a', 'shared-nonce', expiresAt), false);
        assert.equal(await second.consumeAuthNonce?.('principal-b', 'shared-nonce', expiresAt), true);
        for (let index = 1; index < 256; index++) {
            assert.equal(await first.consumeAuthNonce?.('quota-principal', `nonce-${index}`, expiresAt), true);
        }
        assert.equal(await second.consumeAuthNonce?.('quota-principal', 'nonce-0', expiresAt), true);
        assert.equal(await second.consumeAuthNonce?.('quota-principal', 'over-quota', expiresAt), false);
    });

    it('bounds the global Redis authentication principal budget', async () => {
        const key = `auth-principal-budget-${Date.now()}-${process.pid}`;
        const first = new MeshClientRedisRegistry<object>(key, {
            maxAuthReplayPrincipals: 2,
            maxAuthNoncesPerPrincipal: 4
        });
        const second = new MeshClientRedisRegistry<object>(key, {
            maxAuthReplayPrincipals: 2,
            maxAuthNoncesPerPrincipal: 4
        });
        const expiresAt = Date.now() + 60_000;
        assert.equal(await first.consumeAuthNonce?.('principal-a', 'nonce-a', expiresAt), true);
        assert.equal(await second.consumeAuthNonce?.('principal-b', 'nonce-b', expiresAt), true);
        assert.equal(await first.consumeAuthNonce?.('principal-c', 'nonce-c', expiresAt), false);
        assert.equal(await second.consumeAuthNonce?.('principal-a', 'nonce-a-2', expiresAt), true);
    });

    it('does not shorten the global authentication-principal index to a near-expiry nonce', async () => {
        const key = `auth-principal-ttl-${Date.now()}-${process.pid}`;
        const registry = new MeshClientRedisRegistry<object>(key, {
            maxAuthReplayPrincipals: 2,
            maxAuthNoncesPerPrincipal: 4
        });
        const now = Date.now();
        assert.equal(await registry.consumeAuthNonce?.('principal-long', 'nonce-long', now + 2_000), true);
        assert.equal(await registry.consumeAuthNonce?.('principal-short', 'nonce-short', now + 250), true);
        assert.equal(await registry.consumeAuthNonce?.('principal-blocked', 'nonce-blocked', now + 2_000), false);

        const globalIndexKey = (registry as any).authNoncePrincipalsKey() as string;
        const { client } = createRedis('MESH_CLIENT');
        assert.ok((await client.pttl(globalIndexKey)) > 1_000);

        await sleepMs(300);
        // The expired short principal frees one slot; the still-live long
        // principal remains indexed, so admitting one replacement fills the cap.
        assert.equal(await registry.consumeAuthNonce?.('principal-replacement', 'nonce-replacement', Date.now() + 2_000), true);
        assert.equal(await registry.consumeAuthNonce?.('principal-over-cap', 'nonce-over-cap', Date.now() + 2_000), false);
    });

    it('uses Redis server time for claim and orphan delivery leases', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`redis-time-${Date.now()}-${process.pid}`);
        const registry = new MeshClientRegistry(23, backend);
        const originalNow = Date.now;
        Date.now = () => 1;
        try {
            const claim = await registry.claim('clock-skewed-client', { role: 'claimed' }, 'active', true, 'connection-1');
            assert.equal(claim?.status, 'ok');
            assert.equal(claim?.status === 'ok' && (await registry.commitClaim('clock-skewed-client', claim.claimId)), true);
            await backend.enqueueOrphaned?.(23, [
                {
                    clientId: 'clock-skewed-orphan',
                    nodeId: 23,
                    connectionId: 'clock-skewed-connection',
                    connectedAt: 1,
                    metadata: { role: 'orphan' }
                }
            ]);
            const orphan = await backend.claimOrphaned?.('clock-skewed-worker');
            assert.ok(orphan);
            assert.equal(orphan.clients[0].clientId, 'clock-skewed-orphan');
            assert.equal(await backend.ackOrphaned?.(orphan.id, orphan.claimToken), true);
        } finally {
            Date.now = originalNow;
        }
    });

    it('purges pending ownership claims when their node is cleaned up', async () => {
        const backend = new MeshClientRedisRegistry<{ role: string }>(`claims-${Date.now()}-${process.pid}`);
        const first = new MeshClientRegistry(1, backend);
        const claim = await first.claim('pending-claim', { role: 'pending' }, 'pending', true, 'connection-1');
        assert.equal(claim?.status, 'ok');
        await first.cleanupNode();
        const retry = await first.claim('pending-claim', { role: 'retry' }, 'pending', true, 'connection-2');
        assert.equal(retry?.status, 'ok');
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
            assert.equal(await first.registerClient('before-start', { role: 'ignored' }, false, 'before-start-connection'), true);
            await assert.rejects(first.invoke('before-start', 'notify', {}), /Client not found/);

            await first.start();
            await second.start();
            routeMeshCalls(first, second);
            routeMeshCalls(second, first);
            assert.equal(await first.registerClient('client-1', firstMetadata, false, 'connection-1'), true);
            assert.equal(await second.registerClient('client-1', { role: 'conflict' }, false, 'connection-conflict'), false);

            assert.deepStrictEqual(await second.invoke('client-1', 'notify', {}), { deliveredBy: 'first' });
            assert.deepStrictEqual(firstDeliveries, ['client-1:notify']);
            await assert.rejects(second.invoke('client-1', 'disconnect', {}), ClientDisconnectedError);
            await assert.rejects(second.invoke('client-1', 'fail', {}), ClientInvocationError);

            assert.equal(await second.updateClientMetadata('client-1', { role: 'updated' }), true);
            assert.deepStrictEqual(firstMetadata, { role: 'updated' });
            assert.deepStrictEqual((await second.clientRegistry.getClient('client-1'))?.metadata, { role: 'updated' });

            assert.equal(await second.registerClient('client-1', { role: 'second' }, true, 'connection-2'), true);
            await waitFor(() => superseded.includes('client-1'));
            assert.equal((await second.clientRegistry.getClient('client-1'))?.nodeId, second.instanceId);
        } finally {
            await second.stop();
            await first.stop();
        }
    });

    it('serializes a pending activation racing an exact two-node takeover', async () => {
        const key = `pending-takeover-${Date.now()}-${process.pid}`;
        const oldConnection = new PassThrough();
        let oldInvokes = 0;
        let newInvokes = 0;
        let commitAttempts = 0;
        const first = new MeshClientService<{ role: string }>({
            key,
            meshOptions,
            clientInvokeFn: async () => {
                oldInvokes++;
                return 'old';
            }
        });
        const second = new MeshClientService<{ role: string }>({
            key,
            meshOptions,
            clientInvokeFn: async () => {
                newInvokes++;
                return 'new';
            }
        });
        first.onClientSuperseded((_clientId, connectionId) => {
            assert.equal(connectionId, 'connection-old');
            oldConnection.destroy();
            return true;
        });

        try {
            await first.start();
            await second.start();
            routeMeshCalls(first, second);
            routeMeshCalls(second, first);
            assert.equal(await first.reserveClient('pending-client', { role: 'pending-old' }, true, 'connection-old'), true);
            assert.equal((await first.clientRegistry.getClientIncludingPending('pending-client'))?.state, 'pending');

            const secondBackend = (second as any).backend as MeshClientRedisRegistry<{ role: string }>;
            const commitClaim = secondBackend.commitClaim.bind(secondBackend);
            secondBackend.commitClaim = async (...args) => {
                commitAttempts++;
                if (commitAttempts === 1) {
                    assert.equal(oldConnection.destroyed, true);
                    assert.equal(await first.activateClient('pending-client', { role: 'activated-old' }, 'connection-old'), true);
                }
                return commitClaim(...args);
            };

            assert.equal(await second.registerClient('pending-client', { role: 'active-new' }, true, 'connection-new'), true);
            assert.equal(commitAttempts, 2);
            assert.equal(oldConnection.destroyed, true);
            const current = await second.clientRegistry.getClientIncludingPending('pending-client');
            assert.equal(current?.nodeId, second.instanceId);
            assert.equal(current?.connectionId, 'connection-new');
            assert.equal(current?.state, 'active');
            assert.equal(await second.invoke('pending-client', 'notify', {}), 'new');
            assert.equal(await first.invoke('pending-client', 'notify', {}), 'new');
            assert.equal(oldInvokes, 0);
            assert.equal(newInvokes, 2);
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
        const replacement = new SrpcClient<BaseMessage, BaseMessage>(
            createLogger('MeshSrpcReplacementClient'),
            `ws://127.0.0.1:${port}/mesh-srpc`,
            JsonMessage,
            JsonMessage,
            'mesh-client',
            { role: 'replacement' },
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

            const oldConnectionId = stream.id;
            await replacement.connect({ supersede: true });
            await waitFor(() => connected.length === 2);
            await waitFor(async () => {
                const current = await server.clientRegistry.getClient('mesh-client');
                return current?.connectionId !== oldConnectionId && current?.metadata.role === 'replacement';
            });
            assert.equal(disconnected.length, 0);

            replacement.disconnect();
            await waitFor(() => disconnected.length === 1);
            await waitFor(async () => (await server.clientRegistry.getClient('mesh-client')) === undefined);
            assert.deepStrictEqual(connected, [
                { clientId: 'mesh-client', role: 'initial' },
                { clientId: 'mesh-client', role: 'replacement' }
            ]);
            assert.deepStrictEqual(disconnected, [{ clientId: 'mesh-client', role: 'replacement' }]);
        } finally {
            client.disconnect();
            replacement.disconnect();
            await server.meshStop();
            server.close();
            try {
                await nestedApp.stop();
            } finally {
                setCurrentApp(app);
            }
        }
    });

    it('routes transparent unary calls and byte streams over direct mesh links', async () => {
        const key = `mesh-srpc-direct-${Date.now()}-${process.pid}`;
        const firstHttp = createServer();
        const secondHttp = createServer();
        await Promise.all([listen(firstHttp), listen(secondHttp)]);
        const firstPort = (firstHttp.address() as AddressInfo).port;
        const secondPort = (secondHttp.address() as AddressInfo).port;
        const linkSecret = 'mesh-srpc-direct-integration-secret';
        const first = new MeshSrpcServer<SrpcMeta, DirectClientMessage, DirectServerMessage>({
            logger: createLogger('FirstDirectMeshSrpc'),
            clientMessage: DirectClientCodec,
            serverMessage: DirectServerCodec,
            wsPath: '/direct-client',
            httpServer: firstHttp,
            logLevel: false,
            meshKey: key,
            meshOptions,
            meshLink: {
                secret: linkSecret,
                path: '/_tsf/direct-mesh',
                advertiseUrl: `ws://127.0.0.1:${firstPort}/_tsf/direct-mesh`
            }
        });
        const second = new MeshSrpcServer<SrpcMeta, DirectClientMessage, DirectServerMessage>({
            logger: createLogger('SecondDirectMeshSrpc'),
            clientMessage: DirectClientCodec,
            serverMessage: DirectServerCodec,
            wsPath: '/direct-client',
            httpServer: secondHttp,
            logLevel: false,
            meshKey: key,
            meshOptions,
            meshLink: {
                secret: linkSecret,
                path: '/_tsf/direct-mesh',
                advertiseUrl: `ws://127.0.0.1:${secondPort}/_tsf/direct-mesh`
            }
        });
        first.setClientAuthorizer(() => true);
        second.setClientAuthorizer(() => true);
        const client = new SrpcClient<DirectClientMessage, DirectServerMessage>(
            createLogger('DirectMeshSrpcClient'),
            `ws://127.0.0.1:${secondPort}/direct-client`,
            DirectClientCodec,
            DirectServerCodec,
            'direct-client',
            {},
            'unused',
            { enableReconnect: false }
        );
        client.registerMessageHandler('dConsume', data => {
            const receiver = SrpcByteStream.createReceiver(client, data.streamId);
            let bytes = 0;
            receiver.on('data', chunk => {
                bytes += chunk.length;
            });
            return new Promise((resolve, reject) => {
                receiver.once('end', () => resolve({ bytes }));
                receiver.once('error', reject);
            });
        });
        client.registerMessageHandler('dProduce', data => {
            const sender = SrpcByteStream.createSender(client);
            sender.end(Buffer.from(data.content));
            return { streamId: sender.id };
        });
        client.registerMessageHandler('dFail', data => {
            throw new SrpcError(data.message, true);
        });

        try {
            await first.meshStart();
            await second.meshStart();
            await client.connect();
            await waitFor(async () => (await first.clientRegistry.getClient('direct-client')) !== undefined);

            const connection = await first.resolveClient('direct-client');
            assert.ok(connection);
            assert.equal(first.streamsByClientId.has('direct-client'), false);

            const sender = SrpcByteStream.createSender(connection);
            const consumed = first.invoke(connection, 'dConsume', { streamId: sender.id });
            sender.end(Buffer.from('cross-replica upload'));
            await finished(sender, { readable: false });
            assert.deepStrictEqual(await consumed, { bytes: Buffer.byteLength('cross-replica upload') });

            const produced = await first.invoke(connection, 'dProduce', { content: 'cross-replica download' });
            const receiver = SrpcByteStream.createReceiver(connection, produced.streamId);
            const chunks: Buffer[] = [];
            receiver.on('data', chunk => chunks.push(Buffer.from(chunk)));
            await finished(receiver, { writable: false });
            assert.equal(Buffer.concat(chunks).toString(), 'cross-replica download');

            await assert.rejects(
                first.invoke(connection, 'dFail', { message: 'remote user error' }),
                error => error instanceof SrpcError && error.isUserError === true && error.message === 'remote user error'
            );

            // Direct-link message security is configured only once on the
            // underlying MeshService; a normal stop/start must reuse that
            // policy and re-register the route successfully.
            await first.meshStop();
            await first.meshStart();
            const restartedConnection = await first.resolveClient('direct-client');
            assert.ok(restartedConnection);
            await assert.rejects(
                first.invoke(restartedConnection, 'dFail', { message: 'remote user error after restart' }),
                error => error instanceof SrpcError && error.isUserError === true && error.message === 'remote user error after restart'
            );
        } finally {
            client.disconnect();
            await first.meshStop();
            await second.meshStop();
            first.close();
            second.close();
            await Promise.all([closeServer(firstHttp), closeServer(secondHttp)]);
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

/**
 * MeshClientService is transport-agnostic; MeshSrpcServer installs the
 * authenticated direct transport in production. These registry integration
 * tests exercise the same ownership path with an in-process transport pair.
 */
function routeMeshCalls<TMeta>(caller: MeshClientService<TMeta>, target: MeshClientService<TMeta>): void {
    caller.setRemoteTransport({
        invokeClient: async (_nodeId, request) => {
            try {
                return await target.invoke(request.clientId, request.type, request.data, request.timeoutMs, request.connectionId);
            } catch (error) {
                if (error instanceof SrpcError || error instanceof ClientDisconnectedError || error instanceof ClientInvocationError) throw error;
                throw new ClientInvocationError(error instanceof Error ? error.message : String(error));
            }
        },
        fenceClient: async (_nodeId, request) => {
            let fenced = false;
            for (const callback of (target as any).clientSupersededCallbacks as ((
                clientId: string,
                connectionId?: string,
                reason?: string
            ) => boolean | void | Promise<boolean | void>)[]) {
                if ((await callback(request.clientId, request.connectionId, request.reason)) !== false) fenced = true;
            }
            return fenced;
        },
        updateClientMetadata: async (_nodeId, request) => target.updateClientMetadata(request.clientId, request.metadata, request.connectionId)
    });
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function createBinaryJsonCodec<T extends BaseMessage>(): SrpcMessageFns<T> {
    return {
        encode(message) {
            return Buffer.from(
                JSON.stringify(message, (_key, value) => (value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString('base64') } : value))
            );
        },
        decode(input) {
            return JSON.parse(Buffer.from(input).toString('utf8'), (_key, value: unknown) => {
                if (typeof value !== 'object' || value === null) return value;
                const bytes = (value as { $bytes?: unknown }).$bytes;
                return typeof bytes === 'string' ? Buffer.from(bytes, 'base64') : value;
            }) as T;
        }
    };
}
