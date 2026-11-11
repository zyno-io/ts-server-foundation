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

TSF stores multipart uploads in a managed request workspace. `getRequestTemporaryWorkspace(request)`
returns that same workspace, including for a request without multipart data. The router disposes it
after the controller and response workflow settle. Derived and partial files alongside upload paths
are included automatically; neither successful nor failed handlers need to enumerate those files.

Use the request helper when response disconnects or deadlines must cancel work:

```ts
import { execProcess, FileUpload, http, HttpBody, HttpRequest, HttpResponse, withRequestTemporaryWorkspace } from '@zyno-io/ts-server-foundation';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

@http.controller()
class ConversionController {
    @http.POST('/convert')
    async convert(body: HttpBody<{ file: FileUpload }>, request: HttpRequest, response: HttpResponse): Promise<void> {
        await withRequestTemporaryWorkspace(
            request,
            response,
            async (workspace, signal) => {
                const output = workspace.path('result.mp3');
                await execProcess('ffmpeg', ['-i', body.file.path, output], { signal });
                response.setHeader('content-type', 'audio/mpeg');
                await pipeline(createReadStream(output), response, { signal });
            },
            { replayable: true, timeoutMs: 120_000 }
        );
    }
}
```

The helper shares the router-owned directory rather than disposing multipart inputs early. It aborts
its signal on an unfinished response closing or failing, and optionally combines a deadline or caller
signal. Expected abort errors from a client disconnect are suppressed because no response remains;
independent failures and deadlines still propagate. Pass the signal to every process and stream, and
await their completion. Simply racing a promise against cancellation cannot safely stop its writers.

No timeout is imposed unless `timeoutMs` is provided. Recovery remains conservative unless the app
explicitly opts into `replayable`; ordinary multipart uploads preserve crash leftovers by default.

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
For an ordinary explicitly caller-owned path it only unlinks that path; this is never used to infer
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
