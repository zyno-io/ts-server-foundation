import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COMMENT_PREFIX } from './ddl-generator';

export interface MigrationFileOptions {
    migrationsDir?: string;
    now?: Date;
}

export function buildMigrationFileContent(statements: readonly string[], packageName = '@zyno-io/ts-server-foundation'): string {
    const lines: string[] = [];
    for (const statement of statements) {
        if (statement.startsWith(COMMENT_PREFIX)) {
            lines.push('');
            lines.push(`    // Table: ${statement.slice(COMMENT_PREFIX.length)}`);
        } else {
            lines.push(formatStatement(statement));
        }
    }

    return `import { createMigration } from '${packageName}';\n\nexport default createMigration(async db => {${lines.join('\n')}\n});\n`;
}

export function writeMigrationFile(statements: readonly string[], description: string, options: MigrationFileOptions = {}): string {
    const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'src', 'migrations');
    if (!existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true });
    const filename = `${timestamp(options.now ?? new Date())}_${slugify(description)}.ts`;
    const path = join(migrationsDir, filename);
    writeFileSync(path, buildMigrationFileContent(statements), 'utf8');
    return path;
}

function formatStatement(statement: string): string {
    const escaped = statement.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    if (!escaped.includes('\n')) return `    await db.rawExecute(\`${escaped}\`);`;
    return `    await db.rawExecute(\`\n${escaped
        .split('\n')
        .map(line => `        ${line}`)
        .join('\n')}\n    \`);`;
}

function timestamp(date: Date): string {
    const parts = [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds()
    ].map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')));
    return `${parts[0]}${parts[1]}${parts[2]}_${parts[3]}${parts[4]}${parts[5]}`;
}

function slugify(description: string): string {
    const slug = description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 50);
    return slug || 'migration';
}
