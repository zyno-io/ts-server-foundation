# Types

Custom type annotations integrate with reflected type metadata, validation, deserialization, OpenAPI, and the migration generator.

Import them from the package root:

```ts
import {
    DateString,
    EmailAddress,
    GreaterThan,
    Length,
    OptionalNulls,
    PhoneNumber,
    TrimmedString,
    UUID,
    UuidString
} from '@zyno-io/ts-server-foundation';
```

The important distinction is that not every type affects every layer. Some types only validate input, some only change generated database schema, and some do both.

In the table below, runtime validation/deserialization means the explicit reflection helpers and automatic HTTP input pipeline. Entity creation and database saves do not automatically run these validators or deserialization transforms; database-specific runtime conversion is documented in [Database](./database.md#runtime-value-conversion-and-validation).

## Type Utility Helpers

### `OptionalNulls<T>`

`OptionalNulls<T>` makes properties optional when their type includes `null`, while leaving non-nullable properties required.

```ts
class DbEntity extends BaseEntity {
    name!: string;
    color!: string | null;
}

type ControllerDto = OptionalNulls<Pick<DbEntity, 'name' | 'color'>>;
// { name: string; color?: string | null }
```

## Storage And Schema Effects

| Type                      | Runtime validation/deserialization                                      | Migration column                                                   | OpenAPI schema                                |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `DateString`              | Validates `YYYY-MM-DD`.                                                 | `date` on MySQL and PostgreSQL.                                    | `string`, `format: date`.                     |
| `UuidString`              | Validates UUID-formatted strings.                                       | MySQL `char(36)`, PostgreSQL `uuid`.                               | `string`, `format: uuid`.                     |
| `UUID`                    | Validates UUID-formatted strings.                                       | MySQL `binary(16)`, PostgreSQL `uuid`.                             | `string`, `format: uuid`.                     |
| `PhoneNumber`             | Normalizes to E.164 and rejects invalid phones.                         | `varchar(20)`.                                                     | `string`.                                     |
| `PhoneNumberNANP`         | Normalizes to NANP digits without `+1` and rejects invalid phones.      | `varchar(20)`.                                                     | `string`.                                     |
| `Length<N>`               | `MinLength<N>` and `MaxLength<N>`.                                      | `char(N)`.                                                         | `string` with `minLength: N`, `maxLength: N`. |
| `string & MaxLength<N>`   | `maxLength` validation.                                                 | `varchar(N)`.                                                      | `string` with `maxLength: N`.                 |
| `TrimmedString`           | Trims during deserialization.                                           | Normal string mapping unless combined with another annotation.     | Normal string schema.                         |
| `NonEmptyTrimmedString`   | Trims and applies `MinLength<1>`.                                       | Normal string mapping unless combined with another annotation.     | `string` with `minLength: 1`.                 |
| `EmailAddress`            | Regex validation.                                                       | Normal string mapping unless combined with another annotation.     | `string` with the email regex pattern.        |
| `number & GreaterThan<N>` | Rejects values `<= N`.                                                  | MySQL numeric columns are unsigned when the lower bound is `>= 0`. | `number` with `exclusiveMinimum: N`.          |
| `number & LessThan<N>`    | Rejects values `>= N`.                                                  | Does not choose a column type.                                     | `number` with `exclusiveMaximum: N`.          |
| `ValidDate`               | Rejects `Invalid Date` values.                                          | Normal `Date` mapping: MySQL `datetime`, PostgreSQL `timestamp`.   | `string`, `format: date-time`.                |
| `UnsignedNumber`          | `Minimum<0>` validation.                                                | MySQL numeric columns are unsigned when the minimum is `>= 0`.     | `number` with `minimum: 0`.                   |
| `MySQLCoordinate`         | `Coordinate` object shape.                                              | MySQL `point`.                                                     | Normal object schema.                         |
| `NullableMySQLCoordinate` | `Coordinate \| null` object shape.                                      | MySQL `point`, nullable.                                           | Normal nullable object schema.                |
| `HasDefault`              | Marks undefined values as omittable for entity creation/insert helpers. | Does not choose a column type.                                     | No OpenAPI effect.                            |
| `OnUpdate<T>`             | No runtime validation.                                                  | Adds the column `ON UPDATE` expression where supported.            | No OpenAPI effect.                            |

For fixed-width storage, use `Length<N>`. For variable-width storage, use `string & MaxLength<N>`.

## Strings

### `TrimmedString` and `NonEmptyTrimmedString`

`TrimmedString` trims incoming string values during reflected deserialization. `NonEmptyTrimmedString` also applies `MinLength<1>`.

These types do not change the database column type by themselves. In an entity, they still use the normal string mapping unless combined with `Length<N>`, `MaxLength<N>`, or a database annotation.

```ts
import { NonEmptyTrimmedString, TrimmedString } from '@zyno-io/ts-server-foundation';

class UserInput {
    name!: NonEmptyTrimmedString;
    notes!: TrimmedString;
}
```

### `EmailAddress`

`EmailAddress` validates against the project email regex and emits that pattern into OpenAPI.

It does not imply a database-specific email column type. In an entity it maps like a normal string, so add `MaxLength<N>` when the column size matters.

```ts
import { EmailAddress } from '@zyno-io/ts-server-foundation';
import { MaxLength } from '@zyno-io/ts-server-foundation';

class User {
    email!: EmailAddress & MaxLength<255>;
}
```

### `Length<N>`

`Length<N>` is a fixed-length string type. It is implemented as `MinLength<N> & MaxLength<N>` plus a TSF marker annotation, so validation, OpenAPI, and the migration type mapper can all read it.

In generated migrations, `Length<6>` becomes `char(6)`. If you want `varchar(6)`, use `string & MaxLength<6>` instead.

```ts
import { Length } from '@zyno-io/ts-server-foundation';

class VerificationCode {
    code!: Length<6>; // char(6)
}
```

## Dates

### `DateString`

`DateString` validates `YYYY-MM-DD`, maps to a database `date` column, and appears in OpenAPI as a date string.

Use this for calendar dates without a time. Use `Date` or `ValidDate` for timestamps.

```ts
import { DateString } from '@zyno-io/ts-server-foundation';

class Event {
    date!: DateString; // date
}
```

### `ValidDate`

`ValidDate` rejects `Invalid Date` values during validation.

It keeps normal `Date` storage semantics: MySQL `datetime`, PostgreSQL `timestamp`, and OpenAPI `string` with `format: date-time`.

```ts
import { ValidDate } from '@zyno-io/ts-server-foundation';

class ScheduledTask {
    startsAt!: ValidDate;
}
```

## Phone Numbers

Phone types use `google-libphonenumber` during deserialization and validation. In generated migrations, both phone types map to `varchar(20)`.

### `PhoneNumber`

International E.164 format with `+` prefix:

```ts
import { PhoneNumber } from '@zyno-io/ts-server-foundation';

class Contact {
    phone!: PhoneNumber; // '+12025550125'
}
```

### `PhoneNumberNANP`

North American Numbering Plan format without the `+1` prefix:

```ts
import { PhoneNumberNANP } from '@zyno-io/ts-server-foundation';

class Contact {
    phone!: PhoneNumberNANP; // '2025550125'
}
```

### Utilities

```ts
import { cleanPhone, formatPhoneFriendly } from '@zyno-io/ts-server-foundation';

cleanPhone('(202) 555-0125'); // '+12025550125'
cleanPhone('invalid'); // null
formatPhoneFriendly('+12025550125', 'US'); // '(202) 555-0125'
```

## Database Annotations

### `UuidString` and `UUID`

Both aliases validate UUID-formatted strings and emit OpenAPI `string` schemas with `format: uuid`. Their MySQL storage differs:

- `UuidString` uses `char(36)` and remains a string in database bindings and hydrated entities.
- `UUID` uses `binary(16)` and converts between the application string and compact MySQL storage.
- PostgreSQL uses its native `uuid` type for both aliases.

```ts
import { UUID, UuidString } from '@zyno-io/ts-server-foundation';

class Resource {
    id!: UUID;
    externalId!: UuidString;
}
```

### `HasDefault`

Marks a field as having an application/database default so entity creation and insert helpers can treat `undefined` as "omit this column".

`HasDefault` does not pick a database column type. It only changes optional/default handling.

```ts
import { HasDefault } from '@zyno-io/ts-server-foundation';

class User {
    role!: string & HasDefault;
    isAdmin: boolean & HasDefault = false;
}
```

Fields with TypeScript initializers are also read by the migration generator and can produce SQL defaults. For example, `count: number = 0` produces `DEFAULT '0'`, and `createdAt: Date = new Date()` produces `DEFAULT CURRENT_TIMESTAMP`.

### `OnUpdate<T>`

Column `ON UPDATE` expression annotation:

```ts
import { OnUpdate } from '@zyno-io/ts-server-foundation';

class User {
    updatedAt!: Date & OnUpdate<'CURRENT_TIMESTAMP'>;
}
```

This is primarily useful for MySQL timestamp columns. PostgreSQL does not have a direct column-level `ON UPDATE` equivalent.

### `UnsignedNumber`

Number with a minimum value of `0`. In MySQL migrations, any numeric field with a minimum value greater than or equal to zero is emitted as unsigned.

```ts
import { UnsignedNumber } from '@zyno-io/ts-server-foundation';

class Counter {
    value!: UnsignedNumber;
}
```

### `MySQLCoordinate` and `NullableMySQLCoordinate`

MySQL `POINT` geometry type. These are MySQL-specific types; do not use them in PostgreSQL entities unless you provide a custom mapping.

```ts
import { MySQLCoordinate, NullableMySQLCoordinate } from '@zyno-io/ts-server-foundation';

class Location {
    coords!: MySQLCoordinate;
    optionalCoords!: NullableMySQLCoordinate;
}

const coords = { x: -73.9857, y: 40.7484 };
```

## Utility Types

The package also exports common utility types:

```ts
type ConcretePrimitive = string | number | boolean;
type DefinedPrimitive = ConcretePrimitive | null;
type Primitive = DefinedPrimitive | undefined;
type StrictBool = true | false;
type KVObject<T = any> = Record<string, T>;
type NestedKVObject<T = any> = KVObject<T | T[] | KVObject<T>>;
type Serializable<T = ConcretePrimitive> = T | T[] | NestedKVObject<T> | NestedKVObject<T>[];
```

Field and method helpers:

```ts
type RequireFields<T, K extends keyof T> = T & { [P in K]-?: T[P] };
type ObjectKeysMatching<O, V> = {
    [K in keyof O]: O[K] extends V ? K : V extends O[K] ? K : never;
}[keyof O];
type MethodsOf<T> = { [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]: T[K] };
type MethodKeys<T> = keyof MethodsOf<T>;
```

Class helpers:

```ts
import { getClassName, isClass } from '@zyno-io/ts-server-foundation';
```
