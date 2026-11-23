import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createApp,
    http,
    openapi,
    serializeOpenApiSchema,
    type HttpBody,
    type HttpPath,
    type HttpQueries,
    type HttpQuery,
    type OpenApiContributor,
    type OpenApiOperation,
    type OpenApiReferenceObject,
    type OpenApiSchemaObject,
    ReflectionClass
} from '../src';

interface DocWidget {
    /**
     * Stable identifier.
     *
     * Never reused.
     */
    id: string;
    /**
     * Old name.
     * @deprecated Use `title`.
     * @sunset 2027-06-30
     */
    name: string;
    /** @deprecated */
    legacy?: string;
    title: string;
}

class DocWidgetFilter {
    /** Free-text search. */
    q?: string;
    /**
     * Page size.
     * @deprecated Use `cursor`.
     */
    limit?: number;
}

class DocWidgetRecord {
    /** The owning widget. */
    widget!: DocWidget;
    /**
     * The widget again.
     * @deprecated Embed it instead.
     * @sunset 2027-01-01
     */
    previous?: DocWidget;
}

/**
 * Manages widgets.
 *
 * Widgets are the unit of billing.
 */
@http.controller('/widgets')
class DocWidgetsController {
    /**
     * Fetch a widget.
     *
     * Looks the widget up by id.
     *
     * - first
     * - second
     *
     * ```ts
     * const widget = await get('1');
     *
     * // @param stays in the code sample
     * ```
     *
     * @param id - The widget id.
     * @param verbose Include everything.
     * @returns The widget, if it exists.
     */
    @http.GET('/:id')
    async get(id: HttpPath<string>, verbose?: HttpQuery<boolean>): Promise<DocWidget> {
        return { id, name: '', title: String(verbose) };
    }

    /**
     * Search widgets.
     * @param filter Ignored: expanded properties use their own docs.
     */
    @http.GET()
    async search(filter: HttpQueries<DocWidgetFilter>): Promise<DocWidget[]> {
        void filter;
        return [];
    }

    /**
     * Create a widget.
     * @param body The widget to create.
     */
    @http.POST()
    async create(body: HttpBody<DocWidget>): Promise<void> {
        void body;
    }

    /**
     * Old way to list.
     *
     * Lists everything.
     * @deprecated Use search instead.
     * @sunset 2027-03-04
     */
    @http.GET('/legacy')
    async legacyList(
        /** Search text. */
        q?: HttpQuery<string>,
        /** @deprecated No longer used. */
        old?: HttpQuery<string>
    ): Promise<void> {
        void q;
        void old;
    }

    /**
     * Retire.
     * @deprecated
     */
    @http.DELETE('/:id')
    async retire(id: HttpPath<string>): Promise<void> {
        void id;
    }

    @http.GET('/records')
    async records(): Promise<DocWidgetRecord> {
        return { widget: { id: '', name: '', title: '' } };
    }
}

function documentFor(controller: new (...args: never[]) => unknown, contributors?: OpenApiContributor[]) {
    return serializeOpenApiSchema(createApp({ controllers: [controller as never], enableHealthcheck: false, openapi: { contributors } }));
}

const asSchema = (value: OpenApiSchemaObject | OpenApiReferenceObject | undefined) => value as OpenApiSchemaObject;

describe('openapi JSDoc documentation', () => {
    it('reflects descriptions, properties and parameter docs at runtime', () => {
        const reflection = ReflectionClass.from(DocWidgetsController);
        assert.equal(reflection.getDescription(), 'Manages widgets.\n\nWidgets are the unit of billing.');
        const method = reflection.getMethod('get');
        assert.equal(method.getDescription(), 'Fetch a widget.');
        assert.deepEqual(method.getDocs()?.params, { id: 'The widget id.', verbose: 'Include everything.' });
        assert.equal(method.getDocs()?.returns, 'The widget, if it exists.');
        assert.equal(ReflectionClass.from(DocWidgetFilter).getProperty('limit').getDeprecated(), 'Use `cursor`.');
        assert.equal(ReflectionClass.from(DocWidgetFilter).getProperty('q').getDeprecated(), undefined);
        const legacy = reflection.getMethod('legacyList');
        assert.equal(legacy.getDeprecated(), 'Use search instead.');
        assert.equal(legacy.getSunset(), '2027-03-04');
        assert.equal(legacy.getParameters()[0].getDescription(), 'Search text.');
        assert.equal(legacy.getParameters()[1].getDeprecated(), 'No longer used.');
        assert.equal(reflection.getMethod('retire').getDeprecated(), '');
    });

    it('uses the first paragraph as summary and the rest as the description', () => {
        const get = documentFor(DocWidgetsController).paths['/widgets/{id}'].get!;
        assert.equal(get.summary, 'Fetch a widget.');
        assert.equal(
            get.description,
            [
                'Looks the widget up by id.',
                '',
                '- first',
                '- second',
                '',
                '```ts',
                "const widget = await get('1');",
                '',
                '// @param stays in the code sample',
                '```'
            ].join('\n')
        );
    });

    it('documents @param on path, query and body parameters, and @returns', () => {
        const doc = documentFor(DocWidgetsController);
        const get = doc.paths['/widgets/{id}'].get!;
        assert.equal(get.parameters?.find(parameter => parameter.name === 'id')?.description, 'The widget id.');
        assert.equal(get.parameters?.find(parameter => parameter.name === 'verbose')?.description, 'Include everything.');
        assert.equal(get.responses['200'].description, 'The widget, if it exists.');
        assert.equal(doc.paths['/widgets'].post!.requestBody?.description, 'The widget to create.');
        assert.equal(doc.paths['/widgets'].post!.responses['200'].description, 'OK');
        assert.equal(doc.paths['/widgets/{id}'].delete!.responses['200'].description, 'OK');
    });

    it('uses property docs for object-expanded query parameters', () => {
        const parameters = documentFor(DocWidgetsController).paths['/widgets'].get!.parameters ?? [];
        const q = parameters.find(parameter => parameter.name === 'q')!;
        const limit = parameters.find(parameter => parameter.name === 'limit')!;
        assert.equal(q.description, 'Free-text search.');
        assert.equal(q.deprecated, undefined);
        assert.equal(limit.deprecated, true);
        assert.equal(limit.description, 'Page size.\n\n**Deprecated:** Use `cursor`.');
    });

    it('marks deprecated operations and parameters, with sunset dates', () => {
        const doc = documentFor(DocWidgetsController);
        const legacy = doc.paths['/widgets/legacy'].get!;
        assert.equal(legacy.deprecated, true);
        assert.equal(legacy['x-sunset'], '2027-03-04');
        assert.equal(legacy.summary, 'Old way to list.');
        assert.equal(legacy.description, 'Lists everything.\n\n**Deprecated:** Use search instead.');
        const [q, old] = legacy.parameters!;
        assert.equal(q.description, 'Search text.');
        assert.equal(q.deprecated, undefined);
        assert.equal(old.deprecated, true);
        assert.equal(old.description, '**Deprecated:** No longer used.');

        const retire = doc.paths['/widgets/{id}'].delete!;
        assert.equal(retire.deprecated, true);
        assert.equal(retire.description, undefined);
        assert.equal(retire['x-sunset'], undefined);
    });

    it('documents deprecated properties and keeps docs next to $ref', () => {
        const doc = documentFor(DocWidgetsController);
        const widget = doc.components!.schemas!.DocWidget;
        assert.equal(asSchema(widget.properties?.id).description, 'Stable identifier.\n\nNever reused.');
        const name = asSchema(widget.properties?.name);
        assert.equal(name.deprecated, true);
        assert.equal(name['x-sunset'], '2027-06-30');
        assert.equal(name.description, 'Old name.\n\n**Deprecated:** Use `title`.');
        const legacy = asSchema(widget.properties?.legacy);
        assert.equal(legacy.deprecated, true);
        assert.equal(legacy.description, undefined);

        const record = doc.components!.schemas!.DocWidgetRecord;
        assert.deepStrictEqual(record.properties?.widget, { $ref: '#/components/schemas/DocWidget', description: 'The owning widget.' });
        assert.deepStrictEqual(record.properties?.previous, {
            $ref: '#/components/schemas/DocWidget',
            description: 'The widget again.\n\n**Deprecated:** Embed it instead.',
            deprecated: true,
            'x-sunset': '2027-01-01'
        });
    });

    it('describes the controller tag', () => {
        const doc = documentFor(DocWidgetsController);
        assert.deepStrictEqual(doc.tags, [{ name: 'docWidgets', description: 'Manages widgets.\n\nWidgets are the unit of billing.' }]);
        assert.equal(documentFor(UndocumentedController).tags, undefined);
    });
});

@http.controller('/plain')
class UndocumentedController {
    @http.GET()
    async list(): Promise<string> {
        return '';
    }
}

describe('openapi contributors', () => {
    @openapi.operation({ extensions: { 'x-controller': 'c' }, description: 'Controller description.' })
    @http.controller('/contrib')
    class ContribController {
        /** Inferred summary. */
        @http.GET('/one')
        one(): string {
            return '';
        }

        @openapi.operation({ operationId: 'explicitTwo', summary: 'Method summary' })
        @http.GET('/two')
        two(): string {
            return '';
        }
    }

    it('layers inferred, contributors in order, controller, then method', () => {
        const seen: Array<{ route: string; inferred: string | undefined; defaultOperationId: string }> = [];
        const first: OpenApiContributor = {
            name: 'first',
            operation: ({ route, inferred, defaultOperationId }) => {
                seen.push({ route: route.path, inferred: inferred.summary, defaultOperationId });
                return {
                    summary: 'First summary',
                    description: 'First description',
                    tags: ['first'],
                    extensions: { 'x-a': 1, 'x-shared': 'first' },
                    securitySchemes: { keyAuth: { type: 'apiKey', in: 'header', name: 'x-key' } },
                    security: [{ keyAuth: [] }],
                    appendDescription: ['First appendix.']
                };
            }
        };
        const second: OpenApiContributor = {
            name: 'second',
            operation: () => ({
                summary: 'Second summary',
                extensions: { 'x-b': 2, 'x-shared': 'second' },
                securitySchemes: { keyAuth: { type: 'apiKey', in: 'header', name: 'x-key' } },
                appendDescription: ['Second appendix.']
            })
        };
        const doc = documentFor(ContribController, [first, second]);
        const one = doc.paths['/contrib/one'].get!;
        assert.equal(one.summary, 'Second summary');
        assert.deepEqual(one.tags, ['first']);
        assert.equal(one['x-a'], 1);
        assert.equal(one['x-b'], 2);
        assert.equal(one['x-shared'], 'second');
        assert.equal(one['x-controller'], 'c');
        assert.deepEqual(one.security, [{ keyAuth: [] }]);
        assert.deepEqual(doc.components?.securitySchemes?.keyAuth, { type: 'apiKey', in: 'header', name: 'x-key' });
        // Controller openapi.operation() replaces the contributor description; appendices follow it.
        assert.equal(one.description, 'Controller description.\n\nFirst appendix.\n\nSecond appendix.');
        assert.deepEqual(seen[0], { route: '/contrib/one', inferred: 'Inferred summary.', defaultOperationId: 'getContribOne' });

        const two = doc.paths['/contrib/two'].get!;
        assert.equal(two.operationId, 'explicitTwo');
        assert.equal(two.summary, 'Method summary');
    });

    it('lets SerializeOpenApiOptions.contributors replace registered ones', () => {
        const registered: OpenApiContributor = { name: 'registered', operation: () => ({ summary: 'registered' }) };
        const override: OpenApiContributor = { name: 'override', operation: () => ({ summary: 'override' }) };
        const app = createApp({ controllers: [ContribController], enableHealthcheck: false, openapi: { contributors: [registered] } });
        assert.equal(serializeOpenApiSchema(app).paths['/contrib/one'].get!.summary, 'registered');
        assert.equal(serializeOpenApiSchema(app, { contributors: [override] }).paths['/contrib/one'].get!.summary, 'override');
    });

    it('appends contributor paragraphs when nothing else sets a description', () => {
        @http.controller('/append')
        class AppendController {
            @http.GET()
            list(): string {
                return '';
            }
        }
        const doc = documentFor(AppendController, [{ name: 'append', operation: () => ({ appendDescription: ['One.', 'Two.'] }) }]);
        assert.equal(doc.paths['/append'].get!.description, 'One.\n\nTwo.');
    });

    it('conflicting contributor security schemes fail', () => {
        const a: OpenApiContributor = { name: 'a', operation: () => ({ securitySchemes: { s: { type: 'http', scheme: 'basic' } } }) };
        const b: OpenApiContributor = { name: 'b', operation: () => ({ securitySchemes: { s: { type: 'http', scheme: 'digest' } } }) };
        assert.throws(() => documentFor(ContribController, [a, b]), /Conflicting OpenAPI security scheme s/);
    });

    it('calls validateOperation on every contributor with the final operation and ids', () => {
        const calls: Array<{ contributor: string; path: string; operationId: string; explicit?: string; defaultId: string }> = [];
        const record = (name: string): OpenApiContributor => ({
            name,
            validateOperation: ({
                route,
                operation,
                explicitOperationId,
                defaultOperationId
            }: {
                route: { path: string };
                operation: Readonly<OpenApiOperation>;
                explicitOperationId?: string;
                defaultOperationId: string;
            }) => {
                calls.push({
                    contributor: name,
                    path: route.path,
                    operationId: operation.operationId,
                    explicit: explicitOperationId,
                    defaultId: defaultOperationId
                });
            }
        });
        documentFor(ContribController, [record('x'), record('y')]);
        assert.deepEqual(
            calls.filter(call => call.path === '/contrib/two'),
            [
                { contributor: 'x', path: '/contrib/two', operationId: 'explicitTwo', explicit: 'explicitTwo', defaultId: 'getContribTwo' },
                { contributor: 'y', path: '/contrib/two', operationId: 'explicitTwo', explicit: 'explicitTwo', defaultId: 'getContribTwo' }
            ]
        );
        assert.equal(calls.find(call => call.path === '/contrib/one' && call.contributor === 'x')?.explicit, undefined);

        assert.throws(
            () =>
                documentFor(ContribController, [
                    {
                        name: 'strict',
                        validateOperation: ({ operation }: { operation: Readonly<OpenApiOperation> }) => {
                            if (operation.operationId === 'explicitTwo') throw new Error(`missing description on ${operation.operationId}`);
                        }
                    }
                ]),
            /missing description/
        );
    });

    it('calls document once with the finished document and every route, including ignored and internal ones', () => {
        @openapi.ignore()
        @http.controller('/hidden')
        class HiddenController {
            @http.GET()
            hidden(): string {
                return '';
            }
        }
        const calls: Array<{ paths: string[]; routes: string[] }> = [];
        const app = createApp({
            controllers: [ContribController, HiddenController],
            enableHealthcheck: true,
            openapi: {
                contributors: [
                    {
                        name: 'doc',
                        document: (document, routes) => {
                            calls.push({ paths: Object.keys(document.paths).sort(), routes: routes.map(route => route.path).sort() });
                        }
                    }
                ]
            }
        });
        serializeOpenApiSchema(app);
        assert.equal(calls.length, 1);
        assert.ok(!calls[0].paths.includes('/hidden'));
        assert.ok(!calls[0].paths.includes('/healthz'));
        assert.ok(calls[0].routes.includes('/hidden'));
        assert.ok(calls[0].routes.includes('/healthz'));

        assert.throws(
            () =>
                serializeOpenApiSchema(app, {
                    contributors: [
                        {
                            name: 'fail',
                            document: () => {
                                throw new Error('document rejected');
                            }
                        }
                    ]
                }),
            /document rejected/
        );
    });
});
