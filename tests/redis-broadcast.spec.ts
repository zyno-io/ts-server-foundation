import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it, mock } from 'node:test';

import { createApp } from '../src';
import { createBroadcastChannel, createDistributedMethod } from '../src/helpers/redis/broadcast';
import * as redis from '../src/helpers/redis/redis';

class FakeRedis extends EventEmitter {
    status = 'ready';
    readonly publishes: Array<{ channel: string; message: string }> = [];
    readonly subscriptions: string[] = [];

    async subscribe(channel: string): Promise<number> {
        this.subscriptions.push(channel);
        return 1;
    }

    async publish(channel: string, message: string): Promise<number> {
        this.publishes.push({ channel, message });
        return 1;
    }

    disconnect(): void {
        if (this.status === 'end') return;
        this.status = 'end';
        this.emit('end');
    }
}

it('restores existing broadcast channels and distributed methods after Redis clients end', async () => {
    const app = createApp({ enableHealthcheck: false });
    const clients: FakeRedis[] = [];
    const createRedisMock = mock.method(redis, 'createRedis', () => {
        const client = new FakeRedis();
        clients.push(client);
        return { client: client as unknown as ReturnType<typeof redis.createRedis>['client'], prefix: 'test' };
    });

    try {
        const received: string[] = [];
        const channel = createBroadcastChannel<{ value: string }>('channel');
        channel.subscribe(data => received.push(data.value));
        const handled: string[] = [];
        const distributed = createDistributedMethod<{ value: string }>({ name: 'method' }, async data => {
            handled.push(data.value);
        });

        assert.equal(clients.length, 2);
        assert.deepStrictEqual(clients[1].subscriptions, ['test:broadcast']);

        clients[0].disconnect();
        assert.equal(clients[1].status, 'end');

        await distributed({ value: 'local' });
        assert.equal(clients.length, 4);
        assert.equal(clients[2].publishes.length, 1);
        assert.deepStrictEqual(handled, ['local']);

        clients[3].emit('message', 'test:broadcast', JSON.stringify({ instanceKey: 'remote', eventName: 'method', data: { value: 'remote' } }));
        clients[3].emit('message', 'test:broadcast', JSON.stringify({ instanceKey: 'remote', eventName: 'channel', data: { value: 'received' } }));
        assert.deepStrictEqual(handled, ['local', 'remote']);
        assert.deepStrictEqual(received, ['received']);

        clients[3].disconnect();
        assert.equal(clients[2].status, 'end');
        await waitFor(() => clients.length === 6);
        assert.deepStrictEqual(clients[5].subscriptions, ['test:broadcast']);

        clients[5].emit('message', 'test:broadcast', JSON.stringify({ instanceKey: 'remote', eventName: 'channel', data: { value: 'restored' } }));
        clients[3].emit('message', 'test:broadcast', JSON.stringify({ instanceKey: 'remote', eventName: 'channel', data: { value: 'stale' } }));
        assert.deepStrictEqual(received, ['received', 'restored']);
        await channel.publish({ value: 'outbound' });
        assert.equal(clients[4].publishes.length, 1);
    } finally {
        await app.stop();
        createRedisMock.mock.restore();
    }
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for broadcast reconnection');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
