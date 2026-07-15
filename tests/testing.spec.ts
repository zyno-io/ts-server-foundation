import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { entity, type OnUpdate, PrimaryKey } from '../src';
import { createTestDatabasePrefix, formatTestDatabaseName } from '../src/testing/database-name';

import {
    anyOf,
    type App,
    arrayContaining,
    assertCalledWith,
    AutoConstruct,
    BaseEntity,
    BaseDatabase,
    createDatabase,
    type DatabaseDriver,
    defineMigration,
    type DriverConnection,
    getCurrentApp,
    Env,
    type ExecuteResult,
    http,
    HttpBody,
    HttpHeader,
    type LogEntry,
    MySQLDriver,
    objectContaining,
    PostgresDriver,
    type QueryResult,
    resetLogSink,
    setLogSink,
    sql,
    stringContaining,
    TestingFacade,
    TestingHelpers,
    type MySQLDatabaseConfig,
    type PostgresDatabaseConfig
} from '../src';

const originalEnv = { ...process.env };

describe('TestingHelpers', () => {
    afterEach(() => {
        process.env = { ...originalEnv };
        resetLogSink();
        mock.restoreAll();
    });

    it('scopes generated test database prefixes to the worktree directory', () => {
        const first = createTestDatabasePrefix('app-test', '/tmp/worktrees/app-first');
        const repeated = createTestDatabasePrefix('app-test', '/tmp/worktrees/app-first');
        const second = createTestDatabasePrefix('app-test', '/tmp/worktrees/app-second');

        assert.match(first, /^app_test_[a-f0-9]{4}$/);
        assert.equal(repeated, first);
        assert.notEqual(second, first);
    });

    it('keeps generated test database names within identifier limits', () => {
        const prefix = createTestDatabasePrefix('tsf_session_reentrant');
        const name = formatTestDatabaseName('tsf_session_reentrant', [`${process.pid}_${Date.now()}`, process.pid, '013e23d56c', 1]);

        assert.equal(name.startsWith(`${prefix}_`), true);
        assert.equal(name.length <= 63, true);
    });

    it('creates a testing facade and sends mock requests', async () => {
        @http.controller('/testing')
        class TestingController {
            @http.POST()
            post(body: HttpBody<{ name: string }>, authorization: HttpHeader<string>) {
                return { name: body.name, authorization };
            }

            @http.DELETE()
            delete(body: HttpBody<{ lockKey: string }>, authorization: HttpHeader<string>) {
                return { lockKey: body.lockKey, authorization };
            }

            @http.GET()
            get(authorization: HttpHeader<string>) {
                return { authorization };
            }
        }

        process.env.APP_ENV = 'test';
        const tf = TestingHelpers.createTestingFacade(
            { controllers: [TestingController] },
            { defaultTestHeaders: { authorization: 'Bearer default' } }
        );
        await tf.start();

        const defaultHeaderResponse = await TestingHelpers.makeMockRequest(tf, 'POST', '/testing', {
            name: 'Alpha'
        });
        const customHeaderResponse = await TestingHelpers.makeMockRequest(
            tf,
            'POST',
            '/testing',
            { authorization: 'Bearer custom' },
            { name: 'Beta' }
        );
        const getHeaderResponse = await TestingHelpers.makeMockRequest(tf, 'GET', '/testing', {
            authorization: 'Bearer get'
        });
        const deleteBodyResponse = await TestingHelpers.makeMockRequest(
            tf,
            'DELETE',
            '/testing',
            { authorization: 'Bearer delete' },
            { lockKey: 'lock-1' }
        );
        const deleteBodyShorthandResponse = await TestingHelpers.makeMockRequest(tf, 'DELETE', '/testing', { lockKey: 'lock-2' });

        assert.deepStrictEqual(defaultHeaderResponse.json, {
            name: 'Alpha',
            authorization: 'Bearer default'
        });
        assert.deepStrictEqual(customHeaderResponse.json, {
            name: 'Beta',
            authorization: 'Bearer custom'
        });
        assert.deepStrictEqual(getHeaderResponse.json, { authorization: 'Bearer get' });
        assert.deepStrictEqual(deleteBodyResponse.json, {
            lockKey: 'lock-1',
            authorization: 'Bearer delete'
        });
        assert.deepStrictEqual(deleteBodyShorthandResponse.json, {
            lockKey: 'lock-2',
            authorization: 'Bearer default'
        });

        await tf.stop();
    });

    it('creates an additive testing facade factory from defaults', async () => {
        @http.controller('/builder-default')
        class BuilderDefaultController {
            @http.GET()
            get() {
                return { route: 'default' };
            }
        }

        @http.controller('/builder-added')
        class BuilderAddedController {
            @http.GET()
            get() {
                return { route: 'added' };
            }
        }

        process.env.APP_ENV = 'test';
        const seedOrder: string[] = [];
        const createFacade = TestingHelpers.createTestingFacadeBuilder(
            {
                controllers: [BuilderDefaultController]
            },
            {
                autoSeedData: true,
                defaultTestHeaders: { authorization: 'Bearer default' },
                seedData: () => {
                    seedOrder.push('default');
                }
            }
        );
        const tf = createFacade(
            {
                controllers: [BuilderAddedController]
            },
            {
                defaultTestHeaders: { 'x-test': 'added' },
                seedData: () => {
                    seedOrder.push('added');
                }
            }
        );

        try {
            await tf.start();

            assert.deepStrictEqual(tf.options.defaultTestHeaders, {
                authorization: 'Bearer default',
                'x-test': 'added'
            });
            assert.deepStrictEqual(seedOrder, ['default', 'added']);
            assert.deepStrictEqual((await TestingHelpers.makeMockRequest(tf, 'GET', '/builder-default')).json, { route: 'default' });
            assert.deepStrictEqual((await TestingHelpers.makeMockRequest(tf, 'GET', '/builder-added')).json, { route: 'added' });
        } finally {
            await tf.stop();
        }
    });

    it('creates a testing facade factory from resolver functions', async () => {
        class RemovedProvider {}
        class KeptProvider {}

        @http.controller('/builder-resolver')
        class BuilderResolverController {
            @http.GET()
            get() {
                return { route: 'resolver' };
            }
        }

        process.env.APP_ENV = 'test';
        const createFacade = TestingHelpers.createTestingFacadeBuilder(
            c => ({
                ...c,
                providers: c.providers.filter(p => p !== RemovedProvider)
            }),
            o => ({
                enableDatabase: false,
                databasePrefix: 'resolver_test',
                ...o
            })
        );
        const tf = createFacade(
            {
                controllers: [BuilderResolverController],
                providers: [RemovedProvider, KeptProvider]
            },
            {
                databasePrefix: 'custom_resolver_test'
            }
        );

        try {
            await tf.start();

            assert.deepStrictEqual(tf.app.options.providers, [KeptProvider]);
            assert.equal(tf.options.enableDatabase, false);
            assert.equal(tf.options.databasePrefix, 'custom_resolver_test');
            assert.deepStrictEqual((await TestingHelpers.makeMockRequest(tf, 'GET', '/builder-resolver')).json, { route: 'resolver' });
        } finally {
            await tf.stop();
        }
    });

    it('creates a database-safe unit facade with provider exclusions and overrides', async () => {
        let acquireCalls = 0;
        let closeCalls = 0;
        let excludedConstructions = 0;
        let observedDependency = '';

        class UnitDriver implements DatabaseDriver {
            readonly dialect = 'mysql' as const;

            async connect(): Promise<void> {}

            async close(): Promise<void> {
                closeCalls++;
            }

            async acquire(): Promise<DriverConnection> {
                acquireCalls++;
                throw new Error('unguarded database access');
            }
        }

        const driver = new UnitDriver();
        class UnitDatabase extends BaseDatabase {
            constructor() {
                super(driver);
            }
        }

        class ExternalDependency {
            readonly name: string = 'production';
        }

        @AutoConstruct()
        class ExcludedProvider {
            constructor() {
                excludedConstructions++;
            }
        }

        @AutoConstruct()
        class UnitConsumer {
            constructor(dependency: ExternalDependency) {
                observedDependency = dependency.name;
            }
        }

        @entity.name('unit_testing_users')
        class UnitTestingUser extends BaseEntity {
            id!: string & PrimaryKey;
            name!: string;
        }

        const testDependency = { name: 'test' } as ExternalDependency;
        const tf = TestingHelpers.createUnitTestingFacade(
            {
                db: UnitDatabase,
                enableHealthcheck: false,
                providers: [ExternalDependency, ExcludedProvider, UnitConsumer]
            },
            {
                excludeProviders: [ExcludedProvider],
                providerOverrides: [{ provide: ExternalDependency, useValue: testDependency }]
            }
        );

        await tf.start();
        try {
            assert.equal(excludedConstructions, 0);
            assert.equal(observedDependency, 'test');
            assert.equal(tf.get(ExternalDependency), testDependency);

            tf.sql.mockEntity(UnitTestingUser, { id: '1', name: 'Mocked' });
            assert.deepStrictEqual(await tf.get<UnitDatabase>(UnitDatabase).query(UnitTestingUser).find(), [
                Object.assign(new UnitTestingUser(), { id: '1', name: 'Mocked' })
            ]);

            await assert.rejects(() => tf.get<UnitDatabase>(UnitDatabase).rawFindUnsafe('SELECT 1'), /Database is not enabled in testing mode/);
            assert.equal(acquireCalls, 0);
        } finally {
            await tf.stop();
        }

        assert.equal(closeCalls, 1);
        await assert.rejects(() => driver.acquire(), /unguarded database access/);
        assert.equal(acquireCalls, 1);
    });

    it('keeps the database guard active through unit facade shutdown', async () => {
        let acquireCalls = 0;
        let closeCalls = 0;

        class CleanupDriver implements DatabaseDriver {
            readonly dialect = 'mysql' as const;

            async connect(): Promise<void> {}
            async close(): Promise<void> {
                closeCalls++;
            }
            async acquire(): Promise<DriverConnection> {
                acquireCalls++;
                throw new Error('unguarded database access');
            }
        }

        const driver = new CleanupDriver();
        class CleanupDatabase extends BaseDatabase {
            constructor() {
                super(driver);
            }
        }

        const tf = TestingHelpers.createUnitTestingFacade(
            {
                db: CleanupDatabase,
                enableHealthcheck: false
            },
            {
                onStart: facade => {
                    facade.app.registerCleanup(async () => {
                        await facade.get<CleanupDatabase>(CleanupDatabase).rawExecuteUnsafe('DELETE FROM cleanup');
                    });
                }
            }
        );

        await tf.start();
        await assert.rejects(() => tf.stop(), /Database is not enabled in testing mode/);

        assert.equal(acquireCalls, 0);
        assert.equal(closeCalls, 1);
        await assert.rejects(() => driver.acquire(), /unguarded database access/);
        assert.equal(acquireCalls, 1);
    });

    describe('database-disabled standard hooks', () => {
        let acquireCalls = 0;

        class StandardHookDriver implements DatabaseDriver {
            readonly dialect = 'postgres' as const;

            async connect(): Promise<void> {}
            async close(): Promise<void> {}
            async acquire(): Promise<DriverConnection> {
                acquireCalls++;
                throw new Error('unguarded database access');
            }
        }

        const driver = new StandardHookDriver();
        class StandardHookDatabase extends BaseDatabase {
            constructor() {
                super(driver);
            }
        }

        const tf = TestingHelpers.createTestingFacade({
            db: StandardHookDatabase,
            enableHealthcheck: false
        });
        TestingHelpers.installStandardHooks(tf);

        it('rejects connection attempts before they reach the configured driver', async () => {
            await assert.rejects(
                () => tf.get<StandardHookDatabase>(StandardHookDatabase).rawFindUnsafe('SELECT 1'),
                /Database is not enabled in testing mode/
            );
            assert.equal(acquireCalls, 0);
        });
    });

    it('logs test facade startup before lifecycle work', async () => {
        const entries: LogEntry[] = [];
        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));

        const tf = TestingHelpers.createTestingFacade({});
        await tf.start();
        await tf.stop();

        assert.equal(entries[0].scope, 'TestingFacade');
        assert.equal(entries[0].message, 'Starting test facade');
        assert.deepStrictEqual(entries[0].data, {
            enableDatabase: false,
            dbAdapter: undefined,
            migrations: false,
            useSavepoints: false
        });
    });

    it('runs facade lifecycle and seed hooks', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];
        const tf = TestingHelpers.createTestingFacade(
            {},
            {
                autoSeedData: true,
                onBeforeStart: () => {
                    order.push('before-start');
                },
                onStart: () => {
                    order.push('start');
                },
                seedData: () => {
                    order.push('seed');
                },
                onBeforeStop: () => {
                    order.push('before-stop');
                },
                onStop: () => {
                    order.push('stop');
                }
            }
        );

        await tf.start();
        await tf.resetToSeed();
        await tf.stop();

        assert.deepStrictEqual(order, ['before-start', 'start', 'seed', 'seed', 'before-stop', 'stop']);
    });

    it('rebinds the current app before facade lifecycle hooks', async () => {
        process.env.APP_ENV = 'test';
        let sawOwnApp = false;
        const first = TestingHelpers.createTestingFacade(
            {},
            {
                onBeforeStart: facade => {
                    sawOwnApp = getCurrentApp() === facade.app;
                }
            }
        );
        TestingHelpers.createTestingFacade({});

        await first.start();
        await first.stop();

        assert.equal(sawOwnApp, true);
    });

    describe('standard hooks suite seed data', () => {
        const order: string[] = [];
        const tf = TestingHelpers.createTestingFacade(
            {},
            {
                onBeforeStart: () => {
                    order.push('start');
                },
                onBeforeStop: () => {
                    order.push('stop');
                }
            }
        );
        let seedRuns = 0;

        TestingHelpers.installStandardHooks(tf, {
            suiteSeedData: () => {
                order.push(`suite-seed:${++seedRuns}`);
            }
        });

        it('runs suite seed data before the first test', () => {
            assert.deepStrictEqual(order, ['start', 'suite-seed:1']);
            order.push('test:1');
        });

        it('reruns suite seed data after each reset when savepoints are not active', () => {
            assert.deepStrictEqual(order, ['start', 'suite-seed:1', 'test:1', 'suite-seed:2']);
        });
    });

    it('creates and resets named seed savepoints with an active savepoint facade', async () => {
        class SavepointDatabase {}

        const commands: string[] = [];
        const connection: DriverConnection = {
            async query<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
                commands.push('query');
                return { rows: [] };
            },
            async execute(): Promise<ExecuteResult> {
                commands.push('execute');
                return { affectedRows: 0 };
            },
            async begin(): Promise<void> {
                commands.push('begin');
            },
            async commit(): Promise<void> {
                commands.push('commit');
            },
            async rollback(): Promise<void> {
                commands.push('rollback');
            },
            async savepoint(name: string): Promise<void> {
                commands.push(`savepoint:${name}`);
            },
            async rollbackToSavepoint(name: string): Promise<void> {
                commands.push(`rollbackToSavepoint:${name}`);
            },
            async release(): Promise<void> {
                commands.push('release');
            }
        };
        const driver: DatabaseDriver = {
            dialect: 'postgres',
            async connect(): Promise<void> {},
            async close(): Promise<void> {
                commands.push('close');
            },
            async acquire(): Promise<DriverConnection> {
                commands.push('acquire');
                return connection;
            }
        };
        const db = { driver } as BaseDatabase;
        const app = {
            config: { DB_ADAPTER: 'postgres' },
            options: { db: SavepointDatabase },
            get: (token: unknown) => {
                if (token === SavepointDatabase || token === BaseDatabase) return db;
                throw new Error('Unexpected token');
            },
            start: async () => {
                commands.push('app:start');
            },
            stop: async () => {
                commands.push('app:stop');
            }
        } as unknown as App;
        const tf = new TestingFacade(app, {
            enableDatabase: true,
            dbAdapter: 'postgres',
            useSavepoints: true,
            seedData: () => {
                commands.push('seed');
            }
        });

        const created = await tf.createSeedSavepoint('after_suite_seed', () => {
            commands.push('suite-seed');
        });
        const reset = await tf.resetToSeedSavepoint('after_suite_seed');
        await tf.stop();

        assert.equal(created, true);
        assert.equal(reset, true);
        assert.deepStrictEqual(commands, [
            'acquire',
            'begin',
            'seed',
            'savepoint:after_seed',
            'suite-seed',
            'savepoint:after_suite_seed',
            'rollbackToSavepoint:after_suite_seed',
            'rollback',
            'release',
            'app:stop',
            'close'
        ]);
    });

    it('supports asymmetric testing matchers', () => {
        const fn = mock.fn();
        fn({ id: 1, name: 'Alice', tags: ['admin', 'owner'] }, 'created');

        assertCalledWith(
            fn,
            objectContaining({
                id: anyOf(Number),
                tags: arrayContaining([stringContaining('adm')])
            }),
            'created'
        );
    });

    it('mocks entity queries without enabling a database', async () => {
        @entity.name('testing_sql_users')
        class TestingSqlUser extends BaseEntity {
            id!: string & PrimaryKey;
            tenantId!: string;
            name!: string;
            visits!: number;
            deletedAt!: Date | null;
        }

        const tf = TestingHelpers.createTestingFacade({});
        tf.sql.mockEntity(TestingSqlUser, { id: '2', tenantId: 't1', name: 'Beta', visits: 2 });
        tf.sql.mockEntity(TestingSqlUser, [
            { id: '1', tenantId: 't1', name: 'Alpha', visits: 1, deletedAt: null },
            { id: '3', tenantId: 't2', name: 'Gamma', visits: 3, deletedAt: null }
        ]);

        assert.deepStrictEqual(await TestingSqlUser.query().filter({ tenantId: 't1', deletedAt: null }).orderBy('name').findField('name'), [
            'Alpha',
            'Beta'
        ]);
        assert.equal(
            await TestingSqlUser.query()
                .filter({ tenantId: 't1', visits: { $gte: 2 } })
                .has(),
            true
        );
        assert.equal(
            await TestingSqlUser.query()
                .filter({ id: { $in: ['2', '3'] } })
                .count(),
            2
        );

        const patchResult = await TestingSqlUser.query()
            .filterField('id', '1')
            .patchOne({ name: 'Updated', $inc: { visits: 4 } });
        assert.deepStrictEqual(patchResult.primaryKeys, [{ id: '1' }]);

        const selected = await TestingSqlUser.query().filterField('id', '1').select('name', 'visits').findOne();
        assert.equal(selected.name, 'Updated');
        assert.equal(selected.visits, 5);
        assert.equal(selected.id, undefined);

        await assert.rejects(
            () => TestingSqlUser.query().filter({ tenantId: 't1' }).deleteOne(),
            /deleteOne requires an exact filter for primary key TestingSqlUser\.id/
        );
        const deleteResult = await TestingSqlUser.query().filterField('id', '2').deleteOne();
        assert.deepStrictEqual(deleteResult.primaryKeys, [{ id: '2' }]);
        assert.equal(await TestingSqlUser.query().filterField('id', '2').has(), false);

        tf.sql.clearMocks();

        await assert.rejects(() => TestingSqlUser.query().find(), /SQL test mocks are not configured for this entity/);
    });

    it('converts string fixture dates for intersection date marker fields', () => {
        @entity.name('testing_fixture_dates')
        class TestingFixtureDateEntity extends BaseEntity {
            id!: string & PrimaryKey;
            updatedAt!: Date & OnUpdate<'CURRENT_TIMESTAMP'>;
            deletedAt!: Date | null;
        }

        const prepared = TestingHelpers.prepareEntityFixtures(TestingFixtureDateEntity, {
            id: 'fixture-1',
            updatedAt: '2024-01-01T00:00:00.000Z',
            deletedAt: '2024-01-02T00:00:00.000Z'
        });

        assert.equal(prepared.updatedAt instanceof Date, true);
        assert.equal(prepared.deletedAt instanceof Date, true);
    });

    it('preserves database env for non-database facades', async () => {
        Env.APP_ENV = 'test';
        Env.DB_ADAPTER = 'mysql';
        Env.MYSQL_DATABASE = 'plain_facade_original';

        const tf = TestingHelpers.createTestingFacade({});

        assert.equal(Env.DB_ADAPTER, 'mysql');
        assert.equal(Env.MYSQL_DATABASE, 'plain_facade_original');

        await tf.start();
        await tf.stop();

        assert.equal(Env.DB_ADAPTER, 'mysql');
        assert.equal(Env.MYSQL_DATABASE, 'plain_facade_original');
    });

    it('disables savepoints globally when savepoints are not allowed even if a facade opts in', () => {
        Env.TSF_TEST_ALLOW_SAVEPOINTS = '0';

        const tf = TestingHelpers.createTestingFacade({}, { useSavepoints: true });

        assert.equal((tf as unknown as { shouldUseSavepoints: boolean }).shouldUseSavepoints, false);
    });

    it(
        'creates, resets, and drops an isolated MySQL test database',
        {
            skip: readMySQLConfig() ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL testing facade integration'
        },
        async () => {
            const config = readMySQLConfig();
            if (!config) return;
            await runDatabaseFacadeFlow('mysql', config);
        }
    );

    it(
        'creates, resets, and drops an isolated PostgreSQL test database',
        {
            skip: readPostgresConfig() ? false : 'set PG_HOST, PG_USER, and PG_DATABASE to run PostgreSQL testing facade integration'
        },
        async () => {
            const config = readPostgresConfig();
            if (!config) return;
            await runDatabaseFacadeFlow('postgres', config);
        }
    );

    it(
        'cleans up an isolated MySQL database when stop hooks fail',
        {
            skip: readMySQLConfig() ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL testing facade failure cleanup integration'
        },
        async () => {
            const config = readMySQLConfig();
            if (!config) return;
            await runStopFailureCleanupFlow('mysql', config);
        }
    );

    it(
        'cleans up an isolated PostgreSQL database when startup seed fails',
        {
            skip: readPostgresConfig() ? false : 'set PG_HOST, PG_USER, and PG_DATABASE to run PostgreSQL testing facade failure cleanup integration'
        },
        async () => {
            const config = readPostgresConfig();
            if (!config) return;
            await runStartFailureCleanupFlow('postgres', config);
        }
    );

    it(
        'reuses a savepoint MySQL test database across facades in one process',
        {
            skip: readMySQLConfig() ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL shared savepoint database integration'
        },
        async () => {
            const config = readMySQLConfig();
            if (!config) return;
            await runSharedSavepointDatabaseFlow('mysql', config);
        }
    );

    it(
        'reuses a savepoint PostgreSQL test database across facades in one process',
        {
            skip: readPostgresConfig() ? false : 'set PG_HOST, PG_USER, and PG_DATABASE to run PostgreSQL shared savepoint database integration'
        },
        async () => {
            const config = readPostgresConfig();
            if (!config) return;
            await runSharedSavepointDatabaseFlow('postgres', config);
        }
    );
});

type TestAdapter = 'mysql' | 'postgres';

async function runDatabaseFacadeFlow(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig): Promise<void> {
    process.env.APP_ENV = 'test';
    process.env.TSF_TEST_DATABASE_NAME = 'original_override';
    applyDatabaseEnv(adapter, config);
    const originalDatabase = adapter === 'postgres' ? process.env.PG_DATABASE : process.env.MYSQL_DATABASE;
    const DB =
        adapter === 'postgres'
            ? createDatabase('postgres', { database: originalDatabase }, [])
            : createDatabase('mysql', { database: originalDatabase }, []);
    const tf = TestingHelpers.createTestingFacadeWithDatabase(
        { db: DB },
        {
            dbAdapter: adapter,
            databasePrefix: `tsf_testing_${adapter}`,
            useSavepoints: false,
            migrations: [
                defineMigration('001_testing_schema', async db => {
                    await createTestingSchema(db, adapter);
                }),
                defineMigration('002_testing_seed_from_migration', async db => {
                    await db.rawExecute(sql`INSERT INTO ${sql.identifier('tsf_testing_users')} (${sql.identifier('name')}) VALUES (${'migration'})`);
                })
            ],
            autoSeedData: true,
            seedData: async facade => {
                const db = facade.get<BaseDatabase>(BaseDatabase);
                await createTestingSchema(db, adapter);
                await db.rawExecute(sql`INSERT INTO ${sql.identifier('tsf_testing_users')} (${sql.identifier('name')}) VALUES (${'seed'})`);
                await db.rawExecute(
                    sql`INSERT INTO ${sql.identifier('tsf_testing_posts')} (${sql.identifier('userId')}, ${sql.identifier('title')}) VALUES (${1}, ${'seed-post'})`
                );
            }
        }
    );

    let databaseName = '';
    try {
        await tf.start();
        databaseName = tf.databaseName!;
        assert.match(databaseName, new RegExp(`^tsf_testing_${adapter}_`));
        assert.equal(adapter === 'mysql' ? tf.app.config.MYSQL_DATABASE : tf.app.config.PG_DATABASE, databaseName);
        assert.equal(process.env.TSF_TEST_DATABASE_NAME, databaseName);

        const db = tf.get<BaseDatabase>(BaseDatabase);
        assert.deepStrictEqual(
            tf.migrationExecutions.map(execution => execution.name),
            ['001_testing_schema', '002_testing_seed_from_migration']
        );
        assert.deepStrictEqual(await readMigrationNames(db), ['001_testing_schema', '002_testing_seed_from_migration']);
        assert.deepStrictEqual(await readTestingNames(db), ['seed']);
        await db.rawExecute(sql`INSERT INTO ${sql.identifier('tsf_testing_users')} (${sql.identifier('name')}) VALUES (${'runtime'})`);
        await db.rawExecute(
            sql`INSERT INTO ${sql.identifier('tsf_testing_posts')} (${sql.identifier('userId')}, ${sql.identifier('title')}) VALUES (${2}, ${'runtime-post'})`
        );
        assert.deepStrictEqual(await readTestingNames(db), ['seed', 'runtime']);

        await tf.resetToSeed();
        assert.deepStrictEqual(await readMigrationNames(db), ['001_testing_schema', '002_testing_seed_from_migration']);
        assert.deepStrictEqual(await readTestingNames(db), ['seed']);
        assert.deepStrictEqual(await readTestingPostTitles(db), ['seed-post']);
    } finally {
        await tf.stop();
    }

    assert.equal(process.env.DB_ADAPTER, adapter);
    assert.equal(process.env.TSF_TEST_DATABASE_NAME, 'original_override');
    assert.equal(adapter === 'mysql' ? process.env.MYSQL_DATABASE : process.env.PG_DATABASE, originalDatabase);
    assert.equal(tf.app.config.DB_ADAPTER, adapter);
    assert.equal(adapter === 'mysql' ? tf.app.config.MYSQL_DATABASE : tf.app.config.PG_DATABASE, originalDatabase);
    assert.equal(await databaseExists(adapter, config, databaseName), false);
}

async function runStopFailureCleanupFlow(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig): Promise<void> {
    process.env.APP_ENV = 'test';
    process.env.TSF_TEST_DATABASE_NAME = 'original_override';
    applyDatabaseEnv(adapter, config);
    const originalDatabase = adapter === 'postgres' ? process.env.PG_DATABASE : process.env.MYSQL_DATABASE;
    let onStopCalled = false;
    const DB = adapter === 'postgres' ? createDatabase('postgres', {}, []) : createDatabase('mysql', {}, []);
    const tf = TestingHelpers.createTestingFacadeWithDatabase(
        { db: DB },
        {
            dbAdapter: adapter,
            databasePrefix: `tsf_testing_stop_${adapter}`,
            useSavepoints: false,
            onBeforeStop: () => {
                throw new Error('before stop failed');
            },
            onStop: () => {
                onStopCalled = true;
            }
        }
    );

    await tf.start();
    const databaseName = tf.databaseName!;
    await assert.rejects(() => tf.stop(), /before stop failed/);

    assert.equal(onStopCalled, true);
    assert.equal(process.env.TSF_TEST_DATABASE_NAME, 'original_override');
    assert.equal(adapter === 'mysql' ? process.env.MYSQL_DATABASE : process.env.PG_DATABASE, originalDatabase);
    assert.equal(await databaseExists(adapter, config, databaseName), false);
}

async function runStartFailureCleanupFlow(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig): Promise<void> {
    process.env.APP_ENV = 'test';
    process.env.TSF_TEST_DATABASE_NAME = 'original_override';
    applyDatabaseEnv(adapter, config);
    const originalDatabase = adapter === 'postgres' ? process.env.PG_DATABASE : process.env.MYSQL_DATABASE;
    const DB = adapter === 'postgres' ? createDatabase('postgres', {}, []) : createDatabase('mysql', {}, []);
    const tf = TestingHelpers.createTestingFacadeWithDatabase(
        { db: DB },
        {
            dbAdapter: adapter,
            databasePrefix: `tsf_testing_start_${adapter}`,
            useSavepoints: false,
            autoSeedData: true,
            seedData: () => {
                throw new Error('seed failed');
            }
        }
    );

    await assert.rejects(() => tf.start(), /seed failed/);
    const databaseName = tf.databaseName!;

    assert.equal(process.env.TSF_TEST_DATABASE_NAME, 'original_override');
    assert.equal(adapter === 'mysql' ? process.env.MYSQL_DATABASE : process.env.PG_DATABASE, originalDatabase);
    assert.equal(await databaseExists(adapter, config, databaseName), false);
}

async function runSharedSavepointDatabaseFlow(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig): Promise<void> {
    process.env.APP_ENV = 'test';
    process.env.TSF_TEST_DATABASE_NAME = 'original_override';
    applyDatabaseEnv(adapter, config);
    const originalDatabase = adapter === 'postgres' ? process.env.PG_DATABASE : process.env.MYSQL_DATABASE;
    const prefix = `tsf_testing_shared_${adapter}`;
    await TestingHelpers.cleanupTestDatabases(prefix, adapter);

    const DB =
        adapter === 'postgres'
            ? createDatabase('postgres', { database: originalDatabase }, [])
            : createDatabase('mysql', { database: originalDatabase }, []);
    let migrationRuns = 0;
    const migrations = [
        defineMigration('001_testing_shared_schema', async db => {
            migrationRuns++;
            await createTestingSchema(db, adapter);
        })
    ];
    const createFacade = () =>
        TestingHelpers.createTestingFacadeWithDatabase(
            { db: DB },
            {
                dbAdapter: adapter,
                databasePrefix: prefix,
                migrations,
                autoSeedData: true,
                seedData: async facade => {
                    const db = facade.get<BaseDatabase>(BaseDatabase);
                    await db.rawExecute(sql`INSERT INTO ${sql.identifier('tsf_testing_users')} (${sql.identifier('name')}) VALUES (${'seed'})`);
                }
            }
        );

    const first = createFacade();
    const second = createFacade();
    let databaseName = '';
    try {
        await first.start();
        databaseName = first.databaseName!;
        await first.resetToSeed();

        const firstDb = first.get<BaseDatabase>(BaseDatabase);
        assert.deepStrictEqual(
            first.migrationExecutions.map(execution => execution.name),
            ['001_testing_shared_schema']
        );
        assert.deepStrictEqual(await readTestingNames(firstDb), ['seed']);
        await firstDb.rawExecute(sql`INSERT INTO ${sql.identifier('tsf_testing_users')} (${sql.identifier('name')}) VALUES (${'runtime'})`);
        assert.deepStrictEqual(await readTestingNames(firstDb), ['seed', 'runtime']);
        await first.resetToSeed();
        assert.deepStrictEqual(await readTestingNames(firstDb), ['seed']);
        await first.stop();

        assert.equal(await databaseExists(adapter, config, databaseName), true);

        await second.start();
        assert.equal(second.databaseName, databaseName);
        await second.resetToSeed();

        const secondDb = second.get<BaseDatabase>(BaseDatabase);
        assert.deepStrictEqual(second.migrationExecutions, []);
        assert.deepStrictEqual(await readMigrationNames(secondDb), ['001_testing_shared_schema']);
        assert.deepStrictEqual(await readTestingNames(secondDb), ['seed']);
        assert.equal(migrationRuns, 1);
    } finally {
        await first.stop().catch(() => {});
        await second.stop().catch(() => {});
        await TestingHelpers.cleanupTestDatabases(prefix, adapter);
    }

    assert.equal(process.env.TSF_TEST_DATABASE_NAME, 'original_override');
    assert.equal(adapter === 'mysql' ? process.env.MYSQL_DATABASE : process.env.PG_DATABASE, originalDatabase);
    assert.equal(await databaseExists(adapter, config, databaseName), false);
}

async function createTestingSchema(db: BaseDatabase, adapter: TestAdapter): Promise<void> {
    if (adapter === 'postgres') {
        await db.rawExecuteUnsafe(`
            CREATE TABLE IF NOT EXISTS "tsf_testing_users" (
                "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                "name" varchar(255) NOT NULL
            )
        `);
        await db.rawExecuteUnsafe(`
            CREATE TABLE IF NOT EXISTS "tsf_testing_posts" (
                "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                "userId" integer NOT NULL REFERENCES "tsf_testing_users" ("id") ON DELETE CASCADE,
                "title" varchar(255) NOT NULL
            )
        `);
        return;
    }

    await db.rawExecuteUnsafe(`
        CREATE TABLE IF NOT EXISTS \`tsf_testing_users\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`name\` varchar(255) NOT NULL,
            PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE IF NOT EXISTS \`tsf_testing_posts\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`userId\` int NOT NULL,
            \`title\` varchar(255) NOT NULL,
            PRIMARY KEY (\`id\`),
            CONSTRAINT \`tsf_testing_posts_fk_user\` FOREIGN KEY (\`userId\`) REFERENCES \`tsf_testing_users\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
}

async function readTestingNames(db: BaseDatabase): Promise<string[]> {
    const rows = await db.rawFind<{ name: string }>(
        sql`SELECT ${sql.identifier('name')} FROM ${sql.identifier('tsf_testing_users')} ORDER BY ${sql.identifier('id')}`
    );
    return rows.map(row => row.name);
}

async function readTestingPostTitles(db: BaseDatabase): Promise<string[]> {
    const rows = await db.rawFind<{ title: string }>(
        sql`SELECT ${sql.identifier('title')} FROM ${sql.identifier('tsf_testing_posts')} ORDER BY ${sql.identifier('id')}`
    );
    return rows.map(row => row.title);
}

async function readMigrationNames(db: BaseDatabase): Promise<string[]> {
    const rows = await db.rawFind<{ name: string }>(
        sql`SELECT ${sql.identifier('name')} FROM ${sql.identifier('_migrations')} ORDER BY ${sql.identifier('name')}`
    );
    return rows.map(row => row.name);
}

async function databaseExists(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig, databaseName: string): Promise<boolean> {
    const admin = createAdminDatabase(adapter, config);
    try {
        const rows =
            adapter === 'postgres'
                ? await admin.rawFindUnsafe('SELECT datname AS name FROM pg_database WHERE datname = ?', [databaseName])
                : await admin.rawFindUnsafe('SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [databaseName]);
        return rows.length > 0;
    } finally {
        await admin.driver.close();
    }
}

function createAdminDatabase(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig): BaseDatabase {
    if (adapter === 'postgres') {
        const pgConfig = config as PostgresDatabaseConfig;
        return new BaseDatabase(
            new PostgresDriver({
                host: pgConfig.host,
                port: pgConfig.port,
                user: pgConfig.user,
                password: pgConfig.password,
                database: 'postgres',
                ssl: pgConfig.ssl,
                max: 1
            })
        );
    }

    const mysqlConfig = config as MySQLDatabaseConfig;
    return new BaseDatabase(
        new MySQLDriver({
            host: mysqlConfig.host,
            port: mysqlConfig.port,
            user: mysqlConfig.user,
            password: mysqlConfig.password,
            database: 'mysql',
            connectionLimit: 1
        })
    );
}

function applyDatabaseEnv(adapter: TestAdapter, config: MySQLDatabaseConfig | PostgresDatabaseConfig): void {
    process.env.DB_ADAPTER = adapter;
    if (adapter === 'postgres') {
        const pgConfig = config as PostgresDatabaseConfig;
        process.env.PG_HOST = String(pgConfig.host ?? '');
        if (pgConfig.port !== undefined) process.env.PG_PORT = String(pgConfig.port);
        process.env.PG_USER = String(pgConfig.user ?? '');
        if (pgConfig.password !== undefined) process.env.PG_PASSWORD_SECRET = String(pgConfig.password);
        process.env.PG_DATABASE = String(pgConfig.database ?? '');
        return;
    }

    const mysqlConfig = config as MySQLDatabaseConfig;
    process.env.MYSQL_HOST = String(mysqlConfig.host ?? '');
    if (mysqlConfig.port !== undefined) process.env.MYSQL_PORT = String(mysqlConfig.port);
    process.env.MYSQL_USER = String(mysqlConfig.user ?? '');
    if (mysqlConfig.password !== undefined) process.env.MYSQL_PASSWORD_SECRET = String(mysqlConfig.password);
    process.env.MYSQL_DATABASE = String(mysqlConfig.database ?? '');
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

function readPostgresConfig(): PostgresDatabaseConfig | undefined {
    if (!process.env.PG_HOST || !process.env.PG_USER || !process.env.PG_DATABASE) return undefined;
    return {
        host: process.env.PG_HOST,
        port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD_SECRET,
        database: process.env.PG_DATABASE,
        max: 2,
        ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined
    };
}
