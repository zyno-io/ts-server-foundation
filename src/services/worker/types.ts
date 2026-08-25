import type { ClassType } from '../../types';

export const JobSymbol = Symbol('Job');
export const InputDataSymbol = Symbol('InputData');
export const OutputDataSymbol = Symbol('OutputData');

export interface WorkerJobOptions {
    queueName?: string;
    cronSchedule?: string | null;
    cronTz?: string | null;
}

export interface WorkerJobMetadata {
    readonly queueName?: string;
    readonly cronSchedule: string | null;
    readonly cronTz: string | null;
}

export abstract class BaseJob<I = void, O = void> {
    [JobSymbol] = JobSymbol;
    [InputDataSymbol]!: I;
    [OutputDataSymbol]!: O;

    abstract handle(data: I): Promise<O> | O;
}

export type JobClass<I = any, O = any> = ClassType<BaseJob<I, O>>;

const workerJobs = new Map<JobClass, WorkerJobMetadata>();

export function WorkerJob(options: WorkerJobOptions = {}): ClassDecorator {
    return target => {
        const jobClass = target as unknown as JobClass;
        workerJobs.set(
            jobClass,
            Object.freeze({
                queueName: options.queueName,
                cronSchedule: options.cronSchedule ?? null,
                cronTz: options.cronTz ?? null
            })
        );
    };
}

export function getRegisteredWorkerJobs(): JobClass[] {
    return [...workerJobs.keys()];
}

export function getWorkerJobMetadata(jobClass: JobClass): WorkerJobMetadata {
    const metadata = workerJobs.get(jobClass);
    if (!metadata) throw new Error(`Worker job is not registered: ${jobClass.name}`);
    return metadata;
}

export interface IJobOptions {
    delay?: number;
    queueName?: string;
    runInTest?: boolean;
    runImmediately?: boolean;
    /** Defaults to true when a database is configured; set false to opt out. */
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
