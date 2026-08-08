import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { type App, createApp, createRedis, MeshService, sleepMs } from '../src';

const redisSkip = process.env.REDIS_HOST ? false : 'set REDIS_HOST to run Redis-backed mesh service integration tests';

describe('Redis MeshService integration', { skip: redisSkip }, () => {
    let app: App;

    before(() => {
        process.env.APP_ENV = 'test';
        app = createApp({ enableHealthcheck: false });
    });

    after(async () => {
        await app.stop();
    });

    it('fans out through Redis, rejects stale senders, and safely restarts membership subscribers', async () => {
        type Broadcast = { changed: { key: string; when?: Date; value?: number } };
        const key = `mesh-pubsub-${randomUUID()}`;
        const options = { heartbeatIntervalMs: 100, nodeTtlMs: 1_000 };
        const first = new MeshService<Broadcast>(key, options);
        const second = new MeshService<Broadcast>(key, options);
        const third = new MeshService<Broadcast>(key, options);
        const firstDeliveries: Array<{ data: { key: string; when?: string; value?: number }; sender: number }> = [];
        const secondDeliveries: Array<{ data: { key: string; when?: string; value?: number }; sender: number; signal: AbortSignal }> = [];

        first.registerBroadcastHandler('changed', (data, sender) => {
            firstDeliveries.push({ data: data as { key: string; when?: string; value?: number }, sender });
        });
        second.registerBroadcastHandler('changed', (data, sender, context) => {
            secondDeliveries.push({ data: data as { key: string; when?: string; value?: number }, sender, signal: context.signal });
        });

        try {
            await first.start();
            await second.start();
            const firstId = first.instanceId;
            const firstSecondId = second.instanceId;
            await waitFor(async () => (await first.getNodes()).some(node => node.instanceId === firstSecondId));

            const when = new Date('2026-08-08T12:00:00.000Z');
            await first.broadcast('changed', { key: 'normalized', when, value: Number.NaN });
            await waitFor(() => firstDeliveries.length === 1 && secondDeliveries.length === 1);
            assert.deepEqual(firstDeliveries[0], {
                data: { key: 'normalized', when: when.toJSON(), value: null },
                sender: firstId
            });
            assert.deepEqual(secondDeliveries[0].data, { key: 'normalized', when: when.toJSON(), value: null });
            assert.equal(secondDeliveries[0].sender, firstId);

            await first.broadcast('changed', { key: 'other-nodes-only' }, { skipSelf: true });
            await waitFor(() => secondDeliveries.some(delivery => delivery.data.key === 'other-nodes-only'));
            assert.equal(
                firstDeliveries.some(delivery => delivery.data.key === 'other-nodes-only'),
                false
            );

            await third.start();
            const staleId = third.instanceId;
            await third.stop();
            const { client, prefix } = createRedis('MESH');
            await client.publish(
                `${prefix}:mesh:${key}:broadcast`,
                JSON.stringify({ protocolVersion: 2, broadcast: true, senderInstanceId: staleId, type: 'changed', data: { key: 'stale' } })
            );
            await first.broadcast('changed', { key: 'live-marker' }, { skipSelf: true });
            await waitFor(() => secondDeliveries.some(delivery => delivery.data.key === 'live-marker'));
            assert.equal(
                firstDeliveries.some(delivery => delivery.data.key === 'stale'),
                false
            );
            assert.equal(
                secondDeliveries.some(delivery => delivery.data.key === 'stale'),
                false
            );

            const firstSignal = secondDeliveries[0].signal;
            await second.stop();
            assert.equal(firstSignal.aborted, true);
            await waitFor(async () => !(await first.getNodes()).some(node => node.instanceId === firstSecondId));
            await first.broadcast('changed', { key: 'while-stopped' }, { skipSelf: true });
            await sleepMs(50);
            assert.equal(
                secondDeliveries.some(delivery => delivery.data.key === 'while-stopped'),
                false
            );

            await second.start();
            const restartedSecondId = second.instanceId;
            assert.notEqual(restartedSecondId, firstSecondId);
            await waitFor(async () => (await first.getNodes()).some(node => node.instanceId === restartedSecondId));
            await first.broadcast('changed', { key: 'after-restart' }, { skipSelf: true });
            await waitFor(() => secondDeliveries.some(delivery => delivery.data.key === 'after-restart'));
            assert.equal(
                (await first.getNodes()).some(node => node.instanceId === firstSecondId),
                false
            );
        } finally {
            await third.stop();
            await second.stop();
            await first.stop();
        }
    });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await sleepMs(10);
    }
}
