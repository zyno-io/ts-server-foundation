# Logging

TSF provides scoped Pino loggers with async context tracking, structured data, pretty development output, HTTP request logs, and error reporting integration.

## Creating Loggers

```typescript
import { createLogger } from '@zyno-io/ts-server-foundation';

// From a class instance (uses class name as scope)
class TaskService {
    private logger = createLogger(this);

    async process() {
        this.logger.info('Processing task');
    }
}

// From a string
const workerLogger = createLogger('TaskWorker');

// With default data attached to every log
const regionalLogger = createLogger('TaskWorker', { region: 'us-east-1' });
```

For application services, inject `ScopedLogger`. The built-in target factory derives the scope from the concrete consuming class, so this service logs under `TaskService` without repeating its name:

```typescript
import { createApp, ScopedLogger } from '@zyno-io/ts-server-foundation';

class TaskService {
    constructor(private readonly logger: ScopedLogger) {}

    async process() {
        this.logger.info('Processing task');
    }
}

const app = createApp({ providers: [TaskService] });
```

`createLogger()` uses the same current sink and is useful outside DI. Existing logger instances retain the sink they were created with.

## Log Levels

```typescript
logger.debug('Debug message');
logger.info('Info message');
logger.warning('Warning message');
logger.error('Error message');
logger.alert('Alert message');
```

`LoggerLevel` is an ordered numeric enum from `none` through `debug2`. A logger defaults to `LoggerLevel.info`; assign its mutable `level` to change the threshold. Lower-numbered, more severe entries pass a higher threshold:

```typescript
import { LoggerLevel } from '@zyno-io/ts-server-foundation';

logger.level = LoggerLevel.debug2;
logger.is(LoggerLevel.debug2); // true
logger.debug2('Verbose diagnostic');
```

The methods and structured level names are `alert`, `error`, `warning` (`warn` is an alias), `log`, `info`, `debug`, and `debug2`. Pino JSON output maps them to `ALERT`, `ERROR`, `WARNING`, `NOTICE`, `INFO`, and `DEBUG`; both debug levels map to `DEBUG` at the transport boundary.

`debug()` is special: it emits only when the logger scope is enabled by the [`DEBUG`](https://www.npmjs.com/package/debug) namespace setting, and an enabled namespace bypasses the numeric `logger.level`. For example, `DEBUG='TaskService*'` enables `TaskService` and its child scopes. `debug2()` does not use `DEBUG`; it follows the normal numeric threshold.

## Structured Data

```typescript
// Attach data to a log entry
logger.info('Record created', { recordId: 123, total: 99.99 });

// Error with context
logger.error('External operation failed', error, { recordId: 123, provider: 'example-provider' });
```

Logger methods accept these call shapes:

- The first string argument is the message.
- An `Error` in the first or second position is logged as `err`.
- A single object argument after the message is merged into structured data.
- Additional non-standard arguments are logged as `arg0`, `arg1`, and so on.
- `{ err }` inside structured data is lifted into the logged `err` field and removed from data.
- `logger.error(new Error('failed'))` logs an empty message with `err.message === 'failed'`.
- Markup color tags such as `<red>failed</red>` are stripped before output.

## Scoped Loggers

Create child loggers with a scope prefix and optional persistent data:

```typescript
const logger = createLogger('WorkerService');

// Child logger with scope
const taskLogger = logger.scoped('task');
taskLogger.info('Processing');
// Output: [WorkerService:task] Processing

// Child logger with persistent data
const recordLogger = logger.scoped('record', { recordId: 123 });
recordLogger.info('Created');
// Every log includes { recordId: 123 }
```

### `setScopeData(data?)`

Update the persistent data attached to a scoped logger:

```typescript
const logger = createLogger('WorkerService');
logger.setScopeData({ userId: 456 });
logger.info('Action');
// Includes { userId: 456 }
```

`logger.data(data)` returns a child logger carrying additional persistent data. It does not mutate the original logger. `setScopeData()` does mutate the receiving logger and replaces its persistent data.

Data precedence is deterministic: per-call structured data is merged first, persistent scope data overrides it, and active logger context overrides both. Child scope data passed to `scoped()`/`data()` overrides parent scope data with the same key.

## Async Context

Logger entries automatically include the shared `http` and `job` async-context properties. Arbitrary keys set with `setContextProp()` or `withContextData()` are not copied into logs; use `withLoggerContext()` for additional logging fields.

```typescript
import { withLoggerContext } from '@zyno-io/ts-server-foundation';

await withLoggerContext({ reqId: 'abc-123' }, async () => {
    logger.info('Handling request');
    // Log includes reqId: 'abc-123'
});
```

### `withLoggerContext(data, fn)`

Add additional logger context for the duration of a function:

```typescript
import { withLoggerContext } from '@zyno-io/ts-server-foundation';

await withLoggerContext({ jobId: 'job-456' }, async () => {
    logger.info('Processing job');
    // Log includes jobId: 'job-456'
});
```

Nested calls merge with the active logger context and restore the previous values when the callback resolves or throws. The shared `http` and `job` fields are added first; an explicit `withLoggerContext()` field with the same name wins. Context does not leak after the callback.

## Custom Sinks

Tests and integrations can replace the structured sink:

```typescript
import { resetLogSink, setLogSink } from '@zyno-io/ts-server-foundation';

setLogSink(entry => {
    captured.push(entry);
});

// Restore Pino-backed output when finished.
resetLogSink();
```

`setLogSink()` updates future `createLogger()` calls and logger providers created afterward. A logger already constructed keeps its original sink. Each `LogEntry` contains the numeric `level`, `levelName`, optional `scope`, stripped `message`, structured `data`, optional `error`, and a `Date` timestamp.

## Error Handling

Reporting is based on the structured entry, not only the method name. The logger automatically:

1. Extracts the error message and stack trace
2. Includes any `cause` chain
3. Reports an emitted entry carrying an error, plus every emitted `error` and `alert` entry even when no `Error` argument was supplied, to the global reporter and installed Sentry integration; entries filtered by `logger.level` are neither emitted nor reported
4. Maps `alert` to Sentry `fatal`, `warning` to Sentry `warning`, and other reported levels to Sentry `error`
5. Sends Slack webhooks only for `alert` entries; ordinary `error` entries and warning entries carrying errors do not page Slack

```typescript
try {
    await riskyOperation();
} catch (err) {
    logger.error('Operation failed', err);
    // Error reported to Sentry, details logged to Pino
}
```

## ExtendedLogger

`ExtendedLogger` is the DI-registered logger implementation. It provides:

- Pino as the underlying transport
- Scoped child loggers
- Async context integration
- Error reporting to Sentry, with Slack notifications for alert-level entries

All injected `Logger` instances are `ExtendedLogger` instances.

## Pino Instance

Access the raw Pino logger:

```typescript
import { pinoLogger } from '@zyno-io/ts-server-foundation';

pinoLogger.info({ custom: 'data' }, 'Raw pino log');
```

The default transport behavior is:

- JSON logs use a `severity` field with custom levels: `DEFAULT`, `ALERT`, `ERROR`, `WARNING`, `NOTICE`, `INFO`, and `DEBUG`.
- In development and test environments, `pino-pretty` is enabled by default unless `ENABLE_PINO_PRETTY=false`.
- `ENABLE_PINO_PRETTY=true` enables pretty output outside development/test.
- `ENABLE_PINO_SINGLE_LINE=true` enables single-line pretty output mode.
- `LOG_LEVEL` controls the pretty-printer level filter; without it, production defaults to `info` and other environments default to `debug`.

## HTTP Request Logging

Request logging is handled by the owned HTTP server boundary and configured via `HTTP_REQUEST_LOGGING_MODE`:

| Mode     | Description                                                  |
| -------- | ------------------------------------------------------------ |
| `e2e`    | Log `Request` at request start and `Response` at request end |
| `finish` | Log only `Response` at request end                           |
| `errors` | Log only request processing errors and aborts                |
| `none`   | No request logging                                           |

Test mode defaults to `errors`, so application logs stay visible while routine HTTP `Request` and `Response` records are suppressed. Health check logging is disabled by default. Enable with `HEALTHZ_ENABLE_REQUEST_LOGGING=true`.
