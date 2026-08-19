import { BaseDatabase, createMigrationPlan } from '../../database';
import { sql } from '../../database/sql';
import { uuid7 } from '../../helpers';
import { createLogger } from '../logger';
import { QueueEvents, type Job as BullJob } from 'bullmq';

import { JobEntity } from './entity';
import { notifyWorkerObservers } from './observer';
import { WorkerQueueRegistry, type BullMqWorkerJobData } from './queue';
import type { JobClass, QueuedWorkerJob, WorkerJobRecord } from './types';

type TerminalJobStatus = 'completed' | 'failed';

/**
 * Records terminal worker jobs. For BullMQ queues, a leader-owned QueueEvents observer writes
 * the durable record before removing the terminal job from Redis.
 */
export class WorkerRecorderService {
    private readonly records: WorkerJobRecord[] = [];
    private readonly observers = new Map<string, QueueEvents>();
    private readonly terminalJobTasks = new Map<string, Promise<void>>();
    private tableReady?: Promise<void>;
    private readonly logger = createLogger(this);

    constructor(private readonly db?: BaseDatabase) {
        if (db) JobEntity.registerDatabase(db);
    }

    getRecords(): WorkerJobRecord[] {
        return this.records.map(record => ({ ...record }));
    }

    async ensureTableExists(): Promise<void> {
        if (!this.db) return;
        if (!this.tableReady) this.tableReady = this.createOrUpdateTable();
        try {
            await this.tableReady;
        } catch (error) {
            this.tableReady = undefined;
            throw error;
        }
    }

    async start(queueName: string, queueRegistry: WorkerQueueRegistry): Promise<void> {
        if (this.observers.has(queueName)) return;

        await this.ensureTableExists();
        const observer = new QueueEvents(queueName, queueRegistry.getBullMqOptions());
        this.observers.set(queueName, observer);
        observer.on('completed', args => {
            void this.queueTerminalBullMqJob(queueName, args.jobId, 'completed', args.returnvalue, queueRegistry, observer).catch(error => {
                this.logger.error('Failed to record completed BullMQ job', error, { queue: queueName, jobId: args.jobId });
            });
        });
        observer.on('failed', args => {
            void this.queueTerminalBullMqJob(queueName, args.jobId, 'failed', { reason: args.failedReason }, queueRegistry, observer).catch(error => {
                this.logger.error('Failed to record failed BullMQ job', error, { queue: queueName, jobId: args.jobId });
            });
        });
        observer.on('error', error => {
            this.logger.error('BullMQ recorder observer error', error, { queue: queueName });
        });

        try {
            await observer.waitUntilReady();
            await this.drainTerminalBullMqJobs(queueName, queueRegistry, observer);
            this.logger.info('Worker recorder started', { queue: queueName });
        } catch (error) {
            if (this.observers.get(queueName) === observer) this.observers.delete(queueName);
            await observer.close().catch(() => {});
            throw error;
        }
    }

    async stop(queueName?: string): Promise<void> {
        const entries = queueName
            ? ([[queueName, this.observers.get(queueName)]] as const)
            : [...this.observers.entries()].map(([name, observer]) => [name, observer] as const);
        const closures: Promise<void>[] = [];
        for (const [name, observer] of entries) {
            if (!observer) continue;
            if (this.observers.get(name) !== observer) continue;
            this.observers.delete(name);
            closures.push(observer.close());
        }
        await Promise.all(closures);
        const tasks = queueName
            ? [...this.terminalJobTasks.entries()].filter(([key]) => key.startsWith(`${queueName}\0`)).map(([, task]) => task)
            : [...this.terminalJobTasks.values()];
        await Promise.allSettled(tasks);
    }

    async recordCompleted(job: QueuedWorkerJob, result: unknown, options: { recordToDatabase?: boolean } = {}): Promise<WorkerJobRecord> {
        return this.record(job, 'completed', result, options);
    }

    async recordFailed(job: QueuedWorkerJob, result: unknown, options: { recordToDatabase?: boolean } = {}): Promise<WorkerJobRecord> {
        return this.record(job, 'failed', result, options);
    }

    private async createOrUpdateTable(): Promise<void> {
        const db = this.db!;
        if (!db.entityRegistry.includes(JobEntity)) db.entityRegistry.push(JobEntity);
        JobEntity.registerDatabase(db);
        const plan = await createMigrationPlan(db, { tableNames: ['_jobs'] });
        for (const statement of plan.statements) {
            if (statement.startsWith('\0table:')) continue;
            try {
                await db.rawExecuteUnsafe(statement);
            } catch (error) {
                // Another elected queue recorder can initialize the shared table at the same time.
                // Re-reading the scoped plan verifies that its DDL won the race before suppressing it.
                if (!isTableAlreadyExistsError(error)) throw error;
                const retry = await createMigrationPlan(db, { tableNames: ['_jobs'] });
                if (retry.hasChanges) throw error;
            }
        }
    }

    private async drainTerminalBullMqJobs(queueName: string, queueRegistry: WorkerQueueRegistry, observer: QueueEvents): Promise<void> {
        const queue = queueRegistry.getBullQueue(queueName);
        const [completed, failed] = await Promise.all([queue.getCompleted(), queue.getFailed()]);
        for (const job of completed) {
            await this.queueTerminalBullMqJob(queueName, String(job.id), 'completed', job.returnvalue, queueRegistry, observer);
        }
        for (const job of failed) {
            await this.queueTerminalBullMqJob(
                queueName,
                String(job.id),
                'failed',
                { reason: job.failedReason, stack: job.stacktrace },
                queueRegistry,
                observer
            );
        }
    }

    private queueTerminalBullMqJob(
        queueName: string,
        jobId: string,
        status: TerminalJobStatus,
        result: unknown,
        queueRegistry: WorkerQueueRegistry,
        observer: QueueEvents
    ): Promise<void> {
        const key = `${queueName}\0${jobId}`;
        const existing = this.terminalJobTasks.get(key);
        if (existing) return existing;
        let task: Promise<void>;
        task = this.recordTerminalBullMqJob(queueName, jobId, status, result, queueRegistry, observer).finally(() => {
            if (this.terminalJobTasks.get(key) === task) this.terminalJobTasks.delete(key);
        });
        this.terminalJobTasks.set(key, task);
        return task;
    }

    private async recordTerminalBullMqJob(
        queueName: string,
        jobId: string,
        status: TerminalJobStatus,
        result: unknown,
        queueRegistry: WorkerQueueRegistry,
        observer: QueueEvents
    ): Promise<void> {
        if (this.observers.get(queueName) !== observer) return;
        const queue = queueRegistry.getBullQueue(queueName);
        const job = await queue.getJob(jobId);
        if (!job) return;
        const record = await this.record(this.toQueuedWorkerJob(job), status, result, {
            recordToDatabase: this.shouldRecordBullMqJob(job)
        });
        await job.remove();
        this.logger.info(`Recorded ${status} BullMQ job`, { queue: queueName, jobId, name: record.name });
    }

    private shouldRecordBullMqJob(job: BullJob<BullMqWorkerJobData>): boolean {
        return job.data?.options?.recordToDatabase !== false;
    }

    private toQueuedWorkerJob(job: BullJob<BullMqWorkerJobData>): QueuedWorkerJob {
        const payload = job.data ?? ({} as BullMqWorkerJobData);
        const options = payload.options ?? {};
        const createdAt = new Date(job.timestamp);
        const delay = typeof job.delay === 'number' ? job.delay : Number(job.opts.delay ?? 0);
        return {
            id: String(job.id ?? ''),
            queue: job.queueName,
            name: job.name,
            data: payload.data === undefined ? {} : payload.data,
            // QueueEvents can observe a terminal job after its handler was removed during deployment.
            // Terminal observers expose the historical job metadata, not a runnable handler instance.
            jobClass: { name: job.name } as JobClass,
            options: { ...options },
            createdAt,
            shouldExecuteAt: new Date(createdAt.getTime() + delay),
            attemptsMade: job.attemptsMade,
            status: 'queued'
        };
    }

    private async record(
        job: QueuedWorkerJob,
        status: TerminalJobStatus,
        result: unknown,
        options: { recordToDatabase?: boolean }
    ): Promise<WorkerJobRecord> {
        const now = new Date();
        const record: WorkerJobRecord = {
            id: `${job.queue}:${job.id}:${job.attemptsMade || 1}`,
            queue: job.queue,
            queueId: job.id,
            attempt: job.attemptsMade || 1,
            name: job.name,
            data: job.data,
            traceId: null,
            status,
            result,
            createdAt: job.createdAt,
            shouldExecuteAt: job.shouldExecuteAt,
            executedAt: now,
            completedAt: now
        };

        if (options.recordToDatabase !== false && this.db) {
            await this.ensureTableExists();
            await this.insertRecord(record);
        }
        this.records.push(record);
        notifyWorkerObservers({ type: status, job, record });
        return record;
    }

    private async insertRecord(record: WorkerJobRecord): Promise<void> {
        const db = this.db!;
        const columns = [
            'id',
            'queue',
            'queueId',
            'attempt',
            'name',
            'data',
            'traceId',
            'status',
            'result',
            'createdAt',
            'shouldExecuteAt',
            'executedAt',
            'completedAt'
        ];
        const values = [
            sql`${record.id || uuid7()}`,
            sql`${record.queue}`,
            sql`${record.queueId}`,
            sql`${record.attempt}`,
            sql`${record.name}`,
            sql`${toJsonValue(record.data)}`,
            sql`${record.traceId}`,
            sql`${record.status}`,
            sql`${toJsonValue(record.result)}`,
            sql`${record.createdAt}`,
            sql`${record.shouldExecuteAt}`,
            sql`${record.executedAt}`,
            sql`${record.completedAt}`
        ];
        const insert = sql`INSERT INTO ${sql.identifier('_jobs')} (${sql.join(columns.map(name => sql.identifier(name)))}) VALUES (${sql.join(values)})`;
        const duplicateClause =
            db.driver.dialect === 'postgres'
                ? sql` ON CONFLICT (${sql.identifier('id')}) DO NOTHING`
                : sql` ON DUPLICATE KEY UPDATE ${sql.identifier('id')} = ${sql.identifier('id')}`;
        await db.rawExecute(sql`${insert}${duplicateClause}`);
    }
}

function isTableAlreadyExistsError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown; errno?: unknown };
    return candidate.code === '42P07' || candidate.code === 'ER_TABLE_EXISTS_ERROR' || candidate.errno === 1050;
}

function toJsonValue(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}
