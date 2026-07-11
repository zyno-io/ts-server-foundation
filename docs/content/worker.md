# Workers

The worker layer uses BullMQ with Redis outside test mode. In `APP_ENV=test`, it uses an in-process queue so tests do not require Redis unless a test explicitly starts an app with a non-test config.

Enable worker services with `createApp({ enableWorker: true })`. This registers `WorkerService`, `WorkerRunnerService`, the queue registry, and the recorder.

```typescript
const app = createApp({
    enableWorker: true,
    providers: [SendEmailJob]
});
```

Normal server processes can enqueue jobs. Runner ownership is controlled by `ENABLE_JOB_RUNNER`:

| Environment           | Default runner behavior                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `production`          | runner off unless `ENABLE_JOB_RUNNER=true`                                                               |
| non-production        | runner on unless `ENABLE_JOB_RUNNER=false`                                                               |
| `node . worker:start` | runner forced on; the HTTP listener also starts, including `/healthz` unless health checks were disabled |

Production deployments should run API/server pods with `node . server:start` and `ENABLE_JOB_RUNNER` unset or false, and separate worker pods with `node . worker:start`.

## Defining Jobs

Jobs extend `BaseJob<I, O>` and are registered with `@WorkerJob()`.

```typescript
import { BaseJob, WorkerJob } from '@zyno-io/ts-server-foundation';

interface SendEmailInput {
    to: string;
    subject: string;
}

@WorkerJob({ queueName: 'mail' })
class SendEmailJob extends BaseJob<SendEmailInput, { sent: boolean }> {
    async handle(data: SendEmailInput) {
        return { sent: true };
    }
}
```

The job class must also be registered as a provider so the runner can resolve it through DI.

`BaseJob<I, O>` contains one required method, `handle(data: I): O | Promise<O>`. `@WorkerJob()` sets the job class's queue and cron metadata and adds it to the process registry; it does not add the class to the app's DI container. The decorator accepts `queueName` (`queue` is an alias) and `cronSchedule` (`cron` is an alias).

The equivalent static metadata remains available for jobs that cannot use decorator arguments:

```typescript
@WorkerJob()
class DailyCleanupJob extends BaseJob<void, void> {
    static QUEUE_NAME = 'maintenance';
    static CRON_SCHEDULE = '0 2 * * *';

    async handle() {
        await cleanup();
    }
}
```

Decorator values override the inherited `QUEUE_NAME = 'default'` and `CRON_SCHEDULE = null` defaults on that job class.

## Queueing Jobs

Use `WorkerService.queueJob()` for normal queueing and `WorkerService.runJob()` for immediate execution.

```typescript
const worker = app.get(WorkerService);

await worker.queueJob(SendEmailJob, {
    to: 'user@example.com',
    subject: 'Welcome'
});

const execution = await worker.runJob(SendEmailJob, {
    to: 'user@example.com',
    subject: 'Welcome'
});
```

`runJob()` always creates an in-process queue record and executes it immediately through `WorkerRunnerService`; it does not enqueue a BullMQ job. `queueJob(..., { runImmediately: true })` uses the same inline path. Without `runImmediately`, test mode uses the in-memory queue while non-test environments enqueue through BullMQ.

In `APP_ENV=test`, `queueJob()` returns `undefined` unless `runInTest: true` is passed. This keeps tests from accidentally scheduling background work.

```typescript
await worker.queueJob(SendEmailJob, data, {
    runInTest: true,
    runImmediately: true
});
```

## Job Options

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `delay`            | Delay in milliseconds before the job is ready.         |
| `queueName`        | Override the queue for this job instance.              |
| `runInTest`        | Allow queueing in `APP_ENV=test`.                      |
| `runImmediately`   | Bypass BullMQ and execute inline through the runner.   |
| `recordToDatabase` | Insert a `_jobs` record when a database is configured. |
| `repeatKey`        | Internal repeat key used for cron scheduling.          |

The default queue comes from `BaseAppConfig.BULL_QUEUE`. If unset, it is `default`.

Outside `APP_ENV=test`, BullMQ requires a `BULL_REDIS_HOST`/`BULL_REDIS_SENTINEL_HOST` connection or the corresponding generic `REDIS_HOST`/`REDIS_SENTINEL_HOST` fallback.

## Cron Jobs

Use `cronSchedule` or `cron` on `@WorkerJob()`.

```typescript
@WorkerJob({ queueName: 'daily', cronSchedule: '0 2 * * *' })
class DailyCleanupJob extends BaseJob<void, void> {
    async handle() {
        await cleanup();
    }
}
```

When the runner starts, it registers BullMQ job schedulers for registered cron jobs. In test-mode in-process queues, the runner schedules one pending repeat job per registered job class and repeat key.

## Queue Registry

`WorkerQueueRegistry` is primarily an internal queue abstraction. In test mode it stores queued jobs in memory and exposes:

- `add(jobClass, data, options)`
- `getQueuedJobs(queue?)`
- `getAllQueuedJobs()`
- `markCompleted(job, result)`
- `markFailed(job, result)`
- `remove(job)`
- `clear(queue?)`
- `WorkerQueueRegistry.closeQueues()`

Outside test mode, `WorkerService.queueJob()` writes to BullMQ. Workers deserialize jobs by class name and resolve the matching registered provider through DI.

## Recorder

`WorkerRecorderService` keeps in-memory execution records for the lifetime of the process and can optionally write completed/failed records into a `_jobs` table when a `BaseDatabase` provider is configured and the job option `recordToDatabase` is true. The application must provision that table through its own migration; registering worker services does not add it to the database entity registry or create it automatically. `getRecords()` returns shallow copies. The recorder itself is unbounded; DevConsole intentionally displays only the latest 200 records.

```typescript
await worker.queueJob(SendEmailJob, data, {
    runImmediately: true,
    recordToDatabase: true
});

const records = app.get(WorkerRecorderService).getRecords();
```

The database record contains queue, queue id, attempt, job name, input data, status, result, and timestamps.

## Request Context

Jobs execute inside helper context data containing the current job metadata:

```typescript
import { getContextProp } from '@zyno-io/ts-server-foundation';

const job = getContextProp<{ queue: string; id: string; name: string }>('job');
```

## Observers

`registerWorkerObserver()` receives process-wide queue/execution events and returns an unsubscribe function.

```typescript
import { registerWorkerObserver } from '@zyno-io/ts-server-foundation';

const unsubscribe = registerWorkerObserver(entry => {
    console.log(entry.type, entry.job.name, entry.job.id);
});
```

Entries are `added`, `delayed`, `active`, `completed`, or `failed`; completed/failed entries also include the execution record. Observer exceptions are isolated from queueing and job execution. DevConsole uses the same observation surface, so observers are process-wide rather than scoped to one app.

## Current Limits

- Queue names are discovered from `BULL_QUEUE` and registered `@WorkerJob({ queueName })` classes. Avoid arbitrary per-call `queueName` overrides unless worker processes also register a job class on that queue.
- Retry/backoff policy is application-defined; the current worker options do not expose BullMQ retry options.
- Recorder/database failures currently propagate through job execution and can turn an otherwise successful handler into a failed job; choose `recordToDatabase` only when that failure coupling is intended.
- Runner shutdown waits for active handlers without a timeout or cancellation signal.
