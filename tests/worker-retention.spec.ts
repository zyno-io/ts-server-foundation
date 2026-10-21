import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BaseAppConfig,
    BaseDatabase,
    JobEntity,
    MySQLDriver,
    PostgresDriver,
    WorkerRecorderService,
    ReflectionClass,
    createMigrationPlan,
    renderSql,
    sql,
    type DatabaseDriver,
    type SqlInput
} from '../src';

function recorderFixture(overrides: Partial<BaseAppConfig> = {}) {
    const config = Object.assign(new BaseAppConfig(), overrides);
    const db = new BaseDatabase({ dialect: 'postgres' } as DatabaseDriver);
    const recorder = new WorkerRecorderService(db, config);
    recorder.ensureTableExists = async () => {};
    return { recorder, db, config };
}

describe('worker record retention', () => {
    it('defaults to 48 hours and can be disabled without touching the database', async () => {
        assert.equal(new BaseAppConfig().WORKER_RECORD_RETENTION_MS, 48 * 60 * 60_000);
        const { recorder, db } = recorderFixture({ WORKER_RECORD_RETENTION_MS: 0 });
        db.rawQuery = async () => assert.fail('disabled retention must not query');
        assert.equal(await recorder.purgeExpiredRecords(), 0);
        assert.equal(await new WorkerRecorderService().purgeExpiredRecords(), 0);
        assert.equal(
            ReflectionClass.from(JobEntity).indexes.some(index => index.names.join(',') === 'completedAt,id'),
            true
        );
    });

    it('rejects unsafe purge configuration', () => {
        for (const overrides of [
            { WORKER_RECORD_RETENTION_MS: -1 },
            { WORKER_RECORD_RETENTION_MS: NaN },
            { WORKER_RECORD_PURGE_BATCH_SIZE: 0 },
            { WORKER_RECORD_PURGE_BATCH_SIZE: 10_001 },
            { WORKER_RECORD_PURGE_INTERVAL_MS: 0 },
            { WORKER_RECORD_PURGE_INTERVAL_MS: Infinity }
        ]) {
            assert.throws(() => recorderFixture(overrides).recorder.isRetentionEnabled(), /WORKER_RECORD_/);
        }
    });

    it('limits a purge to selected ids and rechecks expiry and terminal status on deletion', async () => {
        const { recorder, db } = recorderFixture({ WORKER_RECORD_PURGE_BATCH_SIZE: 2, WORKER_RECORD_RETENTION_MS: 3_600_000 });
        const queries: ReturnType<typeof renderSql>[] = [];
        db.rawQuery = async <T>(query: SqlInput) => {
            queries.push(renderSql(query, 'postgres'));
            return [{ id: 'old-completed' }, { id: 'old-failed' }] as T[];
        };
        db.rawExecute = async query => {
            queries.push(renderSql(query, 'postgres'));
            return { affectedRows: 2 };
        };
        const startedAt = Date.now();
        assert.equal(await recorder.purgeExpiredRecords(), 2);
        assert.match(queries[0].sql, /ORDER BY "completedAt", "id" LIMIT \$4$/);
        assert.equal(queries[0].bindings[3], 2);
        assert.ok(Math.abs(new Date(String(queries[0].bindings[0])).getTime() - (startedAt - 3_600_000)) < 1_000);
        assert.deepEqual(queries[0].bindings.slice(1, 3), ['completed', 'failed']);
        assert.match(queries[1].sql, /^DELETE FROM "_jobs" WHERE "completedAt" < \$1 AND "status" IN \(\$2, \$3\) AND "id" IN \(\$4, \$5\)$/);
        assert.deepEqual(queries[1].bindings, [...queries[0].bindings.slice(0, 3), 'old-completed', 'old-failed']);
    });

    it('coalesces overlapping purges and can retry a failed batch', async () => {
        const { recorder, db } = recorderFixture();
        let resolveQuery!: () => void;
        const blocked = new Promise<void>(resolve => {
            resolveQuery = resolve;
        });
        let reads = 0;
        db.rawQuery = async () => {
            reads++;
            await blocked;
            throw new Error('database unavailable');
        };
        const first = recorder.purgeExpiredRecords();
        const second = recorder.purgeExpiredRecords();
        resolveQuery();
        const results = await Promise.allSettled([first, second]);
        assert.equal(reads, 1);
        assert.equal(
            results.every(result => result.status === 'rejected'),
            true
        );
        db.rawQuery = async () => [];
        assert.equal(await recorder.purgeExpiredRecords(), 0);
    });

    it('stops the background loop and waits for an active batch', async () => {
        const { recorder, db } = recorderFixture();
        let startQuery!: () => void;
        const started = new Promise<void>(resolve => {
            startQuery = resolve;
        });
        let finishQuery!: () => void;
        const pending = new Promise<void>(resolve => {
            finishQuery = resolve;
        });
        let reads = 0;
        db.rawQuery = async () => {
            reads++;
            startQuery();
            await pending;
            return [];
        };
        recorder.startRetention();
        try {
            // Keep the event loop alive until the recorder's unref'ed initial timer has fired.
            await new Promise(resolve => setTimeout(resolve, 10));
            await started;
            let stopped = false;
            const stop = recorder.stopRetention().then(() => {
                stopped = true;
            });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(stopped, false);
            finishQuery();
            await stop;
            assert.equal(reads, 1);
        } finally {
            finishQuery();
            await recorder.stopRetention();
        }
    });
});

for (const dialect of ['mysql', 'postgres'] as const) {
    const prefix = dialect === 'mysql' ? 'MYSQL' : 'PG';
    const host = process.env[`${prefix}_HOST`];
    const user = process.env[`${prefix}_USER`];
    const database = process.env[`${prefix}_DATABASE`];
    it(
        `purges old completed and failed rows in bounded batches on ${dialect}`,
        {
            skip: host && user && database ? false : `set ${prefix}_HOST, ${prefix}_USER and ${prefix}_DATABASE for retention integration`
        },
        async () => {
            // A dedicated database prevents this test from sharing the framework-owned _jobs table.
            const name = `tsf_retention_${process.pid}_${Date.now()}`;
            const connection = {
                host,
                user,
                password: process.env[`${prefix}_PASSWORD_SECRET`],
                database,
                port: process.env[`${prefix}_PORT`] ? Number(process.env[`${prefix}_PORT`]) : undefined
            };
            const admin = new BaseDatabase(dialect === 'mysql' ? new MySQLDriver(connection) : new PostgresDriver(connection));
            await admin.rawExecute(sql`CREATE DATABASE ${sql.identifier(name)}`);
            const db = new BaseDatabase(
                dialect === 'mysql' ? new MySQLDriver({ ...connection, database: name }) : new PostgresDriver({ ...connection, database: name })
            );
            const recorder = new WorkerRecorderService(db, Object.assign(new BaseAppConfig(), { WORKER_RECORD_PURGE_BATCH_SIZE: 2 }));
            try {
                await recorder.ensureTableExists();
                // Exercise the upgrade path too: provision a missing index on an existing table.
                const indexName = '_jobs_completed_at_id_idx';
                await db.rawExecute(
                    dialect === 'mysql'
                        ? sql`DROP INDEX ${sql.identifier(indexName)} ON ${sql.identifier('_jobs')}`
                        : sql`DROP INDEX ${sql.identifier(indexName)}`
                );
                await new WorkerRecorderService(db).ensureTableExists();
                assert.equal((await createMigrationPlan(db, { tableNames: ['_jobs'] })).hasChanges, false);
                const now = Date.now();
                for (const [id, status, age] of [
                    ['old-completed-1', 'completed', 49],
                    ['old-failed', 'failed', 50],
                    ['old-completed-2', 'completed', 51],
                    ['recent-completed', 'completed', 1],
                    ['recent-failed', 'failed', 47]
                ] as const) {
                    const completedAt = new Date(now - age * 3_600_000);
                    await db.rawExecute(
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
                        )}) VALUES (${id}, ${'test'}, ${id}, ${1}, ${'TestJob'}, ${null}, ${null}, ${status}, ${null}, ${completedAt}, ${completedAt}, ${completedAt}, ${completedAt})`
                    );
                }
                assert.equal(await recorder.purgeExpiredRecords(), 2);
                assert.equal((await db.rawQuery(sql`SELECT ${sql.identifier('id')} FROM ${sql.identifier('_jobs')}`)).length, 3);
                assert.equal(await recorder.purgeExpiredRecords(), 1);
                assert.equal(await recorder.purgeExpiredRecords(), 0);
                assert.deepEqual(
                    (
                        await db.rawQuery<{ id: string }>(
                            sql`SELECT ${sql.identifier('id')} FROM ${sql.identifier('_jobs')} ORDER BY ${sql.identifier('id')}`
                        )
                    ).map(row => row.id),
                    ['recent-completed', 'recent-failed']
                );
            } finally {
                await db.driver.close();
                await admin.rawExecute(sql`DROP DATABASE ${sql.identifier(name)}`);
                await admin.driver.close();
            }
        }
    );
}
