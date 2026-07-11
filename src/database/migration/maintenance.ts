import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from '../sql';
import type { BaseDatabase } from '../database';
import { generateDDL, readEntitiesSchema, type SchemaDiff } from './create';
import { buildMigrationFileContent } from './create/file-generator';

export const DEFAULT_MYSQL_CHARSET = 'utf8mb4';
export const DEFAULT_MYSQL_COLLATION = 'utf8mb4_0900_ai_ci';

export interface ResetMigrationsOptions {
    migrationsDir?: string;
    pgSchema?: string;
}

export interface ResetMigrationsResult {
    migrationsDir: string;
    removedFiles: string[];
    tableCount: number;
    statements: string[];
    migrationPath?: string;
}

export interface StandardizeDbCollationOptions {
    charset?: string;
    collation?: string;
}

export interface StandardizeDbCollationResult {
    skipped: boolean;
    databaseName?: string;
    tables: string[];
}

export async function resetMigrations(db: BaseDatabase, options: ResetMigrationsOptions = {}): Promise<ResetMigrationsResult> {
    const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'src', 'migrations');
    if (!existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true });

    const removedFiles = readdirSync(migrationsDir)
        .filter(file => file.endsWith('.ts'))
        .sort();
    for (const file of removedFiles) unlinkSync(join(migrationsDir, file));

    const tables = [...readEntitiesSchema(db).values()];
    if (!tables.length) {
        return { migrationsDir, removedFiles, tableCount: 0, statements: [] };
    }

    const diff: SchemaDiff = {
        dialect: db.driver.dialect,
        pgSchema: options.pgSchema,
        externalForeignKeyDrops: [],
        externalForeignKeyAdds: [],
        addedTables: tables,
        removedTables: [],
        modifiedTables: []
    };
    const statements = generateDDL(diff);
    const migrationPath = join(migrationsDir, '00000000_000000_base.ts');
    writeFileSync(migrationPath, buildMigrationFileContent(statements), 'utf8');
    return { migrationsDir, removedFiles, tableCount: tables.length, statements, migrationPath };
}

export async function standardizeDbCollation(db: BaseDatabase, options: StandardizeDbCollationOptions = {}): Promise<StandardizeDbCollationResult> {
    if (db.driver.dialect === 'postgres') {
        console.warn('Character set standardization is not applicable to PostgreSQL');
        return { skipped: true, tables: [] };
    }

    const charset = assertSafeMySQLCharsetName(options.charset ?? DEFAULT_MYSQL_CHARSET, 'charset');
    const collation = assertSafeMySQLCharsetName(options.collation ?? DEFAULT_MYSQL_COLLATION, 'collation');
    const dbNameRow = await db.rawFindOne<Record<string, unknown>>(sql`SELECT DATABASE() AS ${sql.identifier('databaseName')}`);
    const databaseName = String(dbNameRow?.databaseName ?? '');
    if (!databaseName) throw new Error('Could not determine current MySQL database');

    await db.rawExecute(
        sql`ALTER DATABASE ${sql.identifier(databaseName)} CHARACTER SET = ${sql.rawTrusted(charset)} COLLATE = ${sql.rawTrusted(collation)}`
    );

    const tableRows = await db.rawFind<Record<string, unknown>>(sql`SHOW TABLES`);
    const tables = tableRows.map(row => Object.values(row)[0]).filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const table of tables) {
        await db.rawExecute(
            sql`ALTER TABLE ${sql.identifier(table)} CONVERT TO CHARACTER SET ${sql.rawTrusted(charset)} COLLATE ${sql.rawTrusted(collation)}`
        );
    }

    return { skipped: false, databaseName, tables };
}

function assertSafeMySQLCharsetName(value: string, field: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`Invalid MySQL ${field}: ${value}`);
    return value;
}
