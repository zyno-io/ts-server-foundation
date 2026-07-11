# Documentation Maintenance

This page defines how TSF documentation is kept current as implementation changes.

## Update Rules

- Prefer examples that compile against `@zyno-io/ts-server-foundation`.
- Import application APIs from the package root unless a page documents the sole supported subpath, `/otel`.
- Keep HTTP parameter examples explicit: `HttpBody`, `HttpQueries`, `HttpQuery`, `HttpPath`, `HttpHeader`, `FileUpload`, and `HttpRequest`.
- Keep database examples focused on `BaseDatabase`, sessions, active-record helpers, migrations, and SQL fragments.
- Document environment keys through `Env` and config classes instead of direct `process.env` access.
- Run `corepack yarn docs:build` after sidebar, link, frontmatter, or VitePress config changes.

## Content Map

Core application pages:

- `getting-started.md`
- `public-api.md`
- `di.md`
- `configuration.md`
- `env.md`
- `http.md`
- `uploads.md`
- `openapi.md`
- `authentication.md`
- `health.md`
- `logging.md`
- `reflection.md`
- `type-reflection-architecture.md`
- `types.md`

Database pages:

- `database.md`
- `sql.md`
- `migrations.md`

Services and runtime pages:

- `worker.md`
- `redis.md`
- `srpc.md`
- `devconsole.md`
- `leader-service.md`
- `mail.md`
- `mesh-service.md`
- `mesh-client.md`

Utilities and operations pages:

- `helpers.md`
- `telemetry.md`
- `testing.md`
- `cli.md`
- `release.md`
- `documentation-plan.md`

## Change Checklist

When an API changes:

1. Update the feature page that owns the API.
2. Update [Public API](./public-api.md) if exports or supported import paths change.
3. Update [Configuration](./configuration.md) and [Environment](./env.md) if environment keys or config defaults change.
4. Update [OpenAPI](./openapi.md) if route metadata, response typing, or schema output changes.
5. Update [Testing](./testing.md) when testing helpers or required local services change.
6. Rebuild the docs with `corepack yarn docs:build`.

## Optional Improvements

- Add deployment examples once a standard TSF app deployment shape is finalized.
- Add generated API reference pages if the package adopts a docs extractor.
- Extract and compile every TypeScript documentation fence if the representative package-import smoke test is expanded into executable documentation.
- Add an isolated publish/install fixture for shared-package `__tsfTypeAliases` metadata.
- Extend conditional live MySQL and PostgreSQL coverage to exercise every schema-builder operation in addition to the fake-driver SQL checks.
- Automate DevConsole screenshot capture if screenshots need regular refreshes.

## Audit Progress Record

The main code-to-docs audit was implemented in three phases. A second-pass review found additional operational and adversarial cases, recorded below rather than treating the audit as fully closed. Service-backed integration suites skip when their required Redis, MySQL, or PostgreSQL environment is not configured.

### Legacy Coverage Baseline

The July 2026 documentation pass compared the full `dk-server-foundation` README and every page in its documentation directory against TSF. Each durable feature area has a current TSF destination: application/lifecycle/DI, configuration, database and migrations, HTTP/CORS/uploads, authentication, workers, SRPC, Redis/leader/mesh, mail, telemetry, health, helpers, testing, types, logging, DevConsole, and CLI operations are linked from [Feature Overview](./overview.md).

The comparison does not copy Deepkit-specific classes, decorators, ORM connection types, Jest behavior, or removed commands into TSF docs. Where TSF kept or replaced the capability, the current API is documented instead. The pass added explicit coverage for the process model and operational defaults; the complete CLI; trusted proxy addresses and request caching; test facade lifecycle, global setup, and module reset; telemetry resources and remote span inputs; worker metadata and observers; SRPC codec/stream types, pending byte-stream limits, and the current telemetry boundary; calendar-version generation; and GitHub Pages deployment.

TSF-only material remains separately documented for its native DI and reflection pipeline, environment snapshots, PostgreSQL, SQL fragments, schema diffs and migrations, multipart/raw uploads, OpenAPI generation, public export policy, mesh client tracking, and reflection architecture. The root README intentionally stays short and points to the overview and full documentation index instead of duplicating these guides.

### Phase 1: Settled Contracts

Completed in the first implementation pass:

1. A missing non-optional standalone `FileUpload` returns `400`; optional uploads receive `undefined`. Runtime and OpenAPI tests cover non-multipart, text-only multipart, wrong-field, required, and optional cases.
2. Routes with multiple `HttpBody` parameters fail registration. This avoids the previous runtime/OpenAPI shape conflict.
3. An optional `HttpQueries<T>` receives `undefined` when no query is present, and its expanded OpenAPI query parameters are non-required.
4. Collision-prone `cast<T>()`, `assert<T>()`, and `is<T>()` are compiler-recognized only when import identity proves that they come from the foundation package. They fail closed when metadata is absent, with focused runtime and compiler-policy tests.
5. Relation lookup/grouping helpers preserve numeric ID `0`, with direct, keyed, grouped, and pivot-relation coverage.

### Phase 2: Core Guides

Completed coverage includes project setup and scaffold anatomy; routing, middleware, request scope, and lifecycle order; HTTP headers, queries, bodies, encodings, streams, responses, observers, and port `0`; upload selection, MIME policies, and temporary-file lifetime; logger levels, contexts, sinks, and alerting; JWT configuration, token precedence, entity validation, and verification warnings; application lifecycle and DI; and the OpenAPI configuration and runtime/schema parity rules.

Typed multi-file parameter arrays are not supported. A direct `FileUpload` selects one file, while handlers that need every file read `HttpRequest.uploadedFiles`.

### Phase 3: Feature References

Completed coverage includes the public reflection API and shared-package metadata; database sessions, relations, SQL, schema building, and migrations; exported helpers and supported package entry points; SRPC handshakes, handlers, reconnect behavior, and errors; mesh-client reservations, activation, delivery, and metadata synchronization; worker execution modes; telemetry; and DevConsole operation. Type Reflection Architecture and this maintenance page are included in navigation.

Among the implementation defects fixed by the audit are required-upload enforcement, optional aggregate-query parity, relation ID `0` preservation, malformed-path and request-encoding handling, HEAD response parity, upload cleanup/order, remote mesh-client metadata persistence, and JSDoc-derived OpenAPI operation summaries.

### Verification Coverage

The audit added focused checks for:

- documentation links, headings, navigation coverage, representative root and `/otel` imports, and the VitePress production build in CI;
- HTTP routing, middleware, headers, bodies, encodings, streams, uploads, cleanup, response behavior, and Node/in-memory parity;
- OpenAPI environment and route-flag precedence, internal routes, security, summaries, and nested body-file schemas;
- JWTs, authentication entities, logging, lifecycle, DI, reflection, SQL guards, sessions, schema building, and migration failure ordering;
- selected DevConsole, worker, SRPC, mesh, leader-service, and telemetry success and failure paths.

Redis-, MySQL-, and PostgreSQL-backed cases are conditional integration tests. Configure the service-specific environment described in [Testing](./testing.md) to run them; an absent service skips those cases rather than changing the package contract.

### Confirmed Corrections Awaiting Focused Coverage

The second and third review passes found objective defects and documentation errors that have been corrected. The following regression cases are still planned; they are not behavior decisions:

1. HTTP and application lifecycle:
    - make worker startup and both worker rollback steps fail independently, verifying that every cleanup is attempted without losing the startup error;
    - exercise a post-bind bootstrap failure and verify that the listener and app-owned resources roll back;
    - make both composed rollback hooks fail and prove that each is attempted and their failures are preserved;
    - make multiple `App.stop()` steps fail and verify later cleanup plus single/aggregate rethrow behavior;
    - cover `onResponse` failure before and after Node headers commit;
    - cover `flushHeaders(); end(body)` and prove that the Node response completes with the body.
2. Data, types, and reflection:
    - cover present hostile keys (`__proto__`, `constructor`, `toString`) in public keyed results, absent hostile keys during relation resolution, same-key additional filters, and number/bigint ID `0`;
    - cover explicit-secret `Crypto` construction before app creation, with both default and explicit IV lengths;
    - reject a non-NANP international number through `PhoneNumberNANP` while retaining valid country-code-1 inputs;
    - load the built health controller from compiled package output and verify working-directory package-version resolution.
3. Runtime services and observability:
    - cover sequential partial mesh-start rollback and instance deregistration;
    - prove that DevConsole broadcasts target only active SRPC streams, falsy secret values are masked, and the database-query index evicts with its ring entry;
    - cover metrics option/environment precedence, socket-peer authorization with spoofed forwarding headers, synchronous and asynchronous provider shutdown failures, reset failures, and state clearing;
    - cover a throwing global error reporter without suppressing later reporting, and assert that `Logger.data()` preserves the parent scope.

### Decision Register

These items intentionally remain unchanged until the project chooses a contract:

1. Authentication and network policy:
    - Should generated OpenAPI advertise configured JWT-cookie authentication in addition to Bearer authentication? Runtime accepts both, while the current document intentionally describes only Bearer.
    - Is a private transport peer sufficient authorization for `/metrics`, or should it be localhost-only, authenticated, or controlled by an explicit allowlist? A public client behind a private reverse proxy appears as that private peer.
2. Concurrent lifecycle behavior:
    - Should concurrent `HttpServerRuntime.listen()` and `App.stop()` calls coalesce, reject, or follow another contract?
    - Should concurrent `MeshService.start()` calls reject or coalesce, and should `stop()` during startup wait, cancel startup, or reject?
3. Data and reflection semantics:
    - Should migration tracking-write failure after a successful `up()` be reconciled, retried, or transactionally coupled where the dialect permits?
    - Should tuples reject trailing input at direct validation and deserializing/HTTP boundaries, or should deserialization continue to project only declared positions?
    - Should public keyed database helpers retain ordinary object prototypes for compatibility or return null-prototype dictionaries so every absent hostile key reads as `undefined`?
4. Mesh and SRPC semantics:
    - Should the Redis client-registry safety TTL be refreshed from mesh liveness, replaced with per-client leases, or removed?
    - Should explicit MeshSrpc metadata updates merge, replace, or support explicit deletion, and how should live and registry state resolve races?
    - Should both SRPC invocation directions preserve/expose `SrpcError.userError`, and should malformed established server frames be ignored or close the client?
5. Worker and DevConsole policy:
    - Is recorder persistence part of successful job execution, and how should recorder failure combine with an original handler failure?
    - What timeout/cancellation contract should runner shutdown use for hanging handlers?
    - Should `WorkerRecorderService` be bounded, and if so independently of the DevConsole's 200-entry view?
    - Should process-global database, SRPC, worker, and mutex observers gain per-app ownership filtering?
6. Compatibility and release operations:
    - Should removed legacy telemetry subpaths, the `serializer` name, deleted conversion tooling, and removed standalone OpenAPI options retain deprecated compatibility aliases for a transition release?
    - Confirm whether main-branch CI should publish to public npm and force-push the GitHub `main` mirror.

### Planned Fixtures And Quality Gates

These gaps do not require a product behavior choice, but do require broader fixtures or test infrastructure:

1. Extend live schema-builder coverage across both supported database engines and add a real migrated `_jobs` table fixture once recorder failure semantics are settled.
2. Cover pending versus active SRPC maps, rejected-conflict callbacks, metadata races under the chosen semantics, and quiet-client Redis expiry under the chosen registry policy.
3. Scan root and nested Markdown, reverse-check sidebar/navigation targets, and either adopt a Markdown parser or define the regex gate's supported Markdown subset.
4. Add dynamic ESM import and packed-install checks, plus assertions that `/otel` exposes only its intended bootstrap surface.
5. Compile documentation fences selectively, starting with setup, middleware, uploads, authentication, logging, and mail examples.
