import { ReflectionClass, ReflectionKind } from '../../../reflection';
import type { Type } from '../../../reflection';

import type { BaseDatabase } from '../../database';
import { defaultEntityForeignKeyName, defaultEntityIndexName } from '../../identifiers';
import { getEntityMetadata } from '../../metadata';
import { resolveColumnType } from './type-mapper';
import { DatabaseSchema, ForeignKeySchema, IndexSchema, INTERNAL_TABLES, TableSchema } from './schema-model';

export interface ReadEntitiesSchemaOptions {
    tableNames?: readonly string[];
}

export function readEntitiesSchema(db: BaseDatabase, options: ReadEntitiesSchemaOptions = {}): DatabaseSchema {
    const schema: DatabaseSchema = new Map();
    const allowedTableNames = options.tableNames ? new Set(options.tableNames) : undefined;
    for (const entity of db.entityRegistry) {
        const reflection = ReflectionClass.from(entity);
        if (reflection.isDatabaseMigrationSkipped(db.driver.dialect)) continue;
        const tableName = getEntityTableName(entity);
        if (shouldSkipEntityTable(tableName, allowedTableNames)) continue;
        const metadata = getEntityMetadata(entity);
        const defaultInstance = new entity() as Record<string, unknown>;
        const columnsByProperty = new Map(metadata.columns.map(column => [column.propertyName, column]));
        const columnNameForProperty = (propertyName: string | number | symbol) =>
            columnsByProperty.get(String(propertyName))?.columnName ?? String(propertyName);

        const table: TableSchema = {
            name: metadata.tableName,
            columns: metadata.columns.map((column, index) => {
                const property = reflection.getProperty(column.propertyName);
                const isReference = property.isReference();
                const defaultValue = defaultInstance[column.propertyName];
                const type = isReference
                    ? property.getResolvedReflectionClass().getPrimary().getType()
                    : typeWithDefaultInitializer(column.type, defaultValue);
                const resolved = resolveColumnType(type, db.driver.dialect);
                if (resolved.type === 'double' && (column.primaryKey || column.autoIncrement || isReference)) resolved.type = 'int';
                const schema = {
                    name: column.columnName,
                    ...resolved,
                    enumTypeName:
                        db.driver.dialect === 'postgres' && resolved.type === 'enum' && resolved.enumValues?.length
                            ? `${metadata.tableName}_${column.columnName}_enum`
                            : undefined,
                    unsigned: resolved.unsigned ?? false,
                    nullable: column.nullable,
                    autoIncrement: column.autoIncrement,
                    primaryKey: column.primaryKey,
                    ordinalPosition: index + 1
                };
                applyDefaultInitializer(schema, defaultValue, db.driver.dialect);
                return schema;
            }),
            indexes: readEntityIndexes(metadata.tableName, reflection, columnNameForProperty, db.driver.dialect),
            foreignKeys: readEntityForeignKeys(metadata.tableName, reflection, columnNameForProperty, db.driver.dialect),
            primaryKeyColumns: metadata.columns.filter(column => column.primaryKey).map(column => column.columnName)
        };
        for (const foreignKey of table.foreignKeys) ensureForeignKeyIndex(table.indexes, table.name, foreignKey.localColumns, db.driver.dialect);
        schema.set(table.name, table);
    }
    return schema;
}

function shouldSkipEntityTable(tableName: string, allowedTableNames: ReadonlySet<string> | undefined): boolean {
    if (allowedTableNames && !allowedTableNames.has(tableName)) return true;
    return INTERNAL_TABLES.has(tableName) && !allowedTableNames?.has(tableName);
}

function typeWithDefaultInitializer(type: Type, value: unknown): Type {
    if (type.kind !== ReflectionKind.unknown || value === undefined || value === null) return type;
    if (typeof value === 'string') return { kind: ReflectionKind.string };
    if (typeof value === 'number') return { kind: ReflectionKind.number };
    if (typeof value === 'boolean') return { kind: ReflectionKind.boolean };
    if (value instanceof Date) return { kind: ReflectionKind.class, classType: Date };
    return type;
}

function applyDefaultInitializer(column: TableSchema['columns'][number], value: unknown, dialect: 'mysql' | 'postgres'): void {
    if (column.autoIncrement || value === undefined || value === null) return;
    if (value instanceof Date) {
        column.defaultExpression = 'CURRENT_TIMESTAMP';
    } else if (typeof value === 'boolean') {
        column.defaultValue = dialect === 'mysql' ? (value ? '1' : '0') : value;
    } else if (typeof value === 'number' || typeof value === 'string') {
        column.defaultValue = value;
    }
}

function getEntityTableName(entity: BaseDatabase['entityRegistry'][number]): string {
    const reflection = ReflectionClass.from(entity);
    return reflection.getCollectionName() || reflection.name || entity.name;
}

function readEntityIndexes(
    tableName: string,
    reflection: ReflectionClass<any>,
    columnNameForProperty: (propertyName: string | number | symbol) => string,
    dialect: BaseDatabase['driver']['dialect']
): IndexSchema[] {
    const indexes: IndexSchema[] = [];
    for (const index of reflection.indexes) {
        const columns = index.names.map(columnNameForProperty);
        if (!columns.length) continue;
        const unique = index.options.unique === true;
        const schema: IndexSchema = {
            name: index.options.name || defaultEntityIndexName(tableName, columns, dialect),
            columns,
            unique,
            size: index.options.size
        };
        mergeOrPushIndex(indexes, schema);
    }
    return indexes;
}

function readEntityForeignKeys(
    tableName: string,
    reflection: ReflectionClass<any>,
    columnNameForProperty: (propertyName: string | number | symbol) => string,
    dialect: BaseDatabase['driver']['dialect']
): ForeignKeySchema[] {
    const foreignKeys: ForeignKeySchema[] = [];
    for (const property of reflection.getProperties()) {
        if (!property.isReference() || property.isDatabaseMigrationSkipped('*')) continue;
        const localColumn = columnNameForProperty(property.name);
        const foreignReflection = property.getResolvedReflectionClass();
        const foreignMetadata = getEntityMetadata(foreignReflection.getClassType());
        const foreignColumns = foreignMetadata.columns.filter(column => column.primaryKey).map(column => column.columnName);
        if (!foreignColumns.length) continue;
        const reference = property.getReference();
        foreignKeys.push({
            name: defaultEntityForeignKeyName(tableName, [localColumn], dialect),
            localColumns: [localColumn],
            foreignTable: foreignMetadata.tableName,
            foreignColumns,
            onDelete: reference?.onDelete ?? 'CASCADE',
            onUpdate: reference?.onUpdate ?? 'CASCADE'
        });
    }
    return foreignKeys;
}

function ensureForeignKeyIndex(indexes: IndexSchema[], tableName: string, columns: string[], dialect: BaseDatabase['driver']['dialect']): void {
    if (indexes.some(index => startsWithColumns(index.columns, columns))) return;
    indexes.push({
        name: defaultEntityIndexName(tableName, columns, dialect),
        columns,
        unique: false
    });
}

function startsWithColumns(indexColumns: readonly string[], columns: readonly string[]): boolean {
    return columns.every((column, index) => indexColumns[index] === column);
}

function mergeOrPushIndex(indexes: IndexSchema[], schema: IndexSchema): void {
    const sameName = indexes.find(existing => existing.name === schema.name);
    if (sameName) {
        if (arraysEqual(sameName.columns, schema.columns)) {
            sameName.unique = sameName.unique || schema.unique;
            sameName.size ??= schema.size;
        }
        return;
    }
    if (!indexes.some(existing => sameIndexShape(existing, schema))) indexes.push(schema);
}

function sameIndexShape(a: IndexSchema, b: IndexSchema): boolean {
    if (a.unique !== b.unique || !arraysEqual(a.columns, b.columns)) return false;
    return a.columns.every(column => (a.columnSizes?.[column] ?? a.size) === (b.columnSizes?.[column] ?? b.size));
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}
