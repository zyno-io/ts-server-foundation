import type { Dialect } from '../../sql';

export { Dialect };

export const INTERNAL_TABLES = new Set(['_migrations', '_locks', '_jobs']);

export interface ColumnSchema {
    name: string;
    type: string;
    size?: number;
    scale?: number;
    unsigned: boolean;
    nullable: boolean;
    autoIncrement: boolean;
    primaryKey: boolean;
    defaultValue?: string | number | boolean | null;
    defaultExpression?: string;
    onUpdateExpression?: string;
    enumValues?: string[];
    enumTypeName?: string;
    afterColumn?: string | null;
    ordinalPosition: number;
}

export interface TableSchema {
    name: string;
    columns: ColumnSchema[];
    indexes: IndexSchema[];
    foreignKeys: ForeignKeySchema[];
    primaryKeyColumns?: string[];
    primaryKeyConstraintName?: string;
}

export type DatabaseSchema = Map<string, TableSchema>;

export interface IndexSchema {
    name: string;
    columns: string[];
    unique: boolean;
    size?: number;
    columnSizes?: Record<string, number>;
    constraintName?: string;
    spatial?: boolean;
}

export interface ForeignKeySchema {
    name: string;
    localColumns: string[];
    foreignTable: string;
    foreignColumns: string[];
    onDelete?: string;
    onUpdate?: string;
}

export interface TableForeignKeySchema {
    tableName: string;
    foreignKey: ForeignKeySchema;
}

export interface SchemaDiff {
    dialect: Dialect;
    pgSchema?: string;
    externalForeignKeyDrops: TableForeignKeySchema[];
    externalForeignKeyAdds: TableForeignKeySchema[];
    addedTables: TableSchema[];
    removedTables: TableSchema[];
    modifiedTables: TableDiff[];
}

export interface TableDiff {
    tableName: string;
    addedColumns: ColumnSchema[];
    removedColumns: ColumnSchema[];
    modifiedColumns: ColumnModification[];
    primaryKeyChanged: boolean;
    oldPrimaryKey: string[];
    newPrimaryKey: string[];
    oldPrimaryKeyConstraintName?: string;
    oldAutoIncrementPrimaryKeyColumns: ColumnSchema[];
    newAutoIncrementColumns: ColumnSchema[];
    addedIndexes: IndexSchema[];
    removedIndexes: IndexSchema[];
    modifiedIndexes: IndexModification[];
    addedForeignKeys: ForeignKeySchema[];
    removedForeignKeys: ForeignKeySchema[];
    modifiedForeignKeys: ForeignKeyModification[];
    preservedForeignKeys: ForeignKeySchema[];
}

export interface ColumnModification {
    name: string;
    oldColumn: ColumnSchema;
    newColumn: ColumnSchema;
    typeChanged: boolean;
    nullableChanged: boolean;
    defaultChanged: boolean;
    autoIncrementChanged: boolean;
}

export interface IndexModification {
    name: string;
    oldIndex: IndexSchema;
    newIndex: IndexSchema;
}

export interface ForeignKeyModification {
    name: string;
    oldForeignKey: ForeignKeySchema;
    newForeignKey: ForeignKeySchema;
}

export function hasSchemaChanges(diff: SchemaDiff): boolean {
    return (
        diff.externalForeignKeyDrops.length > 0 ||
        diff.externalForeignKeyAdds.length > 0 ||
        diff.addedTables.length > 0 ||
        diff.removedTables.length > 0 ||
        diff.modifiedTables.some(
            table =>
                table.addedColumns.length > 0 ||
                table.removedColumns.length > 0 ||
                table.modifiedColumns.length > 0 ||
                table.primaryKeyChanged ||
                table.addedIndexes.length > 0 ||
                table.removedIndexes.length > 0 ||
                table.modifiedIndexes.length > 0 ||
                table.addedForeignKeys.length > 0 ||
                table.removedForeignKeys.length > 0 ||
                table.modifiedForeignKeys.length > 0 ||
                table.preservedForeignKeys.length > 0
        )
    );
}
