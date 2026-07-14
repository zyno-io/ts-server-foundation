# HTTP

`ts-server-foundation` provides a small HTTP router and response layer for controller-based APIs.

## Controllers

Register controllers through `createApp({ controllers: [...] })` and decorate them with the exported `http` helper.

```typescript
import { HttpBody, http } from '@zyno-io/ts-server-foundation';

interface CreateUserBody {
    name: string;
}

@http.controller('/users')
class UserController {
    @http.GET('/:id')
    async getUser(id: number) {
        return { id };
    }

    @http.POST()
    async createUser(body: HttpBody<CreateUserBody>) {
        return { id: 1, ...body };
    }
}
```

Supported route decorators are `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `HEAD`.

Controller and method paths are joined with one `/`; leading, repeated, and final slashes in declarations are normalized. A request may include one trailing slash and still match. `:name` segments match one encoded URL segment, are decoded before injection, and return HTTP `400` when percent encoding is malformed.

Methods match exactly. A `GET` route does not implicitly handle `HEAD`; declare `@http.HEAD()` when the endpoint supports it. Matching also follows declaration and registration order rather than preferring literal paths over parameters, so place `/fixed` before `/:id` when both can match the same request. Controllers exported by imported modules join the same route table and retain module-local DI resolution. If no exact route matches, the router runs `onRouteNotFound` and then returns the normalized `404` response unless a listener has completed the response.

When the app listens outside `APP_ENV=test`, startup output includes the registered HTTP route count, routes grouped by controller, the bound URL, and a final started line. This makes silent server starts easier to diagnose.

## HTTP Runtime

HTTP server operations live on `app.http`, not directly on `App`:

```typescript
const app = createApp({ controllers: [UserController] });

const server = await app.http.listen(0, '127.0.0.1');
const address = server.address();
const port = typeof address === 'object' && address ? address.port : undefined;

const removeObserver = app.http.registerObserver(entry => {
    console.log(entry.request.method, entry.request.url, entry.response.statusCode, entry.durationMs);
});

const removeUpgrade = app.http.registerUpgradeHandler((request, socket, head) => {
    // Claim and handle WebSocket or other HTTP upgrade requests.
});

await app.stop();
removeObserver();
removeUpgrade();
```

`app.http.listen()` starts the app if needed, runs the server bootstrap lifecycle events after the socket binds, installs signal handlers, and starts DevConsole when enabled. If binding or a post-bind bootstrap hook fails, it closes any socket that was opened and rolls back app startup when that listen call initiated it. Application entrypoints should usually call `app.run()` and pass `server:start` on the command line; direct `app.http.listen()` is mainly for tests, demos, embedded servers, and custom process managers.

`app.http.getPort()` resolves an explicit or configured listen port before binding. When `listen(0)` asks the operating system for an ephemeral port, read the actual port from `server.address()` as shown above.

`app.http.request(request, response?)` sends an in-memory `HttpRequest` through the same router/CORS/static-file flow without creating a Node server.

Observers run once after every in-memory or Node request, including CORS, static-file, `404`, and error results. The observation contains `request`, `response`, `startedAt`, `durationMs`, and the processing `error` when one was recorded. An observer exception is isolated from request handling, and the function returned by `registerObserver()` unregisters it.

## Request Order

The request pipeline is:

```text
CORS preflight short circuit
  -> prepare CORS response headers
  -> static GET handling when no registered route matches
  -> onRoute workflow
  -> multipart guard, or raw-stream bypass
  -> controller middleware, then route middleware
  -> onController workflow
  -> controller construction and left-to-right parameter resolution
  -> route handler and response-result handling
  -> onResponse workflow
  -> upload cleanup, even when onResponse fails
  -> final CORS application and response observation
```

An ended response short-circuits later router stages. Multipart guarding happens before middleware so an undeclared or unsafe file cannot be hidden by middleware. `onResponse` runs for successful and failed router requests; upload cleanup runs in its own `finally` after that workflow.

## Request Logging

Node HTTP requests are logged at the server boundary and configured with `HTTP_REQUEST_LOGGING_MODE`:

| Mode     | Behavior                                                  |
| -------- | --------------------------------------------------------- |
| `e2e`    | Logs request start and finish.                            |
| `finish` | Logs only request finish.                                 |
| `errors` | Logs only request processing errors and aborted requests. |
| `none`   | Disables normal request logs.                             |

Test mode defaults to `errors` so service/application logs remain visible without routine HTTP `Request` and `Response` records. Request logs include method, URL, status code, duration, remote address on start, and the active request context. `/healthz` request logging is disabled by default; set `HEALTHZ_ENABLE_REQUEST_LOGGING=true` to include it. `/metrics` is always skipped.

Exclude additional request paths through app options. Strings match exact pathnames (regardless of query strings), while regular expressions support path patterns:

```ts
createApp({
    requestLogging: {
        excludePaths: ['/poll', /^\/internal\//]
    }
});
```

`HttpLogPayloadMiddleware` is an opt-in diagnostic middleware that reads and logs the request body as text along with the method, URL, and content type. Because it can record credentials, tokens, personal data, and large payloads, use it only on deliberately selected routes and with a logger whose destination and retention are appropriate for that data.

### Client Address And Trusted Proxies

`request.remoteAddress` is the transport socket address. `request.getRemoteAddress()` returns that address unless `USE_REAL_IP_HEADER=true`; when proxy headers are trusted it prefers `x-real-ip`, then the first `x-forwarded-for` entry.

```typescript
@http.GET('/whoami')
whoAmI(request: HttpRequest) {
    return { address: request.getRemoteAddress() };
}
```

Enable `USE_REAL_IP_HEADER` only when every path to the application passes through a trusted proxy that removes untrusted forwarding headers. DevConsole and `/metrics` deliberately use the socket address for their local/private access checks and do not trust these headers.

## Parameter Injection

Parameters are explicit by default. The router only auto-infers a parameter when its name matches a URL path parameter.

| Parameter type                            | Source                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `HttpRequest`                             | Current request metadata and guarded body readers.                                       |
| `HttpRequestStream`                       | Raw request stream escape hatch. Bypasses body parsing and guards.                       |
| `HttpResponse`                            | Current response object for imperative writes.                                           |
| `HttpBody<T>`                             | Parsed JSON body or parsed multipart `_payload` object; one per route.                   |
| `HttpQueries<T>`                          | Full query object.                                                                       |
| `HttpQuery<T>`                            | Query value matching the parameter name.                                                 |
| `HttpQuery<T, { name: 'key' }>`           | Query value from an explicit key.                                                        |
| `HttpPath<T>`                             | Path value matching the parameter name.                                                  |
| `HttpPath<T, { name: 'id' }>`             | Path value from an explicit key.                                                         |
| `HttpHeader<T>`                           | Header value matching the parameter name.                                                |
| `HttpHeader<T, { name: 'x-request-id' }>` | Header value from an explicit header name.                                               |
| `FileUpload`                              | Required multipart file matching the parameter name, or the only declared uploaded file. |

Any unannotated non-path parameter fails at startup with an error that asks for an explicit HTTP annotation.
Routes may declare at most one `HttpBody<T>` parameter. Registering a route with multiple body parameters fails at startup instead of assigning one request body to multiple controller arguments.
An omitted optional `query?: HttpQueries<T>` parameter is injected as `undefined`. Once any query value is supplied, the resulting object is deserialized and validated as `T`, including its required properties.

`HttpRequest` normalizes constructed header names to lowercase; Node already supplies lowercased incoming names. An inferred `HttpHeader` lookup checks the parameter name, its lowercase and kebab-case forms, then the `x-`-prefixed kebab form, so `requestId: HttpHeader<string>` can read `x-request-id`. Use `{ name: '...' }` when the wire name should be explicit.

Repeated query keys are stored in order as `string[]`. `HttpQueries<T>` receives that complete shape, while a scalar `HttpQuery<T>` selects the last value for its key.

```typescript
import { HttpBody, HttpHeader, HttpQueries, HttpQuery, HttpRequestStream, http } from '@zyno-io/ts-server-foundation';

interface ListUsersQuery {
    search?: string;
    limit?: number;
}

@http.controller('/users')
class UserController {
    @http.GET()
    async list(query: HttpQueries<ListUsersQuery>) {
        return [];
    }

    @http.GET('/by-email')
    async byEmail(email: HttpQuery<string>) {
        return { email };
    }

    @http.POST()
    async create(body: HttpBody<CreateUserBody>, requestId: HttpHeader<string, { name: 'x-request-id' }>) {
        return { requestId, body };
    }

    @http.POST('/stream')
    async streamUpload(request: HttpRequestStream) {
        for await (const chunk of request) {
            // Stream directly without body parsing.
        }
    }
}
```

### Input Deserialization And Validation

Controller-facing values from `HttpBody<T>`, `HttpQueries<T>`, `HttpQuery<T>`, `HttpPath<T>`, `HttpHeader<T>`, and inferred path parameters are automatically reflected-deserialized and then validated before the controller is invoked.

```text
request bytes or URL strings
  -> JSON/multipart parsing when needed
  -> HTTP normalization
  -> reflected deserialization
  -> reflected validation
  -> final HTTP shape check
  -> controller argument
```

Deserialization includes primitive coercion, nested DTO projection, reflected class construction, `Date` construction, and registered transforms such as trimmed strings and phone normalization. Validation then enforces required and nullable properties, shapes, literals, enums, string and numeric constraints, and custom validators. A nonnumeric string coerces to `NaN`, which is rejected as an invalid `number`. Any failure becomes an HTTP `400` and the controller is not called.

An absent optional parameter bypasses deserialization and validation and is injected as `undefined`. This includes an optional standalone `FileUpload`. A missing required standalone upload produces HTTP `400`. A missing structured `HttpBody<T>` is treated as `{}`, which permits an all-optional body but still reports missing required properties. Undeclared DTO properties are generally dropped during deserialization rather than reported as errors.

`HttpRequest`, `HttpRequestStream`, `HttpResponse`, `ParsedJwt`, direct `FileUpload` parameters, and custom parameter-resolver results do not pass through this reflected pipeline. File uploads instead use the multipart declaration, size, and MIME guards. A file declared as a property inside `HttpBody<T>` is included in that body's reflected traversal after multipart parsing.

Route middleware and the `onController` workflow run before controller parameters are resolved. If either ends the response, parameter deserialization and validation do not run. Multipart parsing and upload guards may run earlier so unsafe file parts are rejected before controller dispatch.

### Custom Parameter Resolvers

Use `http.resolveParameter()` for a controller-specific class parameter. A resolver can be a function, an object with `resolve()`, or a resolver class. Register resolver classes as providers when they need DI.

```typescript
import { createApp, http, type RouteParameterResolverContext } from '@zyno-io/ts-server-foundation';

class ResolvedTenant {
    constructor(readonly id: string) {}
}

class ResolvedTenantResolver {
    resolve(context: RouteParameterResolverContext) {
        return new ResolvedTenant(String(context.parameters.tenantId));
    }
}

@http.resolveParameter(ResolvedTenant, ResolvedTenantResolver)
@http.controller('/tenants/:tenantId')
class TenantController {
    @http.GET()
    get(tenantId: string, tenant: ResolvedTenant) {
        return { tenantId, resolvedId: tenant.id };
    }
}

const app = createApp({
    controllers: [TenantController],
    providers: [ResolvedTenantResolver]
});
```

`RouteParameterResolverContext` includes the request, response, route, parameter name and reflection metadata, query object, and parameters already resolved to the left of the custom parameter. For an app-wide resolver, pass `httpResolvers: { ResolvedTenant: ResolvedTenantResolver }` to `createApp()`.

### Request-Scoped Values

`HttpRequest.store` is available for state that should live for one request. The exported cache helpers support string, symbol, and object keys; `getOrCacheValue()` is useful when middleware, parameter resolvers, and controllers may all need the same asynchronous lookup.

```typescript
import { getOrCacheValue, type HttpRequest } from '@zyno-io/ts-server-foundation';

const CurrentAccountKey = Symbol('current-account');

function getCurrentAccount(request: HttpRequest) {
    return getOrCacheValue(request, CurrentAccountKey, () => loadAccount(request));
}
```

The full helper set is `getCachedValue`, `setCachedValue`, `hasCachedValue`, `clearCachedValue`, and `getOrCacheValue`. Values disappear with the request; this store is not a cross-request cache.

## Bodies And Streams

JSON body parsing happens when a route resolves `HttpBody<T>`. Multipart requests are guarded eagerly on every route except one that opts into raw streaming with `HttpRequestStream`; file parts are rejected unless the route explicitly declares matching `FileUpload` fields.

`HttpRequest.readBodyBuffer()` and `HttpRequest.readBodyText()` decode supported request content encodings, enforce request size limits, and cache the consumed body on `request.body`. They are safe to call more than once; later calls resolve from the cached buffer. For an incoming Node request, `request.body` remains unset until a guarded read consumes it. In-memory requests constructed with a buffer, string, object, or `.multiPart()` set `request.body` immediately.

Guarded reads accept an absent encoding or `identity`, plus `gzip` and `x-gzip`. Gzip is decoded before JSON or multipart parsing. Unsupported encodings return HTTP `415`; corrupt compressed data returns HTTP `400`.

Compressed bytes are limited by `HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES` and decoded or identity bytes by `HTTP_MAX_REQUEST_BODY_BYTES`. A numeric `content-length` above the applicable limit is rejected before streaming, while the byte transforms still enforce the real size when the header is missing, invalid, or too small.

`HttpRequestStream` deliberately bypasses content decoding, both byte limits, `content-length` rejection, JSON/multipart parsing, and upload guards. Routes combining it with `HttpBody<T>` or `FileUpload` fail registration.

In-memory object builders are a convenience boundary, not a wire-parser simulation: `HttpRequest.POST(url, object)` and `.json(object)` prepopulate `parsedBody`, so an `HttpBody<T>` route skips byte decoding and JSON parsing. Use a string or buffer with headers, or a real Node request, when testing encodings, malformed JSON, and byte limits. Both transports otherwise share CORS, static routing, route matching, parameter deserialization, middleware, handler, and observer behavior.

## Multipart Uploads

Multipart parsing uses `busboy` and writes uploaded files into temporary directories. The router cleans those temporary upload directories after the request finishes. File parts whose field name is not declared by a `FileUpload` parameter or `FileUpload` body property are rejected before being written.

```typescript
import { FileUpload, HttpBody, http } from '@zyno-io/ts-server-foundation';

interface UploadPayload {
    title: string;
}

@http.controller('/files')
class FileController {
    @http.POST()
    async upload(payload: HttpBody<UploadPayload>, file: FileUpload<{ maxSize: '40MB'; allowedTypes: ['image/jpeg', 'image/png'] }>) {
        return {
            title: payload.title,
            originalName: file.originalName,
            type: file.type,
            size: file.size
        };
    }
}
```

Multipart field `_payload` is parsed as JSON and merged into the body object. Other text fields are also included. Multiple values for the same field are represented as arrays.

Multipart parsing runs before middleware for every guarded multipart route, including a route that injects only `HttpRequest`. Use `HttpRequestStream` when the controller must consume the raw multipart bytes without parsing or temporary upload files. Temporary upload directories are automatically removed after request handling completes, including error responses.

## Responses

Plain returned values are JSON serialized. `undefined` ends the response; `EmptyResponse` return annotations produce status `204`.

Responses intentionally do not pass through reflected validation, DTO projection, or a reflected serialization registry. TypeScript return types provide the application contract; at runtime the router sends the value produced by the controller through ordinary `JSON.stringify`. `ApiResponse<T, Status>` affects response metadata and status handling, not runtime value validation.

Use response result helpers for explicit writes:

```typescript
import { emptyResponse, jsonResponse, rawResponse, redirectResponse } from '@zyno-io/ts-server-foundation';

return jsonResponse({ ok: true }, 201);
return redirectResponse('/new-path', 302);
return emptyResponse(204);
return rawResponse(Buffer.from('data'), { contentType: 'application/octet-stream' });
```

The package also exports `OkResponse`, `RedirectResponse`, `EmptyResponse`, and `AnyResponse` return-type helpers. OpenAPI-specific response typing is documented in [OpenAPI](./openapi.md).

For imperative responses, `setHeader()` and `getHeader()` are case-insensitive, `headers` exposes comma-joined values, and `rawHeaders` preserves array values. `writeHead()` accepts an object or header tuples and sets the status before data is written. Call `response.write()`/`response.end()` to stream raw output; after a Node response commits, `headersSent` becomes true and later header changes are ignored. The in-memory response buffers writes and does not model header commitment, so `headersSent` remains false there. A handler that starts a Node stream owns ending it.

The router does not serialize another result after a response has ended or Node headers have been sent. Explicit `HEAD` routes run normally but both Node and in-memory transports suppress their response body while retaining status and headers.

## Errors

Throw `HttpError` or one of the exported helpers for intentional HTTP errors. Unhandled routing, middleware, parameter, and controller errors are returned as status `500` with a normalized JSON body.

`onResponse` is the final workflow and runs after router error normalization. If it throws, an in-memory `app.http.request()` rejects after upload cleanup. At the Node boundary, an uncommitted response becomes a generic `500`; a response whose headers were already committed is ended without appending another error body. Final-response listeners should observe and clean up, not throw as a response-control mechanism.

```typescript
import { HttpBadRequestError, HttpNotFoundError } from '@zyno-io/ts-server-foundation';

throw new HttpBadRequestError('Invalid request');
throw new HttpNotFoundError('User not found');
```

Error responses use this shape:

```json
{ "error": "User not found" }
```

## CORS

Pass `cors` to `createApp()` to apply CORS headers to normal responses, error responses, and preflight requests.

```typescript
const app = createApp({
    controllers: [UserController],
    cors: () => ({
        hosts: ['https://app.example.com'],
        credentials: true
    })
});
```

`HttpCorsOptions` supports `hosts`, `paths`, `methods`, `credentials`, `allowHeaders`, and `exposeHeaders`.

## Middleware

Middleware functions and classes can be attached at controller or route level. Use a function for stateless logic or a closure with fixed
configuration. Use a class when the middleware needs dependency injection or an explicit DI scope.

```typescript
import { HttpBadRequestError, HttpMiddleware, HttpMiddlewareFunction, HttpRequest, HttpResponse, http } from '@zyno-io/ts-server-foundation';

const requireHeader: HttpMiddlewareFunction = request => {
    if (!request.headers['x-request-id']) throw new HttpBadRequestError('Missing request id');
};

class RequireHeaderMiddleware implements HttpMiddleware {
    async handle(request: HttpRequest, _response: HttpResponse) {
        if (!request.headers['x-request-id']) throw new HttpBadRequestError('Missing request id');
    }
}

class AuditMiddleware implements HttpMiddleware {
    async handle(request: HttpRequest) {
        request.context.audited = 'true';
    }
}

@(http.controller('/admin').middleware(RequireHeaderMiddleware))
class AdminController {
    @http.middleware(AuditMiddleware)
    @(http.GET().use(requireHeader))
    async index() {
        return { ok: true };
    }
}
```

Use `http.middleware(...)` as a class or method decorator, or chain `.middleware(...)`/`.use(...)` from `http.controller()` and a route decorator. A middleware function receives the same `HttpRequest` and `HttpResponse` arguments as `HttpMiddleware.handle()`. Middleware continues automatically when it returns; there is no `next` callback. Controller middleware always runs before route middleware. Within each group, middleware runs in the stored decorator/list order; when mixing standalone and chained decorators, remember that TypeScript applies stacked decorators from bottom to top.

Returning a response result such as `jsonResponse(...)` writes and ends the response, short-circuiting the remaining middleware, controller workflow, parameter resolution, and handler. Middleware may also end the supplied `HttpResponse` directly.

Middleware functions are invoked directly, so the registered function and its closure are shared by every request and every router using that decorated controller. An unregistered zero-argument middleware class is instantiated once per router. Registered middleware is resolved through DI and follows its provider scope: singleton by default, once per request for `scope: 'request'`, or once per resolution for `scope: 'transient'`. Register middleware with `scope: 'request'` when it injects request-scoped providers or `HttpRequest`; it then shares the controller's request context. Once a middleware class is registered, DI failures are reported rather than falling back to direct construction.

Singleton middleware must not store request-specific state on the function closure or class instance. Store request-local state on `HttpRequest.store`, or register a class with `scope: 'request'` when instance state is required.

## Static Files

Pass `staticFiles` to `createApp()` to serve files after route matching. Static files are only considered for `GET` requests that do not match a registered route.

```typescript
const app = createApp({
    controllers: [ApiController],
    staticFiles: {
        directory: 'static',
        spaFallback: 'index.html'
    }
});
```

`staticFiles: true` uses the default `static/` directory. `directory` defaults to `static`, `index` to `index.html`, and `spaFallback` to the selected index. A custom fallback is served when no concrete file exists. Static handling is GET-only and never shadows a registered route; unsafe decoded paths return `400`.
