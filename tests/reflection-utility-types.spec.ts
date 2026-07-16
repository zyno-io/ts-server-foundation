import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    createOpenApiSchemaContext,
    deserialize,
    listOpenApiTypeProperties,
    ReflectionKind,
    registerClassMetadata,
    typeOf,
    typeToOpenApiSchema,
    validate,
    validatedDeserialize,
    type ClassMetadata,
    type OpenApiReferenceObject,
    type OpenApiSchemaObject,
    type OptionalNulls,
    type Type,
    type TypePropertySignature
} from '../src';

const stringType: Type = { kind: ReflectionKind.string };
const numberType: Type = { kind: ReflectionKind.number };
const booleanType: Type = { kind: ReflectionKind.boolean };

function property(name: string, type: Type, optional = false) {
    return { name, type, optional };
}

function signature(name: string, type: Type, optional = false): TypePropertySignature {
    return { kind: ReflectionKind.propertySignature, name, type, optional };
}

function literal(value: unknown): Type {
    return { kind: ReflectionKind.literal, literal: value };
}

function union(...types: Type[]): Type {
    return { kind: ReflectionKind.union, types };
}

function objectLiteral(types: TypePropertySignature[], typeName?: string): Type {
    return { kind: ReflectionKind.objectLiteral, typeName, types };
}

function typiaTag(kind: string, value?: Type, schema?: Type): Type {
    const tagFields = [signature('kind', literal(kind))];
    if (value) tagFields.push(signature('value', value));
    if (schema) tagFields.push(signature('schema', schema));
    return objectLiteral([signature('typia.tag', objectLiteral(tagFields))]);
}

function schemaObject(
    value: OpenApiSchemaObject | OpenApiReferenceObject | undefined,
    context?: ReturnType<typeof createOpenApiSchemaContext>
): OpenApiSchemaObject {
    assert.ok(value);
    if ('$ref' in value) {
        assert.ok(context);
        const name = value.$ref.replace('#/components/schemas/', '');
        return schemaObject(context.schemas[name], context);
    }
    return value;
}

class ReflectionUtilitySource {}
class ReflectionExternalUtilitySource {}
class ReflectionUtilityHolder {}
class ReflectionRecordHolder {}
class ReflectionExtractHolder {}

class ReflectionOptionalNullsSource {
    name!: string;
    color!: string | null;
    size?: number;
    archived?: boolean | null;
}

type ReflectionNullableKeys<T extends object> = {
    [K in keyof T]-?: null extends T[K] ? K : never;
}[keyof T];

type ReflectionFlat<T> = {
    [K in keyof T]: T[K];
};

type ReflectionNullableOptionals<T extends object> = ReflectionFlat<Omit<T, ReflectionNullableKeys<T>> & Partial<Pick<T, ReflectionNullableKeys<T>>>>;

registerClassMetadata(ReflectionUtilitySource, {
    kind: ReflectionKind.class,
    classType: ReflectionUtilitySource,
    name: 'ReflectionUtilitySource',
    typeName: 'ReflectionUtilitySource',
    properties: [property('id', numberType), property('email', stringType, true), property('archived', booleanType)],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

const utilitySourceType: Type = {
    kind: ReflectionKind.class,
    classType: ReflectionUtilitySource,
    typeName: 'ReflectionUtilitySource'
};

const uuidStringType: Type = {
    kind: ReflectionKind.intersection,
    typeName: 'UuidString',
    types: [stringType, typiaTag('format', literal('uuid')), typiaTag('tsf:type', literal('uuidString'))]
};

registerClassMetadata(ReflectionExternalUtilitySource, {
    kind: ReflectionKind.class,
    classType: ReflectionExternalUtilitySource,
    name: 'ReflectionExternalUtilitySource',
    typeName: 'ReflectionExternalUtilitySource',
    properties: [property('id', uuidStringType), property('label', stringType)],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

registerClassMetadata(ReflectionUtilityHolder, {
    kind: ReflectionKind.class,
    classType: ReflectionUtilityHolder,
    name: 'ReflectionUtilityHolder',
    typeName: 'ReflectionUtilityHolder',
    properties: [
        property('pick', {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Pick',
            utilityType: 'Pick',
            typeArguments: [utilitySourceType],
            utilityKeys: ['id', 'email'],
            types: []
        } as Type),
        property('omit', {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Omit',
            utilityType: 'Omit',
            typeArguments: [utilitySourceType],
            utilityKeys: ['archived'],
            types: []
        } as Type),
        property('partial', {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Partial',
            utilityType: 'Partial',
            typeArguments: [utilitySourceType],
            utilityKeys: [],
            types: []
        } as Type),
        property('required', {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Required',
            utilityType: 'Required',
            typeArguments: [utilitySourceType],
            utilityKeys: [],
            types: []
        } as Type)
    ],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

registerClassMetadata(ReflectionRecordHolder, {
    kind: ReflectionKind.class,
    classType: ReflectionRecordHolder,
    name: 'ReflectionRecordHolder',
    typeName: 'ReflectionRecordHolder',
    properties: [
        property('fixed', {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Record',
            utilityType: 'Record',
            typeArguments: [union(literal('email'), literal('phone')), numberType],
            index: numberType,
            types: []
        } as Type),
        property('indexed', {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Record',
            utilityType: 'Record',
            typeArguments: [stringType, booleanType],
            index: booleanType,
            types: []
        } as Type)
    ],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

const blankConfig = objectLiteral([signature('type', literal('blank'))], 'BlankConfig');
const webViewConfig = objectLiteral([signature('type', literal('webView')), signature('url', stringType)], 'WebViewConfig');
const mediaConfig = objectLiteral([signature('type', literal('mediaRef')), signature('mediaId', stringType)], 'MediaConfig');

registerClassMetadata(ReflectionExtractHolder, {
    kind: ReflectionKind.class,
    classType: ReflectionExtractHolder,
    name: 'ReflectionExtractHolder',
    typeName: 'ReflectionExtractHolder',
    properties: [
        property('config', {
            kind: ReflectionKind.union,
            typeName: 'Extract',
            utilityType: 'Extract',
            typeArguments: [
                union(blankConfig, webViewConfig, mediaConfig),
                union(objectLiteral([signature('type', literal('blank'))]), objectLiteral([signature('type', literal('webView'))]))
            ],
            types: []
        } as Type)
    ],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

describe('reflection utility type metadata', () => {
    it('normalizes deferred utility aliases before listing OpenAPI properties', () => {
        const createPick = (): Type =>
            ({
                kind: ReflectionKind.objectLiteral,
                typeName: 'ReflectionExternalPick',
                utilityType: 'Pick',
                typeArguments: [
                    {
                        kind: ReflectionKind.class,
                        classType: () => ReflectionExternalUtilitySource,
                        typeName: 'ReflectionExternalUtilitySource'
                    }
                ],
                utilityKeys: ['id'],
                types: []
            }) as Type;

        assert.deepStrictEqual(
            listOpenApiTypeProperties(createPick()).map(property => [property.name, property.required]),
            [['id', true]]
        );

        const context = createOpenApiSchemaContext();
        const schema = schemaObject(typeToOpenApiSchema(createPick(), context), context);
        assert.deepStrictEqual(schema.required, ['id']);
        assert.equal((schema.properties?.id as OpenApiSchemaObject).format, 'uuid');
    });

    it('expands Pick, Omit, Partial, and Required utility metadata from class sources', () => {
        assert.deepStrictEqual(
            validate(
                {
                    pick: { id: 1 },
                    omit: { id: 2, email: 'a@example.com' },
                    partial: {},
                    required: { id: 3, email: 'b@example.com', archived: false }
                },
                ReflectionUtilityHolder
            ),
            []
        );

        const errors = validate(
            {
                pick: { id: 'bad' },
                omit: { email: 'a@example.com', archived: 'ignored' },
                partial: { archived: 'bad' },
                required: { id: 3, archived: true }
            },
            ReflectionUtilityHolder
        );

        assert.deepStrictEqual(
            errors.map(error => [error.code, error.path]),
            [
                ['type', 'pick.id'],
                ['required', 'omit.id'],
                ['type', 'partial.archived'],
                ['required', 'required.email']
            ]
        );
    });

    it('expands structurally equivalent optional-null aliases from type metadata', () => {
        type LocalDto = ReflectionNullableOptionals<Pick<ReflectionOptionalNullsSource, 'name' | 'color' | 'size' | 'archived'>>;
        type ExportedDto = OptionalNulls<Pick<ReflectionOptionalNullsSource, 'name' | 'color'>>;

        const localType = typeOf<LocalDto>();
        const exportedType = typeOf<ExportedDto>();

        assert.deepStrictEqual(validate({ name: 'widget' }, localType), []);
        assert.deepStrictEqual(validate({ name: 'widget', color: null, archived: null }, localType), []);
        assert.deepStrictEqual(validate({ name: 'widget' }, exportedType), []);
        assert.deepStrictEqual(
            validate(
                {
                    color: 'red'
                },
                exportedType
            ).map(error => [error.code, error.path]),
            [['required', 'name']]
        );

        assert.deepStrictEqual(
            listOpenApiTypeProperties(localType).map(property => [property.name, property.required]),
            [
                ['name', true],
                ['color', false],
                ['size', false],
                ['archived', false]
            ]
        );

        const context = createOpenApiSchemaContext();
        const schema = schemaObject(typeToOpenApiSchema(localType, context), context);
        assert.deepStrictEqual(schema.required, ['name']);
        assert.deepStrictEqual(schemaObject(schema.properties?.color, context).type, ['string', 'null']);
        assert.equal(schemaObject(schema.properties?.size, context).type, 'number');
        assert.deepStrictEqual(schemaObject(schema.properties?.archived, context).type, ['boolean', 'null']);

        const exportedContext = createOpenApiSchemaContext();
        const exportedSchema = schemaObject(typeToOpenApiSchema(exportedType, exportedContext), exportedContext);
        assert.deepStrictEqual(exportedSchema.required, ['name']);
        assert.deepStrictEqual(schemaObject(exportedSchema.properties?.color, exportedContext).type, ['string', 'null']);
        assert.equal(exportedContext.schemas.OptionalNulls, undefined);

        const errors = validate(
            {
                color: 'red',
                size: 'bad'
            },
            localType
        );

        assert.deepStrictEqual(
            errors.map(error => [error.code, error.path]),
            [
                ['required', 'name'],
                ['type', 'size']
            ]
        );
    });

    it('keeps anonymous object literal display names inline in OpenAPI schemas', () => {
        const context = createOpenApiSchemaContext();
        const schema = typeToOpenApiSchema(objectLiteral([signature('name', stringType)], '{ name: string }'), context);

        assert.deepStrictEqual(schema, {
            type: 'object',
            properties: {
                name: { type: 'string' }
            },
            required: ['name']
        });
        assert.deepStrictEqual(context.schemas, {});
    });

    it('does not emit components for intrinsic primitive type names', () => {
        const context = createOpenApiSchemaContext();
        const schema = typeToOpenApiSchema({ kind: ReflectionKind.object, typeName: 'object' } as Type, context);

        assert.deepStrictEqual(schema, { type: 'object', additionalProperties: true });
        assert.deepStrictEqual(context.schemas, {});

        const typiaObjectContext = createOpenApiSchemaContext();
        const typiaObjectSchema = typeToOpenApiSchema(objectLiteral([], 'object'), typiaObjectContext);

        assert.deepStrictEqual(typiaObjectSchema, { type: 'object', additionalProperties: true });
        assert.deepStrictEqual(typiaObjectContext.schemas, {});
    });

    it('uses stable component names for utility display names', () => {
        const context = createOpenApiSchemaContext();
        const schema = typeToOpenApiSchema(objectLiteral([signature('id', stringType)], 'Pick<SourceDto, "id">'), context);

        assert.deepStrictEqual(schema, { $ref: '#/components/schemas/PickSourceDto' });
        assert.deepStrictEqual(context.schemas.PickSourceDto, {
            type: 'object',
            properties: {
                id: { type: 'string' }
            },
            required: ['id']
        });
        assert.equal(context.schemas.Pick_SourceDto___id__, undefined);
    });

    it('uses exported base names for non-utility generic alias components', () => {
        const context = createOpenApiSchemaContext();
        const envelopeType = objectLiteral(
            [signature('value', stringType), signature('metadata', { kind: ReflectionKind.object })],
            'GenericEnvelope<string, Record<string, unknown>>'
        );
        const stateType = {
            kind: ReflectionKind.union,
            typeName: 'GenericState<string>',
            types: [literal('enabled'), literal('disabled')]
        } as Type;
        const requestType = objectLiteral([signature('envelope', envelopeType), signature('state', stateType)], 'GenericRequest');

        const schema = schemaObject(typeToOpenApiSchema(requestType, context), context);

        assert.deepStrictEqual(schema.properties?.envelope, { $ref: '#/components/schemas/GenericEnvelope' });
        assert.deepStrictEqual(schema.properties?.state, { $ref: '#/components/schemas/GenericState' });
        assert.deepStrictEqual(context.schemas.GenericEnvelope, {
            type: 'object',
            properties: {
                value: { type: 'string' },
                metadata: {
                    type: 'object',
                    additionalProperties: true
                }
            },
            required: ['value', 'metadata']
        });
        assert.deepStrictEqual(context.schemas.GenericState, {
            enum: ['enabled', 'disabled'],
            type: 'string'
        });
        assert.equal(context.schemas.GenericEnvelope_string__Record_string__unknown__, undefined);
        assert.equal(context.schemas.GenericState_string_, undefined);
    });

    it('reuses same-name object components with equivalent OpenAPI scalar metadata', () => {
        const context = createOpenApiSchemaContext();
        const phoneString = { ...stringType, annotations: { 'tsf:type': literal('phone') } } as Type;
        const requestType = objectLiteral(
            [
                signature('first', objectLiteral([signature('value', phoneString)], 'RepeatedShape')),
                signature('second', objectLiteral([signature('value', stringType)], 'RepeatedShape'))
            ],
            'RepeatedShapeRequest'
        );

        const schema = schemaObject(typeToOpenApiSchema(requestType, context), context);

        assert.deepStrictEqual(schema.properties?.first, { $ref: '#/components/schemas/RepeatedShape' });
        assert.deepStrictEqual(schema.properties?.second, { $ref: '#/components/schemas/RepeatedShape' });
        assert.equal(context.schemas.RepeatedShape_2, undefined);
    });

    it('reuses same-name object components when literal union order differs', () => {
        const context = createOpenApiSchemaContext();
        const first = objectLiteral([signature('status', union(literal('open'), literal('closed'), literal('voided')))], 'RepeatedUnionShape');
        const second = objectLiteral([signature('status', union(literal('closed'), literal('open'), literal('voided')))], 'RepeatedUnionShape');
        const requestType = objectLiteral([signature('first', first), signature('second', second)], 'RepeatedUnionRequest');

        const schema = schemaObject(typeToOpenApiSchema(requestType, context), context);

        assert.deepStrictEqual(schema.properties?.first, { $ref: '#/components/schemas/RepeatedUnionShape' });
        assert.deepStrictEqual(schema.properties?.second, { $ref: '#/components/schemas/RepeatedUnionShape' });
        assert.deepStrictEqual(context.schemas.RepeatedUnionShape, {
            type: 'object',
            properties: {
                status: {
                    enum: ['open', 'closed', 'voided'],
                    type: 'string'
                }
            },
            required: ['status']
        });
        assert.equal(context.schemas.RepeatedUnionShape_2, undefined);
    });

    it('reuses nested same-name components when referenced literal union order differs', () => {
        const context = createOpenApiSchemaContext();
        const firstItem = objectLiteral([signature('status', union(literal('open'), literal('closed'), literal('voided')))], 'RepeatedUnionItem');
        const secondItem = objectLiteral([signature('status', union(literal('closed'), literal('open'), literal('voided')))], 'RepeatedUnionItem');
        const first = objectLiteral([signature('item', firstItem)], 'RepeatedUnionParent');
        const second = objectLiteral([signature('item', secondItem)], 'RepeatedUnionParent');
        const requestType = objectLiteral([signature('first', first), signature('second', second)], 'RepeatedUnionNestedRequest');

        const schema = schemaObject(typeToOpenApiSchema(requestType, context), context);

        assert.deepStrictEqual(schema.properties?.first, { $ref: '#/components/schemas/RepeatedUnionParent' });
        assert.deepStrictEqual(schema.properties?.second, { $ref: '#/components/schemas/RepeatedUnionParent' });
        assert.equal(context.schemas.RepeatedUnionItem_2, undefined);
        assert.equal(context.schemas.RepeatedUnionParent_2, undefined);
    });

    it('preserves validation patterns on formatted OpenAPI strings', () => {
        const schema = typeToOpenApiSchema({
            kind: ReflectionKind.string,
            annotations: {
                'tsf:type': literal('uuid')
            },
            validation: [{ name: 'pattern', args: [literal('^[0-9a-fA-F-]+$')] }]
        });

        assert.deepStrictEqual(schema, { type: 'string', format: 'uuid', pattern: '^[0-9a-fA-F-]+$' });
    });

    it('keeps formatted union validation on each OpenAPI branch', () => {
        const dateString = {
            kind: ReflectionKind.intersection,
            types: [stringType, typiaTag('format', literal('date')), typiaTag('tsf:type', literal('date'))]
        } as Type;
        const uuidString = {
            kind: ReflectionKind.intersection,
            types: [stringType, typiaTag('format', literal('uuid')), typiaTag('tsf:type', literal('uuidString'))]
        } as Type;

        const schema = typeToOpenApiSchema(union(dateString, uuidString)) as OpenApiSchemaObject;

        assert.equal(schema.pattern, undefined);
        assert.deepStrictEqual(schema.oneOf, [
            { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            {
                type: 'string',
                format: 'uuid',
                pattern: '^(?:urn:uuid:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
            }
        ]);
    });

    it('distributes object intersections over unions for runtime metadata and OpenAPI', () => {
        const baseNode = objectLiteral([
            signature('id', stringType),
            signature('type', literal('timeCondition')),
            signature('matchNext', stringType),
            signature('noMatchNext', stringType)
        ]);
        const nodeType: Type = {
            kind: ReflectionKind.intersection,
            typeName: 'DistributedTimeConditionNode',
            types: [
                baseNode,
                union(
                    objectLiteral([signature('timeConditionId', stringType), signature('locationId', { kind: ReflectionKind.never }, true)]),
                    objectLiteral([signature('locationId', stringType), signature('timeConditionId', { kind: ReflectionKind.never }, true)])
                )
            ]
        };
        const recordType = {
            kind: ReflectionKind.objectLiteral,
            typeName: 'Record',
            utilityType: 'Record',
            typeArguments: [stringType, nodeType],
            types: []
        } as Type;
        const baseValue = {
            id: 'node-1',
            type: 'timeCondition',
            matchNext: 'matched',
            noMatchNext: 'not-matched'
        };

        const deserialized = deserialize<Record<string, Record<string, unknown>>>(
            {
                condition: { ...baseValue, timeConditionId: 'condition-1' },
                location: { ...baseValue, locationId: 'location-1' }
            },
            recordType
        );

        assert.equal(deserialized.condition.timeConditionId, 'condition-1');
        assert.equal(deserialized.location.locationId, 'location-1');
        assert.deepStrictEqual(validate({ condition: { ...baseValue, timeConditionId: 'condition-1' } }, recordType), []);
        assert.deepStrictEqual(validate({ location: { ...baseValue, locationId: 'location-1' } }, recordType), []);
        assert.notEqual(validate({ missing: baseValue }, recordType).length, 0);
        assert.notEqual(validate({ both: { ...baseValue, timeConditionId: 'condition-1', locationId: 'location-1' } }, recordType).length, 0);
        assert.equal(nodeType.kind, ReflectionKind.union);

        const context = createOpenApiSchemaContext();
        const recordSchema = schemaObject(typeToOpenApiSchema(recordType, context), context);
        assert.ok(recordSchema.additionalProperties && recordSchema.additionalProperties !== true);
        const nodeSchema = schemaObject(recordSchema.additionalProperties, context);
        assert.equal(nodeSchema.oneOf?.length, 2);
        const branches = nodeSchema.oneOf!.map(branch => schemaObject(branch, context));
        assert.deepStrictEqual(
            branches.map(branch => branch.required),
            [
                ['id', 'type', 'matchNext', 'noMatchNext', 'timeConditionId'],
                ['id', 'type', 'matchNext', 'noMatchNext', 'locationId']
            ]
        );
        assert.deepStrictEqual(branches[0].properties?.locationId, { not: {} });
        assert.deepStrictEqual(branches[1].properties?.timeConditionId, { not: {} });
    });

    it('preserves named aliases nested in outer OpenAPI unions', () => {
        const baseNode = objectLiteral([
            signature('id', stringType),
            signature('type', literal('conditional')),
            signature('matchNext', stringType),
            signature('noMatchNext', stringType)
        ]);
        const conditionalNode: Type = {
            kind: ReflectionKind.intersection,
            typeName: 'NestedConditionalAlias',
            types: [
                baseNode,
                union(
                    objectLiteral([signature('conditionId', stringType), signature('locationId', { kind: ReflectionKind.never }, true)]),
                    objectLiteral([signature('locationId', stringType), signature('conditionId', { kind: ReflectionKind.never }, true)])
                )
            ]
        };
        const answerNode = objectLiteral(
            [signature('id', stringType), signature('type', literal('answer')), signature('next', stringType)],
            'SimpleNode'
        );
        const nodeType = {
            kind: ReflectionKind.union,
            typeName: 'OuterNodeUnion',
            types: [answerNode, conditionalNode]
        } as Type;
        const context = createOpenApiSchemaContext();

        const schema = typeToOpenApiSchema(nodeType, context);

        assert.deepStrictEqual(schema, { $ref: '#/components/schemas/OuterNodeUnion' });
        assert.deepStrictEqual(context.schemas.OuterNodeUnion, {
            oneOf: [{ $ref: '#/components/schemas/SimpleNode' }, { $ref: '#/components/schemas/NestedConditionalAlias' }]
        });
        const conditionalSchema = schemaObject(context.schemas.NestedConditionalAlias, context);
        assert.equal(conditionalSchema.oneOf?.length, 2);
        assert.deepStrictEqual(
            conditionalSchema.oneOf?.map(branch => schemaObject(branch, context).required),
            [
                ['id', 'type', 'matchNext', 'noMatchNext', 'conditionId'],
                ['id', 'type', 'matchNext', 'noMatchNext', 'locationId']
            ]
        );
    });

    it('distributes reduced intersections without never properties', () => {
        const type: Type = {
            kind: ReflectionKind.intersection,
            types: [
                objectLiteral([signature('id', stringType)]),
                union(objectLiteral([signature('a', stringType)]), objectLiteral([signature('b', stringType)]))
            ]
        };

        assert.deepStrictEqual(validate({ id: 'id', a: 'a' }, type), []);
        assert.deepStrictEqual(validate({ id: 'id', b: 'b' }, type), []);
        assert.notEqual(validate({ id: 'id' }, type).length, 0);
        assert.equal(type.kind, ReflectionKind.union);
    });

    it('preserves validation metadata from marker-first intersections', () => {
        const minimumLengthMarker = {
            kind: ReflectionKind.unknown,
            typeName: 'MinLength',
            validation: [{ name: 'minLength', args: [literal(2)] }]
        } as Type;
        const taggedString = {
            kind: ReflectionKind.intersection,
            types: [minimumLengthMarker, stringType]
        } as Type;

        assert.deepStrictEqual(typeToOpenApiSchema(taggedString), { type: 'string', minLength: 2 });
        assert.deepStrictEqual(
            validate('a', taggedString).map(error => [error.code, error.path]),
            [['minLength', '']]
        );
    });

    it('does not expose internal typia tag properties in OpenAPI intersections', () => {
        const tagType = objectLiteral(
            [
                signature(
                    'typia.tag',
                    objectLiteral([
                        signature('target', literal('string')),
                        signature('kind', literal('database:primaryKey')),
                        signature('value', literal(true))
                    ])
                )
            ],
            'PrimaryKeyTag'
        );
        const schema = typeToOpenApiSchema({
            kind: ReflectionKind.intersection,
            types: [stringType, tagType]
        });

        assert.deepStrictEqual(schema, { type: 'string' });
    });

    it('preserves named UUID aliases across internal typia tag intersections', () => {
        const tagType = objectLiteral(
            [
                signature(
                    'typia.tag',
                    objectLiteral([
                        signature('target', literal('string')),
                        signature('kind', literal('database:primaryKey')),
                        signature('value', literal(true))
                    ])
                )
            ],
            'PrimaryKeyTag'
        );
        const namedUuidType = {
            kind: ReflectionKind.intersection,
            typeName: 'UuidString',
            types: [stringType, typiaTag('format', literal('uuid')), typiaTag('tsf:type', literal('uuidString'))]
        } as Type;
        const schema = typeToOpenApiSchema({
            kind: ReflectionKind.intersection,
            types: [namedUuidType, tagType]
        });

        assert.deepStrictEqual(schema, {
            type: 'string',
            format: 'uuid',
            pattern: '^(?:urn:uuid:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
        });
    });

    it('does not treat structured marker-named objects as marker stubs', () => {
        const context = createOpenApiSchemaContext();
        const schema = schemaObject(typeToOpenApiSchema(objectLiteral([signature('value', stringType)], 'Index'), context), context);

        assert.deepStrictEqual(schema.properties?.value, { type: 'string' });
    });

    it('does not validate internal typia tag markers as structured values', () => {
        const tagType = objectLiteral(
            [
                signature(
                    'typia.tag',
                    objectLiteral([
                        signature('target', literal('string')),
                        signature('kind', literal('database:primaryKey')),
                        signature('value', literal(true))
                    ]),
                    true
                )
            ],
            'PrimaryKey'
        );
        const idType: Type = {
            kind: ReflectionKind.intersection,
            typeName: 'GenericId',
            types: [stringType, tagType]
        };

        assert.equal(validatedDeserialize('abc', undefined, undefined, undefined, idType), 'abc');
        assert.equal(validate(123, idType)[0]?.message, 'The value must be a string.');
    });

    it('preserves Date formats from lazy class metadata in object literals', () => {
        const context = createOpenApiSchemaContext();
        const responseType = objectLiteral(
            [
                signature('createdAt', {
                    kind: ReflectionKind.class,
                    typeName: 'Date',
                    classType: () => Date
                } as unknown as Type),
                signature(
                    'deletedAt',
                    union(
                        {
                            kind: ReflectionKind.class,
                            typeName: 'Date',
                            classType: () => Date
                        } as unknown as Type,
                        { kind: ReflectionKind.null }
                    )
                )
            ],
            'DateAliasResponse'
        );

        const schema = schemaObject(typeToOpenApiSchema(responseType, context), context);

        assert.deepStrictEqual(schema.properties?.createdAt, { type: 'string', format: 'date-time' });
        assert.deepStrictEqual(schema.properties?.deletedAt, { type: ['string', 'null'], format: 'date-time' });
    });

    it('does not render user classes as built-ins only because names match', () => {
        const UserDate = class Date {};
        registerClassMetadata(UserDate, {
            kind: ReflectionKind.class,
            classType: UserDate,
            name: 'Date',
            typeName: 'Date',
            properties: [property('value', stringType)],
            methods: [],
            constructorParameters: [],
            hasConstructor: false
        } satisfies ClassMetadata);
        const context = createOpenApiSchemaContext();

        const schema = typeToOpenApiSchema({ kind: ReflectionKind.class, typeName: 'Date', classType: UserDate }, context);

        assert.deepStrictEqual(schema, { $ref: '#/components/schemas/Date' });
        assert.deepStrictEqual(context.schemas.Date.properties?.value, { type: 'string' });
    });

    it('preserves named literal unions as OpenAPI component references', () => {
        const context = createOpenApiSchemaContext();
        const modeType = {
            kind: ReflectionKind.union,
            typeName: 'LiteralMode',
            types: [literal('compact'), literal('expanded')]
        } as Type;

        const schema = typeToOpenApiSchema(modeType, context);

        assert.deepStrictEqual(schema, { $ref: '#/components/schemas/LiteralMode' });
        assert.deepStrictEqual(context.schemas.LiteralMode, {
            enum: ['compact', 'expanded'],
            type: 'string'
        });
    });

    it('preserves named literal unions wrapped in metadata intersections', () => {
        const context = createOpenApiSchemaContext();
        const statusType = {
            kind: ReflectionKind.intersection,
            types: [
                {
                    kind: ReflectionKind.union,
                    typeName: 'WebhookDeliveryStatus',
                    types: [literal('pending'), literal('delivering'), literal('succeeded')]
                },
                {
                    kind: ReflectionKind.unknown,
                    typeName: 'DatabaseField',
                    database: { '*': { type: 'VARCHAR(16)' } }
                }
            ]
        } as Type;

        const schema = typeToOpenApiSchema(statusType, context);

        assert.equal(statusType.kind, ReflectionKind.intersection);
        assert.deepStrictEqual(schema, { $ref: '#/components/schemas/WebhookDeliveryStatus' });
        assert.deepStrictEqual(context.schemas.WebhookDeliveryStatus, {
            enum: ['pending', 'delivering', 'succeeded'],
            type: 'string'
        });
    });

    it('preserves named union aliases in OpenAPI object properties', () => {
        const context = createOpenApiSchemaContext();
        const compactConfig = objectLiteral([signature('type', literal('compact')), signature('columns', numberType)], 'CompactConfig');
        const expandedConfig = objectLiteral([signature('type', literal('expanded')), signature('showLabels', booleanType)], 'ExpandedConfig');
        const configUpdateType = {
            kind: ReflectionKind.union,
            typeName: 'ContentConfigUpdateRequest',
            types: [compactConfig, expandedConfig]
        } as Type;
        const nullableConfigUpdateType = {
            kind: ReflectionKind.union,
            typeName: 'ContentConfigUpdateRequest',
            types: [compactConfig, expandedConfig, { kind: ReflectionKind.null }]
        } as Type;
        const requestType = objectLiteral(
            [signature('content', configUpdateType), signature('defaultContent', nullableConfigUpdateType, true)],
            'ConfigRequest'
        );

        const schema = schemaObject(typeToOpenApiSchema(requestType, context), context);

        assert.deepStrictEqual(schema.properties?.content, { $ref: '#/components/schemas/ContentConfigUpdateRequest' });
        assert.deepStrictEqual(schemaObject(schema.properties?.defaultContent).anyOf, [
            { $ref: '#/components/schemas/ContentConfigUpdateRequest' },
            { type: 'null' }
        ]);
        assert.deepStrictEqual(context.schemas.ContentConfigUpdateRequest, {
            oneOf: [{ $ref: '#/components/schemas/CompactConfig' }, { $ref: '#/components/schemas/ExpandedConfig' }]
        });
    });

    it('expands Record utility metadata into fixed properties or index signatures', () => {
        assert.deepStrictEqual(validate({ fixed: { email: 1, phone: 2 }, indexed: { one: true, two: false } }, ReflectionRecordHolder), []);

        const errors = validate(
            {
                fixed: { email: 'bad', phone: 2, extra: 'ignored' },
                indexed: { one: true, two: 'bad' }
            },
            ReflectionRecordHolder
        );

        assert.deepStrictEqual(
            errors.map(error => [error.code, error.path]),
            [
                ['type', 'fixed.email'],
                ['type', 'indexed.two']
            ]
        );
    });

    it('uses expanded utility metadata during deserialization', () => {
        const result = deserialize(
            {
                pick: { id: '7', email: 'a@example.com', archived: true },
                omit: { id: '8', email: 'b@example.com', archived: true },
                partial: { id: '9' },
                required: { id: '10', email: 'c@example.com', archived: '1' }
            },
            {
                kind: ReflectionKind.class,
                classType: ReflectionUtilityHolder,
                typeName: 'ReflectionUtilityHolder'
            }
        );

        assert.deepStrictEqual(
            result,
            Object.assign(new ReflectionUtilityHolder(), {
                pick: { id: 7, email: 'a@example.com' },
                omit: { id: 8, email: 'b@example.com' },
                partial: { id: 9, email: undefined, archived: undefined },
                required: { id: 10, email: 'c@example.com', archived: true }
            })
        );
    });

    it('expands Extract utility metadata for discriminated unions', () => {
        assert.deepStrictEqual(validate({ config: { type: 'blank' } }, ReflectionExtractHolder), []);
        assert.deepStrictEqual(validate({ config: { type: 'webView', url: '/home' } }, ReflectionExtractHolder), []);

        assert.deepStrictEqual(
            validate({ config: { type: 'mediaRef', mediaId: 'asset-1' } }, ReflectionExtractHolder).map(error => [error.code, error.path]),
            [['type', 'config.type']]
        );
    });
});
