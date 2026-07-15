# Testing

Tests use the Node `node:test` runner against compiled output. The package provides a small testing facade, in-memory HTTP requests, isolated MySQL/PostgreSQL database helpers, seed hooks, and assertion helpers.

```bash
corepack yarn test
corepack yarn test tests/http.spec.ts
```

## Testing Facade

`TestingHelpers.createTestingFacade()` creates an app with `frameworkConfig.port = 0`, then gives tests lifecycle helpers around that app.

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TestingHelpers } from '@zyno-io/ts-server-foundation';

const tf = TestingHelpers.createTestingFacade({
    controllers: [UserController],
    providers: [UserService]
});

TestingHelpers.installStandardHooks(tf);

describe('UserController', () => {
    it('returns users', async () => {
        const response = await TestingHelpers.makeMockRequest(tf, 'GET', '/users');
        assert.equal(response.statusCode, 200);
    });
});
```

`installStandardHooks(tf)` installs `before`, `after`, `beforeEach`, and `afterEach` hooks. `beforeEach` calls `tf.resetToSeed()`. `afterEach` resets Node mock timers and restores all mocks. When the facade does not enable a database, the hooks also guard the configured application database for the full facade lifecycle. Any unmocked connection attempt fails with `Database is not enabled in testing mode` before it can reach MySQL or PostgreSQL.

Pass `suiteSeedData` when a suite needs extra baseline rows on top of the facade seed. In savepoint mode, the hook creates a second savepoint after `suiteSeedData` and resets to it before each test. Without savepoints, the hook runs `suiteSeedData` after each `resetToSeed()`.

```typescript
TestingHelpers.installStandardHooks(tf, {
    suiteSeedData: async facade => {
        await facade.get<AppDatabase>(AppDatabase).rawExecute(sql`INSERT INTO users (name) VALUES (${'Seed user'})`);
    }
});
```

## Facade Options

```typescript
interface TestingFacadeOptions {
    defaultTestHeaders?: Record<string, string>;
    seedData?: (facade: TestingFacade) => Promise<void> | void;
    autoSeedData?: boolean;
    onBeforeStart?: (facade: TestingFacade) => Promise<void> | void;
    onStart?: (facade: TestingFacade) => Promise<void> | void;
    onBeforeStop?: (facade: TestingFacade) => Promise<void> | void;
    onStop?: (facade: TestingFacade) => Promise<void> | void;
    enableDatabase?: boolean;
    rejectDatabaseAccess?: boolean;
    dbAdapter?: 'mysql' | 'postgres';
    useSavepoints?: boolean;
    databasePrefix?: string;
    keepDatabase?: boolean;
    enableMigrations?: boolean;
    schemaFromEntities?: boolean | CreateMigrationPlanOptions;
    migrations?: readonly Migration[];
    migrationsDir?: string | readonly string[];
    truncateAfterMigrations?: boolean;
}

interface StandardHookOptions {
    suiteSeedData?: (facade: TestingFacade) => Promise<void> | void;
}
```

`rejectDatabaseAccess` applies the same per-facade connection guard when lifecycle is managed manually. Standard hooks enable it automatically for database-disabled facades.

## Unit Facades

Use `createUnitTestingFacade()` for application-level unit tests that keep the configured database type for `tf.sql` entity mocks but must not open a real database connection. It also supports explicit root-provider exclusions and overrides so auto-constructed integrations do not start unless the suite needs them.

```typescript
const tf = TestingHelpers.createUnitTestingFacade(CoreAppOptions, {
    excludeProviders: [ExternalEventHandlers],
    providerOverrides: [{ provide: PublisherService, useValue: mockPublisher }]
});

TestingHelpers.installStandardHooks(tf);
```

Provider overrides replace root providers with the same token. Exclusions and overrides apply to `appOptions.providers`; use a testing-facade builder resolver when imported modules or other app-option collections need filtering.

Unit facades do not mock raw SQL. Exclude the provider that owns an unrelated raw-SQL lifecycle, override that provider with a test double, or use `createTestingFacadeWithDatabase()` when raw SQL is behavior under test.

Use `createTestingFacadeWithDatabase()` when the test always needs an isolated database.

```typescript
const tf = TestingHelpers.createTestingFacadeWithDatabase(
    {
        db: AppDatabase,
        controllers: [UserController]
    },
    {
        dbAdapter: 'postgres',
        databasePrefix: 'app_test',
        seedData: async facade => {
            const db = facade.get<AppDatabase>(AppDatabase);
            await db.rawExecute(sql`INSERT INTO users (name) VALUES (${'Alice'})`);
        }
    }
);
```

Use `createTestingFacadeBuilder()` to define app-level testing defaults once, then let individual suites append controllers,
providers, imports, and testing hooks:

```typescript
export const createTestingFacade = TestingHelpers.createTestingFacadeBuilder(
    {
        ...CoreAppOptions,
        imports: []
    },
    {
        enableDatabase: true,
        databasePrefix: 'app_test'
    }
);

const tf = createTestingFacade({
    controllers: [UserController]
});
```

Builder inputs can also be resolver functions. The returned factory passes each suite's selections to the resolvers, so
applications can apply custom merge or filtering rules:

```typescript
export const createTestingFacade = TestingHelpers.createTestingFacadeBuilder(
    appOptions => ({
        ...CoreAppOptions,
        ...appOptions,
        providers: [...(CoreAppOptions.providers ?? []), ...appOptions.providers].filter(provider => provider !== ReportingDb)
    }),
    options => ({
        enableDatabase: true,
        databasePrefix: 'app_test',
        ...options
    })
);
```

## Facade Lifecycle API

`installStandardHooks()` is the normal lifecycle owner, but the facade methods are public for custom harnesses:

| Method                                             | Behavior                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                                          | Installs an enabled database-access guard, runs `onBeforeStart`, creates/prepares the database when enabled, starts the app, then runs `onStart`. |
| `stop()`                                           | Runs `onBeforeStop`, stops the app, cleans up database state, then runs `onStop`.                                                                 |
| `get(token)`                                       | Resolves a provider from the facade app.                                                                                                          |
| `request(request)`                                 | Sends an in-memory `HttpRequest` through the app and returns a `MemoryHttpResponse`.                                                              |
| `createDatabase()` / `destroyDatabase()`           | Explicitly owns the configured test database lifecycle.                                                                                           |
| `runMigrations()`                                  | Loads and runs the facade's configured migrations.                                                                                                |
| `truncateTables()`                                 | Clears non-internal tables and resets identity state where supported.                                                                             |
| `seed()` / `resetToSeed()`                         | Applies seed data or restores the per-test baseline.                                                                                              |
| `createSeedSavepoint()` / `resetToSeedSavepoint()` | Manages named seed baselines when savepoint isolation is active.                                                                                  |

`start()` and `stop()` should still be paired. Direct database lifecycle calls are intended for custom setup and debugging; they do not replace app shutdown or the facade hooks.

## Database Tests

The facade creates a database named from `databasePrefix`, a four-character hash of the current project directory, timestamp, process id, and a counter. The directory hash keeps concurrent test runs in separate worktrees from sharing database names. It updates the app config and `Env` for the chosen adapter, then restores the previous database env when stopped.

Database facades use savepoints by default. In savepoint mode, compatible facades reuse migrated test databases, so migrations run once per compatible database slot instead of once per suite. Each facade still gets seed-data isolation and rolls seed/runtime changes back on stop. When `tsf-dev test` has MySQL env available, it starts a shared MySQL session manager with a slot pool sized to the Node test worker concurrency so compatible MySQL facades can run in parallel across worker processes. Each manager slot owns one database and one long-lived backend connection; after schema preparation, the manager keeps a backend transaction open, allows only one frontend connection at a time for that slot, maps frontend transaction commands to savepoints, and rolls back to the slot baseline when the frontend disconnects. Leave `TSF_TEST_MYSQL_SESSION_MANAGER` unset to start the manager when MySQL test config is present and savepoints are allowed, set it to `0` to disable the manager, or set it to `1` to force it on. Set `TSF_TEST_ALLOW_SAVEPOINTS=0` to force all facades out of savepoint mode even when `useSavepoints: true`, or set `useSavepoints: false` for a fully isolated create/migrate/drop database lifecycle. Database readiness waits run only when a facade has `enableDatabase` and are cached once per process.

`TestingFacade.start()` logs `Starting test facade` before database creation, app startup, migrations, and seeding. This gives long-running database tests immediate startup feedback while routine HTTP request/response logs remain suppressed by default in test mode.

Required local env keys are the same keys used by app config:

```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD_SECRET=secret
MYSQL_DATABASE=app

PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=root
PG_PASSWORD_SECRET=secret
PG_DATABASE=app
```

Set `TEST_KEEP_DB=true` or `keepDatabase: true` to keep test databases during facade or process cleanup.

## Migrations And Seeds

When `enableDatabase` is true, migrations run by default if the app has a database class. You can pass explicit `migrations`, point at `migrationsDir`, or set `enableMigrations: false`.

Source migration directories are mapped to compiled output using the active tsconfig's `rootDir` and `outDir`. `tsf-dev test -p <file>` passes that config through to the test runtime, so both `rootDir: "."` and `rootDir: "./src"` layouts work without overriding `migrationsDir`.

Set `schemaFromEntities: true` to create the registered entity schema through `createMigrationPlan()` before migrations run. Pass `{ tableNames, pgSchema }` instead of `true` to scope that schema generation.

After migrations, the facade truncates tables by default. Set `truncateAfterMigrations: false` when a test needs migration-provided seed rows.

Migration execution logs include the number found, number previously executed, number to run, and per-migration start/end messages.

Use `seedData` and `autoSeedData` for repeatable per-test state:

```typescript
const tf = TestingHelpers.createTestingFacadeWithDatabase(
    { db: AppDatabase },
    {
        dbAdapter: 'mysql',
        autoSeedData: true,
        seedData: async facade => {
            await facade.get<AppDatabase>(AppDatabase).rawExecute(sql`INSERT INTO users (name) VALUES (${'Alice'})`);
        }
    }
);
```

## Mock Requests

`TestingHelpers.makeMockRequest()` sends an in-memory `HttpRequest` through the app router and returns a `MemoryHttpResponse`.

```typescript
const getResponse = await TestingHelpers.makeMockRequest(tf, 'GET', '/users?limit=10');
const postResponse = await TestingHelpers.makeMockRequest(tf, 'POST', '/users', { name: 'Alice' });
const headerResponse = await TestingHelpers.makeMockRequest(tf, 'POST', '/users', { authorization: 'Bearer token' }, { name: 'Alice' });

assert.equal(postResponse.statusCode, 200);
assert.deepEqual(postResponse.json, { id: 1, name: 'Alice' });
```

For lower-level cases, call `tf.request(new HttpRequest(...))` directly.

## Assertion Helpers

The package root exports asymmetric testing matchers.

```typescript
import { anyOf, matchesObject, objectContaining, stringContaining } from '@zyno-io/ts-server-foundation';

matchesObject(result, {
    id: anyOf(String),
    name: stringContaining('Alice'),
    metadata: objectContaining({ source: 'test' })
});
```

Available helpers are `matchesObject`, `anyOf`, `arrayContaining`, `stringContaining`, `objectContaining`, `anything`, and `assertCalledWith`.

## Entity Fixtures

`defineEntityFixtures()` keeps fixture objects typed against an entity and records the entity class on each fixture. Date properties accept ISO strings and are converted to `Date` instances by `prepareEntityFixtures()` or `loadEntityFixtures()`.

```typescript
const users = TestingHelpers.defineEntityFixtures(User, {
    alice: {
        email: 'alice@example.com',
        createdAt: '2026-01-01T00:00:00.000Z'
    }
});

const tf = TestingHelpers.createTestingFacadeWithDatabase(
    { db: AppDatabase },
    {
        seedData: () => TestingHelpers.loadEntityFixtures([users.alice])
    }
);
```

`loadEntityFixtures()` persists fixtures one at a time through the entity's registered database.

## Query Builder Mocks

Every facade exposes `tf.sql`, a `SqlTestingHelper` for entity-query tests that do not need a real database.

```typescript
const tf = TestingHelpers.createTestingFacade({});

tf.sql.mockEntity(User, [
    { id: '1', name: 'Alice', visits: 1 },
    { id: '2', name: 'Bob', visits: 2 }
]);

const names = await User.query()
    .filter({ visits: { $gte: 2 } })
    .orderBy('name')
    .findField('name');

await User.query()
    .filterField('id', '2')
    .patchOne({ $inc: { visits: 1 } });
```

The in-memory query builder covers common field filters (including comparison and `LIKE` operators), selection, ordering, paging, scalar/entity reads, counts, and patch/delete mutations. It does not mock raw SQL or dialect-specific SQL behavior. `installStandardHooks()` clears the facade's SQL mocks after every test; call `tf.sql.clearMocks()` when managing lifecycle manually.

## Database Defaults And Cleanup

`setDefaultDatabaseConfig()` writes values to `Env` only when a key is not already configured. `cleanupTestDatabases(prefix, adapter?)` drops MySQL/PostgreSQL test databases matching the prefix and current project-directory hash, including compatible shared-database state in the current process. This prevents cleanup in one worktree from dropping another worktree's test databases.

```typescript
TestingHelpers.setDefaultDatabaseConfig({
    MYSQL_HOST: '127.0.0.1',
    MYSQL_USER: 'root'
});

await TestingHelpers.cleanupTestDatabases('myapptest', 'mysql');
```

Use a test-specific alphanumeric prefix; cleanup is intentionally destructive for matching database names, and `_` or `%` in the prefix acts as a SQL wildcard.

## Global Setup And Module State

When `tests/shared/globalSetup.ts` or `src/tests/shared/globalSetup.ts` emits under the configured TypeScript `outDir`, `tsf-test` loads it before discovering/running tests. An exported `setup()` may be synchronous or asynchronous; an exported `teardown()` runs after the test process and shared MySQL session manager finish.

```typescript
export async function setup() {
    // one-time process setup
}

export async function teardown() {
    // one-time process cleanup
}
```

Environment changes performed while the global-setup module is loaded are retained for the test subprocess. Prefer suite hooks for state that can be isolated per file or facade.

`TestingHelpers.resetSrcModuleCache()` removes CommonJS cache entries whose paths contain `/dist/` or `/src/`. It is useful when a test must re-evaluate application modules after changing environment or module-level state. It does not reset third-party packages, ESM module caches, process globals, registered decorators, or other singleton registries.

## Exported Helpers

`TestingHelpers` currently includes:

- `cleanupTestDatabases`
- `createTestingFacade`
- `createTestingFacadeBuilder`
- `createTestingFacadeWithDatabase`
- `createUnitTestingFacade`
- `defineEntityFixtures`
- `installStandardHooks`
- `loadEntityFixtures`
- `makeMockRequest`
- `prepareEntityFixtures`
- `resetSrcModuleCache`
- `SqlTestingHelper`
- `setDefaultDatabaseConfig`

The fixture functions and `SqlTestingHelper` class are also exported individually from the package root, but `TestingHelpers` is the convenient facade for application tests.
