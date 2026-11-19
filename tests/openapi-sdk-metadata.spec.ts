import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, http, openapi, serializeOpenApiSchema, HttpResponse, ParsedJwt } from '../src';

@openapi.operation({ tags: ['crm'], security: [{ tenantKey: [] }], securitySchemes: { tenantKey: { type: 'http', scheme: 'basic' } } })
@http.controller('/metadata')
class MetadataController {
    @openapi.operation({
        operationId: 'listContacts',
        summary: 'List contacts',
        description: 'A longer description.',
        extensions: { 'x-sdk-audience': 'integration' }
    })
    @http.GET()
    async list(): Promise<{ id: string }[]> {
        return [];
    }
    @openapi.operation({ operationId: 'exportContacts', security: [], deprecated: true })
    @openapi.response<string>({
        status: 200,
        mediaType: 'text/csv',
        examples: { sample: { value: 'name\nRiver' } },
        headers: { 'Content-Disposition': { schema: { type: 'string' } } }
    })
    @http.GET('/export')
    async export(response: HttpResponse): Promise<void> {
        response.writeHead(200, { 'content-type': 'text/csv' });
        response.end('name\nRiver');
    }
}

test('controller and method metadata describe custom middleware auth, stable names, examples and CSV response metadata', () => {
    const doc = serializeOpenApiSchema(createApp({ controllers: [MetadataController], enableHealthcheck: false }));
    const list = doc.paths['/metadata'].get!;
    assert.equal(list.operationId, 'listContacts');
    assert.equal(list.description, 'A longer description.');
    assert.deepEqual(list.tags, ['crm']);
    assert.deepEqual(list.security, [{ tenantKey: [] }]);
    assert.equal(list['x-sdk-audience'], 'integration');
    assert.deepEqual(doc.components?.securitySchemes?.tenantKey, { type: 'http', scheme: 'basic' });
    const csv = doc.paths['/metadata/export'].get!;
    assert.deepEqual(csv.security, []);
    assert.equal(csv.deprecated, true);
    assert.equal(csv.responses['200'].content?.['application/json'], undefined);
    assert.equal(csv.responses['200'].content?.['text/csv'].examples?.sample.value, 'name\nRiver');
    assert.ok(csv.responses['200'].headers?.['Content-Disposition']);
});

test('ambiguous IDs and undefined security schemes fail rather than emit invalid SDK contracts', () => {
    @http.controller('/bad')
    class DuplicateController {
        @openapi.operation({ operationId: 'same' }) @http.GET('/one') one(): string {
            return '';
        }
        @openapi.operation({ operationId: 'same' }) @http.GET('/two') two(): string {
            return '';
        }
    }
    assert.throws(
        () => serializeOpenApiSchema(createApp({ controllers: [DuplicateController], enableHealthcheck: false })),
        /Duplicate OpenAPI operationId/
    );
    @http.controller('/missing')
    class MissingController {
        @openapi.operation({ security: [{ missing: [] }] }) @http.GET() read(): string {
            return '';
        }
    }
    assert.throws(
        () => serializeOpenApiSchema(createApp({ controllers: [MissingController], enableHealthcheck: false })),
        /Undefined OpenAPI security scheme/
    );
});

test('explicit metadata cannot hide required JWT authentication or redefine its scheme', () => {
    @http.controller('/jwt-required')
    class RequiredController {
        @openapi.operation({ security: [] }) @http.GET() read(_jwt: ParsedJwt): string {
            return '';
        }
    }
    assert.throws(
        () => serializeOpenApiSchema(createApp({ controllers: [RequiredController], enableHealthcheck: false })),
        /cannot remove required ParsedJwt/
    );
    @http.controller('/scheme-conflict')
    class ConflictController {
        @openapi.operation({ security: [{ bearerAuth: [] }], securitySchemes: { bearerAuth: { type: 'http', scheme: 'basic' } } })
        @http.GET()
        read(): string {
            return '';
        }
    }
    assert.throws(
        () => serializeOpenApiSchema(createApp({ controllers: [ConflictController], enableHealthcheck: false })),
        /Conflicting OpenAPI security scheme/
    );
});

test('undefined metadata retains reflected summaries and bodyless responses reject body annotations', () => {
    @http.controller('/undefined-metadata')
    class SummaryController {
        /** The reflected summary. */
        @openapi.operation({ summary: undefined, tags: undefined }) @http.GET() read(): string {
            return '';
        }
    }
    const doc = serializeOpenApiSchema(createApp({ controllers: [SummaryController], enableHealthcheck: false }));
    assert.equal(doc.paths['/undefined-metadata'].get!.summary, 'The reflected summary.');
    assert.ok(doc.paths['/undefined-metadata'].get!.tags?.length);
    @http.controller('/empty-media')
    class EmptyController {
        @openapi.response<void>({ status: 204, mediaType: 'text/csv' }) @http.GET() read(): void {}
    }
    assert.throws(() => serializeOpenApiSchema(createApp({ controllers: [EmptyController], enableHealthcheck: false })), /require a response body/);
});

test('same-verb aliases get stable distinct IDs without affecting ordinary operations', () => {
    @http.controller('/aliases')
    class AliasController {
        @openapi.operation({ operationId: 'readAlias' })
        @http.GET('/one')
        @http.GET('/two')
        read(): string {
            return '';
        }

        @openapi.operation({ operationId: 'readSingle' })
        @http.GET('/single')
        single(): string {
            return '';
        }
    }
    const app = createApp({ controllers: [AliasController], enableHealthcheck: false });
    const spec = serializeOpenApiSchema(app);
    const one = spec.paths['/aliases/one']?.get?.operationId;
    const two = spec.paths['/aliases/two']?.get?.operationId;
    assert.match(one ?? '', /^readAlias_[a-f0-9]{12}$/);
    assert.match(two ?? '', /^readAlias_[a-f0-9]{12}$/);
    assert.notEqual(one, two);
    assert.equal(spec.paths['/aliases/single']?.get?.operationId, 'readSingle');
    assert.equal(serializeOpenApiSchema(app).paths['/aliases/one']?.get?.operationId, one);
});
