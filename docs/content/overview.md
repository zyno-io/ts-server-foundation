# Feature Overview

TS Server Foundation is an application runtime and toolkit for TypeScript services. It combines its own reflected type metadata, dependency injection, HTTP runtime, database layer, operational services, and development tools behind one package. The detailed guides are the source of truth; this page is the map of what the package provides and how the pieces fit together.

The project is built and maintained primarily for Zyno Consulting's own production systems. We publish it openly in the hope that it is useful to others, while its roadmap and maintenance priorities remain guided by the needs of those systems rather than a promise of general-purpose framework support.

## Application Foundation

`createApp()` assembles a service from explicit configuration, controllers, providers, listeners, modules, and an optional database. It owns application startup, HTTP startup, signal handling, workers, DevConsole, health checks, and orderly shutdown.

| Area | Included behavior | Detailed guide |
| --- | --- | --- |
| Application lifecycle | Bootstrap and shutdown events, signal handling, idempotent start/stop, and rollback after failed startup | [Dependency Injection](./di.md#application-lifecycle) |
| Dependency injection | Constructor injection, value/class/factory providers, singleton/request/transient scopes, modules, and global exports | [Dependency Injection](./di.md) |
| Configuration | Reflected config classes, env-file loading, typed coercion, encrypted `_SECRET` values, and environment snapshots | [Configuration](./configuration.md), [Environment](./env.md) |
| Type reflection | Runtime type metadata, annotations, custom validators, custom deserializers, aliases, and compiler boundaries | [Type Reflection](./reflection.md), [Architecture](./type-reflection-architecture.md) |
| CLI and scaffolding | App creation, TypeScript 7 compiler setup, build/watch/run workflows, tests, migrations, OpenAPI, and proto generation | [CLI Tools](./cli.md) |

Use constructor injection inside application code. `resolve()` and its `r()` alias are available for app-level code that cannot receive a constructor dependency. Register `@AutoConstruct()` classes as providers when they must be created during startup.

## HTTP And API Contracts

TSF owns its HTTP router and request pipeline. Controllers use decorators for routing and explicit reflected annotations for wire inputs.

| Area | Included behavior | Detailed guide |
| --- | --- | --- |
| HTTP routing | Controllers, exact methods, path parameters, middleware, CORS, workflows, static files, upgrades, and in-memory requests | [HTTP](./http.md) |
| Inputs | Body/query/path/header annotations, reflected coercion and validation, custom parameter resolvers, and request-scoped caching | [HTTP](./http.md#parameter-injection) |
| Uploads and streams | Guarded multipart files, size/MIME constraints, temporary-file cleanup, compressed bodies, and raw request streams | [Uploads](./uploads.md) |
| Responses and errors | JSON/raw/redirect/empty results, response annotations, normalized HTTP errors, and streaming responses | [HTTP](./http.md#responses) |
| OpenAPI | Schemas generated from the same reflected metadata used by validation, explicit response status types, runtime routes, and YAML generation | [OpenAPI](./openapi.md) |
| Authentication | HS256/EdDSA JWTs, entity auth middleware, custom resolvers, Basic auth, password hashing, and reset tokens | [Authentication](./authentication.md) |

The HTTP input pipeline deserializes and validates reflected values before controller invocation. Controller outputs use ordinary JSON serialization; OpenAPI response types describe the contract but do not add runtime output validation.

## Database And Persistence

The database layer is a thin active-record and query system over `mysql2` and `pg`, with dialect-aware schema and migration tooling.

| Area | Included behavior | Detailed guide |
| --- | --- | --- |
| Databases and entities | MySQL/PostgreSQL adapters, reflected entity schemas, column conversion, active-record helpers, and retrieval APIs | [Database](./database.md) |
| Queries | Typed filters, joins, selection, paging, patch/delete operations, relations, batched loading, and query observation | [Database](./database.md#query-builder) |
| Sessions | Transactions, nested savepoints, post-commit/post-rollback hooks, and dialect-specific session locks | [Database](./database.md#sessions-and-transactions) |
| SQL | Safe values and identifiers, composable fragments, raw database methods, and explicit unsafe escape hatches | [SQL](./sql.md) |
| Schema and migrations | Multi-dialect schema builder, live-schema diffs, generated migration files, runners, reset, charset, and PostgreSQL schemas | [Migrations](./migrations.md) |
| Storage annotations | UUIDs, defaults, update expressions, unsigned values, lengths, dates, coordinates, indexes, and references | [Types](./types.md) |

Database I/O performs column-aware storage conversion rather than the HTTP input validation pipeline. Database constraints enforce storage rules; call the reflected validation helpers explicitly when application code needs API-style validation outside HTTP.

## Background And Distributed Services

| Area | Included behavior | Detailed guide |
| --- | --- | --- |
| Workers | BullMQ queues, in-process tests, inline execution, cron jobs, dedicated runners, execution records, observers, and DevConsole inspection | [Workers](./worker.md) |
| Redis | Client configuration, cache helpers, distributed mutexes, broadcasts, and distributed methods | [Redis](./redis.md) |
| Leader election | Redis-backed ownership with renewal, loss callbacks, and failover | [Leader Service](./leader-service.md) |
| Mesh | Typed cross-node requests, responses, broadcasts, membership, heartbeats, and leader-backed cleanup | [Mesh Service](./mesh-service.md) |
| Client tracking | Cross-node client reservation, activation, metadata, lookup, targeted calls, broadcasts, and SRPC integration | [Mesh Client Tracking](./mesh-client.md) |
| SRPC | HMAC-authenticated bidirectional WebSocket RPC, protobuf codecs, duplicate-client policy, reconnects, observers, and byte streams | [SRPC](./srpc.md) |
| Mail | SMTP/Postmark providers, direct and template messages, prepared messages, and typed templates | [Mail](./mail.md) |

Redis is feature-dependent, not a requirement for the base HTTP application. Configure it when enabling BullMQ workers, mutexes, caches, broadcasts, leader election, or mesh services.

## Operations And Development

| Area | Included behavior | Detailed guide |
| --- | --- | --- |
| Health | `/healthz`, application version, built-in database checks, custom checks, and individual results | [Health Checks](./health.md) |
| Logging | Scoped Pino loggers, async context, structured errors, custom sinks, HTTP request modes, and Sentry forwarding | [Logging](./logging.md) |
| Telemetry | OpenTelemetry HTTP/Undici/DNS/Redis/MySQL/PostgreSQL instrumentation, OTLP export, Prometheus metrics, spans, and Sentry | [Telemetry](./telemetry.md) |
| DevConsole | Local-only routes, OpenAPI, requests, SRPC, database queries/entities, health, mutex, worker, environment, and REPL views | [DevConsole](./devconsole.md) |
| Testing | Node test runner, app facades, in-memory HTTP, MySQL/PostgreSQL isolation, savepoints, migrations, fixtures, mocks, and assertions | [Testing](./testing.md) |
| Helpers | Async/process tools, data transforms, JSON, streams, resource cleanup, crypto, validation, dates, UUIDs, errors, and Redis helpers | [Helpers](./helpers.md) |

## Process Model

The generated application exports an `App` through its package entrypoint and accepts explicit runtime commands:

```bash
node . server:start       # HTTP/API process
node . worker:start       # dedicated worker process, with health listener
node . migrate:run        # release-time migrations
node . openapi:generate   # write openapi.yaml without starting HTTP
```

Production deployments should build once, run migrations as a release step, and separate API and worker processes when workers are enabled. Normal production server processes do not start the worker runner unless `ENABLE_JOB_RUNNER=true`; `worker:start` forces runner ownership.

`APP_ENV` is required when `NODE_ENV=production`. Tests run with `APP_ENV=test` and `TZ=UTC`. Database date and timestamp formatting uses UTC, but TSF does not force the timezone of an arbitrary server process; set `TZ=UTC` in the deployment environment when the whole application must run in UTC.

In development, DevConsole is available at `/_devconsole/` after the app listens. Its localhost socket check is the security boundary, so do not expose or proxy it to untrusted clients.

## Start Here

- Follow [Getting Started](./getting-started.md) to scaffold or configure an application.
- Use the [Documentation Index](./README.md) for the complete page list.
- Check [Public API](./public-api.md) before adding imports from internal paths.
- Use [Release](./release.md) for build, docs, package, and versioning checks.
