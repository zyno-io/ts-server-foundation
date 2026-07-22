import {
    ReflectionClass,
    ReflectionKind,
    Type,
    isReflectedType,
    isUUIDType,
    typeAnnotation,
    validationAnnotation,
    type TypeClass,
    type TypeObjectLiteral,
    type TypeProperty,
    type TypePropertySignature
} from '../reflection';
import { isMarkerType, normalizeTypeMetadata, tryResolveClassType } from '../reflection/type-utils';

import { FileUpload } from '../http';
import { normalizeAllowedTypes, parseByteSize } from '../http/uploads';
import type { OpenApiReferenceObject, OpenApiSchemaObject } from './types';

export interface OpenApiSchemaContext {
    schemas: Record<string, OpenApiSchemaObject>;
    generating: Set<string>;
    componentNames: WeakMap<object, string>;
    componentTypes: Map<string, object>;
    objectLiteralComponents: Map<string, Array<{ name: string; signature: string }>>;
}

export interface OpenApiTypeProperty {
    name: string;
    type: Type;
    required: boolean;
    description?: string;
}

export function createOpenApiSchemaContext(): OpenApiSchemaContext {
    return {
        schemas: {},
        generating: new Set(),
        componentNames: new WeakMap(),
        componentTypes: new Map(),
        objectLiteralComponents: new Map()
    };
}

export function typeToOpenApiSchema(
    type: Type,
    context: OpenApiSchemaContext = createOpenApiSchemaContext()
): OpenApiSchemaObject | OpenApiReferenceObject {
    normalizeTypeMetadata(type);
    const schema = typeToOpenApiSchemaInternal(type, context);
    if (shouldApplyValidationAnnotations(type)) applyValidationAnnotations(type, schema);
    return schema;
}

export function listOpenApiTypeProperties(type: Type): OpenApiTypeProperty[] {
    normalizeTypeMetadata(type);
    const unwrapped = unwrapOpenApiType(type);
    if (isMarkerType(unwrapped)) return [];

    if (
        unwrapped.kind === ReflectionKind.class &&
        !isOpenApiClassType(unwrapped, Date) &&
        !isOpenApiClassType(unwrapped, FileUpload) &&
        !isOpenApiClassType(unwrapped, Uint8Array) &&
        !isOpenApiClassType(unwrapped, Buffer)
    ) {
        const classType = resolveOpenApiClassType(unwrapped);
        if (!classType) return [];
        const reflection = readOpenApiReflectionClass(classType);
        if (!reflection) return [];
        return reflection
            .getProperties()
            .filter(property => property.isPublic())
            .map(property => ({
                name: property.getNameAsString(),
                type: property.getType(),
                required: !property.isOptional(),
                description: property.getDescription() || undefined
            }));
    }

    if (unwrapped.kind === ReflectionKind.objectLiteral) {
        return collectObjectLiteralProperties(unwrapped)
            .filter(property => !isTypiaInternalTagProperty(property))
            .map(property => ({
                name: String(property.name),
                type: property.type,
                required: property.optional !== true && !allowsUndefined(property.type),
                description: property.description
            }));
    }

    if (unwrapped.kind === ReflectionKind.intersection) return mergeOpenApiIntersectionProperties(unwrapped);

    return [];
}

export function unwrapOpenApiType(type: Type): Type {
    const openApiName = getOpenApiName(type);
    const httpInner = getHttpAliasInnerType(type);
    if (httpInner) return wrapOpenApiTypeName(unwrapOpenApiType(httpInner), openApiName);
    if (type.kind === ReflectionKind.promise) return wrapOpenApiTypeName(unwrapOpenApiType(type.type), openApiName);
    if (type.kind === ReflectionKind.intersection) {
        const hasOpenApiWrapper = type.types.some(item => isHttpMarkerType(item) || isOpenApiNameMarkerType(item));
        if (!hasOpenApiWrapper) return wrapOpenApiTypeName(type, openApiName);
        const meaningful = type.types.filter(
            item =>
                item.kind !== ReflectionKind.never &&
                item.kind !== ReflectionKind.unknown &&
                !isHttpMarkerType(item) &&
                !isOpenApiNameMarkerType(item)
        );
        return wrapOpenApiTypeName(unwrapOpenApiType(meaningful[0] ?? type), openApiName);
    }
    return wrapOpenApiTypeName(type, openApiName);
}

function getHttpAliasInnerType(type: Type): Type | undefined {
    const typeName = (type as Type & { typeName?: string; typeArguments?: Type[] }).typeName;
    const annotation = httpAnnotationName(typeName);
    if (!annotation) return undefined;
    return getAnnotationOptionType(type, annotation) ?? (type as Type & { typeArguments?: Type[] }).typeArguments?.[0];
}

export function allowsUndefined(type: Type): boolean {
    return (
        type.kind === ReflectionKind.any || (type.kind === ReflectionKind.union && type.types.some(item => item.kind === ReflectionKind.undefined))
    );
}

export function typeHasOpenApiFileUpload(type: Type, seenTypes = new Set<Type>(), seenClasses = new Set<TypeClass['classType']>()): boolean {
    normalizeTypeMetadata(type);
    const unwrapped = unwrapOpenApiType(type);
    if (seenTypes.has(unwrapped)) return false;
    seenTypes.add(unwrapped);

    if (unwrapped.kind === ReflectionKind.class) {
        if (isOpenApiClassType(unwrapped, FileUpload)) return true;
        if (isOpenApiClassType(unwrapped, Date) || isOpenApiClassType(unwrapped, Uint8Array) || isOpenApiClassType(unwrapped, Buffer)) {
            return false;
        }
        const classType = resolveOpenApiClassType(unwrapped);
        if (!classType) return false;
        if (seenClasses.has(classType)) return false;
        seenClasses.add(classType);
        const reflection = readOpenApiReflectionClass(classType);
        return reflection?.getProperties().some(property => typeHasOpenApiFileUpload(property.getType(), seenTypes, seenClasses)) ?? false;
    }

    if (unwrapped.kind === ReflectionKind.objectLiteral) {
        return (
            collectObjectLiteralProperties(unwrapped).some(property => typeHasOpenApiFileUpload(property.type, seenTypes, seenClasses)) ||
            (unwrapped.index ? typeHasOpenApiFileUpload(unwrapped.index, seenTypes, seenClasses) : false)
        );
    }

    if (unwrapped.kind === ReflectionKind.array) return typeHasOpenApiFileUpload(unwrapped.type, seenTypes, seenClasses);
    if (unwrapped.kind === ReflectionKind.tuple) return unwrapped.types.some(item => typeHasOpenApiFileUpload(item.type, seenTypes, seenClasses));
    if (unwrapped.kind === ReflectionKind.union || unwrapped.kind === ReflectionKind.intersection) {
        return unwrapped.types.some(item => typeHasOpenApiFileUpload(item, seenTypes, seenClasses));
    }

    return false;
}

export function typeRequiresOpenApiFileUpload(type: Type, seenTypes = new Set<Type>(), seenClasses = new Set<TypeClass['classType']>()): boolean {
    normalizeTypeMetadata(type);
    const unwrapped = unwrapOpenApiType(type);
    if (seenTypes.has(unwrapped)) return false;
    seenTypes.add(unwrapped);

    let classType: TypeClass['classType'] | undefined;
    try {
        if (unwrapped.kind === ReflectionKind.class) {
            if (isOpenApiClassType(unwrapped, FileUpload)) return true;
            if (isOpenApiClassType(unwrapped, Date) || isOpenApiClassType(unwrapped, Uint8Array) || isOpenApiClassType(unwrapped, Buffer)) {
                return false;
            }
            classType = resolveOpenApiClassType(unwrapped);
            if (!classType || seenClasses.has(classType)) return false;
            seenClasses.add(classType);
        }

        if (unwrapped.kind === ReflectionKind.union) {
            const possibleTypes = unwrapped.types.filter(item => item.kind !== ReflectionKind.never);
            return possibleTypes.length > 0 && possibleTypes.every(item => typeRequiresOpenApiFileUpload(item, seenTypes, seenClasses));
        }

        const properties = listOpenApiTypeProperties(unwrapped);
        if (properties.length) {
            return properties.some(property => property.required && typeRequiresOpenApiFileUpload(property.type, seenTypes, seenClasses));
        }

        if (unwrapped.kind === ReflectionKind.intersection) {
            return unwrapped.types.some(item => typeRequiresOpenApiFileUpload(item, seenTypes, seenClasses));
        }
        if (unwrapped.kind === ReflectionKind.tuple) {
            return unwrapped.types.some(item => typeRequiresOpenApiFileUpload(item.type, seenTypes, seenClasses));
        }

        return false;
    } finally {
        seenTypes.delete(unwrapped);
        if (classType) seenClasses.delete(classType);
    }
}

function readOpenApiReflectionClass(classType: TypeClass['classType']): ReflectionClass | undefined {
    try {
        return ReflectionClass.from(classType);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('No runtime type metadata for ')) return undefined;
        throw error;
    }
}

function resolveOpenApiClassType(type: TypeClass): TypeClass['classType'] | undefined {
    return tryResolveClassType(type.classType as TypeClass['classType'] | (() => TypeClass['classType']));
}

function isOpenApiClassType(type: TypeClass, classType: TypeClass['classType']): boolean {
    const resolved = resolveOpenApiClassType(type);
    return type.classType === classType || resolved === classType;
}

function typeToOpenApiSchemaInternal(
    type: Type,
    context: OpenApiSchemaContext,
    preserveNamedAliases = true
): OpenApiSchemaObject | OpenApiReferenceObject {
    const openApiType = unwrapOpenApiType(type);
    const nullable = isNullable(openApiType);
    const unwrapped = unwrapNullable(openApiType);
    const schema = schemaForNonNullableType(unwrapped, context, preserveNamedAliases);
    if (nullable) return withNullableSchema(schema);
    return schema;
}

function schemaForNonNullableType(
    type: Type,
    context: OpenApiSchemaContext,
    preserveNamedAliases = true
): OpenApiSchemaObject | OpenApiReferenceObject {
    const foundationType = getTypeAnnotation(type, 'tsf:type');
    if (foundationType?.kind === ReflectionKind.literal) {
        if (foundationType.literal === 'date') return { type: 'string', format: 'date' };
        if (foundationType.literal === 'uuid') return { type: 'string', format: 'uuid' };
        if (foundationType.literal === 'integer') return { type: 'integer' };
        if (foundationType.literal === 'phone' || foundationType.literal === 'phoneNanp') return { type: 'string' };
    }

    if (isUUIDType(type)) return { type: 'string', format: 'uuid' };

    if (preserveNamedAliases) {
        const named = schemaForNamedAlias(type, context);
        if (named) return named;
    }

    if (type.kind === ReflectionKind.union) return schemaForUnion(type, context);

    const componentReference = schemaForKnownComponentReference(type, context);
    if (componentReference) return componentReference;

    switch (type.kind) {
        case ReflectionKind.any:
        case ReflectionKind.unknown:
            return {};
        case ReflectionKind.void:
        case ReflectionKind.undefined:
            return {};
        case ReflectionKind.never:
            return { not: {} };
        case ReflectionKind.null:
            return { type: 'null' };
        case ReflectionKind.string:
        case ReflectionKind.templateLiteral:
            return { type: 'string' };
        case ReflectionKind.number:
            return { type: 'number' };
        case ReflectionKind.bigint:
            return { type: 'integer', format: 'int64' };
        case ReflectionKind.boolean:
            return { type: 'boolean' };
        case ReflectionKind.literal:
            return schemaForLiteral(type.literal);
        case ReflectionKind.enum:
            return schemaForEnum(type.values);
        case ReflectionKind.array:
            return { type: 'array', items: typeToOpenApiSchema(type.type, context) };
        case ReflectionKind.tuple:
            return {
                type: 'array',
                items: type.types.length ? { oneOf: type.types.map(item => typeToOpenApiSchema(item.type, context)) } : {}
            };
        case ReflectionKind.class:
            return schemaForClass(type, context);
        case ReflectionKind.objectLiteral:
            return schemaForObjectLiteral(type, context);
        case ReflectionKind.object:
            return { type: 'object', additionalProperties: true };
        case ReflectionKind.intersection:
            return schemaForIntersection(type, context);
        default:
            return {};
    }
}

function schemaForClass(type: TypeClass, context: OpenApiSchemaContext): OpenApiSchemaObject | OpenApiReferenceObject {
    if (isOpenApiClassType(type, Date)) return { type: 'string', format: 'date-time' };
    if (isOpenApiClassType(type, Uint8Array) || isOpenApiClassType(type, Buffer)) return { type: 'string', format: 'binary' };
    if (isOpenApiClassType(type, FileUpload)) return schemaForFileUpload(type);

    const name = getClassComponentName(type, context);
    return schemaForComponent(name, listOpenApiTypeProperties(type), context, type.description);
}

function schemaForFileUpload(type: Type): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'string', format: 'binary' };
    const options = (type as Type & { typeArguments?: Type[] }).typeArguments?.[0];
    if (!options) return schema;
    const value = openApiPlainValue(options);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return schema;
    const record = value as Record<string, unknown>;
    const maxSizeBytes = parseByteSize(record.maxSize);
    const allowedTypes = normalizeAllowedTypes(record.allowedTypes);
    if (maxSizeBytes !== undefined) schema['x-maxSizeBytes'] = maxSizeBytes;
    if (allowedTypes?.length) schema['x-allowedTypes'] = allowedTypes;
    return schema;
}

function openApiPlainValue(type: Type): unknown {
    if (type.kind === ReflectionKind.literal) return type.literal;
    if (type.kind === ReflectionKind.tuple) return type.types.map(item => openApiPlainValue(item.type));
    if (type.kind === ReflectionKind.union) {
        const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
        return concrete.length === 1 ? openApiPlainValue(concrete[0]) : undefined;
    }
    if (type.kind === ReflectionKind.objectLiteral) {
        const output: Record<string, unknown> = {};
        for (const property of listOpenApiTypeProperties(type)) output[property.name] = openApiPlainValue(property.type);
        return output;
    }
}

function schemaForObjectLiteral(type: TypeObjectLiteral, context: OpenApiSchemaContext): OpenApiSchemaObject | OpenApiReferenceObject {
    if (isIntrinsicObjectLiteral(type)) return { type: 'object', additionalProperties: true };

    const component = getObjectLiteralComponentName(type, context);
    const indexType = getObjectLiteralIndexType(type);
    if (!component) return schemaForProperties(listOpenApiTypeProperties(type), context, type.description, indexType);
    return schemaForComponent(component.name, listOpenApiTypeProperties(type), context, type.description, indexType, {
        baseName: component.baseName,
        owner: type
    });
}

function isIntrinsicObjectLiteral(type: TypeObjectLiteral): boolean {
    const typeName = (type as Type & { typeName?: string }).typeName;
    return typeName === 'object' && type.types.length === 0 && !type.index;
}

function schemaForIntersection(
    type: Extract<Type, { kind: ReflectionKind.intersection }>,
    context: OpenApiSchemaContext
): OpenApiSchemaObject | OpenApiReferenceObject {
    const properties = listOpenApiTypeProperties(type);
    if (properties.length) {
        const name = getIntersectionComponentName(type, context);
        if (name) return schemaForComponent(name, properties, context, type.description);
        return schemaForProperties(properties, context, type.description);
    }

    const meaningful = firstMeaningfulIntersectionType(type);
    return meaningful ? typeToOpenApiSchemaInternal(meaningful, context) : {};
}

function schemaForComponent(
    name: string,
    properties: OpenApiTypeProperty[],
    context: OpenApiSchemaContext,
    description?: string,
    indexType?: Type,
    options: { baseName?: string; owner?: object } = {}
): OpenApiSchemaObject | OpenApiReferenceObject {
    if (context.schemas[name]) return { $ref: `#/components/schemas/${name}` };

    context.schemas[name] = {};
    if (context.generating.has(name)) return { $ref: `#/components/schemas/${name}` };
    context.generating.add(name);
    const schema = schemaForProperties(properties, context, description, indexType);
    context.generating.delete(name);

    if (options.baseName && name !== options.baseName && !schemaReferencesComponent(schema, name)) {
        const existingName = findEquivalentObjectLiteralComponent(options.baseName, name, schema, context);
        if (existingName) {
            delete context.schemas[name];
            context.componentTypes.delete(name);
            removeObjectLiteralComponent(options.baseName, name, context);
            if (options.owner) context.componentNames.set(options.owner, existingName);
            return { $ref: `#/components/schemas/${existingName}` };
        }
    }

    context.schemas[name] = schema;
    return { $ref: `#/components/schemas/${name}` };
}

function schemaForProperties(
    properties: OpenApiTypeProperty[],
    context: OpenApiSchemaContext,
    description?: string,
    indexType?: Type
): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = {
        type: 'object',
        properties: {}
    };
    if (description) schema.description = description;
    if (indexType) schema.additionalProperties = schemaForAdditionalProperties(indexType, context);

    const required: string[] = [];
    for (const property of properties) {
        const propertySchema = typeToOpenApiSchema(property.type, context);
        if (property.description && !('$ref' in propertySchema)) propertySchema.description = property.description;
        schema.properties![property.name] = propertySchema;
        if (property.required) required.push(property.name);
    }
    if (required.length) schema.required = required;
    return schema;
}

function schemaForAdditionalProperties(type: Type, context: OpenApiSchemaContext): true | OpenApiSchemaObject | OpenApiReferenceObject {
    if (type.kind === ReflectionKind.any || type.kind === ReflectionKind.unknown) return true;
    return typeToOpenApiSchema(type, context);
}

function schemaForUnion(type: Type, context: OpenApiSchemaContext): OpenApiSchemaObject | OpenApiReferenceObject {
    if (type.kind !== ReflectionKind.union) return typeToOpenApiSchemaInternal(type, context);

    const unionTypes = flattenUnionTypes(type);
    const nullable = unionTypes.some(item => item.kind === ReflectionKind.null);
    const nonNull = unionTypes.filter(item => item.kind !== ReflectionKind.null && item.kind !== ReflectionKind.undefined);
    if (nonNull.length === 0) return { type: 'null' };
    if (nonNull.length === 1) {
        const schema = typeToOpenApiSchema(nonNull[0], context);
        return nullable ? withNullableSchema(schema) : schema;
    }

    if (nonNull.every(item => item.kind === ReflectionKind.literal)) {
        return schemaForEnum([
            ...nonNull.map(item => (item.kind === ReflectionKind.literal ? item.literal : undefined)),
            ...(nullable ? [null] : [])
        ]);
    }

    return {
        oneOf: [...nonNull.map(item => typeToOpenApiSchema(item, context)), ...(nullable ? [{ type: 'null' } satisfies OpenApiSchemaObject] : [])]
    };
}

function schemaForLiteral(value: unknown): OpenApiSchemaObject {
    if (typeof value === 'string') return { type: 'string', enum: [value] };
    if (typeof value === 'number') return { type: 'number', enum: [value] };
    if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
    if (typeof value === 'bigint') return { type: 'integer', format: 'int64', enum: [Number(value)] };
    if (value instanceof RegExp) return { type: 'string', pattern: value.source };
    return {};
}

function schemaForEnum(values: unknown[]): OpenApiSchemaObject {
    const enumValues = values.filter(value => value !== undefined).map(value => (typeof value === 'bigint' ? Number(value) : value));
    const types = uniqueJsonSchemaTypes(enumValues.map(jsonSchemaTypeForValue).filter((type): type is string => type !== undefined));
    const schema: OpenApiSchemaObject = { enum: uniqueEnumValues(enumValues) };
    if (types.length) schema.type = types.length === 1 ? types[0] : types;
    return schema;
}

function schemaForNamedAlias(type: Type, context: OpenApiSchemaContext): OpenApiSchemaObject | OpenApiReferenceObject | undefined {
    const typeName = (type as Type & { typeName?: string }).typeName;
    if (typeName === 'FileUpload') return schemaForFileUpload(type);

    const componentName = getNamedAliasComponentName(type);
    if (!componentName) return undefined;
    return schemaForNamedAliasComponent(componentName, type, context);
}

function schemaForNamedAliasComponent(baseName: string, type: Type, context: OpenApiSchemaContext): OpenApiReferenceObject {
    const existingName = context.componentNames.get(type);
    if (existingName) return { $ref: `#/components/schemas/${existingName}` };

    const signature = typeSignature(type, new Set());
    const existing = context.objectLiteralComponents.get(baseName)?.find(item => item.signature === signature);
    if (existing) {
        context.componentNames.set(type, existing.name);
        return { $ref: `#/components/schemas/${existing.name}` };
    }

    const name = reserveComponentName(baseName, type, context);
    context.componentNames.set(type, name);
    const components = context.objectLiteralComponents.get(baseName) ?? [];
    components.push({ name, signature });
    context.objectLiteralComponents.set(baseName, components);

    if (context.schemas[name]) return { $ref: `#/components/schemas/${name}` };
    context.schemas[name] = {};
    if (context.generating.has(name)) return { $ref: `#/components/schemas/${name}` };

    context.generating.add(name);
    const schema = schemaForNonNullableType(type, context, false);
    context.schemas[name] = '$ref' in schema ? { allOf: [schema] } : schema;
    context.generating.delete(name);

    return { $ref: `#/components/schemas/${name}` };
}

function getNamedAliasComponentName(type: Type): string | undefined {
    if (!isNamedAliasComponentType(type)) return undefined;

    const rawName = getWrappedOpenApiName(type) ?? (type as Type & { typeName?: string }).typeName;
    if (rawName && isIntrinsicTypeName(rawName)) return undefined;
    const componentName = rawName ? getNamedComponentBaseName(rawName) : undefined;
    return componentName ? sanitizeComponentName(componentName) : undefined;
}

function isIntrinsicTypeName(typeName: string): boolean {
    return ['string', 'number', 'boolean', 'bigint', 'object', 'symbol', 'unknown', 'any', 'never', 'void', 'undefined', 'null'].includes(
        typeName.trim()
    );
}

function isNamedAliasComponentType(type: Type): boolean {
    switch (type.kind) {
        case ReflectionKind.string:
        case ReflectionKind.number:
        case ReflectionKind.boolean:
        case ReflectionKind.bigint:
        case ReflectionKind.object:
        case ReflectionKind.templateLiteral:
        case ReflectionKind.literal:
        case ReflectionKind.enum:
        case ReflectionKind.union:
        case ReflectionKind.array:
        case ReflectionKind.tuple:
            return true;
        default:
            return false;
    }
}

function isGeneratedUtilityRootName(typeName: string): boolean {
    return ['Pick', 'Omit', 'Partial', 'Required', 'Readonly', 'Extract', 'NonNullable', 'OptionalNulls'].includes(typeName);
}

function schemaForKnownComponentReference(type: Type, context: OpenApiSchemaContext): OpenApiReferenceObject | undefined {
    if (type.kind !== ReflectionKind.unknown && type.kind !== ReflectionKind.any) return undefined;
    const typeName = (type as Type & { typeName?: string }).typeName;
    if (!typeName) return undefined;
    const name = sanitizeComponentName(typeName);
    if (context.generating.has(name) || context.schemas[name]) return { $ref: `#/components/schemas/${name}` };
}

function collectObjectLiteralProperties(type: TypeObjectLiteral, seen = new Set<Type>()): Array<TypePropertySignature | TypeProperty> {
    if (seen.has(type)) return [];
    if (isMarkerType(type)) return [];
    seen.add(type);

    const own = type.types.filter((item): item is TypePropertySignature => item.kind === ReflectionKind.propertySignature);
    const implemented: Array<TypePropertySignature | TypeProperty> = [];
    for (const item of type.implements ?? []) {
        const unwrapped = unwrapOpenApiType(item);
        if (seen.has(unwrapped)) continue;
        if (unwrapped.kind === ReflectionKind.objectLiteral) {
            implemented.push(...collectObjectLiteralProperties(unwrapped, seen));
            continue;
        }
        implemented.push(
            ...listOpenApiTypeProperties(unwrapped).map<TypePropertySignature>(property => ({
                kind: ReflectionKind.propertySignature as const,
                name: property.name,
                type: property.type,
                optional: property.required ? undefined : true,
                description: property.description
            }))
        );
    }
    const order: string[] = [];
    const byName = new Map<string, TypePropertySignature | TypeProperty>();
    for (const property of [...implemented, ...own]) {
        const name = String(property.name);
        if (!byName.has(name)) order.push(name);
        byName.set(name, property);
    }
    return order.map(name => byName.get(name)!);
}

function getObjectLiteralIndexType(type: TypeObjectLiteral, seen = new Set<Type>()): Type | undefined {
    if (type.index) return type.index;
    if (seen.has(type)) return undefined;
    seen.add(type);

    for (const item of type.implements ?? []) {
        const unwrapped = unwrapOpenApiType(item);
        if (unwrapped.kind === ReflectionKind.objectLiteral) {
            const indexType = getObjectLiteralIndexType(unwrapped, seen);
            if (indexType) return indexType;
        }
    }
}

function mergeOpenApiIntersectionProperties(type: Extract<Type, { kind: ReflectionKind.intersection }>): OpenApiTypeProperty[] {
    const order: string[] = [];
    const byName = new Map<string, OpenApiTypeProperty>();

    const addProperty = (property: OpenApiTypeProperty) => {
        if (!byName.has(property.name)) order.push(property.name);
        byName.set(property.name, property);
    };

    const collect = (item: Type) => {
        const unwrapped = unwrapOpenApiType(item);
        if (isMarkerType(unwrapped)) return;
        if (unwrapped.kind === ReflectionKind.intersection) {
            for (const child of unwrapped.types) collect(child);
            return;
        }
        for (const property of listOpenApiTypeProperties(unwrapped)) addProperty(property);
    };

    for (const item of type.types) collect(item);
    return order.map(name => byName.get(name)!);
}

function firstMeaningfulIntersectionType(type: Extract<Type, { kind: ReflectionKind.intersection }>): Type | undefined {
    return type.types.find(
        item =>
            item.kind !== ReflectionKind.never &&
            item.kind !== ReflectionKind.unknown &&
            !isHttpMarkerType(item) &&
            !isOpenApiNameMarkerType(item) &&
            !isMarkerType(item) &&
            !isTypiaInternalTagType(item)
    );
}

function isTypiaInternalTagType(type: Type): boolean {
    const unwrapped = unwrapOpenApiType(type);
    return (
        unwrapped.kind === ReflectionKind.objectLiteral &&
        !unwrapped.index &&
        collectObjectLiteralProperties(unwrapped).length > 0 &&
        collectObjectLiteralProperties(unwrapped).every(isTypiaInternalTagProperty)
    );
}

function isTypiaInternalTagProperty(property: TypePropertySignature | TypeProperty): boolean {
    return String(property.name) === 'typia.tag';
}

function isNullable(type: Type): boolean {
    return type.kind === ReflectionKind.null || (type.kind === ReflectionKind.union && type.types.some(isNullable));
}

function unwrapNullable(type: Type): Type {
    if (type.kind !== ReflectionKind.union) return type;
    const nonNull = type.types.filter(item => item.kind !== ReflectionKind.null && item.kind !== ReflectionKind.undefined);
    if (nonNull.length === type.types.length) return type;
    return nonNull.length === 1 ? nonNull[0] : ({ ...type, types: nonNull } as Type);
}

function flattenUnionTypes(type: Type): Type[] {
    if (type.kind !== ReflectionKind.union) return [type];
    return type.types.flatMap(flattenNestedUnionType);
}

function flattenNestedUnionType(type: Type): Type[] {
    // Anonymous nested unions can be flattened, but named aliases must remain
    // visible so their branches are emitted behind a component reference.
    if (type.kind !== ReflectionKind.union || getNamedAliasComponentName(type)) return [type];
    return type.types.flatMap(flattenNestedUnionType);
}

function getClassComponentName(type: TypeClass, context: OpenApiSchemaContext): string {
    const explicitName = getWrappedOpenApiName(type);
    const typeName = (type as Type & { typeName?: string }).typeName;
    const classType = resolveOpenApiClassType(type) ?? type.classType;
    const className = typeof classType === 'function' ? classType.name : undefined;
    const baseName = sanitizeComponentName(explicitName ?? (typeName && typeName !== 'Class' ? typeName : (className ?? 'Class')));
    if (!explicitName) {
        const existingName = context.componentNames.get(classType);
        if (existingName) return existingName;
    }

    const name = reserveComponentName(baseName, classType, context);
    if (!explicitName) context.componentNames.set(classType, name);
    return name;
}

function getObjectLiteralComponentName(type: TypeObjectLiteral, context: OpenApiSchemaContext): { name: string; baseName: string } | undefined {
    const explicitName = getWrappedOpenApiName(type);
    const rawName = explicitName ?? getObjectLiteralTypeName(type);
    if (!rawName || (!explicitName && isAnonymousObjectLiteralTypeName(rawName))) return undefined;

    if (!explicitName) {
        const existingName = context.componentNames.get(type);
        if (existingName) return { name: existingName, baseName: sanitizeComponentName(rawName) };
    }

    const baseName = sanitizeComponentName(rawName);
    if (context.generating.has(baseName)) {
        if (!explicitName) context.componentNames.set(type, baseName);
        return { name: baseName, baseName };
    }

    const signature = objectLiteralComponentSignature(type);
    const existing = context.objectLiteralComponents.get(baseName)?.find(item => item.signature === signature);
    if (existing) {
        if (!explicitName) context.componentNames.set(type, existing.name);
        return { name: existing.name, baseName };
    }

    const name = reserveComponentName(baseName, type, context);
    if (!explicitName) context.componentNames.set(type, name);
    const components = context.objectLiteralComponents.get(baseName) ?? [];
    components.push({ name, signature });
    context.objectLiteralComponents.set(baseName, components);
    return { name, baseName };
}

function getIntersectionComponentName(type: Extract<Type, { kind: ReflectionKind.intersection }>, context: OpenApiSchemaContext): string | undefined {
    const explicitName = getWrappedOpenApiName(type);
    const typeName = (type as Type & { typeName?: string }).typeName;
    const rawName = explicitName ?? (typeName ? getNamedComponentBaseName(typeName) : undefined);
    if (!rawName) return undefined;

    if (!explicitName) {
        const existingName = context.componentNames.get(type);
        if (existingName) return existingName;
    }

    const baseName = sanitizeComponentName(rawName);
    if (context.generating.has(baseName)) {
        if (!explicitName) context.componentNames.set(type, baseName);
        return baseName;
    }

    const signature = typeSignature(type, new Set());
    const existing = context.objectLiteralComponents.get(baseName)?.find(item => item.signature === signature);
    if (existing) {
        if (!explicitName) context.componentNames.set(type, existing.name);
        return existing.name;
    }

    const name = reserveComponentName(baseName, type, context);
    if (!explicitName) context.componentNames.set(type, name);
    const components = context.objectLiteralComponents.get(baseName) ?? [];
    components.push({ name, signature });
    context.objectLiteralComponents.set(baseName, components);
    return name;
}

function getObjectLiteralTypeName(type: TypeObjectLiteral): string | undefined {
    const typeName = (type as Type & { typeName?: string }).typeName;
    if (!typeName) return undefined;

    const displayUtilityName = getUtilityDisplayTypeName(typeName);
    if (displayUtilityName) return displayUtilityName;

    const namedComponentName = getNamedComponentBaseName(typeName);
    if (namedComponentName) return namedComponentName;

    if (isUtilityObjectLiteralTypeName(typeName)) {
        const source = (type as Type & { typeArguments?: Type[] }).typeArguments?.[0];
        const sourceName = source ? getSourceTypeName(source) : undefined;
        if (sourceName) return `${typeName}${sourceName}`;
    }

    return typeName;
}

function isUtilityObjectLiteralTypeName(typeName: string): boolean {
    return ['Pick', 'Omit', 'Partial', 'Required', 'Readonly', 'OptionalNulls'].includes(typeName);
}

function getNamedComponentBaseName(typeName: string): string | undefined {
    const trimmed = typeName.trim();
    if (!trimmed || isAnonymousObjectLiteralTypeName(trimmed)) return undefined;

    const parsed = parseGenericDisplayTypeName(trimmed);
    const name = parsed?.name ?? trimmed;
    if (isGeneratedUtilityRootName(name)) return undefined;
    return name;
}

function getUtilityDisplayTypeName(typeName: string): string | undefined {
    const parsed = parseGenericDisplayTypeName(typeName);
    if (!parsed || !isUtilityObjectLiteralTypeName(parsed.name)) return undefined;
    const sourceName = getUtilitySourceDisplayName(parsed.args[0]);
    return sourceName ? `${parsed.name}${sourceName}` : undefined;
}

function getUtilitySourceDisplayName(source: string | undefined): string | undefined {
    if (!source) return undefined;
    const trimmed = source.trim().replace(/^typeof\s+/, '');
    const imported = /^import\([^)]+\)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (imported) return imported[1];

    const nested = parseGenericDisplayTypeName(trimmed);
    if (nested) {
        const nestedSource = getUtilitySourceDisplayName(nested.args[0]);
        return nestedSource ? `${nested.name}${nestedSource}` : nested.name;
    }

    const qualified = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.exec(trimmed);
    if (qualified) return trimmed.split('.').at(-1);
}

function parseGenericDisplayTypeName(typeName: string): { name: string; args: string[] } | undefined {
    const trimmed = typeName.trim();
    const start = trimmed.indexOf('<');
    if (start <= 0 || !trimmed.endsWith('>')) return undefined;
    const name = trimmed.slice(0, start).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
    return { name, args: splitTopLevelTypeArguments(trimmed.slice(start + 1, -1)) };
}

function splitTopLevelTypeArguments(input: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let angle = 0;
    let brace = 0;
    let bracket = 0;
    let paren = 0;
    let quote: string | undefined;
    for (let index = 0; index < input.length; index++) {
        const char = input[index]!;
        if (quote) {
            if (char === '\\') index++;
            else if (char === quote) quote = undefined;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === '<') angle++;
        else if (char === '>') angle--;
        else if (char === '{') brace++;
        else if (char === '}') brace--;
        else if (char === '[') bracket++;
        else if (char === ']') bracket--;
        else if (char === '(') paren++;
        else if (char === ')') paren--;
        else if (char === ',' && angle === 0 && brace === 0 && bracket === 0 && paren === 0) {
            parts.push(input.slice(start, index).trim());
            start = index + 1;
        }
    }
    parts.push(input.slice(start).trim());
    return parts.filter(Boolean);
}

function isAnonymousObjectLiteralTypeName(typeName: string): boolean {
    const trimmed = typeName.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
}

function getSourceTypeName(type: Type): string | undefined {
    if (type.kind === ReflectionKind.class) {
        return (type as Type & { typeName?: string }).typeName ?? resolveOpenApiClassType(type)?.name ?? type.classType.name;
    }
    if (type.kind === ReflectionKind.objectLiteral) return getObjectLiteralTypeName(type);
    return (type as Type & { typeName?: string }).typeName;
}

function objectLiteralComponentSignature(type: TypeObjectLiteral): string {
    return typeSignature(type, new Set());
}

function typeSignature(type: Type, seen: Set<Type>): string {
    if (seen.has(type)) return '[Circular]';
    seen.add(type);

    const unwrapped = unwrapOpenApiType(type);
    if (unwrapped !== type) {
        if (seen.has(unwrapped)) return '[Circular]';
        seen.add(unwrapped);
    }

    switch (unwrapped.kind) {
        case ReflectionKind.class:
            return `class:${(unwrapped as Type & { typeName?: string }).typeName ?? resolveOpenApiClassType(unwrapped)?.name ?? unwrapped.classType.name}`;
        case ReflectionKind.objectLiteral:
            return `object:${getObjectLiteralTypeName(unwrapped) ?? ''}{${listOpenApiTypeProperties(unwrapped)
                .map(property => `${property.name}${property.required ? '' : '?'}:${typeSignature(property.type, new Set(seen))}`)
                .join(';')}}[${unwrapped.index ? typeSignature(unwrapped.index, new Set(seen)) : ''}]`;
        case ReflectionKind.array:
            return `array:${typeSignature(unwrapped.type, new Set(seen))}`;
        case ReflectionKind.tuple:
            return `tuple:${unwrapped.types.map(item => typeSignature(item.type, new Set(seen))).join(',')}`;
        case ReflectionKind.union: {
            const parts = unwrapped.types.map(item => typeSignature(item, new Set(seen)));
            if (isLiteralLikeUnion(unwrapped)) parts.sort();
            return `union:${parts.join('|')}`;
        }
        case ReflectionKind.intersection:
            return `intersection:${unwrapped.types.map(item => typeSignature(item, new Set(seen))).join('&')}`;
        case ReflectionKind.literal:
            return `literal:${String(unwrapped.literal)}`;
        case ReflectionKind.enum:
            return `enum:${unwrapped.values
                .map(value => String(value))
                .sort()
                .join('|')}`;
        case ReflectionKind.string:
        case ReflectionKind.templateLiteral:
        case ReflectionKind.number:
        case ReflectionKind.bigint:
        case ReflectionKind.boolean:
        case ReflectionKind.object:
            return `${unwrapped.kind}:${schemaRelevantMetadataSignature(unwrapped)}`;
        default:
            return `${unwrapped.kind}:${(unwrapped as Type & { typeName?: string }).typeName ?? ''}`;
    }
}

function isLiteralLikeUnion(type: Extract<Type, { kind: ReflectionKind.union }>): boolean {
    return type.types.every(
        item => item.kind === ReflectionKind.literal || item.kind === ReflectionKind.null || item.kind === ReflectionKind.undefined
    );
}

function schemaRelevantMetadataSignature(type: Type): string {
    const annotations = {
        tsfType: serializableTypeValue(getTypeAnnotation(type, 'tsf:type')),
        validation: validationAnnotation.getAnnotations(type).map(annotation => ({
            name: annotation.name,
            args: annotation.args?.map(serializableTypeValue) ?? []
        }))
    };
    return JSON.stringify(annotations);
}

function serializableTypeValue(type: Type | undefined): unknown {
    const value = literalValue(type);
    if (value instanceof RegExp) return { pattern: value.source };
    return value;
}

function findEquivalentObjectLiteralComponent(
    baseName: string,
    generatedName: string,
    schema: OpenApiSchemaObject,
    context: OpenApiSchemaContext
): string | undefined {
    const signature = schemaEquivalenceSignature(schema, context);
    return context.objectLiteralComponents
        .get(baseName)
        ?.map(component => component.name)
        .find(
            name =>
                name !== generatedName &&
                context.schemas[name] &&
                !context.generating.has(name) &&
                schemaEquivalenceSignature(context.schemas[name]!, context) === signature
        );
}

function schemaEquivalenceSignature(schema: OpenApiSchemaObject | OpenApiReferenceObject, context: OpenApiSchemaContext): string {
    return JSON.stringify(normalizeSchemaForEquivalence(schema, context, new Set()));
}

function normalizeSchemaForEquivalence(value: unknown, context: OpenApiSchemaContext, seenRefs: Set<string>): unknown {
    if (Array.isArray(value)) return value.map(item => normalizeSchemaForEquivalence(item, context, seenRefs));
    if (!value || typeof value !== 'object') return value;

    if ('$ref' in value && typeof value.$ref === 'string') {
        const refName = componentNameFromRef(value.$ref);
        if (!refName) return { $ref: value.$ref };
        const baseName = refName.replace(/_\d+$/, '');
        if (seenRefs.has(refName)) return { $ref: baseName };
        const schema = context.schemas[refName];
        if (!schema) return { $ref: baseName };
        const nextSeen = new Set(seenRefs);
        nextSeen.add(refName);
        return { $ref: baseName, schema: normalizeSchemaForEquivalence(schema, context, nextSeen) };
    }

    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
        const normalized = normalizeSchemaForEquivalence(record[key], context, seenRefs);
        output[key] = key === 'enum' && Array.isArray(normalized) ? [...normalized].sort() : normalized;
    }
    return output;
}

function componentNameFromRef(ref: string): string | undefined {
    const prefix = '#/components/schemas/';
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

function removeObjectLiteralComponent(baseName: string, name: string, context: OpenApiSchemaContext): void {
    const components = context.objectLiteralComponents.get(baseName);
    if (!components) return;
    const next = components.filter(component => component.name !== name);
    if (next.length) context.objectLiteralComponents.set(baseName, next);
    else context.objectLiteralComponents.delete(baseName);
}

function schemaReferencesComponent(schema: OpenApiSchemaObject | OpenApiReferenceObject, name: string): boolean {
    if ('$ref' in schema) return schema.$ref === `#/components/schemas/${name}`;
    return Object.values(schema).some(value => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some(item => item && typeof item === 'object' && schemaReferencesComponent(item, name));
        return schemaReferencesComponent(value as OpenApiSchemaObject | OpenApiReferenceObject, name);
    });
}

function reserveComponentName(baseName: string, componentOwner: object, context: OpenApiSchemaContext): string {
    let name = baseName;
    let suffix = 2;
    while (true) {
        const owner = context.componentTypes.get(name);
        if (!owner || owner === componentOwner) {
            context.componentTypes.set(name, componentOwner);
            return name;
        }
        name = `${baseName}_${suffix++}`;
    }
}

function sanitizeComponentName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'AnonymousSchema';
}

function getOpenApiName(type: Type): string | undefined {
    const annotation = getTypeAnnotation(type, 'openapi:name');
    return annotation?.kind === ReflectionKind.literal && typeof annotation.literal === 'string' ? annotation.literal : undefined;
}

function getWrappedOpenApiName(type: Type): string | undefined {
    return (type as Type & { openApiName?: string }).openApiName ?? getOpenApiName(type);
}

function wrapOpenApiTypeName(type: Type, openApiName: string | undefined): Type {
    if (!openApiName) return type;
    return { ...type, openApiName, typeName: openApiName } as unknown as Type;
}

function getTypeAnnotation(type: Type, ...names: string[]): Type | undefined {
    for (const name of names) {
        const direct = type.annotations?.[name];
        if (direct) return direct;
    }

    if ((type.kind === ReflectionKind.union || type.kind === ReflectionKind.intersection) && 'types' in type && Array.isArray(type.types)) {
        const annotations: Type[] = [];
        for (const child of type.types) {
            const nested = getTypeAnnotation(child as Type, ...names);
            if (nested) annotations.push(nested);
        }
        return singleCompatibleAnnotation(annotations);
    }

    for (const name of names) {
        const known = typeAnnotation.getType(type, name);
        if (known) return known;
    }
}

function singleCompatibleAnnotation(annotations: Type[]): Type | undefined {
    if (annotations.length === 0) return undefined;
    const first = annotations[0];
    const firstKey = annotationIdentity(first);
    if (!firstKey) return annotations.length === 1 ? first : undefined;
    return annotations.every(annotation => annotationIdentity(annotation) === firstKey) ? first : undefined;
}

function annotationIdentity(type: Type): string | undefined {
    if (type.kind === ReflectionKind.undefined) return 'undefined';
    if (type.kind === ReflectionKind.literal && 'literal' in type) return `literal:${typeof type.literal}:${String(type.literal)}`;
}

function isHttpMarkerType(type: Type): boolean {
    return !!(
        typeAnnotation.getType(type, 'httpBody') ||
        typeAnnotation.getType(type, 'httpQueries') ||
        typeAnnotation.getType(type, 'httpPath') ||
        typeAnnotation.getType(type, 'httpQuery') ||
        typeAnnotation.getType(type, 'httpHeader')
    );
}

function isOpenApiNameMarkerType(type: Type): boolean {
    return !!typeAnnotation.getType(type, 'openapi:name');
}

function httpAnnotationName(typeName: string | undefined): string | undefined {
    if (typeName === 'HttpBody') return 'httpBody';
    if (typeName === 'HttpQueries') return 'httpQueries';
    if (typeName === 'HttpPath') return 'httpPath';
    if (typeName === 'HttpQuery') return 'httpQuery';
    if (typeName === 'HttpHeader') return 'httpHeader';
}

function getAnnotationOptionType(type: Type, annotation: string): Type | undefined {
    const options = typeAnnotation.getType(type, annotation) ?? typeAnnotation.getOption(type, annotation);
    if (!options || typeof options !== 'object') return undefined;
    if ((options as Type).kind === ReflectionKind.objectLiteral) {
        const property = (options as Extract<Type, { kind: ReflectionKind.objectLiteral }>).types.find(
            item => item.kind === ReflectionKind.propertySignature && String(item.name) === 'type'
        );
        return property?.kind === ReflectionKind.propertySignature ? property.type : undefined;
    }
    const value = (options as { type?: unknown }).type;
    return isReflectedType(value) ? value : undefined;
}

function shouldApplyValidationAnnotations(type: Type): boolean {
    if (type.kind !== ReflectionKind.union) return true;
    const nonNull = flattenUnionTypes(type).filter(item => item.kind !== ReflectionKind.null && item.kind !== ReflectionKind.undefined);
    return nonNull.length <= 1;
}

function applyValidationAnnotations(type: Type, schema: OpenApiSchemaObject | OpenApiReferenceObject): void {
    if ('$ref' in schema) return;
    for (const annotation of validationAnnotation.getAnnotations(type)) {
        const value = literalValue(annotation.args?.[0]);
        if (annotation.name === 'minLength' && typeof value === 'number') schema.minLength = value;
        else if (annotation.name === 'maxLength' && typeof value === 'number') schema.maxLength = value;
        else if (annotation.name === 'minimum' && typeof value === 'number') schema.minimum = value;
        else if (annotation.name === 'greaterThan' && typeof value === 'number') schema.exclusiveMinimum = value;
        else if (annotation.name === 'maximum' && typeof value === 'number') schema.maximum = value;
        else if (annotation.name === 'lessThan' && typeof value === 'number') schema.exclusiveMaximum = value;
        else if (annotation.name === 'pattern') {
            if (value instanceof RegExp) schema.pattern = value.source;
            else if (typeof value === 'string') schema.pattern = value;
        }
    }
}

function literalValue(type: Type | undefined): unknown {
    const runtime = (type as (Type & { runtime?: unknown }) | undefined)?.runtime;
    if (runtime !== undefined) return typeof runtime === 'function' ? runtime() : runtime;
    return type?.kind === ReflectionKind.literal ? type.literal : undefined;
}

function withNullableSchema(schema: OpenApiSchemaObject | OpenApiReferenceObject): OpenApiSchemaObject | OpenApiReferenceObject {
    if ('$ref' in schema) return { anyOf: [schema, { type: 'null' }] };
    if (isEmptySchema(schema)) return schema;

    const next: OpenApiSchemaObject = { ...schema };
    if (next.enum && !next.enum.some(value => value === null)) next.enum = [...next.enum, null];
    if (next.type) {
        next.type = withNullType(next.type);
        return next;
    }

    if (next.oneOf || next.anyOf || next.allOf) return { anyOf: [next, { type: 'null' }] };
    next.type = 'null';
    return next;
}

function withNullType(type: string | string[]): string | string[] {
    const values = Array.isArray(type) ? type : [type];
    if (values.includes('null')) return type;
    return [...values, 'null'];
}

function jsonSchemaTypeForValue(value: unknown): string | undefined {
    if (value === null) return 'null';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'bigint') return 'integer';
}

function uniqueJsonSchemaTypes(types: string[]): string[] {
    const order = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
    const unique = [...new Set(types)];
    return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function uniqueEnumValues(values: unknown[]): unknown[] {
    const seen = new Set<string>();
    const unique: unknown[] = [];
    for (const value of values) {
        const key = `${typeof value}:${String(value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(value);
    }
    return unique;
}

function isEmptySchema(schema: OpenApiSchemaObject): boolean {
    return Object.keys(schema).length === 0;
}
