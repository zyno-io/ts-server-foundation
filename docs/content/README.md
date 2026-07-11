# Documentation

`@zyno-io/ts-server-foundation` is a TypeScript server foundation for HTTP APIs, dependency injection, configuration, database access, workers, SRPC, logging, telemetry, and development tooling.

The TSF compiler emits reflected type metadata used by validation, OpenAPI, routing, DI, config, and database schema extraction. Application code should use the TSF APIs documented here.

## Core Docs

| Document                                                          | Description                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Feature Overview](./overview.md)                                 | Capability map, architecture boundaries, operational model, and links to every detailed feature guide.   |
| [Getting Started](./getting-started.md)                           | Installation, app creation, module options, DI, lifecycle, and environment requirements.                  |
| [Public API](./public-api.md)                                     | Package export surface, root imports, OTel bootstrap imports, and `app.http` boundary.                    |
| [Dependency Injection](./di.md)                                   | Providers, scopes, request contexts, module exports, and controller/service lifecycle.                    |
| [Configuration](./configuration.md)                               | `BaseAppConfig`, `Env`, env-file loading, child-process env preservation, and built-in config keys.       |
| [Environment](./env.md)                                           | `Env`, snapshots, process-env conversion, config loading behavior, and test patterns.                     |
| [Database](./database.md)                                         | MySQL/PostgreSQL database layer, active record, sessions, transactions, raw SQL, locks, and schema tools. |
| [SQL](./sql.md)                                                   | SQL fragments, bindings, identifiers, joins, rendering, and trusted raw SQL escape hatches.               |
| [Migrations](./migrations.md)                                     | Migration files, schema diffing, migration runner, reset, charset, and CLI options.                       |
| [HTTP](./http.md)                                                 | HTTP router, explicit request parameter annotations, multipart uploads, raw streaming, and responses.     |
| [Uploads](./uploads.md)                                           | Multipart parsing, `FileUpload`, temporary-file cleanup, cached body reads, and raw request streams.      |
| [OpenAPI](./openapi.md)                                           | Route/schema serialization, explicit query/body rules, `ApiResponse<T, Status>`, and generation commands. |
| [Authentication](./authentication.md)                             | JWTs, request helpers, auth middleware, basic auth, password hashing, and reset tokens.                   |
| [Health Checks](./health.md)                                      | `/healthz`, `HealthcheckService`, custom checks, and request logging.                                     |
| [Logging](./logging.md)                                           | Pino logging, pretty output, context data, request logs, and error reporting.                             |
| [Types](./types.md)                                               | Runtime and schema type annotations, including DB/OpenAPI effects for custom types.                       |
| [Type Reflection](./reflection.md)                                | Public runtime reflection, annotation readers, custom validators/deserializers, and shared aliases.       |
| [Type Reflection Architecture](./type-reflection-architecture.md) | Compiler metadata policy shared by validation, OpenAPI, and database extraction.                          |

## Services

| Document                                 | Description                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Workers](./worker.md)                   | BullMQ-backed workers, in-process execution, cron scheduling, recording, and DI-owned job handlers.    |
| [Redis](./redis.md)                      | Redis options, cache, mutex, broadcast channels, distributed methods, and BullMQ prefixes.             |
| [DevConsole](./devconsole.md)            | Development dashboard for routes, OpenAPI, requests, SRPC, DB queries, mutexes, and workers.           |
| [SRPC](./srpc.md)                        | WebSocket RPC with generated proto types, authentication hooks, bidirectional calls, and byte streams. |
| [Leader Service](./leader-service.md)    | Redis-backed leader election.                                                                          |
| [Mail](./mail.md)                        | DI-registered SMTP/Postmark mail service and templates.                                                |
| [Mesh Service](./mesh-service.md)        | Redis-backed cross-node typed messaging and broadcasts.                                                |
| [Mesh Client Tracking](./mesh-client.md) | Cross-node client registry, invocation, and SRPC mesh integration.                                     |

## Utilities And Operations

| Document                                             | Description                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Helpers](./helpers.md)                              | Async context, promises, objects, JSON, streams, crypto, validation, dates, errors, UUIDs, and Redis helpers. |
| [Telemetry](./telemetry.md)                          | OpenTelemetry bootstrap, span helpers, metrics endpoint, shutdown, and Sentry helpers.                        |
| [Testing](./testing.md)                              | Testing facade, mock HTTP requests, isolated test databases, seed hooks, and assertion helpers.               |
| [CLI Tools](./cli.md)                                | `tsf`, `tsf-dev`, `tsf-test`, `tsf-migrate`, `tsf-gen-proto`, and app scaffolding.                            |
| [Release](./release.md)                              | Build, test, OpenAPI generation, package contents, tarball inspection, and publish checklist.                 |
| [Documentation Maintenance](./documentation-plan.md) | How to keep the docs aligned with implementation changes.                                                     |
