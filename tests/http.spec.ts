import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as nodeHttpRequest } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
    BaseAppConfig,
    createLogger,
    createApp,
    createModule,
    http,
    emptyResponse,
    HasDefault,
    HttpBody,
    HttpHeader,
    HttpNotFoundError,
    HttpPath,
    HttpQueries,
    HttpQuery,
    HttpRequest,
    HttpRequestStream,
    HttpUserError,
    HttpMiddleware,
    HttpResponse,
    eventDispatcher,
    FileUpload,
    httpWorkflow,
    jsonResponse,
    rawResponse,
    redirectResponse,
    resetLogSink,
    setHttpContextResolver,
    setLogSink,
    type EmailAddress,
    type EntityFields,
    type HttpMiddlewareFunction,
    type LogEntry,
    type Overwrite,
    type TrimmedString,
    type RouteParameterResolverContext
} from '../src';
import type { ImportedBindingRequest, ImportedBodyEntity, ImportedBodyItem } from './http-imported-types';

const pngUploadBody = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex'
);
const jpegUploadBody = Buffer.from('ffd8ffe000104a46494600010101006000600000ffdb004300', 'hex');

describe('http router', () => {
    enum TestRouteModule {
        PRIMARY = 'primary',
        SECONDARY = 'secondary'
    }

    it('routes GET requests with query params and injected response', async () => {
        class AppConfig extends BaseAppConfig {
            TEST_CONFIG_ITEM = 'testValue';
        }

        class TestProvider {
            constructor(private config: AppConfig) {}

            getItem() {
                return this.config.TEST_CONFIG_ITEM;
            }
        }

        @http.controller('/test')
        class TestController {
            constructor(private testProvider: TestProvider) {}

            @http.GET()
            get(input: HttpQueries<{ a: string; platform?: 'ios' | 'android'; active?: boolean }>, response: HttpResponse) {
                response.statusCode = 202;
                return {
                    a: input.a,
                    platform: input.platform,
                    active: input.active,
                    activeType: typeof input.active,
                    c: this.testProvider.getItem()
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            config: AppConfig,
            controllers: [TestController],
            providers: [TestProvider]
        });

        const response = await app.request(HttpRequest.GET('/test?a=bananas&platform=ios&active=true'));
        const invalid = await app.request(HttpRequest.GET('/test?a=bananas&platform=windows'));

        assert.equal(response.statusCode, 202);
        assert.deepStrictEqual(response.json, {
            a: 'bananas',
            platform: 'ios',
            active: true,
            activeType: 'boolean',
            c: 'testValue'
        });
        assert.equal(invalid.statusCode, 400);
    });

    it('injects an omitted optional HttpQueries parameter as undefined', async () => {
        @http.controller('/optional-queries')
        class OptionalQueriesController {
            @http.GET()
            get(query?: HttpQueries<{ limit: number; search?: string }>) {
                return query === undefined ? { query: null } : query;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [OptionalQueriesController] });

        const omitted = await app.request(HttpRequest.GET('/optional-queries'));
        const provided = await app.request(HttpRequest.GET('/optional-queries?limit=10'));
        const incomplete = await app.request(HttpRequest.GET('/optional-queries?search=term'));

        assert.equal(omitted.statusCode, 200);
        assert.deepStrictEqual(omitted.json, { query: null });
        assert.deepStrictEqual(provided.json, { limit: 10 });
        assert.equal(incomplete.statusCode, 400);
    });

    it('keeps instance method metadata when comments mention static', async () => {
        @http.controller('/comment-static')
        class TestController {
            // route order matters here because the path has a static segment
            @http.GET('/route')
            getWithStaticComment() {
                return { ok: true };
            }
        }

        const app = createApp({
            controllers: [TestController]
        });

        const response = await app.request(HttpRequest.GET('/comment-static/route'));

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, { ok: true });
    });

    it('deserializes inferred enum path parameters', async () => {
        @http.controller('/enum-path/:module')
        class TestController {
            @http.GET()
            get(module: TestRouteModule) {
                return { module };
            }
        }

        const app = createApp({
            controllers: [TestController]
        });

        const response = await app.request(HttpRequest.GET('/enum-path/primary'));
        const invalid = await app.request(HttpRequest.GET('/enum-path/unknown'));

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, { module: 'primary' });
        assert.equal(invalid.statusCode, 400);
    });

    it('routes POST requests with HttpBody', async () => {
        class ExampleService {
            create(name: string) {
                return { id: 1, name };
            }
        }

        @http.controller('examples')
        class ExampleController {
            constructor(private exampleService: ExampleService) {}

            @http.POST()
            create(body: HttpBody<{ name: string }>) {
                return this.exampleService.create(body.name);
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ExampleController], providers: [ExampleService] });
        const response = await app.request(HttpRequest.POST('/examples', { name: 'Alpha' }));

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, { id: 1, name: 'Alpha' });
    });

    it('routes x-www-form-urlencoded requests with typed HttpBody parameters', async () => {
        @http.controller('/form-body')
        class FormBodyController {
            @http.POST()
            post(body: HttpBody<{ name: string; active: boolean; count: number; tags: string[] }>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [FormBodyController] });
        const response = await app.request(
            new HttpRequest(
                'POST',
                '/form-body',
                { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                'name=Ada+Lovelace&active=true&count=2&tags=math&tags=programming'
            )
        );
        const invalid = await app.request(
            new HttpRequest(
                'POST',
                '/form-body',
                { 'content-type': 'application/x-www-form-urlencoded' },
                'name=Ada&active=true&count=not-a-number&tags=math'
            )
        );

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, {
            name: 'Ada Lovelace',
            active: true,
            count: 2,
            tags: ['math', 'programming']
        });
        assert.equal(invalid.statusCode, 400);
        assert.match(invalid.json.error, /body\.count/);

        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        try {
            const form = new URLSearchParams();
            form.set('name', 'Grace Hopper');
            form.set('active', 'false');
            form.set('count', '3');
            form.append('tags', 'navy');
            form.append('tags', 'compiler');
            const streamedResponse = await fetch(`http://127.0.0.1:${address.port}/form-body`, {
                method: 'POST',
                body: form
            });

            assert.equal(streamedResponse.status, 200);
            assert.deepStrictEqual(await streamedResponse.json(), {
                name: 'Grace Hopper',
                active: false,
                count: 3,
                tags: ['navy', 'compiler']
            });
        } finally {
            await app.stop();
        }
    });

    it('expands nested x-www-form-urlencoded objects and indexed arrays before typed deserialization', async () => {
        interface NestedFormBody {
            contact: { firstName: string; active: boolean };
            participants: Array<{ name: string; age: number }>;
            tags: string[];
        }

        @http.controller('/nested-form-body')
        class NestedFormBodyController {
            @http.POST()
            post(body: HttpBody<NestedFormBody>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [NestedFormBodyController] });
        const response = await app.request(
            new HttpRequest(
                'POST',
                '/nested-form-body',
                { 'content-type': 'application/x-www-form-urlencoded' },
                [
                    'contact[firstName]=Ada',
                    'contact[active]=true',
                    'participants[1][name]=Grace',
                    'participants[1][age]=85',
                    'participants[0][name]=Ada',
                    'participants[0][age]=36',
                    'tags[]=math',
                    'tags[]=programming'
                ].join('&')
            )
        );

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, {
            contact: { firstName: 'Ada', active: true },
            participants: [
                { name: 'Ada', age: 36 },
                { name: 'Grace', age: 85 }
            ],
            tags: ['math', 'programming']
        });
    });

    it('applies configured structural limits to x-www-form-urlencoded bodies', async () => {
        @http.controller('/limited-form-body')
        class LimitedFormBodyController {
            @http.POST()
            post(body: HttpBody<Record<string, string>>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [LimitedFormBodyController],
            defaultConfig: { HTTP_MAX_FORM_FIELDS: 1 }
        });
        const response = await app.request(
            new HttpRequest('POST', '/limited-form-body', { 'content-type': 'application/x-www-form-urlencoded' }, 'one=1&two=2')
        );

        assert.equal(response.statusCode, 413);
        assert.deepStrictEqual(response.json, { error: 'Form contains too many fields' });
    });

    it('rejects invalid structured array entries during HttpBody deserialization', async () => {
        @http.controller('/structured-array-body')
        class StructuredArrayBodyController {
            @http.POST()
            post(body: HttpBody<{ items: { name: string; qty: number }[] }>) {
                return { items: body.items };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [StructuredArrayBodyController] });
        const response = await app.request(
            HttpRequest.POST('/structured-array-body', {
                items: [{ name: 'valid', qty: 1 }, { name: 'missing-qty' }, { name: 'null-qty', qty: null }]
            })
        );

        assert.equal(response.statusCode, 400, JSON.stringify(response.json));
        assert.match(response.json.error, /body\.items\.1\.qty is required/);
    });

    it('rejects invalid imported interface array entries during HttpBody deserialization', async () => {
        @http.controller('/imported-structured-array-body')
        class ImportedStructuredArrayBodyController {
            @http.POST()
            post(body: HttpBody<{ items: ImportedBodyItem[] }>) {
                return { items: body.items };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ImportedStructuredArrayBodyController] });
        const response = await app.request(
            HttpRequest.POST('/imported-structured-array-body', {
                items: [{ name: 'valid', qty: 1 }, { name: 'missing-qty' }, { name: 'null-qty', qty: null }]
            })
        );

        assert.equal(response.statusCode, 400, JSON.stringify(response.json));
        assert.match(response.json.error, /body\.items\.1\.qty is required/);
    });

    it('preserves distributed intersection bindings in imported Record body types', async () => {
        @http.controller('/imported-distributed-intersection-body')
        class ImportedDistributedIntersectionBodyController {
            @http.POST()
            post(body: HttpBody<ImportedBindingRequest>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ImportedDistributedIntersectionBodyController] });
        const base = {
            id: 'node-1',
            type: 'timeCondition',
            matchNext: 'matched',
            noMatchNext: 'not-matched'
        };
        const timeCondition = await app.request(
            HttpRequest.POST('/imported-distributed-intersection-body', {
                nodes: { start: { ...base, timeConditionId: 'condition-1' } }
            })
        );
        const location = await app.request(
            HttpRequest.POST('/imported-distributed-intersection-body', {
                nodes: { start: { ...base, locationId: 'location-1' } }
            })
        );
        const neither = await app.request(
            HttpRequest.POST('/imported-distributed-intersection-body', {
                nodes: { start: base }
            })
        );
        const both = await app.request(
            HttpRequest.POST('/imported-distributed-intersection-body', {
                nodes: { start: { ...base, timeConditionId: 'condition-1', locationId: 'location-1' } }
            })
        );

        assert.equal(timeCondition.statusCode, 200, JSON.stringify(timeCondition.json));
        assert.deepStrictEqual(timeCondition.json, {
            nodes: { start: { ...base, timeConditionId: 'condition-1' } }
        });
        assert.equal(location.statusCode, 200, JSON.stringify(location.json));
        assert.deepStrictEqual(location.json, {
            nodes: { start: { ...base, locationId: 'location-1' } }
        });
        assert.equal(neither.statusCode, 400, JSON.stringify(neither.json));
        assert.equal(both.statusCode, 400, JSON.stringify(both.json));
    });

    it('drops optional undefined HttpBody properties after deserialization', async () => {
        @http.controller('/optional-undefined-body')
        class OptionalUndefinedBodyController {
            @http.PUT()
            put(body: HttpBody<{ name?: string; nullable?: string | null }>) {
                return {
                    hasName: Object.hasOwn(body, 'name'),
                    hasNullable: Object.hasOwn(body, 'nullable'),
                    body
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [OptionalUndefinedBodyController] });
        const response = await app.request(HttpRequest.PUT('/optional-undefined-body', { name: undefined, nullable: null }));

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            hasName: false,
            hasNullable: true,
            body: { nullable: null }
        });
    });

    it('rejects omitted required nullable HttpBody properties', async () => {
        @http.controller('/required-nullable-body')
        class RequiredNullableBodyController {
            @http.PUT()
            put(
                body: HttpBody<{
                    nested: { sourceType: 'discount' | null; sourceId: string | null; reason: string | null };
                    optional?: string | null;
                }>
            ) {
                return {
                    hasSourceId: Object.hasOwn(body.nested, 'sourceId'),
                    hasOptional: Object.hasOwn(body, 'optional'),
                    body
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [RequiredNullableBodyController] });
        const missing = await app.request(
            HttpRequest.PUT('/required-nullable-body', {
                nested: {
                    sourceType: null,
                    reason: 'manual'
                }
            })
        );
        const explicitNull = await app.request(
            HttpRequest.PUT('/required-nullable-body', {
                nested: {
                    sourceType: null,
                    sourceId: null,
                    reason: 'manual'
                }
            })
        );

        assert.equal(missing.statusCode, 400);
        assert.deepStrictEqual(missing.json, { error: 'body.nested.sourceId is required' });
        assert.equal(explicitNull.statusCode, 200, JSON.stringify(explicitNull.json));
        assert.deepStrictEqual(explicitNull.json, {
            hasSourceId: true,
            hasOptional: false,
            body: {
                nested: {
                    sourceType: null,
                    sourceId: null,
                    reason: 'manual'
                }
            }
        });
    });

    it('rejects omitted required nullable properties inside optional intersection bodies', async () => {
        type NestedRecordMetadata = { id: string | null; delivery?: { destination: string | null } } & {
            code: string | null;
        };

        @http.controller('/optional-intersection-nullable-body')
        class OptionalIntersectionNullableBodyController {
            @http.POST()
            post(body: HttpBody<{ metadata?: { record?: NestedRecordMetadata } }>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [OptionalIntersectionNullableBodyController] });
        const missing = await app.request(
            HttpRequest.POST('/optional-intersection-nullable-body', {
                metadata: { record: { id: null } }
            })
        );
        const explicitNull = await app.request(
            HttpRequest.POST('/optional-intersection-nullable-body', {
                metadata: { record: { id: null, code: null } }
            })
        );

        assert.equal(missing.statusCode, 400);
        assert.deepStrictEqual(missing.json, { error: 'body.metadata.record.code is required' });
        assert.equal(explicitNull.statusCode, 200, JSON.stringify(explicitNull.json));
        assert.deepStrictEqual(explicitNull.json, {
            metadata: {
                record: {
                    id: null,
                    code: null
                }
            }
        });
    });

    it('validates primitive HttpBody values with metadata-only intersection markers', async () => {
        @http.controller('/metadata-marker-body')
        class MetadataMarkerBodyController {
            @http.POST()
            post(body: HttpBody<{ enabled: boolean & HasDefault }>) {
                return { enabled: body.enabled, enabledType: typeof body.enabled };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [MetadataMarkerBodyController] });
        const response = await app.request(HttpRequest.POST('/metadata-marker-body', { enabled: true }));

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, { enabled: true, enabledType: 'boolean' });
    });

    it('expands imported class utility aliases in HttpBody parameters', async () => {
        type ImportedPick = Pick<ImportedBodyEntity, 'startsAt' | 'name'>;
        type ImportedCreate = Omit<ImportedPick, 'name'> & Partial<Pick<ImportedPick, 'name'>>;

        @http.controller('/imported-class-utility-body')
        class ImportedClassUtilityBodyController {
            @http.POST()
            post(body: HttpBody<ImportedCreate>) {
                return {
                    startsAtIsDate: body.startsAt instanceof Date,
                    startsAt: body.startsAt?.toISOString() ?? null,
                    hasName: Object.hasOwn(body, 'name'),
                    name: body.name ?? null,
                    hasOmitted: Object.hasOwn(body, 'omitted')
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ImportedClassUtilityBodyController] });
        const response = await app.request(
            HttpRequest.POST('/imported-class-utility-body', {
                startsAt: '2026-07-01T12:34:56.000Z',
                name: undefined,
                omitted: 'ignored'
            })
        );

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            startsAtIsDate: true,
            startsAt: '2026-07-01T12:34:56.000Z',
            hasName: false,
            name: null,
            hasOmitted: false
        });

        const withOptional = await app.request(
            HttpRequest.POST('/imported-class-utility-body', {
                startsAt: '2026-07-02T12:34:56.000Z',
                name: 'Alpha'
            })
        );

        assert.equal(withOptional.statusCode, 200, JSON.stringify(withOptional.json));
        assert.deepStrictEqual(withOptional.json, {
            startsAtIsDate: true,
            startsAt: '2026-07-02T12:34:56.000Z',
            hasName: true,
            name: 'Alpha',
            hasOmitted: false
        });
    });

    it('expands Partial utility aliases whose source is an intersection', async () => {
        class UtilityIntersectionEntity {
            required!: string;
            optionalSide!: number;
            nullableLimit!: number | null;
        }

        type UtilityCreate = Pick<UtilityIntersectionEntity, 'required'> & Partial<Pick<UtilityIntersectionEntity, 'optionalSide' | 'nullableLimit'>>;
        type UtilityUpdate = Partial<UtilityCreate>;

        @http.controller('/partial-intersection-utility-body')
        class PartialIntersectionUtilityBodyController {
            @http.PUT()
            put(body: HttpBody<UtilityUpdate>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [PartialIntersectionUtilityBodyController] });
        const response = await app.request(
            HttpRequest.PUT('/partial-intersection-utility-body', {
                optionalSide: 5,
                nullableLimit: 7
            })
        );

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            optionalSide: 5,
            nullableLimit: 7
        });
    });

    it('expands EntityFields utility aliases inside partial intersections', async () => {
        class EntityFieldsUtilityEntity {
            id!: string;
            firstName!: string | null;
            lastName!: string | null;
            ignored!: string;
        }

        type EntityFieldsCreate = Partial<EntityFields<Omit<EntityFieldsUtilityEntity, 'id' | 'ignored'>> & { tagIds: string[] }>;

        @http.controller('/entity-fields-utility-body')
        class EntityFieldsUtilityBodyController {
            @http.POST()
            post(body: HttpBody<EntityFieldsCreate>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [EntityFieldsUtilityBodyController] });
        const response = await app.request(
            HttpRequest.POST('/entity-fields-utility-body', {
                firstName: 'Ada',
                lastName: 'Lovelace',
                tagIds: ['vip'],
                ignored: 'not accepted'
            })
        );

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            firstName: 'Ada',
            lastName: 'Lovelace',
            tagIds: ['vip']
        });
    });

    it('uses Overwrite helper for explicit duplicate property replacement', async () => {
        type NestedCreate = {
            name: string;
            enabled: boolean;
            nullableLimit: number | null;
        };
        type CreateInput = {
            name: string;
            nested?: NestedCreate | null;
        };
        type UpdateInput = Overwrite<
            Partial<CreateInput>,
            {
                nested?: Partial<NestedCreate> | null;
            }
        >;

        @http.controller('/overwrite-property-body')
        class OverwritePropertyBodyController {
            @http.PUT()
            put(body: HttpBody<UpdateInput>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [OverwritePropertyBodyController] });
        const response = await app.request(
            HttpRequest.PUT('/overwrite-property-body', {
                nested: {
                    name: 'Updated',
                    nullableLimit: null
                }
            })
        );

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            nested: {
                name: 'Updated',
                nullableLimit: null
            }
        });
    });

    it('deserializes Date values in HttpBody parameters', async () => {
        @http.controller('/date-body')
        class DateBodyController {
            @http.POST()
            post(body: HttpBody<{ scheduledFor: Date; nullable?: Date | null }>) {
                return {
                    isDate: body.scheduledFor instanceof Date,
                    scheduledFor: body.scheduledFor.toISOString(),
                    nullableIsDate: body.nullable instanceof Date,
                    nullable: body.nullable?.toISOString() ?? null
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [DateBodyController] });
        const fromString = await app.request(
            HttpRequest.POST('/date-body', {
                scheduledFor: '2026-07-01T12:34:56.000Z',
                nullable: '2026-07-03T12:34:56.000Z'
            })
        );
        const fromDate = await app.request(HttpRequest.POST('/date-body', { scheduledFor: new Date('2026-07-02T12:34:56.000Z') }));

        assert.equal(fromString.statusCode, 200, JSON.stringify(fromString.json));
        assert.deepStrictEqual(fromString.json, {
            isDate: true,
            scheduledFor: '2026-07-01T12:34:56.000Z',
            nullableIsDate: true,
            nullable: '2026-07-03T12:34:56.000Z'
        });
        assert.equal(fromDate.statusCode, 200, JSON.stringify(fromDate.json));
        assert.deepStrictEqual(fromDate.json, {
            isDate: true,
            scheduledFor: '2026-07-02T12:34:56.000Z',
            nullableIsDate: false,
            nullable: null
        });
    });

    it('applies known string annotations in HttpBody parameters', async () => {
        @http.controller('/known-string-body')
        class KnownStringBodyController {
            @http.POST()
            post(body: HttpBody<{ email: EmailAddress; name: TrimmedString }>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [KnownStringBodyController] });
        const response = await app.request(
            HttpRequest.POST('/known-string-body', {
                email: 'user@example.com',
                name: '  Front Desk  '
            })
        );

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            email: 'user@example.com',
            name: 'Front Desk'
        });
    });

    it('accepts null for nested nullable HttpBody union properties', async () => {
        type ContentConfigBase = { type: 'blank' } | { type: 'webView'; url: string } | { type: 'mediaRef'; mediaId: string };
        type ContentConfig = Extract<ContentConfigBase, { type: 'blank' } | { type: 'webView' }> | null;

        @http.controller('/nested-nullable-body')
        class NestedNullableBodyController {
            @http.POST()
            post(body: HttpBody<{ defaultConfig?: ContentConfig }>) {
                return {
                    hasDefaultConfig: Object.hasOwn(body, 'defaultConfig'),
                    defaultConfig: body.defaultConfig
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [NestedNullableBodyController] });
        const response = await app.request(HttpRequest.POST('/nested-nullable-body', { defaultConfig: null }));

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, { hasDefaultConfig: true, defaultConfig: null });
    });

    it('preserves inherited interface properties in HttpBody parameters', async () => {
        interface OutputUpdateBody {
            isPrimary?: boolean;
            clientLabel?: string | null;
        }

        interface OutputCreateBody extends OutputUpdateBody {
            outputKey: string;
        }

        @http.controller('/interface-extends-body')
        class InterfaceExtendsBodyController {
            @http.POST()
            post(body: HttpBody<OutputCreateBody>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [InterfaceExtendsBodyController] });
        const response = await app.request(
            HttpRequest.POST('/interface-extends-body', {
                outputKey: ' hdmi-2 ',
                clientLabel: ' Side ',
                isPrimary: true
            })
        );

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            isPrimary: true,
            clientLabel: ' Side ',
            outputKey: ' hdmi-2 '
        });
    });

    it('preserves class instances during HttpBody normalization', async () => {
        class ClassBody {
            name!: string;
            scheduledFor!: Date | null;

            label() {
                return `${this.name}:${this.scheduledFor?.toISOString() ?? 'none'}`;
            }
        }

        @http.controller('/class-body')
        class ClassBodyController {
            @http.POST()
            post(body: HttpBody<ClassBody>) {
                return {
                    instance: body instanceof ClassBody,
                    label: body.label()
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ClassBodyController] });
        const response = await app.request(HttpRequest.POST('/class-body', { name: 'alpha', scheduledFor: '2026-07-01T12:34:56.000Z' }));

        assert.equal(response.statusCode, 200, JSON.stringify(response.json));
        assert.deepStrictEqual(response.json, {
            instance: true,
            label: 'alpha:2026-07-01T12:34:56.000Z'
        });
    });

    it('registers controllers declared in imported modules with module-local DI', async () => {
        class ModuleLocalService {
            value = 'local';
        }

        @http.controller('/module-controller')
        class ModuleController {
            constructor(private service: ModuleLocalService) {}

            @http.GET()
            get() {
                return { value: this.service.value };
            }
        }

        const feature = createModule({
            controllers: [ModuleController],
            providers: [ModuleLocalService]
        });
        const parent = createModule({ imports: [feature] });

        process.env.APP_ENV = 'test';
        const app = createApp({ imports: [parent] });
        const response = await app.request(HttpRequest.GET('/module-controller'));

        assert.equal(
            app.router.listRoutes().some(route => route.controllerClass === ModuleController),
            true
        );
        assert.deepStrictEqual(response.json, { value: 'local' });
    });

    it('rejects controllers without http controller metadata', () => {
        class UndecoratedController {
            @http.GET()
            get() {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        assert.throws(
            () => createApp({ controllers: [UndecoratedController] }),
            /Controller UndecoratedController passed to controllers must be decorated with @http\.controller\(\)/
        );
    });

    it('rejects controllers declared in imported modules without http controller metadata', () => {
        class UndecoratedController {
            @http.GET()
            get() {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        const feature = createModule({ controllers: [UndecoratedController] });
        assert.throws(
            () => createApp({ imports: [feature] }),
            /Controller UndecoratedController passed to controllers must be decorated with @http\.controller\(\)/
        );
    });

    it('defaults empty structured HttpBody parameters to an object', async () => {
        @http.controller('/optional-body')
        class OptionalBodyController {
            @http.POST()
            post(body: HttpBody<{ target?: 'canary' | 'released' }>) {
                return { target: body.target ?? null };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [OptionalBodyController] });
        const empty = await app.request(HttpRequest.POST('/optional-body'));
        const invalid = await app.request(HttpRequest.POST('/optional-body').json({ target: 'staging' }));

        assert.deepStrictEqual(empty.json, { target: null });
        assert.equal(invalid.statusCode, 400);
    });

    it('routes path parameters by parameter name', async () => {
        @http.controller('/users')
        class UserController {
            @http.GET(':id')
            get(id: string) {
                return { id };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [UserController] });
        const response = await app.request(HttpRequest.GET('/users/abc'));

        assert.deepStrictEqual(response.json, { id: 'abc' });
    });

    it('infers ignored path parameters with a leading underscore', async () => {
        @http.controller('/preflight')
        class PreflightController {
            @http.OPTIONS(':tenantId/:cartId')
            options(_tenantId: string, _cartId: string) {
                return { tenantId: _tenantId, cartId: _cartId };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [PreflightController] });
        const response = await app.request(HttpRequest.OPTIONS('/preflight/t1/c1'));

        assert.deepStrictEqual(response.json, { tenantId: 't1', cartId: 'c1' });
    });

    it('supports class route parameter resolvers', async () => {
        class ResolvedValue {
            value!: string;
            optional!: boolean;
        }

        class ResolvedValueResolver {
            resolve(context: RouteParameterResolverContext): ResolvedValue {
                return Object.assign(new ResolvedValue(), {
                    value: `${context.parameters.id}:${context.name}`,
                    optional: context.type.isOptional()
                });
            }
        }

        function ResolvedController(path: string): ClassDecorator {
            return target => {
                http.controller(path)(target);
                http.resolveParameter(ResolvedValue, ResolvedValueResolver)(target);
            };
        }

        @ResolvedController('/resolved-values/:id')
        class ResolvedValueController {
            @http.GET()
            get(id: string, value: ResolvedValue) {
                return {
                    id,
                    value: value.value,
                    optional: value.optional
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ResolvedValueController] });
        const response = await app.request(HttpRequest.GET('/resolved-values/abc'));

        assert.deepStrictEqual(response.json, {
            id: 'abc',
            value: 'abc:value',
            optional: false
        });
    });

    it('supports app-level global class route parameter resolvers', async () => {
        class GlobalResolvedValue {
            value!: string;
        }

        class GlobalResolvedValueResolver {
            resolve(context: RouteParameterResolverContext): GlobalResolvedValue {
                return Object.assign(new GlobalResolvedValue(), {
                    value: `${context.parameters.id}:${context.name}`
                });
            }
        }

        @http.controller('/global-resolved-values/:id')
        class GlobalResolvedValueController {
            @http.GET()
            get(id: string, value: GlobalResolvedValue) {
                return {
                    id,
                    value: value.value
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [GlobalResolvedValueController],
            providers: [GlobalResolvedValueResolver],
            httpResolvers: { GlobalResolvedValue: GlobalResolvedValueResolver }
        });
        const response = await app.request(HttpRequest.GET('/global-resolved-values/abc'));

        assert.deepStrictEqual(response.json, {
            id: 'abc',
            value: 'abc:value'
        });
    });

    it('coerces path parameters when the primitive type is reflected', async () => {
        @http.controller('/accounts')
        class AccountController {
            @http.GET(':id')
            get(id: number) {
                return { id, idType: typeof id };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [AccountController] });
        const response = await app.request(HttpRequest.GET('/accounts/42'));
        const invalid = await app.request(HttpRequest.GET('/accounts/not-a-number'));

        assert.deepStrictEqual(response.json, { id: 42, idType: 'number' });
        assert.equal(invalid.statusCode, 400);
        assert.deepStrictEqual(invalid.json, { error: 'path parameter "id": The value must be a number.' });
    });

    it('resolves annotated path, query, and header parameters by parameter name', async () => {
        @http.controller('/items')
        class ItemController {
            @http.GET(':id')
            get(id: HttpPath<string>, _search: HttpQuery<string>, aliased: HttpQuery<'q'>, authorization: HttpHeader<string>) {
                return {
                    id,
                    search: _search,
                    aliased,
                    authorization
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ItemController] });
        const response = await app.request(HttpRequest.GET('/items/abc?search=term&q=literal-name', { authorization: 'Bearer token' }));

        assert.deepStrictEqual(response.json, {
            id: 'abc',
            search: 'term',
            aliased: 'literal-name',
            authorization: 'Bearer token'
        });
    });

    it('resolves explicit annotation names and inferred kebab-case x- headers', async () => {
        @http.controller('/named-parameters')
        class NamedParameterController {
            @http.GET('/:recordId')
            get(
                id: HttpPath<number, { name: 'recordId' }>,
                search: HttpQuery<string, { name: 'filter' }>,
                apiKey: HttpHeader<string, { name: 'x-api-key' }>,
                requestId: HttpHeader<string>
            ) {
                return { id, search, apiKey, requestId };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [NamedParameterController] });
        const response = await app.request(
            HttpRequest.GET('/named-parameters/42?filter=active', {
                'X-API-Key': 'secret',
                'X-Request-ID': 'request-1'
            })
        );

        assert.deepStrictEqual(response.json, {
            id: 42,
            search: 'active',
            apiKey: 'secret',
            requestId: 'request-1'
        });
    });

    it('preserves repeated queries for HttpQueries and uses the last value for HttpQuery', async () => {
        @http.controller('/repeated-query')
        class RepeatedQueryController {
            @http.GET()
            get(queries: HttpQueries<{ tag: string[] }>, tag: HttpQuery<string>) {
                return { tags: queries.tag, tag };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [RepeatedQueryController] });
        const response = await app.request(HttpRequest.GET('/repeated-query?tag=first&tag=second'));

        assert.deepStrictEqual(response.json, { tags: ['first', 'second'], tag: 'second' });
    });

    it('allows omitted optional annotated query parameters', async () => {
        @http.controller('/optional-query')
        class OptionalQueryController {
            @http.POST('flags')
            post(enabled?: HttpQuery<boolean>, preview?: HttpQuery<boolean>) {
                return {
                    enabled: enabled ?? null,
                    enabledType: typeof enabled,
                    preview: preview ?? null,
                    previewType: typeof preview
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [OptionalQueryController] });
        const omitted = await app.request(HttpRequest.POST('/optional-query/flags'));
        const provided = await app.request(HttpRequest.POST('/optional-query/flags?enabled=true&preview=false'));

        assert.equal(omitted.statusCode, 200, JSON.stringify(omitted.json));
        assert.deepStrictEqual(omitted.json, {
            enabled: null,
            enabledType: 'undefined',
            preview: null,
            previewType: 'undefined'
        });
        assert.equal(provided.statusCode, 200, JSON.stringify(provided.json));
        assert.deepStrictEqual(provided.json, {
            enabled: true,
            enabledType: 'boolean',
            preview: false,
            previewType: 'boolean'
        });
    });

    it('names missing required annotated query parameters', async () => {
        @http.controller('/required-query')
        class RequiredQueryController {
            @http.GET()
            get(search: HttpQuery<string>) {
                return { search };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [RequiredQueryController] });
        const response = await app.request(HttpRequest.GET('/required-query'));

        assert.equal(response.statusCode, 400);
        assert.deepStrictEqual(response.json, { error: 'query parameter "search" is required' });
    });

    it('rejects unannotated query and body parameters', () => {
        @http.controller('/implicit-query')
        class ImplicitQueryController {
            @http.GET()
            get(query: { search: string }) {
                return query;
            }
        }

        @http.controller('/implicit-body')
        class ImplicitBodyController {
            @http.POST()
            post(body: { name: string }) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        assert.throws(
            () => createApp({ controllers: [ImplicitQueryController] }),
            /Cannot infer HTTP parameter get\.query for GET; use HttpBody<T>, HttpQuery<T>, HttpQueries<T>, HttpPath<T>, HttpRequest, or HttpResponse/
        );
        process.env.APP_ENV = 'test';
        assert.throws(
            () => createApp({ controllers: [ImplicitBodyController] }),
            /Cannot infer HTTP parameter post\.body for POST; use HttpBody<T>, HttpQuery<T>, HttpQueries<T>, HttpPath<T>, HttpRequest, or HttpResponse/
        );
    });

    it('rejects multiple HttpBody parameters at route registration', () => {
        @http.controller('/multiple-bodies')
        class MultipleBodiesController {
            @http.POST()
            post(_first: HttpBody<{ name: string }>, _second: HttpBody<{ active: boolean }>) {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        assert.throws(
            () => createApp({ controllers: [MultipleBodiesController] }),
            /Cannot declare multiple HttpBody parameters on MultipleBodiesController\.post/
        );
    });

    it('only trusts proxy remote-address headers when configured', async () => {
        @http.controller('/remote-address')
        class RemoteAddressController {
            @http.GET()
            get(request: HttpRequest) {
                return { remoteAddress: request.getRemoteAddress() };
            }
        }

        process.env.APP_ENV = 'test';
        const untrustedApp = createApp({
            controllers: [RemoteAddressController],
            defaultConfig: { USE_REAL_IP_HEADER: false }
        });
        process.env.APP_ENV = 'test';
        const trustedApp = createApp({
            controllers: [RemoteAddressController],
            defaultConfig: { USE_REAL_IP_HEADER: true }
        });

        const untrustedRequest = HttpRequest.GET('/remote-address', { 'x-real-ip': '203.0.113.7' });
        untrustedRequest.remoteAddress = '10.0.0.1';
        const trustedRequest = HttpRequest.GET('/remote-address', {
            'x-forwarded-for': '203.0.113.8, 10.0.0.2'
        });
        trustedRequest.remoteAddress = '10.0.0.1';

        const untrusted = await untrustedApp.request(untrustedRequest);
        const trusted = await trustedApp.request(trustedRequest);

        assert.deepStrictEqual(untrusted.json, { remoteAddress: '10.0.0.1' });
        assert.deepStrictEqual(trusted.json, { remoteAddress: '203.0.113.8' });
    });

    it('returns normalized 404 responses', async () => {
        @http.controller('/known')
        class KnownController {
            @http.GET()
            get() {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [KnownController] });
        const response = await app.request(HttpRequest.GET('/missing'));

        assert.equal(response.statusCode, 404);
        assert.deepStrictEqual(response.json, { error: 'Not Found' });
    });

    it('joins route paths, decodes parameters, accepts trailing slashes, and rejects malformed escapes', async () => {
        @http.controller('/routing/')
        class RoutingController {
            @http.GET('/items/:value/')
            get(value: HttpPath<string>) {
                return { value };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [RoutingController] });
        const decoded = await app.request(HttpRequest.GET('/routing/items/a%20b/'));
        const malformed = await app.request(HttpRequest.GET('/routing/items/%E0%A4%A'));
        const wrongMethod = await app.request(HttpRequest.POST('/routing/items/value'));

        assert.deepStrictEqual(decoded.json, { value: 'a b' });
        assert.equal(malformed.statusCode, 400);
        assert.deepStrictEqual(malformed.json, { error: 'Invalid URL encoding for path parameter "value"' });
        assert.equal(wrongMethod.statusCode, 404);
    });

    it('uses declaration order when multiple routes match the same request', async () => {
        @http.controller('/parameter-first')
        class ParameterFirstController {
            @http.GET('/:value')
            parameter(value: HttpPath<string>) {
                return { route: 'parameter', value };
            }

            @http.GET('/fixed')
            fixed() {
                return { route: 'fixed' };
            }
        }

        @http.controller('/literal-first')
        class LiteralFirstController {
            @http.GET('/fixed')
            fixed() {
                return { route: 'fixed' };
            }

            @http.GET('/:value')
            parameter(value: HttpPath<string>) {
                return { route: 'parameter', value };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ParameterFirstController, LiteralFirstController] });

        assert.deepStrictEqual((await app.request(HttpRequest.GET('/parameter-first/fixed'))).json, {
            route: 'parameter',
            value: 'fixed'
        });
        assert.deepStrictEqual((await app.request(HttpRequest.GET('/literal-first/fixed'))).json, { route: 'fixed' });
    });

    it('requires explicit HEAD routes and suppresses their bodies in memory and over Node HTTP', async () => {
        @http.controller('/head-parity')
        class HeadParityController {
            @http.GET()
            get() {
                return { method: 'GET' };
            }

            @http.HEAD()
            head(response: HttpResponse) {
                response.setHeader('x-handler', 'head');
                return { method: 'HEAD' };
            }
        }

        @http.controller('/get-only')
        class GetOnlyController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [HeadParityController, GetOnlyController] });
        const memoryHead = await app.request(HttpRequest.HEAD('/head-parity'));
        const missingHead = await app.request(HttpRequest.HEAD('/get-only'));
        const get = await app.request(HttpRequest.GET('/head-parity'));
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const nodeHead = await fetch(`http://127.0.0.1:${address.port}/head-parity`, { method: 'HEAD' });

            assert.equal(memoryHead.statusCode, 200);
            assert.equal(memoryHead.getHeader('x-handler'), 'head');
            assert.equal(memoryHead.text, '');
            assert.equal(nodeHead.status, 200);
            assert.equal(nodeHead.headers.get('x-handler'), 'head');
            assert.equal(await nodeHead.text(), '');
            assert.equal(missingHead.statusCode, 404);
            assert.deepStrictEqual(get.json, { method: 'GET' });
        } finally {
            await app.stop();
        }
    });

    it('serves configured static files with SPA fallback', async () => {
        const staticDir = mkdtempSync(join(tmpdir(), 'tsf-static-'));
        mkdirSync(join(staticDir, 'assets'));
        writeFileSync(join(staticDir, 'index.html'), '<main>Example App</main>');
        writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("ok");');

        @http.controller('/api')
        class ApiController {
            @http.GET('/status')
            status() {
                return { ok: true };
            }
        }

        try {
            process.env.APP_ENV = 'test';
            const app = createApp({
                controllers: [ApiController],
                staticFiles: { directory: staticDir }
            });

            const root = await app.request(HttpRequest.GET('/'));
            const asset = await app.request(HttpRequest.GET('/assets/app.js'));
            const fallback = await app.request(HttpRequest.GET('/apps/123'));
            const api = await app.request(HttpRequest.GET('/api/status'));
            const traversal = await app.request(HttpRequest.GET('/%2e%2e%2fpackage.json'));

            assert.equal(root.statusCode, 200);
            assert.equal(root.text, '<main>Example App</main>');
            assert.match(String(root.getHeader('content-type')), /text\/html/);
            assert.equal(asset.statusCode, 200);
            assert.equal(asset.text, 'console.log("ok");');
            assert.match(String(asset.getHeader('content-type')), /text\/javascript/);
            assert.equal(fallback.statusCode, 200);
            assert.equal(fallback.text, '<main>Example App</main>');
            assert.deepStrictEqual(api.json, { ok: true });
            assert.equal(traversal.statusCode, 400);
        } finally {
            rmSync(staticDir, { recursive: true, force: true });
        }
    });

    it('honors custom static index and SPA fallback files without shadowing routes or non-GET requests', async () => {
        const staticDir = mkdtempSync(join(tmpdir(), 'tsf-static-custom-'));
        writeFileSync(join(staticDir, 'home.html'), '<main>Home</main>');
        writeFileSync(join(staticDir, 'fallback.html'), '<main>Fallback</main>');
        writeFileSync(join(staticDir, 'route'), 'static route');

        @http.controller()
        class StaticRouteController {
            @http.GET('/route')
            route() {
                return { source: 'controller' };
            }
        }

        try {
            process.env.APP_ENV = 'test';
            const app = createApp({
                controllers: [StaticRouteController],
                staticFiles: {
                    directory: staticDir,
                    index: 'home.html',
                    spaFallback: 'fallback.html'
                }
            });

            const root = await app.request(HttpRequest.GET('/'));
            const fallback = await app.request(HttpRequest.GET('/client/route'));
            const routed = await app.request(HttpRequest.GET('/route'));
            const post = await app.request(HttpRequest.POST('/client/route'));

            assert.equal(root.text, '<main>Home</main>');
            assert.equal(fallback.text, '<main>Fallback</main>');
            assert.deepStrictEqual(routed.json, { source: 'controller' });
            assert.equal(post.statusCode, 404);
        } finally {
            rmSync(staticDir, { recursive: true, force: true });
        }
    });

    it('observes completed requests safely and exposes the actual ephemeral port on the Node server', async () => {
        @http.controller('/observed')
        class ObservedController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ObservedController] });
        const observations: Array<{ path: string; status: number; error?: unknown }> = [];
        const removeObserver = app.http.registerObserver(entry => {
            observations.push({ path: entry.request.path, status: entry.response.statusCode, error: entry.error });
        });
        app.http.registerObserver(() => {
            throw new Error('observer failures are isolated');
        });

        await app.request(HttpRequest.GET('/observed'));
        await app.request(HttpRequest.GET('/observed/missing'));
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            assert.notEqual(address.port, 0);
            assert.equal((await fetch(`http://127.0.0.1:${address.port}/observed`)).status, 200);
            assert.deepStrictEqual(
                observations.map(entry => [entry.path, entry.status, entry.error instanceof Error]),
                [
                    ['/observed', 200, false],
                    ['/observed/missing', 404, true],
                    ['/observed', 200, false]
                ]
            );

            removeObserver();
            await app.request(HttpRequest.GET('/observed'));
            assert.equal(observations.length, 3);
        } finally {
            await app.stop();
        }
    });

    it('dispatches compatible HTTP workflow listener events', async () => {
        const seen: string[] = [];

        class WorkflowListener {
            @eventDispatcher.listen(httpWorkflow.onController, 50)
            onController(event: typeof httpWorkflow.onController.event) {
                seen.push(`controller:${event.request.path}`);
                (event.request as any).workflowValue = 'set';
            }

            @eventDispatcher.listen(httpWorkflow.onResponse, 100)
            onResponse(event: typeof httpWorkflow.onResponse.event) {
                seen.push(`response:${event.request.path}:${event.sent}`);
                if (!event.response.headersSent) event.response.setHeader('x-workflow', 'yes');
            }

            @eventDispatcher.listen(httpWorkflow.onRouteNotFound, 10)
            async routeNotFound(event: typeof httpWorkflow.onRouteNotFound.event) {
                seen.push(`not-found:${event.request.path}:${event.hasNext()}`);
                if (event.request.path === '/fallback') await event.send(new Response('fallback', { status: 203 }));
            }
        }

        @http.controller('/workflow')
        class WorkflowController {
            @http.GET()
            get(request: HttpRequest) {
                return { value: (request as any).workflowValue };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [WorkflowController],
            listeners: [WorkflowListener]
        });

        const routed = await app.request(HttpRequest.GET('/workflow'));
        const fallback = await app.request(HttpRequest.GET('/fallback'));

        assert.deepStrictEqual(routed.json, { value: 'set' });
        assert.equal(routed.getHeader('x-workflow'), 'yes');
        assert.equal(fallback.statusCode, 203);
        assert.equal(fallback.text, 'fallback');
        assert.equal(fallback.getHeader('x-workflow'), 'yes');
        assert.deepStrictEqual(seen, ['controller:/workflow', 'response:/workflow:true', 'not-found:/fallback:false', 'response:/fallback:true']);
    });

    it('normalizes thrown HttpError responses', async () => {
        @http.controller('/known')
        class KnownController {
            @http.GET()
            get() {
                throw new HttpNotFoundError('Nope');
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [KnownController] });
        const response = await app.request(HttpRequest.GET('/known'));

        assert.equal(response.statusCode, 404);
        assert.deepStrictEqual(response.json, { error: 'Nope' });
    });

    it('exposes HttpUserError as a named 422 HttpError class', async () => {
        @http.controller('/user-error')
        class UserErrorController {
            @http.GET()
            get() {
                throw new HttpUserError('Invalid input');
            }
        }

        const error = new HttpUserError();
        assert.equal(error.name, 'HttpUserError');
        assert.equal(error.httpCode, 422);

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [UserErrorController] });
        const response = await app.request(HttpRequest.GET('/user-error'));

        assert.equal(response.statusCode, 422);
        assert.deepStrictEqual(response.json, { error: 'Invalid input' });
    });

    it('returns 400 for invalid JSON bodies', async () => {
        @http.controller('/body')
        class BodyController {
            @http.POST()
            post(_body: HttpBody<{ name: string }>) {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [BodyController] });
        const response = await app.request(new HttpRequest('POST', '/body', { 'content-type': 'application/json' }, '{'));

        assert.equal(response.statusCode, 400);
        assert.deepStrictEqual(response.json, { error: 'Failed to parse JSON' });
    });

    it('handles the request content-encoding and body-size guard matrix', async () => {
        @http.controller('/gzip-body')
        class GzipBodyController {
            @http.POST()
            post(body: HttpBody<{ name: string }>) {
                return { name: body.name };
            }
        }

        process.env.APP_ENV = 'test';
        const body = gzipSync(JSON.stringify({ name: 'Ada' }));
        const okApp = createApp({ controllers: [GzipBodyController] });
        const okResponse = await okApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body)
        );
        const xGzipResponse = await okApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'x-gzip' }, body)
        );
        const identityResponse = await okApp.request(
            new HttpRequest(
                'POST',
                '/gzip-body',
                { 'content-type': 'application/json', 'content-encoding': 'identity' },
                JSON.stringify({ name: 'Grace' })
            )
        );
        const corruptResponse = await okApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'not-gzip')
        );
        const unsupportedResponse = await okApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'br' }, JSON.stringify({ name: 'Ada' }))
        );
        assert.equal(okResponse.statusCode, 200);
        assert.deepStrictEqual(okResponse.json, { name: 'Ada' });
        assert.deepStrictEqual(xGzipResponse.json, { name: 'Ada' });
        assert.deepStrictEqual(identityResponse.json, { name: 'Grace' });
        assert.equal(corruptResponse.statusCode, 400);
        assert.deepStrictEqual(corruptResponse.json, { error: 'Failed to decode request body' });
        assert.equal(unsupportedResponse.statusCode, 415);
        assert.deepStrictEqual(unsupportedResponse.json, { error: 'Unsupported request content encoding: br' });

        const compressedLimitApp = createApp({
            controllers: [GzipBodyController],
            defaultConfig: { HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES: 5 }
        });
        const compressedLimitResponse = await compressedLimitApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body)
        );
        assert.equal(compressedLimitResponse.statusCode, 413);
        assert.deepStrictEqual(compressedLimitResponse.json, { error: 'Compressed request body is too large' });

        const decodedLimitApp = createApp({
            controllers: [GzipBodyController],
            defaultConfig: { HTTP_MAX_REQUEST_BODY_BYTES: 5, HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES: 1024 }
        });
        const decodedLimitResponse = await decodedLimitApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body)
        );
        assert.equal(decodedLimitResponse.statusCode, 413);
        assert.deepStrictEqual(decodedLimitResponse.json, { error: 'Request body is too large' });

        const plainLimitApp = createApp({
            controllers: [GzipBodyController],
            defaultConfig: { HTTP_MAX_REQUEST_BODY_BYTES: 5 }
        });
        const plainLimitResponse = await plainLimitApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json' }, JSON.stringify({ name: 'Ada' }))
        );
        assert.equal(plainLimitResponse.statusCode, 413);
        assert.deepStrictEqual(plainLimitResponse.json, { error: 'Request body is too large' });

        const declaredLengthApp = createApp({
            controllers: [GzipBodyController],
            defaultConfig: { HTTP_MAX_REQUEST_BODY_BYTES: 1024, HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES: 1024 }
        });
        const declaredPlainLength = await declaredLengthApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-length': '1025' }, JSON.stringify({ name: 'Ada' }))
        );
        const declaredCompressedLength = await declaredLengthApp.request(
            new HttpRequest('POST', '/gzip-body', { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '1025' }, body)
        );
        assert.equal(declaredPlainLength.statusCode, 413);
        assert.deepStrictEqual(declaredPlainLength.json, { error: 'Request body is too large' });
        assert.equal(declaredCompressedLength.statusCode, 413);
        assert.deepStrictEqual(declaredCompressedLength.json, { error: 'Compressed request body is too large' });
    });

    it('parses multipart bodies with _payload JSON and uploaded files', async () => {
        interface UploadBody {
            title: string;
            category?: string;
            details?: { department: string };
            published?: boolean;
            file: FileUpload;
        }

        @http.controller('/upload')
        class UploadController {
            @http.POST()
            post(body: HttpBody<UploadBody>, request: HttpRequest) {
                return {
                    title: body.title,
                    category: body.category,
                    details: body.details,
                    published: body.published,
                    publishedType: typeof body.published,
                    file: {
                        originalName: body.file.originalName,
                        path: body.file.path,
                        type: body.file.type,
                        size: body.file.size,
                        contents: readFileSync(body.file.path, 'utf8')
                    },
                    samePath: (request.uploadedFiles.file as FileUpload).path === body.file.path
                };
            }

            @http.POST('/direct')
            direct(_file: FileUpload) {
                return {
                    originalName: _file.originalName,
                    path: _file.path,
                    type: _file.type,
                    size: _file.size,
                    contents: readFileSync(_file.path, 'utf8')
                };
            }

            @http.POST('/body-and-file')
            bodyAndFile(body: HttpBody<UploadBody>, _file: FileUpload) {
                return {
                    title: body.title,
                    samePath: body.file.path === _file.path,
                    contents: readFileSync(_file.path, 'utf8')
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [UploadController] });
        const multipart = makeMultipartBody([
            { name: '_payload', value: JSON.stringify({ title: 'Quarterly report' }) },
            { name: 'category', value: 'finance' },
            { name: 'details[department]', value: 'research' },
            { name: 'published', value: 'true' },
            { name: 'file', filename: 'report.txt', contentType: 'text/plain', value: 'upload-body' }
        ]);
        const streamedMultipart = makeMultipartBody([
            { name: '_payload', value: JSON.stringify({ title: 'Streamed report' }) },
            { name: 'file', filename: 'streamed.txt', contentType: 'text/plain', value: 'streamed-body' }
        ]);

        const bodyResponse = await app.request(new HttpRequest('POST', '/upload', { 'content-type': multipart.contentType }, multipart.body));
        const directResponse = await app.request(
            new HttpRequest('POST', '/upload/direct', { 'content-type': multipart.contentType }, multipart.body)
        );
        const bodyAndFileResponse = await app.request(
            new HttpRequest(
                'POST',
                '/upload/body-and-file',
                { 'content-type': streamedMultipart.contentType },
                undefined,
                Readable.from([streamedMultipart.body])
            )
        );

        assert.equal(bodyResponse.statusCode, 200);
        const bodyJson = bodyResponse.json;
        const directJson = directResponse.json;

        assert.deepStrictEqual(bodyJson, {
            title: 'Quarterly report',
            category: 'finance',
            details: { department: 'research' },
            published: true,
            publishedType: 'boolean',
            file: {
                originalName: 'report.txt',
                path: bodyJson.file.path,
                type: 'text/plain',
                size: 'upload-body'.length,
                contents: 'upload-body'
            },
            samePath: true
        });
        assert.deepStrictEqual(directJson, {
            originalName: 'report.txt',
            path: directJson.path,
            type: 'text/plain',
            size: 'upload-body'.length,
            contents: 'upload-body'
        });
        assert.deepStrictEqual(bodyAndFileResponse.json, {
            title: 'Streamed report',
            samePath: true,
            contents: 'streamed-body'
        });
        assert.equal(existsSync(bodyJson.file.path), false);
        assert.equal(existsSync(directJson.path), false);
    });

    it('expands multipart text fields with the same object and array notation as URL-encoded bodies', async () => {
        interface NestedMultipartBody {
            contact: { firstName: string; active: boolean };
            participants: Array<{ name: string; age: number }>;
            tags: string[];
        }

        @http.controller('/nested-multipart-body')
        class NestedMultipartBodyController {
            @http.POST()
            post(body: HttpBody<NestedMultipartBody>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [NestedMultipartBodyController] });
        const multipart = makeMultipartBody([
            { name: 'contact[firstName]', value: 'Ada' },
            { name: 'contact[active]', value: 'true' },
            { name: 'participants[1][name]', value: 'Grace' },
            { name: 'participants[1][age]', value: '85' },
            { name: 'participants[0][name]', value: 'Ada' },
            { name: 'participants[0][age]', value: '36' },
            { name: 'tags[]', value: 'math' },
            { name: 'tags[]', value: 'programming' }
        ]);
        const response = await app.request(
            new HttpRequest('POST', '/nested-multipart-body', { 'content-type': multipart.contentType }, multipart.body)
        );

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, {
            contact: { firstName: 'Ada', active: true },
            participants: [
                { name: 'Ada', age: 36 },
                { name: 'Grace', age: 85 }
            ],
            tags: ['math', 'programming']
        });
    });

    it('requires standalone FileUpload parameters while preserving optional uploads', async () => {
        @http.controller('/standalone-upload')
        class StandaloneUploadController {
            @http.POST('/required')
            required(file: FileUpload) {
                return { name: file.originalName };
            }

            @http.POST('/optional')
            optional(file?: FileUpload) {
                return { omitted: file === undefined };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [StandaloneUploadController] });
        const noFile = makeMultipartBody([{ name: 'note', value: 'no upload' }]);
        const wrongFile = makeMultipartBody([{ name: 'attachment', filename: 'report.txt', contentType: 'text/plain', value: 'upload-body' }]);

        const requiredNonMultipart = await app.request(HttpRequest.POST('/standalone-upload/required'));
        const requiredMultipart = await app.request(
            new HttpRequest('POST', '/standalone-upload/required', { 'content-type': noFile.contentType }, noFile.body)
        );
        const requiredWrongField = await app.request(
            new HttpRequest('POST', '/standalone-upload/required', { 'content-type': wrongFile.contentType }, wrongFile.body)
        );
        const optionalNonMultipart = await app.request(HttpRequest.POST('/standalone-upload/optional'));
        const optionalMultipart = await app.request(
            new HttpRequest('POST', '/standalone-upload/optional', { 'content-type': noFile.contentType }, noFile.body)
        );
        const optionalWrongField = await app.request(
            new HttpRequest('POST', '/standalone-upload/optional', { 'content-type': wrongFile.contentType }, wrongFile.body)
        );

        assert.equal(requiredNonMultipart.statusCode, 400);
        assert.deepStrictEqual(requiredNonMultipart.json, { error: 'File field "file" is required' });
        assert.equal(requiredMultipart.statusCode, 400);
        assert.deepStrictEqual(requiredMultipart.json, { error: 'File field "file" is required' });
        assert.equal(requiredWrongField.statusCode, 400);
        assert.deepStrictEqual(requiredWrongField.json, { error: 'Unexpected file field "attachment"' });
        assert.equal(optionalNonMultipart.statusCode, 200);
        assert.deepStrictEqual(optionalNonMultipart.json, { omitted: true });
        assert.equal(optionalMultipart.statusCode, 200);
        assert.deepStrictEqual(optionalMultipart.json, { omitted: true });
        assert.equal(optionalWrongField.statusCode, 400);
        assert.deepStrictEqual(optionalWrongField.json, { error: 'Unexpected file field "attachment"' });
    });

    it('requires FileUpload properties declared inside HttpBody', async () => {
        interface RequiredUploadBody {
            title: string;
            file: FileUpload;
        }

        @http.controller('/required-body-upload')
        class RequiredBodyUploadController {
            @http.POST()
            post(body: HttpBody<RequiredUploadBody>) {
                return { title: body.title, file: body.file.originalName };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [RequiredBodyUploadController] });
        const json = await app.request(HttpRequest.POST('/required-body-upload', { title: 'Missing file' }));
        const textOnly = HttpRequest.POST('/required-body-upload').multiPart([{ name: 'title', value: 'Missing file' }]);
        const multipart = await app.request(textOnly);

        assert.equal(json.statusCode, 400);
        assert.match(String(json.json.error), /file.*required/i);
        assert.equal(multipart.statusCode, 400);
        assert.match(String(multipart.json.error), /file.*required/i);
    });

    it('selects the first duplicate direct upload, supports a single declared-file fallback, and rejects typed multi-file bodies', async () => {
        interface AttachmentBody {
            attachment: FileUpload;
        }

        @http.controller('/duplicate-uploads')
        class DuplicateUploadController {
            @http.POST('/direct')
            direct(file: FileUpload, request: HttpRequest) {
                const files = request.uploadedFiles.file as FileUpload[];
                return {
                    selected: readFileSync(file.path, 'utf8'),
                    names: files.map(item => item.originalName),
                    paths: files.map(item => item.path)
                };
            }

            @http.POST('/fallback')
            fallback(body: HttpBody<AttachmentBody>, file: FileUpload) {
                return { sameFile: body.attachment.path === file.path, name: file.originalName };
            }

            @http.POST('/typed')
            typed(_body: HttpBody<{ file: FileUpload }>) {
                return { ok: true };
            }

            @http.POST('/text')
            text(body: HttpBody<{ label: string[] }>) {
                return { labels: body.label };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [DuplicateUploadController] });
        const duplicates = makeMultipartBody([
            { name: 'file', filename: 'first.txt', contentType: 'text/plain', value: 'first' },
            { name: 'file', filename: 'second.txt', contentType: 'text/plain', value: 'second' }
        ]);
        const fallback = makeMultipartBody([{ name: 'attachment', filename: 'attachment.txt', contentType: 'text/plain', value: 'attachment' }]);
        const repeatedText = makeMultipartBody([
            { name: 'label', value: 'first' },
            { name: 'label', value: 'second' }
        ]);

        const direct = await app.request(
            new HttpRequest('POST', '/duplicate-uploads/direct', { 'content-type': duplicates.contentType }, duplicates.body)
        );
        const fallbackResponse = await app.request(
            new HttpRequest('POST', '/duplicate-uploads/fallback', { 'content-type': fallback.contentType }, fallback.body)
        );
        const typed = await app.request(
            new HttpRequest('POST', '/duplicate-uploads/typed', { 'content-type': duplicates.contentType }, duplicates.body)
        );
        const text = await app.request(
            new HttpRequest('POST', '/duplicate-uploads/text', { 'content-type': repeatedText.contentType }, repeatedText.body)
        );

        assert.deepStrictEqual(direct.json, {
            selected: 'first',
            names: ['first.txt', 'second.txt'],
            paths: direct.json.paths
        });
        assert.ok(direct.json.paths.every((path: string) => !existsSync(path)));
        assert.deepStrictEqual(fallbackResponse.json, { sameFile: true, name: 'attachment.txt' });
        assert.equal(typed.statusCode, 400);
        assert.deepStrictEqual(text.json, { labels: ['first', 'second'] });
    });

    it('validates typed multipart uploads with declared and detected MIME types plus size limits', async () => {
        @http.controller('/typed-upload')
        class TypedUploadController {
            @http.POST()
            upload(file: FileUpload<{ maxSize: '1KB'; allowedTypes: 'image/png' }>) {
                return {
                    originalName: file.originalName,
                    type: file.type,
                    detectedType: file.detectedType,
                    detectedExtension: file.detectedExtension,
                    size: file.size,
                    contents: readFileSync(file.path).subarray(0, 8).toString('hex')
                };
            }

            @http.POST('/tiny')
            tiny(_file: FileUpload<{ maxSize: '8B'; allowedTypes: 'image/png' }>) {
                return {};
            }

            @http.POST('/wildcard')
            wildcard(file: FileUpload<{ allowedTypes: 'image/*' }>) {
                return { declared: file.declaredType, detected: file.detectedType };
            }

            @http.POST('/any')
            any(file: FileUpload<{ allowedTypes: '*/*' }>) {
                return { declared: file.declaredType, detected: file.detectedType };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [TypedUploadController] });
        const ok = makeMultipartBody([{ name: 'file', filename: 'pixel.png', contentType: 'image/png', value: pngUploadBody }]);
        const declaredMismatch = makeMultipartBody([{ name: 'file', filename: 'pixel.png', contentType: 'image/jpeg', value: pngUploadBody }]);
        const detectedMismatch = makeMultipartBody([{ name: 'file', filename: 'pixel.png', contentType: 'image/png', value: jpegUploadBody }]);
        const undetectable = makeMultipartBody([{ name: 'file', filename: 'pixel.png', contentType: 'image/png', value: 'not-an-image' }]);
        const anyDeclared = makeMultipartBody([
            { name: 'file', filename: 'pixel.bin', contentType: 'application/octet-stream', value: pngUploadBody }
        ]);

        const okResponse = await app.request(new HttpRequest('POST', '/typed-upload', { 'content-type': ok.contentType }, ok.body));
        assert.equal(okResponse.statusCode, 200);
        assert.deepStrictEqual(okResponse.json, {
            originalName: 'pixel.png',
            type: 'image/png',
            detectedType: 'image/png',
            detectedExtension: 'png',
            size: pngUploadBody.length,
            contents: '89504e470d0a1a0a'
        });

        const declaredMismatchResponse = await app.request(
            new HttpRequest('POST', '/typed-upload', { 'content-type': declaredMismatch.contentType }, declaredMismatch.body)
        );
        assert.equal(declaredMismatchResponse.statusCode, 415);
        assert.deepStrictEqual(declaredMismatchResponse.json, { error: 'File field "file" has unsupported content type' });

        const detectedMismatchResponse = await app.request(
            new HttpRequest('POST', '/typed-upload', { 'content-type': detectedMismatch.contentType }, detectedMismatch.body)
        );
        assert.equal(detectedMismatchResponse.statusCode, 415);
        assert.deepStrictEqual(detectedMismatchResponse.json, { error: 'File field "file" has unsupported content type' });

        const tooLargeResponse = await app.request(new HttpRequest('POST', '/typed-upload/tiny', { 'content-type': ok.contentType }, ok.body));
        assert.equal(tooLargeResponse.statusCode, 413);
        assert.deepStrictEqual(tooLargeResponse.json, { error: 'File field "file" is too large' });

        const wildcardResponse = await app.request(new HttpRequest('POST', '/typed-upload/wildcard', { 'content-type': ok.contentType }, ok.body));
        assert.deepStrictEqual(wildcardResponse.json, { declared: 'image/png', detected: 'image/png' });

        const anyResponse = await app.request(
            new HttpRequest('POST', '/typed-upload/any', { 'content-type': anyDeclared.contentType }, anyDeclared.body)
        );
        assert.deepStrictEqual(anyResponse.json, { declared: 'application/octet-stream', detected: 'image/png' });

        const undetectableResponse = await app.request(
            new HttpRequest('POST', '/typed-upload/wildcard', { 'content-type': undetectable.contentType }, undetectable.body)
        );
        assert.equal(undetectableResponse.statusCode, 415);
        assert.deepStrictEqual(undetectableResponse.json, { error: 'File field "file" has unsupported content type' });
    });

    it('cleans upload temp directories after parse, MIME, size, and onResponse failures', async () => {
        let uploadedPath: string | undefined;

        @http.controller('/upload-cleanup')
        class UploadCleanupController {
            @http.POST('/parse')
            parse(_body: HttpBody<{ value: string }>) {
                return {};
            }

            @http.POST('/mime')
            mime(_file: FileUpload<{ allowedTypes: 'image/png' }>) {
                return {};
            }

            @http.POST('/size')
            size(_file: FileUpload<{ maxSize: '1B' }>) {
                return {};
            }

            @http.POST('/response')
            response(file: FileUpload) {
                uploadedPath = file.path;
                return { ok: true };
            }
        }

        class FailingResponseListener {
            @eventDispatcher.listen(httpWorkflow.onResponse)
            onResponse(event: typeof httpWorkflow.onResponse.event) {
                if (event.request.path === '/upload-cleanup/response') throw new Error('onResponse failure');
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [UploadCleanupController], listeners: [FailingResponseListener] });
        const before = listUploadTempDirs();
        const badPayload = makeMultipartBody([{ name: '_payload', value: '{' }]);
        const badMime = makeMultipartBody([{ name: 'file', filename: 'file.png', contentType: 'image/png', value: 'not-png' }]);
        const tooLarge = makeMultipartBody([{ name: 'file', filename: 'file.txt', contentType: 'text/plain', value: 'too large' }]);
        const responseFailure = makeMultipartBody([{ name: 'file', filename: 'file.txt', contentType: 'text/plain', value: 'ok' }]);

        assert.equal(
            (await app.request(new HttpRequest('POST', '/upload-cleanup/parse', { 'content-type': badPayload.contentType }, badPayload.body)))
                .statusCode,
            400
        );
        assert.deepStrictEqual(listUploadTempDirs(), before);
        assert.equal(
            (await app.request(new HttpRequest('POST', '/upload-cleanup/mime', { 'content-type': badMime.contentType }, badMime.body))).statusCode,
            415
        );
        assert.deepStrictEqual(listUploadTempDirs(), before);
        assert.equal(
            (await app.request(new HttpRequest('POST', '/upload-cleanup/size', { 'content-type': tooLarge.contentType }, tooLarge.body))).statusCode,
            413
        );
        assert.deepStrictEqual(listUploadTempDirs(), before);
        await assert.rejects(
            () =>
                app.request(
                    new HttpRequest('POST', '/upload-cleanup/response', { 'content-type': responseFailure.contentType }, responseFailure.body)
                ),
            /onResponse failure/
        );
        assert.deepStrictEqual(listUploadTempDirs(), before);
        assert.ok(uploadedPath);
        assert.equal(existsSync(uploadedPath), false);
    });

    it('rejects invalid FileUpload allowedTypes metadata at startup', () => {
        @http.controller('/invalid-upload-policy')
        class InvalidUploadPolicyController {
            @http.POST()
            upload(_file: FileUpload<{ allowedTypes: 'not-a-mime-type' }>) {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        assert.throws(() => createApp({ controllers: [InvalidUploadPolicyController] }), /Invalid FileUpload allowedTypes/);
    });

    it('rejects nested and array FileUpload body properties at startup', () => {
        class NestedUploadPart {
            file!: FileUpload;
        }

        @http.controller('/invalid-nested-upload')
        class InvalidNestedUploadController {
            @http.POST('/nested')
            nested(_body: HttpBody<{ nested: NestedUploadPart }>) {
                return {};
            }
        }

        @http.controller('/invalid-array-upload')
        class InvalidArrayUploadController {
            @http.POST()
            array(_body: HttpBody<{ files: FileUpload[] }>) {
                return {};
            }
        }

        @http.controller('/invalid-file-name-upload')
        class InvalidFileNameUploadController {
            @http.POST()
            named(_body: HttpBody<{ 'nested[file]': FileUpload }>) {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        assert.throws(
            () => createApp({ controllers: [InvalidNestedUploadController] }),
            /FileUpload body properties must be top-level; found "nested.file"/
        );
        assert.throws(
            () => createApp({ controllers: [InvalidArrayUploadController] }),
            /FileUpload body properties must be top-level; found "files.\[\]"/
        );
        assert.throws(() => createApp({ controllers: [InvalidFileNameUploadController] }), /File field "nested\[file\]" must be a top-level field/);
    });

    it('skips eager multipart parsing for bodyless routes while preserving upload guards when bytes are present', async () => {
        @http.controller('/multipart-guard')
        class MultipartGuardController {
            @http.POST('/request')
            request(_request: HttpRequest) {
                return { ok: true };
            }

            @http.GET('/authz')
            authz() {
                return { ok: true };
            }

            @http.HEAD('/authz-head')
            authzHead() {
                return { ok: true };
            }

            @http.POST('/body')
            body(_body: HttpBody<Record<string, unknown>>) {
                return { ok: true };
            }

            @http.POST('/stream')
            async stream(request: HttpRequestStream) {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
                const text = Buffer.concat(chunks).toString('utf8');
                return {
                    sawFileName: text.includes('pixel.png'),
                    sawFileBytes: text.includes('PNG')
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [MultipartGuardController] });
        const multipart = makeMultipartBody([{ name: 'file', filename: 'pixel.png', contentType: 'image/png', value: pngUploadBody }]);

        const guardedResponse = await app.request(
            new HttpRequest('POST', '/multipart-guard/request', { 'content-type': multipart.contentType }, multipart.body)
        );
        assert.equal(guardedResponse.statusCode, 400);
        assert.deepStrictEqual(guardedResponse.json, { error: 'Unexpected file field "file"' });

        const bodylessResponse = await app.request(new HttpRequest('GET', '/multipart-guard/authz', { 'content-type': multipart.contentType }));
        assert.equal(bodylessResponse.statusCode, 200);
        assert.deepStrictEqual(bodylessResponse.json, { ok: true });

        const bodylessPostResponse = await app.request(
            new HttpRequest('POST', '/multipart-guard/request', { 'content-type': multipart.contentType })
        );
        assert.equal(bodylessPostResponse.statusCode, 200);
        assert.deepStrictEqual(bodylessPostResponse.json, { ok: true });

        const bodylessHeadResponse = await app.request(
            new HttpRequest('HEAD', '/multipart-guard/authz-head', { 'content-type': multipart.contentType })
        );
        assert.equal(bodylessHeadResponse.statusCode, 200);

        const bodyfulGetResponse = await app.request(
            new HttpRequest('GET', '/multipart-guard/authz', { 'content-type': multipart.contentType }, multipart.body)
        );
        assert.equal(bodyfulGetResponse.statusCode, 400);
        assert.deepStrictEqual(bodyfulGetResponse.json, { error: 'Unexpected file field "file"' });

        const parsedResponse = await app.request(
            new HttpRequest('POST', '/multipart-guard/body', { 'content-type': multipart.contentType }, multipart.body)
        );
        assert.equal(parsedResponse.statusCode, 400);
        assert.deepStrictEqual(parsedResponse.json, { error: 'Unexpected file field "file"' });

        const streamResponse = await app.request(
            new HttpRequest('POST', '/multipart-guard/stream', { 'content-type': multipart.contentType }, multipart.body)
        );
        assert.equal(streamResponse.statusCode, 200);
        assert.deepStrictEqual(streamResponse.json, { sawFileName: true, sawFileBytes: true });
    });

    it('accepts a bodyless multipart POST over Node HTTP', async () => {
        @http.controller('/bodyless-auth')
        class BodylessAuthController {
            @http.POST()
            post() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [BodylessAuthController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        try {
            const nodeBodylessPost = await requestNodeHttp(address.port, 'POST', '/bodyless-auth', {
                'content-type': 'multipart/form-data; boundary=preserved-without-body'
            });
            assert.equal(nodeBodylessPost.statusCode, 200);
            assert.deepStrictEqual(JSON.parse(nodeBodylessPost.text), { ok: true });
        } finally {
            await app.stop();
        }
    });

    it('rejects parsed parameters combined with HttpRequestStream at registration', () => {
        @http.controller('/invalid-body-stream')
        class InvalidBodyStreamController {
            @http.POST()
            post(_stream: HttpRequestStream, _body: HttpBody<{ value: string }>) {
                return {};
            }
        }

        @http.controller('/invalid-file-stream')
        class InvalidFileStreamController {
            @http.POST()
            post(_stream: HttpRequestStream, _file: FileUpload) {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        assert.throws(
            () => createApp({ controllers: [InvalidBodyStreamController] }),
            /Cannot combine HttpRequestStream with parsed body or file parameters on post/
        );
        assert.throws(
            () => createApp({ controllers: [InvalidFileStreamController] }),
            /Cannot combine HttpRequestStream with parsed body or file parameters on post/
        );
    });

    it('lets HttpRequestStream bypass decoding, declared-length, and byte-limit guards', async () => {
        @http.controller('/stream-bypass')
        class StreamBypassController {
            @http.POST()
            async post(stream: HttpRequestStream) {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
                return { text: Buffer.concat(chunks).toString() };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [StreamBypassController],
            defaultConfig: { HTTP_MAX_REQUEST_BODY_BYTES: 1, HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES: 1 }
        });
        const response = await app.request(
            new HttpRequest('POST', '/stream-bypass', { 'content-encoding': 'br', 'content-length': '9999' }, 'raw-stream-body')
        );

        assert.equal(response.statusCode, 200);
        assert.deepStrictEqual(response.json, { text: 'raw-stream-body' });
    });

    it('runs request handlers inside logger context data', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/log-context')
        class LogContextController {
            private readonly logger = createLogger('LogContextController');

            @http.GET()
            get() {
                this.logger.info('handled');
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        setHttpContextResolver(() => ({ reqId: 'ctx-1' }));
        setLogSink(entry => entries.push(entry));
        try {
            const app = createApp({ controllers: [LogContextController] });
            await app.request(HttpRequest.GET('/log-context'));

            assert.equal((entries[0]?.data?.http as Record<string, unknown> | undefined)?.reqId, 'ctx-1');
        } finally {
            resetLogSink();
            setHttpContextResolver(() => ({ reqId: 'test-req' }));
        }
    });

    it('logs Node HTTP request start and finish with configured paths and health checks suppressed', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/request-logging')
        class RequestLoggingController {
            @http.GET()
            get() {
                return { ok: true };
            }

            @http.GET('/mutate-context')
            mutateContext(request: HttpRequest) {
                request.context.controllerValue = 'seen-by-finish-log';
                return { ok: true };
            }

            @http.GET('/excluded')
            excluded() {
                return { ok: true };
            }

            @http.GET('/excluded-error')
            excludedError() {
                throw new Error('excluded request error');
            }

            @http.GET('/excluded-neighbor')
            excludedNeighbor() {
                return { ok: true };
            }

            @http.GET('/pattern/:id')
            pattern() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const excludedPattern = /^\/request-logging\/pattern\//g;
        const app = createApp({
            controllers: [RequestLoggingController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'e2e' },
            requestLogging: {
                excludePaths: ['/request-logging/excluded', '/request-logging/excluded-error', excludedPattern]
            }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const ok = await requestNodeHttp(address.port, 'GET', '/request-logging');

            assert.equal(ok.statusCode, 200);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request', 'Response']
            );
            assert.equal(entries[0].scope, 'http');
            assert.equal(entries[0].data?.method, 'GET');
            assert.equal(entries[0].data?.url, '/request-logging');
            assert.equal(entries[0].data?.remoteAddress, '127.0.0.1');
            assert.equal(entries[1].data?.statusCode, 200);
            assert.equal(typeof entries[1].data?.duration, 'number');

            entries.length = 0;
            const mutated = await requestNodeHttp(address.port, 'GET', '/request-logging/mutate-context');

            assert.equal(mutated.statusCode, 200);
            assert.equal((entries[1]?.data?.http as Record<string, unknown> | undefined)?.controllerValue, 'seen-by-finish-log');

            entries.length = 0;
            const excluded = await requestNodeHttp(address.port, 'GET', '/request-logging/excluded?source=poll');

            assert.equal(excluded.statusCode, 200);
            assert.equal(entries.length, 0);

            const pattern = await requestNodeHttp(address.port, 'GET', '/request-logging/pattern/123');

            assert.equal(pattern.statusCode, 200);
            assert.equal(entries.length, 0);
            assert.equal(excludedPattern.lastIndex, 0);

            const repeatedPattern = await requestNodeHttp(address.port, 'GET', '/request-logging/pattern/456');

            assert.equal(repeatedPattern.statusCode, 200);
            assert.equal(entries.length, 0);
            assert.equal(excludedPattern.lastIndex, 0);

            const excludedError = await requestNodeHttp(address.port, 'GET', '/request-logging/excluded-error');

            assert.equal(excludedError.statusCode, 500);
            assert.equal(entries.length, 0);

            const excludedNeighbor = await requestNodeHttp(address.port, 'GET', '/request-logging/excluded-neighbor');

            assert.equal(excludedNeighbor.statusCode, 200);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request', 'Response']
            );

            entries.length = 0;
            const health = await requestNodeHttp(address.port, 'GET', '/healthz');

            assert.equal(health.statusCode, 200);
            assert.equal(entries.length, 0);
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('suppresses routine request and response logs by default in test mode', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/test-default-request-logging')
        class TestDefaultRequestLoggingController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({ controllers: [TestDefaultRequestLoggingController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await requestNodeHttp(address.port, 'GET', '/test-default-request-logging');

            assert.equal(response.statusCode, 200);
            assert.deepStrictEqual(entries, []);
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('logs controller errors in test mode without request and response logs', async () => {
        const entries: LogEntry[] = [];
        const controllerError = new Error('controller exploded');

        @http.controller('/request-error-logging')
        class RequestErrorLoggingController {
            @http.GET()
            get() {
                throw controllerError;
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({ controllers: [RequestErrorLoggingController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await requestNodeHttp(address.port, 'GET', '/request-error-logging');

            assert.equal(response.statusCode, 500);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request processing error']
            );
            assert.strictEqual(entries[0].error, controllerError);
            assert.equal(entries[0].scope, 'http');
            assert.equal(entries[0].levelName, 'error');
            assert.equal(entries[0].data?.statusCode, 500);
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('logs routed HttpErrors as warnings, including client errors', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/request-http-error-logging')
        class RequestHttpErrorLoggingController {
            @http.GET()
            get() {
                throw new HttpNotFoundError('Requested resource is unavailable');
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            controllers: [RequestHttpErrorLoggingController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'errors' }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await requestNodeHttp(address.port, 'GET', '/request-http-error-logging');

            assert.equal(response.statusCode, 404);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request processing error']
            );
            assert.equal(entries[0].levelName, 'warning');
            assert.equal(entries[0].scope, 'http');
            assert.deepStrictEqual(entries[0].data, { 'error.message': 'Requested resource is unavailable' });
            assert.equal(entries[0].error, undefined);
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('logs middleware HttpErrors as warnings for matched routes', async () => {
        const entries: LogEntry[] = [];
        const middleware: HttpMiddlewareFunction = () => {
            throw new HttpNotFoundError('Middleware rejected the request');
        };

        @http.middleware(middleware)
        @http.controller('/middleware-http-error-logging')
        class MiddlewareHttpErrorLoggingController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            controllers: [MiddlewareHttpErrorLoggingController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'errors' }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await requestNodeHttp(address.port, 'GET', '/middleware-http-error-logging');

            assert.equal(response.statusCode, 404);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request processing error']
            );
            assert.equal(entries[0].levelName, 'warning');
            assert.deepStrictEqual(entries[0].data, { 'error.message': 'Middleware rejected the request' });
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('logs malformed path parameter HttpErrors as warnings for matched routes', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/malformed-path-error-logging')
        class MalformedPathErrorLoggingController {
            @http.GET('/:id')
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            controllers: [MalformedPathErrorLoggingController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'errors' }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await requestNodeHttp(address.port, 'GET', '/malformed-path-error-logging/%E0%A4%A');

            assert.equal(response.statusCode, 400);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request processing error']
            );
            assert.equal(entries[0].levelName, 'warning');
            assert.deepStrictEqual(entries[0].data, {
                'error.message': 'Invalid URL encoding for path parameter "id"'
            });
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('does not log controller HttpErrors when request logging is disabled or excluded', async () => {
        @http.controller('/request-http-error-logging-independent')
        class RequestHttpErrorLoggingIndependentController {
            @http.GET()
            get() {
                throw new HttpNotFoundError('Requested resource is unavailable');
            }
        }

        const cases = [
            { defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'none' as const } },
            { requestLogging: { excludePaths: ['/request-http-error-logging-independent'] } }
        ];

        process.env.APP_ENV = 'test';
        for (const options of cases) {
            const entries: LogEntry[] = [];
            setLogSink(entry => entries.push(entry));
            const app = createApp({
                controllers: [RequestHttpErrorLoggingIndependentController],
                ...options
            });
            const server = await app.http.listen(0, '127.0.0.1');
            const address = server.address() as AddressInfo;

            try {
                const response = await requestNodeHttp(address.port, 'GET', '/request-http-error-logging-independent');

                assert.equal(response.statusCode, 404);
                assert.deepStrictEqual(entries, []);
            } finally {
                await app.stop();
                resetLogSink();
            }
        }
    });

    it('logs controller errors for in-memory requests without request and response logs', async () => {
        const entries: LogEntry[] = [];
        const controllerError = new Error('memory controller exploded');

        @http.controller('/memory-request-error-logging')
        class MemoryRequestErrorLoggingController {
            @http.GET()
            get() {
                throw controllerError;
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        try {
            const app = createApp({ controllers: [MemoryRequestErrorLoggingController] });
            const response = await app.request(HttpRequest.GET('/memory-request-error-logging'));

            assert.equal(response.statusCode, 500);
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request processing error']
            );
            assert.strictEqual(entries[0].error, controllerError);
            assert.equal(entries[0].scope, 'http');
            assert.equal(entries[0].data?.statusCode, 500);
            assert.equal(entries[0].data?.url, '/memory-request-error-logging');

            entries.length = 0;
            const excludedApp = createApp({
                controllers: [MemoryRequestErrorLoggingController],
                requestLogging: { excludePaths: ['/memory-request-error-logging'] }
            });
            const excludedResponse = await excludedApp.request(HttpRequest.GET('/memory-request-error-logging'));

            assert.equal(excludedResponse.statusCode, 500);
            assert.deepStrictEqual(entries, []);
        } finally {
            resetLogSink();
        }
    });

    it('honors Node HTTP request logging modes and health logging opt-in', async () => {
        @http.controller('/request-logging-modes')
        class RequestLoggingModesController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        const cases = [
            { mode: 'finish', path: '/request-logging-modes', messages: ['Response'] },
            { mode: 'errors', path: '/request-logging-modes', messages: [] },
            { mode: 'errors', path: '/missing-route', messages: [] },
            { mode: 'none', path: '/missing-route', messages: [] }
        ] as const;

        for (const item of cases) {
            const entries: LogEntry[] = [];
            process.env.APP_ENV = 'test';
            setLogSink(entry => entries.push(entry));
            const app = createApp({
                controllers: [RequestLoggingModesController],
                defaultConfig: { HTTP_REQUEST_LOGGING_MODE: item.mode }
            });
            const server = await app.http.listen(0, '127.0.0.1');
            const address = server.address() as AddressInfo;

            try {
                await requestNodeHttp(address.port, 'GET', item.path);
                assert.deepStrictEqual(
                    entries.map(entry => entry.message),
                    item.messages
                );
            } finally {
                await app.stop();
                resetLogSink();
            }
        }

        const entries: LogEntry[] = [];
        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            defaultConfig: { HEALTHZ_ENABLE_REQUEST_LOGGING: true, HTTP_REQUEST_LOGGING_MODE: 'e2e' }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            await requestNodeHttp(address.port, 'GET', '/healthz');
            assert.deepStrictEqual(
                entries.map(entry => entry.message),
                ['Request', 'Response']
            );
        } finally {
            await app.stop();
            resetLogSink();
        }
    });

    it('returns 400 for invalid multipart JSON payloads', async () => {
        @http.controller('/bad-upload')
        class BadUploadController {
            @http.POST()
            post(_body: HttpBody<{ value: string }>) {
                return {};
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [BadUploadController] });
        const multipart = makeMultipartBody([{ name: '_payload', value: '{' }]);
        const response = await app.request(new HttpRequest('POST', '/bad-upload', { 'content-type': multipart.contentType }, multipart.body));

        assert.equal(response.statusCode, 400);
        assert.deepStrictEqual(response.json, { error: 'Failed to parse multipart JSON payload' });
    });

    it('rejects unsafe, ambiguous, and oversized multipart form structures', async () => {
        @http.controller('/guarded-multipart-fields')
        class GuardedMultipartFieldsController {
            @http.POST()
            post(_body: HttpBody<Record<string, unknown>>) {
                return { ok: true };
            }

            @http.POST('/file')
            file(_file: FileUpload) {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [GuardedMultipartFieldsController] });
        const invalidBodies = [
            makeMultipartBody([{ name: '__proto__[polluted]', value: 'yes' }]),
            makeMultipartBody([{ name: 'items[1]', value: 'sparse' }]),
            makeMultipartBody([
                { name: '_payload', value: '{"contact":{"firstName":"Ada"}}' },
                { name: 'contact[firstName]', value: 'Grace' }
            ]),
            makeMultipartBody([
                { name: '_payload', value: '{}' },
                { name: '_payload', value: '{}' }
            ]),
            makeMultipartBody([{ name: '_payload', value: '{"safe":{"constructor":{"polluted":true}}}' }])
        ];

        for (const multipart of invalidBodies) {
            const response = await app.request(
                new HttpRequest('POST', '/guarded-multipart-fields', { 'content-type': multipart.contentType }, multipart.body)
            );
            assert.equal(response.statusCode, 400, JSON.stringify(response.json));
        }

        const limitedApp = createApp({
            controllers: [GuardedMultipartFieldsController],
            defaultConfig: { HTTP_MAX_FORM_FIELDS: 1 }
        });
        const tooMany = makeMultipartBody([
            { name: 'one', value: '1' },
            { name: 'two', value: '2' }
        ]);
        const limitedResponse = await limitedApp.request(
            new HttpRequest('POST', '/guarded-multipart-fields', { 'content-type': tooMany.contentType }, tooMany.body)
        );
        assert.equal(limitedResponse.statusCode, 413);
        assert.deepStrictEqual(limitedResponse.json, { error: 'Form contains too many fields' });

        const before = listUploadTempDirs();
        const nestedFile = makeMultipartBody([{ name: 'file[nested]', filename: 'nested.txt', contentType: 'text/plain', value: 'nested' }]);
        const nestedFileResponse = await app.request(
            new HttpRequest('POST', '/guarded-multipart-fields/file', { 'content-type': nestedFile.contentType }, nestedFile.body)
        );
        assert.equal(nestedFileResponse.statusCode, 400);
        assert.match(nestedFileResponse.json.error, /must be a top-level field/);
        assert.deepStrictEqual(listUploadTempDirs(), before);

        const collision = makeMultipartBody([
            { name: 'file', value: 'text' },
            { name: 'file', filename: 'file.txt', contentType: 'text/plain', value: 'binary' }
        ]);
        const collisionResponse = await app.request(
            new HttpRequest('POST', '/guarded-multipart-fields/file', { 'content-type': collision.contentType }, collision.body)
        );
        assert.equal(collisionResponse.statusCode, 400);
        assert.match(collisionResponse.json.error, /Conflicting form field values/);
        assert.deepStrictEqual(listUploadTempDirs(), before);
    });

    it('normalizes malformed multipart bodies while preserving request body guard errors', async () => {
        @http.controller('/malformed-upload')
        class MalformedUploadController {
            @http.POST()
            post(body: HttpBody<{ value: string }>) {
                return body;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [MalformedUploadController] });
        for (const contentType of ['multipart/form-data', 'multipart/form-data; boundary=incomplete']) {
            const response = await app.request(new HttpRequest('POST', '/malformed-upload', { 'content-type': contentType }));
            assert.equal(response.statusCode, 400);
            assert.deepStrictEqual(response.json, { error: 'Failed to parse multipart body' });
        }

        const multipart = makeMultipartBody([{ name: 'value', value: 'ok' }]);
        const compressedResponse = await app.request(
            new HttpRequest(
                'POST',
                '/malformed-upload',
                { 'content-type': multipart.contentType, 'content-encoding': 'gzip' },
                gzipSync(multipart.body)
            )
        );
        const corruptResponse = await app.request(
            new HttpRequest('POST', '/malformed-upload', { 'content-type': multipart.contentType, 'content-encoding': 'gzip' }, 'not-gzip')
        );
        const unsupportedResponse = await app.request(
            new HttpRequest('POST', '/malformed-upload', { 'content-type': multipart.contentType, 'content-encoding': 'br' }, multipart.body)
        );
        const oversizedResponse = await app.request(
            new HttpRequest(
                'POST',
                '/malformed-upload',
                { 'content-type': multipart.contentType, 'content-length': String(101 * 1024 * 1024) },
                multipart.body
            )
        );

        assert.equal(compressedResponse.statusCode, 200);
        assert.deepStrictEqual(compressedResponse.json, { value: 'ok' });
        assert.equal(corruptResponse.statusCode, 400);
        assert.deepStrictEqual(corruptResponse.json, { error: 'Failed to decode request body' });
        assert.equal(unsupportedResponse.statusCode, 415);
        assert.deepStrictEqual(unsupportedResponse.json, { error: 'Unsupported request content encoding: br' });
        assert.equal(oversizedResponse.statusCode, 413);
        assert.deepStrictEqual(oversizedResponse.json, { error: 'Request body is too large' });
    });

    it('writes explicit response result helpers', async () => {
        @http.controller('/results')
        class ResultController {
            @http.GET('/json')
            json() {
                return jsonResponse({ created: true }, 201);
            }

            @http.GET('/redirect')
            redirect() {
                return redirectResponse('/new-path', 301);
            }

            @http.GET('/empty')
            empty() {
                return emptyResponse();
            }

            @http.DELETE('/void')
            async voidResult(): Promise<void> {}

            @http.GET('/raw')
            raw() {
                return rawResponse('plain text', {
                    statusCode: 202,
                    contentType: 'text/plain',
                    headers: { 'x-mode': 'raw' }
                });
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [ResultController] });

        const json = await app.request(HttpRequest.GET('/results/json'));
        const redirect = await app.request(HttpRequest.GET('/results/redirect'));
        const empty = await app.request(HttpRequest.GET('/results/empty'));
        const voidResult = await app.request(HttpRequest.DELETE('/results/void'));
        const raw = await app.request(HttpRequest.GET('/results/raw'));

        assert.equal(json.statusCode, 201);
        assert.deepStrictEqual(json.json, { created: true });
        assert.equal(redirect.statusCode, 301);
        assert.equal(redirect.getHeader('location'), '/new-path');
        assert.equal(empty.statusCode, 204);
        assert.equal(empty.text, '');
        assert.equal(voidResult.statusCode, 200);
        assert.equal(voidResult.text, '');
        assert.equal(raw.statusCode, 202);
        assert.equal(raw.getHeader('content-type'), 'text/plain');
        assert.equal(raw.getHeader('x-mode'), 'raw');
        assert.equal(raw.text, 'plain text');
    });

    it('applies CORS headers to normal, error, and preflight responses', async () => {
        @http.controller('/cors')
        class CorsController {
            @http.GET()
            get() {
                return { ok: true };
            }

            @http.GET('/error')
            error() {
                throw new HttpNotFoundError('Missing');
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [CorsController],
            cors: () => ({
                hosts: ['https://app.example.com'],
                paths: ['/cors'],
                credentials: true,
                allowHeaders: ['authorization', 'content-type'],
                exposeHeaders: ['x-request-id']
            })
        });

        const ok = await app.request(HttpRequest.GET('/cors', { origin: 'https://app.example.com' }));
        const error = await app.request(HttpRequest.GET('/cors/error', { origin: 'https://app.example.com' }));
        const preflight = await app.request(
            new HttpRequest('OPTIONS', '/cors', {
                origin: 'https://app.example.com',
                'access-control-request-headers': 'authorization'
            })
        );

        assert.equal(ok.getHeader('access-control-allow-origin'), 'https://app.example.com');
        assert.equal(ok.getHeader('access-control-allow-credentials'), 'true');
        assert.equal(ok.getHeader('access-control-expose-headers'), 'x-request-id');
        assert.equal(error.statusCode, 404);
        assert.equal(error.getHeader('access-control-allow-origin'), 'https://app.example.com');
        assert.equal(preflight.statusCode, 204);
        assert.equal(preflight.getHeader('access-control-allow-origin'), 'https://app.example.com');
        assert.equal(preflight.getHeader('access-control-allow-headers'), 'authorization, content-type');
        assert.equal(preflight.text, '');
    });

    it('resolves controllers with request-scoped DI context', async () => {
        let nextId = 0;
        let nextControllerId = 0;
        let nextSingletonId = 0;

        class RequestState {
            readonly id = ++nextId;
        }

        class SingletonState {
            readonly id = ++nextSingletonId;
        }

        @http.controller('/request-scope')
        class RequestScopeController {
            readonly controllerId = ++nextControllerId;

            constructor(
                private state: RequestState,
                private singleton: SingletonState,
                private constructorRequest: HttpRequest
            ) {}

            @http.GET()
            get(routeRequest: HttpRequest) {
                return {
                    controllerId: this.controllerId,
                    stateId: this.state.id,
                    singletonId: this.singleton.id,
                    sameRequest: this.constructorRequest === routeRequest
                };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [RequestScopeController],
            providers: [{ provide: RequestState, useClass: RequestState, scope: 'request' }, SingletonState]
        });

        const first = await app.request(HttpRequest.GET('/request-scope'));
        const second = await app.request(HttpRequest.GET('/request-scope'));

        assert.notEqual(first.json.controllerId, second.json.controllerId);
        assert.deepStrictEqual(first.json, {
            controllerId: first.json.controllerId,
            stateId: 1,
            singletonId: 1,
            sameRequest: true
        });
        assert.deepStrictEqual(second.json, {
            controllerId: second.json.controllerId,
            stateId: 2,
            singletonId: 1,
            sameRequest: true
        });
    });

    it('runs controller and route middleware before handlers', async () => {
        class MiddlewareLog {
            entries: string[] = [];
        }

        class ControllerMiddleware implements HttpMiddleware {
            constructor(private log: MiddlewareLog) {}

            handle() {
                this.log.entries.push('controller');
            }
        }

        class RouteMiddleware implements HttpMiddleware {
            constructor(private log: MiddlewareLog) {}

            handle() {
                this.log.entries.push('route');
            }
        }

        @(http.controller('/middleware').middleware(ControllerMiddleware))
        class MiddlewareController {
            constructor(private log: MiddlewareLog) {}

            @(http.GET('/alt').middleware(RouteMiddleware))
            get() {
                this.log.entries.push('handler');
                return { entries: this.log.entries };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [MiddlewareController],
            providers: [MiddlewareLog, ControllerMiddleware, RouteMiddleware]
        });

        const response = await app.request(HttpRequest.GET('/middleware/alt'));

        assert.deepStrictEqual(response.json, { entries: ['controller', 'route', 'handler'] });
    });

    it('supports function middleware in standalone and chained decorators', async () => {
        function record(request: HttpRequest, name: string): void {
            const entries = (request.store.middlewareEntries ??= []) as string[];
            entries.push(name);
        }

        function controllerChainMiddleware(request: HttpRequest, response: HttpResponse): void {
            record(request, 'controller-chain');
            response.setHeader('x-controller-middleware', 'yes');
        }

        const controllerDecoratorMiddleware: HttpMiddlewareFunction = async request => {
            await Promise.resolve();
            record(request, 'controller-decorator');
        };

        async function routeChainMiddleware(request: HttpRequest): Promise<void> {
            await Promise.resolve();
            record(request, 'route-chain');
        }

        const routeDecoratorMiddleware: HttpMiddlewareFunction = request => {
            record(request, 'route-decorator');
        };

        @http.middleware(controllerDecoratorMiddleware)
        @(http.controller('/middleware-functions').middleware(controllerChainMiddleware))
        class FunctionMiddlewareController {
            @http.middleware(routeDecoratorMiddleware)
            @(http.GET().middleware(routeChainMiddleware))
            get(request: HttpRequest) {
                return { entries: request.store.middlewareEntries };
            }

            @(http.GET('/stop').use(() => jsonResponse({ stopped: true }, 202)))
            stop() {
                return { stopped: false };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [FunctionMiddlewareController] });

        const response = await app.request(HttpRequest.GET('/middleware-functions'));
        const stopped = await app.request(HttpRequest.GET('/middleware-functions/stop'));

        assert.deepStrictEqual(response.json, {
            entries: ['controller-chain', 'controller-decorator', 'route-chain', 'route-decorator']
        });
        assert.equal(response.getHeader('x-controller-middleware'), 'yes');
        assert.equal(stopped.statusCode, 202);
        assert.deepStrictEqual(stopped.json, { stopped: true });
    });

    it('reuses unregistered zero-argument middleware as a router singleton', async () => {
        let constructions = 0;

        class CachedMiddleware implements HttpMiddleware {
            readonly id = ++constructions;

            handle = (request: HttpRequest): void => {
                const ids = (request.store.middlewareIds ??= []) as number[];
                ids.push(this.id);
            };
        }

        @(http.controller('/middleware-cached').middleware(CachedMiddleware))
        class CachedMiddlewareController {
            @(http.GET().use(CachedMiddleware))
            get(request: HttpRequest) {
                return { ids: request.store.middlewareIds };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [CachedMiddlewareController] });

        const first = await app.request(HttpRequest.GET('/middleware-cached'));
        const second = await app.request(HttpRequest.GET('/middleware-cached'));
        const otherApp = createApp({ controllers: [CachedMiddlewareController] });
        const otherRouter = await otherApp.request(HttpRequest.GET('/middleware-cached'));

        assert.deepStrictEqual(first.json, { ids: [1, 1] });
        assert.deepStrictEqual(second.json, { ids: [1, 1] });
        assert.deepStrictEqual(otherRouter.json, { ids: [2, 2] });
        assert.equal(constructions, 2);
    });

    it('preserves singleton, request, and transient scopes for registered middleware', async () => {
        let singletonConstructions = 0;
        let requestConstructions = 0;
        let transientConstructions = 0;

        function record(request: HttpRequest, scope: string, id: number): void {
            const entries = (request.store.middlewareScopes ??= {}) as Record<string, number[]>;
            (entries[scope] ??= []).push(id);
        }

        class SingletonMiddleware implements HttpMiddleware {
            readonly id = ++singletonConstructions;

            handle(request: HttpRequest): void {
                record(request, 'singleton', this.id);
            }
        }

        class RequestMiddleware implements HttpMiddleware {
            readonly id = ++requestConstructions;

            handle(request: HttpRequest): void {
                record(request, 'request', this.id);
            }
        }

        class TransientMiddleware implements HttpMiddleware {
            readonly id = ++transientConstructions;

            handle(request: HttpRequest): void {
                record(request, 'transient', this.id);
            }
        }

        @http.controller('/middleware-scopes')
        class ScopedMiddlewareController {
            @(http
                .GET()
                .use(SingletonMiddleware, SingletonMiddleware, RequestMiddleware, RequestMiddleware, TransientMiddleware, TransientMiddleware))
            get(request: HttpRequest) {
                return request.store.middlewareScopes;
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [ScopedMiddlewareController],
            providers: [
                SingletonMiddleware,
                { provide: RequestMiddleware, useClass: RequestMiddleware, scope: 'request' },
                { provide: TransientMiddleware, useClass: TransientMiddleware, scope: 'transient' }
            ]
        });

        const first = await app.request(HttpRequest.GET('/middleware-scopes'));
        const second = await app.request(HttpRequest.GET('/middleware-scopes'));

        assert.deepStrictEqual(first.json, {
            singleton: [1, 1],
            request: [1, 1],
            transient: [1, 2]
        });
        assert.deepStrictEqual(second.json, {
            singleton: [1, 1],
            request: [2, 2],
            transient: [3, 4]
        });
    });

    it('orders standalone and chained middleware decorators and shares request-scoped dependencies', async () => {
        let nextRequestStateId = 0;

        class MiddlewareRequestState {
            readonly id = ++nextRequestStateId;
        }

        function recordMiddleware(request: HttpRequest, state: MiddlewareRequestState, name: string): void {
            const entries = (request.store.middlewareEntries ??= []) as Array<{ name: string; stateId: number }>;
            entries.push({ name, stateId: state.id });
        }

        class ControllerChainMiddleware implements HttpMiddleware {
            constructor(
                private state: MiddlewareRequestState,
                private request: HttpRequest
            ) {}

            handle(request: HttpRequest) {
                assert.equal(request, this.request);
                recordMiddleware(request, this.state, 'controller-chain');
            }
        }

        class ControllerDecoratorMiddleware implements HttpMiddleware {
            constructor(
                private state: MiddlewareRequestState,
                private request: HttpRequest
            ) {}

            handle(request: HttpRequest) {
                assert.equal(request, this.request);
                recordMiddleware(request, this.state, 'controller-decorator');
            }
        }

        class RouteChainMiddleware implements HttpMiddleware {
            constructor(private state: MiddlewareRequestState) {}

            handle(request: HttpRequest) {
                recordMiddleware(request, this.state, 'route-chain');
            }
        }

        class RouteDecoratorMiddleware implements HttpMiddleware {
            constructor(private state: MiddlewareRequestState) {}

            handle(request: HttpRequest) {
                recordMiddleware(request, this.state, 'route-decorator');
            }
        }

        @http.middleware(ControllerDecoratorMiddleware)
        @(http.controller('/middleware-forms').middleware(ControllerChainMiddleware))
        class MiddlewareFormsController {
            constructor(private state: MiddlewareRequestState) {}

            @http.middleware(RouteDecoratorMiddleware)
            @(http.GET().middleware(RouteChainMiddleware))
            get(request: HttpRequest) {
                const entries = request.store.middlewareEntries as Array<{ name: string; stateId: number }>;
                return { entries, handlerStateId: this.state.id };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [MiddlewareFormsController],
            providers: [
                { provide: MiddlewareRequestState, useClass: MiddlewareRequestState, scope: 'request' },
                { provide: ControllerChainMiddleware, useClass: ControllerChainMiddleware, scope: 'request' },
                { provide: ControllerDecoratorMiddleware, useClass: ControllerDecoratorMiddleware, scope: 'request' },
                { provide: RouteChainMiddleware, useClass: RouteChainMiddleware, scope: 'request' },
                { provide: RouteDecoratorMiddleware, useClass: RouteDecoratorMiddleware, scope: 'request' }
            ]
        });

        const first = await app.request(HttpRequest.GET('/middleware-forms'));
        const second = await app.request(HttpRequest.GET('/middleware-forms'));

        assert.deepStrictEqual(
            first.json.entries.map((entry: { name: string }) => entry.name),
            ['controller-chain', 'controller-decorator', 'route-chain', 'route-decorator']
        );
        assert.ok(first.json.entries.every((entry: { stateId: number }) => entry.stateId === first.json.handlerStateId));
        assert.ok(second.json.entries.every((entry: { stateId: number }) => entry.stateId === second.json.handlerStateId));
        assert.notEqual(first.json.handlerStateId, second.json.handlerStateId);
    });

    it('allows middleware to short-circuit route handlers', async () => {
        class StopMiddleware implements HttpMiddleware {
            handle() {
                return jsonResponse({ stopped: true }, 202);
            }
        }

        @http.controller('/middleware-stop')
        class MiddlewareStopController {
            @(http.GET().use(StopMiddleware))
            get() {
                return { stopped: false };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [MiddlewareStopController] });

        const response = await app.request(HttpRequest.GET('/middleware-stop'));

        assert.equal(response.statusCode, 202);
        assert.deepStrictEqual(response.json, { stopped: true });
    });

    it('does not direct-construct registered middleware when dependency resolution fails', async () => {
        class MissingDependency {}

        class NeedsDependencyMiddleware implements HttpMiddleware {
            constructor(private _dependency: MissingDependency) {}

            handle() {}
        }

        @http.controller('/middleware-missing-dependency')
        class MiddlewareMissingDependencyController {
            @(http.GET().use(NeedsDependencyMiddleware))
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [MiddlewareMissingDependencyController],
            providers: [NeedsDependencyMiddleware]
        });

        const response = await app.request(HttpRequest.GET('/middleware-missing-dependency'));

        assert.equal(response.statusCode, 500);
        assert.deepStrictEqual(response.json, { error: 'Internal Server Error' });
    });

    it('keeps Node and in-memory routing, header, query, and body normalization in parity', async () => {
        @http.controller('/transport-parity')
        class TransportParityController {
            @http.POST('/:name')
            post(name: HttpPath<string>, query: HttpQueries<{ tag: string[] }>, requestId: HttpHeader<string>, body: HttpBody<{ active: boolean }>) {
                return { name, tags: query.tag, requestId, active: body.active };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [TransportParityController] });
        const path = '/transport-parity/Ada%20Lovelace/?tag=first&tag=second';
        const memory = await app.request(HttpRequest.POST(path, { active: true }, { 'X-Request-ID': 'parity' }));
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const node = await fetch(`http://127.0.0.1:${address.port}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-request-id': 'parity' },
                body: JSON.stringify({ active: true })
            });

            assert.equal(node.status, memory.statusCode);
            assert.deepStrictEqual(await node.json(), memory.json);
            assert.deepStrictEqual(memory.json, {
                name: 'Ada Lovelace',
                tags: ['first', 'second'],
                requestId: 'parity',
                active: true
            });
        } finally {
            await app.stop();
        }
    });

    it('cleans up lifecycle state when HTTP listen fails', async () => {
        process.env.APP_ENV = 'test';
        const firstApp = createApp({});
        process.env.APP_ENV = 'test';
        const secondApp = createApp({});
        const server = await firstApp.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            await assert.rejects(() => secondApp.http.listen(address.port, '127.0.0.1'), {
                code: 'EADDRINUSE'
            });
        } finally {
            await secondApp.stop();
            await firstApp.stop();
        }
    });

    it('lets a controller claim a Node response before piping a delayed stream', async () => {
        @http.controller('/delayed-response-stream')
        class DelayedResponseStreamController {
            @http.GET()
            stream(response: HttpResponse): void {
                response.writeHead(203, 'Delayed Stream', {
                    'content-type': 'text/plain',
                    'x-delayed-stream': 'claimed'
                });

                let scheduled = false;
                const stream = new Readable({
                    read() {
                        if (scheduled) return;
                        scheduled = true;
                        setTimeout(() => {
                            this.push('first ');
                            setTimeout(() => {
                                this.push('second');
                                this.push(null);
                            }, 10);
                        }, 10);
                    }
                });

                // The controller intentionally does not await the pipe. writeHead() must prevent
                // the router from serializing this void return as a 204 response.
                stream.pipe(response).once('error', () => {});
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [DelayedResponseStreamController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await requestNodeHttp(address.port, 'GET', '/delayed-response-stream');

            assert.equal(response.statusCode, 203);
            assert.equal(response.statusMessage, 'Delayed Stream');
            assert.equal(response.headers['content-type'], 'text/plain');
            assert.equal(response.headers['x-delayed-stream'], 'claimed');
            assert.equal(response.text, 'first second');
        } finally {
            await app.stop();
        }
    });

    it('logs a controller-owned stream at takeover and native completion', async () => {
        const entries: LogEntry[] = [];
        let releaseStream!: () => void;
        let controllerClaimed!: () => void;
        const streamReleased = new Promise<void>(resolve => {
            releaseStream = resolve;
        });
        const controllerClaimedResponse = new Promise<void>(resolve => {
            controllerClaimed = resolve;
        });

        @http.controller('/logged-response-stream')
        class LoggedResponseStreamController {
            @http.GET()
            stream(response: HttpResponse): void {
                response.writeHead(200, { 'content-type': 'text/plain' });
                const stream = new Readable({ read() {} });
                stream.pipe(response).once('error', () => {});
                controllerClaimed();
                void streamReleased.then(() => {
                    stream.push('complete');
                    stream.push(null);
                });
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            controllers: [LoggedResponseStreamController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'e2e' }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        const request = requestNodeHttp(address.port, 'GET', '/logged-response-stream');

        try {
            await withTimeout(controllerClaimedResponse, 1_000, 'Controller did not claim the response');
            await waitFor(
                () => entries.some(entry => entry.message === 'Response stream hooked by controller'),
                1_000,
                'Controller response takeover was not logged'
            );
            assert.deepEqual(
                entries.map(entry => entry.message),
                ['Request', 'Response stream hooked by controller']
            );

            releaseStream();
            const response = await withTimeout(request, 1_000, 'Controller-owned stream did not complete');

            assert.equal(response.text, 'complete');
            await waitFor(() => entries.some(entry => entry.message === 'Response'), 1_000, 'Response completion was not logged');
            assert.deepEqual(
                entries.map(entry => entry.message),
                ['Request', 'Response stream hooked by controller', 'Response']
            );
        } finally {
            releaseStream();
            await app.stop();
            resetLogSink();
        }
    });

    it('logs an aborted controller-owned stream without a completion record', async () => {
        const entries: LogEntry[] = [];
        let controllerClaimed!: () => void;
        let stream: Readable | undefined;
        const controllerClaimedResponse = new Promise<void>(resolve => {
            controllerClaimed = resolve;
        });

        @http.controller('/aborted-response-stream')
        class AbortedResponseStreamController {
            @http.GET()
            stream(response: HttpResponse): void {
                response.writeHead(200, { 'content-type': 'text/plain' });
                stream = new Readable({ read() {} });
                stream.pipe(response).once('error', () => {});
                controllerClaimed();
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            controllers: [AbortedResponseStreamController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'e2e' }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        const request = nodeHttpRequest({ host: '127.0.0.1', port: address.port, path: '/aborted-response-stream', method: 'GET' });
        request.on('error', () => {});
        request.end();

        try {
            await withTimeout(controllerClaimedResponse, 1_000, 'Controller did not claim the response');
            await waitFor(
                () => entries.some(entry => entry.message === 'Response stream hooked by controller'),
                1_000,
                'Controller response takeover was not logged'
            );

            request.destroy();
            await waitFor(
                () => entries.some(entry => entry.message === 'Request aborted during processing'),
                1_000,
                'Aborted controller-owned stream was not logged'
            );
            assert.deepEqual(
                entries.map(entry => entry.message),
                ['Request', 'Response stream hooked by controller', 'Request aborted during processing']
            );
        } finally {
            stream?.destroy();
            request.destroy();
            await app.stop();
            resetLogSink();
        }
    });

    it('serves requests through the Node HTTP server', async () => {
        @http.controller('/server')
        class ServerController {
            @http.POST(':id')
            post(id: number, body: HttpBody<{ name: string }>, authorization: HttpHeader<string>, request: HttpRequest) {
                return {
                    id,
                    name: body.name,
                    authorization,
                    method: request.method,
                    mode: request.query.mode,
                    bodyWasPersistedAfterParse: request.body !== undefined,
                    bodyText: request.body?.toString()
                };
            }

            @http.GET('/method')
            getMethod() {
                return { ok: true };
            }

            @http.GET('/raw')
            raw(response: HttpResponse) {
                response.writeHead(201, { 'x-custom-response': 'forwarded' });
                response.end('created');
            }
        }

        @http.controller('/server-stream')
        class StreamController {
            @http.POST()
            async stream(request: HttpRequestStream) {
                const bodyWasBufferedBeforeRead = request.body !== undefined;
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
                const text = Buffer.concat(chunks).toString('utf8');
                return {
                    hasPipe: typeof request.pipe === 'function',
                    bodyWasBufferedBeforeRead,
                    parsedBody: request.parsedBody,
                    uploadedFileCount: Object.keys(request.uploadedFiles).length,
                    bodyWasPersistedAfterStreamRead: request.body !== undefined,
                    sawPayload: text.includes('_payload'),
                    sawFileName: text.includes('stream.txt'),
                    sawFileContents: text.includes('stream-only')
                };
            }
        }

        let releaseSecondResponseChunk: (() => void) | undefined;

        @http.controller('/server-response-stream')
        class ResponseStreamController {
            @http.GET()
            async stream(response: HttpResponse) {
                response.writeHead(200, { 'content-type': 'text/plain' });
                response.write('first\n');
                await new Promise<void>(resolve => {
                    releaseSecondResponseChunk = resolve;
                });
                response.end('second\n');
            }
        }

        @http.controller('/server-body-read')
        class BodyReadController {
            @http.POST()
            async post(request: HttpRequest) {
                const bodyWasBufferedBeforeRead = request.body !== undefined;
                const first = await request.readBodyBuffer();
                const second = await request.readBodyBuffer();
                const text = await request.readBodyText();

                return {
                    bodyWasBufferedBeforeRead,
                    sameBuffer: first === second,
                    bodyWasPersistedAfterRead: request.body === first,
                    text
                };
            }
        }

        class NodeResponseWorkflowHeaderListener {
            @eventDispatcher.listen(httpWorkflow.onResponse, 100)
            onResponse(event: typeof httpWorkflow.onResponse.event) {
                if (!event.response.headersSent) event.response.setHeader('x-node-workflow', 'yes');
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [ServerController, StreamController, ResponseStreamController, BodyReadController],
            listeners: [NodeResponseWorkflowHeaderListener],
            cors: { hosts: ['https://node.example.com'] }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;

        try {
            const response = await fetch(`http://127.0.0.1:${address.port}/server/42?mode=node`, {
                method: 'POST',
                headers: { authorization: 'Bearer node', 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Alpha' })
            });
            const streamForm = new FormData();
            streamForm.set('_payload', JSON.stringify({ description: 'stream' }));
            streamForm.set('file', new Blob(['stream-only'], { type: 'text/plain' }), 'stream.txt');
            const streamOnly = await fetch(`http://127.0.0.1:${address.port}/server-stream`, {
                method: 'POST',
                body: streamForm
            });
            const bodyRead = await fetch(`http://127.0.0.1:${address.port}/server-body-read`, {
                method: 'POST',
                headers: { 'content-type': 'text/plain' },
                body: 'cache-me'
            });
            const streamedResponsePromise = fetch(`http://127.0.0.1:${address.port}/server-response-stream`, {
                headers: { origin: 'https://node.example.com' }
            });
            await waitFor(() => releaseSecondResponseChunk !== undefined, 500, 'streaming response handler did not start');
            const streamedResponse = await withTimeout(
                streamedResponsePromise,
                500,
                'response stream did not flush headers before handler completion'
            );
            const reader = streamedResponse.body!.getReader();
            const firstStreamChunk = await withTimeout(reader.read(), 500, 'response stream did not flush first chunk');
            releaseSecondResponseChunk!();
            const secondStreamChunk = await withTimeout(reader.read(), 500, 'response stream did not flush second chunk');
            const raw = await fetch(`http://127.0.0.1:${address.port}/server/raw`);
            const unsupported = await requestNodeHttp(address.port, 'TRACE', '/server/method');

            assert.equal(response.status, 200);
            assert.equal(response.headers.get('x-node-workflow'), 'yes');
            assert.deepStrictEqual(await response.json(), {
                id: 42,
                name: 'Alpha',
                authorization: 'Bearer node',
                method: 'POST',
                mode: 'node',
                bodyWasPersistedAfterParse: true,
                bodyText: JSON.stringify({ name: 'Alpha' })
            });
            assert.equal(streamOnly.status, 200);
            assert.deepStrictEqual(await streamOnly.json(), {
                hasPipe: true,
                bodyWasBufferedBeforeRead: false,
                uploadedFileCount: 0,
                bodyWasPersistedAfterStreamRead: false,
                sawPayload: true,
                sawFileName: true,
                sawFileContents: true
            });
            assert.equal(bodyRead.status, 200);
            assert.deepStrictEqual(await bodyRead.json(), {
                bodyWasBufferedBeforeRead: false,
                sameBuffer: true,
                bodyWasPersistedAfterRead: true,
                text: 'cache-me'
            });
            assert.equal(streamedResponse.status, 200);
            assert.equal(streamedResponse.headers.get('x-node-workflow'), null);
            assert.equal(streamedResponse.headers.get('access-control-allow-origin'), 'https://node.example.com');
            assert.equal(new TextDecoder().decode(firstStreamChunk.value), 'first\n');
            assert.equal(new TextDecoder().decode(secondStreamChunk.value), 'second\n');
            assert.equal(raw.status, 201);
            assert.equal(raw.headers.get('x-custom-response'), 'forwarded');
            assert.equal(raw.headers.get('x-node-workflow'), null);
            assert.equal(await raw.text(), 'created');
            assert.equal(unsupported.statusCode, 404);
            assert.deepStrictEqual(JSON.parse(unsupported.text), { error: 'Not Found' });
        } finally {
            await app.stop();
        }

        assert.equal(server.listening, false);
    });

    it('does not reject upgrades claimed by app-level upgrade handlers', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({});
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        let handled = false;

        server.on('upgrade', (request, socket) => {
            if (request.url !== '/custom-upgrade') return;
            handled = true;
            setTimeout(() => {
                socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: custom\r\n\r\n');
                setTimeout(() => socket.end(), 1100).unref();
            }, 20).unref();
        });

        try {
            const response = await requestRawUpgrade(address.port, '/custom-upgrade');

            assert.equal(handled, true);
            assert.match(response, /^HTTP\/1\.1 101/);
            assert.doesNotMatch(response, /400 Bad Request/);
        } finally {
            await app.stop();
        }
    });
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function requestNodeHttp(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string> = {}
): Promise<{ statusCode: number; statusMessage: string; headers: Record<string, string | string[] | undefined>; text: string }> {
    return new Promise((resolve, reject) => {
        const request = nodeHttpRequest({ host: '127.0.0.1', port, path, method, headers }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('end', () => {
                resolve({
                    statusCode: response.statusCode ?? 0,
                    statusMessage: response.statusMessage ?? '',
                    headers: response.headers,
                    text: Buffer.concat(chunks).toString()
                });
            });
        });
        request.on('error', reject);
        request.end();
    });
}

function requestRawUpgrade(port: number, path: string): Promise<string> {
    const socket = new Socket();
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on('data', data => chunks.push(Buffer.from(data)));
        socket.once('error', reject);
        socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        socket.once('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
        socket.connect(port, '127.0.0.1', () => {
            socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: custom\r\n\r\n`);
        });
    }).finally(() => socket.destroy());
}

function makeMultipartBody(parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>): {
    contentType: string;
    body: Buffer;
} {
    const boundary = `tsf-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];

    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"`));
        if (part.filename) chunks.push(Buffer.from(`; filename="${part.filename}"`));
        chunks.push(Buffer.from('\r\n'));
        if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
        chunks.push(Buffer.from('\r\n'));
        chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
        chunks.push(Buffer.from('\r\n'));
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return {
        contentType: `multipart/form-data; boundary=${boundary}`,
        body: Buffer.concat(chunks)
    };
}

function listUploadTempDirs(): string[] {
    return readdirSync(tmpdir())
        .filter(name => name.startsWith('tsf-upload-'))
        .sort();
}
