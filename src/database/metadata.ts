import { ReflectionClass, ReflectionKind, Type, typeAnnotation } from '../reflection';

import type { ClassType } from '../types';

export interface ColumnMetadata {
    propertyName: string;
    columnName: string;
    primaryKey: boolean;
    autoIncrement: boolean;
    optional: boolean;
    allowsNull: boolean;
    nullable: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    type: Type;
}

export interface EntityMetadata<T extends BaseEntityLike = BaseEntityLike> {
    classType: EntityClass<T>;
    tableName: string;
    columns: ColumnMetadata[];
    primaryKeys: ColumnMetadata[];
    primaryKey: ColumnMetadata;
}

export type BaseEntityLike = object;

export type EntityClass<T extends BaseEntityLike = BaseEntityLike> = ClassType<T> & {
    getDatabase?: () => unknown;
};

const metadataCache = new WeakMap<EntityClass, EntityMetadata>();

export function getEntityMetadata<T extends BaseEntityLike>(classType: EntityClass<T>): EntityMetadata<T> {
    const cached = metadataCache.get(classType);
    if (cached) return cached as EntityMetadata<T>;

    const reflection = ReflectionClass.from(classType);
    const tableName = reflection.getCollectionName() || reflection.name || classType.name;
    const defaultValues = getDefaultValues(classType);
    const columns = reflection
        .getProperties()
        .filter(prop => prop.type.kind !== ReflectionKind.method && !prop.isBackReference() && !prop.isDatabaseSkipped('*'))
        .map(prop => {
            const database = prop.getDatabase<{ name?: string }>('*');
            const propertyName = String(prop.name);
            const optional = prop.isOptional();
            const allowsNull = prop.isNullable();
            return {
                propertyName,
                columnName: database?.name ?? propertyName,
                primaryKey: prop.isPrimaryKey(),
                autoIncrement: prop.isAutoIncrement(),
                optional,
                allowsNull,
                nullable: optional || allowsNull,
                hasDefault: hasTypeAnnotation(prop.getType(), 'tsf:hasDefault'),
                defaultValue: defaultValues?.[propertyName],
                type: prop.getType()
            };
        });
    const primaryKeys = columns.filter(col => col.primaryKey);
    const primaryKey = primaryKeys[0] ?? columns.find(col => col.propertyName === 'id');
    if (!primaryKey) throw new Error(`Entity ${classType.name} has no primary key`);

    const metadata: EntityMetadata<T> = {
        classType,
        tableName,
        columns,
        primaryKeys: primaryKeys.length ? primaryKeys : [primaryKey],
        primaryKey
    };
    metadataCache.set(classType, metadata as EntityMetadata);
    return metadata;
}

function getDefaultValues(classType: EntityClass): Record<string, unknown> | undefined {
    try {
        return new classType() as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function hasTypeAnnotation(type: Type, ...names: string[]): boolean {
    for (const name of names) {
        if (typeAnnotation.getType(type, name)) return true;
    }
    if ((type as Type & { typeName?: string }).typeName === 'HasDefault') return true;

    if ((type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) && 'types' in type) {
        return type.types.some(child => hasTypeAnnotation(child, ...names));
    }
    return false;
}
