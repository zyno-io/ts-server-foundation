---
layout: home

hero:
    name: '@zyno-io/ts-server-foundation'
    text: 'Server Foundation Library'
    tagline: TypeScript server foundation with reflected type metadata
    actions:
        - theme: brand
          text: Get Started
          link: /getting-started
        - theme: alt
          text: Explore Features
          link: /overview

features:
    - title: Application Runtime
      details: createApp, lifecycle hooks, app.http server APIs, health checks, CORS, request handling, and request-scoped DI.
    - title: Dependency Injection
      details: Constructor injection from reflected type metadata, request scopes, module exports, and globally injectable imported exports.
    - title: HTTP
      details: Decorator-based controllers, explicit body/query/header/path annotations, multipart uploads, raw request streaming, and OpenAPI metadata.
    - title: Database
      details: Thin active-record layer over mysql2 and pg with transactions, savepoints, raw SQL bindings, locks, migrations, and schema diffing.
    - title: Workers
      details: In-process job registration, inline test execution, cron scheduling, queue recording, and DI-owned job handlers.
    - title: SRPC
      details: HMAC-authenticated WebSocket RPC with generated proto types, bidirectional calls, byte streams, and upgrade claiming.
    - title: Configuration
      details: Reflected config classes loaded from env files and Env while preserving process env for later code and child processes.
    - title: Testing
      details: Test facades, in-memory HTTP requests, isolated MySQL/PostgreSQL databases, seed hooks, and assertion helpers.
---

## Install

```bash
corepack yarn add @zyno-io/ts-server-foundation
corepack yarn tsf-install
```

`tsf-install` configures the TypeScript transform and compiler dependencies. The TSF compiler emits reflected type metadata and compiler-recognized annotation markers used by DI, HTTP parameters, config classes, entities, validation, and OpenAPI generation. See [Getting Started](./getting-started.md#typescript-configuration) for the manual configuration.

## Quick Start

```ts
import { BaseAppConfig, createApp, createDatabase, http } from '@zyno-io/ts-server-foundation';

class AppConfig extends BaseAppConfig {
    APP_ENV = 'development';
}

@http.controller('/hello')
class HelloController {
    @http.GET()
    hello() {
        return { ok: true };
    }
}

class AppDatabase extends createDatabase('mysql', {}, []) {}

export const app = createApp({
    config: AppConfig,
    db: AppDatabase,
    controllers: [HelloController]
});
```

## Documentation

- [Feature Overview](./overview.md)
- [Getting Started](./getting-started.md)
- [Public API](./public-api.md)
- [Dependency Injection](./di.md)
- [Configuration](./configuration.md)
- [Environment](./env.md)
- [Database](./database.md)
- [SQL](./sql.md)
- [Migrations](./migrations.md)
- [HTTP](./http.md)
- [Uploads](./uploads.md)
- [OpenAPI](./openapi.md)
- [Authentication](./authentication.md)
- [Health Checks](./health.md)
- [DevConsole](./devconsole.md)
- [Logging](./logging.md)
- [Types](./types.md)
- [Type Reflection](./reflection.md)
- [Type Reflection Architecture](./type-reflection-architecture.md)
- [Testing](./testing.md)
- [CLI](./cli.md)
- [Workers](./worker.md)
- [Redis](./redis.md)
- [SRPC](./srpc.md)
- [Mail](./mail.md)
- [Leader Service](./leader-service.md)
- [Mesh Service](./mesh-service.md)
- [Mesh Client Tracking](./mesh-client.md)
- [Helpers](./helpers.md)
- [Telemetry](./telemetry.md)
- [Release](./release.md)
- [Documentation Maintenance](./documentation-plan.md)

## Acknowledgements

TS Server Foundation owes a great deal to the open-source projects that made its architecture possible. [Deepkit](https://github.com/marcj/deepkit) inspired many of the design ideas behind its runtime type reflection, dependency injection, and metadata-driven server APIs. We are especially grateful to Deepkit's maintainer, [Marc J. Schmidt](https://github.com/marcj), for showing how powerful a cohesive, type-aware TypeScript framework can be.

[Typia](https://typia.io/) and [ttsc](https://github.com/samchon/ttsc) provided the essential compiler groundwork for bringing those ideas to TypeScript 7. TSF builds on their type-analysis and transform infrastructure to generate the runtime metadata at the heart of the framework. Our sincere thanks to Jeongho Nam and every contributor to these projects for making that work available to the TypeScript community.
