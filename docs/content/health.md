# Health Checks

TSF includes health, readiness, and liveness endpoints at `/healthz`, `/readyz`, and `/livez`.

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

```http
GET /readyz
GET /livez
```

Both probe endpoints return `{ "ok": true }` when their registered checks pass. Readiness checks represent dependencies that must be available before accepting traffic, while liveness checks can detect a process that should be restarted.

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

health.registerReadyCheck('database', async () => {
    await database.ping();
});

health.registerLivenessCheck('event-loop', () => {
    // Verify the process can continue serving requests.
});

await health.check();
const results = await health.checkIndividual();
```

| Method                            | Description                                                |
| --------------------------------- | ---------------------------------------------------------- |
| `register(name, fn)`              | Adds a named check.                                        |
| `registerReadyCheck(name, fn)`    | Adds a named check run by `/readyz`.                       |
| `registerLivenessCheck(name, fn)` | Adds a named check run by `/livez`.                        |
| `check()`                         | Runs all checks and throws on the first failure.           |
| `checkReady()`                    | Runs all readiness checks and throws on the first failure. |
| `checkLiveness()`                 | Runs all liveness checks and throws on the first failure.  |
| `checkIndividual()`               | Runs all checks and returns `{ name, status, error? }[]`.  |

## Request Logging

Health check request logging is controlled separately from other HTTP routes.

| Config key                       | Description                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `HEALTHZ_ENABLE_REQUEST_LOGGING` | Enables request logs for `/healthz`, `/readyz`, and `/livez` when true. Defaults to false. |
