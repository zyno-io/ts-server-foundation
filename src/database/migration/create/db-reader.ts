import { sql } from '../../sql';
import type { BaseDatabase } from '../../database';
import { DatabaseSchema, ForeignKeySchema, IndexSchema, INTERNAL_TABLES, TableForeignKeySchema, TableSchema } from './schema-model';
import { canonicalType, parseRawSqlType } from './type-mapper';

export interface ReadDatabaseSchemaOptions {
    includeInternalTables?: boolean;
}

export async function readAllTableNames(db: BaseDatabase, pgSchema = 'public'): Promise<string[]> {
    if (db.driver.dialect === 'postgres') {
        const rows = await db.rawFind<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = ${pgSchema}`);
        return rows.map(row => row.tablename).filter(name => !INTERNAL_TABLES.has(name));
    }

    const rows = await db.rawFind<{ TABLE_NAME: string }>(sql`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    `);
    return rows.map(row => row.TABLE_NAME).filter(name => !INTERNAL_TABLES.has(name));
}

export async function readDatabaseSchema(
    db: BaseDatabase,
    tableNames: readonly string[],
    pgSchema = 'public',
    options: ReadDatabaseSchemaOptions = {}
): Promise<DatabaseSchema> {
    const schema: DatabaseSchema = new Map();
    for (const tableName of tableNames) {
        if (!options.includeInternalTables && INTERNAL_TABLES.has(tableName)) continue;
        const table = db.driver.dialect === 'postgres' ? await readPostgresTable(db, tableName, pgSchema) : await readMySQLTable(db, tableName);
        if (table) schema.set(tableName, table);
    }
    return schema;
}

export async function readInboundForeignKeys(
    db: BaseDatabase,
    referencedTableNames: readonly string[],
    pgSchema = 'public'
): Promise<TableForeignKeySchema[]> {
    const tableNames = [...new Set(referencedTableNames)].filter(tableName => !INTERNAL_TABLES.has(tableName));
    if (!tableNames.length) return [];
    return db.driver.dialect === 'postgres' ? readPostgresInboundForeignKeys(db, tableNames, pgSchema) : readMySQLInboundForeignKeys(db, tableNames);
}

async function readMySQLTable(db: BaseDatabase, tableName: string): Promise<TableSchema | undefined> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE,
               DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH,
               NUMERIC_PRECISION, NUMERIC_SCALE, EXTRA, COLUMN_KEY
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}
        ORDER BY ORDINAL_POSITION
    `);
    if (!rows.length) return undefined;
    const primaryKeyColumns = await readMySQLPrimaryKeyColumns(db, tableName);
    const indexes = await readMySQLIndexes(db, tableName);
    const foreignKeys = await readMySQLForeignKeys(db, tableName);

    return {
        name: tableName,
        columns: rows.map(row => {
            const dataType = String(row.DATA_TYPE ?? '').toLowerCase();
            const columnType = String(row.COLUMN_TYPE ?? dataType);
            const parsed = dataType === 'enum' ? parseRawSqlType(columnType, 'mysql') : parseRawSqlType(columnType || dataType, 'mysql');
            return {
                name: String(row.COLUMN_NAME),
                type: parsed.type,
                size: inferSize(parsed.size, row.CHARACTER_MAXIMUM_LENGTH, row.NUMERIC_PRECISION, parsed.type),
                scale: parsed.scale ?? inferScale(row.NUMERIC_SCALE, parsed.type),
                unsigned: parsed.unsigned ?? false,
                nullable: row.IS_NULLABLE === 'YES',
                autoIncrement: String(row.EXTRA ?? '')
                    .toLowerCase()
                    .includes('auto_increment'),
                primaryKey: row.COLUMN_KEY === 'PRI',
                defaultValue: normalizeDefault(row.COLUMN_DEFAULT, parsed.type),
                enumValues: parsed.enumValues,
                ordinalPosition: Number(row.ORDINAL_POSITION)
            };
        }),
        indexes,
        foreignKeys,
        primaryKeyColumns: primaryKeyColumns.length
            ? primaryKeyColumns
            : rows.filter(row => row.COLUMN_KEY === 'PRI').map(row => String(row.COLUMN_NAME))
    };
}

async function readPostgresTable(db: BaseDatabase, tableName: string, pgSchema: string): Promise<TableSchema | undefined> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT column_name, ordinal_position, column_default, is_nullable,
               data_type, udt_name, character_maximum_length,
               numeric_precision, numeric_scale, is_identity
        FROM information_schema.columns
        WHERE table_schema = ${pgSchema} AND table_name = ${tableName}
        ORDER BY ordinal_position
    `);
    if (!rows.length) return undefined;
    const enumTypes = rows.some(row => String(row.data_type ?? '') === 'USER-DEFINED' || String(row.data_type ?? '') === 'user-defined')
        ? await readPostgresEnumTypes(db, pgSchema, rows.map(row => String(row.udt_name ?? '')).filter(Boolean))
        : new Map<string, string[]>();

    const pkRows = await db.rawFind<{ constraint_name: string; column_name: string }>(sql`
        SELECT tc.constraint_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.constraint_schema = kcu.constraint_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = ${pgSchema}
          AND tc.table_name = ${tableName}
        ORDER BY kcu.ordinal_position
    `);
    const pkColumns = new Set(pkRows.map(row => row.column_name));
    const primaryKeyColumns = pkRows.map(row => row.column_name);
    const primaryKeyConstraintName = pkRows[0]?.constraint_name;
    const indexes = await readPostgresIndexes(db, tableName, pgSchema);
    const foreignKeys = await readPostgresForeignKeys(db, tableName, pgSchema);

    return {
        name: tableName,
        columns: rows.map(row => {
            const dataType = canonicalType(String(row.data_type ?? row.udt_name ?? ''));
            const autoIncrement = row.is_identity === 'YES' || String(row.column_default ?? '').includes('nextval(');
            const enumValues = enumTypes.get(String(row.udt_name ?? ''));
            return {
                name: String(row.column_name),
                type: enumValues ? 'enum' : normalizePostgresColumnType(dataType, String(row.udt_name ?? '')),
                size: inferSize(undefined, row.character_maximum_length, row.numeric_precision, dataType),
                scale: inferScale(row.numeric_scale, dataType),
                unsigned: false,
                nullable: row.is_nullable === 'YES',
                autoIncrement,
                primaryKey: pkColumns.has(String(row.column_name)),
                defaultValue: autoIncrement ? undefined : normalizePostgresDefault(row.column_default),
                enumValues,
                enumTypeName: enumValues ? String(row.udt_name) : undefined,
                ordinalPosition: Number(row.ordinal_position)
            };
        }),
        indexes,
        foreignKeys,
        primaryKeyColumns,
        primaryKeyConstraintName
    };
}

async function readPostgresEnumTypes(db: BaseDatabase, pgSchema: string, typeNames: readonly string[]): Promise<Map<string, string[]>> {
    const names = [...new Set(typeNames)].filter(Boolean);
    if (!names.length) return new Map();
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT t.typname AS type_name, e.enumlabel AS enum_value, e.enumsortorder AS sort_order
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ${pgSchema}
          AND t.typname IN (${sql.join(names.map(name => sql`${name}`))})
        ORDER BY t.typname, e.enumsortorder
    `);
    const result = new Map<string, string[]>();
    for (const row of rows) {
        const typeName = String(row.type_name);
        const values = result.get(typeName) ?? [];
        values.push(String(row.enum_value));
        result.set(typeName, values);
    }
    return result;
}

async function readMySQLPrimaryKeyColumns(db: BaseDatabase, tableName: string): Promise<string[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT COLUMN_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX
    `);
    return rows.map(row => String(row.COLUMN_NAME));
}

async function readMySQLIndexes(db: BaseDatabase, tableName: string): Promise<IndexSchema[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND INDEX_NAME <> 'PRIMARY'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `);
    return groupIndexRows(
        rows.map(row => ({
            name: String(row.INDEX_NAME),
            unique: Number(row.NON_UNIQUE) === 0,
            column: String(row.COLUMN_NAME),
            size: row.SUB_PART == null ? undefined : Number(row.SUB_PART)
        }))
    );
}

async function readPostgresIndexes(db: BaseDatabase, tableName: string, pgSchema: string): Promise<IndexSchema[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT i.relname AS index_name,
               ix.indisunique AS is_unique,
               con.conname AS constraint_name,
               array_agg(a.attname ORDER BY keys.ordinality) AS columns
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_index ix ON ix.indrelid = t.oid
        JOIN pg_class i ON i.oid = ix.indexrelid
        LEFT JOIN pg_constraint con ON con.conindid = i.oid AND con.contype IN ('u', 'x')
        JOIN unnest(ix.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keys.attnum
        WHERE n.nspname = ${pgSchema}
          AND t.relname = ${tableName}
          AND ix.indisprimary = false
        GROUP BY i.relname, ix.indisunique, con.conname
        ORDER BY i.relname
    `);
    return rows.map(row => {
        const index: IndexSchema = {
            name: String(row.index_name),
            columns: normalizeColumnArray(row.columns),
            unique: row.is_unique === true || row.is_unique === 't' || row.is_unique === 'true'
        };
        if (row.constraint_name != null) index.constraintName = String(row.constraint_name);
        return index;
    });
}

async function readMySQLForeignKeys(db: BaseDatabase, tableName: string): Promise<ForeignKeySchema[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
               k.ORDINAL_POSITION, r.UPDATE_RULE, r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
         AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE()
          AND k.TABLE_NAME = ${tableName}
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION
    `);
    return groupForeignKeyRows(
        rows.map(row => ({
            name: String(row.CONSTRAINT_NAME),
            localColumn: String(row.COLUMN_NAME),
            foreignTable: String(row.REFERENCED_TABLE_NAME),
            foreignColumn: String(row.REFERENCED_COLUMN_NAME),
            onDelete: normalizeRule(row.DELETE_RULE),
            onUpdate: normalizeRule(row.UPDATE_RULE)
        }))
    );
}

async function readPostgresForeignKeys(db: BaseDatabase, tableName: string, pgSchema: string): Promise<ForeignKeySchema[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT con.conname AS constraint_name,
               local_att.attname AS column_name,
               foreign_class.relname AS foreign_table_name,
               foreign_att.attname AS foreign_column_name,
               keys.ordinality AS ordinal_position,
               CASE con.confupdtype
                   WHEN 'a' THEN 'NO ACTION'
                   WHEN 'r' THEN 'RESTRICT'
                   WHEN 'c' THEN 'CASCADE'
                   WHEN 'n' THEN 'SET NULL'
                   WHEN 'd' THEN 'SET DEFAULT'
               END AS update_rule,
               CASE con.confdeltype
                   WHEN 'a' THEN 'NO ACTION'
                   WHEN 'r' THEN 'RESTRICT'
                   WHEN 'c' THEN 'CASCADE'
                   WHEN 'n' THEN 'SET NULL'
                   WHEN 'd' THEN 'SET DEFAULT'
               END AS delete_rule
        FROM pg_constraint con
        JOIN pg_class local_class ON local_class.oid = con.conrelid
        JOIN pg_namespace local_namespace ON local_namespace.oid = local_class.relnamespace
        JOIN pg_class foreign_class ON foreign_class.oid = con.confrelid
        JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS keys(local_attnum, foreign_attnum, ordinality) ON true
        JOIN pg_attribute local_att ON local_att.attrelid = local_class.oid AND local_att.attnum = keys.local_attnum
        JOIN pg_attribute foreign_att ON foreign_att.attrelid = foreign_class.oid AND foreign_att.attnum = keys.foreign_attnum
        WHERE con.contype = 'f'
          AND local_namespace.nspname = ${pgSchema}
          AND local_class.relname = ${tableName}
        ORDER BY con.conname, keys.ordinality
    `);
    return groupForeignKeyRows(
        rows.map(row => ({
            name: String(row.constraint_name),
            localColumn: String(row.column_name),
            foreignTable: String(row.foreign_table_name),
            foreignColumn: String(row.foreign_column_name),
            onDelete: normalizeRule(row.delete_rule),
            onUpdate: normalizeRule(row.update_rule)
        }))
    );
}

async function readMySQLInboundForeignKeys(db: BaseDatabase, referencedTableNames: readonly string[]): Promise<TableForeignKeySchema[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
               k.ORDINAL_POSITION, r.UPDATE_RULE, r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
         AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE()
          AND k.REFERENCED_TABLE_NAME IN (${sql.join(referencedTableNames.map(tableName => sql`${tableName}`))})
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
    `);
    return groupTableForeignKeyRows(
        rows.map(row => ({
            tableName: String(row.TABLE_NAME),
            name: String(row.CONSTRAINT_NAME),
            localColumn: String(row.COLUMN_NAME),
            foreignTable: String(row.REFERENCED_TABLE_NAME),
            foreignColumn: String(row.REFERENCED_COLUMN_NAME),
            onDelete: normalizeRule(row.DELETE_RULE),
            onUpdate: normalizeRule(row.UPDATE_RULE)
        }))
    );
}

async function readPostgresInboundForeignKeys(
    db: BaseDatabase,
    referencedTableNames: readonly string[],
    pgSchema: string
): Promise<TableForeignKeySchema[]> {
    const rows = await db.rawFind<Record<string, unknown>>(sql`
        SELECT local_class.relname AS table_name,
               con.conname AS constraint_name,
               local_att.attname AS column_name,
               foreign_class.relname AS foreign_table_name,
               foreign_att.attname AS foreign_column_name,
               keys.ordinality AS ordinal_position,
               CASE con.confupdtype
                   WHEN 'a' THEN 'NO ACTION'
                   WHEN 'r' THEN 'RESTRICT'
                   WHEN 'c' THEN 'CASCADE'
                   WHEN 'n' THEN 'SET NULL'
                   WHEN 'd' THEN 'SET DEFAULT'
               END AS update_rule,
               CASE con.confdeltype
                   WHEN 'a' THEN 'NO ACTION'
                   WHEN 'r' THEN 'RESTRICT'
                   WHEN 'c' THEN 'CASCADE'
                   WHEN 'n' THEN 'SET NULL'
                   WHEN 'd' THEN 'SET DEFAULT'
               END AS delete_rule
        FROM pg_constraint con
        JOIN pg_class local_class ON local_class.oid = con.conrelid
        JOIN pg_namespace local_namespace ON local_namespace.oid = local_class.relnamespace
        JOIN pg_class foreign_class ON foreign_class.oid = con.confrelid
        JOIN pg_namespace foreign_namespace ON foreign_namespace.oid = foreign_class.relnamespace
        JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS keys(local_attnum, foreign_attnum, ordinality) ON true
        JOIN pg_attribute local_att ON local_att.attrelid = local_class.oid AND local_att.attnum = keys.local_attnum
        JOIN pg_attribute foreign_att ON foreign_att.attrelid = foreign_class.oid AND foreign_att.attnum = keys.foreign_attnum
        WHERE con.contype = 'f'
          AND local_namespace.nspname = ${pgSchema}
          AND foreign_namespace.nspname = ${pgSchema}
          AND foreign_class.relname IN (${sql.join(referencedTableNames.map(tableName => sql`${tableName}`))})
        ORDER BY local_class.relname, con.conname, keys.ordinality
    `);
    return groupTableForeignKeyRows(
        rows.map(row => ({
            tableName: String(row.table_name),
            name: String(row.constraint_name),
            localColumn: String(row.column_name),
            foreignTable: String(row.foreign_table_name),
            foreignColumn: String(row.foreign_column_name),
            onDelete: normalizeRule(row.delete_rule),
            onUpdate: normalizeRule(row.update_rule)
        }))
    );
}

function normalizePostgresColumnType(dataType: string, udtName: string): string {
    if (dataType === 'user-defined') return canonicalType(udtName);
    if (dataType === 'array') return 'json';
    return dataType;
}

function groupIndexRows(rows: { name: string; unique: boolean; column: string; size?: number }[]): IndexSchema[] {
    const groups = new Map<string, IndexSchema>();
    for (const row of rows) {
        let index = groups.get(row.name);
        if (!index) {
            index = { name: row.name, columns: [], unique: row.unique };
            groups.set(row.name, index);
        }
        index.columns.push(row.column);
        if (row.size !== undefined) {
            index.columnSizes ??= {};
            index.columnSizes[row.column] = row.size;
        }
    }
    for (const index of groups.values()) {
        const sizes = index.columns.map(column => index.columnSizes?.[column]).filter(size => size !== undefined);
        const firstSize = sizes[0];
        if (sizes.length === index.columns.length && sizes.every(size => size === firstSize)) {
            index.size = firstSize;
            delete index.columnSizes;
        }
    }
    return [...groups.values()];
}

function groupForeignKeyRows(
    rows: {
        name: string;
        localColumn: string;
        foreignTable: string;
        foreignColumn: string;
        onDelete?: string;
        onUpdate?: string;
    }[]
): ForeignKeySchema[] {
    const groups = new Map<string, ForeignKeySchema>();
    for (const row of rows) {
        let foreignKey = groups.get(row.name);
        if (!foreignKey) {
            foreignKey = {
                name: row.name,
                localColumns: [],
                foreignTable: row.foreignTable,
                foreignColumns: [],
                onDelete: row.onDelete,
                onUpdate: row.onUpdate
            };
            groups.set(row.name, foreignKey);
        }
        foreignKey.localColumns.push(row.localColumn);
        foreignKey.foreignColumns.push(row.foreignColumn);
    }
    return [...groups.values()];
}

function groupTableForeignKeyRows(
    rows: {
        tableName: string;
        name: string;
        localColumn: string;
        foreignTable: string;
        foreignColumn: string;
        onDelete?: string;
        onUpdate?: string;
    }[]
): TableForeignKeySchema[] {
    const groups = new Map<string, TableForeignKeySchema>();
    for (const row of rows) {
        const key = `${row.tableName}\0${row.name}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                tableName: row.tableName,
                foreignKey: {
                    name: row.name,
                    localColumns: [],
                    foreignTable: row.foreignTable,
                    foreignColumns: [],
                    onDelete: row.onDelete,
                    onUpdate: row.onUpdate
                }
            };
            groups.set(key, group);
        }
        group.foreignKey.localColumns.push(row.localColumn);
        group.foreignKey.foreignColumns.push(row.foreignColumn);
    }
    return [...groups.values()];
}

function normalizeColumnArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') {
        return value
            .replace(/^\{|\}$/g, '')
            .split(',')
            .map(item => item.trim().replace(/^"(.*)"$/, '$1'))
            .filter(Boolean);
    }
    return [];
}

function normalizeRule(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return String(value).toUpperCase();
}

function inferSize(parsed: number | undefined, characterMax: unknown, numericPrecision: unknown, type: string): number | undefined {
    if (parsed !== undefined) return parsed;
    if (['varchar', 'char', 'binary', 'varbinary'].includes(type) && characterMax != null) return Number(characterMax);
    if (['decimal', 'numeric'].includes(type) && numericPrecision != null) return Number(numericPrecision);
}

function inferScale(scale: unknown, type: string): number | undefined {
    if (!['decimal', 'numeric'].includes(type) || scale == null) return undefined;
    return Number(scale);
}

function normalizeDefault(value: unknown, type: string): string | number | boolean | null | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value);
    if (text.toUpperCase() === 'NULL') return null;
    if (type === 'boolean' || type === 'tinyint') {
        if (text === '1' || text.toLowerCase() === 'true') return true;
        if (text === '0' || text.toLowerCase() === 'false') return false;
    }
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text.replace(/^'(.*)'$/, '$1');
}

function normalizePostgresDefault(value: unknown): string | number | boolean | null | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value)
        .replace(/::[\w\s]+(?:\[\])?/g, '')
        .replace(/^'(.*)'$/, '$1');
    return normalizeDefault(text, '');
}
