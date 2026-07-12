#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-require-imports */

import { spawn } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { BaseAppConfig, ConfigLoader } from '../app';
import { Env, type EnvObject } from '../env';
import { runNode } from './common';
import { resolveTypeScriptOutDir, resolveTypeScriptOutputPath } from '../typescript-output';

interface MySQLSessionManagerHandle {
    env: EnvObject;
    stop(): Promise<void>;
}

export async function runTestCli(args = process.argv.slice(2)): Promise<number> {
    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        return 0;
    }

    Env.TZ = 'UTC';
    Env.APP_ENV = 'test';

    const distDir = resolveTypeScriptOutDir({ tsconfigPath: Env.TSF_TSCONFIG }) ?? resolve('dist');
    const teardown = await runGlobalSetup(distDir);
    let manager: MySQLSessionManagerHandle | undefined;
    try {
        const { nodeArgs, fileArgs } = splitArgs(args);
        const testFiles = collectTestFiles(distDir, fileArgs);
        if (testFiles.length === 0) {
            console.error(`No compiled test files found in ${distDir}.`);
            return 1;
        }

        const resolvedDatabaseEnv = resolveTestDatabaseEnv();
        const testRunTs = Env.TEST_RUN_TS ?? String(Math.floor(Date.now() / 1000));
        Env.TEST_RUN_TS = testRunTs;
        const mysqlSessionPoolSize = resolveTestWorkerConcurrency(nodeArgs);
        manager = await startMySQLSessionManagerIfNeeded(testRunTs, resolvedDatabaseEnv, mysqlSessionPoolSize);
        const result = runNode(
            ['--enable-source-maps', ...nodeArgs, '--test', '--test-force-exit', '--test-timeout=180000', ...testFiles],
            process.cwd(),
            {
                ...resolvedDatabaseEnv,
                APP_ENV: 'test',
                TZ: 'UTC',
                TEST_RUN_TS: testRunTs,
                ...manager?.env
            }
        );
        return result.status;
    } finally {
        await manager?.stop();
        if (teardown) await teardown();
    }
}

function printUsage(): void {
    console.log(`Usage: tsf-test [node-test-options] [test-files-or-dirs...]

Runs compiled node:test specs from the configured TypeScript outDir. Source paths
are mapped using rootDir and outDir from the effective tsconfig.`);
}

async function runGlobalSetup(distDir: string): Promise<(() => Promise<void>) | undefined> {
    const setupPath = findGlobalSetupPath(distDir);
    if (!setupPath) return undefined;
    const beforeRequireEnv = snapshotProcessEnv();
    const globalSetup = require(setupPath) as {
        setup?: () => Promise<void> | void;
        teardown?: () => Promise<void> | void;
    };
    const requireEnvPatch = diffProcessEnv(beforeRequireEnv, snapshotProcessEnv());
    if (globalSetup.setup) await globalSetup.setup();
    applyProcessEnvPatch(requireEnvPatch);
    return globalSetup.teardown ? () => Promise.resolve(globalSetup.teardown!()) : undefined;
}

function findGlobalSetupPath(distDir: string): string | undefined {
    const candidates = [
        resolveTypeScriptOutputPath('tests/shared/globalSetup.ts', { tsconfigPath: Env.TSF_TSCONFIG }),
        resolveTypeScriptOutputPath('src/tests/shared/globalSetup.ts', { tsconfigPath: Env.TSF_TSCONFIG }),
        join(distDir, 'tests', 'shared', 'globalSetup.js')
    ].filter((path): path is string => !!path && existsSync(path));
    return [...new Set(candidates)][0];
}

function snapshotProcessEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

function diffProcessEnv(before: NodeJS.ProcessEnv, after: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const patch: NodeJS.ProcessEnv = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[key] !== after[key]) patch[key] = after[key];
    }
    return patch;
}

function applyProcessEnvPatch(patch: NodeJS.ProcessEnv): void {
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

async function startMySQLSessionManagerIfNeeded(
    testRunTs: string,
    databaseEnv: EnvObject,
    poolSize: number
): Promise<MySQLSessionManagerHandle | undefined> {
    if (!shouldStartMySQLSessionManager(databaseEnv)) return undefined;
    const child = spawn(process.execPath, [join(__dirname, '..', 'testing', 'mysql-session-manager-process.js')], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            ...databaseEnv,
            APP_ENV: 'test',
            TZ: 'UTC',
            TEST_RUN_TS: testRunTs,
            TSF_TEST_MYSQL_SESSION_POOL_SIZE: String(poolSize)
        },
        stdio: ['ignore', 'pipe', 'inherit']
    });

    let ready: { port: number; token: string };
    try {
        ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for MySQL session manager to start')), 10_000);
            let buffer = '';
            let settled = false;
            const settle = (worker: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                worker();
            };

            child.stdout?.on('data', data => {
                buffer += data.toString();
                while (true) {
                    const newline = buffer.indexOf('\n');
                    if (newline === -1) return;
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    const prefix = 'TSF_MYSQL_SESSION_MANAGER_READY ';
                    if (line.startsWith(prefix)) {
                        settle(() => resolve(JSON.parse(line.slice(prefix.length)) as { port: number; token: string }));
                    } else if (line.trim()) {
                        process.stdout.write(`${line}\n`);
                    }
                }
            });
            child.once('error', error => settle(() => reject(error)));
            child.once('exit', code => {
                if (!settled) settle(() => reject(new Error(`MySQL session manager exited before startup with code ${code}`)));
            });
        });
    } catch (error) {
        child.kill('SIGTERM');
        throw error;
    }
    console.log('tsf-test: shared MySQL session manager enabled');

    let closed = false;
    const closePromise = new Promise<void>(resolve => {
        child.once('close', () => {
            closed = true;
            resolve();
        });
    });

    return {
        env: {
            TSF_TEST_MYSQL_SESSION_MANAGER: '1',
            TSF_TEST_MYSQL_SESSION_POOL_SIZE: String(poolSize),
            TSF_TEST_MYSQL_SESSION_MANAGER_PORT: String(ready.port),
            TSF_TEST_MYSQL_SESSION_MANAGER_TOKEN: ready.token
        },
        async stop() {
            if (closed) return;
            child.kill('SIGTERM');
            await Promise.race([
                closePromise,
                sleep(3_000).then(() => {
                    if (!closed) child.kill('SIGKILL');
                })
            ]);
        }
    };
}

function shouldStartMySQLSessionManager(databaseEnv: EnvObject): boolean {
    const flag = Env.TSF_TEST_MYSQL_SESSION_MANAGER;
    if (Env.TSF_TEST_ALLOW_SAVEPOINTS !== undefined && !isEnabledFlag(Env.TSF_TEST_ALLOW_SAVEPOINTS)) return false;
    if (flag === '0' || flag === 'false') return false;
    if (Env.TSF_TEST_MYSQL_SESSION_MANAGER_PORT) return false;
    const dbAdapter = databaseEnv.DB_ADAPTER ?? Env.DB_ADAPTER;
    const mysqlHost = databaseEnv.MYSQL_HOST ?? Env.MYSQL_HOST;
    const mysqlUser = databaseEnv.MYSQL_USER ?? Env.MYSQL_USER;
    if (!mysqlHost || !mysqlUser) return flag === '1' || flag === 'true';
    if (dbAdapter && dbAdapter !== 'mysql') return flag === '1' || flag === 'true';
    return true;
}

export function resolveTestWorkerConcurrency(nodeArgs: readonly string[]): number {
    let resolved: number | undefined;
    for (let index = 0; index < nodeArgs.length; index++) {
        const arg = nodeArgs[index];
        if (arg === '--test-concurrency') {
            resolved = parseTestConcurrency(nodeArgs[index + 1]);
            index++;
            continue;
        }
        if (arg.startsWith('--test-concurrency=')) {
            resolved = parseTestConcurrency(arg.slice('--test-concurrency='.length));
        }
    }
    return resolved ?? defaultTestWorkerConcurrency();
}

function parseTestConcurrency(value: string | undefined): number | undefined {
    if (value === 'false') return 1;
    if (!value || value === 'true') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return undefined;
    return Math.floor(parsed);
}

function defaultTestWorkerConcurrency(): number {
    return Math.max(1, availableParallelism() - 1);
}

function resolveTestDatabaseEnv(): EnvObject {
    try {
        const config = new ConfigLoader(BaseAppConfig).load();
        return compactEnv({
            DB_ADAPTER: config.DB_ADAPTER,
            MYSQL_HOST: config.MYSQL_HOST,
            MYSQL_PORT: config.MYSQL_PORT,
            MYSQL_USER: config.MYSQL_USER,
            MYSQL_PASSWORD_SECRET: config.MYSQL_PASSWORD_SECRET,
            MYSQL_DATABASE: config.MYSQL_DATABASE,
            MYSQL_CONNECTION_LIMIT: config.MYSQL_CONNECTION_LIMIT,
            MYSQL_MIN_IDLE_CONNECTIONS: config.MYSQL_MIN_IDLE_CONNECTIONS,
            MYSQL_IDLE_TIMEOUT_SECONDS: config.MYSQL_IDLE_TIMEOUT_SECONDS,
            PG_HOST: config.PG_HOST,
            PG_PORT: config.PG_PORT,
            PG_USER: config.PG_USER,
            PG_PASSWORD_SECRET: config.PG_PASSWORD_SECRET,
            PG_DATABASE: config.PG_DATABASE,
            PG_SCHEMA: config.PG_SCHEMA,
            PG_SSL: config.PG_SSL,
            PG_SSL_REJECT_UNAUTHORIZED: config.PG_SSL_REJECT_UNAUTHORIZED,
            PG_CONNECTION_LIMIT: config.PG_CONNECTION_LIMIT,
            PG_IDLE_TIMEOUT_SECONDS: config.PG_IDLE_TIMEOUT_SECONDS
        });
    } catch {
        return {};
    }
}

function compactEnv(values: Record<string, string | number | boolean | undefined>): EnvObject {
    const env: EnvObject = {};
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) env[key] = String(value);
    }
    return env;
}

function isEnabledFlag(value: string | undefined): boolean {
    return value === '1' || value === 'true';
}

function splitArgs(args: string[]): { nodeArgs: string[]; fileArgs: string[] } {
    const nodeArgs: string[] = [];
    const fileArgs: string[] = [];
    let fileMode = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (fileMode) {
            fileArgs.push(arg);
            continue;
        }
        if (arg === '--') {
            fileMode = true;
            continue;
        }
        if (arg.startsWith('-')) {
            nodeArgs.push(arg);
            if (optionTakesValue(arg) && args[index + 1] && !args[index + 1].startsWith('-')) {
                nodeArgs.push(args[index + 1]);
                index++;
            }
        } else {
            fileArgs.push(arg);
        }
    }
    return { nodeArgs, fileArgs };
}

function collectTestFiles(distDir: string, fileArgs: string[]): string[] {
    if (fileArgs.length === 0) return globSync(join(distDir, '**/*.spec.js'));

    const testFiles: string[] = [];
    for (const fileArg of fileArgs) {
        const distPath = toDistTestPath(fileArg, distDir);
        if (distPath.endsWith('/') || !distPath.split(/[\\/]/).pop()?.includes('.')) {
            testFiles.push(...globSync(join(distPath, '**/*.spec.js')));
        } else {
            testFiles.push(distPath);
        }
    }
    return testFiles;
}

function toDistTestPath(fileArg: string, distDir: string): string {
    const absoluteInput = isAbsolute(fileArg) ? fileArg : resolve(fileArg);
    const relativeToDist = relative(distDir, absoluteInput);
    if (relativeToDist !== '..' && !relativeToDist.startsWith(`..${sep}`) && !isAbsolute(relativeToDist)) {
        return replaceTestExtension(absoluteInput);
    }

    const emitted = resolveTypeScriptOutputPath(absoluteInput, { tsconfigPath: Env.TSF_TSCONFIG });
    if (emitted) return emitted;

    let normalized = isAbsolute(fileArg) ? relative(process.cwd(), fileArg) : fileArg;
    normalized = normalized.replace(/\\/g, '/').replace(/^\.\//, '');
    return replaceTestExtension(resolve(distDir, normalized));
}

function replaceTestExtension(path: string): string {
    return path.replace(/\.(?:cts|mts|tsx?)$/, extension => (extension === '.mts' ? '.mjs' : extension === '.cts' ? '.cjs' : '.js'));
}

function optionTakesValue(arg: string): boolean {
    if (arg.includes('=')) return false;
    return OPTIONS_WITH_VALUES.has(arg);
}

const OPTIONS_WITH_VALUES = new Set([
    '--conditions',
    '--cpu-prof-dir',
    '--diagnostic-dir',
    '--experimental-loader',
    '--import',
    '--inspect-port',
    '--loader',
    '--require',
    '--test-concurrency',
    '--test-coverage-branches',
    '--test-coverage-exclude',
    '--test-coverage-functions',
    '--test-coverage-include',
    '--test-coverage-lines',
    '--test-name-pattern',
    '--test-reporter',
    '--test-reporter-destination',
    '--test-shard',
    '--test-timeout',
    '-C',
    '-r'
]);

if (require.main === module) {
    runTestCli()
        .then(code => process.exit(code))
        .catch(error => {
            console.error('Test runner error:', error);
            process.exit(1);
        });
}
