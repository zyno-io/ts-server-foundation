# Database

TSF provides a small database layer over `mysql2` and `pg`. It includes database factories, entity metadata, active-record helpers, sessions, transactions, raw SQL with bindings, a query builder, session locks, and schema migration tooling.

## Database Classes

Register entities with a database class and pass that class to `createApp()`.

```ts
import { BaseAppConfig, createApp, createDatabase } from '@zyno-io/ts-server-foundation';
import { User } from './entities/User';

class AppConfig extends BaseAppConfig {}

class AppDatabase extends createDatabase('postgres', {}, [User]) {}

export const app = createApp({
    config: AppConfig,
    db: AppDatabase
});
```

Available factories:

| Factory                                                 | Description                                      |
| ------------------------------------------------------- | ------------------------------------------------ |
| `createDatabase(config, entities)`                      | Selects `mysql` or `postgres` from `DB_ADAPTER`. |
| `createDatabase('mysql', config, entities)`             | Creates a MySQL/MariaDB database class.          |
| `createDatabase('postgres', config, entities)`          | Creates a PostgreSQL database class.             |
| `createMySQLDatabase(config, entities)`                 | MySQL/MariaDB-specific factory.                  |
| `createPostgresDatabase(config, entities)`              | PostgreSQL-specific factory.                     |
| `createDatabaseClass(driverFactory, entities, options)` | Wraps a custom `DatabaseDriver`.                 |

Factory config accepts the native driver pool config plus TSF options:

| Option             | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `enableLocksTable` | Enables MySQL session locks through a lock table. PostgreSQL uses advisory transaction locks. |
| `lockTableName`    | MySQL lock table name. Defaults to `_locks`.                                                  |

When pool options are omitted, connection settings are read from config/environment keys such as `MYSQL_HOST`, `MYSQL_DATABASE`, `PG_HOST`, and `PG_DATABASE`.

## Entities

Registered database entity classes must extend `BaseEntity`; database construction rejects other classes. `BaseEntity` supplies the active-record helpers and lets the database bind each entity class to its owning database.

```ts
import { AutoIncrement, BaseEntity, entity, MaxLength, PrimaryKey, UuidString } from '@zyno-io/ts-server-foundation';

@entity.name('users')
export class User extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    publicId!: UuidString;
    email!: string & MaxLength<255>;
    name!: string & MaxLength<120>;
    createdAt: Date = new Date();
}
```

The migration generator reads entity metadata to infer table names, column names, indexes, primary keys, defaults, nullability, enums, foreign keys, and custom TSF types. See [Types](./types.md) for the database effects of `UuidString`, `DateString`, `Length<N>`, and related annotations.

## Runtime Value Conversion And Validation

Database I/O does not run the reflected HTTP-input deserializer or validator over whole entities. TSF instead performs a small set of column-aware storage conversions and otherwise relies on the database driver and database engine.

| Path                                           | Outbound conversion                                           | Inbound conversion                                                 | Reflected validation |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------- |
| Entity `save()` / `saveEntity()`               | Column-aware                                                  | N/A                                                                | No                   |
| Query-builder filters and patches              | Column-aware                                                  | N/A                                                                | No                   |
| Query-builder entity hydration                 | N/A                                                           | Column-aware                                                       | No                   |
| `createEntity()` and related constructors      | None; assigns application values and fills framework defaults | N/A                                                                | No                   |
| `rawFind<T>()` / `rawFindOne<T>()`             | Generic SQL binding normalization only                        | Driver values returned unchanged                                   | No                   |
| `rawFindUnsafe<T>()` / `rawFindOneUnsafe<T>()` | Generic SQL binding normalization only                        | Type-directed `deserialize<T>()` with an explicit or inferable `T` | No                   |

Column-aware writes perform these conversions:

- `UUID` values become 16-byte MySQL values and normalized PostgreSQL UUID strings.
- Database `date` columns receive a UTC `YYYY-MM-DD` value.
- `Date` values bound to other columns become UTC SQL date-time strings.
- `Buffer`, `Uint8Array`, and `ArrayBuffer` values are normalized for binary columns.
- JSON columns are encoded with `JSON.stringify`.
- MySQL point columns accept `Coordinate`/GeoJSON-like values and are written with `ST_GeomFromText`.
- JavaScript `bigint` SQL bindings become decimal strings.

Query-builder hydration creates an entity instance and reverses the applicable storage conversions. It normalizes UUIDs, date-only strings, binary values, JSON strings, and MySQL points, then coerces reflected boolean columns, bigint columns, and finite numeric strings. Other values retain the form supplied by `mysql2` or `pg`. TSF-created MySQL pools interpret date and date-time values as UTC by default; caller-supplied pools retain their own timezone configuration. This client-side setting does not change the MySQL session `time_zone` used by server-generated or `timestamp` values.

These converters are not validators. They do not apply `TrimmedString`, phone normalization, email/pattern checks, length checks, numeric bounds, `ValidDate`, or custom reflected validators. A conversion that does not recognize a value generally leaves it unchanged. Database column types and constraints then determine whether the value is accepted. Nullability, uniqueness, foreign keys, enum/column types, widths, and other generated schema constraints are enforced by the database engine; reflected rules that are not represented in the schema are not enforced during persistence.

If application code needs runtime validation before persistence, call the compiler-backed `validate<T>()` or `validatedDeserialize<T>()` at the application boundary. HTTP DTO parameters already do this automatically before controller invocation.

## Active Record Helpers

Entities registered with a database can query and persist themselves.

```ts
const users = await User.query().filter({ email: 'a@example.com' }).find();

const user = User.reference(1);
user.name = 'Alice';
await user.save();
await user.delete();
```

`reference(value)` creates a clean entity reference with the primary key populated. It is useful when an API expects an entity instance but no database read is needed.

## Entity Creation

```ts
import { createEntity, createPersistedEntity, createQueuedEntity, persistEntity } from '@zyno-io/ts-server-foundation';

const user = createEntity(User, { email: 'a@example.com', name: 'Alice' });

await db.transaction(async session => {
    const queued = createQueuedEntity(User, { email: 'b@example.com', name: 'Bob' }, session);
    queued.name = 'Bobby';
});

const persisted = await createPersistedEntity(User, { email: 'c@example.com', name: 'Carol' });
await persistEntity(user);
```

`createEntity()` fills omitted auto-increment fields with `0` and nullable fields with `null`. Fields annotated with `HasDefault` can be omitted from inserts when their value is `undefined`.

Related helpers:

| Helper                                              | Description                                        |
| --------------------------------------------------- | -------------------------------------------------- |
| `createEntities(Entity, data[])`                    | Creates multiple unsaved entities.                 |
| `createQueuedEntities(Entity, data[], session)`     | Creates and queues multiple entities in a session. |
| `createPersistedEntities(Entity, data[], session?)` | Creates and persists multiple entities.            |
| `persistEntities(entities, session?)`               | Persists multiple existing entities.               |

## Retrieval Helpers

```ts
import { entityExists, getEntity, getEntityOr404, getEntityOrUndefined } from '@zyno-io/ts-server-foundation';

const user = await getEntity(User, 1);
const maybeUser = await getEntityOrUndefined(User, { email: 'a@example.com' });
const requiredUser = await getEntityOr404(User, 1);
const exists = await entityExists(User, { email: 'a@example.com' });
```

`getEntity()` throws `ItemNotFound`. `getEntityOr404()` throws `HttpNotFoundError`.

## Batched Lookups And Relations

The batched lookup helpers issue one `$in` query, deduplicate input IDs, and return hydrated entities:

```ts
import { getEntitiesById, getKeyedEntities, getKeyedGroupedEntities } from '@zyno-io/ts-server-foundation';

const users = await getEntitiesById({ schema: User, ids: [3, 1, 3] });
const usersById = await getKeyedEntities({ schema: User, ids: [1, 2, 3] });
const postsByAuthorId = await getKeyedGroupedEntities({
    schema: Post,
    ids: [1, 2, 3],
    keyField: 'authorId'
});
```

Options shared by these helpers:

| Option     | Meaning                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `schema`   | Registered `BaseEntity` class to query.                                                                                       |
| `ids`      | Values for the primary key or `keyField`. Duplicate and empty falsey values are ignored; number or bigint ID `0` is retained. |
| `keyField` | Field used for the `$in` query and returned object keys. Defaults to the entity primary key.                                  |
| `fields`   | Optional projected fields. Include the key field when requesting a keyed result.                                              |
| `filter`   | Additional query-builder filters.                                                                                             |
| `txn`      | Optional `DatabaseSession` used for the query.                                                                                |

`getKeyedEntities()` returns one entity per stringified key. If multiple rows share a key, the last row wins. `getKeyedGroupedEntities()` preserves all rows in an array per stringified key. Present keys such as `__proto__`, `constructor`, and `toString` are stored as own data properties. Use `Object.hasOwn(result, key)` before reading an arbitrary key. `getEntitiesByIdWithKeyName()` exposes the resolved key-field name together with the entity array for integrations that need both.

Relation resolvers attach lookup results to existing source objects:

```ts
import { resolveRelated, resolveRelatedByPivot } from '@zyno-io/ts-server-foundation';

await resolveRelated({
    src: posts,
    srcIdField: 'authorId',
    targetField: 'author',
    targetSchema: User
});

await resolveRelatedByPivot({
    src: users,
    pivotSchema: UserRole,
    pivotIdKey: 'userId',
    pivotRelatedKey: 'roleId',
    targetField: 'roles',
    targetSchema: Role
});
```

`resolveRelated()` assigns one related entity, or `undefined` when no matching row exists. `resolveRelatedByPivot()` assigns an array; every related result also has its pivot entity under `pivot`. It defaults the source ID field to the source entity primary key. `resolveRelatedByPivotForOne()` is the single-source convenience form. All resolver forms mutate and return the supplied source objects. When using `targetFields`, include the target primary key so results can be keyed.

## Query Builder

`db.query(Entity)` and `Entity.query()` return a `QueryBuilder`.

```ts
const users = await db
    .query(User)
    .filter({ active: true, age: { $gte: 18 } })
    .sort({ name: 'asc', id: -1 })
    .limit(50)
    .offset(100)
    .find();
```

Supported filter operators:

| Operator                     | SQL behavior                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `{ field: value }`           | Equality, with `null` mapped to `IS NULL`.                                     |
| `$ne`                        | Not equal, with `null` mapped to `IS NOT NULL`.                                |
| `$gt`, `$gte`, `$lt`, `$lte` | Comparison operators.                                                          |
| `$in`, `$nin`                | Inclusion/exclusion lists. Empty `$in` is false; `$nin` always excludes nulls. |
| `$like`, `$notLike`          | SQL `LIKE` and `NOT LIKE` pattern matching.                                    |
| `$and`, `$or`                | Top-level arrays of nested filter records. Empty `$or` is always false.        |

Because `$nin` excludes `null`/`undefined` values as well as listed values, an empty `$nin` renders as `IS NOT NULL`.

Query methods:

| Method                                         | Description                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `filter()` / `filterField()`                   | Adds equality or operator filters.                                   |
| `select(...fields)`                            | Limits hydrated results to selected entity fields.                   |
| `orderBy()` / `sort()`                         | Adds ordering; `sort()` also accepts a field-direction object.       |
| `limit()` / `offset()` / `skip()`              | Applies result paging.                                               |
| `find()`                                       | Returns hydrated entities.                                           |
| `findOne()` / `findOneOrUndefined()`           | Returns one entity, throwing or returning `undefined` when absent.   |
| `findField(field)`                             | Returns a single field from each row.                                |
| `findOneField()` / `findOneFieldOrUndefined()` | Returns one selected scalar field.                                   |
| `withMax(field)`                               | Selects `MAX(field)`; read it with `findField(field)`.               |
| `has()`                                        | Returns whether at least one row exists.                             |
| `count()`                                      | Returns a numeric count.                                             |
| `patchMany(patch)`                             | Updates rows matched by the query and returns affected primary keys. |
| `patchOne(patch)`                              | Directly updates the row identified by an exact primary-key filter.  |
| `deleteMany()`                                 | Deletes rows matched by the query and returns affected primary keys. |
| `deleteOne()`                                  | Directly deletes the row identified by an exact primary-key filter.  |
| `forUpdate()`                                  | Locks selected rows for the active transaction.                      |
| `toSelectSql()` / `toCountSql()`               | Returns a SQL fragment for inspection or composition.                |

`patchOne()` and `deleteOne()` require top-level exact equality filters for every primary-key component. Additional filters can be used for conditional mutations, such as transitioning a row only when it has an expected status.

Patch operations accept direct assignments and a top-level `$inc` object:

```ts
const result = await User.query()
    .filter({ tenantId, active: true })
    .patchMany({ lastSeenAt: new Date(), $inc: { loginCount: 1 } });

result.affectedRows;
result.primaryKeys; // [{ id: ... }, ...]
result.modified; // compatibility alias for affectedRows
```

All mutation methods return `QueryMutationResult`. Its enumerable fields are `affectedRows` and `primaryKeys`; `modified` is a non-enumerable compatibility alias.

## Sessions And Transactions

`db.transaction()` opens a connection, starts a transaction, waits for tracked query mutations, flushes queued/managed entities before commit, and rolls back on error. Use it for all connection-scoped work, including raw SQL sequences.

```ts
await db.transaction(async session => {
    const user = createQueuedEntity(User, { email: 'a@example.com', name: 'Alice' }, session);
    session.addPreCommitHook(async () => {
        await session.rawExecute(sql`INSERT INTO audit_log (message) VALUES (${'created user'})`);
    });
    session.addPostCommitHook(async () => {
        await notifyUserCreated(user.id);
    });
});
```

Unprojected entities loaded through `session.query(Entity)` become managed. A managed entity is dirty-checked and saved again at the next flush or commit. Projected queries (`select(...)`) are not managed. Session query reads do not flush queued writes first; session raw methods do.

Session methods:

| Method                                                        | Description                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `add(...entities)`                                            | Queues new or existing entities for persistence.                                        |
| `manage(...entities)`                                         | Adds clean existing entities to dirty tracking for later flushes.                       |
| `remove(...entities)`                                         | Cancels an unflushed new insert, or queues a managed/snapshotted entity for deletion.   |
| `removeQueued(...entities)`                                   | Removes only the queued-persistence state.                                              |
| `unmanage(...entities)`                                       | Clears queued, managed, and removal state for the entities.                             |
| `flush()`                                                     | Inserts queued entities, saves dirty managed entities, then performs queued deletions.  |
| `query(Entity)`                                               | Creates a query builder bound to the session connection.                                |
| `rawQuery()`, `rawFind()`, `rawFindOne()`, `rawExecute()`     | Flushes, then executes SQL through the session connection.                              |
| `raw(input)`                                                  | Returns an object with `execute()`, `find()`, and `findOne()` for one SQL input.        |
| `rawFindUnsafe()`, `rawFindOneUnsafe()`, `rawExecuteUnsafe()` | Flushes, then executes string SQL with manual bindings.                                 |
| `trackOperation(fn)` / `waitForPendingOperations()`           | Tracks query mutations so transaction commit waits for them and propagates rejection.   |
| `withoutAutoFlush(fn)`                                        | Temporarily suppresses database-method auto-flush behavior for internal/composed reads. |
| `savepoint(name)`                                             | Flushes and checkpoints the complete session/policy state at a database savepoint.      |
| `rollbackToSavepoint(name)`                                   | Rolls back the database and restores the matching complete session checkpoint.          |
| `withSavepoint(name, fn)`                                     | Runs a block and performs the same complete rollback if the block throws.               |
| `getTransactionState(key, create, checkpoint, restore)`       | Stores interceptor policy state that participates in savepoint rollback.                |
| `addPreCommitHook(fn)`                                        | Runs serially before commit, after normal flushes; failure rolls back the transaction.  |
| `addPostCommitHook(fn)`                                       | Runs serially after successful commit; it is skipped on rollback.                       |
| `acquireSessionLock(key)`                                     | Acquires a transaction-scoped database lock.                                            |

Use `db.withTransaction(existingSession, fn)` when helper functions should reuse a caller-provided session if one exists, or open a transaction otherwise.

`db.withConnection(fn)` scopes one acquired connection to all raw operations for that database inside the callback. Nested calls reuse the same connection, and the outer call releases it when the callback settles. It does not start a transaction; use `transaction()` when atomicity is required.

### Mutation interceptors

Database-level mutation interceptors enforce cross-cutting persistence policies without coupling TSF to a particular domain. They receive the net successful ORM changes once per transaction, after ordinary pre-commit hooks and before the final flush:

```ts
const unregister = db.registerMutationInterceptor({
    observes: metadata => metadata.classType === User,
    querySnapshotFields: metadata => (metadata.columns.some(column => column.propertyName === 'tenantId') ? ['tenantId'] : []),
    async beforeCommit({ session, mutations }) {
        for (const mutation of mutations) {
            if (mutation.kind === 'entity') {
                mutation.before;
                mutation.after;
                mutation.changedFields;
            }
        }

        // Derived commit artifacts use the same transaction.
        session.add(createEntity(ChangeIndex, { count: mutations.length }));
    }
});
```

Entity mutations are consolidated by entity identity: repeated flushes retain the earliest `before` snapshot and final `after` snapshot, separate instances of the same database row are combined, and net-zero changes are omitted. An update followed by deletion becomes one delete; an insert followed by deletion disappears from the mutation set.

`QueryBuilder.patchOne()`, `patchMany()`, `deleteOne()`, and `deleteMany()` produce `kind: 'query'` mutations with the entity metadata, affected primary keys, expanded changed-field names (including fields nested under `$inc`), and the patch expression for updates. Interceptors can request persisted pre-mutation policy fields with `querySnapshotFields()`. Those values are aligned with `primaryKeys` in `before`; query mutations deliberately do not claim to contain arbitrary before/after entity snapshots, so policy layers can handle them explicitly or reject them.

When a query mutation is observed, TSF selects and locks its target rows with `FOR UPDATE` in the same transaction before applying the write. The mutation therefore reports the stable primary-key set selected for that write rather than a stale preselection that another transaction can delete or change concurrently.

Observed query mutations cannot patch primary-key fields because interceptor records use the stable pre-mutation key as their durable row identity. Load and explicitly replace the entity when an identity change is genuinely required. QueryBuilder primary-key patches remain available when no mutation interceptor observes the entity.

Once an interceptor observes an entity class, direct entity writes and query-builder mutations for that class automatically run in a transaction. Explicit non-transactional sessions and sessions owned by another database are rejected. Interceptor failure vetoes the commit and rolls the transaction back. Entities queued by an interceptor are flushed atomically before commit and are not recursively passed through the interceptor chain.

Both the public `savepoint()`/`rollbackToSavepoint()` pair and `withSavepoint()` restore queued, managed, removed, hook, mutation-accumulator, and transaction-local policy state. Entity state is restored across every touched instance by object identity and, for instances first encountered after the checkpoint, by entity class plus complete primary key. An entity inserted after the checkpoint is restored to an unpersisted state, including its prior auto-increment sentinel, so any instance representing that rolled-back row can be queued and inserted again. Policies should store mutable transaction state through `getTransactionState()` so a rolled-back claim or marker cannot affect later work.

Observed existing-entity updates and deletes lock and load the persisted row immediately before writing, so interceptors receive the real prior snapshot rather than a stale load or caller-supplied defaults. Updates merge only the caller's dirty fields into that authoritative row for the final snapshot and synchronize untouched concurrent values back to the entity instance. Entity update/delete and query mutations with zero affected rows are omitted. Raw SQL cannot be mapped reliably to ORM entities and is therefore outside mutation interception; applications that enforce entity-level policies should constrain or wrap raw writes separately.

Mutation interceptors should only validate changes or write transaction-local derived artifacts. External side effects belong in a post-commit hook.

## Session Locks

Locks are transaction-scoped.

```ts
await db.transaction(async session => {
    await session.acquireSessionLock(['billing-account', accountId]);
    await recalculateBalance(accountId, session);
});
```

PostgreSQL uses `pg_advisory_xact_lock()`. MySQL/MariaDB uses a `_locks` table. Set `enableLocksTable: true` to let TSF create and prune that table automatically, or provision the DKSF-compatible table yourself.

## Raw SQL

Use the `sql` tag for values and identifiers.

```ts
import { sql } from '@zyno-io/ts-server-foundation';

const rows = await db.rawFind<{ id: number; email: string }>(
    sql`SELECT ${sql.identifier('id')}, ${sql.identifier('email')}
        FROM ${sql.identifier('users')}
        WHERE ${sql.identifier('active')} = ${true}`
);

await db.rawExecute(
    sql`UPDATE ${sql.identifier('users')}
        SET ${sql.identifier('lastLoginAt')} = ${new Date()}
        WHERE ${sql.identifier('id')} = ${userId}`
);
```

`rawQuery<T>()` is the base row-returning method, and `rawFind<T>()` is its alias. `rawFindOne()` returns the first row or `undefined`. `rawExecute()` returns `{ affectedRows, rowCount?, insertId?, warningStatus? }`.

The generic type on `rawFind<T>()` is a TypeScript-only assertion: returned rows keep the values produced by the database driver. The unsafe string methods have an additional compiler-injected reflected type slot, so an explicit or otherwise inferable `T` on `rawFindUnsafe<T>()` and `rawFindOneUnsafe<T>()` passes rows through `deserialize<T>()`. A call without a resolvable row type keeps the driver's values unchanged.

Reflected raw-row deserialization is type-directed rather than column-aware. It recursively converts numeric boolean values such as MySQL `TINYINT(1)` (`0`, `1`, or other numeric values) to booleans, converts numeric strings to numbers when the target is `number`, and can construct reflected classes. Consequently, type precision-sensitive `DECIMAL` results as `string`, not `number`, and treat deserialized entity instances as unmanaged objects without ORM snapshots. The operation does not validate rows; prefer the query builder when entity column-aware hydration and persistence tracking are required.

The unsafe variants accept a SQL string and bindings:

```ts
await db.rawFindUnsafe('SELECT * FROM users WHERE email = ?', ['a@example.com']);
```

See [SQL](./sql.md) for fragment composition and rendering details.

## Database Errors

MySQL duplicate-entry errors (`ER_DUP_ENTRY`/errno `1062`) and PostgreSQL unique violations (`23505`) are normalized to `UniqueConstraintError` at query, execute, and transaction boundaries. The normalized error retains the driver error as `cause`.

```ts
import { isUniqueConstraintError } from '@zyno-io/ts-server-foundation';

try {
    await user.save();
} catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
}
```

Other driver errors pass through unchanged. `normalizeDatabaseError()` is exported for integrations that need the same normalization outside `BaseDatabase`.

## Dirty Tracking

Hydrated entities are marked clean. `save()` or `saveEntity()` updates only changed non-primary-key fields.

```ts
import { getDirtyDetails, getDirtyFields, getFieldOriginal, isEntityDirty, isFieldDirty, revertDirtyEntity } from '@zyno-io/ts-server-foundation';

user.name = 'Alice Updated';

isEntityDirty(user); // true
getDirtyFields(user); // ['name']
isFieldDirty(user, 'name'); // true
getFieldOriginal(user, 'name'); // previous value
getDirtyDetails(user); // { name: { original, current } }

revertDirtyEntity(user);
```

## Schema Builder

`db.schema.create()` creates tables from an imperative builder. It is useful for hand-written migrations.

```ts
await db.schema.create('api_tokens', table => {
    table.uuidString('id').primary();
    table.string('name', 120);
    table.string('tokenHash', 255).unique();
    table.time('expiresAfterLocalTime').nullable();
    table.dateTime('createdAt').defaultRaw('CURRENT_TIMESTAMP');
    table.index(['name']);
});
```

Database-level methods:

| Method                       | Behavior                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| `create(name, callback)`     | Creates a table, its indexes, and its foreign keys.                    |
| `alter(name, callback)`      | Applies ordered drop, rename, add, and modify operations.              |
| `drop()` / `dropIfExists()`  | Drops a table, with optional existence guard.                          |
| `rename(from, to)`           | Renames a table with dialect-specific SQL.                             |
| `enumType(name, values)`     | Creates a PostgreSQL enum type and text cast; it is a no-op for MySQL. |
| `raw(statement)`             | Executes a raw schema statement.                                       |
| `onlyOn(dialect, callback)`  | Runs an async schema callback only for the active dialect.             |
| `hasTable()` / `hasColumn()` | Checks the active database's schema catalog.                           |
| `hasIndex()`                 | Checks the active database's index catalog.                            |
| `flush()`                    | Clears the in-memory PostgreSQL enum-type deduplication registry.      |

Column methods:

| Family          | Methods                                                              |
| --------------- | -------------------------------------------------------------------- |
| Identifiers     | `id`, `uuidString`, `uuid`                                           |
| Strings         | `string`, `char`, `text`, `tinyText`, `mediumText`, `longText`       |
| Integers        | `integer`, `tinyint`, `smallint`, `bigint`, `bigInteger`             |
| Numeric         | `float`, `double`, `decimal`                                         |
| Boolean         | `boolean`                                                            |
| Date/time       | `dateTime`, `timestamp`, `timestamptz`, `time`, `date`, `timestamps` |
| Structured/data | `json`, `jsonb`, `binary`, `blob`, `enum`, `point`                   |

`point()` is MySQL-only. `jsonb()` and binary/blob types choose the nearest supported representation for the active dialect. `timestamps()` adds `createdAt` and `updatedAt` defaults and a MySQL `ON UPDATE` expression.

MySQL booleans are emitted as `tinyint(1) unsigned`; PostgreSQL booleans are emitted as `boolean`. Generated schema and entity index/foreign-key names are shortened with a stable hash when they exceed the active dialect identifier limit.

Column modifiers:

`primary`, `nullable(value?)`, `notNull`, `unsigned(value?)`, `autoIncrement(value?)`, `default(value)`, `defaultRaw(expression)`, `onUpdate(expression)`, `index(name?)`, `unique(name?)`, `references(column)`, `change`, `after(column)`, and `first`.

`change()` marks a column declared inside `alter()` as a modification instead of an addition. `after()` and `first()` affect MySQL column placement; PostgreSQL does not emit a placement clause.

Table constraint methods:

- `primary(columns)` creates a composite/table primary key.
- `index(columns, name?)`, `unique(columns, name?)`, and `spatialIndex(columns, name?)` add indexes.
- `foreign(columns, name?)` returns a builder supporting `references()`, `referencesAll()`, `on()`, `onDelete()`, `onUpdate()`, and `name()`.

Alter-only removals and renames are `dropColumn`, `renameColumn`, `dropIndex`, `dropUnique`, `renameIndex`, `dropForeign`, and `dropPrimary`. Alter operations execute in dependency-aware groups: foreign keys and indexes are dropped before structural column changes, while new indexes and foreign keys are added afterward.

## Migrations

Migration files export a function or a `Migration` object.

```ts
import { createMigration, sql } from '@zyno-io/ts-server-foundation';
import type { BaseDatabase } from '@zyno-io/ts-server-foundation';

export default createMigration(async (db: BaseDatabase) => {
    await db.rawExecute(sql`ALTER TABLE ${sql.identifier('users')} ADD ${sql.identifier('archivedAt')} datetime NULL`);
});
```

Run compiled migrations with `tsf-migrate run`. Generate entity/database diffs with `tsf-migrate create`. See [Migrations](./migrations.md) for the full command reference.

The migration runner logs count summaries and per-migration lifecycle messages with the `Migrator` scope: migrations found, migrations previously executed, migrations to run, `Running migration: <name>`, and `Completed migration: <name>`.

## Query Observation

Database queries can be observed by DevConsole and tests.

```ts
import { registerDatabaseQueryObserver } from '@zyno-io/ts-server-foundation';

const stop = registerDatabaseQueryObserver(entry => {
    if (entry.phase === 'finish') console.log(entry.sql, entry.durationMs, entry.error);
});
```

Observers receive start/finish events with SQL, bindings, dialect, operation, timing, and errors.
