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
        const reads: { status: string; start: number; end: number; asc: boolean }[] = [];
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
            async getJobs([status]: ['completed' | 'failed'], start: number, end: number, asc: boolean) {
                reads.push({ status, start, end, asc });
                return (status === 'completed' ? completed : failed).slice(start, end + 1);
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
        assert.ok(
            removed.indexOf('failed-0') < removed.indexOf('completed-100'),
            'failed jobs must progress before the completed backlog is exhausted'
        );
        assert.ok(reads.every(read => read.start === 0 && read.end === 99 && read.asc));
        assert.deepEqual(recorder.getRecords().find(record => record.queueId === 'failed-102')?.result, {
            reason: 'historical failure',
            stack: ['historical stack']
        });
    });

    it('stops draining when its observer loses ownership during a page read', async () => {
        const recorder = new WorkerRecorderService();
        const drain = recorder as unknown as RecorderDrain;
        const observer = {} as QueueEvents;
        drain.observers.set('history', observer);
        const registry = {
            getBullQueue: () => ({
                async getJobs() {
                    drain.observers.delete('history');
                    return [{ id: '1' }];
                },
                getJob: () => assert.fail('leadership was lost')
            })
        } as unknown as WorkerQueueRegistry;
        await drain.drainTerminalBullMqJobs('history', registry, observer);
    });

    it('does not reopen a queue when ownership was lost before draining began', async () => {
        const recorder = new WorkerRecorderService();
        const registry = {
            getBullQueue: () => assert.fail('cancelled startup must not reopen a Redis queue')
        } as unknown as WorkerQueueRegistry;
        await (recorder as unknown as RecorderDrain).drainTerminalBullMqJobs('history', registry, {} as QueueEvents);
    });

    it('coalesces concurrent starts and cancels schema initialization before opening an observer', async () => {
        for (const queueName of [undefined, 'history']) {
            const recorder = new WorkerRecorderService();
            let ready!: () => void;
            const schema = new Promise<void>(resolve => (ready = resolve));
            let schemaChecks = 0;
            recorder.ensureTableExists = async () => {
                schemaChecks++;
                await schema;
            };
            const registry = {
                getBullMqOptions: () => assert.fail('cancelled startup must not create a Redis observer')
            } as unknown as WorkerQueueRegistry;
            const first = recorder.start('history', registry);
            const second = recorder.start('history', registry);
            await recorder.stop(queueName);
            ready();
            await Promise.all([first, second]);
            assert.equal(schemaChecks, 1);
        }
    });

    it('does not let cancelled schema initialization cancel its replacement startup', async () => {
        const recorder = new WorkerRecorderService();
        let ready!: () => void;
        const schema = new Promise<void>(resolve => (ready = resolve));
        recorder.ensureTableExists = () => schema;
        let optionReads = 0;
        const registry = {
            getBullMqOptions: () => {
                optionReads++;
                throw new Error('replacement reached observer creation');
            }
        } as unknown as WorkerQueueRegistry;
        const first = recorder.start('history', registry);
        await recorder.stop('history');
        const replacement = assert.rejects(recorder.start('history', registry), /replacement reached observer creation/);
        ready();
        await Promise.all([first, replacement]);
        assert.equal(optionReads, 1);
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
