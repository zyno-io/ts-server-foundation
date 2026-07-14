# SQL

The `sql` helper builds parameterized SQL fragments that render correctly for MySQL/MariaDB and PostgreSQL.

```ts
import { renderSql, sql } from '@zyno-io/ts-server-foundation';

const query = sql`
    SELECT ${sql.identifier('id')}, ${sql.identifier('email')}
    FROM ${sql.identifier('users')}
    WHERE ${sql.identifier('active')} = ${true}
`;

renderSql(query, 'postgres');
// { sql: 'SELECT "id", "email" FROM "users" WHERE "active" = $1', bindings: [true] }
```

## Values

Interpolated plain values become bindings.

```ts
await db.rawFind(sql`SELECT * FROM ${sql.identifier('users')} WHERE ${sql.identifier('id')} = ${userId}`);
```

Rendering uses `?` placeholders for MySQL/MariaDB and `$1`, `$2`, ... placeholders for PostgreSQL.

## Identifiers

Use `sql.identifier()` for table, schema, and column names.

```ts
sql.identifier('users');
sql.identifier('public', 'users');
```

Identifiers are quoted for the target dialect. Identifier segments cannot be empty or contain null bytes.

## Joining Fragments

Use `sql.join()` when building dynamic lists.

```ts
const columns = ['id', 'email', 'name'].map(name => sql.identifier(name));
const query = sql`SELECT ${sql.join(columns)} FROM ${sql.identifier('users')}`;
```

The default separator is `, `. Pass a custom SQL fragment for other separators.

```ts
const where = sql.join(
    filters.map(filter => sql`${sql.identifier(filter.field)} = ${filter.value}`),
    sql` AND `
);
```

## Trusted Raw SQL

Use `sql.rawTrusted()` only for static SQL keywords or expressions that are not user input.

```ts
const direction = sortDescending ? sql.rawTrusted('DESC') : sql.rawTrusted('ASC');
const query = sql`SELECT * FROM ${sql.identifier('users')} ORDER BY ${sql.identifier('name')} ${direction}`;
```

Never pass untrusted strings to `rawTrusted()`.

## Placeholder Strings

`createSqlQuery(sqlText, bindings)` accepts `?` placeholders and a bindings array.

```ts
import { createSqlQuery } from '@zyno-io/ts-server-foundation';

const query = createSqlQuery('SELECT * FROM users WHERE email = ?', ['a@example.com']);
await db.rawFind(query);
```

The number of `?` placeholders must match the number of bindings.

## Raw Database Methods

```ts
const rows = await db.rawFind<UserRow>(sql`SELECT * FROM ${sql.identifier('users')}`);
const row = await db.rawFindOne<UserRow>(sql`SELECT * FROM ${sql.identifier('users')} WHERE ${sql.identifier('id')} = ${id}`);
const result = await db.rawExecute(sql`DELETE FROM ${sql.identifier('users')} WHERE ${sql.identifier('id')} = ${id}`);
```

`rawFind<T>()` and `rawFindOne<T>()` return driver-provided row values; their generic type is not a runtime deserialization or validation request. SQL bindings normalize valid `Date` values to UTC SQL date-time strings and JavaScript `bigint` values to decimal strings, but raw methods do not have entity column metadata for UUID, date-only, binary, JSON, or point conversion.

Session methods mirror database methods and run on the session connection:

```ts
await db.transaction(async session => {
    await session.rawExecute(sql`INSERT INTO ${sql.identifier('audit_log')} (${sql.identifier('message')}) VALUES (${'started'})`);
});
```

## Unsafe Methods

The unsafe methods take a string and bindings array directly.

```ts
await db.rawFindUnsafe('SELECT * FROM users WHERE email = ?', ['a@example.com']);
await session.rawExecuteUnsafe('UPDATE users SET active = ? WHERE id = ?', [false, id]);
```

Prefer the `sql` tag for new code because identifiers and values stay explicit in the same expression.

When TSF's metadata compiler can resolve an explicit or inferable `T`, `rawFindUnsafe<T>()` and `rawFindOneUnsafe<T>()` reflected-deserialize returned rows. Numeric values targeting booleans are converted to `true` or `false`, including MySQL `TINYINT(1)` results. Numeric strings targeting `number` are also converted, so precision-sensitive `DECIMAL` results should be typed as `string`. Calls without a resolvable row type keep driver-native values. Typed raw reads do not validate rows or attach ORM persistence state; use query-builder entity reads for column-aware hydration.

## Rendering For Logs Or Tests

```ts
const rendered = renderSql(sql`SELECT ${1}`, 'mysql');

rendered.sql; // 'SELECT ?'
rendered.bindings; // [1]
```

`renderSql()` is useful for assertions, debugging, and custom drivers.
