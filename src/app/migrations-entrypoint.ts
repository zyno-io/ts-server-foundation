import { resolve } from 'node:path';

import {
    BaseDatabase,
    createMigrationPlan,
    loadMigrationsFromDirectory,
    MigrationRunner,
    resetMigrations,
    standardizeDbCollation,
    writeMigrationFile
} from '../database';
import { WorkerQueueRegistry, WorkerRunnerService } from '../services';

import type { App } from './base';

export type MigrationEntrypointCommand = 'create' | 'run' | 'reset' | 'charset';

export interface MigrationCommandOptions {
    appPath?: string;
    description: string;
    migrationsDir: string;
    pgSchema?: string;
    tableNames?: string[];
    positionals: string[];
}

export function parseMigrationCommandOptions(
    command: MigrationEntrypointCommand,
    args: string[],
    options: { allowApp?: boolean } = {}
): MigrationCommandOptions {
    let appPath: string | undefined;
    let description = 'auto_migration';
    let migrationsDir = 'src/migrations';
    let pgSchema: string | undefined;
    const tableNames: string[] = [];
    const positionals: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        switch (arg) {
            case '--app':
                if (!options.allowApp) throw new Error(`Unknown option: ${arg}`);
                appPath = requiredValue(args, ++index, arg);
                break;
            case '--description':
            case '-d':
                description = requiredValue(args, ++index, arg);
                break;
            case '--migrations-dir':
                migrationsDir = requiredValue(args, ++index, arg);
                break;
            case '--pg-schema':
                pgSchema = requiredNonEmptyValue(args, ++index, arg);
                break;
            case '--table':
                tableNames.push(parseTableName(requiredValue(args, ++index, arg), arg));
                break;
            case '--tables':
                tableNames.push(...splitTableNames(requiredValue(args, ++index, arg)));
                break;
            default:
                if (options.allowApp && arg.startsWith('--app=')) appPath = arg.slice('--app='.length);
                else if (arg.startsWith('--description=')) description = arg.slice('--description='.length);
                else if (arg.startsWith('--migrations-dir=')) migrationsDir = arg.slice('--migrations-dir='.length);
                else if (arg.startsWith('--pg-schema=')) pgSchema = parseNonEmptyValue(arg.slice('--pg-schema='.length), '--pg-schema');
                else if (arg.startsWith('--table=')) tableNames.push(parseTableName(arg.slice('--table='.length), '--table'));
                else if (arg.startsWith('--tables=')) tableNames.push(...splitTableNames(arg.slice('--tables='.length)));
                else if (command === 'charset' && !arg.startsWith('-')) positionals.push(arg);
                else throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (command === 'charset' && positionals.length > 2) throw new Error('charset accepts at most charset and collation arguments');

    return {
        appPath: appPath ? resolve(appPath) : undefined,
        description,
        migrationsDir: resolve(migrationsDir),
        pgSchema,
        tableNames: tableNames.length ? [...new Set(tableNames)] : undefined,
        positionals
    };
}

export async function executeMigrationCommand(app: App<any>, command: MigrationEntrypointCommand, options: MigrationCommandOptions): Promise<void> {
    const db = app.get(BaseDatabase);
    try {
        switch (command) {
            case 'create':
                await createMigration(db, options);
                return;
            case 'run':
                await runMigrations(app, db, options);
                return;
            case 'reset':
                await resetMigrationFiles(db, options);
                return;
            case 'charset':
                await standardizeCharset(db, options);
                return;
        }
    } finally {
        if (command === 'run' && app.options.enableWorker) await app.get(WorkerQueueRegistry).shutdown();
        await db.driver.close();
    }
}

async function createMigration(db: BaseDatabase, options: MigrationCommandOptions): Promise<void> {
    const plan = await createMigrationPlan(db, {
        pgSchema: options.pgSchema,
        tableNames: options.tableNames
    });
    if (!plan.hasChanges) {
        console.log('No schema changes detected.');
        return;
    }

    const file = writeMigrationFile(plan.statements, options.description, {
        migrationsDir: options.migrationsDir
    });
    console.log(`Created migration: ${file}`);
}

async function runMigrations(app: App<any>, db: BaseDatabase, options: MigrationCommandOptions): Promise<void> {
    const migrations = await loadMigrationsFromDirectory(options.migrationsDir);
    const executions = await new MigrationRunner(db).run(migrations);
    if (app.options.enableWorker) await app.get(WorkerRunnerService).removeStaleBullMqCronJobs();
    console.log(`Ran ${executions.length} migration(s).`);
}

async function resetMigrationFiles(db: BaseDatabase, options: MigrationCommandOptions): Promise<void> {
    const result = await resetMigrations(db, {
        migrationsDir: options.migrationsDir,
        pgSchema: options.pgSchema
    });
    console.log(`Removed ${result.removedFiles.length} migration file(s).`);
    if (result.migrationPath) {
        console.log(`Created base migration: ${result.migrationPath}`);
    } else {
        console.log('No entity tables found; no base migration created.');
    }
}

async function standardizeCharset(db: BaseDatabase, options: MigrationCommandOptions): Promise<void> {
    const result = await standardizeDbCollation(db, {
        charset: options.positionals[0],
        collation: options.positionals[1]
    });
    if (!result.skipped) console.log(`Standardized ${result.tables.length} table(s) in ${result.databaseName}.`);
}

function splitTableNames(value: string): string[] {
    const parts = value.split(',').map(table => table.trim());
    if (!parts.length || parts.some(table => !table)) throw new Error('--tables requires one or more non-empty table names');
    return parts;
}

function requiredValue(args: string[], index: number, flag: string): string {
    const value = args[index];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
}

function requiredNonEmptyValue(args: string[], index: number, flag: string): string {
    return parseNonEmptyValue(requiredValue(args, index, flag), flag);
}

function parseTableName(value: string, flag: string): string {
    return parseNonEmptyValue(value, flag);
}

function parseNonEmptyValue(value: string, flag: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${flag} requires a non-empty value`);
    return trimmed;
}
