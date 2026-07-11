import { ReflectionClass } from './reflection-class';
import {
    isReflectedType,
    ReflectionKind,
    type ClassType,
    type Type,
    type TypeObjectLiteral,
    type TypeProperty,
    type TypePropertySignature
} from './model';

export function unwrapValueType(type: Type): Type {
    if (type.kind === ReflectionKind.union) {
        const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
        return concrete.length === 1 ? unwrapValueType(concrete[0]) : type;
    }
    if (type.kind === ReflectionKind.intersection) {
        const mergedObject = mergedIntersectionObjectLiteral(type);
        if (mergedObject) return mergedObject;
        const meaningful = type.types.find(item => !isMarkerType(item));
        return meaningful ? unwrapValueType(meaningful) : type;
    }
    return type;
}

export function mergedIntersectionObjectLiteral(type: Type): TypeObjectLiteral | undefined {
    if (type.kind !== ReflectionKind.intersection) return undefined;

    const properties = mergeStructuredProperties(type);
    if (properties.length === 0) return undefined;
    return { kind: ReflectionKind.objectLiteral, typeName: type.typeName, types: properties };
}

export function mergeStructuredProperties(type: Type): TypePropertySignature[] {
    const order: string[] = [];
    const byName = new Map<string, TypePropertySignature>();

    const addProperty = (property: TypePropertySignature | TypeProperty) => {
        const key = String(property.name);
        if (!byName.has(key)) order.push(key);
        byName.set(key, {
            kind: ReflectionKind.propertySignature,
            name: property.name,
            type: property.type,
            optional: property.optional
        });
    };

    const collect = (item: Type) => {
        if (isMarkerType(item)) return;
        if (item.kind === ReflectionKind.intersection) {
            for (const child of item.types) collect(child);
            return;
        }
        if (item.kind === ReflectionKind.objectLiteral) {
            for (const property of objectLiteralPropertiesFromType(item)) addProperty(property);
            return;
        }
    };

    collect(type);
    return order.map(key => byName.get(key)!);
}

export function objectLiteralPropertiesFromType(type: TypeObjectLiteral, seen = new Set<Type>()): TypePropertySignature[] {
    if (seen.has(type)) return [];
    if (isMarkerType(type)) return [];
    seen.add(type);

    const inherited: TypePropertySignature[] = [];
    for (const base of type.implements ?? []) {
        const unwrapped = unwrapValueType(base);
        if (seen.has(unwrapped)) continue;
        if (unwrapped.kind === ReflectionKind.objectLiteral) {
            inherited.push(...objectLiteralPropertiesFromType(unwrapped, seen));
        } else if (unwrapped.kind === ReflectionKind.intersection) {
            inherited.push(...mergeStructuredProperties(unwrapped));
        } else if (unwrapped.kind === ReflectionKind.class) {
            inherited.push(...utilitySourcePropertiesFromType(unwrapped));
        }
    }

    return mergeUtilityProperties([...inherited, ...type.types.map(cloneUtilityProperty)]);
}

export function objectLiteralIndexType(type: TypeObjectLiteral, seen = new Set<Type>()): Type | undefined {
    if (type.index) return type.index;
    if (seen.has(type)) return undefined;
    seen.add(type);

    for (const base of type.implements ?? []) {
        const unwrapped = unwrapValueType(base);
        if (unwrapped.kind === ReflectionKind.objectLiteral) {
            const index = objectLiteralIndexType(unwrapped, seen);
            if (index) return index;
        }
    }
}

export function isMarkerType(type: Type): boolean {
    return Boolean(type.annotations || type.validation || type.database || isBareKnownMarkerType(type) || isTypiaTagOnlyObject(type));
}

function isBareKnownMarkerType(type: Type): boolean {
    return type.kind === ReflectionKind.unknown && isKnownMarkerTypeName(type.typeName);
}

function isKnownMarkerTypeName(typeName: string | undefined): boolean {
    switch (typeName) {
        case 'ApiName':
        case 'AutoIncrement':
        case 'DatabaseField':
        case 'GreaterThan':
        case 'HasDefault':
        case 'Index':
        case 'LessThan':
        case 'Maximum':
        case 'MaxLength':
        case 'Minimum':
        case 'MinLength':
        case 'MySQL':
        case 'OnUpdate':
        case 'Pattern':
        case 'PrimaryKey':
        case 'Reference':
        case 'TypeAnnotation':
        case 'Unique':
            return true;
        default:
            return false;
    }
}

function isTypiaTagOnlyObject(type: Type): boolean {
    return (
        type.kind === ReflectionKind.objectLiteral &&
        type.types.length > 0 &&
        type.types.every(property => property.kind === ReflectionKind.propertySignature && String(property.name) === 'typia.tag')
    );
}

export function allowsUndefined(type: Type): boolean {
    return (
        type.kind === ReflectionKind.any ||
        type.kind === ReflectionKind.undefined ||
        (type.kind === ReflectionKind.union && type.types.some(allowsUndefined))
    );
}

export function allowsNull(type: Type): boolean {
    return (
        type.kind === ReflectionKind.any || type.kind === ReflectionKind.null || (type.kind === ReflectionKind.union && type.types.some(allowsNull))
    );
}

export function resolveClassType(value: ClassType | (() => ClassType)): ClassType {
    const resolved = tryResolveClassType(value);
    if (!resolved) throw new Error('Target is not a constructor');
    return resolved;
}

export function tryResolveClassType(value: ClassType | (() => ClassType)): ClassType | undefined {
    if (isClass(value)) return value;
    try {
        const resolved = (value as () => unknown)();
        return isClass(resolved) ? resolved : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeTypeMetadata(value: unknown, seen = new Set<unknown>()): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.kind === ReflectionKind.class && typeof record.classType === 'function' && !isClass(record.classType)) {
        try {
            const resolved = (record.classType as () => unknown)();
            if (isClass(resolved)) record.classType = resolved;
        } catch {
            // Leave unresolved circular references as thunks until the next metadata read.
        }
    }
    for (const child of Object.values(record)) {
        if (typeof child === 'function') continue;
        if (Array.isArray(child)) {
            for (const item of child) normalizeTypeMetadata(item, seen);
        } else {
            normalizeTypeMetadata(child, seen);
        }
    }
    expandUtilityTypeMetadata(record);
}

export function isClass(value: unknown): value is ClassType {
    return Boolean(typeof value === 'function' && value.prototype && value.prototype.constructor === value);
}

export function expandUtilityTypeMetadata(record: Record<string, unknown>): void {
    const utilityType = getUtilityTypeName(record);
    if (!utilityType) return;

    const typeArguments = Array.isArray(record.typeArguments) ? record.typeArguments : [];

    if (utilityType === 'Record') {
        if (record.kind !== ReflectionKind.objectLiteral || ((record.types as unknown[]) ?? []).length > 0) return;
        const keyType = typeArguments[0];
        const valueType = typeArguments[1];
        if (!isReflectedType(keyType) || !isReflectedType(valueType)) return;
        const properties = recordPropertiesFromKeyType(keyType, valueType);
        if (properties.length > 0) {
            record.types = properties;
            delete record.index;
        } else {
            record.index = valueType;
        }
        return;
    }

    if (((record.types as unknown[]) ?? []).length > 0) return;

    const source = typeArguments[0];
    if (!isReflectedType(source)) return;

    if (utilityType === 'Extract') {
        const target = typeArguments[1];
        if (record.kind !== ReflectionKind.union || !isReflectedType(target)) return;
        record.types = flattenRuntimeUnionTypes(source).filter(item => isExtractAssignable(item, target));
        return;
    }

    if (record.kind !== ReflectionKind.objectLiteral) return;

    const sourceProperties = utilitySourcePropertiesFromType(source);
    const sourceIndex = source.kind === ReflectionKind.objectLiteral ? objectLiteralIndexType(source) : undefined;
    if (sourceProperties.length === 0) {
        if (sourceIndex) record.index = sourceIndex;
        return;
    }

    const keys = new Set((Array.isArray(record.utilityKeys) ? record.utilityKeys : []).filter((item): item is string => typeof item === 'string'));
    let properties = sourceProperties.map(cloneUtilityProperty);
    if (utilityType === 'Pick') properties = properties.filter(property => keys.has(String(property.name)));
    else if (utilityType === 'Omit') properties = properties.filter(property => !keys.has(String(property.name)));
    else if (utilityType === 'Partial') properties = properties.map(property => ({ ...property, optional: true }));
    else if (utilityType === 'Required') properties = properties.map(property => ({ ...property, optional: undefined }));
    else if (utilityType === 'OptionalNulls') {
        properties = properties.map(property => (allowsNull(property.type) ? { ...property, optional: true } : property));
    }

    record.types = properties;
    if (sourceIndex) record.index = sourceIndex;
}

export function recordPropertiesFromKeyType(keyType: Type, valueType: Type): TypePropertySignature[] {
    const keys = recordLiteralKeysFromType(keyType);
    return keys.map(key => ({
        kind: ReflectionKind.propertySignature,
        name: key,
        type: valueType,
        optional: undefined
    }));
}

export function recordLiteralKeysFromType(type: Type): Array<string | number> {
    const keys: Array<string | number> = [];
    for (const item of flattenRuntimeUnionTypes(type)) {
        if (item.kind !== ReflectionKind.literal || (typeof item.literal !== 'string' && typeof item.literal !== 'number')) return [];
        keys.push(item.literal);
    }
    return keys;
}

export function flattenRuntimeUnionTypes(type: Type): Type[] {
    return type.kind === ReflectionKind.union ? type.types.flatMap(flattenRuntimeUnionTypes) : [type];
}

export function isExtractAssignable(source: Type, target: Type): boolean {
    const sourceType = unwrapValueType(source);
    const targetType = unwrapValueType(target);

    if (targetType.kind === ReflectionKind.union) return targetType.types.some(item => isExtractAssignable(sourceType, item));
    if (sourceType.kind === ReflectionKind.union) return sourceType.types.every(item => isExtractAssignable(item, targetType));

    if (targetType.kind === ReflectionKind.objectLiteral) {
        const targetProperties = objectLiteralPropertiesFromType(targetType).filter(
            property => !property.optional && !allowsUndefined(property.type)
        );
        if (targetProperties.length === 0) return sourceType.kind === ReflectionKind.objectLiteral || sourceType.kind === ReflectionKind.class;
        const sourceProperties = utilitySourcePropertiesFromType(sourceType);
        if (sourceProperties.length === 0) return false;
        return targetProperties.every(targetProperty => {
            const sourceProperty = sourceProperties.find(property => String(property.name) === String(targetProperty.name));
            return sourceProperty ? typesOverlap(sourceProperty.type, targetProperty.type) : false;
        });
    }

    return typesOverlap(sourceType, targetType);
}

export function typesOverlap(left: Type, right: Type): boolean {
    const leftType = unwrapValueType(left);
    const rightType = unwrapValueType(right);
    if (
        leftType.kind === ReflectionKind.any ||
        leftType.kind === ReflectionKind.unknown ||
        rightType.kind === ReflectionKind.any ||
        rightType.kind === ReflectionKind.unknown
    ) {
        return true;
    }
    if (leftType.kind === ReflectionKind.union) return leftType.types.some(item => typesOverlap(item, rightType));
    if (rightType.kind === ReflectionKind.union) return rightType.types.some(item => typesOverlap(leftType, item));
    if (leftType.kind === ReflectionKind.literal && rightType.kind === ReflectionKind.literal) return leftType.literal === rightType.literal;
    if (leftType.kind === ReflectionKind.literal) return literalMatchesType(leftType.literal, rightType);
    if (rightType.kind === ReflectionKind.literal) return literalMatchesType(rightType.literal, leftType);
    return leftType.kind === rightType.kind;
}

export function literalMatchesType(value: unknown, type: Type): boolean {
    if (value === null) return type.kind === ReflectionKind.null;
    if (value === undefined) return type.kind === ReflectionKind.undefined;
    if (typeof value === 'string') return type.kind === ReflectionKind.string || type.kind === ReflectionKind.templateLiteral;
    if (typeof value === 'number') return type.kind === ReflectionKind.number;
    if (typeof value === 'boolean') return type.kind === ReflectionKind.boolean;
    if (typeof value === 'bigint') return type.kind === ReflectionKind.bigint;
    return false;
}

export function utilitySourcePropertiesFromType(type: Type): TypePropertySignature[] {
    if (type.kind === ReflectionKind.class) {
        const Target = tryResolveClassType(type.classType);
        if (!Target) return [];
        try {
            return ReflectionClass.from(Target)
                .getProperties()
                .map(property => ({
                    kind: ReflectionKind.propertySignature,
                    name: property.name,
                    type: property.getType(),
                    optional: property.isOptional() ? true : undefined,
                    description: property.getDescription() || undefined
                }));
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('No runtime type metadata for ')) return [];
            throw error;
        }
    }

    if (type.kind === ReflectionKind.objectLiteral) return objectLiteralPropertiesFromType(type);
    if (type.kind === ReflectionKind.intersection) return mergeUtilityProperties(type.types.flatMap(utilitySourcePropertiesFromType));
    return [];
}

export function mergeUtilityProperties(properties: TypePropertySignature[]): TypePropertySignature[] {
    const order: string[] = [];
    const byName = new Map<string, TypePropertySignature>();
    for (const property of properties) {
        const key = String(property.name);
        if (!byName.has(key)) order.push(key);
        byName.set(key, cloneUtilityProperty(property));
    }
    return order.map(key => byName.get(key)!);
}

export function cloneUtilityProperty(property: TypePropertySignature): TypePropertySignature {
    return {
        kind: ReflectionKind.propertySignature,
        name: property.name,
        type: property.type,
        optional: property.optional ? true : undefined,
        description: property.description
    };
}

export function isUtilityTypeName(value: unknown): value is 'Pick' | 'Omit' | 'Partial' | 'Required' | 'Extract' | 'Record' | 'OptionalNulls' {
    return (
        value === 'Pick' ||
        value === 'Omit' ||
        value === 'Partial' ||
        value === 'Required' ||
        value === 'Extract' ||
        value === 'Record' ||
        value === 'OptionalNulls'
    );
}

export function getUtilityTypeName(
    record: Record<string, unknown>
): 'Pick' | 'Omit' | 'Partial' | 'Required' | 'Extract' | 'Record' | 'OptionalNulls' | undefined {
    if (isUtilityTypeName(record.utilityType)) return record.utilityType;
    if (isUtilityTypeName(record.typeName)) return record.typeName;
}

export function visitType(type: Type, visitor: (type: Type) => void): void {
    visitor(type);
    if ((type.kind === ReflectionKind.union || type.kind === ReflectionKind.intersection) && 'types' in type) {
        for (const child of type.types) visitType(child, visitor);
    } else if ((type.kind === ReflectionKind.array || type.kind === ReflectionKind.promise) && 'type' in type) {
        visitType(type.type, visitor);
    } else if (type.kind === ReflectionKind.objectLiteral && 'types' in type) {
        for (const property of type.types) visitType(property.type, visitor);
        if (type.index) visitType(type.index, visitor);
    }
}

export function visitTypeSurface(type: Type, visitor: (type: Type) => void): void {
    visitor(type);
    if ((type.kind === ReflectionKind.union || type.kind === ReflectionKind.intersection) && 'types' in type) {
        for (const child of type.types) visitTypeSurface(child, visitor);
    }
}

export function findNested<T>(type: Type, predicate: (type: Type) => T | undefined): T | undefined {
    let result: T | undefined;
    visitType(type, child => {
        if (result !== undefined || child === type) return;
        result = predicate(child);
    });
    return result;
}

export function findNestedSurface<T>(type: Type, predicate: (type: Type) => T | undefined): T | undefined {
    let result: T | undefined;
    visitTypeSurface(type, child => {
        if (result !== undefined || child === type) return;
        result = predicate(child);
    });
    return result;
}

export function hasNestedType(type: Type, predicate: (type: Type) => boolean): boolean {
    let found = false;
    visitType(type, child => {
        found ||= predicate(child);
    });
    return found;
}

export function literalNumber(type: Type | undefined): number | undefined {
    return type?.kind === ReflectionKind.literal && typeof type.literal === 'number' ? type.literal : undefined;
}

export function resolveRuntimeValue(type: Type | undefined): unknown {
    if (!type) return undefined;
    const runtime = (type as Type & { runtime?: unknown }).runtime;
    if (runtime !== undefined) return typeof runtime === 'function' ? runtime() : runtime;
    if (type.kind === ReflectionKind.literal) return type.literal;
    return undefined;
}

export function joinPath(base: string, key: string): string {
    return base ? `${base}.${key}` : key;
}
