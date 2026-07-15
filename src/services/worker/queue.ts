import { BaseAppConfig } from '../../app';
import { createRedisOptions } from '../../helpers/redis/redis';
import type { JobClass, QueuedWorkerJob, IJobOptions } from './types';
import { notifyWorkerObservers } from './observer';
import { Queue, type Job as BullJob, type QueueOptions, type WorkerOptions } from 'bullmq';

export interface BullMqWorkerJobData<I = unknown> {
    data: I;
    options: IJobOptions;
}

export interface BullMqCronJobSchedule {
    queue: string;
    name: string;
    pattern: string;
}

export interface RemovedBullMqJobScheduler {
    queue: string;
    name: string;
    pattern?: string;
    key: string;
}

export class WorkerQueueRegistry {
    private static readonly queues = new Map<string, QueuedWorkerJob[]>();
    private static readonly bullQueues = new Set<Queue<BullMqWorkerJobData>>();
    private static nextId = 1;
    private readonly bullQueues = new Map<string, Queue<BullMqWorkerJobData>>();

    constructor(private readonly config?: BaseAppConfig) {}

    usesBullMq(): boolean {
        if (this.config?.APP_ENV === 'test') return false;
        return true;
    }

    getDefaultQueueName(): string {
        return this.config?.BULL_QUEUE ?? 'default';
    }

    getQueueName(jobClass: JobClass, options: IJobOptions = {}): string {
        return options.queueName ?? getOwnQueueName(jobClass) ?? this.getDefaultQueueName();
    }

    async enqueue<I>(jobClass: JobClass<I>, data: I, options: IJobOptions = {}): Promise<QueuedWorkerJob<I>> {
        if (!this.usesBullMq()) return this.add(jobClass, data, options);

        const queueName = this.getQueueName(jobClass, options);
        const bullJob = await this.getBullQueue(queueName).add(
            jobClass.name,
            {
                data,
                options: { ...options }
            },
            {
                delay: options.delay,
                removeOnComplete: 1000,
                removeOnFail: 1000
            }
        );

        const job = this.fromBullJob(bullJob as BullJob<BullMqWorkerJobData<I>>, jobClass);
        notifyWorkerObservers({
            type: job.shouldExecuteAt.getTime() > Date.now() ? 'delayed' : 'added',
            job
        });
        return job;
    }

    add<I>(jobClass: JobClass<I>, data: I, options: IJobOptions = {}): QueuedWorkerJob<I> {
        const queue = this.getQueueName(jobClass, options);
        const createdAt = new Date();
        const job: QueuedWorkerJob<I> = {
            id: String(WorkerQueueRegistry.nextId++),
            queue,
            name: jobClass.name,
            data,
            jobClass,
            options: { ...options },
            createdAt,
            shouldExecuteAt: new Date(createdAt.getTime() + (options.delay ?? 0)),
            attemptsMade: 0,
            status: 'queued'
        };

        const jobs = WorkerQueueRegistry.queues.get(queue) ?? [];
        jobs.push(job as QueuedWorkerJob);
        WorkerQueueRegistry.queues.set(queue, jobs);
        notifyWorkerObservers({
            type: job.shouldExecuteAt.getTime() > Date.now() ? 'delayed' : 'added',
            job
        });
        return job;
    }

    getQueuedJobs(queue = this.getDefaultQueueName()): QueuedWorkerJob[] {
        return [...(WorkerQueueRegistry.queues.get(queue) ?? [])];
    }

    getAllQueuedJobs(): QueuedWorkerJob[] {
        return [...WorkerQueueRegistry.queues.values()].flat();
    }

    markCompleted(job: QueuedWorkerJob, result: unknown): void {
        job.status = 'completed';
        job.result = result;
    }

    markFailed(job: QueuedWorkerJob, result: unknown): void {
        job.status = 'failed';
        job.result = result;
    }

    remove(job: QueuedWorkerJob): void {
        const jobs = WorkerQueueRegistry.queues.get(job.queue);
        if (!jobs) return;
        const remaining = jobs.filter(item => item !== job);
        if (remaining.length) WorkerQueueRegistry.queues.set(job.queue, remaining);
        else WorkerQueueRegistry.queues.delete(job.queue);
    }

    clear(queue?: string): void {
        if (queue) WorkerQueueRegistry.queues.delete(queue);
        else WorkerQueueRegistry.queues.clear();
    }

    getBullQueue(queueName: string): Queue<BullMqWorkerJobData> {
        const existing = this.bullQueues.get(queueName);
        if (existing) return existing;

        const queue = new Queue<BullMqWorkerJobData>(queueName, this.getBullMqOptions());
        this.bullQueues.set(queueName, queue);
        WorkerQueueRegistry.bullQueues.add(queue);
        return queue;
    }

    getBullQueues(): Array<{ name: string; queue: Queue<BullMqWorkerJobData> }> {
        return [...this.bullQueues.entries()].map(([name, queue]) => ({ name, queue }));
    }

    async removeStaleBullMqJobSchedulers(desiredSchedules: readonly BullMqCronJobSchedule[]): Promise<RemovedBullMqJobScheduler[]> {
        if (!this.usesBullMq()) return [];

        const desiredByQueue = new Map<string, Map<string, BullMqCronJobSchedule>>();
        for (const schedule of desiredSchedules) {
            const queueSchedules = desiredByQueue.get(schedule.queue) ?? new Map<string, BullMqCronJobSchedule>();
            queueSchedules.set(schedule.name, schedule);
            desiredByQueue.set(schedule.queue, queueSchedules);
        }

        const removed: RemovedBullMqJobScheduler[] = [];
        const defaultQueueName = this.getDefaultQueueName();
        for (const queueName of await this.discoverBullMqJobSchedulerQueueNames()) {
            const queue = this.getBullQueue(queueName);
            const desiredQueueSchedules = desiredByQueue.get(queueName);
            for (const scheduler of await queue.getJobSchedulers()) {
                const isTsfScheduler = isTsfBullMqJobScheduler(scheduler);
                const isLegacyRepeatable = queueName === defaultQueueName && isLegacyBullMqCronRepeatable(scheduler);
                if (!isTsfScheduler && !isLegacyRepeatable) continue;
                const desired = desiredQueueSchedules?.get(scheduler.name);
                const matchesDesiredSchedule =
                    desired !== undefined && desired.pattern === scheduler.pattern && scheduler.key === `${desired.name}:${desired.pattern}`;
                // Legacy repeatables use a different key and rescheduling mechanism. Remove even
                // matching definitions so the runner can replace them with one Job Scheduler.
                if (isTsfScheduler && matchesDesiredSchedule) continue;

                const wasRemoved = isLegacyRepeatable
                    ? await queue.removeRepeatableByKey(scheduler.key)
                    : await queue.removeJobScheduler(scheduler.key);
                if (wasRemoved) {
                    removed.push({
                        queue: queueName,
                        name: scheduler.name,
                        pattern: scheduler.pattern,
                        key: scheduler.key
                    });
                }
            }
        }
        return removed;
    }

    normalizeJobData<I>(data: I | null | undefined): I {
        return (data === undefined ? {} : data) as I;
    }

    fromBullJob<I>(job: BullJob<BullMqWorkerJobData<I>>, jobClass: JobClass<I>): QueuedWorkerJob<I> {
        const createdAt = new Date(job.timestamp);
        const delay = typeof job.delay === 'number' ? job.delay : Number(job.opts.delay ?? 0);
        const payload = this.unwrapBullMqJobData(job.data);
        return {
            id: String(job.id ?? ''),
            queue: job.queueName,
            name: job.name,
            data: this.normalizeJobData(payload.data),
            jobClass,
            options: { ...payload.options },
            createdAt,
            shouldExecuteAt: new Date(createdAt.getTime() + delay),
            attemptsMade: job.attemptsMade,
            status: 'queued'
        };
    }

    async shutdown(): Promise<void> {
        await Promise.all([...this.bullQueues.values()].map(closeBullQueue));
        for (const queue of this.bullQueues.values()) WorkerQueueRegistry.bullQueues.delete(queue);
        this.bullQueues.clear();
    }

    static async closeQueues(): Promise<void> {
        WorkerQueueRegistry.queues.clear();
        const queues = [...WorkerQueueRegistry.bullQueues];
        WorkerQueueRegistry.bullQueues.clear();
        await Promise.all(queues.map(closeBullQueue));
    }

    getBullMqOptions(): QueueOptions & Pick<WorkerOptions, 'connection' | 'prefix'> {
        const config = this.config;
        if (!config) {
            throw new Error('BullMQ workers require app config');
        }
        let options: ReturnType<typeof createRedisOptions>['options'];
        let prefix: string;
        try {
            ({ options, prefix } = createRedisOptions('BULL'));
        } catch (error) {
            throw new Error(
                'BullMQ workers require REDIS_HOST or REDIS_SENTINEL_HOST (or BULL_REDIS_HOST/BULL_REDIS_SENTINEL_HOST) to be configured',
                { cause: error }
            );
        }

        return {
            connection: { ...options, maxRetriesPerRequest: null },
            prefix: `${prefix}:bmq`
        };
    }

    private unwrapBullMqJobData<I>(raw: BullMqWorkerJobData<I> | I): {
        data: I | null | undefined;
        options: IJobOptions;
    } {
        if (isRecord(raw) && isWorkerPayloadWrapper(raw)) {
            const wrapped = raw as Partial<BullMqWorkerJobData<I>>;
            return {
                data: wrapped.data,
                options: isRecord(wrapped.options) ? { ...wrapped.options } : {}
            };
        }

        return { data: raw as I, options: {} };
    }

    private async discoverBullMqJobSchedulerQueueNames(): Promise<string[]> {
        const prefix = this.getBullMqOptions().prefix ?? 'bull';
        const discoveryQueue = this.getBullQueue(this.getDefaultQueueName());
        const client = await discoveryQueue.client;
        const queueNames = new Set(this.bullQueues.keys());
        const keyPrefix = `${prefix}:`;
        const keySuffix = ':repeat';
        let cursor = '0';

        do {
            const result = await client.scan(cursor, { MATCH: `${escapeRedisGlob(prefix)}:*${keySuffix}`, COUNT: 100 });
            cursor = result[0];
            for (const key of result[1]) {
                if (!key.startsWith(keyPrefix) || !key.endsWith(keySuffix)) continue;
                const queueName = key.slice(keyPrefix.length, -keySuffix.length);
                if (queueName && !queueName.includes(':')) queueNames.add(queueName);
            }
        } while (cursor !== '0');

        return [...queueNames].sort();
    }
}

async function closeBullQueue(queue: Queue<BullMqWorkerJobData>): Promise<void> {
    const clientPromise = queue.client.catch(() => undefined);
    try {
        await queue.close();
    } catch {
        // Queue cleanup is best-effort during application shutdown.
    }

    // BullMQ closes its ioredis client with QUIT, which leaves Sentinel failover detector
    // subscriptions connected. Disconnect the underlying client to tear those sockets down.
    try {
        (await clientPromise)?.disconnect();
    } catch {
        // Force cleanup is also best-effort when graceful cleanup fails.
    }
}

function getOwnQueueName(jobClass: JobClass): string | undefined {
    return Object.prototype.hasOwnProperty.call(jobClass, 'QUEUE_NAME') ? jobClass.QUEUE_NAME : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isWorkerPayloadWrapper(value: Record<string, unknown>): boolean {
    if (!Object.prototype.hasOwnProperty.call(value, 'options')) return false;
    if (Object.prototype.hasOwnProperty.call(value, 'data')) return true;
    return isRecord(value.options) && Object.prototype.hasOwnProperty.call(value.options, 'repeatKey');
}

function isTsfBullMqJobScheduler(scheduler: unknown): scheduler is {
    key: string;
    name: string;
    pattern?: string;
    template?: { data?: unknown };
} {
    if (!isRecord(scheduler) || typeof scheduler.key !== 'string' || typeof scheduler.name !== 'string') return false;
    if (!isRecord(scheduler.template)) return false;
    const templateData = scheduler.template.data;
    if (!isRecord(templateData) || !isRecord(templateData.options)) return false;
    return templateData.options.repeatKey === scheduler.key && scheduler.key.startsWith(`${scheduler.name}:`);
}

function isLegacyBullMqCronRepeatable(scheduler: unknown): scheduler is {
    key: string;
    name: string;
    pattern: string;
} {
    return (
        isRecord(scheduler) &&
        typeof scheduler.key === 'string' &&
        typeof scheduler.name === 'string' &&
        typeof scheduler.pattern === 'string' &&
        scheduler.iterationCount === undefined
    );
}

function escapeRedisGlob(value: string): string {
    return value.replace(/[\\*?[\]]/g, '\\$&');
}
