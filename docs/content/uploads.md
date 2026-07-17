# Uploads

Multipart upload parsing is integrated with the HTTP parameter resolver. File parts are accepted only when a route explicitly declares matching `FileUpload` fields through a `FileUpload` parameter or a `FileUpload` property in `HttpBody<T>`.

## File Parameters

```ts
import { FileUpload, http, HttpBody } from '@zyno-io/ts-server-foundation';

interface UploadBody {
    description?: string;
}

@http.controller('/files')
class FilesController {
    @http.POST()
    async upload(body: HttpBody<UploadBody>, file: FileUpload<{ maxSize: '40MB'; allowedTypes: 'image/*' }>) {
        return {
            description: body.description,
            name: file.originalName,
            path: file.path,
            size: file.size,
            type: file.type,
            detectedType: file.detectedType
        };
    }
}
```

A standalone `FileUpload` parameter is required unless the controller parameter is optional. If the named file is absent, a required parameter returns HTTP `400`; an optional parameter receives `undefined`. This applies to non-multipart requests and multipart requests containing only text fields. A multipart file under an undeclared field name is rejected with HTTP `400`, even when the declared upload parameter is optional.

`FileUpload<Options>` supports:

| Option         | Description                                                               |
| -------------- | ------------------------------------------------------------------------- |
| `maxSize`      | Per-file byte limit as a number or string such as `'40MB'`.               |
| `allowedTypes` | MIME type or list of MIME types. Exact matches, `type/*`, and `*/*` work. |

The multipart part `Content-Type` must match `allowedTypes` before the file is written. When `allowedTypes` is set, the framework also buffers a signature sample, asks `file-type` to detect the format, and requires the detected MIME type to match. Both checks honor wildcards. Detection is still mandatory for `*/*`: an empty, text-only, truncated, or otherwise undetectable signature is rejected. Use allowed types that `file-type` can recognize, and do not treat detection as malware scanning or complete content validation.

`FileUpload` fields:

| Field               | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `path`              | Temporary file path on disk.                                         |
| `size`              | Uploaded byte count.                                                 |
| `type`              | MIME type from the multipart part, or `application/octet-stream`.    |
| `declaredType`      | Same declared MIME type from the multipart part.                     |
| `detectedType`      | MIME type detected by `file-type` when `allowedTypes` is set.        |
| `detectedExtension` | Extension detected by `file-type` when `allowedTypes` is set.        |
| `originalName`      | Original client filename. A sanitized copy is used in the temp path. |
| `name`              | Alias for `originalName`.                                            |

## Multipart Body Fields

Regular multipart text fields are expanded with the same bracket notation as URL-encoded bodies. A field named `_payload` is parsed as JSON and structurally merged into the body object.

```text
_payload={"description":"Profile photo"}
metadata[category]=avatar
file=<binary>
```

`[property]` traverses an object, `[0]` addresses an array index, and terminal `[]` appends an array value. If multiple text fields use the same exact name, the parsed body stores them in order as an array; declare the corresponding DTO property as an array. `_payload` and text fields may contribute disjoint properties to the same object, but duplicate values and incompatible structures are rejected instead of overwriting one another.

Duplicate files are arrays in `request.uploadedFiles` and the raw parsed body. A standalone `FileUpload` parameter selects the first file under its name. If its named field is absent, it falls back only when exactly one file exists across the route's other declared upload fields.

Typed multi-file body properties are not supported: `file: FileUpload` expects one file and rejects the duplicate-file array. Use `HttpRequest.uploadedFiles` when an endpoint intentionally accepts repeated files, and apply application-level checks to the array.

A body DTO can declare file fields directly:

```ts
class AttachmentBody {
    title!: string;
    attachment?: FileUpload<{ maxSize: '2MB'; allowedTypes: 'application/pdf' }>;
}

@http.controller('/attachments')
class AttachmentController {
    @http.POST()
    upload(body: HttpBody<AttachmentBody>) {
        return { title: body.title, fileName: body.attachment?.originalName };
    }
}
```

For OpenAPI, a required body file makes the request multipart-only. When all body files are optional or nullable, the operation advertises both JSON (for requests without files) and multipart content.

File parts and `FileUpload` body properties must be top-level. File part names cannot use bracket notation, and a nested `nested.file: FileUpload` or `FileUpload[]` body declaration fails route registration.

## Cleanup

Uploaded files are written to a temporary directory created with the `tsf-upload-` prefix. The `onResponse` workflow runs while uploaded files still exist. Immediately afterward, the HTTP router removes every upload directory in a cleanup `finally`, including form/multipart parse failures, MIME and size rejections, controller errors, and failures thrown by `onResponse` listeners.

`FileUpload.path` is request-scoped. Do not store it for later background work without copying the file before the controller returns. By the time `app.http.request()` resolves—or rejects because the final response workflow failed—the temporary path has been removed.

## Raw Streaming

Use `HttpRequestStream` for endpoints that intentionally accept a raw body stream and bypass body guards.

```ts
import { http, HttpRequestStream } from '@zyno-io/ts-server-foundation';

@http.controller('/raw')
class RawController {
    @http.POST()
    async upload(request: HttpRequestStream) {
        for await (const chunk of request) {
            await writeChunk(chunk);
        }
        return { ok: true };
    }
}
```

Do not combine `HttpRequestStream` with `HttpBody<T>` or `FileUpload` on the same route; route registration rejects that combination. Raw streaming also bypasses MIME policies, multipart declaration checks, content decoding, `content-length` checks, and request byte limits, so the handler must enforce every appropriate limit itself.

## Cached Body Reads

`HttpRequest.readBodyBuffer()`, `readBodyText()`, and `readBody()` read the request body and cache the buffer on `request.body`.

```ts
const first = await request.readBodyBuffer();
const second = await request.readBodyBuffer();

first === second; // true
request.body === first; // true
```

Cached reads are reusable. If the request stream is already being consumed through `request.stream`, body-buffer reads throw because the stream cannot be consumed twice.

## Testing Multipart Requests

`HttpRequest` can build multipart bodies for tests.

```ts
const request = HttpRequest.POST('/files').multiPart([
    { name: '_payload', value: JSON.stringify({ description: 'Avatar' }) },
    {
        name: 'file',
        file: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
        fileName: 'avatar.png',
        contentType: 'image/png'
    }
]);
```

This uses the same parser path as a real multipart request.
