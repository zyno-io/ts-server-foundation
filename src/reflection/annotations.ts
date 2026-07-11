import { findNestedSurface, visitTypeSurface } from './type-utils';
import { ReflectionKind, type Type, type ValidationAnnotation } from './model';

export function isUUIDType(type: Type): boolean {
    const annotation = typeAnnotation.getType(type, 'tsf:type');
    return annotation?.kind === ReflectionKind.literal && (annotation.literal === 'uuid' || annotation.literal === 'uuidString');
}

export function isDatabaseUUIDType(type: Type): boolean {
    const annotation = typeAnnotation.getType(type, 'tsf:type');
    return annotation?.kind === ReflectionKind.literal && annotation.literal === 'uuid';
}

export const typeAnnotation = {
    getType(type: Type, name: string): Type | undefined {
        const direct = type.annotations?.[name];
        if (direct) return direct;
        return findNestedSurface(type, child => child.annotations?.[name]) ?? findTypiaTagTypeAnnotation(type, name);
    },

    getOption(type: Type, name: string): unknown {
        return this.getType(type, name);
    }
};

export const validationAnnotation = {
    getAnnotations(type: Type): ValidationAnnotation[] {
        const result: ValidationAnnotation[] = [];
        const seen = new Set<string>();
        visitTypeSurface(type, child => {
            if (child.validation) {
                for (const annotation of child.validation) {
                    const key = validationAnnotationKey(annotation);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    result.push(annotation);
                }
            }
            const typiaAnnotation = typiaTagValidationAnnotation(child);
            if (typiaAnnotation) {
                const key = validationAnnotationKey(typiaAnnotation);
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(typiaAnnotation);
                }
            }
        });
        return result;
    }
};

export const databaseAnnotation = {
    getDatabase<T = any>(type: Type, dialect: string): T | undefined {
        const direct = type.database?.[dialect] ?? (dialect !== '*' ? type.database?.['*'] : undefined);
        if (direct) return direct as T;
        if (type.kind === ReflectionKind.union) {
            const concrete = type.types.filter(item => item.kind !== ReflectionKind.null && item.kind !== ReflectionKind.undefined);
            if (concrete.length === 1) return this.getDatabase<T>(concrete[0], dialect);
            return undefined;
        }
        const nested = findNestedSurface(type, child => child.database?.[dialect] ?? (dialect !== '*' ? child.database?.['*'] : undefined)) as
            | T
            | undefined;
        if (nested) return nested;
        const typia = findTypiaTagDatabase<T>(type, dialect);
        if (typia) return typia;
    }
};

interface TypiaTag {
    kind: string;
    value?: Type;
    schema?: Type;
}

const undefinedType: Type = { kind: ReflectionKind.undefined };

function literalType(literal: unknown): Type {
    return { kind: ReflectionKind.literal, literal };
}

function validation(name: string, ...args: Type[]): ValidationAnnotation {
    return { name, args };
}

function findTypiaTagTypeAnnotation(type: Type, name: string): Type | undefined {
    return findSurface(type, child => typiaTagTypeAnnotation(child, name));
}

function typiaTagTypeAnnotation(type: Type, name: string): Type | undefined {
    const tag = readTypiaTag(type);
    if (!tag || tag.kind !== name) return undefined;
    if (!tag.kind.startsWith('tsf:') && !tag.kind.startsWith('openapi:')) return undefined;
    return tag.value ?? undefinedType;
}

function typiaTagValidationAnnotation(type: Type): ValidationAnnotation | undefined {
    const tag = readTypiaTag(type);
    if (!tag) return undefined;

    switch (tag.kind) {
        case 'minLength':
        case 'maxLength':
        case 'minimum':
        case 'greaterThan':
        case 'maximum':
        case 'lessThan':
            return tag.value ? validation(tag.kind, tag.value) : undefined;
        case 'pattern':
            return validation('pattern', tag.value ?? schemaProperty(tag.schema, 'pattern') ?? undefinedType);
        case 'format': {
            const format = literalString(tag.value) ?? literalString(schemaProperty(tag.schema, 'format'));
            const pattern = format ? formatPattern(format) : undefined;
            return pattern ? validation('pattern', literalType(pattern)) : undefined;
        }
        case 'tsf:validator':
            return validation('validator', tag.value ?? undefinedType);
        default:
            return undefined;
    }
}

function findTypiaTagDatabase<T>(type: Type, dialect: string): T | undefined {
    return findSurface(type, child => typiaTagDatabase<T>(child, dialect));
}

function typiaTagDatabase<T>(type: Type, dialect: string): T | undefined {
    const tag = readTypiaTag(type);
    if (!tag) return undefined;
    const payload = plainObjectFromType(tag.schema) ?? plainObjectFromType(tag.value);
    if (!payload) return undefined;

    if (tag.kind === 'database:field') return payload as T;
    if (tag.kind === 'database:mysql' && dialect === 'mysql') return payload as T;
}

function readTypiaTag(type: Type): TypiaTag | undefined {
    if (type.kind !== ReflectionKind.objectLiteral) return undefined;
    const tagProperty = type.types.find(property => String(property.name) === 'typia.tag');
    if (!tagProperty) return undefined;

    const tagType = unwrapOptionalType(tagProperty.type);
    if (tagType.kind !== ReflectionKind.objectLiteral) return undefined;
    const kind = literalString(schemaProperty(tagType, 'kind'));
    if (!kind) return undefined;

    return {
        kind,
        value: schemaProperty(tagType, 'value'),
        schema: schemaProperty(tagType, 'schema')
    };
}

function schemaProperty(type: Type | undefined, name: string): Type | undefined {
    const concrete = type ? unwrapOptionalType(type) : undefined;
    if (!concrete || concrete.kind !== ReflectionKind.objectLiteral) return undefined;
    return concrete.types.find(property => String(property.name) === name)?.type;
}

function unwrapOptionalType(type: Type): Type {
    if (type.kind !== ReflectionKind.union) return type;
    const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
    return concrete.length === 1 ? concrete[0] : type;
}

function literalString(type: Type | undefined): string | undefined {
    return type?.kind === ReflectionKind.literal && typeof type.literal === 'string' ? type.literal : undefined;
}

function plainObjectFromType(type: Type | undefined): Record<string, any> | undefined {
    const concrete = type ? unwrapOptionalType(type) : undefined;
    if (!concrete || concrete.kind !== ReflectionKind.objectLiteral) return undefined;

    const result: Record<string, any> = {};
    for (const property of concrete.types) {
        const value = plainValueFromType(property.type);
        if (value !== undefined) result[String(property.name)] = value;
    }
    return result;
}

function plainValueFromType(type: Type): unknown {
    const concrete = unwrapOptionalType(type);
    if (concrete.kind === ReflectionKind.literal) return concrete.literal;
    if (concrete.kind === ReflectionKind.undefined) return undefined;
    if (concrete.kind === ReflectionKind.objectLiteral) return plainObjectFromType(concrete);
    return undefined;
}

function findSurface<T>(type: Type, predicate: (type: Type) => T | undefined): T | undefined {
    let result: T | undefined;
    visitTypeSurface(type, child => {
        if (result !== undefined) return;
        result = predicate(child);
    });
    return result;
}

function formatPattern(format: string): string | undefined {
    switch (format) {
        case 'date':
            return '^\\d{4}-\\d{2}-\\d{2}$';
        case 'email':
            return '^[a-zA-Z0-9_+.-]+@[a-zA-Z0-9-.]+\\.[a-zA-Z]+$';
        case 'uuid':
            return '^(?:urn:uuid:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$';
        default:
            return undefined;
    }
}

function validationAnnotationKey(annotation: ValidationAnnotation): string {
    return `${annotation.name}:${annotation.args.map(validationAnnotationArgKey).join('|')}`;
}

function validationAnnotationArgKey(type: Type): string {
    if (type.kind === ReflectionKind.literal && 'literal' in type) return `literal:${String(type.literal)}`;
    const runtime = (type as Type & { runtime?: unknown }).runtime;
    if (runtime) return `runtime:${String(runtime)}`;
    return `${type.kind}:${type.typeName ?? ''}`;
}

export function knownPrimitiveKind(type: Type): ReflectionKind.string | ReflectionKind.number | ReflectionKind.boolean | undefined {
    const foundationType = typeAnnotation.getType(type, 'tsf:type');
    if (foundationType?.kind === ReflectionKind.literal) {
        if (foundationType.literal === 'integer') return ReflectionKind.number;
        if (typeof foundationType.literal === 'string') return ReflectionKind.string;
    }
}
