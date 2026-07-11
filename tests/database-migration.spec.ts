import { AutoIncrement, entity, MaxLength, PrimaryKey } from '../src';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseEntity,
    DatabaseDriver,
    defineMigration,
    DriverConnection,
    ExecuteResult,
    loadMigrationsFromDirectory,
    type LogEntry,
    MigrationRunner,
    QueryResult,
    RenderedSql,
    resetLogSink,
    resetMigrations,
    setLogSink,
    standardizeDbCollation
} from '../src';

const tempDirs: string[] = [];

afterEach(() => {
    resetLogSink();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tsf-migration-'));
    tempDirs.push(dir);
    return dir;
}

class FakeConnection implements DriverConnection {
    commands: string[] = [];

    constructor(private driver: FakeDriver) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        this.commands.push('query');
        this.driver.queries.push(query);
        return { rows: this.driver.rows.shift() as T[] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        this.commands.push('execute');
        this.driver.executes.push(query);
        return { affectedRows: 1 };
    }

    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {
        this.commands.push('release');
    }
}

class FakeDriver implements DatabaseDriver {
    rows: Record<string, unknown>[][] = [];
    queries: RenderedSql[] = [];
    executes: RenderedSql[] = [];
    connections: FakeConnection[] = [];

    constructor(readonly dialect: 'mysql' | 'postgres') {}

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        const connection = new FakeConnection(this);
        this.connections.push(connection);
        return connection;
    }
}

@entity.name('tsf_reset_users')
class ResetMigrationUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string & MaxLength<80>;
}

describe('MigrationRunner', () => {
    it('runs unexecuted migrations in name order and records them', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows = [[{ name: '002_second' }]];
        const db = new BaseDatabase(driver);
        const order: string[] = [];
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));

        const completed = await new MigrationRunner(db).run([
            defineMigration('002_second', () => {
                order.push('second');
            }),
            defineMigration('001_first', async migrationDb => {
                order.push('first');
                await migrationDb.rawExecuteUnsafe('SELECT 1');
            })
        ]);

        assert.deepStrictEqual(order, ['first']);
        assert.deepStrictEqual(
            completed.map(item => item.name),
            ['001_first']
        );
        assert.match(driver.executes[0].sql, /CREATE TABLE IF NOT EXISTS "_migrations"/);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "name" FROM "_migrations"',
            bindings: []
        });
        assert.deepStrictEqual(driver.executes[1], {
            sql: 'SELECT 1',
            bindings: []
        });
        assert.deepStrictEqual(driver.executes[2].bindings.slice(0, 1), ['001_first']);
        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(driver.connections[0].commands, ['execute', 'query', 'execute', 'execute', 'release']);
        assert.deepStrictEqual(
            entries.map(entry => entry.message),
            [
                '2 migrations found in package',
                '1 migrations previously executed',
                '1 migrations to run',
                'Running migration: 001_first',
                'Completed migration: 001_first'
            ]
        );
        assert.equal(
            entries.every(entry => entry.scope === 'Migrator'),
            true
        );
        assert.equal(typeof entries[4].data?.durationMs, 'number');
    });

    it('emits MySQL migration table DDL', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [[]];
        const db = new BaseDatabase(driver);

        await new MigrationRunner(db).run([]);

        assert.match(driver.executes[0].sql, /CREATE TABLE IF NOT EXISTS `_migrations`/);
        assert.match(driver.executes[0].sql, /`durationMs` int unsigned NOT NULL/);
    });

    it('runs beforeRun first and stops without recording or continuing after a migration failure', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows = [[]];
        const db = new BaseDatabase(driver);
        const order: string[] = [];

        await assert.rejects(
            () =>
                new MigrationRunner(db, 'service_migrations').run(
                    [
                        defineMigration('002_later', () => {
                            order.push('later');
                        }),
                        defineMigration('001_fails', () => {
                            order.push('fails');
                            throw new Error('migration failed');
                        })
                    ],
                    {
                        beforeRun: () => {
                            order.push('before');
                        }
                    }
                ),
            /migration failed/
        );

        assert.deepStrictEqual(order, ['before', 'fails']);
        assert.match(driver.executes[0].sql, /CREATE TABLE IF NOT EXISTS "service_migrations"/);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "name" FROM "service_migrations"',
            bindings: []
        });
        assert.equal(driver.executes.length, 1);
    });

    it('loads migrations from relative directories and maps source dirs to dist output', async () => {
        const root = tempDir();
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            writeFileSync('package.json', '{"name":"fixture","type":"module"}');
            const distDir = join(root, 'dist', 'src', 'migrations');
            const sourceDir = join(root, 'src', 'migrations');
            mkdirSync(distDir, { recursive: true });
            mkdirSync(sourceDir, { recursive: true });
            writeFileSync(join(sourceDir, '001_source.ts'), 'source');
            writeFileSync(join(distDir, '001_source.cjs'), 'exports.default = async () => {};\n');
            writeFileSync(join(distDir, '002_source.js'), 'export default async function migration() {}\n');
            writeFileSync(join(distDir, '003_source.mjs'), 'export default async function migration() {}\n');

            assert.deepStrictEqual(
                (await loadMigrationsFromDirectory('src/migrations')).map(migration => migration.name),
                ['001_source', '002_source', '003_source']
            );
            assert.deepStrictEqual(
                (await loadMigrationsFromDirectory('dist/src/migrations')).map(migration => migration.name),
                ['001_source', '002_source', '003_source']
            );
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('resets source migrations and writes a base migration from entity metadata', async () => {
        const migrationsDir = tempDir();
        writeFileSync(join(migrationsDir, '99999999_999999_old.ts'), 'old');
        writeFileSync(join(migrationsDir, 'keep.js'), 'keep');
        const db = new BaseDatabase(new FakeDriver('mysql'), [ResetMigrationUser]);

        const result = await resetMigrations(db, { migrationsDir });

        assert.deepStrictEqual(result.removedFiles, ['99999999_999999_old.ts']);
        assert.equal(existsSync(join(migrationsDir, '99999999_999999_old.ts')), false);
        assert.equal(existsSync(join(migrationsDir, 'keep.js')), true);
        assert.equal(result.tableCount, 1);
        assert.equal(result.migrationPath, join(migrationsDir, '00000000_000000_base.ts'));
        const content = readFileSync(result.migrationPath, 'utf8');
        assert.match(content, /CREATE TABLE \\`tsf_reset_users\\`/);
        assert.match(content, /\\`name\\` varchar\(80\) NOT NULL/);
    });

    it('creates a migrations directory during reset and skips base file creation without entities', async () => {
        const root = tempDir();
        const migrationsDir = join(root, 'src', 'migrations');
        const db = new BaseDatabase(new FakeDriver('postgres'));

        const result = await resetMigrations(db, { migrationsDir });

        assert.equal(existsSync(migrationsDir), true);
        assert.equal(result.tableCount, 0);
        assert.equal(result.migrationPath, undefined);
    });

    it('standardizes MySQL database and table collations', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [[{ databaseName: 'app_db' }], [{ Tables_in_app_db: 'users' }, { Tables_in_app_db: 'posts' }]];
        const db = new BaseDatabase(driver);

        const result = await standardizeDbCollation(db, {
            charset: 'latin1',
            collation: 'latin1_swedish_ci'
        });

        assert.deepStrictEqual(result, {
            skipped: false,
            databaseName: 'app_db',
            tables: ['users', 'posts']
        });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT DATABASE() AS `databaseName`',
            bindings: []
        });
        assert.deepStrictEqual(driver.queries[1], {
            sql: 'SHOW TABLES',
            bindings: []
        });
        assert.match(driver.executes[0].sql, /ALTER DATABASE `app_db` CHARACTER SET = latin1 COLLATE = latin1_swedish_ci/);
        assert.match(driver.executes[1].sql, /ALTER TABLE `users` CONVERT TO CHARACTER SET latin1 COLLATE latin1_swedish_ci/);
        assert.match(driver.executes[2].sql, /ALTER TABLE `posts` CONVERT TO CHARACTER SET latin1 COLLATE latin1_swedish_ci/);
    });

    it('skips collation standardization on PostgreSQL', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver);
        const warnings: unknown[][] = [];
        const warn = console.warn;
        console.warn = (...args: unknown[]) => {
            warnings.push(args);
        };

        try {
            const result = await standardizeDbCollation(db);

            assert.deepStrictEqual(result, { skipped: true, tables: [] });
            assert.deepStrictEqual(driver.queries, []);
            assert.deepStrictEqual(driver.executes, []);
            assert.match(String(warnings[0]?.[0]), /not applicable to PostgreSQL/);
        } finally {
            console.warn = warn;
        }
    });

    it('rejects unsafe MySQL charset and collation names', async () => {
        const db = new BaseDatabase(new FakeDriver('mysql'));

        await assert.rejects(() => standardizeDbCollation(db, { charset: 'utf8mb4;DROP' }), /Invalid MySQL charset/);
        await assert.rejects(() => standardizeDbCollation(db, { collation: 'utf8mb4-0900-ai-ci' }), /Invalid MySQL collation/);
    });
});
