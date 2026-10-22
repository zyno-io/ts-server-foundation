import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { Worker, type Job, type QueueEvents } from 'bullmq';

import {
    BaseAppConfig,
    BaseDatabase,
    createApp,
    LeaderService,
    renderSql,
    resetLogSink,
    setLogSink,
    WorkerQueueRegistry,
    WorkerRecorderService
} from '../src';
import type { DatabaseDriver } from '../src';

const originalEnv = { ...process.env };

afterEach(async () => {
    process.env = { ...originalEnv };
    resetLogSink();
    await WorkerQueueRegistry.closeQueues();
});

type RecorderDrain = {
    observers: Map<string, QueueEvents>;
    drainTerminalBullMqJobs(queueName: string, registry: WorkerQueueRegistry, observer: QueueEvents): Promise<void>;
};

describe('BullMQ recorder recovery', () => {
    it('drains multiple bounded pages without skipping jobs as removals shrink both terminal sets', async () => {
        setLogSink(() => {});
        const recorder = new WorkerRecorderService();
        const drain = recorder as unknown as RecorderDrain;
        const observer = {} as QueueEvents;
        drain.observers.set('history', observer);
        const completed: Job[] = [];
        const failed: Job[] = [];
        const reads: { status: string; start: number; end: number }[] = [];
        const removed: string[] = [];
        const jobs = new Map<string, Job>();
        for (const [status, target, count] of [
            ['completed', completed, 205],
            ['failed', failed, 103]
        ] as const) {
            for (let index = 0; index < count; index++) {
                const id = `${status}-${index}`;
                const job = {
                    id,
                    name: 'HistoricalJob',
                    queueName: 'history',
                    data: { data: { index }, options: {} },
                    timestamp: Date.now(),
                    delay: 0,
                    attemptsMade: 1,
                    returnvalue: index,
                    failedReason: 'historical failure',
                    stacktrace: ['historical stack'],
                    async remove() {
                        assert.ok(
                            recorder.getRecords().some(record => record.queueId === id),
                            'record must precede removal'
                        );
                        target.splice(target.indexOf(job as unknown as Job), 1);
                        jobs.delete(id);
                        removed.push(id);
                    }
                };
                target.push(job as unknown as Job);
                jobs.set(id, job as unknown as Job);
            }
        }
        const queue = {
            async getCompleted(start: number, end: number) {
                reads.push({ status: 'completed', start, end });
                return completed.slice(start, end + 1);
            },
            async getFailed(start: number, end: number) {
                reads.push({ status: 'failed', start, end });
                return failed.slice(start, end + 1);
            },
            async getJob(id: string) {
                return jobs.get(id);
            }
        };
        const registry = { getBullQueue: () => queue } as unknown as WorkerQueueRegistry;
        await drain.drainTerminalBullMqJobs('history', registry, observer);

        assert.equal(new Set(removed).size, 308);
        assert.equal(completed.length, 0);
        assert.equal(failed.length, 0);
        assert.deepEqual(
            reads.map(read => read.status),
            ['completed', 'completed', 'completed', 'completed', 'failed', 'failed', 'failed']
        );
        assert.ok(reads.every(read => read.start === 0 && read.end === 99));
        assert.deepEqual(recorder.getRecords().at(-1)?.result, { reason: 'historical failure', stack: ['historical stack'] });
    });

    it('stops draining when its observer loses ownership during a page read', async () => {
        const recorder = new WorkerRecorderService();
        const drain = recorder as unknown as RecorderDrain;
        const observer = {} as QueueEvents;
        drain.observers.set('history', observer);
        const registry = {
            getBullQueue: () => ({
                async getCompleted() {
                    drain.observers.delete('history');
                    return [{ id: '1' }];
                },
                getJob: () => assert.fail('leadership was lost'),
                getFailed: () => assert.fail('leadership was lost')
            })
        } as unknown as WorkerQueueRegistry;
        await drain.drainTerminalBullMqJobs('history', registry, observer);
    });

    it('recovers a database deadlock during real QueueEvents startup and resumes removing new completions', async t => {
        const redisHost = process.env.REDIS_HOST;
        if (!redisHost) {
            t.skip('set REDIS_HOST to run BullMQ recorder integration');
            return;
        }
        process.env.APP_ENV = 'development';
        const app = createApp({
            defaultConfig: {
                REDIS_HOST: redisHost,
                REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
                REDIS_PREFIX: `recorder-recovery-${randomUUID()}`
            }
        });
        setLogSink(() => {});
        const registry = new WorkerQueueRegistry(app.config);
        const queueName = 'history';
        const queue = registry.getBullQueue(queueName);
        const worker = new Worker(queueName, async () => 'done', registry.getBullMqOptions());
        const db = new BaseDatabase({ dialect: 'mysql' } as DatabaseDriver);
        const recorder = new WorkerRecorderService(db, new BaseAppConfig());
        recorder.ensureTableExists = async () => {};
        const inserted = new Set<string>();
        let inserts = 0;
        db.rawExecute = async query => {
            if (++inserts === 1) throw Object.assign(new Error('recording deadlock'), { code: 'ER_LOCK_DEADLOCK' });
            inserted.add(String(renderSql(query, 'mysql').bindings[0]));
            return { affectedRows: 1 };
        };
        const leader = new LeaderService(`worker-recorder:${queueName}`, { redisConfigPrefix: 'BULL', retryDelayMs: 20, retryOnCallbackError: true });
        let starts = 0;
        leader.setBecameLeaderCallback(async () => {
            starts++;
            await recorder.start(queueName, registry);
        });
        leader.setLostLeaderCallback(() => recorder.stop(queueName));
        try {
            await queue.add('HistoricalJob', { data: {}, options: {} }, { removeOnComplete: false });
            await waitFor(async () => (await queue.getCompletedCount()) === 1);
            leader.start();
            await waitFor(async () => starts >= 2 && (await queue.getCompletedCount()) === 0);
            assert.equal(leader.isLeader, true);
            assert.equal(inserted.size, 1);

            const live = await queue.add('LiveJob', { data: {}, options: {} }, { removeOnComplete: false });
            await waitFor(async () => inserted.size === 2 && !(await queue.getJob(String(live.id))));
            assert.equal(starts, 2);
        } finally {
            await worker.close();
            await leader.stop();
            await recorder.stop();
            await queue.obliterate({ force: true });
            await app.stop();
        }
    });
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Timed out waiting for recorder recovery');
}
