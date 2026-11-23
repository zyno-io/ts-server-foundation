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
    ParsedJwt,
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

/** A documented class DTO. */
class DocumentedDto {
    /** Identifier. */
    id!: string;
}

/**
 * Lifecycle state.
 *
 * Moves forward only.
 */
type DocumentedState = 'draft' | 'live';

class DeprecatedAggregate {
    /** Free text. */
    text?: string;
    other?: number;
}

@http.controller('/extra')
class ExtraDocsController {
    /** Summary only. */
    @http.GET('/summary-only')
    summaryOnly(): string {
        return '';
    }

    @http.GET('/plain-twin')
    plainTwin(): string {
        return '';
    }

    @http.GET('/dto')
    dto(): { dto: DocumentedDto; state: DocumentedState } {
        return { dto: { id: '' }, state: 'draft' };
    }

    /**
     * Wire names.
     * @param id The TypeScript name wins.
     * @param other Belongs to the parameter named other in TypeScript.
     */
    @http.GET('/wire/:id')
    wire(id: HttpPath<string>, other?: HttpQuery<string, { name: 'renamed' }>, third?: HttpQuery<string, { name: 'other' }>): string {
        void id;
        void other;
        void third;
        return '';
    }

    /**
     * Fallback.
     * @param q Matches the wire name because no parameter is called q.
     */
    @http.GET('/fallback')
    fallback(search?: HttpQuery<string, { name: 'q' }>): string {
        void search;
        return '';
    }

    @http.GET('/aggregate')
    aggregate(
        /**
         * @deprecated Use search.
         * @sunset 2027-05-05
         */
        query: HttpQueries<DeprecatedAggregate>
    ): string {
        void query;
        return '';
    }
}

@openapi.operation({ securitySchemes: { shared: { type: 'http', scheme: 'basic' } }, security: [{ shared: [] }] })
@http.controller('/schemes')
class SchemesController {
    @http.GET()
    list(): string {
        return '';
    }
}

@http.controller('/jwt')
class JwtController {
    @http.GET()
    read(_jwt: ParsedJwt): string {
        return '';
    }
}

describe('openapi docs review fixes', () => {
    it('describes class DTO and non-object alias components from their JSDoc', () => {
        const doc = documentFor(ExtraDocsController);
        assert.equal(doc.components!.schemas!.DocumentedDto.description, 'A documented class DTO.');
        const state = doc.components!.schemas!.DocumentedState;
        assert.equal(state.description, 'Lifecycle state.\n\nMoves forward only.');
        assert.ok(state.enum || state.anyOf || state.oneOf || state.allOf || state.type);
    });

    it('a summary-only JSDoc adds no description', () => {
        const paths = documentFor(ExtraDocsController).paths;
        const documented = paths['/extra/summary-only'].get!;
        const twin = paths['/extra/plain-twin'].get!;
        assert.equal(documented.description, undefined);
        assert.equal(documented.deprecated, undefined);
        const strip = ({ operationId: _id, summary: _summary, ...rest }: OpenApiOperation) => rest;
        assert.deepStrictEqual(strip(documented), strip(twin));
    });

    it('matches @param by TypeScript name before the wire name', () => {
        const params = documentFor(ExtraDocsController).paths['/extra/wire/{id}'].get!.parameters!;
        const byName = (name: string) => params.find(parameter => parameter.name === name)!;
        assert.equal(byName('id').description, 'The TypeScript name wins.');
        assert.equal(byName('renamed').description, 'Belongs to the parameter named other in TypeScript.');
        assert.equal(byName('other').description, undefined);
        const fallback = documentFor(ExtraDocsController).paths['/extra/fallback'].get!.parameters!;
        assert.equal(fallback[0].description, 'Matches the wire name because no parameter is called q.');
    });

    it('propagates @deprecated and @sunset of an HttpQueries aggregate to each expanded parameter', () => {
        const op = documentFor(ExtraDocsController).paths['/extra/aggregate'].get!;
        assert.equal(op.deprecated, undefined);
        for (const parameter of op.parameters!) {
            assert.equal(parameter.deprecated, true);
            assert.equal(parameter['x-sunset'], '2027-05-05');
        }
        assert.equal(op.parameters!.find(parameter => parameter.name === 'text')!.description, 'Free text.\n\n**Deprecated:** Use search.');
        assert.equal(op.parameters!.find(parameter => parameter.name === 'other')!.description, '**Deprecated:** Use search.');
    });

    it('gives each contributor its own copy of the inferred operation', () => {
        const seen: Array<string | undefined> = [];
        const mutator: OpenApiContributor = {
            name: 'mutator',
            operation: ({ inferred }) => {
                (inferred as OpenApiOperation).summary = 'tampered';
                (inferred.tags as string[]).push('tampered');
                return undefined;
            }
        };
        const observer: OpenApiContributor = {
            name: 'observer',
            operation: ({ route, inferred }) => {
                if (route.path === '/extra/summary-only') seen.push(inferred.summary, inferred.tags?.join(','));
                return undefined;
            }
        };
        documentFor(ExtraDocsController, [mutator, observer]);
        assert.deepEqual(seen, ['Summary only.', 'extraDocs']);
    });

    it('rejects contributors that set operationId or non-x- extensions', () => {
        const withOperationId = { name: 'ids', operation: () => ({ operationId: 'nope' }) } as unknown as OpenApiContributor;
        assert.throws(() => documentFor(ExtraDocsController, [withOperationId]), /cannot set operationId/);
        const badExtension = { name: 'ext', operation: () => ({ extensions: { owner: 'x' } }) } as unknown as OpenApiContributor;
        assert.throws(() => documentFor(ExtraDocsController, [badExtension]), /extensions must start with x-/);
    });

    it('keeps the required ParsedJwt bearerAuth rule for contributor security', () => {
        const removes: OpenApiContributor = { name: 'removes', operation: () => ({ security: [] }) };
        assert.throws(() => documentFor(JwtController, [removes]), /cannot remove required ParsedJwt authentication/);
        const adds: OpenApiContributor = {
            name: 'adds',
            operation: () => ({
                security: [{ bearerAuth: [], extra: [] }],
                securitySchemes: { extra: { type: 'apiKey', in: 'header', name: 'x-extra' } }
            })
        };
        const doc = documentFor(JwtController, [adds]);
        assert.deepEqual(doc.paths['/jwt'].get!.security, [{ bearerAuth: [], extra: [] }]);
    });

    it('fails when a contributor scheme conflicts with a decorator scheme', () => {
        const conflicting: OpenApiContributor = {
            name: 'conflicting',
            operation: () => ({ securitySchemes: { shared: { type: 'http', scheme: 'digest' } } })
        };
        assert.throws(() => documentFor(SchemesController, [conflicting]), /Conflicting OpenAPI security scheme shared/);
        const same: OpenApiContributor = { name: 'same', operation: () => ({ securitySchemes: { shared: { type: 'http', scheme: 'basic' } } }) };
        assert.doesNotThrow(() => documentFor(SchemesController, [same]));
    });
});
