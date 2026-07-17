# Getting Started

## Install

Scaffold a project:

```bash
npx @zyno-io/ts-server-foundation create-app @myorg/my-api
cd my-api
corepack yarn install
corepack yarn dev
```

Manual installation:

```bash
corepack yarn add @zyno-io/ts-server-foundation
corepack yarn tsf-install
```

`tsf-install` adds the supported TypeScript/`ttsc` compiler dependencies and configures TSF's metadata transform. Scaffolded applications run it from `postinstall`.

## Scaffold Anatomy

The generated project is intentionally small:

| Path                                                 | Purpose                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                       | Executable entrypoint. Initializes `@zyno-io/ts-server-foundation/otel` before loading the application, then calls `app.run()`.                   |
| `src/app.ts`                                         | Creates and exports the application, database, controllers, and providers. Tests should import this module rather than the executable entrypoint. |
| `src/config.ts`                                      | Application config class extending `BaseAppConfig`.                                                                                               |
| `src/database.ts`                                    | MySQL database class and entity registry used by the example.                                                                                     |
| `src/controllers/`, `src/services/`, `src/entities/` | Example HTTP, service, and database layers.                                                                                                       |
| `src/migrations/`                                    | Source migration files; compiled output is resolved from TypeScript `rootDir` and `outDir` (`dist/src/migrations/` in this scaffold).             |
| `tests/`                                             | Node test-runner tests compiled with `tsconfig.test.json`.                                                                                        |
| `.env.development`                                   | Local port, MySQL connection, database adapter, and Redis key prefix. Do not commit real secrets.                                                 |
| `package.json`                                       | Sets `main` to `./dist/src/index.js`, allowing `node . <command>` to dispatch through the compiled entrypoint.                                    |

The generated scripts map to the development wrapper:

| Script                | Command                       |
| --------------------- | ----------------------------- |
| `yarn build`          | `tsf-dev build`               |
| `yarn dev`            | `tsf-dev run -- server:start` |
| `yarn test`           | `tsf-dev test`                |
| `yarn test:debug`     | `tsf-dev test --debug`        |
| `yarn migrate`        | `tsf-dev migrate`             |
| `yarn migrate:create` | `tsf-dev migrate:create`      |
| `postinstall`         | `tsf-install`                 |

The OTel-first entrypoint matters: instrumentation must load before HTTP, database, Redis, and other modules it patches. Keep application construction in `app.ts` so tests can import it without running command dispatch.

## TypeScript Configuration

Reflected type metadata is required for constructor injection, route parameter metadata, OpenAPI schemas, config loading, entity metadata, and custom type annotations.

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "lib": ["ES2022"],
        "module": "commonjs",
        "rootDir": ".",
        "outDir": "dist",
        "sourceMap": true,
        "strict": true,
        "isolatedModules": true,
        "esModuleInterop": true,
        "forceConsistentCasingInFileNames": true,
        "skipLibCheck": true,
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true,
        "importHelpers": true,
        "types": ["node"],
        "plugins": [
            {
                "transform": "@zyno-io/ts-server-foundation/type-compiler",
                "emitTypeAliases": false,
                "emitUndecoratedMethods": false
            }
        ]
    },
    "include": ["src/**/*.ts"],
    "reflection": true
}
```

Build with `ttsc`, as the scaffold and `tsf-dev` commands do. `tsf-install` installs the supported compiler and adds the transform plus top-level `reflection` setting; the full scaffold configuration above is the recommended baseline. `isolatedModules: true` keeps application code compatible with file-at-a-time transforms. `emitTypeAliases: false` limits alias metadata to local use, while `emitUndecoratedMethods: false` limits method metadata to decorated methods such as HTTP routes. The compiler emits reflected metadata through a compact, versioned runtime format for CommonJS and ESM output. See [Type Reflection Architecture](./type-reflection-architecture.md) for the compiler and runtime metadata policy.

For published releases, `tsf-install` prepares the native type compiler during installation. TSF first tries a verified prebuilt from the matching GitHub release on Linux, macOS, and Windows for x64 and arm64. A missing asset, network failure, timeout, checksum mismatch, unsupported platform, or incompatible compiler version automatically falls back to `ttsc`'s normal local Go source build. Both paths populate the same project-local `ttsc` cache, so later builds reuse the result.

Set `TSF_TYPE_COMPILER_PREBUILT=0` to force local source builds. Set `TSF_TYPE_COMPILER_PREBUILT_DEBUG=1` to report why a prebuilt was not used. `TTSC_CACHE_DIR` continues to control the shared build cache location.

For tests, extend the main config and include both source and tests:

```json
{
    "extends": "./tsconfig.json",
    "include": ["src/**/*.ts", "tests/**/*.ts"],
    "reflection": true
}
```

## Create an App

```ts
import { BaseAppConfig, createApp, createDatabase, http } from '@zyno-io/ts-server-foundation';

class AppConfig extends BaseAppConfig {
    APP_ENV = 'development';
}

@http.controller('/health-example')
class ExampleController {
    @http.GET()
    get() {
        return { ok: true };
    }
}

class AppDatabase extends createDatabase('mysql', {}, []) {}

export const app = createApp({
    config: AppConfig,
    db: AppDatabase,
    controllers: [ExampleController]
});

if (require.main === module) {
    void app.run();
}
```

Run the server entrypoint with an explicit command:

```bash
node . server:start
```

`app.run()` handles command dispatch for `server:start`, `worker:start`, `migrate:run`, `openapi:generate`, `repl`, and commands registered on the app. Direct HTTP server APIs live under `app.http`; for tests, demos, or embedded usage call `app.http.listen()`:

Running `node .` without a command, or with an unknown command, prints usage and sets a failing exit code. Production process definitions should always include the intended command.

```ts
const server = await app.http.listen(0, '127.0.0.1');
await app.stop();
```

Register app commands with `@cli.controller()` and the `commands` option:

```ts
import { cli, createApp, ScopedLogger } from '@zyno-io/ts-server-foundation';

@cli.controller('receipts:requeue', { description: 'Requeue queued receipts' })
class ReceiptsRequeueCommand {
    constructor(private logger: ScopedLogger) {}

    async execute(args: string[]) {
        this.logger.info('Running receipts:requeue', { args });
    }
}

export const app = createApp({
    commands: [ReceiptsRequeueCommand]
});
```

Run custom commands through the same compiled entrypoint:

```bash
node . receipts:requeue
```

Long-running commands can extend `CliServiceCommand`. These commands start an HTTP listener with only the enabled `/healthz` and `/metrics` controllers; application, OpenAPI, and DevConsole controllers are not exposed by the service process.

## `createApp()` Options

```ts
interface CreateAppOptions<C extends BaseAppConfig = BaseAppConfig> extends ModuleDefinition<C> {
    config?: ClassType<C>;
    defaultConfig?: Partial<C>;
    db?: ClassType;
    frameworkConfig?: Record<string, unknown>;
    serverConfig?: Record<string, unknown>;
    cors?: HttpCorsConfig<C>;
    staticFiles?: boolean | StaticFilesOptions;
    httpResolvers?: RouteParameterResolverRegistry;
    enableHealthcheck?: boolean;
    enableWorker?: boolean;
    enableDkRpc?: boolean;
}
```

Common fields:

| Option              | Description                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `config`            | Config class. Defaults to `BaseAppConfig`.                                                    |
| `defaultConfig`     | Default values applied before env files and `Env`.                                            |
| `db`                | Database class from `createDatabase`, `createMySQLDatabase`, or `createPostgresDatabase`.     |
| `controllers`       | HTTP controllers registered with the owned router.                                            |
| `providers`         | DI providers. Classes, `useValue`, `useClass`, `useExisting`, and `useFactory` are supported. |
| `imports`           | Imported modules. Exported providers from imported modules become globally injectable.        |
| `exports`           | Providers exported by this module for global injection.                                       |
| `listeners`         | Lifecycle/event listener classes.                                                             |
| `commands`          | Classes decorated with `@cli.command()` or `@cli.controller()`.                               |
| `frameworkConfig`   | HTTP runtime options; `port` overrides `config.PORT`.                                         |
| `serverConfig`      | Secondary HTTP runtime options; `frameworkConfig` takes precedence for `port`.                |
| `cors`              | Static CORS options or a config-driven factory.                                               |
| `staticFiles`       | Static-file options, or `true` for the default `static/` directory with SPA fallback.         |
| `httpResolvers`     | App-wide custom HTTP parameter resolvers keyed by reflected class name.                       |
| `enableHealthcheck` | Set to `false` to skip the default `/healthz` endpoint.                                       |
| `enableWorker`      | Registers worker services and job runners.                                                    |
| `enableDkRpc`       | Legacy compatibility flag; the current runtime does not act on it.                            |

## Application And HTTP Runtime

`App` owns lifecycle, DI, config, command entrypoints, and module wiring. HTTP server behavior is exposed through `app.http`:

```ts
const app = createApp({ controllers: [ExampleController] });

await app.start(); // optional; app.http.listen() starts it automatically
const server = await app.http.listen(3000, '0.0.0.0');

app.http.registerUpgradeHandler((request, socket, head) => {
    // WebSocket or other upgrade handling
});

app.http.registerObserver(entry => {
    // completed HTTP request observation
});

await app.stop();
```

Transport APIs live under `app.http` so the base application class stays focused on application lifecycle.

## Dependency Injection

Constructor dependencies are read from reflected type metadata:

```ts
class UserService {
    constructor(private db: BaseDatabase) {}
}
```

Resolve app-level providers outside constructor injection with `resolve()` or `r()`:

```ts
import { BaseAppConfig, r, resolve } from '@zyno-io/ts-server-foundation';

const config = resolve(BaseAppConfig);
const sameConfig = r(BaseAppConfig);
```

Exported providers from imported modules are globally injectable. You do not need to explicitly import a module at the injection site when a provider is exported by a module in the app graph.

## AutoConstruct

`@AutoConstruct()` instantiates a registered provider during normal app startup. The decorator does not register the class by itself:

```ts
import { AutoConstruct, createApp } from '@zyno-io/ts-server-foundation';

@AutoConstruct()
class StartupProbe {
    constructor() {
        // Runs when app.start() creates AutoConstruct providers.
    }
}

const app = createApp({ providers: [StartupProbe] });
```

CLI service commands skip auto-construct providers by default. Pass `cli: true` for providers that should also initialize in those processes:

```ts
@AutoConstruct({ cli: true })
class CliStartupProbe {}
```

## Environment

`APP_ENV` is required only when `NODE_ENV=production`. Tests infer `APP_ENV=test` from the Node test runner; other non-production processes default to `development`.

Configuration is loaded from env files and `Env`. Values consumed by reflected config properties remain in `process.env`, so later code and child processes inherit the same environment.

## Development, Test, And Production Setup

For the generated MySQL example, create the database named by `MYSQL_DATABASE` and make the `.env.development` credentials usable before running migrations or calling the example endpoints. The scaffold unit test only constructs the app and does not require a live database. Redis is not required by the base scaffold; configure it when enabling BullMQ workers, mutexes, leader election, mesh services, caches, or broadcasts.

Local development:

```bash
corepack enable
corepack yarn install
corepack yarn migrate
corepack yarn dev
```

Tests compile source and tests with the reflection transform before invoking Node's test runner:

```bash
corepack yarn test
corepack yarn test:debug
```

For production, provide environment variables through the deployment secret/config system, build once, and execute the compiled package entrypoint explicitly:

```bash
corepack yarn build
APP_ENV=production node . server:start
```

Run migrations as a separate release step with `node . migrate:run`. If workers are enabled, use a separate `node . worker:start` process; see [Workers](./worker.md). A production database is required when the app registers one. Redis remains feature-dependent rather than an unconditional server prerequisite.

## CLI

Primary commands:

```bash
tsf create-app <package-name> [path]
tsf test [node-test-options] [test-files-or-dirs...]
tsf gen-proto <proto-file-or-dir> <output-dir> [options]

tsf-dev build
tsf-dev run -- server:start
tsf-dev test
tsf-dev migrate
tsf-dev migrate:create
tsf-dev migrate:reset
tsf-dev migrate:charset
tsf-dev openapi:generate
```

See [CLI Tools](./cli.md) for the detailed command reference.

See [Public API](./public-api.md) for package export rules and import guidance.
