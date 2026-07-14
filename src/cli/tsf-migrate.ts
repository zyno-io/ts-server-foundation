#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    App,
    BaseDatabase,
    createMigrationPlan,
    loadMigrationsFromDirectory,
    MigrationRunner,
    resetMigrations,
    standardizeDbCollation,
    WorkerQueueRegistry,
    WorkerRunnerService,
    writeMigrationFile
} from '..';
import { resolveTypeScriptOutputPath } from '../typescript-output';

interface MigrateCliOptions {
    appPath: string;
    description: string;
    migrationsDir: string;
    pgSchema?: string;
    tableNames?: string[];
    positionals: string[];
}

async function main(args = process.argv.slice(2)): Promise<number> {
    const [command, ...rest] = args;
    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return command ? 0 : 1;
    }

    switch (command) {
        case 'create':
        case 'create:raw':
            return create(parseOptions(rest));
        case 'run':
            return run(parseOptions(rest));
        case 'reset':
            return reset(parseOptions(rest));
        case 'charset':
            return charset(parseOptions(rest, { allowPositionals: true }));
        default:
            console.error(`Unknown migrate command: ${command}`);
            printUsage();
            return 1;
    }
}

function printUsage(): void {
    console.error(`Usage: tsf-migrate <command> [options]

Commands:
  create                    Create a raw SQL migration from entity/database diff
  run                       Run compiled migrations from dist
  reset                     Remove source migrations and create a base migration
  charset [charset collation]
                            Standardize MySQL database/table charset and collation

Options:
  --app <path>              Compiled app module, default emitted path for src/app.ts
  --description <text>      Migration description, default auto_migration
  --migrations-dir <path>   Source migrations dir for create, default src/migrations
  --pg-schema <schema>      PostgreSQL schema, default public
  --table <name>            Limit create diff to a table, repeatable
  --tables <a,b>            Limit create diff to comma-separated tables`);
}

async function create(options: MigrateCliOptions): Promise<number> {
    const app = loadApp(options.appPath);
    const db = getDatabase(app);
    try {
        const plan = await createMigrationPlan(db, {
            pgSchema: options.pgSchema,
            tableNames: options.tableNames
        });
        if (!plan.hasChanges) {
            console.log('No schema changes detected.');
            return 0;
        }

        const file = writeMigrationFile(plan.statements, options.description, {
            migrationsDir: options.migrationsDir
        });
        console.log(`Created migration: ${file}`);
        return 0;
    } finally {
        await closeDatabase(db);
    }
}

async function run(options: MigrateCliOptions): Promise<number> {
    const app = loadApp(options.appPath);
    const db = getDatabase(app);
    try {
        const migrations = await loadMigrationsFromDirectory(options.migrationsDir);
        const executions = await new MigrationRunner(db).run(migrations);
        if (app.options.enableWorker) await app.get(WorkerRunnerService).removeStaleBullMqCronJobs();
        console.log(`Ran ${executions.length} migration(s).`);
        return 0;
    } finally {
        if (app.options.enableWorker) await app.get(WorkerQueueRegistry).shutdown();
        await closeDatabase(db);
    }
}

async function reset(options: MigrateCliOptions): Promise<number> {
    const app = loadApp(options.appPath);
    const db = getDatabase(app);
    try {
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
        return 0;
    } finally {
        await closeDatabase(db);
    }
}

async function charset(options: MigrateCliOptions): Promise<number> {
    if (options.positionals.length > 2) throw new Error('charset accepts at most charset and collation arguments');
    const app = loadApp(options.appPath);
    const db = getDatabase(app);
    try {
        const result = await standardizeDbCollation(db, {
            charset: options.positionals[0],
            collation: options.positionals[1]
        });
        if (!result.skipped) {
            console.log(`Standardized ${result.tables.length} table(s) in ${result.databaseName}.`);
        }
        return 0;
    } finally {
        await closeDatabase(db);
    }
}

function parseOptions(args: string[], options: { allowPositionals?: boolean } = {}): MigrateCliOptions {
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
                if (arg.startsWith('--app=')) appPath = arg.slice('--app='.length);
                else if (arg.startsWith('--description=')) description = arg.slice('--description='.length);
                else if (arg.startsWith('--migrations-dir=')) migrationsDir = arg.slice('--migrations-dir='.length);
                else if (arg.startsWith('--pg-schema=')) pgSchema = parseNonEmptyValue(arg.slice('--pg-schema='.length), '--pg-schema');
                else if (arg.startsWith('--table=')) tableNames.push(parseTableName(arg.slice('--table='.length), '--table'));
                else if (arg.startsWith('--tables=')) tableNames.push(...splitTableNames(arg.slice('--tables='.length)));
                else if (options.allowPositionals && !arg.startsWith('-')) positionals.push(arg);
                else throw new Error(`Unknown option: ${arg}`);
        }
    }

    return {
        appPath: appPath ? resolve(appPath) : (resolveTypeScriptOutputPath('src/app.ts') ?? resolve('dist/src/app.js')),
        description,
        migrationsDir: resolve(migrationsDir),
        pgSchema,
        tableNames: tableNames.length ? [...new Set(tableNames)] : undefined,
        positionals
    };
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

function parseNonEmptyValue(value: string, flag: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${flag} requires a non-empty value`);
    return trimmed;
}

function parseTableName(value: string, flag: string): string {
    return parseNonEmptyValue(value, flag);
}

function loadApp(appPath: string): App {
    if (!existsSync(appPath)) throw new Error(`App module not found: ${appPath}`);
    const loaded = require(appPath) as Record<string, unknown>;
    const primary = coerceAppExport(loaded.app, 'app');
    if (primary) return primary;
    const defaultExport = coerceAppExport(loaded.default, 'default');
    if (defaultExport) return defaultExport;

    for (const [name, value] of Object.entries(loaded)) {
        if (name === 'app' || name === 'default' || name === 'createApp') continue;
        if (!/^create.*App$/.test(name)) continue;
        const app = coerceAppExport(value, name, true);
        if (app) return app;
    }

    throw new Error(`App module ${appPath} must export an App instance or zero-argument app factory as "app" or default`);
}

function coerceAppExport(value: unknown, exportName: string, requireFactory = false): App | undefined {
    if (value instanceof App) return value;
    if (typeof value !== 'function') {
        if (requireFactory && value !== undefined) throw new Error(`Export "${exportName}" is not an App instance or app factory`);
        return undefined;
    }
    if (value.length > 0) return undefined;
    const app = value();
    if (app instanceof App) return app;
    throw new Error(`Export "${exportName}" did not return an App instance`);
}

function getDatabase(app: App): BaseDatabase {
    return app.get(BaseDatabase);
}

async function closeDatabase(db: BaseDatabase): Promise<void> {
    await db.driver.close();
}

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(error => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        });
}
