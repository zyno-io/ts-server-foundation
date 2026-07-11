# Type Reflection Architecture

TSF reflection metadata is the shared contract between validation, deserialization, HTTP routing, OpenAPI generation, and database schema extraction. The compiler should emit one coherent metadata shape, and runtime consumers should interpret that shape through shared helpers instead of re-implementing TypeScript type rules or duplicating validation logic.

For application-facing `typeOf`, class/member inspection, annotation readers, custom validators/deserializers, and shared-package setup, see [Type Reflection](./reflection.md).

This document is the source of truth for reflection policy. Implementation details can move, but code should continue to satisfy these rules.

## Goals

Reflection must preserve the TypeScript type that application authors wrote while still letting TypeScript resolve complex type algebra. The important outcomes are:

- validation and OpenAPI describe the same shape and constraints;
- database schema extraction uses the same reflected facts, with storage-specific interpretation only where needed;
- public aliases stay visible when they are part of an API contract;
- generated OpenAPI component names are stable and human-meaningful;
- consumer package paths, model names, and workspace layouts are never hardcoded;
- compiler work is scoped so metadata generation does not explode memory usage.

## Metadata Pipeline

The compiler has two encoders.

The Typia encoder is preferred for structural DTOs. It asks TypeScript and Typia for the resolved type, so mapped types, conditional types, intersections, unions, `Pick`, `Omit`, `Partial`, and local aliases are reduced by the TypeScript checker before TSF serializes metadata.

The internal encoder is reserved for TSF-only semantics that Typia cannot preserve on its own. Examples include root framework wrappers, root database/entity metadata, unresolved index metadata, ordered literal unions, native `Date` metadata that must remain a runtime `Date`, and source alias boundaries that runtime consumers must still see.

The compiler may precompute metadata for emitted project files so checker-backed work is done before parallel write callbacks. That cache is an implementation detail. It must not become a broad semantic pass that asks Typia for every reachable type.

## Preferred Surfaces

HTTP controller method arguments and return types are preferred structural metadata surfaces. On those surfaces, the compiler should use Typia for the outer structural DTO whenever Typia can preserve the observable runtime meaning.

Preferred surfaces intentionally allow nested TSF tags such as `DateString`, `UuidString`, validation tags, database tags, and named aliases without forcing the whole DTO through the internal encoder. If a specific property carries metadata Typia cannot preserve, the compiler should preserve that property's source metadata rather than abandoning the entire DTO shape.

Root wrappers are different from their payloads. A wrapper such as `HttpBody<T>`, `HttpQueries<T>`, `HttpQuery<T>`, `HttpPath<T>`, `HttpHeader<T>`, or `ApiResponse<T, Status>` must keep wrapper metadata because routing and response handling depend on it. The wrapped payload type `T` should still follow the normal preferred-surface rules.

Non-preferred surfaces are more conservative. They may use Typia when the type or an alias body contains Typia-preferred syntax, such as Typia-compatible tags or complex mapped/conditional helpers. Otherwise, root framework markers, root database markers, external package aliases, `Date`, and similar runtime-sensitive types should stay on the internal encoder.

## Internal Encoder Boundaries

Use the internal encoder for shapes where TSF metadata is observable and Typia does not carry enough information:

- framework wrappers and response metadata;
- root database/entity markers;
- root or unresolved index metadata where TSF must preserve `additionalProperties` or index value details that Typia did not emit;
- source-dependent utility metadata only when preserving an alias, index, or property-source boundary is observable to runtime consumers;
- ordered literal unions when schema order is observable;
- direct `Date` or `ValidDate` roots, because runtime deserialization must produce a `Date`;
- object-target custom validators where Typia tag metadata does not preserve the validator on the native value;
- imported package aliases when the alias boundary should be loaded from that package's emitted metadata.

These boundaries are narrow. `Record`, index signatures, and indexed access should not force an enclosing controller DTO onto the internal encoder when TypeScript and Typia can resolve the composed type into equivalent structural metadata. TypeScript utility composition such as `OptionalNulls<Pick<T, K>>` should be resolved by the checker/Typia path on preferred structural surfaces, not reimplemented by name in Go.

## Tags And Annotations

Custom type semantics should be represented as Typia-compatible tag metadata wherever possible. Type definitions should attach structured tags in TypeScript; compiler code should read those tag shapes instead of duplicating alias-specific meanings.

Runtime consumers should read tags through shared annotation helpers:

- validation executes validators from reflected validation metadata;
- deserialization reads reflected metadata for transforms and runtime value handling;
- OpenAPI maps the same reflected validation metadata into schema keywords;
- database extraction reads database tags and may additionally use shared validation facts, such as `minimum >= 0` for unsigned numeric columns.

## Runtime Execution Boundaries

Reflection metadata is available to multiple subsystems, but metadata availability does not imply that every value crosses the validation/deserialization pipeline.

| Surface                                                  | Reflected deserialization       | Reflected validation     |
| -------------------------------------------------------- | ------------------------------- | ------------------------ |
| HTTP body, query, path, and header controller parameters | Yes                             | Yes                      |
| Explicit `validatedDeserialize<T>()`                     | Yes                             | Yes                      |
| Compiler-backed `deserialize<T>()`                       | Yes                             | No final validation pass |
| Compiler-backed `validate<T>()`                          | No                              | Yes                      |
| Configuration loading                                    | Primitive config coercion only  | Yes                      |
| Entity/query-builder database I/O                        | Column-specific conversion only | No                       |
| Controller return values                                 | No; ordinary JSON serialization | No                       |

TSF intentionally has a reflected deserializer registry for incoming transforms and no matching reflected outbound serializer registry. HTTP output relies on TypeScript return types at development time and ordinary JSON serialization at runtime. Database runtime conversion is a storage boundary with its own column-specific rules; it does not implicitly run API-input transforms or validators.

The current compiler injects generic metadata for `deserialize<T>()`, `validate<T>()`, `validatedDeserialize<T>()`, and `typeOf<T>()`. It also injects metadata for compatibility exports such as `cast<T>()`, `assert<T>()`, and `is<T>()` when import identity proves that the call targets the foundation package. Uncompiled compatibility calls require explicit metadata and throw when it is absent.

TSF tags are metadata, not fake object properties. Typia-internal `typia.tag` objects must not appear as user-visible OpenAPI properties or validation targets.

`Pattern<T>` and `Validate<T>` should use literal string arguments when possible so the compiler can emit portable metadata. Non-literal runtime validator references remain an internal-encoder concern.

## Validation And OpenAPI

Validation and OpenAPI should be nearly 1:1. If validation knows about a string format, pattern, length, numeric minimum, numeric maximum, or custom named validator, OpenAPI should usually expose the corresponding schema information from the same reflected metadata.

OpenAPI should not infer TSF semantics from bare type names such as `DateString`, `UuidString`, `PhoneNumber`, or `UnsignedNumber`. Those semantics must come from annotations, Typia tags, constructor identity, or structurally bare marker stubs. Matching a user-defined class or alias by name alone is not acceptable.

Validation may execute runtime functions that OpenAPI can only name or approximate. In those cases, both consumers should still read the same reflected validator metadata.

## Database Extraction

Database schema extraction is the intended domain-specific consumer of reflection metadata. It may interpret tags and validation facts in storage-specific ways, including:

- column type selection from database field tags;
- primary keys, uniqueness, indexes, references, defaults, and update hooks;
- `minimum >= 0` as an unsigned numeric column hint for dialects that support unsigned columns;
- length constraints as string column width hints.

Database-specific interpretation should remain in database extraction. Validation and OpenAPI should not duplicate database schema rules unless the rule is also a validation rule.

## Alias And Package Boundaries

Named aliases are part of the public API when they are written into controller DTOs or exported from shared packages. Reflection should preserve that boundary so OpenAPI can emit component references using exported names.

Generic application aliases use the exported base name for OpenAPI components. For example, `Envelope<string, Record<string, unknown>>` should produce `Envelope`, not a sanitized instantiated name. Generated utility components may use stable generated names when no exported alias exists.

Shared packages should expose emitted alias metadata through `__tsfTypeAliases`. When an app imports a type from a package that exposes TSF metadata, the compiler should reference that package metadata by import/export identity. It must not resolve behavior by repository path, workspace layout, or application-specific package name.

TSF's own package spec may be recognized as a single compiler constant because the compiler must distinguish foundation metadata helpers from arbitrary user imports. Other package specs must not be special-cased.

## Component Naming

OpenAPI component naming should prioritize stable public names:

- explicit OpenAPI names win;
- named aliases and classes use their exported names;
- non-utility generic aliases use the exported base name;
- utility displays such as `Pick`, `Omit`, `Partial`, and `Required` may generate stable names only when no public alias is available;
- same-name components with equivalent OpenAPI signatures should be reused;
- same-name components with different signatures should be disambiguated deterministically.

Anonymous object literals should stay inline unless a stable name is explicitly available.

## Hardcoding And Duplication

Hardcoded names should be minimized and centralized. Acceptable hardcoded values are framework wrapper names, reflection kind names, TSF tag keys, known TypeScript built-ins such as `Date`, and TSF's own package spec as a single compiler constant.

Application model names, app package paths, shared-package aliases, and consumer repository names must never be hardcoded.

Compiler code may know TSF marker names when those names define metadata syntax, such as `DatabaseField`, `Index`, `Pattern`, or `TsfValidatorTag`. It should not duplicate semantic payloads that can be expressed in TypeScript tags. For example, a date-string alias should get its date behavior from `TypiaFormat<'date'>` and `TsfTypeTag`, not from a Go switch on the alias name.

## Implementation Checks

When changing reflection behavior, check these invariants:

- a DTO containing a nested database tag should still use structural Typia metadata where the database tag is not the root payload;
- DTOs composed with `Record`, index signatures, or indexed access should still use Typia when the resolved structural shape preserves the observable runtime contract;
- a DTO containing `Date` should not force the whole object through the internal encoder, but the `Date` property must still deserialize and document as a date-time value;
- a direct `Date` or `ValidDate` root should preserve runtime `Date` metadata;
- literal unions that need stable emitted ordering should not be reordered by Typia;
- imported shared-package aliases should remain references to that package metadata;
- OpenAPI component names should not include sanitized generic instantiations when an exported alias name is available;
- validation metadata and OpenAPI schema keywords should come from the same annotations.
