import { COMMENT_PREFIX, generateDDL, type ColumnSchema, type ForeignKeySchema, type IndexSchema, type TableSchema } from './migration/create';
import type { BaseDatabase } from './database';
import { defaultSchemaIndexName } from './identifiers';
import { quoteIdentifier, type Dialect } from './sql';

export type SchemaTableCallback = (table: SchemaTableBuilder) => void;
export type SchemaAlterCallback = (table: SchemaAlterBuilder) => void;

export class DatabaseSchemaBuilder {
    private readonly enumTypeRegistry = new Set<string>();

    constructor(private readonly db: BaseDatabase) {}

    async create(tableName: string, callback: SchemaTableCallback): Promise<void> {
        const table = new SchemaTableBuilder(tableName, this.db.driver.dialect);
        callback(table);
        const statements = generateDDL({
            dialect: this.db.driver.dialect,
            externalForeignKeyDrops: [],
            externalForeignKeyAdds: [],
            addedTables: [table.toSchema()],
            removedTables: [],
            modifiedTables: []
        }).filter(statement => !statement.startsWith(COMMENT_PREFIX));

        for (const statement of statements) await this.db.rawExecute(statement);
    }

    async alter(tableName: string, callback: SchemaAlterCallback): Promise<void> {
        const table = new SchemaAlterBuilder(tableName, this.db.driver.dialect);
        callback(table);

        for (const statement of createPostgresEnumTypes(table.enumColumns, tableName, this.db.driver.dialect, this.enumTypeRegistry)) {
            await this.db.rawExecute(statement);
        }
        for (const statement of table.toStatements()) await this.db.rawExecute(statement);
    }

    async drop(tableName: string): Promise<void> {
        await this.db.rawExecute(`DROP TABLE ${qTable(this.db.driver.dialect, tableName)}`);
    }

    async dropIfExists(tableName: string): Promise<void> {
        await this.db.rawExecute(`DROP TABLE IF EXISTS ${qTable(this.db.driver.dialect, tableName)}`);
    }

    async rename(from: string, to: string): Promise<void> {
        const dialect = this.db.driver.dialect;
        await this.db.rawExecute(
            dialect === 'mysql'
                ? `RENAME TABLE ${qTable(dialect, from)} TO ${q(dialect, to)}`
                : `ALTER TABLE ${qTable(dialect, from)} RENAME TO ${q(dialect, to)}`
        );
    }

    async enumType(name: string, values: readonly string[]): Promise<void> {
        for (const statement of createPostgresEnumType(name, [...values], this.db.driver.dialect, this.enumTypeRegistry)) {
            await this.db.rawExecute(statement);
        }
    }

    async raw(statement: string): Promise<void> {
        await this.db.rawExecute(statement);
    }

    async onlyOn(dialect: Dialect, callback: () => Promise<void>): Promise<void> {
        if (this.db.driver.dialect === dialect) await callback();
    }

    async hasTable(tableName: string): Promise<boolean> {
        const rows = await this.db.rawQuery(
            this.db.driver.dialect === 'mysql'
                ? `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${literal(tableName)} LIMIT 1`
                : `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${literal(tableName)} LIMIT 1`
        );
        return rows.length > 0;
    }

    async hasColumn(tableName: string, columnName: string): Promise<boolean> {
        const rows = await this.db.rawQuery(
            this.db.driver.dialect === 'mysql'
                ? `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${literal(tableName)} AND COLUMN_NAME = ${literal(columnName)} LIMIT 1`
                : `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${literal(tableName)} AND column_name = ${literal(columnName)} LIMIT 1`
        );
        return rows.length > 0;
    }

    async hasIndex(tableName: string, indexName: string): Promise<boolean> {
        const rows = await this.db.rawQuery(
            this.db.driver.dialect === 'mysql'
                ? `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${literal(tableName)} AND INDEX_NAME = ${literal(indexName)} LIMIT 1`
                : `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${literal(tableName)} AND indexname = ${literal(indexName)} LIMIT 1`
        );
        return rows.length > 0;
    }

    async flush(): Promise<void> {
        this.enumTypeRegistry.clear();
    }
}

abstract class SchemaBlueprintBase {
    constructor(
        protected readonly tableName: string,
        protected readonly dialect: Dialect
    ) {}

    protected abstract addColumn(column: SchemaColumnBuilder): SchemaColumnBuilder;
    protected abstract addIndexSchema(index: IndexSchema): void;
    protected abstract addForeignKeySchema(foreignKey: ForeignKeySchema): void;

    id(name = 'id'): SchemaColumnBuilder {
        return this.column(name, 'bigint').unsigned().autoIncrement().primary();
    }

    uuidString(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'uuid' : 'char', this.dialect === 'postgres' ? undefined : 36);
    }

    uuid(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'uuid' : 'binary', this.dialect === 'postgres' ? undefined : 16);
    }

    string(name: string, size = 255): SchemaColumnBuilder {
        return this.column(name, 'varchar', size);
    }

    char(name: string, size = 255): SchemaColumnBuilder {
        return this.column(name, 'char', size);
    }

    text(name: string): SchemaColumnBuilder {
        return this.column(name, 'text');
    }

    tinyText(name: string): SchemaColumnBuilder {
        return this.column(name, 'tinytext');
    }

    mediumText(name: string): SchemaColumnBuilder {
        return this.column(name, 'mediumtext');
    }

    longText(name: string): SchemaColumnBuilder {
        return this.column(name, 'longtext');
    }

    integer(name: string): SchemaColumnBuilder {
        return this.column(name, 'int');
    }

    tinyint(name: string): SchemaColumnBuilder {
        return this.column(name, 'tinyint');
    }

    smallint(name: string): SchemaColumnBuilder {
        return this.column(name, 'smallint');
    }

    bigint(name: string): SchemaColumnBuilder {
        return this.column(name, 'bigint');
    }

    bigInteger(name: string): SchemaColumnBuilder {
        return this.bigint(name);
    }

    float(name: string): SchemaColumnBuilder {
        return this.column(name, 'float');
    }

    double(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'double precision' : 'double');
    }

    decimal(name: string, size = 10, scale = 2): SchemaColumnBuilder {
        return this.column(name, 'decimal', size, scale);
    }

    boolean(name: string): SchemaColumnBuilder {
        const column = this.column(name, this.dialect === 'mysql' ? 'tinyint' : 'boolean', this.dialect === 'mysql' ? 1 : undefined);
        if (this.dialect === 'mysql') column.unsigned();
        return column;
    }

    dateTime(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'timestamp' : 'datetime');
    }

    timestamp(name: string): SchemaColumnBuilder {
        return this.column(name, 'timestamp');
    }

    timestamptz(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'timestamptz' : 'timestamp');
    }

    time(name: string): SchemaColumnBuilder {
        return this.column(name, 'time');
    }

    date(name: string): SchemaColumnBuilder {
        return this.column(name, 'date');
    }

    json(name: string): SchemaColumnBuilder {
        return this.column(name, 'json');
    }

    jsonb(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'jsonb' : 'json');
    }

    binary(name: string, size?: number): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'bytea' : size === undefined ? 'blob' : 'binary', size);
    }

    blob(name: string): SchemaColumnBuilder {
        return this.column(name, this.dialect === 'postgres' ? 'bytea' : 'blob');
    }

    enum(name: string, values: readonly string[], typeName = `${this.tableName}_${name}_enum`): SchemaColumnBuilder {
        const column = this.column(name, 'enum');
        column.setEnumValues(values, this.dialect === 'postgres' ? typeName : undefined);
        return column;
    }

    point(name: string): SchemaColumnBuilder {
        if (this.dialect !== 'mysql') throw new Error('point() is only supported for MySQL schemas');
        return this.column(name, 'point');
    }

    timestamps(): void {
        this.dateTime('createdAt').defaultRaw('CURRENT_TIMESTAMP');
        const updatedAt = this.dateTime('updatedAt').defaultRaw('CURRENT_TIMESTAMP');
        if (this.dialect === 'mysql') updatedAt.onUpdate('CURRENT_TIMESTAMP');
    }

    index(columns: string | readonly string[], name = defaultSchemaIndexName(this.tableName, normalizeColumns(columns), false, this.dialect)): this {
        this.addIndexSchema({ name, columns: normalizeColumns(columns), unique: false });
        return this;
    }

    unique(columns: string | readonly string[], name = defaultSchemaIndexName(this.tableName, normalizeColumns(columns), true, this.dialect)): this {
        this.addIndexSchema({ name, columns: normalizeColumns(columns), unique: true });
        return this;
    }

    spatialIndex(
        columns: string | readonly string[],
        name = defaultSchemaIndexName(this.tableName, normalizeColumns(columns), false, this.dialect)
    ): this {
        this.addIndexSchema({ name, columns: normalizeColumns(columns), unique: false, spatial: true });
        return this;
    }

    foreign(
        columns: string | readonly string[],
        name = defaultForeignKeyName(this.tableName, normalizeColumns(columns), this.dialect)
    ): SchemaForeignKeyBuilder {
        const foreignKey: ForeignKeySchema = {
            name,
            localColumns: normalizeColumns(columns),
            foreignTable: '',
            foreignColumns: [],
            onDelete: 'RESTRICT',
            onUpdate: 'RESTRICT'
        };
        this.addForeignKeySchema(foreignKey);
        return new SchemaForeignKeyBuilder(foreignKey);
    }

    abstract primary(columns: string[]): this;

    protected column(name: string, type: string, size?: number, scale?: number): SchemaColumnBuilder {
        const column = new SchemaColumnBuilder(
            name,
            type,
            size,
            scale,
            () => this.index(name),
            indexName => this.index(name, indexName),
            indexName => this.unique(name, indexName),
            referencedColumn => this.foreign(name).references(referencedColumn)
        );
        return this.addColumn(column);
    }
}

export class SchemaTableBuilder extends SchemaBlueprintBase {
    private readonly columns: SchemaColumnBuilder[] = [];
    private readonly indexes: IndexSchema[] = [];
    private readonly foreignKeys: ForeignKeySchema[] = [];
    private explicitPrimaryKeyColumns: string[] | undefined;

    protected addColumn(column: SchemaColumnBuilder): SchemaColumnBuilder {
        this.columns.push(column);
        return column;
    }

    protected addIndexSchema(index: IndexSchema): void {
        this.indexes.push(index);
    }

    protected addForeignKeySchema(foreignKey: ForeignKeySchema): void {
        this.foreignKeys.push(foreignKey);
    }

    primary(columns: string[]): this {
        this.explicitPrimaryKeyColumns = [...columns];
        return this;
    }

    toSchema(): TableSchema {
        const columns = this.columns.map((column, index) => column.toSchema(index + 1));
        return {
            name: this.tableName,
            columns,
            indexes: [...this.indexes],
            foreignKeys: this.foreignKeys.map(foreignKey => ({ ...foreignKey })),
            primaryKeyColumns: this.explicitPrimaryKeyColumns ?? columns.filter(column => column.primaryKey).map(column => column.name)
        };
    }
}

type AlterOperation =
    | { kind: 'addColumn'; column: SchemaColumnBuilder }
    | { kind: 'modifyColumn'; column: SchemaColumnBuilder }
    | { kind: 'dropColumn'; name: string }
    | { kind: 'renameColumn'; from: string; to: string }
    | { kind: 'addIndex'; index: IndexSchema }
    | { kind: 'dropIndex'; name: string }
    | { kind: 'renameIndex'; from: string; to: string }
    | { kind: 'addForeignKey'; foreignKey: ForeignKeySchema }
    | { kind: 'dropForeignKey'; name: string }
    | { kind: 'addPrimaryKey'; columns: string[] }
    | { kind: 'dropPrimaryKey'; name?: string };

export class SchemaAlterBuilder extends SchemaBlueprintBase {
    private readonly operations: AlterOperation[] = [];

    get enumColumns(): ColumnSchema[] {
        return this.operations
            .filter(
                (operation): operation is Extract<AlterOperation, { kind: 'addColumn' | 'modifyColumn' }> =>
                    operation.kind === 'addColumn' || operation.kind === 'modifyColumn'
            )
            .map(operation => operation.column.toSchema(0))
            .filter(column => column.type === 'enum');
    }

    protected addColumn(column: SchemaColumnBuilder): SchemaColumnBuilder {
        this.operations.push({ kind: 'addColumn', column });
        column.setChangeCallback(() => this.markColumnAsModified(column));
        return column;
    }

    protected addIndexSchema(index: IndexSchema): void {
        this.operations.push({ kind: 'addIndex', index });
    }

    protected addForeignKeySchema(foreignKey: ForeignKeySchema): void {
        this.operations.push({ kind: 'addForeignKey', foreignKey });
    }

    dropColumn(name: string): this {
        this.operations.push({ kind: 'dropColumn', name });
        return this;
    }

    renameColumn(from: string, to: string): this {
        this.operations.push({ kind: 'renameColumn', from, to });
        return this;
    }

    dropIndex(name: string): this {
        this.operations.push({ kind: 'dropIndex', name });
        return this;
    }

    dropUnique(name: string): this {
        return this.dropIndex(name);
    }

    renameIndex(from: string, to: string): this {
        this.operations.push({ kind: 'renameIndex', from, to });
        return this;
    }

    dropForeign(name: string): this {
        this.operations.push({ kind: 'dropForeignKey', name });
        return this;
    }

    primary(columns: string[]): this {
        this.operations.push({ kind: 'addPrimaryKey', columns: [...columns] });
        return this;
    }

    dropPrimary(name?: string): this {
        this.operations.push({ kind: 'dropPrimaryKey', name });
        return this;
    }

    markColumnAsModified(column: SchemaColumnBuilder): void {
        const index = this.operations.findIndex(operation => operation.kind === 'addColumn' && operation.column === column);
        if (index === -1) return;
        this.operations[index] = { kind: 'modifyColumn', column };
    }

    toStatements(): string[] {
        const statements: string[] = [];
        const operationGroups: AlterOperation['kind'][] = [
            'dropForeignKey',
            'dropIndex',
            'renameIndex',
            'dropPrimaryKey',
            'dropColumn',
            'renameColumn',
            'addColumn',
            'modifyColumn',
            'addPrimaryKey',
            'addIndex',
            'addForeignKey'
        ];

        for (const kind of operationGroups) {
            for (const operation of this.operations) {
                if (operation.kind === kind) statements.push(...this.operationStatements(operation));
            }
        }

        return statements;
    }

    private operationStatements(operation: AlterOperation): string[] {
        const dialect = this.dialect;
        const table = qTable(dialect, this.tableName);

        switch (operation.kind) {
            case 'addColumn': {
                const column = operation.column.toSchema(0);
                return [`ALTER TABLE ${table} ADD COLUMN ${columnDefinition(column, dialect)}${columnPositionClause(column, dialect)}`];
            }
            case 'modifyColumn':
                return modifyColumnStatements(this.tableName, operation.column.toSchema(0), dialect);
            case 'dropColumn':
                return [`ALTER TABLE ${table} DROP COLUMN ${q(dialect, operation.name)}`];
            case 'renameColumn':
                return [`ALTER TABLE ${table} RENAME COLUMN ${q(dialect, operation.from)} TO ${q(dialect, operation.to)}`];
            case 'addIndex':
                return [createIndex(this.tableName, operation.index, dialect)];
            case 'dropIndex':
                return [dropIndex(this.tableName, operation.name, dialect)];
            case 'renameIndex':
                return [
                    dialect === 'mysql'
                        ? `ALTER TABLE ${table} RENAME INDEX ${q(dialect, operation.from)} TO ${q(dialect, operation.to)}`
                        : `ALTER INDEX ${qIndex(dialect, operation.from)} RENAME TO ${q(dialect, operation.to)}`
                ];
            case 'addForeignKey':
                return [addForeignKey(this.tableName, operation.foreignKey, dialect)];
            case 'dropForeignKey':
                return [
                    dialect === 'mysql'
                        ? `ALTER TABLE ${table} DROP FOREIGN KEY ${q(dialect, operation.name)}`
                        : `ALTER TABLE ${table} DROP CONSTRAINT ${q(dialect, operation.name)}`
                ];
            case 'addPrimaryKey':
                return [`ALTER TABLE ${table} ADD PRIMARY KEY (${operation.columns.map(column => q(dialect, column)).join(', ')})`];
            case 'dropPrimaryKey':
                return [
                    dialect === 'mysql'
                        ? `ALTER TABLE ${table} DROP PRIMARY KEY`
                        : `ALTER TABLE ${table} DROP CONSTRAINT ${q(dialect, operation.name ?? `${this.tableName}_pkey`)}`
                ];
        }
    }
}

function normalizeColumns(columns: string | readonly string[]): string[] {
    return typeof columns === 'string' ? [columns] : [...columns];
}

export class SchemaColumnBuilder {
    private nullableValue = false;
    private primaryKeyValue = false;
    private unsignedValue = false;
    private autoIncrementValue = false;
    private defaultValueValue: ColumnSchema['defaultValue'];
    private defaultExpressionValue: string | undefined;
    private onUpdateExpressionValue: string | undefined;
    private enumValuesValue: string[] | undefined;
    private enumTypeNameValue: string | undefined;
    private afterColumnValue: string | null | undefined;
    private changeCallback: (() => void) | undefined;

    constructor(
        readonly name: string,
        private readonly type: string,
        private readonly size?: number,
        private readonly scale?: number,
        private readonly addDefaultIndex?: () => void,
        private readonly addNamedIndex?: (name: string) => void,
        private readonly addNamedUniqueIndex?: (name: string | undefined) => void,
        private readonly addForeignKey?: (referencedColumn: string) => SchemaForeignKeyBuilder
    ) {}

    get isPrimaryKey(): boolean {
        return this.primaryKeyValue;
    }

    primary(): this {
        this.primaryKeyValue = true;
        return this;
    }

    nullable(value = true): this {
        this.nullableValue = value;
        return this;
    }

    notNull(): this {
        this.nullableValue = false;
        return this;
    }

    unsigned(value = true): this {
        this.unsignedValue = value;
        return this;
    }

    autoIncrement(value = true): this {
        this.autoIncrementValue = value;
        return this;
    }

    default(value: string | number | boolean | null): this {
        this.defaultValueValue = value;
        this.defaultExpressionValue = undefined;
        return this;
    }

    defaultRaw(expression: string): this {
        this.defaultExpressionValue = expression;
        this.defaultValueValue = undefined;
        return this;
    }

    onUpdate(expression: string): this {
        this.onUpdateExpressionValue = expression;
        return this;
    }

    index(indexName?: string): this {
        if (indexName) this.addNamedIndex?.(indexName);
        else this.addDefaultIndex?.();
        return this;
    }

    unique(indexName?: string): this {
        this.addNamedUniqueIndex?.(indexName);
        return this;
    }

    references(referencedColumn: string): SchemaForeignKeyBuilder {
        if (!this.addForeignKey) throw new Error('Column foreign keys are not available for this schema builder');
        return this.addForeignKey(referencedColumn);
    }

    change(): this {
        this.changeCallback?.();
        return this;
    }

    after(columnName: string): this {
        this.afterColumnValue = columnName;
        return this;
    }

    first(): this {
        this.afterColumnValue = null;
        return this;
    }

    setEnumValues(values: readonly string[], typeName?: string): void {
        this.enumValuesValue = [...values];
        this.enumTypeNameValue = typeName;
    }

    setChangeCallback(callback: () => void): void {
        this.changeCallback = callback;
    }

    toSchema(ordinalPosition: number): ColumnSchema {
        const schema: ColumnSchema = {
            name: this.name,
            type: this.type,
            size: this.size,
            scale: this.scale,
            unsigned: this.unsignedValue,
            nullable: this.nullableValue,
            autoIncrement: this.autoIncrementValue,
            primaryKey: this.primaryKeyValue,
            ordinalPosition
        };
        if (this.defaultValueValue !== undefined) schema.defaultValue = this.defaultValueValue;
        if (this.defaultExpressionValue !== undefined) schema.defaultExpression = this.defaultExpressionValue;
        if (this.onUpdateExpressionValue !== undefined) schema.onUpdateExpression = this.onUpdateExpressionValue;
        if (this.enumValuesValue) schema.enumValues = this.enumValuesValue;
        if (this.enumTypeNameValue) schema.enumTypeName = this.enumTypeNameValue;
        if (this.afterColumnValue !== undefined) schema.afterColumn = this.afterColumnValue;
        return schema;
    }
}

export class SchemaForeignKeyBuilder {
    constructor(private readonly foreignKey: ForeignKeySchema) {}

    references(column: string): this {
        this.foreignKey.foreignColumns = [column];
        return this;
    }

    referencesAll(columns: string[]): this {
        this.foreignKey.foreignColumns = [...columns];
        return this;
    }

    on(table: string): this {
        this.foreignKey.foreignTable = table;
        return this;
    }

    onDelete(action: string): this {
        this.foreignKey.onDelete = action;
        return this;
    }

    onUpdate(action: string): this {
        this.foreignKey.onUpdate = action;
        return this;
    }

    name(name: string): this {
        this.foreignKey.name = name;
        return this;
    }
}

function createPostgresEnumTypes(columns: readonly ColumnSchema[], tableName: string, dialect: Dialect, seen: Set<string>): string[] {
    if (dialect !== 'postgres') return [];
    return columns.flatMap(column => {
        if (column.type !== 'enum' || !column.enumValues?.length) return [];
        return createPostgresEnumType(column.enumTypeName ?? `${tableName}_${column.name}_enum`, column.enumValues, dialect, seen);
    });
}

function createPostgresEnumType(typeName: string, values: readonly string[], dialect: Dialect, seen: Set<string>): string[] {
    if (dialect !== 'postgres') return [];
    if (seen.has(typeName)) return [];
    seen.add(typeName);
    const literals = values.map(value => literal(value)).join(', ');
    return [
        [
            'DO $$ BEGIN',
            `IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = ${literal(typeName)}) THEN`,
            `    CREATE TYPE ${qType(dialect, typeName)} AS ENUM (${literals});`,
            'END IF;',
            'END $$'
        ].join('\n'),
        `CREATE CAST (text AS ${qType(dialect, typeName)}) WITH INOUT AS IMPLICIT`
    ];
}

function modifyColumnStatements(tableName: string, column: ColumnSchema, dialect: Dialect): string[] {
    const table = qTable(dialect, tableName);
    const columnName = q(dialect, column.name);
    if (dialect === 'mysql') return [`ALTER TABLE ${table} MODIFY COLUMN ${columnDefinition(column, dialect)}`];

    const statements = [`ALTER TABLE ${table} ALTER COLUMN ${columnName} TYPE ${columnType(column, dialect)}`];
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${columnName} ${column.nullable ? 'DROP' : 'SET'} NOT NULL`);
    if (column.defaultExpression) statements.push(`ALTER TABLE ${table} ALTER COLUMN ${columnName} SET DEFAULT ${column.defaultExpression}`);
    else if (column.defaultValue !== undefined)
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${columnName} SET DEFAULT ${literal(column.defaultValue)}`);
    else statements.push(`ALTER TABLE ${table} ALTER COLUMN ${columnName} DROP DEFAULT`);
    return statements;
}

function columnPositionClause(column: ColumnSchema, dialect: Dialect): string {
    if (dialect !== 'mysql') return '';
    if (column.afterColumn === null) return ' FIRST';
    if (typeof column.afterColumn === 'string') return ` AFTER ${q(dialect, column.afterColumn)}`;
    return '';
}

function columnDefinition(column: ColumnSchema, dialect: Dialect): string {
    const parts = [q(dialect, column.name), columnType(column, dialect)];
    if (!column.nullable) parts.push('NOT NULL');
    if (column.autoIncrement) parts.push(dialect === 'postgres' ? 'GENERATED BY DEFAULT AS IDENTITY' : 'AUTO_INCREMENT');
    if (column.defaultExpression) parts.push(`DEFAULT ${column.defaultExpression}`);
    else if (column.defaultValue !== undefined) parts.push(`DEFAULT ${literal(column.defaultValue)}`);
    if (dialect === 'mysql' && column.onUpdateExpression) parts.push(`ON UPDATE ${column.onUpdateExpression}`);
    return parts.join(' ');
}

function columnType(column: ColumnSchema, dialect: Dialect): string {
    if (column.type === 'enum' && column.enumValues?.length) {
        return dialect === 'mysql'
            ? `ENUM(${column.enumValues.map(value => literal(value)).join(', ')})`
            : qType(dialect, column.enumTypeName ?? 'enum');
    }
    if (column.type === 'boolean' && dialect === 'mysql') return `tinyint(1)${column.unsigned ? ' unsigned' : ''}`;
    if (column.type === 'json' && dialect === 'mysql') return 'json';
    if (column.type === 'jsonb' && dialect === 'mysql') return 'json';
    if (column.type === 'bytea' && dialect === 'mysql') return 'blob';
    if (column.type === 'tinytext' && dialect === 'postgres') return 'text';
    if (column.type === 'mediumtext' && dialect === 'postgres') return 'text';
    if (column.type === 'longtext' && dialect === 'postgres') return 'text';
    if (column.type === 'int' && dialect === 'postgres') return 'integer';
    if (column.type === 'double' && dialect === 'postgres') return 'double precision';
    if (column.type === 'datetime' && dialect === 'postgres') return 'timestamp';
    if (column.type === 'binary' && dialect === 'postgres') return 'bytea';

    const size = column.size !== undefined ? `(${column.scale !== undefined ? `${column.size}, ${column.scale}` : column.size})` : '';
    const unsigned = dialect === 'mysql' && column.unsigned ? ' unsigned' : '';
    return `${column.type}${size}${unsigned}`;
}

function createIndex(tableName: string, index: IndexSchema, dialect: Dialect): string {
    const unique = index.unique ? 'UNIQUE ' : '';
    const spatial = dialect === 'mysql' && index.spatial ? 'SPATIAL ' : '';
    const columns = index.columns.map(column => {
        const quoted = q(dialect, column);
        const size = index.columnSizes?.[column] ?? index.size;
        return dialect === 'mysql' && size ? `${quoted}(${size})` : quoted;
    });
    return `CREATE ${spatial}${unique}INDEX ${qIndex(dialect, index.name)} ON ${qTable(dialect, tableName)} (${columns.join(', ')})`;
}

function dropIndex(tableName: string, indexName: string, dialect: Dialect): string {
    return dialect === 'mysql' ? `DROP INDEX ${q(dialect, indexName)} ON ${qTable(dialect, tableName)}` : `DROP INDEX ${qIndex(dialect, indexName)}`;
}

function addForeignKey(tableName: string, foreignKey: ForeignKeySchema, dialect: Dialect): string {
    const localColumns = foreignKey.localColumns.map(column => q(dialect, column)).join(', ');
    const foreignColumns = foreignKey.foreignColumns.map(column => q(dialect, column)).join(', ');
    const parts = [
        `ALTER TABLE ${qTable(dialect, tableName)} ADD CONSTRAINT ${q(dialect, foreignKey.name)}`,
        `FOREIGN KEY (${localColumns}) REFERENCES ${qTable(dialect, foreignKey.foreignTable)} (${foreignColumns})`
    ];
    if (foreignKey.onDelete) parts.push(`ON DELETE ${foreignKey.onDelete}`);
    if (foreignKey.onUpdate) parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
    return parts.join(' ');
}

function defaultForeignKeyName(tableName: string, columns: readonly string[], dialect: Dialect): string {
    return defaultSchemaIndexName(tableName, columns, false, dialect).replace(/_index$/, '_foreign');
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

function qTable(dialect: Dialect, name: string): string {
    return q(dialect, name);
}

function qType(dialect: Dialect, name: string): string {
    return q(dialect, name);
}

function qIndex(dialect: Dialect, name: string): string {
    return q(dialect, name);
}
