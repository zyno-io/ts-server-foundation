# Helpers

TSF exports small utility helpers from the package root. They are grouped by async context, availability monitoring, data manipulation, streams, Redis, security, dates, errors, and package metadata.

## Async Context

```ts
import { getContext, getContextProp, removeContextProp, setContextProp, withContext, withContextData } from '@zyno-io/ts-server-foundation';

await withContext(async () => {
    setContextProp('reqId', 'abc');
    getContextProp<string>('reqId'); // 'abc'
});

await withContextData({ userId: '123' }, async () => {
    getContext(); // { userId: '123' }
});
```

`withContextData()` restores overwritten values when the callback completes.

## Promises And Processes

```ts
import { createSemaphore, deferred, execProcess } from '@zyno-io/ts-server-foundation';

const semaphore = createSemaphore();
semaphore.release();
await semaphore.promise;

const pending = deferred<string>();
pending.resolve('done');
await pending.promise;

const result = await execProcess('git', ['status'], { cwd: process.cwd() });
result.stdout.toString();
```

`execProcess()` throws on non-zero exit codes unless `errorOnNonZero: false` is passed.

`ExecProcessOptions` also accepts `cwd`, `env`, `stdio`, `shell`, and `onSpawn`. Captured `stdout` and `stderr` are `Buffer` values; they are empty when the selected `stdio` mode does not expose child pipes. `onSpawn` receives the `ChildProcess` after spawn, and throwing from it kills the child and rejects the operation. Spawn and exit failures are wrapped with the command in the outer error message and the original failure as `cause`.

## Arrays

```ts
import { asyncMap, chunk, toArray, unique } from '@zyno-io/ts-server-foundation';

toArray('one'); // ['one']
unique([1, 1, 2]); // [1, 2]
chunk([1, 2, 3, 4], 2); // [[1, 2], [3, 4]]
await asyncMap(items, async item => processItem(item));
```

`asyncMap()` runs sequentially.

`chunk()` throws when its size is zero or negative. `unique()` uses JavaScript `Set` equality and preserves first-seen order.

## Objects

```ts
import { extractKV, extractUpdates, extractValues, objectAssign, objectEntries, objectKeys, patchObject } from '@zyno-io/ts-server-foundation';

const keys = objectKeys(user);
const entries = objectEntries(user);
const subset = extractValues(user, ['id', 'email'] as const);
const updates = extractUpdates(current, next);
patchObject(current, { name: 'Alice' });
const namesById = extractKV(users, 'id', 'name');
```

`extractUpdates()` supports `equals` and `matches` comparison modes. `matches` recursively compares plain-object subsets.

## Transformer

```ts
import { Transformer } from '@zyno-io/ts-server-foundation';

const rows = await Transformer.create(users)
    .apply(items => items.filter(item => item.active))
    .applyEach(item => ({ ...item, label: item.name.toUpperCase() }))
    .narrow('id', 'label')
    .get();
```

Methods:

| Method                             | Description                                         |
| ---------------------------------- | --------------------------------------------------- |
| `apply(fn, shouldApply?)`          | Transforms the whole array.                         |
| `applyEach(fn, shouldApply?)`      | Maps each item synchronously.                       |
| `applyEachAsync(fn, shouldApply?)` | Maps each item sequentially with an async function. |
| `narrow(...keys)`                  | Keeps selected keys.                                |
| `get()`                            | Resolves the transformed array.                     |

## JSON

```ts
import { fromJson, safeJsonStringify, toJson } from '@zyno-io/ts-server-foundation';

const text = toJson({ ok: true });
const value = fromJson<{ ok: boolean }>(text);
safeJsonStringify(circularObject);
```

`safeJsonStringify()` replaces circular references with `"[Circular]"`.

## Streams

```ts
import { safePipe, PipeError } from '@zyno-io/ts-server-foundation';

try {
    await safePipe(input, output);
} catch (error) {
    if (error instanceof PipeError) {
        error.side; // 'input' | 'output'
    }
}
```

`safePipe()` destroys the opposite stream when one side fails.

## Resource Cleanup

`withResourceCleanup()` owns temporary files and streams for the duration of an async operation:

```ts
import { createReadStream } from 'node:fs';
import { withResourceCleanup } from '@zyno-io/ts-server-foundation';

const result = await withResourceCleanup(async tracker => {
    tracker.addFile('/tmp/generated-report');
    tracker.addStream(createReadStream('/tmp/generated-report'));
    return processReport();
});
```

The callback receives a `ResourceTracker`:

| Method          | Behavior                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `addFile(path)` | Records a file to unlink during cleanup. Missing/unlink-failed files are ignored.               |
| `addStream(s)`  | Records a readable or writable stream, captures its first emitted error, and destroys it later. |
| `getFailure()`  | Returns the first recorded stream error, if any.                                                |
| `cleanup()`     | Unlinks tracked files and destroys tracked streams that are not already destroyed.              |

Cleanup runs in `finally` after success or failure. If the callback finishes but a tracked stream has already emitted an error, `withResourceCleanup()` rejects with that error. Its optional `onError` callback observes callback/recorded failures before cleanup; it does not suppress them.

## Package Metadata

```ts
import { getPackageJson, getPackageName, getPackageVersion, resetPackageJsonCache } from '@zyno-io/ts-server-foundation';

getPackageName();
getPackageVersion();
resetPackageJsonCache();
```

Package metadata is read from `process.cwd()/package.json` and cached.

## Security

```ts
import {
    AlphanumericCharacters,
    Crypto,
    NumericCharacters,
    PrintableCharacters,
    UpperCaseAlphanumericCharacters,
    randomBytes,
    randomBytesSync,
    randomString,
    randomStringSync
} from '@zyno-io/ts-server-foundation';

const token = await randomString(32, AlphanumericCharacters);
const pin = randomStringSync(6, NumericCharacters);
const recoveryCode = randomStringSync(12, UpperCaseAlphanumericCharacters);
const printable = randomStringSync(24, PrintableCharacters);
const bytes = await randomBytes(32);
const hex = randomBytesSync(16, true);

const encrypted = Crypto.encrypt('secret');
const decrypted = Crypto.decrypt(encrypted);
```

`Crypto` uses AES-256-GCM. `CRYPTO_SECRET` must be 32 bytes or 64 hex characters. `CRYPTO_IV_LENGTH` defaults to 12.

The four exported character sources are `PrintableCharacters` (ASCII 32 through 126), `AlphanumericCharacters`, `UpperCaseAlphanumericCharacters`, and `NumericCharacters`. `randomString()` and `randomStringSync()` default to `AlphanumericCharacters` and reject an empty source. Character selection uses random bytes modulo the source length.

`randomBytes(length, true)` and `randomBytesSync(length, true)` return hex strings; without `true` they return `Buffer` values. String encryption returns base64 and string decryption returns UTF-8. Buffer input produces Buffer output. Invalid/truncated payloads or authentication-tag failures throw. Use `new Crypto({ secret })` for app-independent settings with the default 12-byte IV, or also pass `ivLength` to override it. When `secret` is omitted, construction reads application configuration. The static methods share a lazily created instance, and `Crypto.reset()` clears that instance so changed application configuration is read on the next static call.

`assertInput()` and `isValidEmail()` provide lightweight boundary checks independent of reflection:

```ts
import { assertInput, isValidEmail } from '@zyno-io/ts-server-foundation';

assertInput(value, 'email');
if (!isValidEmail(value)) throw new Error('Invalid email');
```

`assertInput()` rejects `undefined`, `null`, and `''`; it does not reject other falsey values such as `0` or `false`. `isValidEmail()` is a simple whitespace/`@`/dot shape check, not mailbox verification.

## Reflected Deserialization And Validation

```ts
import { assertInput, deserialize, validate, validatedDeserialize } from '@zyno-io/ts-server-foundation';

const deserialized = deserialize<MyInput>(payload);
const errors = validate<MyInput>(payload);
const input = validatedDeserialize<MyInput>(payload);
assertInput(payload.name, 'name');
```

The generic `deserialize<T>()`, `validate<T>()`, and `validatedDeserialize<T>()` calls require TSF's metadata compiler transform when the reflected type is supplied only through `T`.

| Helper                      | Deserializes | Validates | Failure behavior                                 |
| --------------------------- | ------------ | --------- | ------------------------------------------------ |
| `deserialize<T>()`          | Yes          | No        | Returns the transformed value.                   |
| `validate<T>()`             | No           | Yes       | Returns every reflected `ValidatorError`.        |
| `validatedDeserialize<T>()` | Yes          | Yes       | Deserializes first, then throws the first error. |

The compatibility exports `cast<T>()`, `assert<T>()`, and `is<T>()` receive generic metadata when they are imported directly from `@zyno-io/ts-server-foundation`. The compiler checks import identity so application helpers with the same short names are not transformed. Uncompiled calls and calls without a generic type require an explicit reflected `Type` argument and throw when it is absent.

Deserialization recursively coerces supported primitives, arrays, tuples, objects, unions, intersections, and reflected classes. It also applies registered transforms such as `TrimmedString` trimming and phone normalization. Reflected object DTOs are reconstructed from their declared properties, so undeclared input properties are generally dropped rather than rejected. Union deserialization uses validation internally to select the first matching branch, but `deserialize<T>()` does not perform a final whole-value validation pass.

Validation checks required/null handling, primitive and structured shapes, literals, enums, unions, and reflected constraints such as patterns, lengths, numeric bounds, and custom validators. `NaN` is not a valid reflected `number`; positive and negative infinity remain valid JavaScript numbers unless a narrower constraint rejects them.

Use `validatedDeserialize<T>()` for untrusted input whenever a type has transforms. Calling `validate<T>()` directly does not trim or normalize first. The exported `deserializer` is the global transform registry used by library-provided and custom reflected types; there is intentionally no reflected outbound serializer registry.

`assertInput()` is separate from reflected validation. It throws `HttpBadRequestError` when a value is `undefined`, `null`, or an empty string.

## Dates And UUIDs

```ts
import { extractDate, sleepMs, sleepSecs, uuid4, uuid7, uuid7FromDate } from '@zyno-io/ts-server-foundation';

await sleepMs(100);
await sleepSecs(2);
const day = extractDate(new Date());
const id = uuid7();
const randomId = uuid4();
const historicalId = uuid7FromDate(new Date('2026-01-01T00:00:00Z'));
```

`extractDate()` accepts a `Date`, timestamp, or date string and returns the UTC `YYYY-MM-DD` portion of its ISO representation. Invalid date input throws when converted to ISO.

`uuid7()` creates time-ordered UUID v7 strings. `uuid7FromDate()` creates a v7 value using the supplied date's timestamp; it is not a deterministic hash of the date. `uuid4()` creates random UUID v4 strings.

## Error Helpers And Reporting

```ts
import { getErrorMessage, isError, reportError, setGlobalErrorReporter, toError, tryOrError, tryOrErrorSync } from '@zyno-io/ts-server-foundation';

const error = toError('failed to process input', unknownError);
const parsed = tryOrErrorSync(() => JSON.parse(text));
const fetched = await tryOrError(() => fetchData());

setGlobalErrorReporter((level, reported, context) => {
    auditError(level, reported, context);
});
reportError(3, error, { scope: 'ImportJob', data: { fileId } });
```

`isError()` recognizes ordinary and native errors. `getErrorMessage()` returns an error's message or `String(value)`. `toError()` preserves an existing `Error`, converts other values with `String`, and attaches a recursively normalized `cause` when supplied. `tryOrErrorSync()` and `tryOrError()` return caught failures as `Error` values instead of throwing, so callers must distinguish the result with `isError()`.

`reportError()` synchronously calls the registered global reporter, sends the exception to Sentry when installed, and starts a Slack webhook notification only for level `1`. A throwing global reporter is isolated and logged so it does not prevent Sentry or Slack handling. Level `1` maps to Sentry `fatal`, level `3` to `warning`, and other levels to `error`. Populate `SentryLiftKeysToTagsFromLoggerContext` with primitive logger-context keys that should be lifted to Sentry tags; the remaining logger context stays in the event details. Slack delivery is asynchronous and delivery errors are logged rather than thrown to the caller.

See [Logging](./logging.md#error-handling) for logger integration and alert configuration.

## Availability Monitoring

`createAvailabilityMonitor()` turns dependency lifecycle events into delayed, deduplicated outage reporting:

```ts
import { createAvailabilityMonitor } from '@zyno-io/ts-server-foundation';

const monitor = createAvailabilityMonitor(logger, {
    name: 'Search service',
    alertAfterMs: 60_000
});

dependency.on('error', error => monitor.unavailable(error));
dependency.on('ready', () => monitor.available());
```

The first `unavailable()` call logs a warning and starts the grace period. Repeated failures update the retained error without producing duplicate warnings or alerts. If the dependency remains unavailable, one error is reported after `alertAfterMs`; `available()` cancels a pending alert, logs recovery, and rearms the monitor. `stop()` permanently cancels the monitor and its timer.

The default grace period is 60 seconds. Dependency-specific adapters can translate their native lifecycle events to `unavailable()` and `available()`; `monitorRedisAvailability()` is the built-in ioredis adapter.

## Redis Helpers

```ts
import { Cache, createBroadcastChannel, createRedis, createRedisOptions, disconnectAllRedis, withMutex } from '@zyno-io/ts-server-foundation';

const { client, prefix } = createRedis('CACHE');
await Cache.setObj('settings', { enabled: true }, 60);

const channel = createBroadcastChannel<{ id: string }>('item.changed');
channel.subscribe(message => console.log(message.id));
channel.publish({ id: '123' });

await withMutex({
    key: ['job', 'daily'],
    fn: async didWait => runJob(didWait),
    mode: 'redis'
});

// Normally automatic during app.stop(); release all tracked clients early when needed:
await disconnectAllRedis();
```

Redis config prefixes map keys like `CACHE_REDIS_HOST` to the base Redis option names for that connection.

See [Redis](./redis.md) for cache, mutex, broadcast, and distributed-method details.
