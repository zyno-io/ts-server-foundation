# Temporary Workspaces

Temporary workspaces own staging files for one operation or HTTP request. They provide private
directories, cleanup of partial outputs, and bounded recovery of safely disposable process leftovers.
They are not durable storage or a cross-process file handoff protocol.

## Scoped Work

```ts
import { execProcess, withTemporaryWorkspace } from '@zyno-io/ts-server-foundation';

await withTemporaryWorkspace(
    async workspace => {
        const output = workspace.path('converted.wav');
        await execProcess('ffmpeg', ['-i', inputPath, output], { signal });
        await consume(output);
    },
    { replayable: true }
);
```

The workspace owns every file created inside its private directory, including files that a tool
partially writes before failing. `path()` validates a leaf filename and does not create the file:
tools such as ffmpeg can require a nonexistent output. Allocate paths before starting writers.
The callback must await all users of its files. Scope disposal runs on both success and failure.
It recursively releases its explicitly owned directory and attempts to leave a release marker when
an unlink fails. If disk exhaustion prevents the marker write, disposal still tries to free its bytes.
Cleanup failure does not replace the callback's original result or error.

`replayable` defaults to `false`. Set it only when retained input permits replay after a process crash.
This policy is an application decision. An accepted upload or an uncommitted recording may be its
sole remaining copy and must not be marked replayable merely because it is old or called temporary.

## Multipart And Request Work

TSF stores multipart uploads in a managed request workspace. `await request.workspace()` lazily
returns that same workspace, including for a request without multipart data. Concurrent calls share
one allocation. The router disposes it after the controller and response workflow settle. Derived
and partial files alongside upload paths are included automatically. Reading `request.signal` alone
does not allocate a temporary directory.

```ts
import { execProcess, FileUpload, http, HttpBody, HttpRequest, HttpResponse } from '@zyno-io/ts-server-foundation';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

@http.controller()
class ConversionController {
    @http.POST('/convert')
    async convert(body: HttpBody<{ file: FileUpload }>, request: HttpRequest, response: HttpResponse): Promise<void> {
        request.setDeadline(120_000);
        const files = await request.workspace({ replayable: true });
        const output = files.path('result.mp3');
        await execProcess('ffmpeg', ['-i', body.file.path, output], { signal: request.signal });
        response.setHeader('content-type', 'audio/mpeg');
        await pipeline(createReadStream(output), response, { signal: request.signal });
    }
}
```

The request owns the lifetime; no callback wrapper or extra injected provider is required. Every request
has one stable `signal`, which aborts when an unfinished response disconnects or fails. Normal body
consumption and successful response completion do not abort it. Multipart parsing and buffered body
reads honor that signal too. Expected errors caused by the disconnect are suppressed because no
response remains; independent errors and deadline failures remain recorded.

`setDeadline(timeoutMs)` explicitly bounds the remaining request work, including response workflow
listeners. It accepts a positive integer timer duration in milliseconds from the call. Repeated calls
can shorten the deadline but cannot extend an earlier one. No deadline applies by default. Cancellation
keeps its first reason; a response closing after a deadline does not turn the timeout into a suppressed
disconnect. The router clears the timer and disconnect listeners after awaited response work, then
releases its files. Pass `request.signal` to every process/stream and await all users before returning.
Cancellation alone does not wait for arbitrary work started without awaiting it.

Workspace crash recovery defaults to preservation. Opt into `workspace({ replayable: true })` only when
retained sources allow replay of the whole request workspace. This also updates a directory already
created by multipart parsing. Workspace allocation and deadline configuration are rejected after the
request lifecycle finishes. CLI/background work should use `withTemporaryWorkspace()` or explicitly
owned `temporaryFiles` instead of retaining a completed request's paths.

`getRequestTemporaryWorkspace(request)` and `withRequestTemporaryWorkspace(request, response, fn, options)`
remain compatible functional APIs. The callback helper combines the request signal with its optional
caller signal/deadline; new controllers can use the request methods directly.

## Returning A Temporary File

For operations whose result outlives the creator's callback, transfer explicit ownership:

```ts
import { temporaryFiles } from '@zyno-io/ts-server-foundation';

const path = await temporaryFiles.fromStream(upstream, true, signal);
try {
    await consume(path);
} finally {
    await temporaryFiles.remove(path);
}
```

`create(replayable?)` reserves a single `data` file with mode `0600`; `fromStream()` additionally waits
for a pipeline and removes failed/aborted partial output. The creator owns failures before return;
the caller owns the successfully returned path. `remove()` releases a managed single-file workspace.
For an ordinary explicitly caller-owned path or a member of a multi-file workspace it only unlinks
that path; a filename such as `data` never implies ownership of its siblings. This is never used to infer
ownership during an automatic sweep. `createWorkspace()` similarly transfers a whole workspace until
the caller calls `dispose()`. Keep a potentially sole-copy result until the domain's durable handoff
has succeeded. Generic TSF code does not decide whether an object-store or database commit did that.

## Process Cancellation

`execProcess()` accepts `signal`, `timeoutMs`, and `killGraceMs`. Cancellation sends `SIGTERM` to the
owned direct child, escalates to `SIGKILL` after the grace period (one second by default), and rejects
with `AbortError` only after the process and its stdio have closed. This also applies when `onSpawn`
throws. An already aborted signal prevents spawning. The helper does not manage an arbitrary process
tree; applications starting shell/background descendants must provide their own ownership boundary.

## Automatic Recovery

Every normal API and CLI-service application includes `TemporaryFileCleanupService`. At server
bootstrap and once per minute it scans local temporary storage, independently of distributed worker
election. A standalone `TemporaryFiles` instance can be swept and closed explicitly; the application
service manages the default `temporaryFiles` instance under the operating system's temporary directory.

Each pass examines at most 100 directory entries and removes at most 25 workspaces. One persistent
cursor advances past protected entries; overlapping passes share a promise. Each recovery candidate
contains at most 64 regular, singly linked files. Recovery never follows symlinks, descends into child
directories, or recursively removes an unbounded tree. Explicit scope disposal can release its own
larger/nested output tree; automatic recovery fails closed when that tree cannot be bounded safely.

Only private, same-user `tsf-temp-v1-` directories are considered. Unknown legacy prefixes remain
untouched. A release marker authorizes retry after explicit disposal. Otherwise a workspace must be
at least one hour old, have valid ownership metadata in the same host/boot/PID namespace, and have
an owner proven to have exited. Only replayable or empty workspaces can then be removed. Live owners
remain protected regardless of age. Linux boot ids, PID namespaces, and process start ticks prevent
confusing a reused PID with its original owner. Other platforms conservatively preserve live/reused PIDs.
Platforms without POSIX user-ownership checks support explicit scope disposal but retain automatic
recovery candidates rather than guessing directory ownership.

Metadata contains no tenant identity, provider credentials, URLs, or media. The framework logs aggregate
scanned, removed, retained, and failed counts. Malformed ownership and unavailable process identity
fail closed. Shutdown stops scanning and closes the cursor; it does not dispose active workspaces.
Preserved files intentionally have no automatic expiry. This is bounded cleanup work, not a disk quota.
