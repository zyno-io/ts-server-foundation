import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { AutoIncrement, entity, PrimaryKey } from '../src';

import {
    BaseAppConfig,
    BaseDatabase,
    BaseEntity,
    BaseJob,
    createApp,
    createPersistedEntity,
    FileUpload,
    http,
    HttpBody,
    MySQLDriver,
    WorkerJob,
    WorkerQueueRegistry,
    WorkerService,
    type MySQLDatabaseConfig
} from '../src';

const originalEnv = { ...process.env };
const SAMPLE_TABLE = 'tsf_full_stack_smoke_samples';
const LOCK_TABLE = 'tsf_full_stack_smoke_locks';
const JOBS_TABLE = '_jobs';

let activeMySQLConfig: MySQLDatabaseConfig | undefined;
let activeQueueName = 'full-stack-smoke';

@entity.name(SAMPLE_TABLE)
class FullStackSmokeEntity extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string;
}

class FullStackSmokeDatabase extends BaseDatabase {
    constructor() {
        if (!activeMySQLConfig) throw new Error('Full-stack smoke MySQL config was not initialized');
        super(new MySQLDriver(activeMySQLConfig), [FullStackSmokeEntity], {
            enableLocksTable: true,
            lockTableName: LOCK_TABLE
        });
    }
}

class FullStackSmokeConfig extends BaseAppConfig {
    APP_ENV = 'development';
    ENABLE_JOB_RUNNER = true;
    HTTP_REQUEST_LOGGING_MODE: 'none' | 'e2e' | 'finish' | 'errors' = 'none';
}

@WorkerJob()
class FullStackSmokeJob extends BaseJob<{ id: number; name: string }, { output: string }> {
    static override QUEUE_NAME = activeQueueName;

    constructor(private readonly db: FullStackSmokeDatabase) {
        super();
    }

    async handle(data: { id: number; name: string }): Promise<{ output: string }> {
        await this.db.query(FullStackSmokeEntity).filter({ id: data.id }).patchOne({ name: data.name });
        return { output: `updated:${data.name}` };
    }
}

@http.controller('/full-stack-smoke')
class FullStackSmokeController {
    constructor(
        private readonly db: FullStackSmokeDatabase,
        private readonly worker: WorkerService
    ) {}

    @http.POST()
    async post(
        body: HttpBody<{
            field1: string;
            field2: string;
            file1: FileUpload;
        }>
    ) {
        const hooks: string[] = [];
        const result = await this.db.transaction(async session => {
            await session.acquireSessionLock(['full-stack-smoke', body.field1]);
            session.addPreCommitHook(async () => {
                hooks.push('pre');
            });
            session.addPostCommitHook(async () => {
                hooks.push('post');
            });

            const entity = await createPersistedEntity(FullStackSmokeEntity, { name: 'Test' }, session);
            const rows = await session.query(FullStackSmokeEntity).find();
            const raw = await session.rawFindUnsafe<{ tag: string }>('SELECT ? AS tag', ['bound-ok']);
            return {
                entity,
                count: rows.length,
                rawTag: raw[0]?.tag
            };
        });

        const queued = await this.worker.queueJob(
            FullStackSmokeJob,
            { id: result.entity.id, name: 'Other World' },
            { recordToDatabase: true, queueName: activeQueueName }
        );
        const queuedJob = queued ? ('job' in queued ? queued.job : queued) : undefined;

        return {
            field1: body.field1,
            field2: body.field2,
            file1: {
                originalName: body.file1.originalName,
                type: body.file1.type,
                size: body.file1.size,
                contents: readFileSync(body.file1.path, 'utf8')
            },
            entityId: result.entity.id,
            count: result.count,
            rawTag: result.rawTag,
            hooks,
            job: queuedJob ? { id: queuedJob.id, name: queuedJob.name, queue: queuedJob.queue } : undefined
        };
    }
}

afterEach(async () => {
    process.env = { ...originalEnv };
    await WorkerQueueRegistry.closeQueues();
});

describe('full-stack smoke parity', () => {
    const mysqlConfig = readMySQLConfig();
    const redisConfig = readRedisConfig();

    it(
        'runs HTTP multipart, MySQL transaction/raw queries, and BullMQ worker recording together',
        {
            skip: mysqlConfig && redisConfig ? false : 'set MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE and REDIS_HOST to run full-stack smoke',
            timeout: 20_000
        },
        async () => {
            if (!mysqlConfig || !redisConfig) return;

            activeMySQLConfig = mysqlConfig;
            activeQueueName = `full-stack-smoke-${process.pid}-${Date.now()}`;
            FullStackSmokeJob.QUEUE_NAME = activeQueueName;
            process.env.APP_ENV = 'development';

            const setupDb = new FullStackSmokeDatabase();
            await resetSchema(setupDb);
            await createSchema(setupDb);
            await setupDb.driver.close();

            const app = createApp({
                config: FullStackSmokeConfig,
                db: FullStackSmokeDatabase,
                controllers: [FullStackSmokeController],
                providers: [FullStackSmokeJob],
                enableHealthcheck: false,
                enableWorker: true,
                defaultConfig: {
                    ENABLE_JOB_RUNNER: true,
                    BULL_QUEUE: activeQueueName,
                    REDIS_HOST: redisConfig.host,
                    REDIS_PORT: redisConfig.port,
                    REDIS_PREFIX: `tsf-full-stack-${process.pid}-${Date.now()}`
                },
                frameworkConfig: { port: 0 }
            });
            const db = app.get(FullStackSmokeDatabase);

            try {
                const server = await app.http.listen(0, '127.0.0.1');
                const address = server.address() as AddressInfo;
                const form = new FormData();
                form.set('_payload', JSON.stringify({ field1: 'value1' }));
                form.set('field2', 'value2');
                form.set('file1', new Blob(['file content'], { type: 'text/plain' }), 'file.txt');

                const response = await fetch(`http://127.0.0.1:${address.port}/full-stack-smoke`, {
                    method: 'POST',
                    body: form
                });
                const responseText = await response.text();
                assert.equal(response.status, 200, responseText);
                const body = JSON.parse(responseText) as {
                    field1: string;
                    field2: string;
                    file1: { originalName: string; type: string; size: number; contents: string };
                    entityId: number;
                    count: number;
                    rawTag: string;
                    hooks: string[];
                    job: { id: string; name: string; queue: string };
                };

                assert.deepEqual(body, {
                    field1: 'value1',
                    field2: 'value2',
                    file1: {
                        originalName: 'file.txt',
                        type: 'text/plain',
                        size: 'file content'.length,
                        contents: 'file content'
                    },
                    entityId: body.entityId,
                    count: 1,
                    rawTag: 'bound-ok',
                    hooks: ['pre', 'post'],
                    job: {
                        id: body.job.id,
                        name: 'FullStackSmokeJob',
                        queue: activeQueueName
                    }
                });

                await waitFor(async () => {
                    const row = await db.rawFindOneUnsafe<{ name: string }>(`SELECT name FROM ${quote(SAMPLE_TABLE)} WHERE id = ?`, [body.entityId]);
                    return row?.name === 'Other World';
                });

                const job = await waitFor(async () => {
                    const row = await db.rawFindOneUnsafe<{
                        name: string;
                        status: string;
                        data: unknown;
                        result: unknown;
                    }>(`SELECT name, status, data, result FROM ${quote(JOBS_TABLE)} WHERE name = ? ORDER BY completedAt DESC LIMIT 1`, [
                        'FullStackSmokeJob'
                    ]);
                    return row?.status === 'completed' ? row : undefined;
                });

                assert.equal(job.name, 'FullStackSmokeJob');
                assert.deepEqual(parseJsonColumn(job.data), { id: body.entityId, name: 'Other World' });
                assert.deepEqual(parseJsonColumn(job.result), { output: 'updated:Other World' });
            } finally {
                await app.stop();
                await resetSchema(db);
                await db.driver.close();
            }
        }
    );
});

async function resetSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS ${quote(JOBS_TABLE)}`);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS ${quote(SAMPLE_TABLE)}`);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS ${quote(LOCK_TABLE)}`);
}

async function createSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`
        CREATE TABLE ${quote(SAMPLE_TABLE)} (
            id int NOT NULL AUTO_INCREMENT,
            name varchar(255) NOT NULL,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE ${quote(JOBS_TABLE)} (
            id varchar(191) NOT NULL,
            queue varchar(191) NOT NULL,
            queueId varchar(191) NOT NULL,
            attempt int NOT NULL,
            name varchar(191) NOT NULL,
            data json NULL,
            traceId varchar(64) NULL,
            status varchar(32) NOT NULL,
            result json NULL,
            createdAt datetime(3) NOT NULL,
            shouldExecuteAt datetime(3) NOT NULL,
            executedAt datetime(3) NOT NULL,
            completedAt datetime(3) NOT NULL,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
}

function readMySQLConfig(): MySQLDatabaseConfig | undefined {
    if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) return undefined;
    return {
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : undefined,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD_SECRET,
        database: process.env.MYSQL_DATABASE,
        connectionLimit: 3
    };
}

function readRedisConfig(): { host: string; port?: number } | undefined {
    const host = process.env.REDIS_HOST ?? process.env.BULL_REDIS_HOST;
    if (!host) return undefined;
    const portValue = process.env.REDIS_PORT ?? process.env.BULL_REDIS_PORT;
    return {
        host,
        port: portValue ? Number(portValue) : undefined
    };
}

function quote(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
}

function parseJsonColumn(value: unknown): unknown {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const result = await fn();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Timed out waiting for full-stack smoke condition');
}
