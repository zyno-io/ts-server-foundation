import { BaseAppConfig } from '../../app';
import { createRedisOptions } from '../../helpers/redis/redis';
import type { JobClass, QueuedWorkerJob, IJobOptions } from './types';
import { notifyWorkerObservers } from './observer';
import { Queue, type Job as BullJob, type QueueOptions, type WorkerOptions } from 'bullmq';

export interface BullMqWorkerJobData<I = unknown> {
    data: I;
    options: IJobOptions;
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
        await Promise.all([...this.bullQueues.values()].map(queue => queue.close().catch(() => {})));
        for (const queue of this.bullQueues.values()) WorkerQueueRegistry.bullQueues.delete(queue);
        this.bullQueues.clear();
    }

    static async closeQueues(): Promise<void> {
        WorkerQueueRegistry.queues.clear();
        const queues = [...WorkerQueueRegistry.bullQueues];
        WorkerQueueRegistry.bullQueues.clear();
        await Promise.all(queues.map(queue => queue.close().catch(() => {})));
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
