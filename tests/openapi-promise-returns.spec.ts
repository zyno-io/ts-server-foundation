import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createApp,
    http,
    HttpRequest,
    serializeOpenApiSchema,
    type ApiResponse,
    type OpenApiOperation,
    type OpenApiReferenceObject,
    type OpenApiSchemaObject
} from '../src';
import type { EmptyResponse, RedirectResponse } from './openapi-promise-returns-barrel';

interface PromiseReturnDto {
    id: string;
    count: number;
}

class PromiseReturnService {
    async load(): Promise<PromiseReturnDto> {
        return { id: '', count: 0 };
    }

    async create(): ApiResponse<PromiseReturnDto, 201> {
        return { id: '', count: 0 };
    }

    async remove(): EmptyResponse {}

    async move(): RedirectResponse {}
}

type PromiseReturnAlias = Promise<PromiseReturnDto>;
type PromiseReturnAsync<T> = Promise<T>;
interface PromiseReturnApi {
    load: Promise<PromiseReturnDto>;
}

@http.controller('/direct')
class DirectPromiseReturnsController {
    @http.GET('/return-type')
    async returnType(): ReturnType<PromiseReturnService['load']> {
        return { id: '', count: 0 };
    }

    @http.GET('/alias')
    async alias(): PromiseReturnAlias {
        return { id: '', count: 0 };
    }

    @http.GET('/generic')
    async generic(): PromiseReturnAsync<PromiseReturnDto> {
        return { id: '', count: 0 };
    }

    @http.GET('/indexed')
    async indexed(): PromiseReturnApi['load'] {
        return { id: '', count: 0 };
    }

    @http.POST('/created')
    async created(): ReturnType<PromiseReturnService['create']> {
        return { id: '', count: 0 };
    }

    @http.DELETE('/empty')
    async empty(): ReturnType<PromiseReturnService['remove']> {}

    @http.DELETE('/empty-barrel')
    async emptyBarrel(): EmptyResponse {}

    @http.GET('/redirect')
    async redirect(): ReturnType<PromiseReturnService['move']> {}
}

/** Registers a route through http verbs, as wrapper decorators in consuming libraries do. */
function WrappedPromiseRoute(method: 'GET' | 'POST' | 'DELETE', path?: string) {
    return function <T extends object>(target: T, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        return http[method](path)(target, propertyKey, descriptor);
    };
}

@http.controller('/wrapped')
class WrappedPromiseReturnsController {
    @WrappedPromiseRoute('GET', '/return-type')
    async returnType(): ReturnType<PromiseReturnService['load']> {
        return { id: '', count: 0 };
    }

    @WrappedPromiseRoute('GET', '/alias')
    async alias(): PromiseReturnAlias {
        return { id: '', count: 0 };
    }

    @WrappedPromiseRoute('GET', '/generic')
    async generic(): PromiseReturnAsync<PromiseReturnDto> {
        return { id: '', count: 0 };
    }

    @WrappedPromiseRoute('GET', '/indexed')
    async indexed(): PromiseReturnApi['load'] {
        return { id: '', count: 0 };
    }

    @WrappedPromiseRoute('POST', '/created')
    async created(): ReturnType<PromiseReturnService['create']> {
        return { id: '', count: 0 };
    }

    @WrappedPromiseRoute('DELETE', '/empty')
    async empty(): ReturnType<PromiseReturnService['remove']> {}

    @WrappedPromiseRoute('DELETE', '/empty-barrel')
    async emptyBarrel(): EmptyResponse {}

    @WrappedPromiseRoute('GET', '/redirect')
    async redirect(): ReturnType<PromiseReturnService['move']> {}
}

function documentFor(controller: new (...args: never[]) => unknown) {
    return serializeOpenApiSchema(createApp({ controllers: [controller as never], enableHealthcheck: false }));
}

for (const [label, controller, prefix] of [
    ['TSF http verb decorators', DirectPromiseReturnsController, '/direct'],
    ['wrapper decorators', WrappedPromiseReturnsController, '/wrapped']
] as const) {
    describe(`openapi Promise return types spelled through aliases (${label})`, () => {
        const doc = documentFor(controller);
        const resolve = (schema: OpenApiSchemaObject | OpenApiReferenceObject | undefined): OpenApiSchemaObject => {
            if (schema && '$ref' in schema) return doc.components!.schemas![schema.$ref.replace('#/components/schemas/', '')];
            return schema as OpenApiSchemaObject;
        };
        const responseSchema = (operation: OpenApiOperation | undefined, status: string) =>
            resolve(operation?.responses[status]?.content?.['application/json']?.schema);
        const assertDto = (schema: OpenApiSchemaObject, route: string) => {
            assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['count', 'id'], `${route} describes ${JSON.stringify(schema)}`);
        };

        for (const route of ['return-type', 'alias', 'generic', 'indexed']) {
            it(`describes the awaited type of ${route}`, () => {
                assertDto(responseSchema(doc.paths[`${prefix}/${route}`].get, '200'), route);
            });
        }

        it('keeps the ApiResponse status of a ReturnType', () => {
            const post = doc.paths[`${prefix}/created`].post;
            assert.equal(post?.responses['200'], undefined);
            assertDto(responseSchema(post, '201'), 'created');
        });

        it('keeps EmptyResponse and RedirectResponse reached through ReturnType or a barrel', () => {
            assert.deepEqual(Object.keys(doc.paths[`${prefix}/empty`].delete!.responses), ['204']);
            assert.deepEqual(Object.keys(doc.paths[`${prefix}/empty-barrel`].delete!.responses), ['204']);
            assert.deepEqual(Object.keys(doc.paths[`${prefix}/redirect`].get!.responses), ['302']);
        });

        it('answers EmptyResponse routes with 204', async () => {
            process.env.APP_ENV = 'test';
            const app = createApp({ controllers: [controller as never], enableHealthcheck: false });
            assert.equal((await app.request(HttpRequest.DELETE(`${prefix}/empty`))).statusCode, 204);
            assert.equal((await app.request(HttpRequest.DELETE(`${prefix}/empty-barrel`))).statusCode, 204);
        });
    });
}
