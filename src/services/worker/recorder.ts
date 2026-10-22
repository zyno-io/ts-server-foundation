import { BaseAppConfig } from '../../app/config';
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
const TERMINAL_DRAIN_BATCH_SIZE = 100;

/**
 * Records terminal worker jobs. For BullMQ queues, a leader-owned QueueEvents observer writes
 * the durable record before removing the terminal job from Redis.
 */
export class WorkerRecorderService {
    private readonly records: WorkerJobRecord[] = [];
    private readonly observers = new Map<string, QueueEvents>();
    private readonly terminalJobTasks = new Map<string, Promise<void>>();
    private tableReady?: Promise<void>;
    private retentionRunning = false;
    private retentionTimer?: NodeJS.Timeout;
    private retentionTask?: Promise<number>;
    private readonly logger = createLogger(this);

    constructor(
        private readonly db?: BaseDatabase,
        private readonly config: BaseAppConfig = new BaseAppConfig()
    ) {
        if (db) JobEntity.registerDatabase(db);
    }

    getRecords(): WorkerJobRecord[] {
        return this.records.map(record => ({ ...record }));
    }

    isRetentionEnabled(): boolean {
        const { WORKER_RECORD_RETENTION_MS: ttl, WORKER_RECORD_PURGE_BATCH_SIZE: batchSize, WORKER_RECORD_PURGE_INTERVAL_MS: interval } = this.config;
        if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Error('WORKER_RECORD_RETENTION_MS must be a nonnegative safe integer');
        if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
            throw new Error('WORKER_RECORD_PURGE_BATCH_SIZE must be an integer between 1 and 10000');
        }
        if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 2_147_483_647) {
            throw new Error('WORKER_RECORD_PURGE_INTERVAL_MS must be an integer between 1000 and 2147483647');
        }
        return !!this.db && ttl > 0;
    }

    /** Called only by the elected retention worker (or the in-process test runner). */
    startRetention(): void {
        if (this.retentionRunning || !this.isRetentionEnabled()) return;
        this.retentionRunning = true;
        this.scheduleRetention(0);
    }

    async stopRetention(): Promise<void> {
        this.retentionRunning = false;
        clearTimeout(this.retentionTimer);
        this.retentionTimer = undefined;
        await this.retentionTask?.catch(() => {});
    }

    /** Deletes at most one batch in autocommit, outside job recording and application transactions. */
    async purgeExpiredRecords(): Promise<number> {
        if (!this.isRetentionEnabled()) return 0;
        if (this.retentionTask) return this.retentionTask;
        const task = this.purgeExpiredBatch();
        this.retentionTask = task;
        try {
            return await task;
        } finally {
            if (this.retentionTask === task) this.retentionTask = undefined;
        }
    }

    private scheduleRetention(delay: number): void {
        if (!this.retentionRunning) return;
        this.retentionTimer = setTimeout(async () => {
            this.retentionTimer = undefined;
            let nextDelay = this.config.WORKER_RECORD_PURGE_INTERVAL_MS;
            try {
                const deleted = await this.purgeExpiredRecords();
                // Drain historical backlogs gradually, yielding between short, bounded transactions.
                if (deleted === this.config.WORKER_RECORD_PURGE_BATCH_SIZE) nextDelay = 1_000;
            } catch (error) {
                this.logger.error('Failed to purge expired worker records', error);
            }
            this.scheduleRetention(nextDelay);
        }, delay);
        this.retentionTimer.unref();
    }

    private async purgeExpiredBatch(): Promise<number> {
        await this.ensureTableExists();
        const db = this.db!;
        const cutoff = new Date(Date.now() - this.config.WORKER_RECORD_RETENTION_MS);
        const expired = sql`${sql.identifier('completedAt')} < ${cutoff} AND ${sql.identifier('status')} IN (${'completed'}, ${'failed'})`;
        // A limited indexed read works on both MySQL and PostgreSQL without an unbounded DELETE
        // or MySQL's restrictions on selecting from the target table in a DELETE subquery.
        const rows = await db.rawQuery<{ id: string }>(
            sql`SELECT ${sql.identifier('id')} FROM ${sql.identifier('_jobs')} WHERE ${expired} ORDER BY ${sql.identifier('completedAt')}, ${sql.identifier('id')} LIMIT ${this.config.WORKER_RECORD_PURGE_BATCH_SIZE}`
        );
        if (!rows.length) return 0;
        const result = await db.rawExecute(
            sql`DELETE FROM ${sql.identifier('_jobs')} WHERE ${expired} AND ${sql.identifier('id')} IN (${sql.join(rows.map(row => sql`${row.id}`))})`
        );
        return result.affectedRows;
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
                if (!isSchemaAlreadyExistsError(error)) throw error;
                const retry = await createMigrationPlan(db, { tableNames: ['_jobs'] });
                if (retry.hasChanges) throw error;
            }
        }
    }

    private async drainTerminalBullMqJobs(queueName: string, queueRegistry: WorkerQueueRegistry, observer: QueueEvents): Promise<void> {
        const queue = queueRegistry.getBullQueue(queueName);
        for (const status of ['completed', 'failed'] as const) {
            while (this.observers.get(queueName) === observer) {
                // Removal shifts the remaining set forward. Always read its first bounded page
                // instead of materializing every historical job or skipping jobs by offset.
                const jobs = await (status === 'completed'
                    ? queue.getCompleted(0, TERMINAL_DRAIN_BATCH_SIZE - 1)
                    : queue.getFailed(0, TERMINAL_DRAIN_BATCH_SIZE - 1));
                if (!jobs.length) break;
                for (const job of jobs) {
                    if (this.observers.get(queueName) !== observer) return;
                    await this.queueTerminalBullMqJob(
                        queueName,
                        String(job.id),
                        status,
                        status === 'completed' ? job.returnvalue : { reason: job.failedReason, stack: job.stacktrace },
                        queueRegistry,
                        observer
                    );
                }
            }
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

function isSchemaAlreadyExistsError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown; errno?: unknown };
    return (
        candidate.code === '42P07' ||
        candidate.code === 'ER_TABLE_EXISTS_ERROR' ||
        candidate.errno === 1050 ||
        candidate.code === 'ER_DUP_KEYNAME' ||
        candidate.errno === 1061
    );
}

function toJsonValue(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}
