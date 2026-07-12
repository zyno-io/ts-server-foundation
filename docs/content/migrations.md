# Migrations

TSF migrations are TypeScript files that compile to JavaScript and run against a `BaseDatabase`. The tooling can generate migrations from entity/schema differences, run pending migrations, reset source migrations to a base migration, and standardize MySQL charset/collation.

## Migration Files

Migration files export a function or a `Migration` object.

```ts
import { createMigration, sql } from '@zyno-io/ts-server-foundation';
import type { BaseDatabase } from '@zyno-io/ts-server-foundation';

export default createMigration(async (db: BaseDatabase) => {
    await db.rawExecute(sql`
        ALTER TABLE ${sql.identifier('users')}
        ADD ${sql.identifier('archivedAt')} datetime NULL
    `);
});
```

You can also name a migration explicitly:

```ts
import { defineMigration } from '@zyno-io/ts-server-foundation';

export const migration = defineMigration('20260630_120000_add_users', async db => {
    await db.schema.create('users', table => {
        table.integer('id').primary().autoIncrement();
        table.string('email', 255);
    });
});
```

## Running Migrations In Code

```ts
import { loadMigrationsFromDirectory, MigrationRunner } from '@zyno-io/ts-server-foundation';

const migrations = await loadMigrationsFromDirectory('dist/src/migrations');
const executions = await new MigrationRunner(db).run(migrations);
```

`MigrationRunner` sorts migrations lexicographically by name, records completed migrations in `_migrations` by default, and skips recorded names on later runs. Each record contains `name`, `executedAt`, and `durationMs`; the returned `MigrationExecution[]` contains the migrations completed by that call.

The constructor accepts a custom tracking-table name and logger. `run()` accepts a `beforeRun` callback:

```ts
import { MigrationRunner } from '@zyno-io/ts-server-foundation';

const runner = new MigrationRunner(db, 'service_migrations');
await runner.run(migrations, {
    beforeRun: async migrationDb => {
        await migrationDb.rawExecute('SET lock_timeout = 5000');
    }
});
```

`beforeRun` runs on the scoped migration connection before the tracking table is created or read. The runner then creates the tracking table if necessary, reads completed names, and executes pending migrations one at a time. A migration is recorded only after its `up` function succeeds.

The runner scopes a connection but does not automatically wrap each migration in a transaction. If an `up` function fails, it logs the failure, stops immediately, does not record that migration, and does not run later migrations. Use `db.transaction()` inside a migration when the dialect and migration operations support transactional DDL and atomicity is required.

Convenience functions:

- `runMigrations(db, migrations, options?)` creates a default runner.
- `runMigrationsFromDirectory(db, directory)` loads compiled files and runs them.
- `loadMigrationsFromDirectory(directory)` only loads and normalizes migration exports.

## CLI

The `tsf-migrate` binary loads a compiled app module, resolves `BaseDatabase` from the app, and runs the selected command.

```bash
corepack yarn build
corepack yarn tsf-migrate create --app dist/src/app.js --description add_users
corepack yarn tsf-migrate run --app dist/src/app.js
```

Commands:

| Command      | Description                                                                |
| ------------ | -------------------------------------------------------------------------- |
| `create`     | Creates a raw SQL migration from entity/database diff.                     |
| `create:raw` | Alias for `create`.                                                        |
| `run`        | Runs compiled migrations from the dist migrations directory.               |
| `reset`      | Removes source migration files and creates a base migration from entities. |
| `charset`    | Standardizes MySQL database/table charset and collation.                   |

Options:

| Option                               | Description                                            |
| ------------------------------------ | ------------------------------------------------------ |
| `--app <path>`                       | Compiled app module. Defaults to the emitted path for `src/app.ts`. |
| `--description <text>` / `-d <text>` | Migration file description. Default `auto_migration`.  |
| `--migrations-dir <path>`            | Source migration directory. Default `src/migrations`.  |
| `--pg-schema <schema>`               | PostgreSQL schema for introspection.                   |
| `--table <name>`                     | Limit diff generation to one table. Repeatable.        |
| `--tables <a,b>`                     | Limit diff generation to a comma-separated table list. |

## Diff Generation

`createMigrationPlan(db, options)` compares entity metadata to the live database.

```ts
import { createMigrationPlan, writeMigrationFile } from '@zyno-io/ts-server-foundation';

const plan = await createMigrationPlan(db, { tableNames: ['users'] });

if (plan.hasChanges) {
    writeMigrationFile(plan.statements, 'update_users');
}
```

The generated plan includes:

- added and removed tables
- added, removed, modified, and renamed columns
- primary key changes
- indexes and unique indexes
- foreign keys
- MySQL enum definitions
- PostgreSQL enum type changes
- external foreign key drops/adds needed for scoped table changes

Generated statements are dependency ordered. Existing inbound, removed, modified, or temporarily preserved foreign keys are dropped first. Table/column/index/primary-key work follows, and new or restored foreign keys are added after referenced structures exist.

::: warning Review destructive changes
Diff generation can emit `DROP TABLE`, `DROP COLUMN`, index/constraint drops, enum rewrites, type changes, and nullability changes. Renames are inferred only where the comparator has enough evidence; an intended rename can otherwise appear as a drop plus add. Read every generated migration, verify its table scope and PostgreSQL schema, and add any required data backfill or explicit rename before running it.
:::

`tableNames`/`--table` narrows entity and database comparison, but changes to referenced tables can still require temporary drops and restores of inbound foreign keys owned by tables outside that scope.

## Schema Builder In Migrations

Use `db.schema.create()` for hand-written table creation.

```ts
await db.schema.create('api_tokens', table => {
    table.uuidString('id').primary();
    table.string('name', 120);
    table.string('tokenHash', 255).unique();
    table.time('expiresAfterLocalTime').nullable();
    table.dateTime('createdAt').defaultRaw('CURRENT_TIMESTAMP');
});
```

Available column builders:

`id`, `uuidString`, `uuid`, `string`, `char`, `text`, `tinyText`, `mediumText`, `longText`, `integer`, `tinyint`, `smallint`, `bigint`, `bigInteger`, `float`, `double`, `decimal`, `boolean`, `dateTime`, `timestamp`, `timestamptz`, `time`, `date`, `json`, `jsonb`, `binary`, `blob`, `enum`, and MySQL-only `point`.

MySQL booleans are emitted as `tinyint(1) unsigned`; PostgreSQL booleans are emitted as `boolean`. Generated schema and entity index/foreign-key names are shortened with a stable hash when they exceed the active dialect identifier limit.

Column modifiers include `primary`, `nullable`, `notNull`, `unsigned`, `autoIncrement`, `default`, `defaultRaw`, `onUpdate`, `index`, `unique`, `references`, `change`, `after`, and `first`. Table builders support primary, ordinary/unique/spatial indexes, and single/composite foreign keys. Alter builders also support column, index, foreign-key, and primary-key drops and renames.

See [Database: Schema Builder](./database.md#schema-builder) for the complete database-level and builder API.

## Reset

`resetMigrations(db, options)` removes every `.ts` file from the source migration directory and writes `00000000_000000_base.ts` containing table creation DDL for all registered entities. Non-`.ts` files are left in place. If there are no registered entity tables, it creates the directory if needed but does not write a base migration.

```ts
import { resetMigrations } from '@zyno-io/ts-server-foundation';

await resetMigrations(db, { migrationsDir: 'src/migrations' });
```

CLI:

```bash
corepack yarn tsf-migrate reset --app dist/src/app.js
```

::: warning
`reset` permanently deletes the source `.ts` migration files in the selected directory before writing the base file. Commit or back up migrations first, and verify `--migrations-dir` before running it.
:::

## MySQL Charset

```bash
corepack yarn tsf-migrate charset utf8mb4 utf8mb4_0900_ai_ci --app dist/src/app.js
```

The charset command is MySQL/MariaDB-only. PostgreSQL databases are skipped.

## Loading Directories

`loadMigrationsFromDirectory()` accepts a source or compiled directory. For a source path, it reads the effective TypeScript `rootDir` and `outDir` (including inherited settings) and resolves the emitted directory. For example, `src/migrations` maps to `dist/src/migrations` with `rootDir: "."`, and to `dist/migrations` with `rootDir: "./src"`.

When source migration files exist but no compiled migration files can be found, loading fails with the paths that were searched. This prevents a build-layout mismatch from being reported as a successful run with zero migrations. Projects without resolvable compiler settings retain the conventional `dist/src/migrations` and `dist/migrations` fallbacks.

Supported compiled file extensions are `.js`, `.cjs`, and `.mjs`.

A module may export a migration function or `Migration` object as either `default` or `migration`. Function exports use the compiled filename without its extension as the migration name. An invalid module stops directory loading with an error.
