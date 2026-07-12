# Public API

The package intentionally exposes a small package-level import surface:

- `@zyno-io/ts-server-foundation` for application APIs
- `@zyno-io/ts-server-foundation/otel` for OpenTelemetry bootstrap

Feature-folder subpaths such as `/http`, `/database/sql`, `/testing`, `/services/logger`, and `/telemetry/sentry` are not exported. Import application APIs from the package root:

```ts
import { App, BaseDatabase, HttpBody, HttpRequest, TestingHelpers, createApp, http, sql } from '@zyno-io/ts-server-foundation';
```

The root export is the supported application surface. Internal file layout can change without becoming a package-level breaking contract.

## Root Export Reference

The root barrel groups the supported APIs below. The examples are representative named exports, not separate import paths.

| Area                        | Representative root exports                                                                                                                | Guide                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Application and commands    | `App`, `createApp`, `BaseAppConfig`, `AppModule`, `createModule`, `AutoConstruct`, lifecycle tokens, `cli`                                 | [Getting Started](./getting-started.md) |
| Dependency injection/events | `Container`, provider types, `resolve`, `EventBus`, `EventToken`, `event`                                                                  | [Dependency Injection](./di.md)         |
| HTTP and uploads            | `http`, `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `FileUpload`, HTTP errors, request/response workflow tokens                       | [HTTP](./http.md)                       |
| Authentication and health   | `JWT`, `ParsedJwt`, `Auth`, auth middleware helpers, `HealthcheckService`, `HealthcheckController`                                         | [Authentication](./authentication.md)   |
| Reflection and validation   | `typeOf`, `ReflectionClass`, `ReflectionKind`, annotation readers, `deserialize`, `validate`, `validatedDeserialize`, registries           | [Type Reflection](./reflection.md)      |
| Shared types                | HTTP wrapper types, database markers, validation tags, `DateString`, `UuidString`, `PhoneNumber`, `TrimmedString`, utility types           | [Types](./types.md)                     |
| Database, SQL, migrations   | `BaseDatabase`, `BaseEntity`, `DatabaseSession`, query/relation helpers, `sql`, schema builders, migration runner/diff/maintenance helpers | [Database](./database.md)               |
| General and Redis helpers   | Async context, availability monitoring, process/promise/data/stream/security/date/error/UUID helpers, `Cache`, Redis/broadcast/mutex APIs  | [Helpers](./helpers.md)                 |
| Logging and services        | Logger APIs, workers, leader election, mail, mesh, and mesh-client tracking                                                                | [Logging](./logging.md)                 |
| SRPC                        | `SrpcClient`, `SrpcServer`, `SrpcByteStream`, handlers, errors, and observers                                                              | [SRPC](./srpc.md)                       |
| OpenAPI                     | `serializeOpenApiSchema`, `serializeOpenApiYaml`, `dumpOpenApiSchema`, schema inspection helpers and document types                        | [OpenAPI](./openapi.md)                 |
| Telemetry and Sentry        | Span/context helpers plus `installSentry`, `flushSentry`, and related state helpers                                                        | [Telemetry](./telemetry.md)             |
| DevConsole                  | Controller/runtime/store, local-only middleware, observers, and inspection helpers                                                         | [DevConsole](./devconsole.md)           |
| Testing                     | `TestingFacade`, facade builders, mock-request helpers, fixtures, expectations, and `TestingHelpers`                                       | [Testing](./testing.md)                 |

The emitted `.d.ts` file is the authoritative symbol-level reference. Package tests compile representative imports from every group and verify that the package export map exposes only `.` and `./otel`.

## OpenTelemetry Bootstrap

OpenTelemetry instrumentation must be initialized before most other imports. Use the dedicated subpath for that early import:

```ts
import { init } from '@zyno-io/ts-server-foundation/otel';

init();

const { createApp } = await import('@zyno-io/ts-server-foundation');
```

Sentry helpers, span helpers, HTTP helpers, database helpers, testing helpers, and service classes are exported from the root package.

The `/otel` subpath exports `init`, `shutdownTelemetry`, `resetTelemetryForTests`, `TelemetryInitOptions`/`IOtelOptions`, the HTTP attribute-hook type, and the OTel state/span helpers. `init` is intentionally absent from the root so a bootstrap import does not first load the rest of the application package. Conversely, service/database/HTTP APIs are not exported from `/otel`.

## Application Boundary

`App` owns application lifecycle, DI, config, and command entrypoints. HTTP server APIs live under `app.http`:

```ts
const app = createApp({ controllers: [UsersController] });

await app.http.listen(3000, '127.0.0.1');
app.http.registerUpgradeHandler(handler);
app.http.registerObserver(entry => {
    // observe completed HTTP requests
});

await app.stop();
```

Application entrypoints should normally call `app.run()`, which requires an explicit built-in or registered command such as `server:start` or `openapi:generate`:

```ts
if (require.main === module) {
    void app.run();
}
```

```bash
node . server:start
node . openapi:generate
```

HTTP server APIs live under `app.http` so the base application class remains focused on lifecycle, DI, config, and command dispatch.
