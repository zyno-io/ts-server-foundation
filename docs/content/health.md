# Health Checks

TSF includes a health service and a default HTTP endpoint at `/healthz`.

## Endpoint

```http
GET /healthz
```

Successful response:

```json
{ "version": "0.0.0-dev" }
```

The version comes from the cached `package.json` in the process working directory and falls back to `unknown` when that metadata is unavailable. If a registered health check throws, the endpoint returns a normalized HTTP error response.

Disable the default endpoint with `createApp({ enableHealthcheck: false })`.

## Registering Checks

Inject `HealthcheckService` and register named checks.

```ts
import { HealthcheckService, sql } from '@zyno-io/ts-server-foundation';

class DatabaseHealth {
    constructor(health: HealthcheckService, db: AppDatabase) {
        health.register('database', async () => {
            await db.rawFind(sql`SELECT ${1}`);
        });
    }
}
```

Checks return `void` or `Promise<void>`. Throw to mark the check unhealthy.

## Service API

```ts
import { HealthcheckService } from '@zyno-io/ts-server-foundation';

health.register('cache', async () => {
    await cache.ping();
});

await health.check();
const results = await health.checkIndividual();
```

| Method               | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `register(name, fn)` | Adds a named check.                                       |
| `check()`            | Runs all checks and throws on the first failure.          |
| `checkIndividual()`  | Runs all checks and returns `{ name, status, error? }[]`. |

## Request Logging

Health check request logging is controlled separately from other HTTP routes.

| Config key                       | Description                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `HEALTHZ_ENABLE_REQUEST_LOGGING` | Enables request logs for `/healthz` when true. Defaults to false. |
