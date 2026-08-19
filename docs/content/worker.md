# Workers

The worker layer uses BullMQ with Redis outside test mode. In `APP_ENV=test`, it uses an in-process queue so tests do not require Redis unless a test explicitly starts an app with a non-test config.

Enable worker services with `createApp({ enableWorker: true })`. This registers `WorkerService`, `WorkerRunnerService`, the queue registry, and the recorder.

```typescript
const app = createApp({
    enableWorker: true,
    providers: [SendEmailJob]
});
```

Normal server processes can enqueue jobs. The job runner starts only for the main app process or `node . worker:start`; CLI service commands never start it, even when `ENABLE_JOB_RUNNER=true`.

For the main app process, runner ownership is controlled by `ENABLE_JOB_RUNNER`:

| Environment           | Default runner behavior                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `production`          | runner off unless `ENABLE_JOB_RUNNER=true`                                                                                        |
| non-production        | runner on unless `ENABLE_JOB_RUNNER=false`                                                                                        |
| `node . worker:start` | runner forced on; the HTTP listener also starts, including `/healthz`, `/readyz`, and `/livez` unless health checks were disabled |

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

| Option             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `delay`            | Delay in milliseconds before the job is ready.           |
| `queueName`        | Override the queue for this job instance.                |
| `runInTest`        | Allow queueing in `APP_ENV=test`.                        |
| `runImmediately`   | Bypass BullMQ and execute inline through the runner.     |
| `recordToDatabase` | Set to `false` to opt out of the default `_jobs` record. |
| `repeatKey`        | Internal repeat key used for cron scheduling.            |

The default queue comes from `BaseAppConfig.BULL_QUEUE`. If unset, it is `default`.

Outside `APP_ENV=test`, BullMQ requires a `BULL_REDIS_HOST`/`BULL_REDIS_SENTINEL_HOST` connection or the corresponding generic `REDIS_HOST`/`REDIS_SENTINEL_HOST` fallback.

The runner suppresses Redis availability logs for BullMQ reconnects shorter than two seconds. This filters BullMQ's defensive blocking-connection recycling without shifting the sustained-outage deadline configured by `REDIS_UNAVAILABLE_ALERT_AFTER_MS`. `Worker ready` is logged only for each worker's initial connection; longer outage recovery is reported by the availability monitor.

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

After a successful `migrate` or `migrate:run`, the migration command removes framework-managed BullMQ schedulers whose job was deleted, no longer has a cron schedule, moved queues, or changed schedules. Matching schedulers remain registered and the worker runner creates the replacement for changed schedules when the application starts. Legacy repeatable cron jobs on the default queue are also removed so migrations from `dk-server-foundation` replace them with Job Schedulers instead of running both registrations.

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

`WorkerRecorderService` keeps in-memory execution records for the lifetime of the process and writes completed/failed records into the internal `_jobs` table by default when a `BaseDatabase` provider is configured. It provisions that table from `JobEntity` before a BullMQ worker consumes jobs (and before inline database recording); applications do not include it in their own migrations.

For BullMQ queues, a Redis leader is elected independently for each queue. The elected recorder listens through `QueueEvents`, persists a terminal job record, and only then removes that completed or failed job from BullMQ. This preserves completed jobs across recorder restart or leader handoff until their database record is durable. `getRecords()` returns shallow copies. The recorder itself is unbounded; DevConsole intentionally displays only the latest 200 records.

```typescript
await worker.queueJob(SendEmailJob, data, {
    runImmediately: true
});

const records = app.get(WorkerRecorderService).getRecords();
```

Set `recordToDatabase: false` only when a job must not have a durable audit record. The database record contains queue, queue id, attempt, job name, input data, status, result, and timestamps.

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
- For inline/in-process execution, a recorder/database failure propagates through job execution. For BullMQ execution, the elected observer logs the failure and keeps the terminal job in BullMQ for recovery rather than removing it.
- Runner shutdown waits for active handlers without a timeout or cancellation signal.
