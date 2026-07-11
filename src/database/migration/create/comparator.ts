import {
    ColumnModification,
    ColumnSchema,
    DatabaseSchema,
    Dialect,
    ForeignKeyModification,
    ForeignKeySchema,
    IndexModification,
    IndexSchema,
    SchemaDiff,
    TableDiff,
    TableSchema
} from './schema-model';
import { defaultEntityForeignKeyName, defaultEntityIndexName, normalizeGeneratedIdentifier } from '../../identifiers';

export function compareSchemas(entitySchema: DatabaseSchema, dbSchema: DatabaseSchema, dialect: Dialect, pgSchema?: string): SchemaDiff {
    const addedTables: TableSchema[] = [];
    const removedTables: TableSchema[] = [];
    const modifiedTables: TableDiff[] = [];

    for (const [name, table] of entitySchema) {
        if (!dbSchema.has(name)) addedTables.push(table);
    }
    for (const [name, table] of dbSchema) {
        if (!entitySchema.has(name)) removedTables.push(table);
    }
    for (const [name, entityTable] of entitySchema) {
        const dbTable = dbSchema.get(name);
        if (!dbTable) continue;
        const diff = compareTable(entityTable, dbTable, dialect);
        if (diff) modifiedTables.push(diff);
    }

    return {
        dialect,
        pgSchema,
        externalForeignKeyDrops: [],
        externalForeignKeyAdds: [],
        addedTables,
        removedTables,
        modifiedTables
    };
}

function compareTable(entityTable: TableSchema, dbTable: TableSchema, dialect: Dialect): TableDiff | undefined {
    const entityColumns = new Map(entityTable.columns.map(column => [column.name, column]));
    const dbColumns = new Map(dbTable.columns.map(column => [column.name, column]));
    const addedColumns = entityTable.columns.filter(column => !dbColumns.has(column.name));
    const removedColumns = dbTable.columns.filter(column => !entityColumns.has(column.name));
    const modifiedColumns: ColumnModification[] = [];

    for (const [name, entityColumn] of entityColumns) {
        const dbColumn = dbColumns.get(name);
        if (!dbColumn) continue;
        const modification = compareColumn(entityColumn, dbColumn, dialect);
        if (modification) modifiedColumns.push(modification);
    }

    const oldPrimaryKey = getPrimaryKeyColumns(dbTable);
    const newPrimaryKey = getPrimaryKeyColumns(entityTable);
    const primaryKeyChanged = !arraysEqual(oldPrimaryKey, newPrimaryKey);
    const oldAutoIncrementPrimaryKeyColumns = dbTable.columns.filter(column => column.autoIncrement && oldPrimaryKey.includes(column.name));
    const newAutoIncrementColumns = entityTable.columns.filter(column => column.autoIncrement);
    const { addedIndexes, removedIndexes, modifiedIndexes } = compareIndexes(entityTable.name, entityTable.indexes, dbTable.indexes, dialect);
    const { addedForeignKeys, removedForeignKeys, modifiedForeignKeys, unchangedForeignKeys } = compareForeignKeys(
        entityTable.name,
        entityTable.foreignKeys,
        dbTable.foreignKeys,
        dialect
    );
    const preservedForeignKeys = getPreservedForeignKeys(unchangedForeignKeys, {
        removedColumns,
        modifiedColumns,
        oldPrimaryKey,
        newPrimaryKey,
        primaryKeyChanged
    });

    if (
        !addedColumns.length &&
        !removedColumns.length &&
        !modifiedColumns.length &&
        !primaryKeyChanged &&
        !addedIndexes.length &&
        !removedIndexes.length &&
        !modifiedIndexes.length &&
        !addedForeignKeys.length &&
        !removedForeignKeys.length &&
        !modifiedForeignKeys.length &&
        !preservedForeignKeys.length
    ) {
        return undefined;
    }

    return {
        tableName: entityTable.name,
        addedColumns,
        removedColumns,
        modifiedColumns,
        primaryKeyChanged,
        oldPrimaryKey,
        newPrimaryKey,
        oldPrimaryKeyConstraintName: dbTable.primaryKeyConstraintName,
        oldAutoIncrementPrimaryKeyColumns,
        newAutoIncrementColumns,
        addedIndexes,
        removedIndexes,
        modifiedIndexes,
        addedForeignKeys,
        removedForeignKeys,
        modifiedForeignKeys,
        preservedForeignKeys
    };
}

function compareIndexes(tableName: string, entityIndexes: readonly IndexSchema[] = [], dbIndexes: readonly IndexSchema[] = [], dialect: Dialect) {
    const matchedEntityIndexes = new Set<IndexSchema>();
    const matchedDbIndexes = new Set<IndexSchema>();
    const modifiedIndexes: IndexModification[] = [];

    for (const entityIndex of entityIndexes) {
        const dbIndex = findMatchingIndex(tableName, entityIndex, dbIndexes, matchedDbIndexes, dialect);
        if (!dbIndex) continue;
        matchedEntityIndexes.add(entityIndex);
        matchedDbIndexes.add(dbIndex);
        if (indexesMatch(entityIndex, dbIndex)) continue;
        modifiedIndexes.push({ name: entityIndex.name, oldIndex: dbIndex, newIndex: entityIndex });
    }

    const addedIndexes = entityIndexes.filter(index => !matchedEntityIndexes.has(index));
    const removedIndexes = dbIndexes.filter(index => !matchedDbIndexes.has(index));

    return { addedIndexes, removedIndexes, modifiedIndexes };
}

function compareForeignKeys(
    tableName: string,
    entityForeignKeys: readonly ForeignKeySchema[] = [],
    dbForeignKeys: readonly ForeignKeySchema[] = [],
    dialect: Dialect
) {
    const matchedEntityForeignKeys = new Set<ForeignKeySchema>();
    const matchedDbForeignKeys = new Set<ForeignKeySchema>();
    const modifiedForeignKeys: ForeignKeyModification[] = [];
    const unchangedForeignKeys: ForeignKeySchema[] = [];

    for (const entityForeignKey of entityForeignKeys) {
        const dbForeignKey = findMatchingForeignKey(tableName, entityForeignKey, dbForeignKeys, matchedDbForeignKeys, dialect);
        if (!dbForeignKey) continue;
        matchedEntityForeignKeys.add(entityForeignKey);
        matchedDbForeignKeys.add(dbForeignKey);
        if (foreignKeysMatch(entityForeignKey, dbForeignKey)) {
            unchangedForeignKeys.push(dbForeignKey);
            continue;
        }
        modifiedForeignKeys.push({
            name: entityForeignKey.name,
            oldForeignKey: dbForeignKey,
            newForeignKey: entityForeignKey
        });
    }

    const addedForeignKeys = entityForeignKeys.filter(foreignKey => !matchedEntityForeignKeys.has(foreignKey));
    const removedForeignKeys = dbForeignKeys.filter(foreignKey => !matchedDbForeignKeys.has(foreignKey));

    return { addedForeignKeys, removedForeignKeys, modifiedForeignKeys, unchangedForeignKeys };
}

function findMatchingIndex(
    tableName: string,
    entityIndex: IndexSchema,
    dbIndexes: readonly IndexSchema[],
    matchedDbIndexes: ReadonlySet<IndexSchema>,
    dialect: Dialect
): IndexSchema | undefined {
    return (
        dbIndexes.find(index => !matchedDbIndexes.has(index) && index.name === entityIndex.name) ??
        dbIndexes.find(index => !matchedDbIndexes.has(index) && generatedIndexNamesEquivalent(tableName, entityIndex, index, dialect))
    );
}

function findMatchingForeignKey(
    tableName: string,
    entityForeignKey: ForeignKeySchema,
    dbForeignKeys: readonly ForeignKeySchema[],
    matchedDbForeignKeys: ReadonlySet<ForeignKeySchema>,
    dialect: Dialect
): ForeignKeySchema | undefined {
    return (
        dbForeignKeys.find(foreignKey => !matchedDbForeignKeys.has(foreignKey) && foreignKey.name === entityForeignKey.name) ??
        dbForeignKeys.find(
            foreignKey =>
                !matchedDbForeignKeys.has(foreignKey) && generatedForeignKeyNamesEquivalent(tableName, entityForeignKey, foreignKey, dialect)
        )
    );
}

function generatedIndexNamesEquivalent(tableName: string, entityIndex: IndexSchema, dbIndex: IndexSchema, dialect: Dialect): boolean {
    if (!arraysEqual(entityIndex.columns, dbIndex.columns)) return false;
    const names = generatedEntityIndexNames(tableName, entityIndex.columns, entityIndex.unique, dialect);
    return names.has(entityIndex.name) && names.has(dbIndex.name);
}

function generatedForeignKeyNamesEquivalent(
    tableName: string,
    entityForeignKey: ForeignKeySchema,
    dbForeignKey: ForeignKeySchema,
    dialect: Dialect
): boolean {
    if (!arraysEqual(entityForeignKey.localColumns, dbForeignKey.localColumns)) return false;
    if (entityForeignKey.foreignTable !== dbForeignKey.foreignTable || !arraysEqual(entityForeignKey.foreignColumns, dbForeignKey.foreignColumns))
        return false;
    const names = generatedEntityForeignKeyNames(tableName, entityForeignKey, dialect);
    return names.has(entityForeignKey.name) && names.has(dbForeignKey.name);
}

function generatedEntityIndexNames(tableName: string, columns: readonly string[], unique: boolean, dialect: Dialect): Set<string> {
    const legacyName = `${tableName}_${unique ? 'u' : 'i'}_${columns.join('_')}`;
    return new Set([defaultEntityIndexName(tableName, columns, dialect), legacyName, normalizeGeneratedIdentifier(legacyName, dialect)]);
}

function generatedEntityForeignKeyNames(tableName: string, foreignKey: ForeignKeySchema, dialect: Dialect): Set<string> {
    const legacyName = `${tableName}_fk_${foreignKey.localColumns.join('_')}_${foreignKey.foreignTable}_${foreignKey.foreignColumns.join('_')}`;
    return new Set([
        defaultEntityForeignKeyName(tableName, foreignKey.localColumns, dialect),
        legacyName,
        normalizeGeneratedIdentifier(legacyName, dialect)
    ]);
}

function getPreservedForeignKeys(
    foreignKeys: readonly ForeignKeySchema[],
    changes: {
        removedColumns: readonly ColumnSchema[];
        modifiedColumns: readonly ColumnModification[];
        oldPrimaryKey: readonly string[];
        newPrimaryKey: readonly string[];
        primaryKeyChanged: boolean;
    }
): ForeignKeySchema[] {
    const affectedColumns = new Set([
        ...changes.removedColumns.map(column => column.name),
        ...changes.modifiedColumns.map(column => column.name),
        ...(changes.primaryKeyChanged ? [...changes.oldPrimaryKey, ...changes.newPrimaryKey] : [])
    ]);
    if (!affectedColumns.size) return [];
    return foreignKeys.filter(foreignKey => foreignKey.localColumns.some(column => affectedColumns.has(column)));
}

function compareColumn(entityColumn: ColumnSchema, dbColumn: ColumnSchema, dialect: Dialect): ColumnModification | undefined {
    const typeChanged = !typesMatch(entityColumn, dbColumn, dialect);
    const nullableChanged = entityColumn.nullable !== dbColumn.nullable;
    const defaultChanged = !defaultsMatch(entityColumn, dbColumn);
    const autoIncrementChanged = entityColumn.autoIncrement !== dbColumn.autoIncrement;

    if (!typeChanged && !nullableChanged && !defaultChanged && !autoIncrementChanged) return undefined;

    return {
        name: entityColumn.name,
        oldColumn: dbColumn,
        newColumn: entityColumn,
        typeChanged,
        nullableChanged,
        defaultChanged,
        autoIncrementChanged
    };
}

function typesMatch(a: ColumnSchema, b: ColumnSchema, dialect: Dialect): boolean {
    const aType = typeAlias(a.type, dialect);
    const bType = typeAlias(b.type, dialect);
    if (aType !== bType) return false;
    if (booleanTinyintTypesMatch(a, b, dialect, aType, bType)) return true;
    if (relevantSize(a, dialect) !== relevantSize(b, dialect)) return false;
    if ((a.scale ?? undefined) !== (b.scale ?? undefined)) return false;
    if (a.unsigned !== b.unsigned) return false;
    if (!arraysEqual(a.enumValues ?? [], b.enumValues ?? [])) return false;
    return true;
}

function relevantSize(column: ColumnSchema, dialect: Dialect): number | undefined {
    return ['varchar', 'char', 'binary', 'varbinary', 'decimal', 'numeric', 'tinyint'].includes(typeAlias(column.type, dialect))
        ? column.size
        : undefined;
}

function typeAlias(type: string, dialect: Dialect): string {
    switch (type) {
        case 'integer':
            return 'int';
        case 'numeric':
            return 'decimal';
        case 'bool':
        case 'boolean':
            return dialect === 'mysql' ? 'tinyint' : 'boolean';
        case 'datetime':
            return dialect === 'postgres' ? 'timestamp' : 'datetime';
        default:
            return type;
    }
}

function booleanTinyintTypesMatch(a: ColumnSchema, b: ColumnSchema, dialect: Dialect, aType: string, bType: string): boolean {
    if (dialect !== 'mysql' || aType !== 'tinyint' || bType !== 'tinyint') return false;
    return (
        (isCanonicalBooleanTinyint(a) && isCompatibleBooleanTinyintStorage(b)) ||
        (isCanonicalBooleanTinyint(b) && isCompatibleBooleanTinyintStorage(a))
    );
}

function isCanonicalBooleanTinyint(column: ColumnSchema): boolean {
    return column.type === 'boolean' || (column.type === 'tinyint' && column.size === 1 && column.unsigned);
}

function isCompatibleBooleanTinyintStorage(column: ColumnSchema): boolean {
    if (column.type === 'boolean') return true;
    if (column.size === 1) return true;
    return column.size === undefined && column.unsigned;
}

function defaultsMatch(a: ColumnSchema, b: ColumnSchema): boolean {
    if (a.autoIncrement || b.autoIncrement) return true;
    const aHasDefault = a.defaultValue !== undefined || a.defaultExpression !== undefined;
    const bHasDefault = b.defaultValue !== undefined || b.defaultExpression !== undefined;
    if (!aHasDefault || !bHasDefault) return aHasDefault === bHasDefault;
    if (a.defaultExpression || b.defaultExpression) {
        return normalizeExpression(a.defaultExpression) === normalizeExpression(b.defaultExpression);
    }
    if (a.defaultValue === b.defaultValue) return true;
    if (a.defaultValue === undefined || b.defaultValue === undefined) return false;
    if (String(a.defaultValue) === String(b.defaultValue)) return true;
    const aNumber = Number(a.defaultValue);
    const bNumber = Number(b.defaultValue);
    return !Number.isNaN(aNumber) && !Number.isNaN(bNumber) && aNumber === bNumber;
}

function indexesMatch(a: IndexSchema, b: IndexSchema): boolean {
    if (a.unique !== b.unique || !arraysEqual(a.columns, b.columns)) return false;
    return a.columns.every(column => indexColumnSize(a, column) === indexColumnSize(b, column));
}

function indexColumnSize(index: IndexSchema, column: string): number | undefined {
    return index.columnSizes?.[column] ?? index.size;
}

function foreignKeysMatch(a: ForeignKeySchema, b: ForeignKeySchema): boolean {
    return (
        arraysEqual(a.localColumns, b.localColumns) &&
        a.foreignTable === b.foreignTable &&
        arraysEqual(a.foreignColumns, b.foreignColumns) &&
        normalizeAction(a.onDelete) === normalizeAction(b.onDelete) &&
        normalizeAction(a.onUpdate) === normalizeAction(b.onUpdate)
    );
}

function getPrimaryKeyColumns(table: TableSchema): string[] {
    return table.primaryKeyColumns?.length
        ? [...table.primaryKeyColumns]
        : table.columns.filter(column => column.primaryKey).map(column => column.name);
}

function normalizeAction(action: string | undefined): string {
    return (action || 'CASCADE').toUpperCase();
}

function normalizeExpression(value: string | undefined): string | undefined {
    return value?.trim().toUpperCase().replace(/\(\)/g, '');
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}
