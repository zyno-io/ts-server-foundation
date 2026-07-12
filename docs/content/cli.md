# CLI Tools

TSF ships application scaffolding, compiler setup, development orchestration, tests, migrations, OpenAPI generation, and protobuf generation as package binaries. All TSF-owned commands use the `tsf` prefix.

## Package Binaries

| Binary | Description |
| --- | --- |
| `tsf` | Umbrella CLI for `create-app`, `test`, and `gen-proto`. |
| `ts-server-foundation` | Alias for the umbrella CLI. |
| `tsf-create-app` | Scaffold a new app from `template-app`. |
| `tsf-dev` | Build/watch/run/test and application development workflows. |
| `tsf-test` | Compile-output-aware Node test runner. |
| `tsf-migrate` | Create, run, reset, and charset migration commands. |
| `tsf-gen-proto` | Generate TypeScript protobuf codecs through `ts-proto`. |
| `tsf-install` | Configure the supported TypeScript 7/`ttsc` compiler and TSF transform. |
| `tsf-update` | Reserved update command; currently reports that no automatic updater is available. |

## Umbrella Command

`tsf` forwards to the matching standalone binary:

```bash
tsf create-app <package-name> [path]
tsf test [node-test-options] [test-files-or-dirs...]
tsf gen-proto <proto-file-or-dir> <output-dir> [options]
```

The standalone names remain useful in package scripts and when a command needs to be invoked directly.

## App Scaffolding

```bash
npx @zyno-io/ts-server-foundation create-app my-api
npx @zyno-io/ts-server-foundation create-app @myorg/my-api
tsf-create-app @myorg/my-api ./services/api
```

The first argument must be a valid npm package name. The output path defaults to the unscoped package name, so `@myorg/my-api` creates `./my-api/`. Scaffolding refuses to overwrite an existing directory.

The command copies `template-app` and fills in:

- package and database names
- the Redis prefix
- the TSF package version
- the supported `typescript` and `ttsc` versions
- template `.gitignore` and other `.tmpl` file names

When scaffolding from an unpublished `0.0.0-dev` checkout, the generated TSF dependency uses `*`; published versions use a compatible `^<version>` range. The generated app prints its install and development commands when complete.

## Development Workflow

```bash
tsf-dev <command> [options]
```

All commands resolve the project root from the working directory. `-p <file>` and `--tsconfig <file>` select a TypeScript config where applicable.

| Command | Behavior |
| --- | --- |
| `clean` | Removes `dist/`. |
| `build [--watch]` | Ensures compiler setup, cleans when needed, and compiles with the supported `ttsc`. |
| `run [--debug] [script] -- <app-command>` | Ensures a watch build, then starts Node with source maps, file watching, and the requested app command. |
| `test [--debug]` | Builds the test config and delegates to `tsf-test`. |
| `migrate [--debug]` | Builds, then invokes the package entrypoint with `migrate:run`. |
| `migrate:create [--debug]` | Builds, then delegates to `tsf-migrate create`. |
| `migrate:reset [--debug]` | Builds, then delegates to `tsf-migrate reset`. |
| `migrate:charset [--debug]` | Builds, then delegates to `tsf-migrate charset`. |
| `openapi:generate` | Builds, then invokes the package entrypoint with `openapi:generate`. |

### Build And Watch

```bash
tsf-dev clean
tsf-dev build
tsf-dev build --watch
tsf-dev build -p tsconfig.test.json
```

`tsf-dev build` records a fingerprint of compiler inputs and outputs under `dist/`. A later command reuses a fresh build; changing TypeScript/JavaScript sources, JSON configuration, or the lockfile invalidates it. Watch mode uses the selected tsconfig's files/include/exclude/outDir rules and ignores generated and dependency directories.

`tsf-install` runs before normal development builds so the project uses the package-supported compiler versions and transform. Test builds are the exception: `tsf-dev test` compiles directly and does not mutate package/compiler setup during a test run.

### Run

```bash
tsf-dev run -- server:start
tsf-dev run -- worker:start
tsf-dev run dist/custom-entry.js -- maintenance:run
tsf-dev run --debug -- server:start
```

Arguments before `--` belong to `tsf-dev`; arguments after it are passed to the application. The script defaults to `.`, which asks Node to load the package `main`. An explicit app command is required by scaffolded applications.

The first `tsf-dev run` for a project owns the compiler watcher. Concurrent run processes share its build-ready state instead of starting duplicate compilers. If an existing output fingerprint is fresh, the watcher waits for an input change before compiling again.

Normal run mode enables the Node inspector. `--debug` changes it to `--inspect-brk`. When `PORT` is set, the inspector uses `PORT + 1000`; otherwise Node selects/reports its inspector port.

### Tests

```bash
tsf-dev test
tsf-dev test tests/http.spec.ts
tsf-dev test --test-name-pattern='uploads'
tsf-dev test --debug tests/http.spec.ts
```

The command selects `tsconfig.test.json` when present, otherwise `tsconfig.json`, compiles if needed, and forwards remaining Node test flags and file/directory selectors to `tsf-test`. Debug mode starts with `--inspect-brk=9268`.

## Test Runner

```bash
tsf-test [node-test-options] [test-files-or-dirs...]
```

`tsf-test` sets `APP_ENV=test` and `TZ=UTC`, maps source selectors to emitted files using the effective tsconfig's `rootDir` and `outDir`, and runs Node with source maps, a 180-second per-test timeout, and forced process exit. With no selector it discovers compiled `*.spec.js` files anywhere below the configured `outDir`.

If a `tests/shared/globalSetup.ts` or `src/tests/shared/globalSetup.ts` source file emits under the configured `outDir`, its optional `setup()` runs before the test subprocess and `teardown()` runs after it. See [Testing](./testing.md#global-setup-and-module-state).

When MySQL test configuration is available and savepoints are allowed, the runner starts a shared MySQL session manager. Its pool size follows `--test-concurrency` or defaults to available parallelism minus one. Control it with:

| Environment key | Behavior |
| --- | --- |
| `TSF_TEST_MYSQL_SESSION_MANAGER=0` | Disable the shared manager. |
| `TSF_TEST_MYSQL_SESSION_MANAGER=1` | Force the manager on; missing MySQL configuration still fails startup. |
| `TSF_TEST_ALLOW_SAVEPOINTS=0` | Disable savepoint-backed facade reuse globally. |
| `TEST_RUN_TS=<value>` | Reuse an explicit run identifier for generated test database names. |

Database readiness is checked only by database-enabled facades, not as a runner-wide preflight.

## Migrations

Use `tsf-dev migrate*` during development when source must be compiled first. Use `tsf-migrate` directly when compiled application output already exists.

```bash
tsf-migrate create [options]
tsf-migrate run [options]
tsf-migrate reset [options]
tsf-migrate charset [charset collation] [options]
```

| Command | Behavior |
| --- | --- |
| `create` | Diffs reflected entity schemas against the live database and writes a raw-SQL migration when changes exist. `create:raw` is an alias. |
| `run` | Loads compiled migrations and runs migrations not recorded in `_migrations`. |
| `reset` | Removes source migration files and creates one base migration from registered entities. |
| `charset` | Standardizes the MySQL database and table charset/collation; PostgreSQL reports a skipped operation. |

Options:

| Option | Description |
| --- | --- |
| `--app <path>` | Compiled app module. Defaults to the emitted path for `src/app.ts`. |
| `--description <text>`, `-d <text>` | Migration description. Defaults to `auto_migration`. |
| `--migrations-dir <path>` | Source migration directory. Defaults to `src/migrations`. |
| `--pg-schema <schema>` | PostgreSQL schema used for diff/reset. Defaults to the database reader's schema. |
| `--table <name>` | Limits a create diff to one table. Repeatable. |
| `--tables <a,b>` | Limits a create diff to a comma-separated table list. |

Option values may also use `--name=value`. Table names are de-duplicated; empty values and unknown options fail rather than being ignored.

The app module may export an `App` instance or zero-argument app factory as `app` or `default`. As a compatibility fallback, a zero-argument named export matching `create*App` is also accepted. The CLI resolves `BaseDatabase` through that app and closes the database driver when the command completes.

For `run`, a source path containing `src` maps to the equivalent compiled `dist` path. Pass a path already containing `dist` to load it directly. See [Migrations](./migrations.md) for migration file format, directory loading, schema diffs, reset behavior, and charset defaults.

Migration debug mode under `tsf-dev` uses `--inspect-brk=9226`.

## OpenAPI Generation

```bash
tsf-dev openapi:generate
tsf-dev openapi:generate -p tsconfig.json
```

This builds the project, then runs `node . openapi:generate`. The built-in `App.run()` command serializes registered routes to `openapi.yaml` without binding the HTTP server. The application package must expose its compiled entrypoint through `package.json#main`, as scaffolded TSF apps do.

Runtime OpenAPI routes and serializer options are documented in [OpenAPI](./openapi.md).

## Proto Generation

```bash
tsf-gen-proto resources/proto/service.proto src/generated/proto
tsf-gen-proto resources/proto src/generated/proto --only-types
```

The input may be one `.proto` file or a directory. Directory mode generates every direct `.proto` child and does not recurse. The output directory is created when necessary.

| Flag | Effect |
| --- | --- |
| `--only-types` | Passes `onlyTypes=true` to `ts-proto`. |
| `--use-date` | Uses `Date` for `google.protobuf.Timestamp`; the default is `useDate=false`. |
| `--use-map-type` | Uses ES `Map` for protobuf maps; the default is `useMapType=false`. |

Generation always enables `esModuleInterop` and disables generated service clients because SRPC uses the message codecs directly. The command uses `PROTOC` when set, then the package's `protoc` binary, then a `protoc` executable on `PATH`. It resolves `ts-proto` from the app or TSF package.

## Compiler Installation

`tsf-install` prepares an app for TSF's reflected metadata compiler. It:

- adds itself to `postinstall` without replacing an existing postinstall command
- moves the supported `typescript` and `ttsc` versions into `devDependencies`
- keeps TSF/compiler versions aligned in other packages in the same workspace when those dependencies are present
- finds `tsconfig*.json` files outside generated/dependency directories
- adds the TSF transform to `compilerOptions.plugins`
- sets top-level `reflection: true`
- avoids duplicating the plugin in configs that extend an already configured local base config

When compiler dependencies change outside a package-manager lifecycle, it detects Yarn, npm, pnpm, or Bun and refreshes the install/lockfile. During `postinstall`, it reports that another install is needed instead of recursively starting the package manager.

The generated app registers `tsf-install` as `postinstall`, so normal dependency installation keeps compiler setup aligned. See [Getting Started: TypeScript Configuration](./getting-started.md#typescript-configuration) for the resulting config.

## Update Command

`tsf-update` is included as a reserved compatibility binary but does not currently modify the project. Dependency updates should be performed through the package manager, followed by `tsf-install` when compiler configuration must be refreshed.
