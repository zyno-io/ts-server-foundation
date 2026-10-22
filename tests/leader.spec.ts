import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';

import { createApp, LeaderService, resetLogSink, setLogSink } from '../src';

const originalEnv = { ...process.env };

afterEach(() => {
    process.env = { ...originalEnv };
    resetLogSink();
});

function leaderFixture(t: TestContext, retryOnCallbackError = true) {
    process.env.APP_ENV = 'test';
    createApp({});
    setLogSink(() => {});
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const leader = new LeaderService('worker-recorder:recovery', { renewalIntervalMs: 100, retryDelayMs: 10, retryOnCallbackError });
    let owner: string | undefined;
    const client = {
        ACQUIRE: t.mock.fn(async (_key: string, id: string) => {
            if (owner) return 0;
            owner = id;
            return 1;
        }),
        RENEW: t.mock.fn(async (_key: string, id: string) => Number(owner === id)),
        RELEASE: t.mock.fn(async (_key: string, id: string) => {
            if (owner !== id) return 0;
            owner = undefined;
            return 1;
        })
    };
    t.mock.method(leader as unknown as { getRedisClient(): typeof client }, 'getRedisClient', () => client);
    return { leader, client, expireLease: () => (owner = undefined) };
}

async function flushTasks(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

describe('leader startup recovery', () => {
    it('preserves the default callback error behavior for other leader consumers', async t => {
        const { leader, client } = leaderFixture(t, false);
        leader.setBecameLeaderCallback(() => {
            throw new Error('notification failed');
        });
        try {
            leader.start();
            await flushTasks();
            t.mock.timers.tick(100);
            await flushTasks();
            assert.equal(leader.isLeader, true);
            assert.equal(client.RENEW.mock.callCount(), 1);
            assert.equal(client.RELEASE.mock.callCount(), 0);
        } finally {
            await leader.stop();
        }
    });

    it('releases a failed startup lease, cleans up, and retries instead of renewing an inert leader', async t => {
        const { leader, client } = leaderFixture(t);
        const cleanup = t.mock.fn();
        let attempts = 0;
        const start = t.mock.fn(async () => {
            if (++attempts === 1) throw Object.assign(new Error('recording deadlock'), { code: 'ER_LOCK_DEADLOCK' });
        });
        leader.setBecameLeaderCallback(start);
        leader.setLostLeaderCallback(cleanup);

        try {
            leader.start();
            await flushTasks();
            assert.equal(leader.isLeader, false);
            assert.equal(client.RELEASE.mock.callCount(), 1);
            assert.equal(cleanup.mock.callCount(), 1);

            t.mock.timers.tick(10);
            await flushTasks();
            assert.equal(leader.isLeader, true);
            assert.equal(start.mock.callCount(), 2);
            assert.notEqual(client.ACQUIRE.mock.calls[0].arguments[1], client.ACQUIRE.mock.calls[1].arguments[1]);

            t.mock.timers.tick(100);
            await flushTasks();
            assert.equal(leader.isLeader, true);
            assert.equal(client.RENEW.mock.callCount(), 1);
        } finally {
            await leader.stop();
        }
    });

    it('does not restart election when an in-flight startup fails after shutdown', async t => {
        const { leader, client } = leaderFixture(t);
        let failStartup!: (error: Error) => void;
        const startup = new Promise<void>((_resolve, reject) => (failStartup = reject));
        leader.setBecameLeaderCallback(() => startup);
        try {
            leader.start();
            await flushTasks();
            await leader.stop();
            failStartup(new Error('late startup failure'));
            await flushTasks();
            t.mock.timers.tick(1_000);
            await flushTasks();
            assert.equal(leader.isLeader, false);
            assert.equal(client.ACQUIRE.mock.callCount(), 1);
            assert.equal(client.RELEASE.mock.callCount(), 1);
        } finally {
            await leader.stop();
        }
    });

    it('does not relinquish a replacement lease when an older startup fails late', async t => {
        const { leader, client, expireLease } = leaderFixture(t);
        let failStartup!: (error: Error) => void;
        const startup = new Promise<void>((_resolve, reject) => (failStartup = reject));
        let attempts = 0;
        const start = t.mock.fn(() => (++attempts === 1 ? startup : undefined));
        const cleanup = t.mock.fn();
        leader.setBecameLeaderCallback(start);
        leader.setLostLeaderCallback(cleanup);
        try {
            leader.start();
            await flushTasks();
            expireLease();
            t.mock.timers.tick(100);
            await flushTasks();
            assert.equal(leader.isLeader, false);
            t.mock.timers.tick(10);
            await flushTasks();
            assert.equal(leader.isLeader, true);

            failStartup(new Error('failure from previous lease'));
            await flushTasks();
            assert.equal(leader.isLeader, true);
            assert.equal(client.RELEASE.mock.callCount(), 0);
            assert.equal(cleanup.mock.callCount(), 1);
        } finally {
            await leader.stop();
        }
    });
});
