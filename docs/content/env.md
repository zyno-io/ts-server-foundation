# Environment

TSF centralizes environment access through the exported `Env` object and config loader. Application code should prefer `Env` and reflected config classes over direct `process.env` reads.

## `Env`

`Env` is preloaded with `process.env` and typed as optional strings.

```ts
import { Env } from '@zyno-io/ts-server-foundation';

const adapter = Env.DB_ADAPTER; // string | undefined
Env.APP_ENV = 'development';
delete Env.PORT;
```

Reading or writing `Env` reads or writes `process.env` at runtime. This keeps all known keys discoverable in one interface while preserving Node environment behavior.

## Snapshots

Tests can snapshot and restore the full environment.

```ts
import { applyEnv, envSnapshot } from '@zyno-io/ts-server-foundation';

const before = envSnapshot();

try {
    applyEnv({ APP_ENV: 'test', DB_ADAPTER: 'postgres' });
    // run isolated logic
} finally {
    applyEnv(before);
}
```

Helpers:

| Helper               | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `envSnapshot()`      | Returns a shallow copy of the current `Env`.                         |
| `applyEnv(env)`      | Clears `process.env` and replaces it with defined values from `env`. |
| `toProcessEnv(env?)` | Converts an `EnvObject` to a plain `NodeJS.ProcessEnv`.              |

## Config Loading

`ConfigLoader` loads a reflected config class from dotenv files and `Env` using `@zyno-io/config`.

```ts
import { BaseAppConfig, ConfigLoader } from '@zyno-io/ts-server-foundation';

class AppConfig extends BaseAppConfig {
    FEATURE_ENABLED = false;
    API_TIMEOUT_MS = 5000;
}

const config = new ConfigLoader(AppConfig).load();
```

File load order from the current working directory:

1. `.env`
2. `.env.local`
3. `.env.development` and `.env.development.local` when running tests
4. `.env.${APP_ENV}`
5. `.env.${APP_ENV}.local`
6. Values already present in `Env`

Later values override earlier values. Config loading does not delete consumed keys from `process.env`, so loaded values remain available to later code and child processes. `_SECRET` keys are decrypted by `@zyno-io/config` when `CONFIG_DECRYPTION_SECRET` or the legacy `CONFIG_DECRYPTION_KEY` is present.

## Defaults

`APP_ENV` is required in production. Outside production, it defaults automatically:

| Condition                                    | Default       |
| -------------------------------------------- | ------------- |
| Node test context is active                  | `test`        |
| `NODE_ENV !== 'production'`                  | `development` |
| `NODE_ENV === 'production'` and no `APP_ENV` | Error         |

## Type Coercion

Config values are strings when read from files or environment. The loader coerces reflected number and boolean fields.

```ts
class AppConfig extends BaseAppConfig {
    PORT = 3000; // "8080" becomes 8080
    ENABLE_CACHE = false; // "true" or "1" becomes true
}
```

Literal boolean and number types are also coerced.

## Loaded Environment Keys

When a config property is loaded from `Env`, the loader leaves that key in `Env` after loading. This keeps Node's process environment intact for later code and child processes.

```ts
Env.PORT = '8080';
const config = new ConfigLoader(BaseAppConfig).load();

config.PORT; // 8080
Env.PORT; // "8080"
```

## Common Keys

The runtime recognizes these built-in config and environment keys. Most are reflected `BaseAppConfig` properties; early telemetry bootstrap also reads its `OTEL_*` controls directly from `Env`:

- application and HTTP: `APP_ENV`, `DEVCONSOLE_ENABLED`, `PORT`, `USE_REAL_IP_HEADER`, `HTTP_MAX_REQUEST_BODY_BYTES`, `HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES`, `HTTP_MAX_FORM_FIELDS`, `HTTP_MAX_FORM_FIELD_NAME_LENGTH`, `HTTP_MAX_FORM_DEPTH`, `HTTP_MAX_FORM_ARRAY_INDEX`
- database: `DB_ADAPTER`, `MYSQL_*`, `PG_*`
- auth: `AUTH_JWT_*`, `AUTH_BASIC_SECRET`
- Redis and workers: `REDIS_*`, `CACHE_REDIS_*`, `MUTEX_REDIS_*`, `BROADCAST_REDIS_*`, `MESH_REDIS_*`, `BULL_REDIS_*`, `BULL_QUEUE`, `MUTEX_MODE`, `ENABLE_JOB_RUNNER`
- OpenAPI: `ENABLE_OPENAPI_ROUTE`, `ENABLE_OPENAPI_SCHEMA`
- logging: `HTTP_REQUEST_LOGGING_MODE`, `HEALTHZ_ENABLE_REQUEST_LOGGING`, `ENABLE_PINO_PRETTY`, `ENABLE_PINO_SINGLE_LINE`, `LOG_LEVEL`
- telemetry: `SENTRY_DSN`, `OTEL_*`, `ALERTS_SLACK_WEBHOOK_URL`
- SRPC: `SRPC_AUTH_SECRET`, `SRPC_AUTH_CLOCK_DRIFT_MS`
- mail: `MAIL_*`, `SMTP_*`, `POSTMARK_SECRET`
- tests and tooling: `TEST_KEEP_DB`, `TEST_RUN_TS`, `TSF_TEST_*`, `PROTOC`

See [Configuration](./configuration.md) for the value-level config reference.
