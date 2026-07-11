import { quoteIdentifier, type Dialect } from '../../sql';
import { ColumnSchema, ForeignKeySchema, IndexSchema, SchemaDiff, TableDiff, TableForeignKeySchema, TableSchema } from './schema-model';

export const COMMENT_PREFIX = '\0table:';

export function generateDDL(diff: SchemaDiff): string[] {
    const statements: string[] = [];
    const context: DdlContext = { dialect: diff.dialect, pgSchema: diff.pgSchema };
    const droppedForeignKeys = new Set<string>();
    const enumRewrites = collectPostgresEnumRewrites(diff);
    const rewrittenEnumColumns = new Set(enumRewrites.flatMap(group => group.columns.map(column => columnKey(column.tableName, column.columnName))));

    appendTableStatements(statements, externalForeignKeyDrops(diff, context, droppedForeignKeys));
    appendTableStatements(statements, removedTableForeignKeyDrops(diff, context, droppedForeignKeys));
    appendTableStatements(statements, modifiedTableForeignKeyDrops(diff, context, droppedForeignKeys));

    for (const table of diff.addedTables) {
        statements.push(`${COMMENT_PREFIX}${table.name}`);
        statements.push(...createEnumTypes(table.columns, table.name, context));
        statements.push(createTable(table, context));
        statements.push(...table.indexes.map(index => createIndex(table.name, index, context)));
    }
    for (const table of diff.modifiedTables) {
        statements.push(`${COMMENT_PREFIX}${table.tableName}`);
        statements.push(
            ...enumRewrites.filter(group => group.tableName === table.tableName).flatMap(group => postgresEnumRewriteStatements(group, context))
        );
        statements.push(...alterTable(table, context, rewrittenEnumColumns));
    }
    for (const table of diff.removedTables) {
        statements.push(`${COMMENT_PREFIX}${table.name}`);
        statements.push(`DROP TABLE ${qTable(context, table.name)}`);
        statements.push(...dropOwnedEnumTypes(table.columns, table.name, context));
    }
    appendTableStatements(statements, addedTableForeignKeyAdds(diff, context));
    appendTableStatements(statements, modifiedTableForeignKeyAdds(diff, context));
    appendTableStatements(statements, externalForeignKeyAdds(diff, context));
    return statements;
}

interface DdlContext {
    dialect: Dialect;
    pgSchema?: string;
}

interface TableStatements {
    tableName: string;
    statements: string[];
}

interface PostgresEnumRewriteGroup {
    tableName: string;
    typeName: string;
    nextTypeName: string;
    values: string[];
    columns: Array<{ tableName: string; columnName: string }>;
}

function appendTableStatements(target: string[], groups: TableStatements[]): void {
    for (const group of groups) {
        if (!group.statements.length) continue;
        target.push(`${COMMENT_PREFIX}${group.tableName}`);
        target.push(...group.statements);
    }
}

function externalForeignKeyDrops(diff: SchemaDiff, context: DdlContext, droppedForeignKeys: Set<string>): TableStatements[] {
    const byTable = new Map<string, TableForeignKeySchema[]>();
    for (const tableForeignKey of diff.externalForeignKeyDrops) {
        const items = byTable.get(tableForeignKey.tableName) ?? [];
        items.push(tableForeignKey);
        byTable.set(tableForeignKey.tableName, items);
    }
    return [...byTable].map(([tableName, tableForeignKeys]) => ({
        tableName,
        statements: tableForeignKeys
            .map(tableForeignKey => dropForeignKeyOnce(tableName, tableForeignKey.foreignKey, context, droppedForeignKeys))
            .filter((statement): statement is string => statement !== undefined)
    }));
}

function removedTableForeignKeyDrops(diff: SchemaDiff, context: DdlContext, droppedForeignKeys: Set<string>): TableStatements[] {
    return diff.removedTables.map(table => ({
        tableName: table.name,
        statements: table.foreignKeys
            .map(foreignKey => dropForeignKeyOnce(table.name, foreignKey, context, droppedForeignKeys))
            .filter((statement): statement is string => statement !== undefined)
    }));
}

function modifiedTableForeignKeyDrops(diff: SchemaDiff, context: DdlContext, droppedForeignKeys: Set<string>): TableStatements[] {
    return diff.modifiedTables.map(table => ({
        tableName: table.tableName,
        statements: [
            ...table.removedForeignKeys.map(foreignKey => dropForeignKeyOnce(table.tableName, foreignKey, context, droppedForeignKeys)),
            ...table.modifiedForeignKeys.map(modification =>
                dropForeignKeyOnce(table.tableName, modification.oldForeignKey, context, droppedForeignKeys)
            ),
            ...table.preservedForeignKeys.map(foreignKey => dropForeignKeyOnce(table.tableName, foreignKey, context, droppedForeignKeys))
        ].filter((statement): statement is string => statement !== undefined)
    }));
}

function addedTableForeignKeyAdds(diff: SchemaDiff, context: DdlContext): TableStatements[] {
    return diff.addedTables.map(table => ({
        tableName: table.name,
        statements: table.foreignKeys.map(foreignKey => addForeignKey(table.name, foreignKey, context))
    }));
}

function modifiedTableForeignKeyAdds(diff: SchemaDiff, context: DdlContext): TableStatements[] {
    return diff.modifiedTables.map(table => ({
        tableName: table.tableName,
        statements: [
            ...table.modifiedForeignKeys.map(modification => addForeignKey(table.tableName, modification.newForeignKey, context)),
            ...table.addedForeignKeys.map(foreignKey => addForeignKey(table.tableName, foreignKey, context)),
            ...table.preservedForeignKeys.map(foreignKey => addForeignKey(table.tableName, foreignKey, context))
        ]
    }));
}

function externalForeignKeyAdds(diff: SchemaDiff, context: DdlContext): TableStatements[] {
    const byTable = new Map<string, TableForeignKeySchema[]>();
    for (const tableForeignKey of diff.externalForeignKeyAdds) {
        const items = byTable.get(tableForeignKey.tableName) ?? [];
        items.push(tableForeignKey);
        byTable.set(tableForeignKey.tableName, items);
    }
    return [...byTable].map(([tableName, tableForeignKeys]) => ({
        tableName,
        statements: tableForeignKeys.map(tableForeignKey => addForeignKey(tableName, tableForeignKey.foreignKey, context))
    }));
}

function createTable(table: TableSchema, context: DdlContext): string {
    const columnDefs = table.columns.map(column => `    ${columnDefinition(column, context)}`);
    const primaryKey = (
        table.primaryKeyColumns?.length ? table.primaryKeyColumns : table.columns.filter(column => column.primaryKey).map(column => column.name)
    ).map(column => q(context.dialect, column));
    if (primaryKey.length) columnDefs.push(`    PRIMARY KEY (${primaryKey.join(', ')})`);
    const suffix = context.dialect === 'mysql' ? '\n) ENGINE=InnoDB' : '\n)';
    return `CREATE TABLE ${qTable(context, table.name)} (\n${columnDefs.join(',\n')}${suffix}`;
}

function alterTable(diff: TableDiff, context: DdlContext, rewrittenEnumColumns: ReadonlySet<string> = new Set()): string[] {
    const statements: string[] = [];
    const tableName = qTable(context, diff.tableName);

    statements.push(...createEnumTypes(diff.addedColumns, diff.tableName, context));
    statements.push(
        ...createEnumTypes(
            diff.modifiedColumns.filter(modification => modification.oldColumn.type !== 'enum').map(modification => modification.newColumn),
            diff.tableName,
            context
        )
    );

    for (const index of diff.removedIndexes) statements.push(dropIndex(diff.tableName, index, context));
    for (const modification of diff.modifiedIndexes) statements.push(dropIndex(diff.tableName, modification.oldIndex, context));

    const oldAutoIncrementPrimaryColumns =
        context.dialect === 'mysql' && diff.primaryKeyChanged
            ? diff.oldAutoIncrementPrimaryKeyColumns.map(column => ({
                  ...column,
                  autoIncrement: false
              }))
            : [];
    for (const column of oldAutoIncrementPrimaryColumns) {
        statements.push(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnDefinition(column, context)}`);
    }

    if (diff.primaryKeyChanged && diff.oldPrimaryKey.length) {
        statements.push(
            context.dialect === 'postgres'
                ? `ALTER TABLE ${tableName} DROP CONSTRAINT ${q(context.dialect, diff.oldPrimaryKeyConstraintName ?? `${diff.tableName}_pkey`)}`
                : `ALTER TABLE ${tableName} DROP PRIMARY KEY`
        );
    }

    for (const column of diff.removedColumns) {
        statements.push(`ALTER TABLE ${tableName} DROP COLUMN ${q(context.dialect, column.name)}`);
        statements.push(...dropOwnedEnumTypes([column], diff.tableName, context));
    }
    for (const column of diff.addedColumns) {
        statements.push(
            `ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition(column, context, { autoIncrement: !deferAutoIncrement(diff, column, context) })}`
        );
    }
    for (const modification of diff.modifiedColumns) {
        if (context.dialect === 'postgres') {
            statements.push(...alterPostgresColumn(diff.tableName, modification, context, rewrittenEnumColumns));
        } else {
            statements.push(
                `ALTER TABLE ${tableName} MODIFY COLUMN ${columnDefinition(modification.newColumn, context, {
                    autoIncrement: !deferAutoIncrement(diff, modification.newColumn, context)
                })}`
            );
        }
    }

    if (diff.primaryKeyChanged && diff.newPrimaryKey.length) {
        const columns = diff.newPrimaryKey.map(column => q(context.dialect, column)).join(', ');
        statements.push(`ALTER TABLE ${tableName} ADD PRIMARY KEY (${columns})`);
    }

    for (const modification of diff.modifiedIndexes) statements.push(createIndex(diff.tableName, modification.newIndex, context));
    for (const index of diff.addedIndexes) statements.push(createIndex(diff.tableName, index, context));
    for (const column of deferredAutoIncrementColumns(diff, context)) {
        statements.push(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnDefinition(column, context)}`);
    }

    return statements;
}

function alterPostgresColumn(
    tableName: string,
    modification: TableDiff['modifiedColumns'][number],
    context: DdlContext,
    rewrittenEnumColumns: ReadonlySet<string> = new Set()
): string[] {
    const column = modification.newColumn;
    const table = qTable(context, tableName);
    const name = q('postgres', column.name);
    const statements = rewrittenEnumColumns.has(columnKey(tableName, column.name))
        ? []
        : postgresColumnTypeStatements(tableName, modification, context);
    if (modification.autoIncrementChanged && !column.autoIncrement) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP IDENTITY IF EXISTS`);
    }
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} ${column.nullable ? 'DROP' : 'SET'} NOT NULL`);
    if (modification.autoIncrementChanged && column.autoIncrement) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP DEFAULT`);
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} ADD GENERATED BY DEFAULT AS IDENTITY`);
    } else if (column.defaultExpression) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT ${column.defaultExpression}`);
    } else if (column.defaultValue !== undefined) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT ${literal(column.defaultValue)}`);
    } else {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP DEFAULT`);
    }
    if (modification.oldColumn.type === 'enum' && column.type !== 'enum') {
        statements.push(...dropOwnedEnumTypes([modification.oldColumn], tableName, context));
    }
    return statements;
}

function postgresColumnTypeStatements(tableName: string, modification: TableDiff['modifiedColumns'][number], context: DdlContext): string[] {
    const column = modification.newColumn;
    const oldColumn = modification.oldColumn;
    const table = qTable(context, tableName);
    const name = q('postgres', column.name);

    if (oldColumn.type === 'enum' && column.type === 'enum' && oldColumn.enumValues?.length && column.enumValues?.length) {
        return postgresEnumEvolutionStatements(tableName, modification, context);
    }

    return [`ALTER TABLE ${table} ALTER COLUMN ${name} TYPE ${columnType(column, context)}`];
}

function postgresEnumEvolutionStatements(tableName: string, modification: TableDiff['modifiedColumns'][number], context: DdlContext): string[] {
    const column = modification.newColumn;
    const oldColumn = modification.oldColumn;
    const oldValues = oldColumn.enumValues ?? [];
    const newValues = column.enumValues ?? [];
    const typeName = oldColumn.enumTypeName ?? column.enumTypeName ?? `${tableName}_${column.name}_enum`;

    if (isAppendOnlyEnumChange(oldValues, newValues)) {
        return newValues.slice(oldValues.length).map(value => `ALTER TYPE ${qType(context, typeName)} ADD VALUE IF NOT EXISTS ${literal(value)}`);
    }

    return postgresEnumRewriteStatements(
        {
            tableName,
            typeName,
            nextTypeName: `${typeName}__next`,
            values: newValues,
            columns: [{ tableName, columnName: column.name }]
        },
        context
    );
}

function isAppendOnlyEnumChange(oldValues: readonly string[], newValues: readonly string[]): boolean {
    return oldValues.length <= newValues.length && oldValues.every((value, index) => value === newValues[index]);
}

function collectPostgresEnumRewrites(diff: SchemaDiff): PostgresEnumRewriteGroup[] {
    if (diff.dialect !== 'postgres') return [];
    const groups = new Map<string, PostgresEnumRewriteGroup>();

    for (const table of diff.modifiedTables) {
        for (const modification of table.modifiedColumns) {
            const oldColumn = modification.oldColumn;
            const newColumn = modification.newColumn;
            const oldValues = oldColumn.enumValues ?? [];
            const newValues = newColumn.enumValues ?? [];
            if (oldColumn.type !== 'enum' || newColumn.type !== 'enum' || !oldValues.length || !newValues.length) continue;
            if (isAppendOnlyEnumChange(oldValues, newValues)) continue;

            const typeName = oldColumn.enumTypeName ?? newColumn.enumTypeName ?? `${table.tableName}_${newColumn.name}_enum`;
            const group = groups.get(typeName);
            if (group) {
                if (!arraysEqual(group.values, newValues)) {
                    throw new Error(`Conflicting desired values for PostgreSQL enum type ${typeName}`);
                }
                if (!group.columns.some(column => column.tableName === table.tableName && column.columnName === newColumn.name)) {
                    group.columns.push({ tableName: table.tableName, columnName: newColumn.name });
                }
                continue;
            }

            groups.set(typeName, {
                tableName: table.tableName,
                typeName,
                nextTypeName: `${typeName}__next`,
                values: newValues,
                columns: [{ tableName: table.tableName, columnName: newColumn.name }]
            });
        }
    }

    return [...groups.values()];
}

function postgresEnumRewriteStatements(group: PostgresEnumRewriteGroup, context: DdlContext): string[] {
    return [
        ...group.columns.map(
            column => `ALTER TABLE ${qTable(context, column.tableName)} ALTER COLUMN ${q('postgres', column.columnName)} DROP DEFAULT`
        ),
        `DROP TYPE IF EXISTS ${qType(context, group.nextTypeName)}`,
        `CREATE TYPE ${qType(context, group.nextTypeName)} AS ENUM (${group.values.map(value => literal(value)).join(', ')})`,
        ...group.columns.map(column => {
            const columnName = q('postgres', column.columnName);
            return `ALTER TABLE ${qTable(context, column.tableName)} ALTER COLUMN ${columnName} TYPE ${qType(context, group.nextTypeName)} USING ${columnName}::text::${qType(
                context,
                group.nextTypeName
            )}`;
        }),
        `DROP TYPE ${qType(context, group.typeName)}`,
        `ALTER TYPE ${qType(context, group.nextTypeName)} RENAME TO ${q('postgres', group.typeName)}`
    ];
}

function columnKey(tableName: string, columnName: string): string {
    return `${tableName}\0${columnName}`;
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function deferAutoIncrement(diff: TableDiff, column: ColumnSchema, context: DdlContext): boolean {
    return context.dialect === 'mysql' && column.autoIncrement && diff.primaryKeyChanged;
}

function deferredAutoIncrementColumns(diff: TableDiff, context: DdlContext): ColumnSchema[] {
    if (context.dialect !== 'mysql' || !diff.primaryKeyChanged) return [];
    return diff.newAutoIncrementColumns;
}

function columnDefinition(column: ColumnSchema, context: DdlContext, options: { autoIncrement?: boolean } = {}): string {
    const parts = [q(context.dialect, column.name), columnType(column, context)];
    if (!column.nullable) parts.push('NOT NULL');
    if (column.autoIncrement && options.autoIncrement !== false) {
        parts.push(context.dialect === 'postgres' ? 'GENERATED BY DEFAULT AS IDENTITY' : 'AUTO_INCREMENT');
    }
    if (column.defaultExpression) parts.push(`DEFAULT ${column.defaultExpression}`);
    else if (column.defaultValue !== undefined) parts.push(`DEFAULT ${literal(column.defaultValue)}`);
    if (context.dialect === 'mysql' && column.onUpdateExpression) parts.push(`ON UPDATE ${column.onUpdateExpression}`);
    return parts.join(' ');
}

function columnType(column: ColumnSchema, context: DdlContext): string {
    const dialect = context.dialect;
    if (column.type === 'enum' && column.enumValues?.length) {
        return dialect === 'mysql'
            ? `ENUM(${column.enumValues.map(value => literal(value)).join(', ')})`
            : qType(context, column.enumTypeName ?? 'enum');
    }
    if (column.type === 'boolean' && dialect === 'mysql') return `tinyint(1)${column.unsigned ? ' unsigned' : ''}`;
    if (column.type === 'json' && dialect === 'mysql') return 'json';
    if (column.type === 'int' && dialect === 'postgres') return 'integer';
    if (column.type === 'double' && dialect === 'postgres') return 'double precision';
    if (column.type === 'datetime' && dialect === 'postgres') return 'timestamp';

    const size = column.size !== undefined ? `(${column.scale !== undefined ? `${column.size}, ${column.scale}` : column.size})` : '';
    const unsigned = dialect === 'mysql' && column.unsigned ? ' unsigned' : '';
    return `${column.type}${size}${unsigned}`;
}

function createEnumTypes(columns: readonly ColumnSchema[], tableName: string, context: DdlContext): string[] {
    if (context.dialect !== 'postgres') return [];
    const seen = new Set<string>();
    return columns
        .filter(column => column.type === 'enum' && column.enumValues?.length)
        .map(column => ({
            typeName: column.enumTypeName ?? `${tableName}_${column.name}_enum`,
            values: column.enumValues!
        }))
        .filter(item => {
            if (seen.has(item.typeName)) return false;
            seen.add(item.typeName);
            return true;
        })
        .map(item => `CREATE TYPE ${qType(context, item.typeName)} AS ENUM (${item.values.map(value => literal(value)).join(', ')})`);
}

function dropOwnedEnumTypes(columns: readonly ColumnSchema[], tableName: string, context: DdlContext): string[] {
    if (context.dialect !== 'postgres') return [];
    const seen = new Set<string>();
    return columns
        .filter(column => column.type === 'enum' && column.enumValues?.length)
        .map(column => ({
            column,
            typeName: column.enumTypeName ?? `${tableName}_${column.name}_enum`
        }))
        .filter(({ column, typeName }) => typeName === `${tableName}_${column.name}_enum`)
        .filter(({ typeName }) => {
            if (seen.has(typeName)) return false;
            seen.add(typeName);
            return true;
        })
        .map(({ typeName }) => `DROP TYPE IF EXISTS ${qType(context, typeName)}`);
}

function createIndex(tableName: string, index: IndexSchema, context: DdlContext): string {
    const unique = index.unique ? 'UNIQUE ' : '';
    const columns = index.columns.map(column => {
        const quoted = q(context.dialect, column);
        const size = index.columnSizes?.[column] ?? index.size;
        return context.dialect === 'mysql' && size ? `${quoted}(${size})` : quoted;
    });
    return `CREATE ${unique}INDEX ${qIndex(context, index.name)} ON ${qTable(context, tableName)} (${columns.join(', ')})`;
}

function dropIndex(tableName: string, index: IndexSchema, context: DdlContext): string {
    if (context.dialect === 'postgres' && index.constraintName) {
        return `ALTER TABLE ${qTable(context, tableName)} DROP CONSTRAINT ${q(context.dialect, index.constraintName)}`;
    }
    return context.dialect === 'mysql'
        ? `DROP INDEX ${q(context.dialect, index.name)} ON ${qTable(context, tableName)}`
        : `DROP INDEX ${qIndex(context, index.name)}`;
}

function addForeignKey(tableName: string, foreignKey: ForeignKeySchema, context: DdlContext): string {
    const localColumns = foreignKey.localColumns.map(column => q(context.dialect, column)).join(', ');
    const foreignColumns = foreignKey.foreignColumns.map(column => q(context.dialect, column)).join(', ');
    const parts = [
        `ALTER TABLE ${qTable(context, tableName)} ADD CONSTRAINT ${q(context.dialect, foreignKey.name)}`,
        `FOREIGN KEY (${localColumns}) REFERENCES ${qTable(context, foreignKey.foreignTable)} (${foreignColumns})`
    ];
    if (foreignKey.onDelete) parts.push(`ON DELETE ${foreignKey.onDelete}`);
    if (foreignKey.onUpdate) parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
    return parts.join(' ');
}

function dropForeignKey(tableName: string, foreignKey: ForeignKeySchema, context: DdlContext): string {
    return context.dialect === 'mysql'
        ? `ALTER TABLE ${qTable(context, tableName)} DROP FOREIGN KEY ${q(context.dialect, foreignKey.name)}`
        : `ALTER TABLE ${qTable(context, tableName)} DROP CONSTRAINT ${q(context.dialect, foreignKey.name)}`;
}

function dropForeignKeyOnce(
    tableName: string,
    foreignKey: ForeignKeySchema,
    context: DdlContext,
    droppedForeignKeys: Set<string>
): string | undefined {
    const key = `${tableName}\0${foreignKey.name}`;
    if (droppedForeignKeys.has(key)) return undefined;
    droppedForeignKeys.add(key);
    return dropForeignKey(tableName, foreignKey, context);
}

function literal(value: string | number | boolean | null): string {
    if (value === null) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return `'${value.replace(/'/g, "''")}'`;
}

function q(dialect: Dialect, name: string): string {
    return quoteIdentifier(name, dialect);
}

function qTable(context: DdlContext, name: string): string {
    if (context.dialect === 'postgres' && context.pgSchema) return `${q(context.dialect, context.pgSchema)}.${q(context.dialect, name)}`;
    return q(context.dialect, name);
}

function qType(context: DdlContext, name: string): string {
    if (context.dialect === 'postgres' && context.pgSchema) return `${q(context.dialect, context.pgSchema)}.${q(context.dialect, name)}`;
    return q(context.dialect, name);
}

function qIndex(context: DdlContext, name: string): string {
    if (context.dialect === 'postgres' && context.pgSchema) return `${q(context.dialect, context.pgSchema)}.${q(context.dialect, name)}`;
    return q(context.dialect, name);
}
