import assert from 'node:assert/strict';
import createDebug from 'debug';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';

import {
    BaseDatabase,
    createDatabase,
    createSharedMySQLSessionPool,
    defineMigration,
    ensureSharedMySQLSessionDatabase,
    completeSharedMySQLSessionSchema,
    type LogEntry,
    MySQLDriver,
    prepareSharedMySQLSessionSchema,
    releaseSharedMySQLSessionDatabase,
    resetLogSink,
    setLogSink,
    sql,
    TestingHelpers,
    type MySQLConnectionLike,
    type MySQLDatabaseConfig,
    UniqueConstraintError
} from '../src';
import { connectRpc, listenRpc } from '../src/database/drivers/mysql-session-rpc';
import { MySQLSessionManager } from '../src/testing/mysql-session-manager';

const originalEnv = { ...process.env };

describe('MySQL shared session manager', () => {
    const mysqlConfig = readMySQLConfig();

    afterEach(() => {
        process.env = { ...originalEnv };
        createDebug.disable();
        resetLogSink();
    });

    it('round-trips BigInt and Buffer payloads over the local RPC codec', async () => {
        const server = await listenRpc(0, (_method, params) => params);
        const peer = await connectRpc(server.port);
        try {
            const result = await peer.call<{ count: bigint; bytes: Buffer }>('echo', {
                count: 9007199254740993n,
                bytes: Buffer.from([1, 2, 3])
            });

            assert.equal(result.count, 9007199254740993n);
            assert.deepStrictEqual(result.bytes, Buffer.from([1, 2, 3]));
        } finally {
            peer.close();
            await server.close();
        }
    });

    it('round-trips unique constraint errors over the local RPC codec', async () => {
        const server = await listenRpc(0, () => {
            throw new UniqueConstraintError('Duplicate entry');
        });
        const peer = await connectRpc(server.port);
        try {
            await assert.rejects(
                () => peer.call('fail'),
                (error: unknown) => {
                    assert.ok(error instanceof UniqueConstraintError);
                    assert.equal((error as Error).message, 'Duplicate entry');
                    return true;
                }
            );
        } finally {
            peer.close();
            await server.close();
        }
    });

    it('logs manager process lifecycle', async () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        createDebug.enable('MySQLSessionManager');
        const manager = new MySQLSessionManager({
            token: `manager-logging-${process.pid}-${Date.now()}`,
            mysql: {
                host: '127.0.0.1',
                user: 'root'
            }
        });

        await manager.start();
        await manager.stop();

        assert.ok(entries.some(entry => entry.levelName === 'debug' && entry.message === 'Shared MySQL session manager started'));
        assert.ok(entries.some(entry => entry.levelName === 'debug' && entry.message === 'Shared MySQL session manager stopping'));
        assert.ok(entries.some(entry => entry.levelName === 'debug' && entry.message === 'Shared MySQL session manager stopped'));
    });

    it(
        'prepares a shared schema once and rolls back a released lease',
        {
            skip: mysqlConfig ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL shared session manager integration'
        },
        async () => {
            if (!mysqlConfig) return;
            const entries: LogEntry[] = [];
            setLogSink(entry => entries.push(entry));
            createDebug.enable('MySQLSessionManager');
            const manager = await startManager(mysqlConfig, 'manager-rpc');
            const key = `manager-rpc-${process.pid}-${Date.now()}`;
            let databaseName = '';

            try {
                const database = await ensureSharedMySQLSessionDatabase({
                    key,
                    prefix: 'tsf_session_mgr',
                    keepDatabase: false
                });
                databaseName = database.databaseName;

                const preparation = await prepareSharedMySQLSessionSchema(key, database.leaseId);
                assert.equal(preparation.run, true);
                assert.ok(preparation.preparationId);

                const schemaConnection = await createSharedMySQLSessionPool(key, 'schema-client', database.leaseId).getConnection();
                try {
                    await schemaConnection.query(`
                        CREATE TABLE tsf_session_rows (
                            id int NOT NULL AUTO_INCREMENT,
                            label varchar(64) NOT NULL,
                            PRIMARY KEY (id)
                        ) ENGINE=InnoDB
                    `);
                } finally {
                    await schemaConnection.release();
                }
                await completeSharedMySQLSessionSchema(key, database.leaseId, preparation.preparationId);

                const secondPreparation = await prepareSharedMySQLSessionSchema(key, database.leaseId);
                assert.equal(secondPreparation.run, false);

                const writeConnection = await createSharedMySQLSessionPool(key, 'writer-client', database.leaseId).getConnection();
                await writeConnection.query('START TRANSACTION');
                await writeConnection.query('INSERT INTO tsf_session_rows (label) VALUES (?)', ['rolled-back']);
                await writeConnection.query('COMMIT');
                await assert.rejects(
                    () => writeConnection.query('CREATE TABLE tsf_session_runtime_ddl (id int NOT NULL) ENGINE=InnoDB'),
                    error =>
                        error instanceof Error &&
                        error.message.includes('Shared MySQL session manager blocked runtime DDL (CREATE)') &&
                        error.message.includes(databaseName) &&
                        error.message.includes('CREATE TABLE tsf_session_runtime_ddl')
                );
                assert.equal(await countRows(writeConnection, 'tsf_session_rows'), 1);
                await writeConnection.release();

                const verifyConnection = await createSharedMySQLSessionPool(key, 'verify-client', database.leaseId).getConnection();
                try {
                    assert.equal(await countRows(verifyConnection, 'tsf_session_rows'), 0);
                } finally {
                    await verifyConnection.release();
                }
            } finally {
                await manager.stop();
            }

            assertConnectionLifecycleLogs(entries, databaseName);
            assert.equal(await databaseExists(mysqlConfig, databaseName), false);
        }
    );

    it(
        'queues logical connections for a pooled slot even when the client id matches',
        {
            skip: mysqlConfig ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL shared session manager integration'
        },
        async () => {
            if (!mysqlConfig) return;
            const manager = await startManager(mysqlConfig, 'manager-reentrant');
            const key = `manager-reentrant-${process.pid}-${Date.now()}`;
            let firstConnection: MySQLConnectionLike | undefined;
            let secondConnection: MySQLConnectionLike | undefined;
            let waitingConnection: MySQLConnectionLike | undefined;

            try {
                const database = await ensureSharedMySQLSessionDatabase({
                    key,
                    prefix: 'tsf_session_reentrant',
                    keepDatabase: false
                });
                const preparation = await prepareSharedMySQLSessionSchema(key, database.leaseId);
                assert.equal(preparation.run, true);
                const setupConnection = await createSharedMySQLSessionPool(key, 'setup-client', database.leaseId).getConnection();
                try {
                    await setupConnection.query(`
                        CREATE TABLE tsf_session_reentrant_rows (
                            id int NOT NULL AUTO_INCREMENT,
                            label varchar(64) NOT NULL,
                            PRIMARY KEY (id)
                        ) ENGINE=InnoDB
                    `);
                } finally {
                    await setupConnection.release();
                }
                await completeSharedMySQLSessionSchema(key, database.leaseId, preparation.preparationId);

                const reentrantPool = createSharedMySQLSessionPool(key, 'same-client', database.leaseId);
                firstConnection = await reentrantPool.getConnection();
                await firstConnection.query('START TRANSACTION');
                await firstConnection.query('INSERT INTO tsf_session_reentrant_rows (label) VALUES (?)', ['first']);

                const secondConnectionPromise = reentrantPool.getConnection();
                await assertPending(secondConnectionPromise);

                await firstConnection.release();
                firstConnection = undefined;

                secondConnection = await secondConnectionPromise;
                assert.equal(await countRows(secondConnection, 'tsf_session_reentrant_rows'), 0);
                await secondConnection.query('START TRANSACTION');
                await secondConnection.query('INSERT INTO tsf_session_reentrant_rows (label) VALUES (?)', ['second']);

                const waitingConnectionPromise = createSharedMySQLSessionPool(key, 'other-client', database.leaseId).getConnection();
                await assertPending(waitingConnectionPromise);

                await secondConnection.release();
                secondConnection = undefined;

                waitingConnection = await waitingConnectionPromise;
                assert.equal(await countRows(waitingConnection, 'tsf_session_reentrant_rows'), 0);
            } finally {
                await releaseQuietly(waitingConnection);
                await releaseQuietly(secondConnection);
                await releaseQuietly(firstConnection);
                await manager.stop();
            }
        }
    );

    it(
        'allocates pooled database slots for parallel clients',
        {
            skip: mysqlConfig ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL shared session manager integration'
        },
        async () => {
            if (!mysqlConfig) return;
            const manager = await startManager(mysqlConfig, 'manager-pool', 2);
            const key = `manager-pool-${process.pid}-${Date.now()}`;
            let firstLease: string | undefined;
            let secondLease: string | undefined;
            let thirdLease: string | undefined;
            let firstName = '';
            let secondName = '';

            try {
                const first = await ensureSharedMySQLSessionDatabase({
                    key,
                    prefix: 'tsf_session_pool',
                    keepDatabase: false
                });
                const second = await ensureSharedMySQLSessionDatabase({
                    key,
                    prefix: 'tsf_session_pool',
                    keepDatabase: false
                });
                firstLease = first.leaseId;
                secondLease = second.leaseId;
                firstName = first.databaseName;
                secondName = second.databaseName;
                assert.notEqual(firstName, secondName);

                const firstConnection = await createSharedMySQLSessionPool(key, 'first-client', first.leaseId).getConnection();
                const secondConnection = await createSharedMySQLSessionPool(key, 'second-client', second.leaseId).getConnection();
                try {
                    await firstConnection.query('START TRANSACTION');
                    await secondConnection.query('START TRANSACTION');
                    await firstConnection.query('SELECT 1');
                    await secondConnection.query('SELECT 1');
                } finally {
                    await releaseQuietly(firstConnection);
                    await releaseQuietly(secondConnection);
                }

                const thirdPromise = ensureSharedMySQLSessionDatabase({
                    key,
                    prefix: 'tsf_session_pool',
                    keepDatabase: false
                });
                await assertPending(thirdPromise);

                await releaseSharedMySQLSessionDatabase(key, first.leaseId);
                firstLease = undefined;
                const third = await thirdPromise;
                thirdLease = third.leaseId;
                assert.equal(third.databaseName, firstName);
            } finally {
                if (thirdLease) await releaseSharedMySQLSessionDatabase(key, thirdLease).catch(() => {});
                if (secondLease) await releaseSharedMySQLSessionDatabase(key, secondLease).catch(() => {});
                if (firstLease) await releaseSharedMySQLSessionDatabase(key, firstLease).catch(() => {});
                await manager.stop();
            }

            assert.equal(await databaseExists(mysqlConfig, firstName), false);
            assert.equal(await databaseExists(mysqlConfig, secondName), false);
        }
    );

    it(
        'wires TestingFacade MySQL savepoint databases through the manager',
        {
            skip: mysqlConfig ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL shared session facade integration'
        },
        async () => {
            if (!mysqlConfig) return;
            const manager = await startManager(mysqlConfig, 'manager-facade');
            const prefix = 'tsf_session_facade';
            const originalDatabase = mysqlConfig.database;
            const DB = createDatabase('mysql', { database: originalDatabase, enableLocksTable: true, lockTableName: '_session_facade_locks' }, []);
            let migrationRuns = 0;
            let first: ReturnType<typeof TestingHelpers.createTestingFacadeWithDatabase> | undefined;
            let second: ReturnType<typeof TestingHelpers.createTestingFacadeWithDatabase> | undefined;
            let databaseName = '';

            const migrations = [
                defineMigration('001_session_facade_schema', async db => {
                    migrationRuns++;
                    assert.equal(await db.schema.hasTable('_session_facade_locks'), true);
                    assert.equal(await db.schema.hasTable('_jobs'), true);
                    await db.rawExecuteUnsafe(`
                        CREATE TABLE IF NOT EXISTS tsf_session_facade_rows (
                            id int NOT NULL AUTO_INCREMENT,
                            label varchar(64) NOT NULL,
                            PRIMARY KEY (id)
                        ) ENGINE=InnoDB
                    `);
                })
            ];

            const createFacade = () => {
                applyMySQLEnv(mysqlConfig);
                return TestingHelpers.createTestingFacadeWithDatabase(
                    {
                        db: DB,
                        enableWorker: true,
                        defaultConfig: { ENABLE_JOB_RUNNER: false },
                        providers: [
                            {
                                provide: DB,
                                useFactory: () => new DB()
                            }
                        ]
                    },
                    {
                        dbAdapter: 'mysql',
                        databasePrefix: prefix,
                        migrations,
                        autoSeedData: true,
                        seedData: async facade => {
                            const db = facade.get<BaseDatabase>(BaseDatabase);
                            await db.rawExecute(
                                sql`INSERT INTO ${sql.identifier('tsf_session_facade_rows')} (${sql.identifier('label')}) VALUES (${'seed'})`
                            );
                        }
                    }
                );
            };

            try {
                first = createFacade();
                second = createFacade();

                await first.start();
                databaseName = first.databaseName!;
                await first.resetToSeed();

                const firstDb = first.get<BaseDatabase>(BaseDatabase);
                assert.equal(await firstDb.schema.hasTable('_jobs'), true);
                assert.deepStrictEqual(await readLabels(firstDb, 'tsf_session_facade_rows'), ['seed']);
                await firstDb.rawExecute(
                    sql`INSERT INTO ${sql.identifier('tsf_session_facade_rows')} (${sql.identifier('label')}) VALUES (${'runtime'})`
                );
                assert.deepStrictEqual(await readLabels(firstDb, 'tsf_session_facade_rows'), ['seed', 'runtime']);
                await firstDb.transaction(async session => {
                    await session.acquireSessionLock(['session-facade', 1]);
                });
                await first.resetToSeed();
                assert.deepStrictEqual(await readLabels(firstDb, 'tsf_session_facade_rows'), ['seed']);
                await first.stop();
                first = undefined;

                await second.start();
                assert.equal(second.databaseName, databaseName);
                await second.resetToSeed();

                const secondDb = second.get<BaseDatabase>(BaseDatabase);
                assert.deepStrictEqual(second.migrationExecutions, []);
                assert.deepStrictEqual(await readMigrationNames(secondDb), ['001_session_facade_schema']);
                assert.deepStrictEqual(await readLabels(secondDb, 'tsf_session_facade_rows'), ['seed']);
                assert.equal(migrationRuns, 1);
            } finally {
                await second?.stop().catch(() => {});
                await first?.stop().catch(() => {});
                await manager.stop();
                applyMySQLEnv(mysqlConfig);
                await TestingHelpers.cleanupTestDatabases(prefix, 'mysql').catch(() => {});
            }

            assert.equal(await databaseExists(mysqlConfig, databaseName), false);
        }
    );
});

async function startManager(config: MySQLDatabaseConfig, testName: string, poolSize?: number): Promise<MySQLSessionManager> {
    process.env.APP_ENV = 'test';
    const token = `${testName}-${process.pid}-${Date.now()}`;
    const manager = new MySQLSessionManager({
        token,
        testRunTs: `${process.pid}_${Date.now()}`,
        poolSize,
        mysql: {
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password
        }
    });
    await manager.start();
    process.env.TSF_TEST_MYSQL_SESSION_MANAGER = '1';
    process.env.TSF_TEST_MYSQL_SESSION_MANAGER_PORT = String(manager.port);
    process.env.TSF_TEST_MYSQL_SESSION_MANAGER_TOKEN = token;
    return manager;
}

function assertConnectionLifecycleLogs(entries: LogEntry[], databaseName: string): void {
    assert.ok(databaseName);
    const backend = requireLog(entries, 'Shared MySQL backend connection opened', entry => entry.data?.databaseName === databaseName);
    assert.match(String(backend.data?.backendConnectionId), /^backend-\d+-\d+$/);

    const closed = requireLog(entries, 'Shared MySQL backend connection closed', entry => entry.data?.databaseName === databaseName);
    assert.match(String(closed.data?.backendConnectionId), /^backend-\d+-\d+$/);
}

function requireLog(entries: LogEntry[], message: string, predicate: (entry: LogEntry) => boolean): LogEntry {
    const entry = entries.find(candidate => candidate.message === message && predicate(candidate));
    if (!entry) throw new Error(`Missing log entry: ${message}`);
    return entry;
}

async function countRows(connection: MySQLConnectionLike, table: string): Promise<number> {
    const [rows] = await connection.query<Array<{ count: number }>>(`SELECT COUNT(*) AS count FROM \`${table.replace(/`/g, '``')}\``);
    return Number(rows[0]?.count ?? 0);
}

async function releaseQuietly(connection: MySQLConnectionLike | undefined): Promise<void> {
    if (!connection) return;
    await Promise.resolve(connection.release()).catch(() => {});
}

async function assertPending<T>(promise: Promise<T>): Promise<void> {
    const pending = Symbol('pending');
    const result = await Promise.race<unknown>([
        promise.then(
            value => ({ value }),
            error => ({ error })
        ),
        sleep(40).then(() => pending)
    ]);
    assert.equal(result, pending);
}

async function readLabels(db: BaseDatabase, table: string): Promise<string[]> {
    const rows = await db.rawFind<{ label: string }>(
        sql`SELECT ${sql.identifier('label')} FROM ${sql.identifier(table)} ORDER BY ${sql.identifier('id')}`
    );
    return rows.map(row => row.label);
}

async function readMigrationNames(db: BaseDatabase): Promise<string[]> {
    const rows = await db.rawFind<{ name: string }>(
        sql`SELECT ${sql.identifier('name')} FROM ${sql.identifier('_migrations')} ORDER BY ${sql.identifier('name')}`
    );
    return rows.map(row => row.name);
}

async function databaseExists(config: MySQLDatabaseConfig, databaseName: string): Promise<boolean> {
    if (!databaseName) return false;
    const admin = new BaseDatabase(
        new MySQLDriver({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: 'mysql',
            connectionLimit: 1
        })
    );
    try {
        const rows = await admin.rawFindUnsafe<{ name: string }>(
            'SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
            [databaseName]
        );
        return rows.length > 0;
    } finally {
        await admin.driver.close();
    }
}

function applyMySQLEnv(config: MySQLDatabaseConfig): void {
    process.env.APP_ENV = 'test';
    process.env.DB_ADAPTER = 'mysql';
    process.env.MYSQL_HOST = String(config.host ?? '');
    if (config.port !== undefined) process.env.MYSQL_PORT = String(config.port);
    process.env.MYSQL_USER = String(config.user ?? '');
    if (config.password !== undefined) process.env.MYSQL_PASSWORD_SECRET = String(config.password);
    process.env.MYSQL_DATABASE = String(config.database ?? '');
}

function readMySQLConfig(): MySQLDatabaseConfig | undefined {
    if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) return undefined;
    return {
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : undefined,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD_SECRET,
        database: process.env.MYSQL_DATABASE,
        connectionLimit: 2
    };
}
