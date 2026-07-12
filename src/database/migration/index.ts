import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sql } from '../sql';
import type { BaseDatabase } from '../database';
import { createLogger, type LoggerInterface } from '../../services/logger';
import { resolveTypeScriptOutputPath } from '../../typescript-output';

export * from './create';
export * from './maintenance';

export type MigrationFunction<T extends BaseDatabase = BaseDatabase> = (db: T) => Promise<void> | void;

export interface Migration<T extends BaseDatabase = BaseDatabase> {
    name: string;
    up: MigrationFunction<T>;
}

export interface MigrationExecution {
    name: string;
    executedAt: Date;
    durationMs: number;
}

export interface MigrationRunOptions<T extends BaseDatabase = BaseDatabase> {
    beforeRun?: MigrationFunction<T>;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

export function createMigration<T extends BaseDatabase>(fn: MigrationFunction<T>): MigrationFunction<T> {
    return fn;
}

export function defineMigration<T extends BaseDatabase>(name: string, up: MigrationFunction<T>): Migration<T> {
    return { name, up };
}

export class MigrationRunner<T extends BaseDatabase = BaseDatabase> {
    constructor(
        readonly db: T,
        readonly tableName = '_migrations',
        private readonly logger: LoggerInterface = createLogger('Migrator')
    ) {}

    async run(migrations: readonly Migration<T>[], options: MigrationRunOptions<T> = {}): Promise<MigrationExecution[]> {
        return this.db.withConnection(async () => {
            await options.beforeRun?.(this.db);
            const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
            this.logger.info(`${ordered.length} migrations found in package`);
            await this.createMigrationsTableIfNotExists();
            const executedMigrationNames = await this.getExecutedMigrationNames();
            const executed = new Set(executedMigrationNames);
            const pending = ordered.filter(migration => !executed.has(migration.name));
            const completed: MigrationExecution[] = [];

            this.logger.info(`${executedMigrationNames.length} migrations previously executed`);
            this.logger.info(`${pending.length} migrations to run`);

            for (const migration of pending) {
                const startedAt = Date.now();
                this.logger.info(`Running migration: ${migration.name}`);
                try {
                    await migration.up(this.db);
                } catch (error) {
                    this.logger.error('Migration function failed to execute', error, { file: migration.name });
                    throw error;
                }
                const execution: MigrationExecution = {
                    name: migration.name,
                    executedAt: new Date(),
                    durationMs: Date.now() - startedAt
                };
                await this.recordMigration(execution);
                completed.push(execution);
                this.logger.info(`Completed migration: ${migration.name}`, {
                    durationMs: execution.durationMs
                });
            }

            return completed;
        });
    }

    async getExecutedMigrationNames(): Promise<string[]> {
        const rows = await this.db.rawFind<Record<string, unknown>>(sql`SELECT ${sql.identifier('name')} FROM ${sql.identifier(this.tableName)}`);
        return rows.map(row => String(row.name));
    }

    async createMigrationsTableIfNotExists(): Promise<void> {
        if (this.db.driver.dialect === 'postgres') {
            await this.db.rawExecute(sql`
                CREATE TABLE IF NOT EXISTS ${sql.identifier(this.tableName)} (
                    ${sql.identifier('name')} varchar(255) NOT NULL PRIMARY KEY,
                    ${sql.identifier('executedAt')} timestamp NOT NULL,
                    ${sql.identifier('durationMs')} integer NOT NULL
                )
            `);
            return;
        }

        await this.db.rawExecute(sql`
            CREATE TABLE IF NOT EXISTS ${sql.identifier(this.tableName)} (
                ${sql.identifier('name')} varchar(255) NOT NULL,
                ${sql.identifier('executedAt')} datetime NOT NULL,
                ${sql.identifier('durationMs')} int unsigned NOT NULL,
                PRIMARY KEY (${sql.identifier('name')})
            )
        `);
    }

    private async recordMigration(execution: MigrationExecution): Promise<void> {
        await this.db.rawExecute(
            sql`INSERT INTO ${sql.identifier(this.tableName)} (${sql.identifier('name')}, ${sql.identifier('executedAt')}, ${sql.identifier(
                'durationMs'
            )}) VALUES (${execution.name}, ${execution.executedAt}, ${execution.durationMs})`
        );
    }
}

export async function runMigrations<T extends BaseDatabase>(
    db: T,
    migrations: readonly Migration<T>[],
    options?: MigrationRunOptions<T>
): Promise<MigrationExecution[]> {
    return new MigrationRunner(db).run(migrations, options);
}

export async function loadMigrationsFromDirectory<T extends BaseDatabase = BaseDatabase>(directory: string): Promise<Migration<T>[]> {
    const migrationDirectory = resolveRunnableMigrationsDirectory(directory);
    if (!migrationDirectory) return [];
    const files = readdirSync(migrationDirectory)
        .filter(file => /\.(c?js|mjs)$/.test(file))
        .sort();
    const migrations: Migration<T>[] = [];

    for (const file of files) {
        const modulePath = resolve(migrationDirectory, file);
        const loaded = await loadMigrationModule<T>(modulePath);
        const value = loaded.default ?? loaded.migration;
        if (typeof value === 'function') {
            migrations.push({ name: basename(file, extname(file)), up: value });
        } else if (value && typeof value === 'object' && typeof value.up === 'function') {
            migrations.push({ ...value, name: value.name || basename(file, extname(file)) });
        } else {
            throw new Error(`Migration ${modulePath} must export a migration function as default`);
        }
    }

    return migrations;
}

async function loadMigrationModule<T extends BaseDatabase>(
    modulePath: string
): Promise<{
    default?: MigrationFunction<T> | Migration<T>;
    migration?: MigrationFunction<T> | Migration<T>;
}> {
    if (extname(modulePath) === '.mjs') {
        return (await dynamicImport(pathToFileURL(modulePath).href)) as {
            default?: MigrationFunction<T> | Migration<T>;
            migration?: MigrationFunction<T> | Migration<T>;
        };
    }
    try {
        return require(modulePath) as {
            default?: MigrationFunction<T> | Migration<T>;
            migration?: MigrationFunction<T> | Migration<T>;
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_REQUIRE_ESM') throw error;
        return (await dynamicImport(pathToFileURL(modulePath).href)) as {
            default?: MigrationFunction<T> | Migration<T>;
            migration?: MigrationFunction<T> | Migration<T>;
        };
    }
}

function resolveRunnableMigrationsDirectory(directory: string): string | undefined {
    const absolute = resolve(directory);
    if (existsSync(absolute) && hasRunnableMigrationFiles(absolute)) return absolute;

    const candidates = compiledMigrationDirectoryCandidates(absolute);
    for (const candidate of candidates) {
        if (existsSync(candidate) && hasRunnableMigrationFiles(candidate)) return candidate;
    }

    if (existsSync(absolute) && hasSourceMigrationFiles(absolute)) {
        throw new Error(
            `Found source migrations in ${absolute}, but no compiled migrations were found. Searched: ${candidates.join(', ') || '(no compiled path could be resolved)'}`
        );
    }

    return existsSync(absolute) ? absolute : undefined;
}

function hasRunnableMigrationFiles(directory: string): boolean {
    return readdirSync(directory).some(file => /\.(c?js|mjs)$/.test(file));
}

function hasSourceMigrationFiles(directory: string): boolean {
    return readdirSync(directory).some(file => /\.(?:cts|mts|tsx?)$/.test(file) && !file.endsWith('.d.ts'));
}

function compiledMigrationDirectoryCandidates(sourceDirectory: string): string[] {
    const candidates: string[] = [];
    const configuredOutput = resolveTypeScriptOutputPath(sourceDirectory, { cwd: process.cwd() });
    if (configuredOutput && configuredOutput !== sourceDirectory) candidates.push(configuredOutput);

    const segments = sourceDirectory.split(/[\\/]/);
    const srcIndex = segments.lastIndexOf('src');
    if (srcIndex !== -1) {
        const base = segments.slice(0, srcIndex).join(sep) || sep;
        candidates.push(join(base, 'dist', ...segments.slice(srcIndex)));
        candidates.push(join(base, 'dist', ...segments.slice(srcIndex + 1)));
    } else if (!sourceDirectory.split(/[\\/]/).includes('dist')) {
        candidates.push(join(dirname(sourceDirectory), 'dist', basename(sourceDirectory)));
    }

    return [...new Set(candidates.map(candidate => (isAbsolute(candidate) ? candidate : resolve(candidate))))];
}

export async function runMigrationsFromDirectory<T extends BaseDatabase>(db: T, directory: string): Promise<MigrationExecution[]> {
    return new MigrationRunner(db).run(await loadMigrationsFromDirectory<T>(directory));
}
