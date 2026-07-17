import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseJob,
    createApp,
    createModule,
    DatabaseDriver,
    DriverConnection,
    ExecuteResult,
    getContextProp,
    getRegisteredWorkerJobs,
    type LogEntry,
    QueryResult,
    QueuedWorkerJob,
    resetLogSink,
    setLogSink,
    WorkerJob,
    WorkerQueueRegistry,
    WorkerRunnerService,
    WorkerRecorderService,
    WorkerService
} from '../src';
import type { RenderedSql } from '../src';

const originalEnv = { ...process.env };

afterEach(async () => {
    process.env = { ...originalEnv };
    resetLogSink();
    await WorkerQueueRegistry.closeQueues();
});

class FakeConnection implements DriverConnection {
    constructor(private driver: FakeDriver) {}

    async query<T = Record<string, unknown>>(_query: RenderedSql): Promise<QueryResult<T>> {
        return { rows: [] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        this.driver.executes.push(query);
        return { affectedRows: 1, rowCount: 1 };
    }

    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {}
}

class FakeDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    executes: RenderedSql[] = [];

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        return new FakeConnection(this);
    }
}

class WorkerDatabase extends BaseDatabase {
    static driver = new FakeDriver();

    constructor() {
        super(WorkerDatabase.driver);
    }
}

class WorkerDependency {
    suffix = 'done';
}

@WorkerJob({ queueName: 'critical', cronSchedule: '* * * * *' })
class ExampleJob extends BaseJob<{ name: string }, { message: string; contextName: string }> {
    constructor(private readonly dependency: WorkerDependency) {
        super();
    }

    async handle(data: { name: string }): Promise<{ message: string; contextName: string }> {
        const contextJob = getContextProp<{ name: string }>('job');
        return {
            message: `${data.name}:${this.dependency.suffix}`,
            contextName: contextJob?.name ?? ''
        };
    }
}

@WorkerJob()
class DefaultQueueJob extends BaseJob<{ name: string }, string> {
    handle(data: { name: string }): string {
        return data.name;
    }
}

@WorkerJob({ queueName: 'failures' })
class FailingJob extends BaseJob<Record<string, never>, void> {
    handle(_data: Record<string, never>): void {
        throw new Error('worker exploded');
    }
}

@WorkerJob({ queueName: 'daily', cronSchedule: '0 2 * * *' })
class DailyCronJob extends BaseJob<void, string> {
    handle(): string {
        return 'daily';
    }
}

@WorkerJob({ cronSchedule: '0 5 * * *' })
class DefaultLegacyCronJob extends BaseJob<void, string> {
    handle(): string {
        return 'legacy';
    }
}

@WorkerJob({ queueName: 'repeat', cronSchedule: '* * * * *' })
class RepeatCronJob extends BaseJob<void, string> {
    handle(): string {
        return 'repeat';
    }
}

const repeatObjectPayloads: Array<{ locationId?: string }> = [];

@WorkerJob({ queueName: 'repeat-object', cronSchedule: '* * * * *' })
class RepeatObjectCronJob extends BaseJob<{ locationId?: string }, string> {
    handle(data: { locationId?: string }): string {
        repeatObjectPayloads.push(data);
        return data.locationId ?? 'all';
    }
}

const bullMqExecutions: string[] = [];

@WorkerJob({ queueName: 'bullmq-cross-process' })
class BullMqExampleJob extends BaseJob<{ name: string }, string> {
    handle(data: { name: string }): string {
        bullMqExecutions.push(data.name);
        return `${data.name}:done`;
    }
}

describe('worker services', () => {
    it('registers worker job metadata', () => {
        assert.equal(ExampleJob.QUEUE_NAME, 'critical');
        assert.equal(ExampleJob.CRON_SCHEDULE, '* * * * *');
        assert.ok(getRegisteredWorkerJobs().includes(ExampleJob));
    });

    it('does not queue jobs in test env unless explicitly requested', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [WorkerDependency, ExampleJob]
        });

        const result = await app.get(WorkerService).queueJob(ExampleJob, { name: 'Alpha' });

        assert.equal(result, undefined);
        assert.deepEqual(app.get(WorkerQueueRegistry).getQueuedJobs('critical'), []);
    });

    it('logs queueing, registration, execution, and runner lifecycle events', async () => {
        process.env.APP_ENV = 'test';
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            enableWorker: true,
            providers: [DefaultQueueJob],
            defaultConfig: { BULL_QUEUE: 'configured' }
        });

        const queued = (await app.get(WorkerService).queueJob(DefaultQueueJob, { name: 'logged' }, { runInTest: true })) as QueuedWorkerJob;
        await app.start();
        await app.stop();

        assert.deepEqual(
            entries.map(entry => entry.message),
            ['Queued job', 'Registering job', 'Worker started', 'Job activated', 'Job completed', 'Worker stopping', 'Worker stopped']
        );
        assert.deepEqual(
            entries.map(entry => entry.scope),
            [
                'WorkerService',
                'WorkerRunnerService',
                'WorkerRunnerService',
                'WorkerRunnerService',
                'WorkerRunnerService',
                'WorkerRunnerService',
                'WorkerRunnerService'
            ]
        );
        assert.deepEqual(entries[0].data?.job, {
            name: 'DefaultQueueJob',
            id: queued.id,
            queue: 'configured'
        });
        assert.deepEqual(entries[1].data?.job, {
            name: 'DefaultQueueJob',
            queue: 'configured',
            schedule: null
        });
        assert.deepEqual(entries[3].data?.job, {
            queue: 'configured',
            id: queued.id,
            name: 'DefaultQueueJob',
            attempt: 1
        });
        assert.deepEqual(entries[4].data?.job, entries[3].data?.job);
    });

    it('logs job execution failures with job identity', async () => {
        process.env.APP_ENV = 'test';
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            enableWorker: true,
            providers: [FailingJob]
        });

        await assert.rejects(app.get(WorkerService).runJob(FailingJob, {}), /worker exploded/);

        const failure = entries.find(entry => entry.message === 'Job failed: worker exploded');
        assert.ok(failure);
        assert.equal((failure.error as Error).message, 'worker exploded');
        const loggedJob = failure.data?.job as Record<string, unknown>;
        assert.equal(loggedJob.queue, 'failures');
        assert.match(String(loggedJob.id), /^\d+$/);
        assert.equal(loggedJob.name, 'FailingJob');
        assert.equal(loggedJob.attempt, 1);
    });

    it('runs jobs inline through DI and records executions', async () => {
        process.env.APP_ENV = 'test';
        WorkerDatabase.driver.executes = [];
        const app = createApp({
            db: WorkerDatabase,
            enableWorker: true,
            providers: [WorkerDependency, ExampleJob],
            defaultConfig: { BULL_QUEUE: 'critical' }
        });

        const result = await app
            .get(WorkerService)
            .queueJob(ExampleJob, { name: 'Alpha' }, { runInTest: true, runImmediately: true, recordToDatabase: true });
        const execution = result as {
            job: QueuedWorkerJob;
            result: { message: string; contextName: string };
        };

        assert.equal(execution.job.status, 'completed');
        assert.deepEqual(execution.result, { message: 'Alpha:done', contextName: 'ExampleJob' });
        assert.equal(app.get(WorkerRecorderService).getRecords()[0].status, 'completed');
        assert.deepEqual(app.get(WorkerQueueRegistry).getQueuedJobs('critical'), []);
        assert.equal(WorkerDatabase.driver.executes.length, 1);
        assert.equal(WorkerDatabase.driver.executes[0].sql.startsWith('INSERT INTO "_jobs"'), true);
        assert.equal(WorkerDatabase.driver.executes[0].bindings[4], 'ExampleJob');
        assert.equal(WorkerDatabase.driver.executes[0].bindings[5], JSON.stringify({ name: 'Alpha' }));
        assert.equal(WorkerDatabase.driver.executes[0].bindings[8], JSON.stringify({ message: 'Alpha:done', contextName: 'ExampleJob' }));
    });

    it('uses BULL_QUEUE for default jobs and drains queued jobs through the runner', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [DefaultQueueJob],
            defaultConfig: { BULL_QUEUE: 'configured' }
        });

        const queued = (await app.get(WorkerService).queueJob(DefaultQueueJob, { name: 'Beta' }, { runInTest: true })) as QueuedWorkerJob;
        assert.equal(queued.queue, 'configured');
        assert.equal(queued.status, 'queued');

        await app.start();
        await app.get(WorkerRunnerService).drainReadyJobs('configured');

        assert.equal(queued.status, 'completed');
        assert.equal(queued.result, 'Beta');
        assert.deepEqual(app.get(WorkerQueueRegistry).getQueuedJobs('configured'), []);
        await app.stop();
    });

    it('schedules registered cron jobs when the runner starts', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [WorkerDependency, ExampleJob]
        });

        await app.start();
        const jobs = app.get(WorkerQueueRegistry).getQueuedJobs('critical');

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].name, 'ExampleJob');
        assert.equal(jobs[0].options.repeatKey, 'ExampleJob:* * * * *');
        assert.ok(jobs[0].shouldExecuteAt.getTime() > Date.now());

        await app.stop();
    });

    it('honors hour fields when scheduling cron jobs', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [DailyCronJob]
        });

        await app.start();
        const jobs = app.get(WorkerQueueRegistry).getQueuedJobs('daily');

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].shouldExecuteAt.getHours(), 2);
        assert.equal(jobs[0].shouldExecuteAt.getMinutes(), 0);
        assert.equal(jobs[0].shouldExecuteAt.getSeconds(), 0);

        await app.stop();
    });

    it('reschedules overdue repeat jobs drained by the runner', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [RepeatCronJob]
        });

        await app.start();
        const queue = app.get(WorkerQueueRegistry);
        queue.clear('repeat');
        const overdue = queue.add(RepeatCronJob, undefined, {
            delay: -60_000,
            repeatKey: 'RepeatCronJob:* * * * *'
        });

        await app.get(WorkerRunnerService).drainReadyJobs('repeat');
        const jobs = queue.getQueuedJobs('repeat');

        assert.equal(overdue.status, 'completed');
        assert.equal(jobs.length, 1);
        assert.notEqual(jobs[0].id, overdue.id);
        assert.equal(jobs[0].options.repeatKey, 'RepeatCronJob:* * * * *');
        assert.ok(jobs[0].shouldExecuteAt.getTime() > Date.now());

        await app.stop();
    });

    it('does not duplicate repeat jobs when an overdue copy is drained', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [RepeatCronJob]
        });

        await app.start();
        const queue = app.get(WorkerQueueRegistry);
        const existing = queue.getQueuedJobs('repeat')[0];
        const overdue = queue.add(RepeatCronJob, undefined, {
            delay: -60_000,
            repeatKey: 'RepeatCronJob:* * * * *'
        });

        await app.get(WorkerRunnerService).drainReadyJobs('repeat');
        const jobs = queue.getQueuedJobs('repeat');

        assert.equal(overdue.status, 'completed');
        assert.deepEqual(
            jobs.map(job => job.id),
            [existing.id]
        );

        await app.stop();
    });

    it('passes an empty object to cron jobs scheduled without explicit data', async () => {
        process.env.APP_ENV = 'test';
        repeatObjectPayloads.length = 0;
        const app = createApp({
            enableWorker: true,
            providers: [RepeatObjectCronJob]
        });

        await app.start();
        const queue = app.get(WorkerQueueRegistry);
        const scheduled = queue.getQueuedJobs('repeat-object')[0];
        assert.deepEqual(scheduled.data, {});

        queue.clear('repeat-object');
        const overdue = queue.add(RepeatObjectCronJob, undefined as unknown as { locationId?: string }, {
            delay: -60_000,
            repeatKey: 'RepeatObjectCronJob:* * * * *'
        });

        await app.get(WorkerRunnerService).drainReadyJobs('repeat-object');

        assert.deepEqual(repeatObjectPayloads, [{}]);
        assert.equal(overdue.status, 'completed');
        assert.equal(overdue.result, 'all');

        await app.stop();
    });

    it('normalizes missing BullMQ worker payload data to an empty object', () => {
        process.env.APP_ENV = 'development';
        const registry = new WorkerQueueRegistry({ APP_ENV: 'development' } as never);
        const queued = registry.fromBullJob(
            {
                id: 'repeat-id',
                queueName: 'repeat-object',
                name: 'RepeatObjectCronJob',
                timestamp: Date.now(),
                delay: 0,
                opts: {},
                attemptsMade: 0,
                data: {
                    data: undefined,
                    options: { repeatKey: 'RepeatObjectCronJob:* * * * *' }
                }
            } as never,
            RepeatObjectCronJob
        );

        assert.deepEqual(queued.data, {});
        assert.deepEqual(queued.options, { repeatKey: 'RepeatObjectCronJob:* * * * *' });
    });

    it('normalizes old BullMQ repeat payloads with omitted undefined data to an empty object', () => {
        process.env.APP_ENV = 'development';
        const registry = new WorkerQueueRegistry({ APP_ENV: 'development' } as never);
        const queued = registry.fromBullJob(
            {
                id: 'repeat-id',
                queueName: 'repeat-object',
                name: 'RepeatObjectCronJob',
                timestamp: Date.now(),
                delay: 0,
                opts: {},
                attemptsMade: 0,
                data: {
                    options: { repeatKey: 'RepeatObjectCronJob:* * * * *' }
                }
            } as never,
            RepeatObjectCronJob
        );

        assert.deepEqual(queued.data, {});
        assert.deepEqual(queued.options, { repeatKey: 'RepeatObjectCronJob:* * * * *' });
    });

    it('preserves explicit null BullMQ worker payload data', () => {
        process.env.APP_ENV = 'development';
        const registry = new WorkerQueueRegistry({ APP_ENV: 'development' } as never);
        const queued = registry.fromBullJob(
            {
                id: 'null-id',
                queueName: 'repeat-object',
                name: 'RepeatObjectCronJob',
                timestamp: Date.now(),
                delay: 0,
                opts: {},
                attemptsMade: 0,
                data: {
                    data: null,
                    options: {}
                }
            } as never,
            RepeatObjectCronJob
        );

        assert.equal(queued.data, null);
    });

    it('applies Redis prefixes to BullMQ options', () => {
        process.env.APP_ENV = 'development';
        const defaultPrefixApp = createApp({
            enableWorker: true,
            defaultConfig: {
                REDIS_HOST: 'redis-default',
                REDIS_PREFIX: 'default-prefix'
            }
        });

        assert.equal(defaultPrefixApp.get(WorkerQueueRegistry).getBullMqOptions().prefix, 'default-prefix:bmq');

        const bullPrefixApp = createApp({
            enableWorker: true,
            defaultConfig: {
                REDIS_HOST: 'redis-default',
                REDIS_PREFIX: 'default-prefix',
                BULL_REDIS_PREFIX: 'bull-prefix'
            }
        });

        assert.equal(bullPrefixApp.get(WorkerQueueRegistry).getBullMqOptions().prefix, 'bull-prefix:bmq');
    });

    it('disconnects BullMQ clients after gracefully closing registry queues', async () => {
        const calls: string[] = [];
        const queue = {
            client: Promise.resolve({
                disconnect() {
                    calls.push('disconnect');
                }
            }),
            async close() {
                calls.push('close');
            }
        };
        const registry = new WorkerQueueRegistry({ APP_ENV: 'development' } as never);
        const instanceQueues = (registry as unknown as { bullQueues: Map<string, typeof queue> }).bullQueues;
        const globalQueues = (
            WorkerQueueRegistry as unknown as {
                bullQueues: Set<typeof queue>;
            }
        ).bullQueues;
        instanceQueues.set('sentinel', queue);
        globalQueues.add(queue);

        await registry.shutdown();

        assert.deepEqual(calls, ['close', 'disconnect']);
        assert.equal(instanceQueues.size, 0);
        assert.equal(globalQueues.size, 0);
    });

    it('disconnects BullMQ clients when graceful queue cleanup fails', async () => {
        const calls: string[] = [];
        const queue = {
            client: Promise.resolve({
                disconnect() {
                    calls.push('disconnect');
                }
            }),
            async close() {
                calls.push('close');
                throw new Error('close failed');
            }
        };
        const globalQueues = (
            WorkerQueueRegistry as unknown as {
                bullQueues: Set<typeof queue>;
            }
        ).bullQueues;
        globalQueues.add(queue);

        await WorkerQueueRegistry.closeQueues();

        assert.deepEqual(calls, ['close', 'disconnect']);
        assert.equal(globalQueues.size, 0);
    });

    it('removes only stale framework-managed BullMQ job schedulers', async () => {
        process.env.APP_ENV = 'development';
        const registry = new WorkerQueueRegistry({ APP_ENV: 'development', BULL_QUEUE: 'default' } as never);
        const removedByQueue = new Map<string, string[]>();
        const queues = new Map<string, object>([
            [
                'default',
                {
                    client: Promise.resolve({
                        scan: async () => [
                            '0',
                            [
                                'test[prefix]:default:repeat',
                                'test[prefix]:critical:repeat',
                                'test[prefix]:abandoned:repeat',
                                'another-prefix:ignored:repeat'
                            ]
                        ]
                    }),
                    getJobSchedulers: async () => [
                        {
                            key: 'legacy-repeat-key',
                            name: 'DefaultLegacyCronJob',
                            pattern: '0 5 * * *'
                        }
                    ],
                    removeRepeatableByKey: async (key: string) => {
                        removedByQueue.set('default', [key]);
                        return true;
                    }
                }
            ],
            [
                'critical',
                fakeBullQueue(
                    'critical',
                    [
                        fakeTsfScheduler('ExampleJob', '* * * * *'),
                        fakeTsfScheduler('ExampleJob', '*/5 * * * *'),
                        fakeTsfScheduler('DeletedJob', '0 2 * * *'),
                        fakeTsfScheduler('ExampleJob', '* * * * *', 'ExampleJob:wrong-key'),
                        {
                            key: 'ExternalJob:0 3 * * *',
                            name: 'ExternalJob',
                            pattern: '0 3 * * *',
                            template: { data: { source: 'external' } }
                        }
                    ],
                    removedByQueue
                )
            ],
            ['abandoned', fakeBullQueue('abandoned', [fakeTsfScheduler('MovedJob', '0 4 * * *')], removedByQueue)]
        ]);
        let scanPattern = '';
        const defaultQueue = queues.get('default') as {
            client: Promise<{ scan: (...args: unknown[]) => Promise<[string, string[]]> }>;
        };
        const client = await defaultQueue.client;
        const scan = client.scan;
        client.scan = async (...args: unknown[]) => {
            scanPattern = String((args[1] as { MATCH?: string }).MATCH);
            return scan(...args);
        };
        registry.getBullMqOptions = (() => ({ prefix: 'test[prefix]' })) as never;
        registry.getBullQueue = ((queueName: string) => queues.get(queueName)) as never;

        const removed = await registry.removeStaleBullMqJobSchedulers([
            { queue: 'critical', name: 'ExampleJob', pattern: '* * * * *' },
            { queue: 'new-queue', name: 'MovedJob', pattern: '0 4 * * *' }
        ]);

        assert.equal(scanPattern, 'test\\[prefix\\]:*:repeat');
        assert.deepEqual(
            removedByQueue,
            new Map([
                ['abandoned', ['MovedJob:0 4 * * *']],
                ['critical', ['ExampleJob:*/5 * * * *', 'DeletedJob:0 2 * * *', 'ExampleJob:wrong-key']],
                ['default', ['legacy-repeat-key']]
            ])
        );
        assert.deepEqual(
            removed.map(scheduler => ({ queue: scheduler.queue, key: scheduler.key })),
            [
                { queue: 'abandoned', key: 'MovedJob:0 4 * * *' },
                { queue: 'critical', key: 'ExampleJob:*/5 * * * *' },
                { queue: 'critical', key: 'DeletedJob:0 2 * * *' },
                { queue: 'critical', key: 'ExampleJob:wrong-key' },
                { queue: 'default', key: 'legacy-repeat-key' }
            ]
        );
    });

    it('reconciles BullMQ schedules only for cron jobs registered in the app', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            enableWorker: true,
            providers: [WorkerDependency, ExampleJob, DefaultQueueJob]
        });
        const registry = app.get(WorkerQueueRegistry);
        let desiredSchedules: unknown;
        registry.removeStaleBullMqJobSchedulers = (async (schedules: Parameters<WorkerQueueRegistry['removeStaleBullMqJobSchedulers']>[0]) => {
            desiredSchedules = schedules;
            return [];
        }) as never;

        await app.get(WorkerRunnerService).removeStaleBullMqCronJobs();

        assert.deepEqual(desiredSchedules, [{ queue: 'critical', name: 'ExampleJob', pattern: '* * * * *' }]);
    });

    it('reconciles real BullMQ job schedulers across queues', async t => {
        const redisHost = process.env.REDIS_HOST;
        if (!redisHost) {
            t.skip('set REDIS_HOST to run BullMQ scheduler integration');
            return;
        }

        process.env.APP_ENV = 'development';
        const app = createApp({
            enableWorker: true,
            providers: [WorkerDependency, ExampleJob, DefaultLegacyCronJob],
            defaultConfig: {
                ENABLE_JOB_RUNNER: false,
                REDIS_HOST: redisHost,
                REDIS_PORT: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
                REDIS_PREFIX: `tsf-scheduler-reconcile-${Date.now()}`
            }
        });
        const registry = app.get(WorkerQueueRegistry);
        const criticalQueue = registry.getBullQueue('critical');
        const abandonedQueue = registry.getBullQueue('abandoned');
        const defaultQueue = registry.getBullQueue('default');
        const upsertTsfScheduler = async (queue: typeof criticalQueue, name: string, pattern: string) => {
            const key = `${name}:${pattern}`;
            await queue.upsertJobScheduler(
                key,
                { pattern },
                {
                    name,
                    data: { data: {}, options: { repeatKey: key } }
                }
            );
        };

        try {
            await upsertTsfScheduler(criticalQueue, 'ExampleJob', '* * * * *');
            await upsertTsfScheduler(criticalQueue, 'ExampleJob', '*/5 * * * *');
            await upsertTsfScheduler(criticalQueue, 'DeletedJob', '0 2 * * *');
            await upsertTsfScheduler(abandonedQueue, 'MovedJob', '0 4 * * *');
            await defaultQueue.add('DefaultLegacyCronJob', {} as never, { repeat: { pattern: '0 5 * * *' } });
            await criticalQueue.upsertJobScheduler(
                'ExternalJob:0 3 * * *',
                { pattern: '0 3 * * *' },
                { name: 'ExternalJob', data: { source: 'external' } as never }
            );

            await app.get(WorkerRunnerService).removeStaleBullMqCronJobs();

            assert.deepEqual(
                (await criticalQueue.getJobSchedulers()).map(scheduler => scheduler.key).sort(),
                ['ExampleJob:* * * * *', 'ExternalJob:0 3 * * *'].sort()
            );
            assert.deepEqual(await abandonedQueue.getJobSchedulers(), []);
            assert.deepEqual(await defaultQueue.getRepeatableJobs(), []);
        } finally {
            await Promise.all(registry.getBullQueues().map(({ queue }) => queue.obliterate({ force: true }).catch(() => {})));
            await registry.shutdown();
        }
    });

    it('does not start the job runner in production unless ENABLE_JOB_RUNNER is enabled', async () => {
        process.env.APP_ENV = 'production';
        const app = createApp({
            enableWorker: true,
            providers: [DefaultQueueJob]
        });

        await app.start();

        await app.stop();
    });

    it('requires Redis/BullMQ config when the production job runner is enabled', async () => {
        process.env.APP_ENV = 'production';
        delete process.env.REDIS_HOST;
        delete process.env.REDIS_PORT;
        delete process.env.REDIS_SENTINEL_HOST;
        delete process.env.REDIS_SENTINEL_PORT;
        delete process.env.REDIS_SENTINEL_NAME;
        const app = createApp({
            enableWorker: true,
            providers: [DefaultQueueJob],
            defaultConfig: { ENABLE_JOB_RUNNER: true }
        });

        await assert.rejects(app.start(), /BullMQ workers require REDIS_HOST or REDIS_SENTINEL_HOST/);
    });

    it('queues BullMQ jobs that are drained by a separate app instance', async t => {
        const redisHost = process.env.REDIS_HOST;
        if (!redisHost) {
            t.skip('set REDIS_HOST to run BullMQ worker integration');
            return;
        }

        const redisPort = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379;
        const redisPrefix = `tsf-worker-${Date.now()}`;
        bullMqExecutions.length = 0;

        process.env.APP_ENV = 'development';
        const producer = createApp({
            enableWorker: true,
            providers: [BullMqExampleJob],
            defaultConfig: {
                ENABLE_JOB_RUNNER: false,
                REDIS_HOST: redisHost,
                REDIS_PORT: redisPort,
                REDIS_PREFIX: redisPrefix
            }
        });

        process.env.APP_ENV = 'development';
        const worker = createApp({
            enableWorker: true,
            providers: [BullMqExampleJob],
            defaultConfig: {
                ENABLE_JOB_RUNNER: true,
                REDIS_HOST: redisHost,
                REDIS_PORT: redisPort,
                REDIS_PREFIX: redisPrefix
            }
        });

        try {
            await worker.start();
            const queued = (await producer.get(WorkerService).queueJob(BullMqExampleJob, { name: 'Delta' })) as QueuedWorkerJob<{ name: string }>;
            assert.equal(queued?.queue, 'bullmq-cross-process');
            assert.equal(queued?.name, 'BullMqExampleJob');

            await waitFor(() => bullMqExecutions.includes('Delta'));
        } finally {
            await producer.stop();
            await worker.stop();
        }
    });

    it('executes imported module job handlers through the owning app container', async () => {
        process.env.APP_ENV = 'test';

        class ModuleDependency {
            suffix = 'module';
        }

        @WorkerJob()
        class ModuleJob extends BaseJob<{ name: string }, string> {
            constructor(private readonly dependency: ModuleDependency) {
                super();
            }

            handle(data: { name: string }): string {
                return `${data.name}:${this.dependency.suffix}`;
            }
        }

        const feature = createModule({
            providers: [ModuleDependency, ModuleJob]
        });
        const firstApp = createApp({
            enableWorker: true,
            imports: [feature]
        });
        createApp({
            enableWorker: true,
            providers: [DefaultQueueJob]
        });

        const result = await firstApp.get(WorkerService).runJob(ModuleJob, { name: 'Gamma' }, { runInTest: true });

        assert.equal(result.result, 'Gamma:module');
    });
});

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (fn()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Timed out waiting for condition');
}

function fakeTsfScheduler(name: string, pattern: string, key = `${name}:${pattern}`): object {
    return {
        key,
        name,
        pattern,
        template: {
            data: {
                data: {},
                options: { repeatKey: key }
            }
        }
    };
}

function fakeBullQueue(queueName: string, schedulers: object[], removedByQueue: Map<string, string[]>): object {
    return {
        getJobSchedulers: async () => schedulers,
        removeJobScheduler: async (key: string) => {
            const removed = removedByQueue.get(queueName) ?? [];
            removed.push(key);
            removedByQueue.set(queueName, removed);
            return true;
        }
    };
}
