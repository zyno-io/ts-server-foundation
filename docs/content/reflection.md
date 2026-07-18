# Type Reflection

TSF's compiler emits runtime descriptions of TypeScript types. Routing, dependency injection, validation, deserialization, OpenAPI, configuration, and database metadata all consume this shared representation.

This page documents the public runtime APIs. See [Type Reflection Architecture](./type-reflection-architecture.md) for compiler policy and subsystem boundaries.

## Compiler Requirement

Generic reflection calls work because the TSF compiler adds a metadata argument to recognized calls. Configure the transform as described in [Getting Started](./getting-started.md#typescript-configuration), and build application code with `ttsc` or the TSF commands.

The compiler recognizes these generic entrypoints:

- `typeOf<T>()`
- `deserialize<T>()`
- `validate<T>()`
- `validatedDeserialize<T>()`
- `cast<T>()`
- `assert<T>()`
- `is<T>()`

Calling `typeOf<T>()`, `deserialize<T>()`, or `validatedDeserialize<T>()` from JavaScript that did not pass through the transform throws a missing-metadata error. `validate(value, Class)` can instead read metadata already attached to a compiled class.

An untransformed `validate<T>(plainObject)` call has no target metadata and therefore returns no errors. Do not treat that fail-open result as validation; compile the call, or pass a compiled class/reflected `Type` explicitly.

The compiler recognizes the short compatibility exports `cast<T>()`, `assert<T>()`, and `is<T>()` only when they are imported from `@zyno-io/ts-server-foundation`. Import identity keeps application functions with the same common names from being transformed. Calls that do not pass through the compiler or do not specify a generic type must provide an explicit reflected `Type`; otherwise they throw a missing-metadata error.

## Inspecting A Type

`typeOf<T>()` returns a reflected `Type`. Narrow it with `ReflectionKind` before reading kind-specific fields.

```ts
import { ReflectionKind, typeOf } from '@zyno-io/ts-server-foundation';

interface CreateUser {
    email: string;
    displayName?: string;
}

const type = typeOf<CreateUser>();

if (type.kind === ReflectionKind.objectLiteral) {
    for (const property of type.types) {
        console.log(String(property.name), property.optional === true, property.type.kind);
    }
}
```

The `Type` union includes primitives, literals, arrays, tuples, unions, intersections, object literals, classes, promises, enums, and property signatures. Prefer narrowing by `kind` over relying on a `typeName`: names are descriptive and are not a substitute for annotation metadata.

## Inspecting Classes

Use `ReflectionClass.from(Class)` for a compiled class. It throws when neither that class nor an inherited base class has runtime metadata.

```ts
import { ReflectionClass } from '@zyno-io/ts-server-foundation';
import { User } from './entities/User';

const reflection = ReflectionClass.from(User);
const primary = reflection.getPrimary();
const save = reflection.getMethod('save');

console.log(reflection.name);
console.log(primary.getNameAsString(), primary.getType());
console.log(save.getParameters(), save.getReturnType());
```

Public reflection wrappers:

| Wrapper               | Available information                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ReflectionClass`     | Runtime class, name, collection name, indexes, migration exclusion, properties, methods, constructor parameters, and primary property. |
| `ReflectionProperty`  | Name, type, description, optional/null state, primary/auto-increment markers, database metadata, and reference metadata.               |
| `ReflectionMethod`    | JSDoc description, parameters, and return type.                                                                                        |
| `ReflectionParameter` | Name, type, optional state, and whether a default exists.                                                                              |

`getProperty()`, `getMethod()`, and `getPrimary()` throw when the requested member is absent. `getConstructorOrUndefined()` returns `undefined` for a zero-argument constructor without reflected parameters. Inherited properties and methods are included, with derived declarations replacing same-named base declarations.

`registerClassMetadata()` is exported for compiler and integration tooling that already has a complete `ClassMetadata` object. Normal applications should let the compiler attach metadata.

## Reading Annotations

Annotation readers accept a reflected `Type` and search the relevant nested metadata surfaces.

```ts
import {
    databaseAnnotation,
    ReflectionKind,
    typeAnnotation,
    typeOf,
    validationAnnotation,
    type DateString,
    type Length
} from '@zyno-io/ts-server-foundation';

const reflected = typeOf<{ birthday: DateString; code: Length<8> }>();
if (reflected.kind !== ReflectionKind.objectLiteral) throw new Error('Expected an object literal');

const birthday = reflected.types.find(property => property.name === 'birthday')!.type;
const code = reflected.types.find(property => property.name === 'code')!.type;

typeAnnotation.getType(birthday, 'tsf:type');
databaseAnnotation.getDatabase(birthday, 'mysql');
validationAnnotation.getAnnotations(code);
```

The readers have distinct roles:

| Reader                                          | Result                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `typeAnnotation.getType(type, name)`            | The reflected annotation payload, including compatible `typia.tag` metadata for TSF/OpenAPI annotation names.              |
| `typeAnnotation.getOption(type, name)`          | Compatibility alias of `getType()`.                                                                                        |
| `validationAnnotation.getAnnotations(type)`     | Deduplicated length, numeric-bound, pattern, format-derived, and named-validator annotations.                              |
| `databaseAnnotation.getDatabase(type, dialect)` | Database options for the requested dialect, with generic `'*'` metadata as fallback. MySQL-only tags do not leak to `'*'`. |

Do not infer behavior from alias names. For example, a user type merely named `UuidString` is not a UUID unless its reflected annotations say so.

## Custom Named Validators

Register a validator name once during application/module initialization, then attach that name with `Validate<'name'>`.

```ts
import { ValidatorError, validate, validationRegistry, type Validate } from '@zyno-io/ts-server-foundation';

validationRegistry.register('uppercaseCode', value => {
    if (typeof value !== 'string' || !/^[A-Z]+$/.test(value)) {
        return new ValidatorError('uppercaseCode', 'The value must contain uppercase letters only.');
    }
});

type UppercaseCode = string & Validate<'uppercaseCode'>;

const errors = validate<{ code: UppercaseCode }>({ code: 'abc' });
```

A validator returns `undefined`/`void` for success or a `ValidatorError` for failure. TSF replaces the returned error path with the actual nested input path. Registering the same name again replaces its function. If no function is registered for a reflected validator name, that annotation does not produce a validation error, so shared validator modules must be imported before input is handled.

## Custom Deserializers

The exported `deserializer` is a process-global registry of incoming transforms. A decorator predicate selects reflected types, and its handler adds one or more value transforms.

```ts
import { deserializer, deserialize, typeAnnotation, type TsfTypiaTag } from '@zyno-io/ts-server-foundation';

type LowercaseString = string & TsfTypiaTag<'string', 'tsf:lowercase'>;

deserializer.addDecorator(
    type => typeAnnotation.getType(type, 'tsf:lowercase') !== undefined,
    (_type, state) => {
        state.addTransform(value => (typeof value === 'string' ? value.toLowerCase() : value));
    }
);

const value = deserialize<{ name: LowercaseString }>({ name: 'ALICE' });
```

Matching decorators run in registration order, and each decorator's transforms run in the order they were added. The registry has no removal API, so libraries should use specific annotation names and register decorators once at module load. Deserialization is not a final validation pass; use `validatedDeserialize<T>()` when transformed input must also be validated.

There is intentionally no reflected outbound serializer registry. HTTP output uses ordinary JSON serialization, while database I/O uses column-specific conversion.

## Shared Package Aliases

The compiler can preserve a named type alias imported from another package when that package was also built with the TSF compiler. Its emitted JavaScript exposes a generated `__tsfTypeAliases` map keyed by exported alias name.

For a shared package:

1. Compile the package with the TSF transform, not plain `tsc`.
2. Export the aliases from a runtime-loadable package entrypoint.
3. Publish the transformed JavaScript and its declarations together.
4. Preserve the generated `__tsfTypeAliases` export when bundling or rewriting output.
5. Compile the consuming application with the TSF transform as well.

`__tsfTypeAliases` is generated compiler data, not an application API to edit by hand. The consumer resolves it by package import/export identity; TSF does not rely on a monorepo path, workspace name, or consumer-specific model name.

Alias metadata containing only JSON-representable type information is emitted as self-contained JavaScript and does not add a TSF runtime dependency to the shared package. Aliases that refer to runtime values, such as classes or validators, retain the generated runtime import; those packages must declare the matching TSF runtime dependency.

If a package is built without emitted alias metadata, the consumer may retain only an unresolved external type boundary. Validation, deserialization, and OpenAPI cannot safely reconstruct missing alias semantics from the alias name alone.

## Runtime Boundaries

Reflection availability does not mean every subsystem automatically validates values. HTTP input and `validatedDeserialize<T>()` deserialize and validate; database entity I/O performs storage conversion without reflected validation; controller return values use ordinary JSON serialization.

See [Helpers](./helpers.md#reflected-deserialization-and-validation) for conversion behavior and [Database](./database.md#runtime-value-conversion-and-validation) for the storage boundary.
