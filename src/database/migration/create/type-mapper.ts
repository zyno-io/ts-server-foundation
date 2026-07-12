import { databaseAnnotation, isDatabaseUUIDType, ReflectionKind, Type, typeAnnotation, validationAnnotation } from '../../../reflection';
import { flattenRuntimeUnionTypes, tryResolveClassType } from '../../../reflection/type-utils';
import { Coordinate } from '../../../types/type-annotations';

import type { Dialect } from '../../sql';

export interface ResolvedColumnType {
    type: string;
    size?: number;
    scale?: number;
    unsigned?: boolean;
    enumValues?: string[];
}

export function resolveColumnType(type: Type, dialect: Dialect): ResolvedColumnType {
    return applyMinimumUnsigned(type, dialect, resolveColumnTypeBase(type, dialect));
}

function resolveColumnTypeBase(type: Type, dialect: Dialect): ResolvedColumnType {
    if (hasConflictingTypeAnnotation(type, 'tsf:type')) return { type: 'json' };

    const rawType = getDatabaseTypeAnnotation(type, dialect);
    if (rawType) return parseRawSqlType(rawType, dialect);

    if (type.kind === ReflectionKind.union) {
        const nonNull = flattenRuntimeUnionTypes(type).filter(item => item.kind !== ReflectionKind.null && item.kind !== ReflectionKind.undefined);
        if (nonNull.length === 1) return resolveColumnType(nonNull[0], dialect);
        if (
            nonNull.length > 0 &&
            nonNull.every(item => item.kind === ReflectionKind.literal && typeof (item as { literal: unknown }).literal === 'string')
        ) {
            return {
                type: 'enum',
                enumValues: nonNull.map(item => String((item as { literal: unknown }).literal))
            };
        }
        return { type: 'json' };
    }

    const foundationType = getTypeAnnotation(type, 'tsf:type');
    if (foundationType?.kind === ReflectionKind.literal) {
        switch (foundationType.literal) {
            case 'date':
                return { type: 'date' };
            case 'phone':
            case 'phoneNanp':
                return { type: 'varchar', size: 20 };
            case 'uuid':
                return uuidColumnType(dialect);
            case 'uuidString':
                return uuidStringColumnType(dialect);
            case 'integer':
                return { type: 'int' };
        }
    }

    if (isDatabaseUUIDType(type)) {
        return uuidColumnType(dialect);
    }

    if (isBinaryType(type)) {
        return binaryColumnType(dialect);
    }

    const length = getTypeAnnotation(type, 'tsf:length');
    if (length?.kind === ReflectionKind.literal && typeof length.literal === 'number') {
        return { type: 'char', size: length.literal };
    }

    const maxLength = getMaxLength(type);
    if (maxLength !== undefined) {
        return { type: 'varchar', size: maxLength };
    }

    if (type.kind === ReflectionKind.intersection) {
        const rawIntersectionType = getDatabaseTypeAnnotation(type, dialect);
        if (rawIntersectionType) return parseRawSqlType(rawIntersectionType, dialect);

        const foundationIntersectionType = getTypeAnnotation(type, 'tsf:type');
        if (foundationIntersectionType?.kind === ReflectionKind.literal) {
            switch (foundationIntersectionType.literal) {
                case 'date':
                    return { type: 'date' };
                case 'phone':
                case 'phoneNanp':
                    return { type: 'varchar', size: 20 };
                case 'uuid':
                    return uuidColumnType(dialect);
                case 'uuidString':
                    return uuidStringColumnType(dialect);
                case 'integer':
                    return { type: 'int' };
            }
        }

        if (isDatabaseUUIDType(type)) {
            return uuidColumnType(dialect);
        }

        if (isBinaryType(type)) {
            return binaryColumnType(dialect);
        }

        const intersectionLength = getTypeAnnotation(type, 'tsf:length');
        if (intersectionLength?.kind === ReflectionKind.literal && typeof intersectionLength.literal === 'number') {
            return { type: 'char', size: intersectionLength.literal };
        }

        const intersectionMaxLength = getMaxLength(type);
        if (intersectionMaxLength !== undefined) {
            return { type: 'varchar', size: intersectionMaxLength };
        }

        const base = type.types.find(item =>
            [
                ReflectionKind.string,
                ReflectionKind.number,
                ReflectionKind.boolean,
                ReflectionKind.bigint,
                ReflectionKind.enum,
                ReflectionKind.union,
                ReflectionKind.class,
                ReflectionKind.literal
            ].includes(item.kind)
        );
        if (base) return resolveColumnType(base, dialect);
    }

    if (type.kind === ReflectionKind.enum) {
        const values = type.values.filter(value => value !== null && value !== undefined);
        if (values.length && values.every(value => typeof value === 'string')) {
            return { type: 'enum', enumValues: values.map(String) };
        }
        return { type: 'int' };
    }

    if (type.kind === ReflectionKind.literal) {
        switch (typeof type.literal) {
            case 'string':
                return { type: 'varchar', size: 255 };
            case 'number':
                return { type: 'double' };
            case 'boolean':
                return dialect === 'postgres' ? { type: 'boolean' } : { type: 'tinyint', size: 1, unsigned: true };
        }
    }

    switch (type.kind) {
        case ReflectionKind.string:
            return { type: 'varchar', size: 255 };
        case ReflectionKind.number:
            return { type: 'double' };
        case ReflectionKind.bigint:
            return { type: 'bigint' };
        case ReflectionKind.boolean:
            return dialect === 'postgres' ? { type: 'boolean' } : { type: 'tinyint', size: 1, unsigned: true };
        case ReflectionKind.class: {
            const classType = tryResolveClassType(type.classType);
            if (classType === Date) return dialect === 'postgres' ? { type: 'timestamp' } : { type: 'datetime' };
            if (dialect === 'mysql' && classType === Coordinate) return { type: 'point' };
            if (isBinaryType(type)) return binaryColumnType(dialect);
            return { type: 'json' };
        }
        case ReflectionKind.objectLiteral:
        case ReflectionKind.array:
        case ReflectionKind.any:
            return { type: 'json' };
        default:
            return { type: 'json' };
    }
}

function applyMinimumUnsigned(type: Type, dialect: Dialect, resolved: ResolvedColumnType): ResolvedColumnType {
    if (dialect !== 'mysql' || resolved.unsigned === true || !supportsUnsigned(resolved)) return resolved;
    const minimum = getMinimum(type);
    return minimum !== undefined && minimum >= 0 ? { ...resolved, unsigned: true } : resolved;
}

function supportsUnsigned(resolved: ResolvedColumnType): boolean {
    return ['bigint', 'decimal', 'double', 'float', 'int', 'mediumint', 'smallint', 'tinyint'].includes(resolved.type);
}

function uuidColumnType(dialect: Dialect): ResolvedColumnType {
    return dialect === 'postgres' ? { type: 'uuid' } : { type: 'binary', size: 16 };
}

function uuidStringColumnType(dialect: Dialect): ResolvedColumnType {
    return dialect === 'postgres' ? { type: 'uuid' } : { type: 'char', size: 36 };
}

function binaryColumnType(dialect: Dialect): ResolvedColumnType {
    return dialect === 'postgres' ? { type: 'bytea' } : { type: 'blob' };
}

function isBinaryType(type: Type): boolean {
    const typeName = (type as Type & { typeName?: string }).typeName;
    if (typeName === 'Uint8Array' || typeName === 'ArrayBuffer' || typeName === 'Buffer') return true;
    if (type.kind === ReflectionKind.class) {
        const className = type.classType?.name;
        return className === 'Uint8Array' || className === 'ArrayBuffer' || className === 'Buffer';
    }
    if ('types' in type && Array.isArray(type.types)) return type.types.some(isBinaryType);
    return false;
}

function getTypeAnnotation(type: Type, ...names: string[]): Type | undefined {
    for (const name of names) {
        const direct = typeAnnotation.getType(type, name);
        if (direct) return direct;
    }

    if ('types' in type && Array.isArray(type.types)) {
        for (const child of type.types) {
            const nested = getTypeAnnotation(child, ...names);
            if (nested) return nested;
        }
    }
}

function getMaxLength(type: Type): number | undefined {
    for (const annotation of validationAnnotation.getAnnotations(type)) {
        if (annotation.name !== 'maxLength') continue;
        const arg = annotation.args?.[0];
        if (arg?.kind === ReflectionKind.literal && typeof arg.literal === 'number') return arg.literal;
    }

    if ('types' in type && Array.isArray(type.types)) {
        for (const child of type.types) {
            const nested = getMaxLength(child);
            if (nested !== undefined) return nested;
        }
    }
}

function getMinimum(type: Type): number | undefined {
    let minimum: number | undefined;
    for (const annotation of validationAnnotation.getAnnotations(type)) {
        if (annotation.name !== 'minimum' && annotation.name !== 'greaterThan') continue;
        const arg = annotation.args?.[0];
        if (arg?.kind !== ReflectionKind.literal || typeof arg.literal !== 'number') continue;
        minimum = minimum === undefined ? arg.literal : Math.max(minimum, arg.literal);
    }
    return minimum;
}

function hasConflictingTypeAnnotation(type: Type, name: string): boolean {
    const values = new Set<unknown>();
    collectTypeAnnotationLiterals(type, name, values);
    return values.size > 1;
}

function collectTypeAnnotationLiterals(type: Type, name: string, values: Set<unknown>): void {
    const direct = type.annotations?.[name];
    if (direct?.kind === ReflectionKind.literal) values.add(direct.literal);
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        for (const item of type.types) collectTypeAnnotationLiterals(item, name, values);
    } else if (type.kind === ReflectionKind.array) {
        collectTypeAnnotationLiterals(type.type, name, values);
    } else if (type.kind === ReflectionKind.tuple) {
        for (const item of type.types) collectTypeAnnotationLiterals(item.type, name, values);
    }
}

export function parseRawSqlType(raw: string, dialect: Dialect): ResolvedColumnType {
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    const unsigned = dialect === 'mysql' && /\bunsigned\b/.test(normalized);
    const withoutUnsigned = normalized.replace(/\bunsigned\b/g, '').trim();
    const enumMatch = withoutUnsigned.match(/^enum\s*\((.*)\)$/);
    if (enumMatch) {
        return {
            type: 'enum',
            enumValues: enumMatch[1].split(',').map(item =>
                item
                    .trim()
                    .replace(/^'(.*)'$/, '$1')
                    .replace(/''/g, "'")
            )
        };
    }

    const match = withoutUnsigned.match(/^([a-z ]+?)(?:\((\d+)(?:\s*,\s*(\d+))?\))?$/);
    if (!match) return { type: canonicalType(withoutUnsigned), unsigned };

    return {
        type: canonicalType(match[1].trim()),
        size: match[2] === undefined ? undefined : Number(match[2]),
        scale: match[3] === undefined ? undefined : Number(match[3]),
        unsigned
    };
}

export function canonicalType(type: string): string {
    switch (type.toLowerCase()) {
        case 'integer':
            return 'int';
        case 'bool':
            return 'boolean';
        case 'numeric':
            return 'decimal';
        case 'character varying':
            return 'varchar';
        case 'timestamp without time zone':
        case 'timestamp with time zone':
            return 'timestamp';
        case 'double precision':
            return 'double';
        default:
            return type.toLowerCase();
    }
}

function getDatabaseTypeAnnotation(type: Type, dialect: Dialect): string | undefined {
    return (
        databaseAnnotation.getDatabase<{ type?: string }>(type, dialect)?.type ?? databaseAnnotation.getDatabase<{ type?: string }>(type, '*')?.type
    );
}
