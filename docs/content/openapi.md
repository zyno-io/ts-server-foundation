# OpenAPI

OpenAPI generation is built from registered HTTP routes and reflected type metadata. The generator reads the same route parameter plan used by the HTTP router, so explicit controller annotations matter. Generated documents are OpenAPI 3.1 (`openapi: 3.1.0`).

## Document Identity And Operations

`serializeOpenApiSchema()` defaults `info.title` and `info.version` to the cached package metadata first read from `process.cwd()/package.json`, falling back to `API` and `0.0.0`. Call `resetPackageJsonCache()` after changing the working directory, or override either value explicitly:

```ts
const document = serializeOpenApiSchema(app, {
    title: 'Users API',
    version: '2.1.0'
});
```

Every operation receives a tag derived from its controller class name: the `Controller` suffix is removed and the remainder is camel-cased. Set `tags` with [`openapi.operation()`](#operation-metadata) to replace it.

## Controller Parameters

Controller parameters are explicit, except path parameters whose parameter name matches a URL token.

```ts
import { ApiResponse, HttpBody, HttpPath, HttpQueries, HttpQuery, http } from '@zyno-io/ts-server-foundation';

class ListUsersQuery {
    includePosts?: boolean;
    limit!: number;
}

class CreateUserBody {
    name!: string;
}

class UserDto {
    id!: number;
    name!: string;
}

@http.controller('/users')
class UserController {
    @http.GET()
    async list(query: HttpQueries<ListUsersQuery>): Promise<UserDto[]> {
        return [];
    }

    @http.GET('/:id')
    async get(id: HttpPath<number>, search?: HttpQuery<string, { name: 'q' }>): Promise<UserDto> {
        return { id, name: search ?? '' };
    }

    @http.POST()
    async create(body: HttpBody<CreateUserBody>): ApiResponse<UserDto, 201> {
        return { id: 1, name: body.name };
    }
}
```

`HttpQueries<T>` expands class or object properties into query parameters. Required properties of `T` are required query parameters only when the aggregate controller parameter is required. For `query?: HttpQueries<T>`, OpenAPI marks every expanded parameter optional because the whole aggregate may be omitted; at runtime, supplying any query value still validates the resulting object as `T`, including its required properties. `HttpQuery<T>` documents one query parameter. `HttpBody<T>` becomes a JSON request body unless the reflected body contains file uploads. A route may declare only one `HttpBody<T>` parameter; multiple body parameters fail route registration.

A route method's JSDoc supplies the operation `summary`, `description`, parameter descriptions, response description and deprecation; see [Documenting With JSDoc](#documenting-with-jsdoc). A `summary` or `description` set with [`openapi.operation()`](#operation-metadata) replaces the JSDoc value.

Bodies with a required `FileUpload` are documented only as `multipart/form-data`. If every file in the body is optional or nullable, the same schema is exposed for both `application/json` and `multipart/form-data`, allowing requests that omit the files to remain ordinary JSON. A standalone `FileUpload` controller parameter always makes the operation multipart; required and optional standalone parameters are reflected in the multipart schema and request-body requiredness. File constraints are emitted as `x-maxSizeBytes`, `x-allowedTypes`, and multipart encoding content types.

`FileUpload` body properties must be top-level. Nested file properties and arrays of `FileUpload` fail route registration, keeping the generated schema aligned with what the multipart runtime can populate.

## Responses

`ApiResponse<T, Status>` documents and emits a JSON response with the given status. The status defaults to `200`, so `ApiResponse<UserDto>` is equivalent to `ApiResponse<UserDto, 200>`.

Plain `Promise<T>` return types document and emit a `200` JSON response. `OkResponse`, `AnyResponse`, `JsonResponseResult`, `RawResponseResult`, `RedirectResponseResult`, and `EmptyResponseResult` keep their existing OpenAPI behavior.

Use `openapi.response<T>()` when an operation documents additional response types without changing its runtime behavior. Use `openapi.errors<T>()` to add the same error body for several statuses. Decorators on a controller apply to every route; route decorators add to them, and a route response for the same status replaces the controller response.

```ts
import { http, openapi } from '@zyno-io/ts-server-foundation';

class ProblemDetails {
    code!: string;
    message!: string;
}

class UserDto {
    id!: string;
}

@openapi.errors<ProblemDetails>([401, 403])
@http.controller('/users')
class UserController {
    @openapi.response<UserDto>({ status: 201, description: 'Created' })
    @openapi.errors<ProblemDetails>(422)
    @http.POST()
    async create(): Promise<UserDto> {
        return { id: 'user_1' };
    }

    @openapi.ignore()
    @http.GET('/internal')
    async internal(): Promise<UserDto> {
        return { id: 'internal' };
    }
}
```

The decorators use reflected generic metadata and are documentation-only: they neither set response statuses nor alter response bodies at runtime. `openapi.ignore()` can be placed on a route or controller to exclude it from the generated document. Duplicate explicit statuses at the same scope fail early; method metadata deterministically overrides controller metadata for the same status.

### Media Types, Headers, And Examples

`openapi.response<T>()` documents a JSON body by default. Three optional settings describe other kinds of responses:

| Option      | What it does                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `mediaType` | Documents the body under this content type instead of `application/json`.                          |
| `headers`   | Documents response headers. Each entry is a header name with a `schema`.                           |
| `examples`  | Adds named example bodies. Each entry is an example name with a `value` and an optional `summary`. |

This route sends a CSV download and documents it. The handler writes the CSV itself through `HttpResponse` and returns `Promise<void>`, so TSF does not serialize a JSON body. The body type in the document is still `T`, so `response<string>` produces a `string` schema under `text/csv`:

```ts
import { HttpResponse, http, openapi } from '@zyno-io/ts-server-foundation';

@http.controller('/contacts')
class ContactExportController {
    @openapi.response<string>({
        status: 200,
        description: 'Contacts as CSV',
        mediaType: 'text/csv',
        headers: {
            'Content-Disposition': { schema: { type: 'string' } }
        },
        examples: {
            oneContact: {
                summary: 'Header row and one contact',
                value: 'name\nRiver'
            }
        }
    })
    @http.GET('/export')
    async export(response: HttpResponse): Promise<void> {
        response.writeHead(200, {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="contacts.csv"'
        });
        response.end('name\nRiver');
    }
}
```

The `response<string>` annotation describes the body that the handler writes. It does not make TSF stream anything or change what the route sends; the `writeHead()` and `end()` calls do that. Because the annotation is for status `200`, it replaces the bodiless `200` response that TSF would otherwise infer from `Promise<void>`.

The generated response is:

```yaml
responses:
    '200':
        description: Contacts as CSV
        headers:
            Content-Disposition:
                schema:
                    type: string
        content:
            text/csv:
                schema:
                    type: string
                examples:
                    oneContact:
                        summary: Header row and one contact
                        value: "name\nRiver"
```

These options change the generated document only. They do not set the status, the `Content-Type` header, any other header, or the body that the route sends; the handler is still responsible for sending what the document describes. The rules for `openapi.response<T>()`, `openapi.errors<T>()`, and `openapi.ignore()` described above are unchanged, and `openapi.errors<T>()` does not accept these options.

`mediaType` and `examples` describe a body, so they need a body type. If `T` is `void` or `undefined`, setting either one fails document generation with `OpenAPI response mediaType/examples require a response body type`. `headers` is still allowed on a response with no body.

Object unions gain a native OpenAPI discriminator when TSF can prove one: every branch must have one qualifying common required property whose string literal values do not overlap. This deliberately does not infer discriminators from nullable unions, broad `string` properties, overlapping values, or unions with more than one possible tag property.

An operation with a required `ParsedJwt` parameter receives `security: [{ bearerAuth: [] }]`, and the document gains an HTTP bearer security scheme with JWT format. An optional `ParsedJwt` does not mark the operation as requiring bearer authentication. Runtime authentication may also read the configured JWT cookie, but the generated document currently advertises only the Bearer mechanism. A `security` value set with [`openapi.operation()`](#operation-metadata) can add to this requirement but cannot remove it; see [Security](#security).

## Operation Metadata

`openapi.operation()` sets the details of an operation that TSF cannot work out from your code, or that you want to pin down yourself. Every option is optional:

| Option            | What it does                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId`     | A fixed name for the operation. Generated clients usually turn it into a function name. Methods only. [Same-verb path aliases](#same-verb-path-aliases) add a suffix. |
| `tags`            | Group names for the operation. Replaces the tag derived from the controller class name.                                                                               |
| `summary`         | A short title. Replaces the first paragraph of the method's JSDoc.                                                                                                    |
| `description`     | Longer explanatory text. Replaces the rest of the method's JSDoc, including any `**Deprecated:**` note added from `@deprecated`.                                      |
| `deprecated`      | `true` marks the operation as deprecated. A JSDoc `@deprecated` tag does this too.                                                                                    |
| `security`        | The credentials a caller must send, as a list of security scheme names. `[]` means none are needed. It cannot drop the bearer requirement of a required `ParsedJwt`.  |
| `securitySchemes` | Definitions for the scheme names used in `security`. They are added to `components.securitySchemes`.                                                                  |
| `extensions`      | Custom `x-` fields copied onto the operation, for example for a client generator.                                                                                     |

Anything you leave out keeps its usual value: the operation ID and tag are derived from the controller and method names, the summary and description come from the method's JSDoc, and a required `ParsedJwt` parameter adds the bearer requirement.

An option set to `undefined` counts as left out. `openapi.operation({ summary: undefined })` keeps the JSDoc summary, and an `undefined` field on a method keeps the controller's value for that field. This makes it safe to pass values that are only sometimes present.

### Controller Defaults And Method Overrides

Put `openapi.operation()` on a controller to set defaults for every route in it. Put it on a method to override those defaults for one route.

- A field set on the method replaces the controller's value for that field entirely. `tags` and `security` lists are replaced, not combined.
- `extensions` are combined. If both set the same `x-` key, the method wins.
- Layering order, later replacing earlier: inferred values (types and JSDoc), then [contributors](#contributors) in registration order, then the controller's `openapi.operation()`, then the method's.
- `operationId` is allowed only on a method, because every operation needs its own ID.
- Each controller or method accepts one `openapi.operation()` decorator.

### Example: Header Authentication From Custom Middleware

In this example the application checks two request headers in its own middleware. TSF cannot see that from the route signature, so the controller describes it with `security` and `securitySchemes`. One route is public and overrides the default with `security: []`.

```ts
import { HttpMiddlewareFunction, HttpUnauthorizedError, http, openapi } from '@zyno-io/ts-server-foundation';

class ContactDto {
    id!: string;
    name!: string;
}

// Your own runtime check. This is what actually protects the routes.
const requireApiKey: HttpMiddlewareFunction = request => {
    if (!request.headers['x-tenant-id'] || request.headers['x-api-key'] !== process.env.API_KEY) {
        throw new HttpUnauthorizedError('Invalid API key');
    }
};

@openapi.operation({
    tags: ['contacts'],
    // Callers must send both headers.
    security: [{ apiKey: [], tenantId: [] }],
    securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        tenantId: { type: 'apiKey', in: 'header', name: 'X-Tenant-Id' }
    }
})
@http.controller('/contacts')
class ContactController {
    @openapi.operation({
        operationId: 'listContacts',
        summary: 'List contacts',
        description: 'Returns every contact that belongs to the tenant named in the `X-Tenant-Id` header.',
        extensions: { 'x-sdk-audience': 'integration' }
    })
    @(http.GET().use(requireApiKey))
    async list(): Promise<ContactDto[]> {
        return [];
    }

    @openapi.operation({ operationId: 'findContacts', deprecated: true })
    @(http.GET('/find').use(requireApiKey))
    async find(): Promise<ContactDto[]> {
        return [];
    }

    /** Check that the contacts service is reachable. */
    @openapi.operation({ operationId: 'getContactsStatus', security: [] })
    @http.GET('/status')
    async status(): Promise<{ ok: boolean }> {
        return { ok: true };
    }
}
```

The generated document contains:

```yaml
paths:
    /contacts:
        get:
            operationId: listContacts
            tags: [contacts]
            summary: List contacts
            description: Returns every contact that belongs to the tenant named in the `X-Tenant-Id` header.
            security:
                - apiKey: []
                  tenantId: []
            x-sdk-audience: integration
    /contacts/find:
        get:
            operationId: findContacts
            tags: [contacts]
            deprecated: true
            security:
                - apiKey: []
                  tenantId: []
    /contacts/status:
        get:
            operationId: getContactsStatus
            tags: [contacts]
            summary: Check that the contacts service is reachable.
            security: []
components:
    securitySchemes:
        apiKey: { type: apiKey, in: header, name: X-Api-Key }
        tenantId: { type: apiKey, in: header, name: X-Tenant-Id }
```

(Responses and schemas are omitted here for brevity.)

### Security

`security` is a list of acceptable ways to authenticate. Each item is an object whose keys are scheme names. All the schemes in one object are required together; separate objects are alternatives. The array after each name lists required scopes and is usually empty.

- `security: [{ apiKey: [], tenantId: [] }]` means both are required.
- `security: [{ apiKey: [] }, { bearerAuth: [] }]` means either one is enough.
- `security: []` means no credentials are needed. Use it to mark a public route inside a controller that has a default.

An explicit `security` value replaces the controller default for that route.

#### Routes With A Required `ParsedJwt`

A route with a required `ParsedJwt` parameter always needs the JWT at runtime, so the document is not allowed to say otherwise. On such a route, every alternative in `security` must include `bearerAuth`:

- `security: [{ bearerAuth: [], tenantId: [] }]` is fine. It adds a second requirement alongside the JWT.
- `security: [{ apiKey: [] }, { bearerAuth: [] }]` fails, because the first alternative lets a caller skip the JWT.
- `security: []` fails, because it claims the route is public.

A failure stops document generation with `OpenAPI security metadata cannot remove required ParsedJwt authentication`. The rule applies to the value the route ends up with, so a controller-level `security` default without `bearerAuth` also fails for any route in that controller that takes a required `ParsedJwt`. Give that route its own `security` that includes `bearerAuth`.

Routes without a required `ParsedJwt`, including routes where it is optional, are not restricted. `security: []` remains the way to mark them public.

#### Scheme Definitions

Every scheme name used in `security` must be defined in `securitySchemes` somewhere in the document. A definition on any controller or method covers the whole document, so you can define a scheme once and reuse its name elsewhere. Definitions are read only from routes that end up in the document, so a scheme declared only on an ignored route is not emitted.

`bearerAuth` is the one exception. The name is reserved for TSF's built-in JWT Bearer scheme (`type: http`, `scheme: bearer`, `bearerFormat: JWT`), which TSF adds whenever an operation uses it. You do not need to define it, and you cannot redefine it: a different `bearerAuth` definition fails document generation. Pick another name for your own scheme.

::: warning
`openapi.operation()` only describes your API. It does not check headers, tokens, or permissions, and it does not reject any request. Protect routes with middleware, `ParsedJwt`, or your own checks, and keep the documented `security` in line with what that code enforces.
:::

### Checks

TSF rejects metadata that would produce a broken or ambiguous document.

These fail as soon as the decorator runs, when the controller file is loaded:

- An empty or blank `operationId`.
- An `operationId` on a controller.
- An `extensions` key that does not start with `x-`.
- A second `openapi.operation()` on the same controller or method.

These fail when the document is generated, which includes `serializeOpenApiSchema()`, the `/openapi.*` routes, and `openapi:generate`:

| Error                                                                       | Cause                                                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Duplicate OpenAPI operationId <id>`                                        | Two operations end up with the same ID, whether explicit or derived. [Same-verb aliases](#same-verb-path-aliases) of one handler are exempt. |
| `Duplicate OpenAPI route <method> <path>`                                   | Two routes have the same HTTP method and path.                                                                                               |
| `Conflicting OpenAPI security scheme <name>`                                | The same scheme name is defined twice with different definitions.                                                                            |
| `Conflicting OpenAPI security scheme bearerAuth; this name is reserved…`    | An operation uses `bearerAuth` and a `bearerAuth` definition differs from the built-in JWT Bearer scheme.                                    |
| `Undefined OpenAPI security scheme <name>`                                  | `security` uses a scheme name that has no definition.                                                                                        |
| `OpenAPI security metadata cannot remove required ParsedJwt authentication` | A route with a required `ParsedJwt` has `security` that is empty or has an alternative without `bearerAuth`.                                 |
| `OpenAPI response mediaType/examples require a response body type`          | `openapi.response<T>()` sets `mediaType` or `examples` while `T` is `void` or `undefined`.                                                   |

Defining the same scheme more than once with identical contents is fine.

## Documenting With JSDoc

TSF's metadata compiler reads JSDoc and the generator turns it into OpenAPI text. Descriptions are Markdown; line breaks, lists and code fences in them are preserved.

### Route Methods

| JSDoc                | OpenAPI                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| First paragraph      | `summary`. Its lines are joined with spaces.                                                                                          |
| Remaining paragraphs | `description`, with paragraph breaks, lists and code fences intact.                                                                   |
| `@param name text`   | `description` of a path, query or header parameter. Text may span lines. Group parameters are ignored; see [Parameters](#parameters). |
| `@returns text`      | `description` of the default success response, replacing `OK` or the status reason phrase. `@return` works too.                       |
| `@deprecated [text]` | `deprecated: true`. A non-empty text is also appended to the description as `**Deprecated:** text`.                                   |
| `@sunset YYYY-MM-DD` | The extension `x-sunset: YYYY-MM-DD`.                                                                                                 |

Unknown tags are ignored, and a line starting with `@` inside a code fence is treated as code. `@param` names are the handler's TypeScript parameter names. A wire name given with `HttpQuery<T, { name }>` matches only when no parameter has that TypeScript name. A response documented with `openapi.response<T>()` keeps its own description.

```ts
/**
 * Fetch a widget.
 *
 * Looks the widget up by id.
 *
 * - Archived widgets are returned too.
 *
 * @param id The widget id.
 * @param verbose Include usage history.
 * @returns The widget, if it exists.
 * @deprecated Use `GET /gadgets/:id`.
 * @sunset 2027-03-01
 */
@http.PATCH('/:id')
async update(id: HttpPath<string>, verbose?: HttpQuery<boolean>, body?: HttpBody<WidgetPatch>): Promise<Widget> {}
```

produces (`operationId` and `tags` omitted):

```yaml
responses:
    '200':
        description: The widget, if it exists.
        content:
            application/json:
                schema:
                    $ref: '#/components/schemas/Widget'
summary: Fetch a widget.
description: |-
    Looks the widget up by id.

    - Archived widgets are returned too.

    **Deprecated:** Use `GET /gadgets/:id`.
deprecated: true
x-sunset: 2027-03-01
parameters:
    - name: id
      in: path
      required: true
      schema:
          type: string
      description: The widget id.
    - name: verbose
      in: query
      required: false
      schema:
          type: boolean
      description: Include usage history.
requestBody:
    required: false
    content:
        application/json:
            schema:
                $ref: '#/components/schemas/WidgetPatch'
```

The body has no `@param`: the request body is documented through the members of `WidgetPatch`, as described below.

### Parameters

Docs apply to single-value parameters only: `HttpPath<T>`, `HttpQuery<T>` and `HttpHeader<T>`. A JSDoc comment written directly on such a parameter also documents it. `@param` text wins when both exist. A `@deprecated` tag there marks the parameter `deprecated: true` and appends the `**Deprecated:**` note to its description.

```ts
async list(
    /** Search text. */
    q?: HttpQuery<string>,
    /** @deprecated Use `q`. */
    search?: HttpQuery<string>
): Promise<Widget[]> {}
```

Group parameters, `HttpBody<T>` and `HttpQueries<T>`, take no docs of their own. A `@param` tag or JSDoc comment on one is ignored, and TSF logs a [route warning](#route-warnings) for it. Document the members of `T` instead:

- `requestBody` has no `description`. The JSDoc of each member of `T` describes that property of the body schema.
- Each query parameter expanded from `HttpQueries<T>` takes the JSDoc of the matching member of `T`, including its `@deprecated` and `@sunset`.

### Properties And Types

JSDoc on class properties, interface members and members of object types becomes the `description` of that property in the schema. Object types include type aliases such as `type Widget = { ... }` and inline object literals anywhere in a handler signature, for example `HttpBody<{ ... }>`, `HttpQueries<{ ... }>`, `Promise<{ ... }>`, `Promise<Array<{ ... }>>` and `Promise<{ ... }[]>`. `@deprecated` sets `deprecated: true` and `x-sunset` carries `@sunset`, as for operations. JSDoc on a class, interface or type alias becomes the `description` of its component schema.

```ts
interface Widget {
    /** Stable identifier. */
    id: string;
    /**
     * Old display name.
     * @deprecated Use `title`.
     * @sunset 2027-06-30
     */
    name: string;
}
```

When a property's schema is a reference to a component, `description`, `deprecated` and `x-sunset` are written next to `$ref` (OpenAPI 3.1 allows this); the reference is not wrapped in `allOf`:

```yaml
previous:
    $ref: '#/components/schemas/Widget'
    description: |-
        The widget before the edit.

        **Deprecated:** Embed it instead.
    deprecated: true
```

::: warning Limitation
Put a member's JSDoc on its own line. TypeScript does not attach a JSDoc comment that follows another token on the same line, so `{ /** Not read. */ id: string }` documents nothing. This applies to interfaces and classes as well as object literals.

```ts
async create(
    body: HttpBody<{
        /** Read: the comment starts its own line. */
        title: string;
    }>
): Promise<void> {}
```

:::

### Controllers And Tags

The JSDoc of a controller class becomes the description of the controller's derived tag in the document-level `tags` array (`tags: [{ name: 'widgets', description: '...' }]`). Controllers without JSDoc add no entry, and tags replaced with `openapi.operation({ tags })` are not described.

## Deprecation Output

| Source                  | Operation                                                  | Parameter              | Schema property        |
| ----------------------- | ---------------------------------------------------------- | ---------------------- | ---------------------- |
| `@deprecated`           | `deprecated: true`                                         | `deprecated: true`     | `deprecated: true`     |
| `@deprecated Some text` | Also `**Deprecated:** Some text` appended to `description` | Same                   | Same                   |
| `@sunset 2027-01-01`    | `x-sunset: 2027-01-01`                                     | `x-sunset: 2027-01-01` | `x-sunset: 2027-01-01` |

`@sunset` is emitted whether or not `@deprecated` is present; pair them so the item is also marked deprecated. A value that is not `YYYY-MM-DD` is ignored.

## Contributors

A contributor lets a library, or your application, add operation metadata and enforce rules for every route without decorating each controller. Register contributors when creating the app:

```ts
import { createApp, type OpenApiContributor } from '@zyno-io/ts-server-foundation';

const requireOperationIds: OpenApiContributor = {
    name: 'require-operation-ids',
    operation: ({ route }) => ({
        security: route.path.startsWith('/admin') ? [{ adminKey: [] }] : undefined,
        securitySchemes: { adminKey: { type: 'apiKey', in: 'header', name: 'X-Admin-Key' } },
        extensions: { 'x-owner': 'platform' },
        appendDescription: ['Rate limited to 60 requests per minute.']
    }),
    validateOperation: ({ route, operation, explicitOperationId }) => {
        if (!explicitOperationId) throw new Error(`${route.method} ${route.path} needs an explicit operationId`);
    },
    document: (document, routes) => {
        if (!Object.keys(document.paths).length) throw new Error(`No documented routes out of ${routes.length}`);
    }
};

const app = createApp({ controllers, openapi: { contributors: [requireOperationIds] } });
```

`serializeOpenApiSchema(app, { contributors })` replaces the registered list for that call.

| Hook                | When it runs                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation(ctx)`    | For each documented route, after inference and before `openapi.operation()`. Receives the `route`, a copy of the `inferred` operation and the `defaultOperationId`. May return `openapi.operation()` options (without `operationId`) and `appendDescription`. |
| `validateOperation` | On each final operation, for every contributor. Receives `route`, `operation`, `explicitOperationId` (set through `openapi.operation()`, if any) and `defaultOperationId`. Throw to fail generation.                                                          |
| `document`          | Once, with the finished document and every registered route, including `openapi.ignore()`d and [TSF infrastructure](#tsf-infrastructure-routes) routes. Throw to fail generation.                                                                             |

Layering, later replacing earlier: inferred values including JSDoc, contributors in order, the controller's `openapi.operation()`, the method's `openapi.operation()`. A returned field replaces the earlier value, `extensions` merge, and `securitySchemes` merge with the usual [conflict check](#scheme-definitions). After layering, each contributor's `appendDescription` paragraphs are appended to the final description, joined by blank lines, including after an `openapi.operation({ description })` override. The operation ID algorithm, the one-`openapi.operation()`-per-target rule and the required-`ParsedJwt` `bearerAuth` rule are unchanged, and contributors cannot bypass them.

## Operation IDs

Without an explicit `operationId`, operation IDs are camel-cased from the lowercase HTTP method, the controller class name without its `Controller` suffix, and the handler method name. Keep all three stable when generated clients depend on operation IDs, or set `operationId` with [`openapi.operation()`](#operation-metadata) so that renaming a class or method does not change the ID. An explicit ID is used exactly as written, unless the handler has [same-verb path aliases](#same-verb-path-aliases).

### Same-Verb Path Aliases

One handler can be registered on several paths with the same HTTP method. Each path is a separate OpenAPI operation, and all of them would otherwise share one ID. TSF appends a suffix to every one of those operations:

```text
<operationId>_<first 12 hex characters of SHA-256(path)>
```

The hash input is the path as it appears in the document, with `{name}` parameters, for example `/contacts/{id}`.

- The suffix is added to explicit and derived IDs alike. An explicit `operationId` on an aliased handler is a prefix, not the final ID.
- Every alias gets a suffix, including the first one registered. No path keeps the bare ID.
- A suffix depends only on its own path, so it does not change with registration order or with the other aliases.
- A handler with one path per HTTP method keeps its ID unchanged. That includes a handler registered under different methods, such as `GET` and `POST`, with one path each.
- Only routes that appear in the document are counted. A handler with one public path and one [infrastructure](#tsf-infrastructure-routes) path is not aliased unless `includeInternal` is set.

```yaml
paths:
    /contacts:
        get:
            operationId: listContacts_<hash of /contacts>
    /people:
        get:
            operationId: listContacts_<hash of /people>
```

Adding or removing an alias can change that handler's IDs:

| Change                                   | Effect on the handler's operation IDs                 |
| ---------------------------------------- | ----------------------------------------------------- |
| Second same-verb path added              | The original path's ID gains a suffix.                |
| Alias removed, one path left             | The remaining path's ID loses its suffix.             |
| Alias added or removed, two or more left | The other aliases keep their IDs.                     |
| Alias path changed                       | That alias gets a new suffix. The others keep theirs. |

Treat the first two as breaking changes for generated clients. Other handlers are unaffected.

Suffixes only separate the aliases of one handler. Two different handlers that end up with the same ID are still rejected with `Duplicate OpenAPI operationId <id>`; see [Checks](#checks).

## TSF Infrastructure Routes

Generated documents exclude TSF infrastructure routes (health, openapi, metrics, devconsole) by default:

- `/openapi.json`
- `/openapi.yaml`
- `/_devconsole`
- `/healthz`
- `/readyz`
- `/livez`
- `/metrics`

Call `serializeOpenApiSchema(app, { includeInternal: true })` if a tool needs these routes in the document. Application routes are never treated as internal; hide them with `openapi.ignore()`.

## Runtime Routes

In development and test mode, the app serves:

- `/openapi.json`
- `/openapi.yaml`

Route exposure follows this precedence:

| Configuration                               | Result                                              |
| ------------------------------------------- | --------------------------------------------------- |
| `ENABLE_OPENAPI_ROUTE=1`                    | Routes enabled in every environment.                |
| `ENABLE_OPENAPI_ROUTE=0`                    | Routes disabled in every environment.               |
| Route flag unset, `ENABLE_OPENAPI_SCHEMA=1` | Legacy fallback enables routes.                     |
| Route flag unset, `ENABLE_OPENAPI_SCHEMA=0` | Legacy fallback disables routes.                    |
| Both unset                                  | Enabled in development/test and disabled elsewhere. |

The explicit route flag always wins when it conflicts with the legacy schema flag. Both `/openapi.json` and `/openapi.yaml` use the same decision.

## Route Warnings

TSF checks the routes that go into the document and reports:

| Warning                                                                  | Cause                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No return type declared for <METHOD> <path> (<Controller> -> <method>)` | The handler has no return type annotation, or returns `any`, `unknown`, `Promise<any>` or `Promise<unknown>`, and has no `openapi.response<T>()`. TSF does not infer return types, so the response schema is empty. A named alias such as `AnyResponse` counts as declared. |
| `@param <name> on <route> is ignored: group parameters …`                | A `@param` tag names an `HttpBody` or `HttpQueries` parameter.                                                                                                                                                                                                              |
| `JSDoc on parameter <name> on <route> is ignored: group parameters …`    | A JSDoc comment is written directly on an `HttpBody` or `HttpQueries` parameter.                                                                                                                                                                                            |
| `@param <name> on <route> matches no parameter`                          | A `@param` tag names no handler parameter and no path parameter.                                                                                                                                                                                                            |

TSF infrastructure routes and `openapi.ignore()`d routes are skipped. The warnings never fail generation:

- In development, outside a Node test process (`NODE_TEST_CONTEXT`) and outside CLI service and REPL mode, TSF logs each warning on the `app` logger 250 ms after startup. This happens whether or not the [startup dump](#startup-yaml-dump) is enabled.
- `openapi:generate` prints each one to stderr, prefixed with `Warning:`, before writing the file.

`collectOpenApiRouteWarnings(app)` returns the same messages as strings, for a test or CI check:

```ts
import { collectOpenApiRouteWarnings } from '@zyno-io/ts-server-foundation';

assert.deepEqual(collectOpenApiRouteWarnings(app), []);
```

## Startup YAML Dump

In development, TSF writes `openapi.yaml` to the current working directory after startup unless `NODE_TEST_CONTEXT` identifies a Node test process. Test and production environments do not dump by default.

`ENABLE_OPENAPI_SCHEMA=1` explicitly enables the dump in any environment, including a Node test context; `ENABLE_OPENAPI_SCHEMA=0` explicitly suppresses it. This flag directly controls writing the file and acts as the legacy route-exposure fallback only when `ENABLE_OPENAPI_ROUTE` is unset.

## Explicit Generation

Generate the schema without starting a long-running server:

```bash
tsf-dev openapi:generate
tsf-dev openapi:generate -p tsconfig.json
```

The command builds the project and runs its package `main` as `node . openapi:generate`. The built-in `App.run()` command writes `openapi.yaml` in the project working directory without starting a long-running server. It uses the same registered route graph as the application; no separate app-module or export selection is needed.

Programmatic generation is also available:

```ts
import { dumpOpenApiSchema, serializeOpenApiSchema, serializeOpenApiYaml } from '@zyno-io/ts-server-foundation';

const document = serializeOpenApiSchema(app, { includeInternal: false });
const yaml = serializeOpenApiYaml(app);
await dumpOpenApiSchema(app, { path: 'openapi.yaml' });
```
