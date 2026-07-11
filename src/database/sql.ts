export type SqlValue = unknown;

export interface SqlQuery {
    readonly kind: 'sql';
    readonly chunks: readonly string[];
    readonly values: readonly SqlValue[];
}

export interface SqlIdentifier {
    readonly kind: 'identifier';
    readonly names: readonly string[];
}

export interface SqlTrustedRaw {
    readonly kind: 'rawTrusted';
    readonly text: string;
}

export type SqlFragment = SqlQuery | SqlIdentifier | SqlTrustedRaw;
export type SqlInput = SqlQuery | string;
export type Dialect = 'mysql' | 'postgres';

export interface RenderedSql {
    sql: string;
    bindings: unknown[];
}

type SqlTemplateValue = SqlValue | SqlFragment;

function isSqlQuery(value: unknown): value is SqlQuery {
    return !!value && typeof value === 'object' && (value as SqlQuery).kind === 'sql';
}

function isIdentifier(value: unknown): value is SqlIdentifier {
    return !!value && typeof value === 'object' && (value as SqlIdentifier).kind === 'identifier';
}

function isTrustedRaw(value: unknown): value is SqlTrustedRaw {
    return !!value && typeof value === 'object' && (value as SqlTrustedRaw).kind === 'rawTrusted';
}

function makeQuery(chunks: string[], values: unknown[]): SqlQuery {
    return Object.freeze({
        kind: 'sql' as const,
        chunks: Object.freeze(chunks),
        values: Object.freeze(values)
    });
}

function sqlTag(strings: TemplateStringsArray, ...values: SqlTemplateValue[]): SqlQuery {
    const chunks = [strings[0] ?? ''];
    const bindings: unknown[] = [];

    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        const nextChunk = strings[i + 1] ?? '';

        if (isSqlQuery(value)) {
            chunks[chunks.length - 1] += value.chunks[0] ?? '';
            for (let j = 0; j < value.values.length; j++) {
                bindings.push(value.values[j]);
                chunks.push(value.chunks[j + 1] ?? '');
            }
            chunks[chunks.length - 1] += nextChunk;
        } else if (isIdentifier(value) || isTrustedRaw(value)) {
            bindings.push(value);
            chunks.push(nextChunk);
        } else {
            bindings.push(value);
            chunks.push(nextChunk);
        }
    }

    return makeQuery(chunks, bindings);
}

function join(values: readonly SqlTemplateValue[], separator: SqlQuery = sqlTag`, `): SqlQuery {
    if (!values.length) return makeQuery([''], []);

    let result = sqlTag`${values[0]}`;
    for (const value of values.slice(1)) {
        result = sqlTag`${result}${separator}${value}`;
    }
    return result;
}

function identifier(...names: string[]): SqlIdentifier {
    if (!names.length) throw new Error('sql.identifier() requires at least one name');
    for (const name of names) {
        if (!name || name.includes('\0')) {
            throw new Error(`Invalid SQL identifier segment: ${JSON.stringify(name)}`);
        }
    }
    return Object.freeze({ kind: 'identifier' as const, names: Object.freeze([...names]) });
}

function rawTrusted(text: string): SqlTrustedRaw {
    return Object.freeze({ kind: 'rawTrusted' as const, text });
}

export const sql = Object.assign(sqlTag, {
    join,
    identifier,
    rawTrusted
});

export function createSqlQuery(sqlIn: string, bindings: unknown[] = []): SqlQuery {
    const parts = sqlIn.split('?');
    if (parts.length - 1 !== bindings.length) {
        throw new Error(`Expected ${parts.length - 1} SQL bindings, received ${bindings.length}`);
    }

    return makeQuery(parts, [...bindings]);
}

export function renderSql(input: SqlInput, dialect: Dialect): RenderedSql {
    if (typeof input === 'string') return { sql: input, bindings: [] };

    const bindings: unknown[] = [];
    let text = input.chunks[0] ?? '';

    for (let i = 0; i < input.values.length; i++) {
        const value = input.values[i];

        if (isIdentifier(value)) {
            text += renderIdentifier(value, dialect);
        } else if (isTrustedRaw(value)) {
            text += value.text;
        } else {
            bindings.push(normalizeSqlBindingValue(value));
            text += dialect === 'postgres' ? `$${bindings.length}` : '?';
        }

        text += input.chunks[i + 1] ?? '';
    }

    return { sql: text, bindings };
}

export function normalizeSqlBindingValue(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (!isDateLike(value)) return value;
    const time = value.getTime();
    if (!Number.isFinite(time)) return value;
    return formatSqlDateTimeUtc(value);
}

function isDateLike(value: unknown): value is {
    getTime(): number;
    getUTCFullYear(): number;
    getUTCMonth(): number;
    getUTCDate(): number;
    getUTCHours(): number;
    getUTCMinutes(): number;
    getUTCSeconds(): number;
    getUTCMilliseconds(): number;
} {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
        Object.prototype.toString.call(value) === '[object Date]' &&
        typeof candidate.getTime === 'function' &&
        typeof candidate.getUTCFullYear === 'function' &&
        typeof candidate.getUTCMonth === 'function' &&
        typeof candidate.getUTCDate === 'function' &&
        typeof candidate.getUTCHours === 'function' &&
        typeof candidate.getUTCMinutes === 'function' &&
        typeof candidate.getUTCSeconds === 'function' &&
        typeof candidate.getUTCMilliseconds === 'function'
    );
}

function formatSqlDateTimeUtc(value: {
    getUTCFullYear(): number;
    getUTCMonth(): number;
    getUTCDate(): number;
    getUTCHours(): number;
    getUTCMinutes(): number;
    getUTCSeconds(): number;
    getUTCMilliseconds(): number;
}): string {
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}`;
}

function pad(value: number, size = 2): string {
    return String(value).padStart(size, '0');
}

function renderIdentifier(identifier: SqlIdentifier, dialect: Dialect): string {
    return identifier.names.map(name => quoteIdentifier(name, dialect)).join('.');
}

export function quoteIdentifier(name: string, dialect: Dialect): string {
    if (dialect === 'postgres') return `"${name.replace(/"/g, '""')}"`;
    return `\`${name.replace(/`/g, '``')}\``;
}
