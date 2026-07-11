import type { BaseDatabase } from '../../database';
import { compareSchemas } from './comparator';
import { readAllTableNames, readDatabaseSchema, readInboundForeignKeys } from './db-reader';
import { generateDDL } from './ddl-generator';
import { readEntitiesSchema } from './entity-reader';
import { hasSchemaChanges, type ForeignKeySchema, type SchemaDiff, type TableSchema } from './schema-model';

export interface CreateMigrationPlanOptions {
    pgSchema?: string;
    tableNames?: readonly string[];
}

export interface MigrationPlan {
    diff: SchemaDiff;
    statements: string[];
    hasChanges: boolean;
}

export async function createMigrationPlan(db: BaseDatabase, options: CreateMigrationPlanOptions = {}): Promise<MigrationPlan> {
    const scopedTableNames = options.tableNames ? [...new Set(options.tableNames)] : undefined;
    const entitySchema = readEntitiesSchema(db, { tableNames: scopedTableNames });
    const entityTableNames = [...entitySchema.keys()];
    const dbTableNames = scopedTableNames ?? (await readAllTableNames(db, options.pgSchema));
    const tableNames = scopedTableNames ?? [...new Set([...entityTableNames, ...dbTableNames])];
    const dbSchema = await readDatabaseSchema(db, tableNames, options.pgSchema, { includeInternalTables: scopedTableNames !== undefined });
    const diff = compareSchemas(entitySchema, dbSchema, db.driver.dialect, options.pgSchema);
    await addExternalForeignKeyChanges(diff, entitySchema, scopedTableNames, db, options.pgSchema);
    const statements = generateDDL(diff);
    return {
        diff,
        statements,
        hasChanges: hasSchemaChanges(diff)
    };
}

async function addExternalForeignKeyChanges(
    diff: SchemaDiff,
    entitySchema: ReturnType<typeof readEntitiesSchema>,
    scopedTableNames: readonly string[] | undefined,
    db: BaseDatabase,
    pgSchema?: string
): Promise<void> {
    const scopedTables = scopedTableNames ? new Set(scopedTableNames) : undefined;
    const removedTables = new Set(diff.removedTables.map(table => table.name));
    const affectedColumnsByTable = new Map<string, Set<string>>();

    for (const table of diff.removedTables) affectedColumnsByTable.set(table.name, new Set(['*']));
    for (const table of diff.modifiedTables) {
        const affectedColumns = getExternallyReferencedAffectedColumns(table);
        if (affectedColumns.size) affectedColumnsByTable.set(table.tableName, affectedColumns);
    }

    if (!affectedColumnsByTable.size) return;

    const inboundForeignKeys = await readInboundForeignKeys(db, [...affectedColumnsByTable.keys()], pgSchema);
    diff.externalForeignKeyDrops = inboundForeignKeys.filter(tableForeignKey => {
        const affectedColumns = affectedColumnsByTable.get(tableForeignKey.foreignKey.foreignTable);
        return affectedColumns?.has('*') || tableForeignKey.foreignKey.foreignColumns.some(column => affectedColumns?.has(column));
    });
    diff.externalForeignKeyAdds = diff.externalForeignKeyDrops.filter(tableForeignKey => {
        if (removedTables.has(tableForeignKey.foreignKey.foreignTable) || removedTables.has(tableForeignKey.tableName)) return false;
        if (scopedTables?.has(tableForeignKey.tableName)) return false;
        if (!scopedTables && tableDiffHandlesForeignKey(diff, tableForeignKey.tableName, tableForeignKey.foreignKey)) return false;
        const referencedTable = entitySchema.get(tableForeignKey.foreignKey.foreignTable);
        if (!referencedTable) return false;
        const remainingColumns = new Set(referencedTable.columns.map(column => column.name));
        if (!tableForeignKey.foreignKey.foreignColumns.every(column => remainingColumns.has(column))) return false;

        if (scopedTables) return true;
        const owningTable = entitySchema.get(tableForeignKey.tableName);
        return !!owningTable && tableHasMatchingForeignKey(owningTable, tableForeignKey.foreignKey);
    });
}

function getExternallyReferencedAffectedColumns(table: SchemaDiff['modifiedTables'][number]): Set<string> {
    return new Set([
        ...table.removedColumns.map(column => column.name),
        ...table.modifiedColumns.map(column => column.name),
        ...(table.primaryKeyChanged ? [...table.oldPrimaryKey, ...table.newPrimaryKey] : [])
    ]);
}

function tableDiffHandlesForeignKey(diff: SchemaDiff, tableName: string, foreignKey: ForeignKeySchema): boolean {
    const table = diff.modifiedTables.find(item => item.tableName === tableName);
    if (!table) return false;
    return (
        table.removedForeignKeys.some(item => foreignKeysMatchIdentity(item, foreignKey)) ||
        table.modifiedForeignKeys.some(
            modification =>
                foreignKeysMatchIdentity(modification.oldForeignKey, foreignKey) || foreignKeysMatchIdentity(modification.newForeignKey, foreignKey)
        ) ||
        table.preservedForeignKeys.some(item => foreignKeysMatchIdentity(item, foreignKey))
    );
}

function tableHasMatchingForeignKey(table: TableSchema, foreignKey: ForeignKeySchema): boolean {
    return table.foreignKeys.some(candidate => foreignKeysMatchIdentity(candidate, foreignKey));
}

function foreignKeysMatchIdentity(a: ForeignKeySchema, b: ForeignKeySchema): boolean {
    return (
        arraysEqual(a.localColumns, b.localColumns) &&
        a.foreignTable === b.foreignTable &&
        arraysEqual(a.foreignColumns, b.foreignColumns) &&
        normalizeAction(a.onDelete) === normalizeAction(b.onDelete) &&
        normalizeAction(a.onUpdate) === normalizeAction(b.onUpdate)
    );
}

function normalizeAction(action: string | undefined): string {
    return (action || 'CASCADE').toUpperCase();
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export * from './schema-model';
export * from './entity-reader';
export * from './db-reader';
export * from './comparator';
export * from './ddl-generator';
export * from './file-generator';
