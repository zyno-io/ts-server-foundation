import { BaseDatabase } from '../../database';
import { uuid7 } from '../../helpers';
import { sql } from '../../database/sql';
import { JobEntity } from './entity';
import { notifyWorkerObservers } from './observer';
import type { QueuedWorkerJob, WorkerJobRecord } from './types';

export class WorkerRecorderService {
    private readonly records: WorkerJobRecord[] = [];

    constructor(private readonly db?: BaseDatabase) {
        if (db) JobEntity.registerDatabase(db);
    }

    getRecords(): WorkerJobRecord[] {
        return this.records.map(record => ({ ...record }));
    }

    async recordCompleted(job: QueuedWorkerJob, result: unknown, options: { recordToDatabase?: boolean } = {}): Promise<WorkerJobRecord> {
        return this.record(job, 'completed', result, options);
    }

    async recordFailed(job: QueuedWorkerJob, result: unknown, options: { recordToDatabase?: boolean } = {}): Promise<WorkerJobRecord> {
        return this.record(job, 'failed', result, options);
    }

    private async record(
        job: QueuedWorkerJob,
        status: 'completed' | 'failed',
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

        this.records.push(record);
        if (options.recordToDatabase && this.db) await this.insertRecord(record);
        notifyWorkerObservers({ type: status, job, record });
        return record;
    }

    private async insertRecord(record: WorkerJobRecord): Promise<void> {
        await this.db!.rawExecute(
            sql`INSERT INTO ${sql.identifier('_jobs')} (${sql.join(
                [
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
                ].map(name => sql.identifier(name))
            )}) VALUES (${sql.join([
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
            ])})`
        );
    }
}

function toJsonValue(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}
