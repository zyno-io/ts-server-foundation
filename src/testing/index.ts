import { after, afterEach, before, beforeEach, mock } from 'node:test';
import { resolve } from 'node:path';

import { App, BaseAppConfig, createApp, setCurrentApp, type CreateAppOptions } from '../app';
import {
    BaseDatabase,
    completeSharedMySQLSessionSchema,
    createDatabase,
    createMigrationPlan,
    type CreateMigrationPlanOptions,
    ensureSharedMySQLSessionDatabase,
    ensureMySQLLocksTable,
    getSharedMySQLSessionManagerConfig,
    loadMigrationsFromDirectory,
    MigrationRunner,
    MySQLDriver,
    prepareSharedMySQLSessionSchema,
    PostgresDriver,
    releaseSharedMySQLSessionDatabase,
    type DatabaseDialect,
    type DriverConnection,
    type Migration,
    type MigrationExecution
} from '../database';
import { Env } from '../env';
import { HttpRequest, MemoryHttpResponse } from '../http';
import { sql } from '../database/sql';
import { createLogger } from '../services/logger';
import { JobEntity } from '../services/worker/entity';
import { waitForTestDatabaseReady } from './database-readiness';
import { defineEntityFixtures, loadEntityFixtures, prepareEntityFixtures } from './fixtures';
import { SqlTestingHelper } from './sql';

export * from './expect';
export * from './fixtures';
export * from './sql';

export type TestDbAdapter = DatabaseDialect;
type NoInferConfig<C> = [C][C extends unknown ? 0 : never];
export type TestingFacadeSeedData<C extends BaseAppConfig = any> = (facade: TestingFacade<C>) => Promise<void> | void;

export interface TestingFacadeOptions<C extends BaseAppConfig = any> {
    defaultTestHeaders?: Record<string, string>;
    seedData?: TestingFacadeSeedData<C>;
    autoSeedData?: boolean;
    onBeforeStart?: (facade: TestingFacade<C>) => Promise<void> | void;
    onStart?: (facade: TestingFacade<C>) => Promise<void> | void;
    onBeforeStop?: (facade: TestingFacade<C>) => Promise<void> | void;
    onStop?: (facade: TestingFacade<C>) => Promise<void> | void;
    enableDatabase?: boolean;
    dbAdapter?: TestDbAdapter;
    useSavepoints?: boolean;
    databasePrefix?: string;
    keepDatabase?: boolean;
    enableMigrations?: boolean;
    schemaFromEntities?: boolean | CreateMigrationPlanOptions;
    migrations?: readonly Migration[];
    migrationsDir?: string | readonly string[];
    truncateAfterMigrations?: boolean;
}

export interface StandardHookOptions<C extends BaseAppConfig = any> {
    suiteSeedData?: TestingFacadeSeedData<C>;
}

export class TestingFacade<C extends BaseAppConfig = any> {
    public databaseName?: string;
    public readonly dbAdapter?: TestDbAdapter;
    public readonly migrationExecutions: MigrationExecution[] = [];
    public readonly sql = new SqlTestingHelper();
    public savepointIsolationActive = false;
    private readonly originalDatabaseEnv?: DatabaseEnvSnapshot;
    private readonly originalAppDatabaseConfig: Partial<BaseAppConfig>;
    private savepointConnection?: DriverConnection;
    private savepointCleanup?: () => void;
    private savepointIsolationLocksReady = false;
    private sharedDatabaseState?: SharedTestDatabaseState;
    private sharedMySQLSessionKey?: string;
    private sharedMySQLSessionLeaseId?: string;
    private databaseCreated = false;
    private readonly logger = createLogger('TestingFacade');

    constructor(
        readonly app: App<any>,
        readonly options: TestingFacadeOptions<any> = {},
        originalDatabaseEnv?: DatabaseEnvSnapshot
    ) {
        this.originalDatabaseEnv = originalDatabaseEnv ?? (options.enableDatabase ? snapshotDatabaseEnv() : undefined);
        this.dbAdapter = options.enableDatabase ? resolveTestDbAdapter(app.config, options.dbAdapter) : options.dbAdapter;
        this.originalAppDatabaseConfig = snapshotAppDatabaseConfig(app.config);
    }

    async start(): Promise<void> {
        try {
            this.logger.info('Starting test facade', {
                enableDatabase: this.options.enableDatabase === true,
                dbAdapter: this.dbAdapter,
                migrations: this.shouldRunMigrations(),
                useSavepoints: this.shouldUseSavepoints
            });
            setCurrentApp(this.app);
            if (this.options.enableDatabase) await this.createDatabase();
            if (this.shouldPrepareDatabaseSchema()) await this.prepareDatabaseSchema();
            if (this.options.enableDatabase && this.shouldUseSavepoints) await this.initSavepointIsolation();
            await this.options.onBeforeStart?.(this);
            setCurrentApp(this.app);
            await this.app.start();
            await this.options.onStart?.(this);
            if (this.options.autoSeedData && !this.shouldUseSavepoints) await this.seed();
        } catch (error) {
            await this.app.stop().catch(() => {});
            await this.cleanupDatabase();
            throw error;
        }
    }

    async stop(): Promise<void> {
        setCurrentApp(this.app);
        let errorToThrow: unknown;
        try {
            await this.options.onBeforeStop?.(this);
        } catch (error) {
            errorToThrow ??= error;
        }
        try {
            await this.teardownSavepointIsolation();
        } catch (error) {
            errorToThrow ??= error;
        }
        try {
            await this.app.stop();
        } catch (error) {
            errorToThrow ??= error;
        }
        try {
            await this.cleanupDatabase();
        } catch (error) {
            errorToThrow ??= error;
        }
        try {
            await this.options.onStop?.(this);
        } catch (error) {
            errorToThrow ??= error;
        }
        if (errorToThrow) throw errorToThrow;
    }

    async createDatabase(): Promise<void> {
        if (!this.options.enableDatabase) return;
        if (this.databaseCreated) return;
        const adapter = this.requireDbAdapter();
        await waitForTestDatabaseReady(adapter, this.app.config);

        const sharedKey = this.getSharedDatabaseKey(adapter);
        if (adapter === 'mysql' && sharedKey && getSharedMySQLSessionManagerConfig()) {
            await this.createManagedSharedMySQLDatabase(sharedKey);
            return;
        }
        if (sharedKey) {
            await this.createSharedDatabase(adapter, sharedKey);
            return;
        }

        this.databaseName = createTestDatabaseName(this.options.databasePrefix);

        const adminDb = this.createAdminDatabase(adapter);
        try {
            await adminDb.rawExecute(sql`CREATE DATABASE ${sql.identifier(this.databaseName)}`);
        } finally {
            await adminDb.driver.close();
        }

        this.databaseCreated = true;
        this.applyDatabaseConfig(adapter, this.databaseName);
    }

    async destroyDatabase(): Promise<void> {
        if (this.sharedMySQLSessionKey) {
            await releaseSharedMySQLSessionDatabase(this.sharedMySQLSessionKey, this.sharedMySQLSessionLeaseId).catch(() => {});
            this.sharedMySQLSessionKey = undefined;
            this.sharedMySQLSessionLeaseId = undefined;
            this.databaseCreated = false;
            return;
        }
        if (this.sharedDatabaseState) {
            this.releaseSharedDatabase();
            return;
        }
        if (!this.databaseCreated || !this.databaseName || this.options.keepDatabase || Env.TEST_KEEP_DB) return;
        await this.dropDatabase(this.requireDbAdapter(), this.databaseName);
        this.databaseCreated = false;
    }

    async truncateTables(): Promise<void> {
        if (!this.options.enableDatabase || !this.databaseCreated) return;
        const db = this.get<BaseDatabase>(BaseDatabase);
        if (db.driver.dialect === 'postgres') {
            const rows = await db.rawFind<{ tablename: string }>(
                sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_migrations'`
            );
            if (!rows.length) return;
            await db.rawExecute(sql`TRUNCATE TABLE ${sql.join(rows.map(row => sql.identifier(row.tablename)))} RESTART IDENTITY CASCADE`);
            return;
        }

        const rows = await db.rawFind<Record<string, unknown>>(sql`SHOW TABLES`);
        const tables = rows
            .map(row => String(Object.values(row)[0]))
            .filter(table => table && table !== '_migrations')
            .sort();
        if (!tables.length) return;
        await db.transaction(async session => {
            await db.rawExecute(sql`SET FOREIGN_KEY_CHECKS = 0`, session);
            try {
                for (const table of tables) {
                    await db.rawExecute(sql`TRUNCATE TABLE ${sql.identifier(table)}`, session);
                }
            } finally {
                await db.rawExecute(sql`SET FOREIGN_KEY_CHECKS = 1`, session);
            }
        });
    }

    async request(request: HttpRequest): Promise<MemoryHttpResponse> {
        return (await this.app.request(request, new MemoryHttpResponse())) as MemoryHttpResponse;
    }

    async seed(): Promise<void> {
        await this.options.seedData?.(this);
    }

    async runMigrations(): Promise<MigrationExecution[]> {
        if (!this.app.options.db) throw new Error('TestingFacade migrations require an app database provider');
        const db = this.get<BaseDatabase>(BaseDatabase);
        const migrations = await this.loadTestingMigrations();
        const executions = await new MigrationRunner(db).run(migrations, {
            beforeRun: () => this.prepareInternalMigrationTables(db)
        });
        this.migrationExecutions.push(...executions);
        return executions;
    }

    async resetToSeed(): Promise<void> {
        if (this.options.enableDatabase && this.shouldUseSavepoints) {
            if (!this.savepointIsolationActive) {
                await this.initSavepointIsolation();
            } else {
                if (!this.savepointConnection) throw new Error('Savepoint isolation is active without a database connection');
                await this.savepointConnection.rollbackToSavepoint('after_seed');
            }
            if (this.savepointIsolationActive) return;
        }
        if (this.options.enableDatabase) await this.truncateTables();
        await this.seed();
    }

    async createSeedSavepoint(name: string, seedData?: TestingFacadeSeedData<C>): Promise<boolean> {
        if (!this.options.enableDatabase || !this.shouldUseSavepoints || !this.getDatabaseProvider()) return false;
        if (!this.savepointIsolationActive) await this.initSavepointIsolation();
        if (!this.savepointConnection) throw new Error('Savepoint isolation is active without a database connection');
        await seedData?.(this);
        await this.savepointConnection.savepoint(name);
        return true;
    }

    async resetToSeedSavepoint(name: string): Promise<boolean> {
        if (!this.options.enableDatabase || !this.shouldUseSavepoints || !this.getDatabaseProvider()) return false;
        if (!this.savepointIsolationActive) await this.initSavepointIsolation();
        if (!this.savepointConnection) throw new Error('Savepoint isolation is active without a database connection');
        await this.savepointConnection.rollbackToSavepoint(name);
        return true;
    }

    get<T>(token: Parameters<App<C>['get']>[0]): T {
        return this.app.get(token) as T;
    }

    private async cleanupDatabase(): Promise<void> {
        try {
            await this.teardownSavepointIsolation();
            await this.closeDatabaseProvider();
            await this.destroyDatabase();
        } finally {
            this.restoreDatabaseConfig();
        }
    }

    private async prepareDatabaseSchema(): Promise<void> {
        if (this.sharedMySQLSessionKey) {
            await this.prepareManagedSharedMySQLSchema(this.sharedMySQLSessionKey, this.sharedMySQLSessionLeaseId);
            return;
        }

        const sharedState = this.sharedDatabaseState;
        if (!sharedState) {
            await this.createSchemaFromEntities();
            if (this.shouldRunMigrations()) await this.runMigrations();
            if (this.shouldTruncateAfterMigrations()) await this.truncateTables();
            return;
        }

        if (!sharedState.schemaReady) {
            sharedState.schemaReady = (async () => {
                try {
                    await this.createSchemaFromEntities();
                    if (this.shouldRunMigrations()) await this.runMigrations();
                    if (this.shouldTruncateAfterMigrations()) await this.truncateTables();
                } catch (error) {
                    sharedTestDatabases.delete(sharedState.key);
                    if (!sharedState.keepDatabase && !Env.TEST_KEEP_DB) await sharedState.destroy().catch(() => {});
                    throw error;
                }
            })();
        }

        await sharedState.schemaReady;
    }

    private async prepareManagedSharedMySQLSchema(key: string, leaseId: string | undefined): Promise<void> {
        const preparation = await prepareSharedMySQLSessionSchema(key, leaseId);
        if (!preparation.run) return;

        try {
            await this.createSchemaFromEntities();
            if (this.shouldRunMigrations()) await this.runMigrations();
            if (this.shouldTruncateAfterMigrations()) await this.truncateTables();
        } catch (error) {
            await completeSharedMySQLSessionSchema(key, leaseId, preparation.preparationId, error).catch(() => {});
            throw error;
        }

        await completeSharedMySQLSessionSchema(key, leaseId, preparation.preparationId);
    }

    private async closeDatabaseProvider(): Promise<void> {
        if (!this.app.options.db) return;
        try {
            const db = this.app.get(this.app.options.db) as BaseDatabase;
            await db.driver.close();
        } catch {
            // The DB may never have been constructed, or start() may have failed before it was usable.
        }
    }

    private createAdminDatabase(adapter: TestDbAdapter): BaseDatabase {
        return adapter === 'postgres'
            ? new BaseDatabase(
                  new PostgresDriver({
                      host: this.app.config.PG_HOST,
                      port: this.app.config.PG_PORT,
                      user: this.app.config.PG_USER,
                      password: this.app.config.PG_PASSWORD_SECRET,
                      database: 'postgres',
                      ssl: this.app.config.PG_SSL ? { rejectUnauthorized: this.app.config.PG_SSL_REJECT_UNAUTHORIZED ?? true } : undefined,
                      max: 1
                  })
              )
            : new BaseDatabase(
                  new MySQLDriver({
                      host: this.app.config.MYSQL_HOST,
                      port: this.app.config.MYSQL_PORT,
                      user: this.app.config.MYSQL_USER,
                      password: this.app.config.MYSQL_PASSWORD_SECRET,
                      database: 'mysql',
                      connectionLimit: 1
                  })
              );
    }

    private async dropDatabase(adapter: TestDbAdapter, databaseName: string): Promise<void> {
        const adminDb = this.createAdminDatabase(adapter);
        try {
            if (adapter === 'postgres') {
                await adminDb.rawExecute(
                    sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName} AND pid <> pg_backend_pid()`
                );
            }
            await adminDb.rawExecute(sql`DROP DATABASE IF EXISTS ${sql.identifier(databaseName)}`);
        } finally {
            await adminDb.driver.close();
        }
    }

    private async createSharedDatabase(adapter: TestDbAdapter, key: string): Promise<void> {
        let state = sharedTestDatabases.get(key);
        if (!state) {
            const databaseName = createTestDatabaseName(this.options.databasePrefix);
            state = {
                key,
                adapter,
                databaseName,
                references: 0,
                keepDatabase: !!this.options.keepDatabase,
                destroy: () => this.dropDatabase(adapter, databaseName)
            };
            sharedTestDatabases.set(key, state);
            installSharedDatabaseCleanup();
            state.databaseReady = this.initializeSharedDatabase(state);
        } else {
            state.keepDatabase = state.keepDatabase || !!this.options.keepDatabase;
        }

        state.references++;
        this.sharedDatabaseState = state;
        try {
            await state.databaseReady;
        } catch (error) {
            this.releaseSharedDatabase();
            sharedTestDatabases.delete(key);
            throw error;
        }

        this.databaseName = state.databaseName;
        this.databaseCreated = true;
        this.applyDatabaseConfig(adapter, state.databaseName);
    }

    private async createManagedSharedMySQLDatabase(key: string): Promise<void> {
        const state = await ensureSharedMySQLSessionDatabase({
            key,
            prefix: this.options.databasePrefix ?? 'test',
            keepDatabase: !!this.options.keepDatabase
        });
        this.sharedMySQLSessionKey = key;
        this.sharedMySQLSessionLeaseId = state.leaseId;
        this.databaseName = state.databaseName;
        this.databaseCreated = true;
        this.applyDatabaseConfig('mysql', state.databaseName);
        Env.TSF_TEST_MYSQL_SESSION_KEY = key;
        Env.TSF_TEST_MYSQL_SESSION_LEASE_ID = state.leaseId;
        Env.TSF_TEST_MYSQL_SESSION_DATABASE = state.databaseName;
    }

    private async initializeSharedDatabase(state: SharedTestDatabaseState): Promise<void> {
        const adminDb = this.createAdminDatabase(state.adapter);
        try {
            await adminDb.rawExecute(sql`CREATE DATABASE ${sql.identifier(state.databaseName)}`);
        } finally {
            await adminDb.driver.close();
        }
    }

    private releaseSharedDatabase(): void {
        const state = this.sharedDatabaseState;
        if (!state) return;
        state.references = Math.max(0, state.references - 1);
        this.sharedDatabaseState = undefined;
        this.databaseCreated = false;
    }

    private applyDatabaseConfig(adapter: TestDbAdapter, databaseName: string): void {
        this.app.config.DB_ADAPTER = adapter;
        Env.DB_ADAPTER = adapter;
        Env.TSF_TEST_DATABASE_NAME = databaseName;
        if (adapter === 'postgres') {
            this.app.config.PG_DATABASE = databaseName;
            Env.PG_DATABASE = databaseName;
        } else {
            this.app.config.MYSQL_DATABASE = databaseName;
            Env.MYSQL_DATABASE = databaseName;
        }
    }

    private restoreDatabaseConfig(): void {
        Object.assign(this.app.config, this.originalAppDatabaseConfig);
        if (this.originalDatabaseEnv) restoreDatabaseEnv(this.originalDatabaseEnv);
    }

    private requireDbAdapter(): TestDbAdapter {
        if (!this.dbAdapter) throw new Error("TestingFacade enableDatabase requires dbAdapter or DB_ADAPTER to be 'mysql' or 'postgres'");
        return this.dbAdapter;
    }

    private shouldRunMigrations(): boolean {
        if (this.options.enableMigrations !== undefined) return this.options.enableMigrations;
        if (this.options.enableDatabase) return !!this.app.options.db;
        return !!this.options.migrations?.length || this.options.migrationsDir !== undefined;
    }

    private shouldCreateSchemaFromEntities(): boolean {
        return !!this.options.schemaFromEntities;
    }

    private shouldPrepareDatabaseSchema(): boolean {
        return !!this.options.enableDatabase && (this.shouldCreateSchemaFromEntities() || this.shouldRunMigrations());
    }

    private async createSchemaFromEntities(): Promise<void> {
        const option = this.options.schemaFromEntities;
        if (!option) return;
        const db = this.getDatabaseProvider();
        if (!db) throw new Error('TestingFacade schemaFromEntities requires an app database provider');
        const plan = await createMigrationPlan(db, option === true ? {} : option);
        for (const statement of plan.statements) {
            if (statement.startsWith('\0table:')) continue;
            await db.rawExecuteUnsafe(statement);
        }
    }

    private shouldTruncateAfterMigrations(): boolean {
        if (!this.options.enableDatabase) return false;
        return this.options.truncateAfterMigrations ?? true;
    }

    private shouldPrepareWorkerJobsTable(): boolean {
        return !!this.options.enableDatabase && !!this.app.options.enableWorker && !!this.app.options.db;
    }

    private async prepareInternalMigrationTables(db: BaseDatabase): Promise<void> {
        await ensureMySQLLocksTable(db);
        if (db.driver.dialect === 'mysql' && db.options.enableLocksTable) this.savepointIsolationLocksReady = true;
        if (this.shouldPrepareWorkerJobsTable()) await this.prepareWorkerJobsTableForDatabase(db);
    }

    private async prepareWorkerJobsTableForDatabase(db: BaseDatabase): Promise<void> {
        if (!db.entityRegistry.includes(JobEntity)) db.entityRegistry.push(JobEntity);
        JobEntity.registerDatabase(db);
        const plan = await createMigrationPlan(db, { tableNames: ['_jobs'] });
        for (const statement of plan.statements) {
            if (statement.startsWith('\0table:')) continue;
            await db.rawExecuteUnsafe(statement);
        }
    }

    private async loadTestingMigrations(): Promise<Migration[]> {
        const migrations = [...(this.options.migrations ?? [])];
        const dirs = this.getMigrationDirectories();
        for (const dir of dirs) {
            migrations.push(...(await loadMigrationsFromDirectory(dir)));
        }
        return migrations;
    }

    private getMigrationDirectories(): readonly string[] {
        if (this.options.migrationsDir !== undefined) {
            return typeof this.options.migrationsDir === 'string' ? [this.options.migrationsDir] : this.options.migrationsDir;
        }
        if (this.options.migrations !== undefined) return [];
        return ['src/migrations'];
    }

    private get shouldUseSavepoints(): boolean {
        if (!readEnvBoolean(Env.TSF_TEST_ALLOW_SAVEPOINTS, true)) return false;
        if (this.options.useSavepoints !== undefined) return this.options.useSavepoints;
        return !!this.options.enableDatabase;
    }

    private getSharedDatabaseKey(adapter: TestDbAdapter): string | undefined {
        if (!this.options.enableDatabase || !this.shouldUseSavepoints) return undefined;
        const migrations = this.options.migrations ?? [];
        const inlineMigrations = migrations.map(migration => `${migration.name}:${getInlineMigrationIdentity(migration)}`).sort();
        const migrationDirs = this.getMigrationDirectories()
            .map(dir => resolve(dir))
            .sort();
        const schemaFromEntities =
            this.options.schemaFromEntities === true
                ? true
                : this.options.schemaFromEntities
                  ? {
                        pgSchema: this.options.schemaFromEntities.pgSchema,
                        tableNames: this.options.schemaFromEntities.tableNames ? [...this.options.schemaFromEntities.tableNames].sort() : undefined
                    }
                  : false;
        return JSON.stringify({
            adapter,
            prefix: this.options.databasePrefix ?? 'test',
            schemaFromEntities,
            migrations: this.shouldRunMigrations() ? { inlineMigrations, migrationDirs } : false,
            truncateAfterMigrations: this.shouldTruncateAfterMigrations(),
            workerJobsTable: this.shouldPrepareWorkerJobsTable()
        });
    }

    private getDatabaseProvider(): BaseDatabase | undefined {
        if (!this.app.options.db) return undefined;
        try {
            return this.app.get(this.app.options.db) as BaseDatabase;
        } catch {
            try {
                return this.get<BaseDatabase>(BaseDatabase);
            } catch {
                return undefined;
            }
        }
    }

    private async initSavepointIsolation(): Promise<void> {
        const db = this.getDatabaseProvider();
        if (!db) return;

        if (!this.savepointIsolationLocksReady) await this.ensureSavepointIsolationLocksReady(db);

        const originalAcquire = db.driver.acquire.bind(db.driver);
        const connection = await originalAcquire();
        const originalBegin = connection.begin.bind(connection);
        const originalCommit = connection.commit.bind(connection);
        const originalRollback = connection.rollback.bind(connection);
        const originalSavepoint = connection.savepoint.bind(connection);
        const originalRollbackToSavepoint = connection.rollbackToSavepoint.bind(connection);
        const originalRelease = connection.release.bind(connection);
        const transactionStack: string[] = [];
        let savepointId = 0;

        const cleanup = () => {
            db.driver.acquire = originalAcquire;
            connection.begin = originalBegin;
            connection.commit = originalCommit;
            connection.rollback = originalRollback;
            connection.release = originalRelease;
        };

        try {
            await originalBegin();

            db.driver.acquire = async () => connection;
            connection.begin = async () => {
                const name = `tsf_test_tx_${++savepointId}`;
                transactionStack.push(name);
                await originalSavepoint(name);
            };
            connection.commit = async () => {
                transactionStack.pop();
            };
            connection.rollback = async () => {
                const name = transactionStack.pop();
                if (name) await originalRollbackToSavepoint(name);
            };
            connection.release = async () => {};

            this.savepointConnection = connection;
            this.savepointCleanup = cleanup;

            await this.seed();
            await originalSavepoint('after_seed');
            this.savepointIsolationActive = true;
        } catch (error) {
            cleanup();
            this.savepointConnection = undefined;
            this.savepointCleanup = undefined;
            try {
                await originalRollback();
            } finally {
                await originalRelease();
            }
            throw error;
        }
    }

    private async teardownSavepointIsolation(): Promise<void> {
        if (!this.savepointConnection) return;
        const connection = this.savepointConnection;
        this.savepointCleanup?.();
        this.savepointConnection = undefined;
        this.savepointCleanup = undefined;
        this.savepointIsolationActive = false;
        try {
            await connection.rollback();
        } finally {
            await connection.release();
        }
    }

    private async ensureSavepointIsolationLocksReady(db = this.getDatabaseProvider()): Promise<void> {
        if (!db) return;
        await ensureMySQLLocksTable(db);
        this.savepointIsolationLocksReady = true;
    }
}

type TestingAppOptions<C extends BaseAppConfig> = Omit<CreateAppOptions<C>, 'config'> & {
    config?: CreateAppOptions<C>['config'];
};
export type TestingFacadeFactory<C extends BaseAppConfig = BaseAppConfig> = (
    appOptions?: Partial<TestingAppOptions<C>>,
    options?: TestingFacadeOptions<NoInferConfig<C>>
) => TestingFacade<C>;
export type TestingFacadeAppOptionsSelection<C extends BaseAppConfig = any> = Partial<TestingAppOptions<C>> & {
    imports: NonNullable<TestingAppOptions<C>['imports']>;
    exports: NonNullable<TestingAppOptions<C>['exports']>;
    providers: NonNullable<TestingAppOptions<C>['providers']>;
    controllers: NonNullable<TestingAppOptions<C>['controllers']>;
    listeners: NonNullable<TestingAppOptions<C>['listeners']>;
    commands: NonNullable<TestingAppOptions<C>['commands']>;
};
export type TestingFacadeAppOptionsResolver<C extends BaseAppConfig = any> = (
    appOptions: TestingFacadeAppOptionsSelection<C>
) => TestingAppOptions<C>;
export type TestingFacadeOptionsResolver<C extends BaseAppConfig = any> = (
    options: TestingFacadeOptions<NoInferConfig<C>>
) => TestingFacadeOptions<NoInferConfig<C>>;
export type TestingFacadeAppOptionsSource<C extends BaseAppConfig = any> = TestingAppOptions<C> | TestingFacadeAppOptionsResolver<C>;
export type TestingFacadeOptionsSource<C extends BaseAppConfig = any> =
    | TestingFacadeOptions<NoInferConfig<C>>
    | TestingFacadeOptionsResolver<NoInferConfig<C>>;

export function createTestingFacade<C extends BaseAppConfig = BaseAppConfig>(
    appOptions: TestingAppOptions<C>,
    options: TestingFacadeOptions<NoInferConfig<C>> = {}
): TestingFacade<C> {
    const originalDatabaseEnv = options.enableDatabase ? snapshotDatabaseEnv() : undefined;
    const app = createApp<C>({
        config: BaseAppConfig as CreateAppOptions<C>['config'],
        ...appOptions,
        frameworkConfig: {
            ...appOptions.frameworkConfig,
            port: 0
        }
    } as CreateAppOptions<C>);
    if (originalDatabaseEnv) restoreDatabaseEnv(originalDatabaseEnv);
    return new TestingFacade(app, options, originalDatabaseEnv);
}

export function createTestingFacadeWithDatabase<C extends BaseAppConfig = BaseAppConfig>(
    appOptions: TestingAppOptions<C>,
    options: Omit<TestingFacadeOptions<NoInferConfig<C>>, 'enableDatabase'> = {}
): TestingFacade<C> {
    return createTestingFacade(appOptions, { ...options, enableDatabase: true });
}

export function createTestingFacadeBuilder<C extends BaseAppConfig = any>(
    defaultAppOptions: TestingFacadeAppOptionsSource<C>,
    defaultOptions: TestingFacadeOptionsSource<NoInferConfig<C>> = {}
): TestingFacadeFactory<C> {
    return (appOptions = {}, options = {}) => {
        const resolvedAppOptions =
            typeof defaultAppOptions === 'function'
                ? defaultAppOptions(normalizeTestingAppOptions(appOptions))
                : mergeTestingAppOptions(defaultAppOptions, appOptions);
        const resolvedOptions = typeof defaultOptions === 'function' ? defaultOptions(options) : mergeTestingFacadeOptions(defaultOptions, options);
        return createTestingFacade(resolvedAppOptions, resolvedOptions);
    };
}

function mergeTestingAppOptions<C extends BaseAppConfig>(
    defaults: TestingAppOptions<C>,
    overrides: Partial<TestingAppOptions<C>>
): TestingAppOptions<C> {
    const merged = {
        ...defaults,
        ...overrides,
        imports: mergeTestingArrays(defaults.imports, overrides.imports),
        exports: mergeTestingArrays(defaults.exports, overrides.exports),
        providers: mergeTestingArrays(defaults.providers, overrides.providers),
        controllers: mergeTestingArrays(defaults.controllers, overrides.controllers),
        listeners: mergeTestingArrays(defaults.listeners, overrides.listeners),
        commands: mergeTestingArrays(defaults.commands, overrides.commands)
    } as TestingAppOptions<C>;

    const defaultConfig = mergeTestingObjects(defaults.defaultConfig, overrides.defaultConfig);
    if (defaultConfig) merged.defaultConfig = defaultConfig as Partial<C>;
    const frameworkConfig = mergeTestingObjects(defaults.frameworkConfig, overrides.frameworkConfig);
    if (frameworkConfig) merged.frameworkConfig = frameworkConfig;
    const serverConfig = mergeTestingObjects(defaults.serverConfig, overrides.serverConfig);
    if (serverConfig) merged.serverConfig = serverConfig;
    return merged;
}

function normalizeTestingAppOptions<C extends BaseAppConfig>(options: Partial<TestingAppOptions<C>>): TestingFacadeAppOptionsSelection<C> {
    return {
        ...options,
        imports: [...(options.imports ?? [])],
        exports: [...(options.exports ?? [])],
        providers: [...(options.providers ?? [])],
        controllers: [...(options.controllers ?? [])],
        listeners: [...(options.listeners ?? [])],
        commands: [...(options.commands ?? [])]
    };
}

function mergeTestingFacadeOptions<C extends BaseAppConfig>(
    defaults: TestingFacadeOptions<C>,
    overrides: TestingFacadeOptions<C>
): TestingFacadeOptions<C> {
    const merged: TestingFacadeOptions<C> = {
        ...defaults,
        ...overrides,
        defaultTestHeaders: mergeTestingObjects(defaults.defaultTestHeaders, overrides.defaultTestHeaders),
        migrations: mergeTestingArrays(defaults.migrations, overrides.migrations),
        migrationsDir: mergeTestingMigrationDirs(defaults.migrationsDir, overrides.migrationsDir),
        seedData: composeTestingFacadeCallbacks(defaults.seedData, overrides.seedData),
        onBeforeStart: composeTestingFacadeCallbacks(defaults.onBeforeStart, overrides.onBeforeStart),
        onStart: composeTestingFacadeCallbacks(defaults.onStart, overrides.onStart),
        onBeforeStop: composeTestingFacadeCallbacks(defaults.onBeforeStop, overrides.onBeforeStop),
        onStop: composeTestingFacadeCallbacks(defaults.onStop, overrides.onStop)
    };
    return merged;
}

function mergeTestingArrays<T>(defaults: readonly T[] | undefined, overrides: readonly T[] | undefined): T[] | undefined {
    if (!defaults?.length && !overrides?.length) return undefined;
    return [...(defaults ?? []), ...(overrides ?? [])];
}

function mergeTestingObjects<T extends object>(defaults: T | undefined, overrides: T | undefined): T | undefined {
    if (!defaults && !overrides) return undefined;
    return { ...(defaults ?? {}), ...(overrides ?? {}) } as T;
}

function mergeTestingMigrationDirs(
    defaults: string | readonly string[] | undefined,
    overrides: string | readonly string[] | undefined
): string | readonly string[] | undefined {
    if (defaults === undefined) return overrides;
    if (overrides === undefined) return defaults;
    return [...toTestingStringArray(defaults), ...toTestingStringArray(overrides)];
}

function toTestingStringArray(value: string | readonly string[]): readonly string[] {
    return typeof value === 'string' ? [value] : value;
}

function composeTestingFacadeCallbacks<C extends BaseAppConfig>(
    first: TestingFacadeSeedData<C> | undefined,
    second: TestingFacadeSeedData<C> | undefined
): TestingFacadeSeedData<C> | undefined {
    if (!first) return second;
    if (!second) return first;
    return async facade => {
        await first(facade);
        await second(facade);
    };
}

export type MockMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
type BodylessMockMethod = 'GET';
type BodyMockMethod = Exclude<MockMethod, BodylessMockMethod>;
export type MockHeaders = Record<string, unknown>;
export type MockBody = unknown;

export async function makeMockRequest(tf: TestingFacade, method: BodylessMockMethod, url: string, headers?: MockHeaders): Promise<MemoryHttpResponse>;
export async function makeMockRequest(tf: TestingFacade, method: BodyMockMethod, url: string, body: MockBody): Promise<MemoryHttpResponse>;
export async function makeMockRequest(
    tf: TestingFacade,
    method: BodyMockMethod,
    url: string,
    headers: MockHeaders,
    body: MockBody
): Promise<MemoryHttpResponse>;
export async function makeMockRequest(
    tf: TestingFacade,
    method: MockMethod,
    url: string,
    headers: MockHeaders,
    body: MockBody
): Promise<MemoryHttpResponse>;
export async function makeMockRequest(
    tf: TestingFacade,
    method: MockMethod,
    url: string,
    headersOrBody: MockHeaders | MockBody = {},
    body?: MockBody
): Promise<MemoryHttpResponse> {
    const bodyless = method === 'GET';
    const hasSeparateBody = arguments.length >= 5;
    const hasBody = hasSeparateBody || !bodyless;
    const headers = normalizeMockHeaders({
        'content-type': 'application/json',
        ...tf.options.defaultTestHeaders,
        ...(hasSeparateBody || (bodyless && !hasSeparateBody) ? (headersOrBody as MockHeaders) : {})
    });
    const payload = hasSeparateBody ? body : headersOrBody;

    if (!hasBody) return tf.request(new HttpRequest(method, url, headers));
    return tf.request(new HttpRequest(method, url, headers, payload as Buffer | string | object | undefined));
}

function normalizeMockHeaders(headers: MockHeaders): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers)
            .filter((entry): entry is [string, Exclude<unknown, undefined>] => entry[1] !== undefined)
            .map(([key, value]) => [key, Array.isArray(value) ? value.map(String).join(', ') : String(value)])
    );
}

export function installStandardHooks<C extends BaseAppConfig = BaseAppConfig>(tf: TestingFacade<C>, options: StandardHookOptions<C> = {}): void {
    const suiteSeedSavepoint = 'after_suite_seed';
    let suiteSeedUsesSavepoint = false;

    before(async () => {
        await tf.start();
        if (options.suiteSeedData) suiteSeedUsesSavepoint = await tf.createSeedSavepoint(suiteSeedSavepoint, options.suiteSeedData);
    });
    after(() => tf.stop());
    beforeEach(async () => {
        if (!options.suiteSeedData) {
            await tf.resetToSeed();
            return;
        }
        if (suiteSeedUsesSavepoint && (await tf.resetToSeedSavepoint(suiteSeedSavepoint))) return;
        await tf.resetToSeed();
        await options.suiteSeedData(tf);
    });
    afterEach(() => {
        tf.sql.clearMocks();
        mock.timers.reset();
        mock.restoreAll();
    });
}

export function resetSrcModuleCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/dist/') || key.includes('/src/')) delete require.cache[key];
    }
}

export function setDefaultDatabaseConfig(config: Record<string, string | number | boolean | undefined>): void {
    for (const [key, value] of Object.entries(config)) {
        if (value === undefined || Env[key] !== undefined) continue;
        Env[key] = String(value);
    }
}

export async function cleanupTestDatabases(prefix = 'test', adapter?: TestDbAdapter): Promise<void> {
    clearSharedTestDatabases(prefix, adapter);
    const adapters = adapter ? [adapter] : (['mysql', 'postgres'] as const).filter(item => hasDatabaseConfig(item));
    for (const dbAdapter of adapters) {
        const adminDb = createCleanupAdminDatabase(dbAdapter);
        try {
            if (dbAdapter === 'postgres') {
                const rows = await adminDb.rawFindUnsafe<{ name: string }>('SELECT datname AS name FROM pg_database WHERE datname LIKE ?', [
                    `${prefix}%`
                ]);
                for (const row of rows) {
                    await adminDb.rawExecute(
                        sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${row.name} AND pid <> pg_backend_pid()`
                    );
                    await adminDb.rawExecute(sql`DROP DATABASE IF EXISTS ${sql.identifier(row.name)}`);
                }
            } else {
                const rows = await adminDb.rawFindUnsafe<{ name: string }>(
                    'SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME LIKE ?',
                    [`${prefix}%`]
                );
                for (const row of rows) {
                    await adminDb.rawExecute(sql`DROP DATABASE IF EXISTS ${sql.identifier(row.name)}`);
                }
            }
        } finally {
            await adminDb.driver.close();
        }
    }
}

function hasDatabaseConfig(adapter: TestDbAdapter): boolean {
    return adapter === 'postgres' ? !!Env.PG_HOST : !!Env.MYSQL_HOST;
}

function createCleanupAdminDatabase(adapter: TestDbAdapter): BaseDatabase {
    if (adapter === 'postgres') {
        return new BaseDatabase(
            new PostgresDriver({
                host: Env.PG_HOST,
                port: Env.PG_PORT ? Number(Env.PG_PORT) : 5432,
                user: Env.PG_USER,
                password: Env.PG_PASSWORD_SECRET,
                database: 'postgres',
                ssl: readEnvBoolean(Env.PG_SSL) ? { rejectUnauthorized: readEnvBoolean(Env.PG_SSL_REJECT_UNAUTHORIZED, true) } : undefined,
                max: 1
            })
        );
    }

    return new BaseDatabase(
        new MySQLDriver({
            host: Env.MYSQL_HOST,
            port: Env.MYSQL_PORT ? Number(Env.MYSQL_PORT) : 3306,
            user: Env.MYSQL_USER,
            password: Env.MYSQL_PASSWORD_SECRET,
            database: 'mysql',
            connectionLimit: 1
        })
    );
}

function readEnvBoolean(value: unknown, defaultValue = false): boolean {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    return value === '1' || value === 'true';
}

export const TestingHelpers = {
    cleanupTestDatabases,
    createTestingFacade,
    createTestingFacadeBuilder,
    createTestingFacadeWithDatabase,
    defineEntityFixtures,
    installStandardHooks,
    loadEntityFixtures,
    makeMockRequest,
    prepareEntityFixtures,
    resetSrcModuleCache,
    SqlTestingHelper,
    setDefaultDatabaseConfig
};

const DATABASE_ENV_KEYS = [
    'DB_ADAPTER',
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_PASSWORD_SECRET',
    'MYSQL_DATABASE',
    'MYSQL_CONNECTION_LIMIT',
    'MYSQL_MIN_IDLE_CONNECTIONS',
    'MYSQL_IDLE_TIMEOUT_SECONDS',
    'PG_HOST',
    'PG_PORT',
    'PG_USER',
    'PG_PASSWORD_SECRET',
    'PG_DATABASE',
    'PG_SCHEMA',
    'PG_SSL',
    'PG_SSL_REJECT_UNAUTHORIZED',
    'PG_CONNECTION_LIMIT',
    'PG_IDLE_TIMEOUT_SECONDS',
    'TSF_TEST_DATABASE_NAME',
    'TSF_TEST_ALLOW_SAVEPOINTS',
    'TSF_TEST_MYSQL_SESSION_KEY',
    'TSF_TEST_MYSQL_SESSION_LEASE_ID',
    'TSF_TEST_MYSQL_SESSION_DATABASE'
] as const;
type DatabaseEnvSnapshot = Partial<Record<(typeof DATABASE_ENV_KEYS)[number], string>>;
interface SharedTestDatabaseState {
    key: string;
    adapter: TestDbAdapter;
    databaseName: string;
    databaseReady?: Promise<void>;
    schemaReady?: Promise<void>;
    references: number;
    keepDatabase: boolean;
    destroy: () => Promise<void>;
}

let nextDatabaseId = 1;
let nextInlineMigrationId = 1;
let sharedDatabaseCleanupInstalled = false;
let sharedDatabaseCleanupStarted = false;
const inlineMigrationIds = new WeakMap<object, number>();
const sharedTestDatabases = new Map<string, SharedTestDatabaseState>();

function resolveTestDbAdapter(config: BaseAppConfig, explicit?: TestDbAdapter): TestDbAdapter {
    if (explicit) return explicit;
    if (config.DB_ADAPTER === 'mysql' || config.DB_ADAPTER === 'postgres') return config.DB_ADAPTER;
    if (Env.DB_ADAPTER === 'mysql' || Env.DB_ADAPTER === 'postgres') return Env.DB_ADAPTER;
    const hasPostgres = !!(config.PG_HOST ?? Env.PG_HOST);
    const hasMySQL = !!(config.MYSQL_HOST ?? Env.MYSQL_HOST);
    if (hasPostgres && !hasMySQL) return 'postgres';
    if (hasMySQL && !hasPostgres) return 'mysql';
    throw new Error("TestingFacade enableDatabase requires dbAdapter or DB_ADAPTER to be 'mysql' or 'postgres'");
}

function createTestDatabaseName(prefix = 'test'): string {
    const ts = Env.TEST_RUN_TS ?? String(Math.floor(Date.now() / 1000));
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_') || 'test';
    return `${safePrefix}_${ts}_${process.pid}_${nextDatabaseId++}`;
}

function getInlineMigrationIdentity(migration: Migration): number {
    let id = inlineMigrationIds.get(migration);
    if (!id) {
        id = nextInlineMigrationId++;
        inlineMigrationIds.set(migration, id);
    }
    return id;
}

function installSharedDatabaseCleanup(): void {
    if (sharedDatabaseCleanupInstalled) return;
    sharedDatabaseCleanupInstalled = true;
    process.once('beforeExit', () => {
        void cleanupSharedTestDatabases();
    });
}

async function cleanupSharedTestDatabases(): Promise<void> {
    if (sharedDatabaseCleanupStarted) return;
    sharedDatabaseCleanupStarted = true;
    const states = [...sharedTestDatabases.values()];
    sharedTestDatabases.clear();
    for (const state of states) {
        if (state.keepDatabase || Env.TEST_KEEP_DB) continue;
        try {
            await state.destroy();
        } catch {
            // Best-effort process cleanup should not mask the original test result.
        }
    }
}

function clearSharedTestDatabases(prefix: string, adapter?: TestDbAdapter): void {
    for (const [key, state] of sharedTestDatabases) {
        if (adapter && state.adapter !== adapter) continue;
        if (!state.databaseName.startsWith(prefix)) continue;
        sharedTestDatabases.delete(key);
    }
}

function snapshotDatabaseEnv(): DatabaseEnvSnapshot {
    const snapshot: DatabaseEnvSnapshot = {};
    for (const key of DATABASE_ENV_KEYS) {
        if (Env[key] !== undefined) snapshot[key] = Env[key];
    }
    return snapshot;
}

function restoreDatabaseEnv(snapshot: DatabaseEnvSnapshot): void {
    for (const key of DATABASE_ENV_KEYS) {
        if (snapshot[key] === undefined) delete Env[key];
        else Env[key] = snapshot[key];
    }
}

function snapshotAppDatabaseConfig(config: BaseAppConfig): Partial<BaseAppConfig> {
    return {
        DB_ADAPTER: config.DB_ADAPTER,
        MYSQL_DATABASE: config.MYSQL_DATABASE,
        PG_DATABASE: config.PG_DATABASE
    };
}
