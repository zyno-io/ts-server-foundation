# OpenAPI

OpenAPI generation is built from registered HTTP routes and reflected type metadata. The generator reads the same route parameter plan used by the HTTP router, so explicit controller annotations matter.

## Document Identity And Operations

`serializeOpenApiSchema()` defaults `info.title` and `info.version` to the cached package metadata first read from `process.cwd()/package.json`, falling back to `API` and `0.0.0`. Call `resetPackageJsonCache()` after changing the working directory, or override either value explicitly:

```ts
const document = serializeOpenApiSchema(app, {
    title: 'Users API',
    version: '2.1.0'
});
```

Every operation receives a tag derived from its controller class name: the `Controller` suffix is removed and the remainder is camel-cased.

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

The first paragraph of a route method's JSDoc becomes the OpenAPI operation `summary`. Later paragraphs and JSDoc tags are not included.

Bodies with a required `FileUpload` are documented only as `multipart/form-data`. If every file in the body is optional or nullable, the same schema is exposed for both `application/json` and `multipart/form-data`, allowing requests that omit the files to remain ordinary JSON. A standalone `FileUpload` controller parameter always makes the operation multipart; required and optional standalone parameters are reflected in the multipart schema and request-body requiredness. File constraints are emitted as `x-maxSizeBytes`, `x-allowedTypes`, and multipart encoding content types.

File requiredness is discovered recursively for OpenAPI media-type selection. A required nested object containing a required file therefore makes the body multipart-only, while an optional nested object permits both JSON and multipart schemas. This is schema behavior only: the runtime multipart parser assigns file parts to top-level fields, so flatten upload DTO properties instead of relying on automatic population of `nested.file`.

## Responses

`ApiResponse<T, Status>` documents and emits a JSON response with the given status. The status defaults to `200`, so `ApiResponse<UserDto>` is equivalent to `ApiResponse<UserDto, 200>`.

Plain `Promise<T>` return types document and emit a `200` JSON response. `OkResponse`, `AnyResponse`, `JsonResponseResult`, `RawResponseResult`, `RedirectResponseResult`, and `EmptyResponseResult` keep their existing OpenAPI behavior.

An operation with a required `ParsedJwt` parameter receives `security: [{ bearerAuth: [] }]`, and the document gains an HTTP bearer security scheme with JWT format. An optional `ParsedJwt` does not mark the operation as requiring bearer authentication. Runtime authentication may also read the configured JWT cookie, but the generated document currently advertises only the Bearer mechanism.

## Operation IDs

Operation IDs are camel-cased from the lowercase HTTP method, the controller class name without its `Controller` suffix, and the handler method name. Keep all three stable when generated clients depend on operation IDs.

## Internal Routes

Generated documents exclude internal routes by default:

- `/openapi.json`
- `/openapi.yaml`
- `/_devconsole`
- `/healthz`
- `/metrics`

Call `serializeOpenApiSchema(app, { includeInternal: true })` if a tool needs the full internal route list.

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
