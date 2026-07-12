# Configuration

Configuration is loaded by reflecting a config class. `createApp()` defaults to `BaseAppConfig`, but apps usually extend it.

```ts
import { BaseAppConfig, Env } from '@zyno-io/ts-server-foundation';

class AppConfig extends BaseAppConfig {
    STRIPE_KEY_SECRET!: string;
    MAX_UPLOAD_BYTES = 10_000_000;
}

Env.APP_ENV = 'test';
```

## Loading Order

`ConfigLoader` creates the config class, applies `defaultConfig`, then loads env files and `Env` through `@zyno-io/config`.

Loaded string values receive configuration-specific primitive coercion for reflected numbers, booleans, and matching literals. The completed config instance is then reflected-validated, so required fields, unions, constraints, custom validators, and invalid numeric values such as `NaN` fail application startup. Configuration loading does not run the general reflected deserializer registry: transforms such as `TrimmedString` and phone normalization are not applied automatically.

Env files are read from the process cwd:

1. `.env`
2. `.env.local`
3. `.env.development` and `.env.development.local` in test mode
4. `.env.${APP_ENV}`
5. `.env.${APP_ENV}.local`

Values from `Env` override file values.

Keys ending in `_SECRET` may contain encrypted `@zyno-io/config` payloads. They are decrypted while loading when `CONFIG_DECRYPTION_SECRET` is set; `CONFIG_DECRYPTION_KEY` is also supported as a fallback for older deployments. Encrypted `_SECRET` values from process env are decrypted the same way.

## Env Behavior

`Env` is the only runtime bridge to `process.env`. It is preloaded from `process.env`, typed as optional strings, and exported from the package root.

Config loading reads from `Env` without deleting consumed keys from `process.env`. Values loaded into the typed config object remain available to later code and child processes.

## Required Environment

`APP_ENV` is required only when `NODE_ENV=production`. The loader infers `APP_ENV=test` under Node's test runner and otherwise defaults to `development` outside production.

## Built-In Configuration And Environment Surface

`BaseAppConfig` owns the reflected application settings used during `createApp()`. Some observability keys below are read directly from `Env` by the early telemetry bootstrap instead, so they do not need to be declared on `BaseAppConfig` unless an application wants to load them through a custom config class.

### Application

| Variable                                 | Type      | Default                                           | Description                                                                                                   |
| ---------------------------------------- | --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                | `string`  | test/development inferred; required in production | Application environment.                                                                                      |
| `DEVCONSOLE_ENABLED`                     | `boolean` | enabled in development                            | Enable or disable `/_devconsole` independently of `APP_ENV`.                                                  |
| `PORT`                                   | `number`  | `3000`                                            | HTTP server port. Ignored in `APP_ENV=test` unless `frameworkConfig.port` or `serverConfig.port` is provided. |
| `USE_REAL_IP_HEADER`                     | `boolean` | unset                                             | Trust proxy remote-address headers.                                                                           |
| `HTTP_MAX_REQUEST_BODY_BYTES`            | `number`  | `104857600`                                       | Maximum decoded request body bytes.                                                                           |
| `HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES` | `number`  | `26214400`                                        | Maximum compressed request body bytes before gzip decoding.                                                   |

### Database

| Variable                 | Type                    | Default | Description                                                      |
| ------------------------ | ----------------------- | ------- | ---------------------------------------------------------------- |
| `DB_ADAPTER`             | `'mysql' \| 'postgres'` | unset   | Dialect used by shared `createDatabase(config, entities)` calls. |
| `TSF_TEST_DATABASE_NAME` | `string`                | unset   | Internal test database override used by `TestingFacade`.         |

### MySQL

| Variable                     | Type     | Default                           |
| ---------------------------- | -------- | --------------------------------- |
| `MYSQL_HOST`                 | `string` | unset                             |
| `MYSQL_PORT`                 | `number` | unset                             |
| `MYSQL_USER`                 | `string` | unset                             |
| `MYSQL_PASSWORD_SECRET`      | `string` | unset                             |
| `MYSQL_DATABASE`             | `string` | unset                             |
| `MYSQL_CONNECTION_LIMIT`     | `number` | 10 production, 5 development/test |
| `MYSQL_MIN_IDLE_CONNECTIONS` | `number` | unset                             |
| `MYSQL_IDLE_TIMEOUT_SECONDS` | `number` | 60 production, 5 development/test |

### PostgreSQL

| Variable                     | Type      | Default                           |
| ---------------------------- | --------- | --------------------------------- |
| `PG_HOST`                    | `string`  | unset                             |
| `PG_PORT`                    | `number`  | unset                             |
| `PG_USER`                    | `string`  | unset                             |
| `PG_PASSWORD_SECRET`         | `string`  | unset                             |
| `PG_DATABASE`                | `string`  | unset                             |
| `PG_SCHEMA`                  | `string`  | unset                             |
| `PG_SSL`                     | `boolean` | unset                             |
| `PG_SSL_REJECT_UNAUTHORIZED` | `boolean` | unset                             |
| `PG_CONNECTION_LIMIT`        | `number`  | 10 production, 5 development/test |
| `PG_IDLE_TIMEOUT_SECONDS`    | `number`  | 60 production, 5 development/test |

### Authentication

| Variable                   | Type      | Default                |
| -------------------------- | --------- | ---------------------- |
| `AUTH_JWT_ISSUER`          | `string`  | unset                  |
| `AUTH_JWT_EXPIRATION_MINS` | `number`  | runtime fallback `60`  |
| `AUTH_JWT_COOKIE_NAME`     | `string`  | runtime fallback `jwt` |
| `AUTH_JWT_SECRET`          | `string`  | unset                  |
| `AUTH_JWT_SECRET_B64`      | `string`  | unset                  |
| `AUTH_JWT_ED_SECRET`       | `string`  | unset                  |
| `AUTH_JWT_ENABLE_VERIFY`   | `boolean` | `true`                 |
| `AUTH_BASIC_SECRET`        | `string`  | unset                  |

### Crypto

| Variable           | Type     | Default |
| ------------------ | -------- | ------- |
| `CRYPTO_SECRET`    | `string` | unset   |
| `CRYPTO_IV_LENGTH` | `number` | `12`    |

### Redis And Workers

| Variable                           | Type                 | Default                 |
| ---------------------------------- | -------------------- | ----------------------- |
| `REDIS_SENTINEL_HOST`              | `string`             | unset                   |
| `REDIS_SENTINEL_PORT`              | `number`             | unset                   |
| `REDIS_SENTINEL_NAME`              | `string`             | unset                   |
| `REDIS_HOST`                       | `string`             | unset                   |
| `REDIS_PORT`                       | `number`             | unset                   |
| `REDIS_PREFIX`                     | `string`             | package name            |
| `REDIS_UNAVAILABLE_ALERT_AFTER_MS` | `number`             | `60000`                 |
| `CACHE_REDIS_*`                    | `string`/`number`    | falls back to `REDIS_*` |
| `MUTEX_REDIS_*`                    | `string`/`number`    | falls back to `REDIS_*` |
| `BROADCAST_REDIS_*`                | `string`/`number`    | falls back to `REDIS_*` |
| `MESH_REDIS_*`                     | `string`/`number`    | falls back to `REDIS_*` |
| `BULL_REDIS_*`                     | `string`/`number`    | falls back to `REDIS_*` |
| `BULL_QUEUE`                       | `string`             | `default`               |
| `MUTEX_MODE`                       | `'local' \| 'redis'` | `local`                 |
| `ENABLE_JOB_RUNNER`                | `boolean`            | unset                   |
| `TEST_KEEP_DB`                     | `string`             | unset                   |
| `TEST_RUN_TS`                      | `string`             | unset                   |

### Observability

| Variable                              | Type      | Default |
| ------------------------------------- | --------- | ------- |
| `SENTRY_DSN`                          | `string`  | unset   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | `string`  | unset   |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | `string`  | unset   |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `string`  | unset   |
| `OTEL_METRICS_ENDPOINT_ENABLED`       | `boolean` | unset   |
| `OTEL_DEBUG`                          | `boolean` | unset   |
| `OTEL_SDK_DISABLED`                   | `boolean` | unset   |
| `ALERTS_SLACK_WEBHOOK_URL`            | `string`  | unset   |

### SRPC

| Variable                   | Type     | Default |
| -------------------------- | -------- | ------- |
| `SRPC_AUTH_SECRET`         | `string` | unset   |
| `SRPC_AUTH_CLOCK_DRIFT_MS` | `number` | `30000` |

### HTTP And OpenAPI

| Variable                         | Type                                      | Default                                          | Description                                                                              |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `HTTP_REQUEST_LOGGING_MODE`      | `'none' \| 'e2e' \| 'finish' \| 'errors'` | `errors` in test, `e2e` otherwise                | Controls request start, finish, and error logs.                                          |
| `HEALTHZ_ENABLE_REQUEST_LOGGING` | `boolean`                                 | `false`                                          | Includes `/healthz` in normal request logging.                                           |
| `ENABLE_OPENAPI_SCHEMA`          | `boolean`                                 | development outside Node tests                   | Writes `openapi.yaml` after startup; legacy route fallback when the route flag is unset. |
| `ENABLE_OPENAPI_ROUTE`           | `boolean`                                 | enabled in development/test                      | Serves `/openapi.json` and `/openapi.yaml`; takes precedence over the schema flag.       |
| `ENABLE_PINO_PRETTY`             | `boolean`                                 | enabled in development/test                      | Enables pretty log output.                                                               |
| `ENABLE_PINO_SINGLE_LINE`        | `boolean`                                 | enabled in development/test                      | Keeps pretty log entries on one line.                                                    |
| `LOG_LEVEL`                      | `string`                                  | `debug` outside production, `info` in production | Sets the `pino-pretty` output filter; JSON logging is not filtered by this key.          |

### Mail

| Variable               | Type                   | Default     |
| ---------------------- | ---------------------- | ----------- |
| `MAIL_FROM`            | `string`               | unset       |
| `MAIL_FROM_NAME`       | `string`               | unset       |
| `MAIL_PROVIDER`        | `'smtp' \| 'postmark'` | `smtp`      |
| `SMTP_HOST`            | `string`               | `127.0.0.1` |
| `SMTP_PORT`            | `number`               | `1025`      |
| `SMTP_USER`            | `string`               | unset       |
| `SMTP_PASSWORD_SECRET` | `string`               | unset       |
| `SMTP_TLS`             | `boolean`              | `false`     |
| `POSTMARK_SECRET`      | `string`               | unset       |

## `isDevFeatureEnabled`

```ts
import { isDevFeatureEnabled } from '@zyno-io/ts-server-foundation';

if (isDevFeatureEnabled(config.ENABLE_OPENAPI_SCHEMA)) {
    // enabled
}
```

`'1'` and `'true'` enable a flag. `'0'` and `'false'` disable a flag. Undefined flags default to enabled in development/test and disabled in production unless a different default is passed.
