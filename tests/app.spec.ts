import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { encryptConfigData } from '@zyno-io/config';

import {
    AutoConstruct,
    BaseAppConfig,
    BaseDatabase,
    BaseEntity,
    cli,
    ConfigLoader,
    createApp,
    createDatabaseClass,
    createModule,
    type DatabaseDriver,
    type DriverConnection,
    event,
    eventDispatcher,
    EventToken,
    http,
    type ExecuteResult,
    onAppBootstrap,
    onServerBootstrap,
    onServerMainBootstrapDone,
    onServerShutdown,
    onServerShutdownRequested,
    type QueryResult,
    registerAppCleanup,
    resetLogSink,
    setLogSink
} from '../src';

const originalEnv = { ...process.env };
const originalExecArgv = [...process.execArgv];
const originalArgv = [...process.argv];
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalExitCode = process.exitCode;
let originalCwd = process.cwd();
const tmpDirs: string[] = [];

afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    process.argv.splice(0, process.argv.length, ...originalArgv);
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exitCode = originalExitCode;
    resetLogSink();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tsf-'));
    tmpDirs.push(dir);
    process.chdir(dir);
    return dir;
}

function generateConfigKeys(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('x25519', {
        publicKeyEncoding: {
            type: 'spki',
            format: 'der'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'der'
        }
    });

    return {
        privateKey: privateKey.toString('base64').replace(/=+$/, ''),
        publicKey: publicKey.toString('base64').replace(/=+$/, '')
    };
}

class NoopConnection implements DriverConnection {
    async query<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
        return { rows: [] };
    }

    async execute(): Promise<ExecuteResult> {
        return { affectedRows: 0, rowCount: 0 };
    }

    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {}
}

class NoopDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        return new NoopConnection();
    }
}

describe('config loader', () => {
    it('loads class defaults, defaultConfig, env files, and process env with coercion', () => {
        class AppConfig extends BaseAppConfig {
            FEATURE_ENABLED: boolean = false;
            LIMIT: number = 1;
            NAME: string = 'default';
        }

        makeTempCwd();
        writeFileSync('.env.test', 'FEATURE_ENABLED=true\nLIMIT=12\nNAME=file\n');
        process.env.APP_ENV = 'test';
        process.env.NAME = 'process';

        const config = new ConfigLoader(AppConfig, { LIMIT: 3 }).load();
        assert.equal(config.APP_ENV, 'test');
        assert.equal(config.FEATURE_ENABLED, true);
        assert.equal(config.LIMIT, 12);
        assert.equal(config.NAME, 'process');
    });

    it('decrypts encrypted secret values from env files', () => {
        class AppConfig extends BaseAppConfig {
            API_SECRET!: string;
        }

        const { privateKey, publicKey } = generateConfigKeys();
        const encrypted = encryptConfigData(publicKey, { API_SECRET: 'from file' });

        makeTempCwd();
        writeFileSync('.env.test', `API_SECRET=${encrypted.API_SECRET}\n`);
        process.env.APP_ENV = 'test';
        process.env.CONFIG_DECRYPTION_SECRET = privateKey;

        const config = new ConfigLoader(AppConfig).load();

        assert.equal(config.API_SECRET, 'from file');
        assert.equal(process.env.CONFIG_DECRYPTION_SECRET, undefined);
    });

    it('decrypts encrypted secret values from process env', () => {
        class AppConfig extends BaseAppConfig {
            API_SECRET!: string;
        }

        const { privateKey, publicKey } = generateConfigKeys();
        const encrypted = encryptConfigData(publicKey, { API_SECRET: 'from process env' });

        process.env.APP_ENV = 'test';
        process.env.API_SECRET = encrypted.API_SECRET;
        process.env.CONFIG_DECRYPTION_SECRET = privateKey;

        const config = new ConfigLoader(AppConfig).load();

        assert.equal(config.API_SECRET, 'from process env');
        assert.equal(process.env.API_SECRET, encrypted.API_SECRET);
        assert.equal(process.env.CONFIG_DECRYPTION_SECRET, undefined);
    });

    it('loads config fields inherited through multiple class levels', () => {
        class SharedConfig extends BaseAppConfig {
            SHARED_NAME: string = 'default';
        }

        class AppConfig extends SharedConfig {
            FEATURE_ENABLED: boolean = false;
        }

        makeTempCwd();
        process.env.APP_ENV = 'test';
        process.env.DB_ADAPTER = 'mysql';
        process.env.MYSQL_USER = 'root';
        process.env.SHARED_NAME = 'shared';
        process.env.FEATURE_ENABLED = 'true';

        const config = new ConfigLoader(AppConfig).load();

        assert.equal(config.APP_ENV, 'test');
        assert.equal(config.DB_ADAPTER, 'mysql');
        assert.equal(config.MYSQL_USER, 'root');
        assert.equal(config.SHARED_NAME, 'shared');
        assert.equal(config.FEATURE_ENABLED, true);
        assert.equal(process.env.DB_ADAPTER, 'mysql');
        assert.equal(process.env.MYSQL_USER, 'root');
    });

    it('preserves process env keys consumed by reflected config properties', () => {
        class AppConfig extends BaseAppConfig {
            FILE_ONLY?: string;
            LIMIT: number = 1;
            NAME: string = 'default';
        }

        makeTempCwd();
        writeFileSync('.env.test', 'FILE_ONLY=file\nLIMIT=12\n');
        process.env.APP_ENV = 'test';
        process.env.LIMIT = '34';
        process.env.NAME = 'process';
        process.env.UNRELATED_ENV = 'keep';

        const config = new ConfigLoader(AppConfig).load();

        assert.equal(config.APP_ENV, 'test');
        assert.equal(config.FILE_ONLY, 'file');
        assert.equal(config.LIMIT, 34);
        assert.equal(config.NAME, 'process');
        assert.equal(process.env.APP_ENV, 'test');
        assert.equal(process.env.LIMIT, '34');
        assert.equal(process.env.NAME, 'process');
        assert.equal(process.env.FILE_ONLY, undefined);
        assert.equal(process.env.UNRELATED_ENV, 'keep');

        const childEnv = execFileSync(
            process.execPath,
            ['-e', "process.stdout.write([process.env.APP_ENV, process.env.LIMIT, process.env.NAME, process.env.UNRELATED_ENV].join(':'))"],
            { encoding: 'utf8' }
        );
        assert.equal(childEnv, 'test:34:process:keep');
    });

    it('preserves consumed process env keys even when validation fails', () => {
        class AppConfig extends BaseAppConfig {
            MODE!: 'allowed';
        }

        process.env.APP_ENV = 'test';
        process.env.MODE = 'denied';

        assert.throws(() => new ConfigLoader(AppConfig).load(), /Invalid configuration/);
        assert.equal(process.env.APP_ENV, 'test');
        assert.equal(process.env.MODE, 'denied');
    });

    it('defaults APP_ENV to development when NODE_ENV is not production', () => {
        const env = { ...process.env };
        delete env.APP_ENV;
        delete env.NODE_ENV;
        const output = execFileSync(
            process.execPath,
            [
                '-e',
                `
                    const { BaseAppConfig, ConfigLoader } = require('./dist/src');
                    class AppConfig extends BaseAppConfig {}
                    const config = new ConfigLoader(AppConfig).load();
                    process.stdout.write(config.APP_ENV);
                `
            ],
            { env, cwd: process.cwd(), encoding: 'utf8' }
        );

        assert.equal(output, 'development');
    });

    it('throws when APP_ENV is missing in production mode', () => {
        const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
        delete env.APP_ENV;
        execFileSync(
            process.execPath,
            [
                '-e',
                `
                    const { BaseAppConfig, ConfigLoader } = require('./dist/src');
                    class AppConfig extends BaseAppConfig {}
                    try {
                        new ConfigLoader(AppConfig).load();
                        process.exit(1);
                    } catch (error) {
                        if (!/APP_ENV must be specified/.test(error.message)) {
                            console.error(error);
                            process.exit(2);
                        }
                    }
                `
            ],
            { env, cwd: process.cwd(), stdio: 'pipe' }
        );
    });

    it('infers APP_ENV=test from node test exec args', () => {
        class AppConfig extends BaseAppConfig {}
        delete process.env.APP_ENV;
        process.execArgv.push('--test');

        const config = new ConfigLoader(AppConfig).load();

        assert.equal(config.APP_ENV, 'test');
    });
});

describe('app lifecycle', () => {
    it('injects config class and BaseAppConfig', () => {
        class AppConfig extends BaseAppConfig {
            CUSTOM_VALUE = 'ok';
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ config: AppConfig });

        assert.strictEqual(app.get(AppConfig), app.config);
        assert.strictEqual(app.get(BaseAppConfig), app.config);
        assert.equal(app.get(AppConfig).CUSTOM_VALUE, 'ok');
    });

    it('dispatches lifecycle events in order', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];
        const app = createApp({});

        app.on(
            onAppBootstrap,
            () => {
                order.push('bootstrap-low');
            },
            0
        );
        app.on(
            onAppBootstrap,
            () => {
                order.push('bootstrap-high');
            },
            10
        );
        app.on(onServerShutdown, () => {
            order.push('shutdown');
        });
        app.on(onServerShutdownRequested, () => {
            order.push('shutdown-requested');
        });

        await app.start();
        await app.stop();
        await app.stop();

        assert.deepStrictEqual(order, ['bootstrap-high', 'bootstrap-low', 'shutdown-requested', 'shutdown']);
    });

    it('runs registered application cleanups once in reverse acquisition order', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];
        const app = createApp({});

        app.registerCleanup(() => {
            order.push('first-cleanup');
        });
        const unregister = app.registerCleanup(() => {
            order.push('unregistered-cleanup');
        });
        registerAppCleanup(async () => {
            await Promise.resolve();
            order.push('last-cleanup');
        });
        unregister();
        app.on(onServerShutdown, () => {
            order.push('shutdown');
        });

        await app.start();
        await app.stop();
        await app.stop();

        assert.deepStrictEqual(order, ['shutdown', 'last-cleanup', 'first-cleanup']);
    });

    it('runs registered cleanups after a partial startup without dispatching shutdown events', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];
        const app = createApp({});
        app.registerCleanup(() => {
            order.push('cleanup');
        });
        app.on(onServerShutdown, () => {
            order.push('shutdown');
        });

        await app.stop();

        assert.deepStrictEqual(order, ['cleanup']);
    });

    it('attempts every application cleanup and aggregates failures', async () => {
        process.env.APP_ENV = 'test';
        const attempted: string[] = [];
        const app = createApp({});
        app.registerCleanup(() => {
            attempted.push('first');
            throw new Error('first cleanup failed');
        });
        app.registerCleanup(() => {
            attempted.push('second');
            throw new Error('second cleanup failed');
        });

        await assert.rejects(
            () => app.stop(),
            error => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.errors.length, 2);
                return true;
            }
        );
        assert.deepStrictEqual(attempted, ['second', 'first']);
    });

    it('coalesces concurrent starts and keeps startup idempotent while running', async () => {
        process.env.APP_ENV = 'test';
        let bootstrapCalls = 0;
        let releaseBootstrap!: () => void;
        const bootstrapGate = new Promise<void>(resolve => {
            releaseBootstrap = resolve;
        });
        const app = createApp({});
        app.on(onAppBootstrap, async () => {
            bootstrapCalls++;
            await bootstrapGate;
        });

        const first = app.start();
        const second = app.start();
        assert.equal(bootstrapCalls, 1);

        releaseBootstrap();
        await Promise.all([first, second]);
        await app.start();

        assert.equal(bootstrapCalls, 1);
        await app.stop();
    });

    it('auto-constructs registered decorated providers only', async () => {
        process.env.APP_ENV = 'test';
        const constructed: string[] = [];

        @AutoConstruct()
        class StartedService {
            constructor() {
                constructed.push('registered');
            }
        }

        @AutoConstruct()
        class UnregisteredService {
            constructor() {
                constructed.push('unregistered');
            }
        }

        const app = createApp({ providers: [StartedService] });
        void UnregisteredService;
        assert.deepStrictEqual(constructed, []);
        await app.start();
        assert.deepStrictEqual(constructed, ['registered']);
        await app.stop();
    });

    it('does not dispatch shutdown lifecycle events before startup', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];
        const app = createApp({});
        app.on(onServerShutdownRequested, () => {
            order.push('requested');
        });
        app.on(onServerShutdown, () => {
            order.push('shutdown');
        });

        await app.stop();

        assert.deepStrictEqual(order, []);
    });

    it('initializes configured database entities before auto-construct providers', async () => {
        process.env.APP_ENV = 'test';

        class AppEntity extends BaseEntity {}

        const AppDB = createDatabaseClass(() => new NoopDriver(), [AppEntity]);
        let queried = false;

        @AutoConstruct()
        class StartedService {
            constructor() {
                AppEntity.query();
                queried = true;
            }
        }

        const app = createApp({ db: AppDB, providers: [StartedService] });

        assert.throws(() => AppEntity.query(), /not registered with a database/);
        await app.start();
        assert.equal(queried, true);
        assert.equal(AppEntity.getDatabase(), app.get(BaseDatabase));
    });

    it('initializes configured database through constructor injection', async () => {
        process.env.APP_ENV = 'test';

        class AppEntity extends BaseEntity {}
        class DatabaseDependency {
            readonly driver = new NoopDriver();
        }
        class AppDB extends BaseDatabase {
            constructor(readonly dependency: DatabaseDependency) {
                super(dependency.driver, [AppEntity]);
            }
        }

        const app = createApp({ db: AppDB, providers: [DatabaseDependency] });

        await app.start();

        assert.equal(app.get(AppDB).dependency, app.get(DatabaseDependency));
        assert.equal(AppEntity.getDatabase(), app.get(BaseDatabase));
    });

    it('supports custom event tokens', async () => {
        process.env.APP_ENV = 'test';
        const token = new EventToken<{ value: number }>('custom');
        const app = createApp({});
        let value = 0;

        app.on(token, event => {
            value = event.value;
        });

        await app.events.dispatch(token, { value: 42 });
        assert.equal(value, 42);
    });

    it('registers decorated listener classes before lifecycle dispatch', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];

        class BootstrapListener {
            @event.listen(onAppBootstrap, 10)
            first() {
                order.push('first');
            }

            @event.listen(onAppBootstrap)
            second() {
                order.push('second');
            }
        }

        class ShutdownListener {
            @eventDispatcher.listen(onServerShutdownRequested)
            shutdownRequested() {
                order.push('shutdown-requested');
            }
        }

        const app = createApp({
            listeners: [BootstrapListener, ShutdownListener]
        });

        await app.start();
        await app.stop();

        assert.deepStrictEqual(order, ['first', 'second', 'shutdown-requested']);
    });

    it('dispatches server bootstrap events after listen binds', async () => {
        process.env.APP_ENV = 'test';
        const order: string[] = [];
        const app = createApp({});

        app.on(onServerBootstrap, () => {
            order.push('server-bootstrap');
        });
        app.on(onServerMainBootstrapDone, () => {
            order.push('server-main-bootstrap-done');
        });

        await app.http.listen(0, '127.0.0.1');
        await app.stop();

        assert.deepStrictEqual(order, ['server-bootstrap', 'server-main-bootstrap-done']);
    });

    it('prints command usage instead of starting when run() has no entrypoint command', async () => {
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js');
        const errors: string[] = [];
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
        const app = createApp({});

        await app.run(0, '127.0.0.1');

        assert.equal(process.exitCode, 1);
        assert.match(errors.join('\n'), /Usage: node dist\/src\/index\.js <command> \[options\]/);
        assert.match(errors.join('\n'), /server:start/);
        assert.match(errors.join('\n'), /worker:start/);
        assert.match(errors.join('\n'), /migrate:run/);
    });

    it('prints custom commands in run() usage', async () => {
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js');
        const errors: string[] = [];
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

        @cli.controller('jobs:drain', { description: 'Drain queued jobs' })
        class JobsDrainCommand {
            execute() {}
        }

        const app = createApp({ commands: [JobsDrainCommand] });

        await app.run(0, '127.0.0.1');

        const output = errors.join('\n');
        assert.equal(process.exitCode, 1);
        assert.match(output, /jobs:drain\s+Drain queued jobs/);
    });

    it('runs custom commands through DI', async () => {
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js', 'jobs:drain', '--limit=2');
        const calls: unknown[][] = [];

        @cli.command('jobs:drain')
        class JobsDrainCommand {
            constructor(private config: BaseAppConfig) {}

            execute(args: string[]) {
                calls.push([this.config.APP_ENV, args]);
            }
        }

        const app = createApp({ commands: [JobsDrainCommand] });

        await app.run(0, '127.0.0.1');

        assert.deepStrictEqual(calls, [['test', ['--limit=2']]]);
        assert.equal(process.exitCode, originalExitCode);
    });

    it('runs imported module commands with module-local providers', async () => {
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js', 'cdr:recording-prep-worker', '--once');
        const calls: unknown[][] = [];

        class CallRecordingConversionService {
            readonly name = 'conversion-service';
        }

        @cli.controller('cdr:recording-prep-worker')
        class CallRecordingPrepWorkerCli {
            constructor(private conversion: CallRecordingConversionService) {}

            execute(args: string[]) {
                calls.push([this.conversion.name, args]);
            }
        }

        const cdrModule = createModule({
            providers: [CallRecordingConversionService],
            commands: [CallRecordingPrepWorkerCli]
        });
        const app = createApp({ imports: [cdrModule] });

        await app.run(0, '127.0.0.1');

        assert.deepStrictEqual(calls, [['conversion-service', ['--once']]]);
        assert.equal(process.exitCode, originalExitCode);
    });

    it('rejects commands without cli command metadata', () => {
        process.env.APP_ENV = 'test';

        class UndecoratedCommand {
            execute() {}
        }

        assert.throws(
            () => createApp({ commands: [UndecoratedCommand] }),
            /Command UndecoratedCommand passed to commands must be decorated with @cli\.command\(\) or @cli\.controller\(\)/
        );
    });

    it('rejects commands declared in imported modules without cli command metadata', () => {
        process.env.APP_ENV = 'test';

        class UndecoratedCommand {
            execute() {}
        }

        const feature = createModule({ commands: [UndecoratedCommand] });
        assert.throws(
            () => createApp({ imports: [feature] }),
            /Command UndecoratedCommand passed to commands must be decorated with @cli\.command\(\) or @cli\.controller\(\)/
        );
    });

    it('prints command usage instead of starting for unknown entrypoint commands', async () => {
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js', 'unknown:command');
        const errors: string[] = [];
        console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
        const app = createApp({});

        await app.run(0, '127.0.0.1');

        const output = errors.join('\n');
        assert.equal(process.exitCode, 1);
        assert.match(output, /Unknown entrypoint command: unknown:command/);
        assert.match(output, /Commands:/);
        assert.match(output, /server:start/);
    });

    it('starts the HTTP server for the server:start entrypoint command', async () => {
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js', 'server:start');
        const app = createApp({});

        const server = await app.run(0, '127.0.0.1');
        await app.stop();

        assert.equal(server, undefined);
    });

    it('generates OpenAPI through the app entrypoint command', async () => {
        const dir = makeTempCwd();
        process.env.APP_ENV = 'test';
        process.argv.splice(0, process.argv.length, 'node', 'dist/src/index.js', 'openapi:generate');
        const logs: string[] = [];
        console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

        @http.controller('/entrypoint-openapi')
        class EntrypointOpenApiController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        const app = createApp({ controllers: [EntrypointOpenApiController], enableHealthcheck: false });
        await app.run();

        const schema = readFileSync(join(dir, 'openapi.yaml'), 'utf8');
        assert.match(schema, /openapi: 3\.1\.0/);
        assert.match(schema, /\/entrypoint-openapi:/);
        assert.equal(
            logs.some(line => line.includes('Wrote OpenAPI schema to')),
            true
        );
    });

    it('logs startup route details outside test mode', async () => {
        process.env.APP_ENV = 'development';
        const entries: Array<{ message: string; scope?: string; data?: Record<string, unknown> }> = [];
        setLogSink(entry => entries.push(entry));
        const app = createApp({});

        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address();
        await app.stop();

        assert.ok(address && typeof address === 'object');
        assert.equal(entries[0].message, 'Starting @zyno-io/ts-server-foundation');
        assert.equal(entries[1].message, 'HTTP routes registered');
        assert.equal(entries.at(-2)?.message, 'Server started');
        assert.equal(entries.at(-1)?.message, `DevConsole available at http://localhost:${address.port}/_devconsole`);
        assert.equal(entries[0].scope, 'app');
        assert.equal(entries[0].data?.packageName, '@zyno-io/ts-server-foundation');
        assert.equal(entries[1].data?.routeCount, app.router.listRoutes().length);
        const healthController = entries.find(entry => entry.data?.controller === 'HealthcheckController');
        assert.ok(healthController);
        assert.deepEqual(healthController.data?.routes, [{ method: 'GET', path: '/healthz' }]);
        assert.equal(entries.find(entry => entry.message === 'HTTP listening')?.data?.url, `http://127.0.0.1:${address.port}`);
    });

    it('logs wildcard listen addresses without rewriting them to localhost', async () => {
        process.env.APP_ENV = 'development';
        const entries: Array<{ message: string; data?: Record<string, unknown> }> = [];
        setLogSink(entry => entries.push(entry));
        const app = createApp({});

        const server = await app.http.listen(0, '0.0.0.0');
        const address = server.address();
        await app.stop();

        assert.ok(address && typeof address === 'object');
        assert.equal(entries.find(entry => entry.message === 'HTTP listening')?.data?.url, `http://0.0.0.0:${address.port}`);
    });

    it('keeps HTTP server APIs on app.http instead of App wrappers', () => {
        process.env.APP_ENV = 'test';
        const app = createApp({});
        const legacy = app as unknown as Record<string, unknown>;

        assert.equal(legacy.listen, undefined);
        assert.equal(legacy.registerUpgradeHandler, undefined);
        assert.equal(legacy.registerHttpObserver, undefined);
        assert.equal(legacy.getPort, undefined);
        assert.equal(typeof app.http.listen, 'function');
        assert.equal(typeof app.http.registerUpgradeHandler, 'function');
        assert.equal(typeof app.http.registerObserver, 'function');
        assert.equal(typeof app.http.getPort, 'function');
    });

    it('ignores PORT from config in test mode unless framework port is explicit', () => {
        class AppConfig extends BaseAppConfig {
            PORT = 4321;
        }

        process.env.APP_ENV = 'test';
        process.env.PORT = '9876';

        const defaultPortApp = createApp({ config: AppConfig });
        process.env.APP_ENV = 'test';
        const explicitPortApp = createApp({ config: AppConfig, frameworkConfig: { port: 0 } });

        assert.equal(defaultPortApp.http.getPort(), 3000);
        assert.equal(explicitPortApp.http.getPort(), 0);
    });
});
