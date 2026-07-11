import type { ClassType } from '../../types';

export const JobSymbol = Symbol('Job');
export const InputDataSymbol = Symbol('InputData');
export const OutputDataSymbol = Symbol('OutputData');

export interface WorkerJobOptions {
    queueName?: string;
    queue?: string;
    cronSchedule?: string | null;
    cron?: string | null;
}

export abstract class BaseJob<I = void, O = void> {
    [JobSymbol] = JobSymbol;
    [InputDataSymbol]!: I;
    [OutputDataSymbol]!: O;

    static QUEUE_NAME = 'default';
    static CRON_SCHEDULE: string | null = null;

    abstract handle(data: I): Promise<O> | O;
}

export interface BaseJobClass {
    QUEUE_NAME: string;
    CRON_SCHEDULE: string | null;
}

export type JobClass<I = any, O = any> = ClassType<BaseJob<I, O>> & BaseJobClass;

const workerJobs = new Set<JobClass>();

export function WorkerJob(options: WorkerJobOptions = {}): ClassDecorator {
    return target => {
        const jobClass = target as unknown as JobClass;
        const queueName = options.queueName ?? options.queue;
        const cronSchedule = options.cronSchedule ?? options.cron;
        if (queueName !== undefined) jobClass.QUEUE_NAME = queueName;
        if (cronSchedule !== undefined) jobClass.CRON_SCHEDULE = cronSchedule;
        workerJobs.add(jobClass);
    };
}

export function getRegisteredWorkerJobs(): JobClass[] {
    return [...workerJobs];
}

export interface IJobOptions {
    delay?: number;
    queueName?: string;
    runInTest?: boolean;
    runImmediately?: boolean;
    recordToDatabase?: boolean;
    repeatKey?: string;
}

export type WorkerJobStatus = 'queued' | 'completed' | 'failed' | 'skipped';

export interface QueuedWorkerJob<I = unknown> {
    id: string;
    queue: string;
    name: string;
    data: I;
    jobClass: JobClass<I>;
    options: IJobOptions;
    createdAt: Date;
    shouldExecuteAt: Date;
    attemptsMade: number;
    status: WorkerJobStatus;
    result?: unknown;
}

export interface WorkerJobRecord<I = unknown, O = unknown> {
    id: string;
    queue: string;
    queueId: string;
    attempt: number;
    name: string;
    data: I;
    traceId: string | null;
    status: 'completed' | 'failed';
    result: O;
    createdAt: Date;
    shouldExecuteAt: Date;
    executedAt: Date;
    completedAt: Date;
}
