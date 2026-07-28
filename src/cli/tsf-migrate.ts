#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { App } from '..';
import { resolveTypeScriptOutputPath } from '../typescript-output';
import { executeMigrationCommand, parseMigrationCommandOptions, type MigrationEntrypointCommand } from '../app/migrations-entrypoint';

async function main(args = process.argv.slice(2)): Promise<number> {
    const [command, ...rest] = args;
    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return command ? 0 : 1;
    }

    switch (command) {
        case 'create':
        case 'create:raw':
            return execute('create', rest);
        case 'run':
            return execute('run', rest);
        case 'reset':
            return execute('reset', rest);
        case 'charset':
            return execute('charset', rest);
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

async function execute(command: MigrationEntrypointCommand, args: string[]): Promise<number> {
    const options = parseMigrationCommandOptions(command, args, { allowApp: true });
    const appPath = options.appPath ?? resolveTypeScriptOutputPath('src/app.ts') ?? resolve('dist/src/app.js');
    const app = loadApp(appPath);
    await executeMigrationCommand(app, command, options);
    return 0;
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

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(error => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        });
}
