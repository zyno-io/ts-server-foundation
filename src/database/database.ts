import { AsyncLocalStorage } from 'node:async_hooks';

import { deserialize, isReflectedType, type ReceiveType, type Type } from '../reflection';

import { createSqlQuery, renderSql, RenderedSql, SqlInput, sql, type Dialect } from './sql';
import { BaseEntity, bindEntityDatabase, getDirtyDetails, getEntityFields, hasEntitySnapshot, markEntityClean } from './entity';
import type { DatabaseDriver, DriverConnection, ExecuteResult } from './driver';
import { Env } from '../env';
import { normalizeDatabaseError } from './errors';
import { ColumnMetadata, EntityClass, getEntityMetadata, type EntityMetadata } from './metadata';
import { QueryBuilder } from './query';
import { DatabaseSchemaBuilder } from './schema';
import { DatabaseSession } from './session';
import { serializeColumnValue } from './values';

export type MutexKey = any;

export interface BaseDatabaseOptions {
    enableLocksTable?: boolean;
    lockTableName?: string;
}

export interface DatabaseQueryObservation {
    id: string;
    phase: 'start' | 'finish';
    db: BaseDatabase;
    sql: string;
    bindings: unknown[];
    dialect: Dialect;
    operation: 'query' | 'execute';
    startedAt: number;
    durationMs: number;
    error?: unknown;
}

export type DatabaseQueryObserver = (entry: DatabaseQueryObservation) => void;

const databaseQueryObservers = new Set<DatabaseQueryObserver>();
let databaseQueryObservationId = 1;
const mysqlLocksTableInit = new WeakMap<BaseDatabase, Promise<void>>();
const mysqlLocksTableInitByName = new Map<string, Promise<void>>();
const databaseConnectionScope = new AsyncLocalStorage<Map<BaseDatabase, DriverConnection>>();

export function registerDatabaseQueryObserver(observer: DatabaseQueryObserver): () => void {
    databaseQueryObservers.add(observer);
    return () => databaseQueryObservers.delete(observer);
}

export class BaseDatabase {
    readonly entityRegistry: EntityClass[];
    readonly options: Required<BaseDatabaseOptions>;
    readonly schema: DatabaseSchemaBuilder;

    constructor(
        readonly driver: DatabaseDriver,
        entities: EntityClass[] = [],
        options: BaseDatabaseOptions = {}
    ) {
        assertBaseEntityClasses(entities);
        this.entityRegistry = entities;
        this.options = {
            enableLocksTable: options.enableLocksTable ?? false,
            lockTableName: options.lockTableName ?? '_locks'
        };
        this.schema = new DatabaseSchemaBuilder(this);
        for (const entity of entities) bindEntityDatabase(entity, this);
    }

    query<T extends object>(Entity: EntityClass<T>, session?: DatabaseSession): QueryBuilder<T> {
        return new QueryBuilder(this, Entity, session);
    }

    async transaction<T>(worker: (session: DatabaseSession) => Promise<T>): Promise<T> {
        const connection = await this.driver.acquire();
        const session = new DatabaseSession(this, connection, { transactional: true });
        let transactionStarted = false;
        let committed = false;
        try {
            await connection.begin();
            transactionStarted = true;
            const result = await worker(session);
            await session.waitForPendingOperations();
            await session.flush();
            await session.runPreCommitHooks();
            await session.waitForPendingOperations();
            await session.flush();
            await connection.commit();
            committed = true;
            await session.runPostCommitHooks();
            return result;
        } catch (error) {
            const normalizedError = normalizeDatabaseError(error);
            if (transactionStarted && !committed) await connection.rollback();
            throw normalizedError;
        } finally {
            await connection.release();
        }
    }

    async withTransaction<T>(session: DatabaseSession | undefined, worker: (session: DatabaseSession) => Promise<T>): Promise<T> {
        return session ? worker(session) : this.transaction(worker);
    }

    async withConnection<T>(worker: (db: this) => Promise<T> | T): Promise<T> {
        const existingConnection = getScopedConnection(this);
        if (existingConnection) return worker(this);

        const connection = await this.driver.acquire();
        const parentScope = databaseConnectionScope.getStore();
        const scope = new Map(parentScope);
        scope.set(this, connection);
        try {
            return await databaseConnectionScope.run(scope, () => worker(this));
        } finally {
            await connection.release();
        }
    }

    async rawQuery<T = Record<string, unknown>>(input: SqlInput, session?: DatabaseSession): Promise<T[]> {
        if (session?.shouldAutoFlush) await session.flush();
        const rendered = renderSql(input, this.driver.dialect);
        const sessionConnection = session?.getConnection();
        const scopedConnection = getScopedConnection(this);
        const connection = sessionConnection ?? scopedConnection ?? (await this.driver.acquire());
        const observationId = createDatabaseQueryObservationId();
        const startedAt = Date.now();
        let observedError: unknown;
        notifyDatabaseQueryObservers(this, rendered, 'query', observationId, 'start', startedAt);
        try {
            let rows: T[] = [];
            for (const query of splitRenderedSql(rendered, this.driver.dialect)) {
                const result = await connection.query<T>(query);
                rows = result.rows;
            }
            return rows;
        } catch (error) {
            observedError = normalizeDatabaseError(error);
            throw observedError;
        } finally {
            notifyDatabaseQueryObservers(this, rendered, 'query', observationId, 'finish', startedAt, observedError);
            if (!sessionConnection && !scopedConnection) await connection.release();
        }
    }

    async rawFind<T = Record<string, unknown>>(input: SqlInput, session?: DatabaseSession): Promise<T[]> {
        return this.rawQuery<T>(input, session);
    }

    async rawFindTyped<T>(input: SqlInput, session: DatabaseSession | undefined, type: Type): Promise<T[]> {
        const rows = await this.rawQuery<Record<string, unknown>>(input, session);
        return rows.map(row => deserialize<T>(row, type));
    }

    async rawFindOne<T = Record<string, unknown>>(input: SqlInput, session?: DatabaseSession): Promise<T | undefined> {
        return (await this.rawFind<T>(input, session))[0];
    }

    createSqlQuery(text: string, bindings: unknown[] = []) {
        return createSqlQuery(text, bindings);
    }

    async rawExecute(input: SqlInput, session?: DatabaseSession): Promise<ExecuteResult> {
        if (session?.shouldAutoFlush) await session.flush();
        const rendered = renderSql(input, this.driver.dialect);
        const sessionConnection = session?.getConnection();
        const scopedConnection = getScopedConnection(this);
        const connection = sessionConnection ?? scopedConnection ?? (await this.driver.acquire());
        const observationId = createDatabaseQueryObservationId();
        const startedAt = Date.now();
        let observedError: unknown;
        notifyDatabaseQueryObservers(this, rendered, 'execute', observationId, 'start', startedAt);
        try {
            let aggregate: ExecuteResult | undefined;
            for (const query of splitRenderedSql(rendered, this.driver.dialect)) {
                const result = await connection.execute(query);
                if (aggregate) {
                    const next: ExecuteResult = {
                        affectedRows: aggregate.affectedRows + result.affectedRows,
                        rowCount: (aggregate.rowCount ?? aggregate.affectedRows) + (result.rowCount ?? result.affectedRows)
                    };
                    const insertId = result.insertId ?? aggregate.insertId;
                    const warningStatus = result.warningStatus ?? aggregate.warningStatus;
                    if (insertId !== undefined) next.insertId = insertId;
                    if (warningStatus !== undefined) next.warningStatus = warningStatus;
                    aggregate = next;
                } else {
                    aggregate = result;
                }
            }
            return aggregate ?? { affectedRows: 0, rowCount: 0 };
        } catch (error) {
            observedError = normalizeDatabaseError(error);
            throw observedError;
        } finally {
            notifyDatabaseQueryObservers(this, rendered, 'execute', observationId, 'finish', startedAt, observedError);
            if (!sessionConnection && !scopedConnection) await connection.release();
        }
    }

    async rawFindUnsafe<T = Record<string, unknown>>(
        text: string,
        bindings: unknown[] = [],
        session?: DatabaseSession,
        type?: ReceiveType<T>
    ): Promise<T[]> {
        const query = createUnsafeQuery(text, bindings);
        const resolvedType = resolveRawReceiveType(type);
        return resolvedType ? this.rawFindTyped<T>(query, session, resolvedType) : this.rawFind<T>(query, session);
    }

    async rawFindOneUnsafe<T = Record<string, unknown>>(
        text: string,
        bindings: unknown[] = [],
        session?: DatabaseSession,
        type?: ReceiveType<T>
    ): Promise<T | undefined> {
        return (await this.rawFindUnsafe<T>(text, bindings, session, type))[0];
    }

    async rawExecuteUnsafe(text: string, bindings: unknown[] = [], session?: DatabaseSession, _type?: unknown): Promise<ExecuteResult> {
        return this.rawExecute(createUnsafeQuery(text, bindings), session);
    }

    async acquireSessionLock(key: MutexKey | MutexKey[], session: DatabaseSession): Promise<void> {
        if (!session.isTransactional) throw new Error('Session locks require an active transaction');

        const lockKey = flattenMutexKey(key);
        if (this.driver.dialect === 'postgres') {
            const { high, low } = hashLockKey(lockKey);
            await this.rawExecute(sql`SELECT pg_advisory_xact_lock(${high}, ${low})`, session);
            return;
        }

        await ensureMySQLLocksTable(this);

        const table = this.options.lockTableName;
        await this.rawExecute(sql`INSERT IGNORE INTO ${sql.identifier(table)} (${sql.identifier('key')}) VALUES (${lockKey})`);
        await this.rawExecute(
            sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier('lastTouched')} = ${sql.rawTrusted('NOW()')} WHERE ${sql.identifier('key')} = ${lockKey}`,
            session
        );
    }

    async persist(entity: object, session?: DatabaseSession): Promise<void> {
        await this.saveEntity(entity, session);
    }

    async saveEntity(entity: object, session?: DatabaseSession): Promise<void> {
        const metadata = getEntityMetadata(entity.constructor as EntityClass);
        const fields = getEntityFields(entity);
        const pk = metadata.primaryKey.propertyName;
        const pkValue = fields[pk];
        const isNewEntity = !hasEntitySnapshot(entity);

        if (isNewEntity && (!metadata.primaryKey.autoIncrement || isAutoIncrementSentinel(pkValue))) {
            for (const primaryKey of metadata.primaryKeys) {
                const value = fields[primaryKey.propertyName];
                if (!primaryKey.autoIncrement && (value === undefined || value === null)) {
                    throw new Error(`Cannot insert ${metadata.classType.name} without primary key ${primaryKey.propertyName}`);
                }
            }

            const insertColumns = metadata.columns.filter(column => {
                if (column.primaryKey && column.autoIncrement && isAutoIncrementSentinel(pkValue)) return false;
                return !(column.hasDefault && fields[column.propertyName] === undefined);
            });
            const insertQuery = insertColumns.length
                ? sql`INSERT INTO ${sql.identifier(metadata.tableName)} (${sql.join(insertColumns.map(column => sql.identifier(column.columnName)))}) VALUES (${sql.join(
                      insertColumns.map(column => sql`${serializeColumnValue(column, fields[column.propertyName], this.driver.dialect)}`)
                  )})`
                : this.driver.dialect === 'postgres'
                  ? sql`INSERT INTO ${sql.identifier(metadata.tableName)} DEFAULT VALUES`
                  : sql`INSERT INTO ${sql.identifier(metadata.tableName)} () VALUES ()`;

            if (metadata.primaryKey.autoIncrement && this.driver.dialect === 'postgres') {
                const row = await this.rawFindOne<Record<string, unknown>>(
                    sql`${insertQuery} RETURNING ${sql.identifier(metadata.primaryKey.columnName)}`,
                    session
                );
                const insertId = row?.[metadata.primaryKey.columnName] ?? row?.[pk];
                if (insertId !== undefined) (entity as unknown as Record<string, unknown>)[pk] = insertId;
            } else {
                const result = await this.rawExecute(insertQuery, session);
                if (metadata.primaryKey.autoIncrement && result.insertId !== undefined)
                    (entity as unknown as Record<string, unknown>)[pk] = result.insertId;
            }
        } else {
            assertPrimaryKeyValues(metadata, fields, 'update');

            const dirtyDetails = getDirtyDetails(entity);
            const dirty = metadata.columns.filter(column => !column.primaryKey && Object.hasOwn(dirtyDetails, column.propertyName));
            if (dirty.length) {
                await this.rawExecute(
                    sql`UPDATE ${sql.identifier(metadata.tableName)} SET ${sql.join(
                        dirty.map(
                            column =>
                                sql`${sql.identifier(column.columnName)} = ${serializeColumnValue(column, dirtyDetails[column.propertyName].current, this.driver.dialect)}`
                        ),
                        sql`, `
                    )} WHERE ${renderPrimaryKeyWhere(metadata.primaryKeys, fields, this.driver.dialect)}`,
                    session
                );
            }
        }

        markEntityClean(entity);
        session?.removeQueued(entity);
    }

    async deleteEntity(entity: object, session?: DatabaseSession): Promise<void> {
        const metadata = getEntityMetadata(entity.constructor as EntityClass);
        const fields = entity as unknown as Record<string, unknown>;
        assertPrimaryKeyValues(metadata, fields, 'delete');
        await this.rawExecute(
            sql`DELETE FROM ${sql.identifier(metadata.tableName)} WHERE ${renderPrimaryKeyWhere(metadata.primaryKeys, fields, this.driver.dialect)}`,
            session
        );
    }
}

function assertBaseEntityClasses(entities: readonly EntityClass[]): void {
    for (const entity of entities) {
        if (isBaseEntityClass(entity)) continue;
        throw new Error(`Database entity ${getEntityClassName(entity)} must extend BaseEntity`);
    }
}

function isBaseEntityClass(entity: unknown): boolean {
    return typeof entity === 'function' && entity.prototype instanceof BaseEntity;
}

function getEntityClassName(entity: unknown): string {
    return typeof entity === 'function' && entity.name ? entity.name : '<anonymous>';
}

function getScopedConnection(db: BaseDatabase): DriverConnection | undefined {
    return databaseConnectionScope.getStore()?.get(db);
}

export async function ensureMySQLLocksTable(db: BaseDatabase): Promise<void> {
    if (db.driver.dialect !== 'mysql' || !db.options.enableLocksTable) return;

    const existing = mysqlLocksTableInit.get(db);
    if (existing) return existing;

    const cacheKey = getMySQLLocksTableCacheKey(db);
    const existingByName = cacheKey ? mysqlLocksTableInitByName.get(cacheKey) : undefined;
    if (existingByName) {
        mysqlLocksTableInit.set(db, existingByName);
        return existingByName;
    }

    const init = (async () => {
        const table = db.options.lockTableName;
        const databaseName = readCurrentMySQLDatabaseName();
        if (databaseName && (await mysqlLocksTableExists(db, databaseName, table))) return;

        await db.rawExecute(
            sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(table)} (${sql.identifier('key')} VARCHAR(255) NOT NULL PRIMARY KEY, ${sql.identifier('createdAt')} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ${sql.identifier('lastTouched')} DATETIME)`
        );
        await db.rawExecute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier('lastTouched')} < ${sql.rawTrusted('NOW() - INTERVAL 1 HOUR')}`
        );
    })();

    mysqlLocksTableInit.set(db, init);
    if (cacheKey) mysqlLocksTableInitByName.set(cacheKey, init);
    try {
        await init;
    } catch (error) {
        mysqlLocksTableInit.delete(db);
        if (cacheKey && mysqlLocksTableInitByName.get(cacheKey) === init) mysqlLocksTableInitByName.delete(cacheKey);
        throw error;
    }
}

function getMySQLLocksTableCacheKey(db: BaseDatabase): string | undefined {
    const databaseName = readCurrentMySQLDatabaseName();
    return databaseName ? `${databaseName}:${db.options.lockTableName}` : undefined;
}

function readCurrentMySQLDatabaseName(): string | undefined {
    return Env.TSF_TEST_MYSQL_SESSION_DATABASE ?? Env.TSF_TEST_DATABASE_NAME;
}

async function mysqlLocksTableExists(db: BaseDatabase, databaseName: string, table: string): Promise<boolean> {
    const rows = await db.rawFind<{ found: number }>(
        sql`SELECT 1 AS ${sql.identifier('found')} FROM ${sql.identifier('information_schema')}.${sql.identifier('tables')} WHERE ${sql.identifier('table_schema')} = ${databaseName} AND ${sql.identifier('table_name')} = ${table} LIMIT 1`
    );
    return rows.length > 0;
}

function assertPrimaryKeyValues(metadata: EntityMetadata, fields: Record<string, unknown>, action: 'update' | 'delete'): void {
    for (const primaryKey of metadata.primaryKeys) {
        const value = fields[primaryKey.propertyName];
        if (value === undefined || value === null) {
            throw new Error(`Cannot ${action} ${metadata.classType.name} without primary key ${primaryKey.propertyName}`);
        }
    }
}

function renderPrimaryKeyWhere(primaryKeys: ColumnMetadata[], fields: Record<string, unknown>, dialect: Dialect): ReturnType<typeof sql> {
    return sql.join(
        primaryKeys.map(column => sql`${sql.identifier(column.columnName)} = ${serializeColumnValue(column, fields[column.propertyName], dialect)}`),
        sql` AND `
    );
}

function notifyDatabaseQueryObservers(
    db: BaseDatabase,
    rendered: RenderedSql,
    operation: DatabaseQueryObservation['operation'],
    id: string,
    phase: DatabaseQueryObservation['phase'],
    startedAt: number,
    error?: unknown
): void {
    if (!databaseQueryObservers.size) return;
    const entry: DatabaseQueryObservation = {
        id,
        phase,
        db,
        sql: rendered.sql,
        bindings: rendered.bindings,
        dialect: db.driver.dialect,
        operation,
        startedAt,
        durationMs: phase === 'finish' ? Date.now() - startedAt : 0,
        error
    };
    for (const observer of databaseQueryObservers) {
        try {
            observer(entry);
        } catch {
            // Observers must never affect database operations.
        }
    }
}

function createDatabaseQueryObservationId(): string {
    return `dbq-${databaseQueryObservationId++}`;
}

function createUnsafeQuery(text: string, bindings: unknown[]) {
    return createSqlQuery(text, bindings);
}

function resolveRawReceiveType<T>(type: ReceiveType<T> | undefined): Type | undefined {
    return isReflectedType(type) ? type : undefined;
}

function splitRenderedSql(rendered: RenderedSql, dialect: Dialect): RenderedSql[] {
    if (rendered.bindings.length) {
        const statements = splitBoundSqlStatements(rendered, dialect);
        return statements.length <= 1 ? [rendered] : statements;
    }
    const statements = splitSqlStatements(rendered.sql);
    if (statements.length <= 1) return [rendered];

    return statements.map(statement => ({ sql: statement, bindings: [] }));
}

interface BoundPlaceholder {
    start: number;
    end: number;
    bindingIndex: number;
}

interface BoundStatement {
    start: number;
    end: number;
    placeholders: BoundPlaceholder[];
}

function splitBoundSqlStatements(rendered: RenderedSql, dialect: Dialect): RenderedSql[] {
    const statements = findBoundSqlStatements(rendered.sql, dialect);
    if (statements.length <= 1) return [rendered];
    return statements.map(statement => renderBoundStatement(rendered.sql, rendered.bindings, statement, dialect));
}

function findBoundSqlStatements(text: string, dialect: Dialect): BoundStatement[] {
    const statements: BoundStatement[] = [];
    let statementStart = 0;
    let quote: "'" | '"' | '`' | undefined;
    let dollarQuote: string | undefined;
    let inLineComment = false;
    let inBlockComment = false;
    let mysqlBindingIndex = 0;
    let currentPlaceholders: BoundPlaceholder[] = [];
    let i = 0;

    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (char === '\n' || char === '\r') inLineComment = false;
            i++;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i += 2;
            } else {
                i++;
            }
            continue;
        }

        if (dollarQuote) {
            if (text.startsWith(dollarQuote, i)) {
                i += dollarQuote.length;
                dollarQuote = undefined;
            } else {
                i++;
            }
            continue;
        }

        if (quote) {
            if ((quote === "'" || quote === '"') && char === '\\') {
                i += 2;
                continue;
            }

            if (char === quote) {
                if (next === quote) {
                    i += 2;
                    continue;
                }
                quote = undefined;
            }
            i++;
            continue;
        }

        if (char === '-' && next === '-') {
            inLineComment = true;
            i += 2;
            continue;
        }

        if (char === '#') {
            inLineComment = true;
            i++;
            continue;
        }

        if (char === '/' && next === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            i++;
            continue;
        }

        if (char === '$') {
            const marker = readDollarQuoteMarker(text, i);
            if (marker) {
                dollarQuote = marker;
                i += marker.length;
                continue;
            }

            if (dialect === 'postgres') {
                const match = /^\$([1-9]\d*)/.exec(text.slice(i));
                if (match) {
                    currentPlaceholders.push({
                        start: i,
                        end: i + match[0].length,
                        bindingIndex: Number(match[1]) - 1
                    });
                    i += match[0].length;
                    continue;
                }
            }
        }

        if (dialect === 'mysql' && char === '?') {
            currentPlaceholders.push({
                start: i,
                end: i + 1,
                bindingIndex: mysqlBindingIndex++
            });
            i++;
            continue;
        }

        if (char === ';') {
            const start = trimStartIndex(text, statementStart, i);
            const end = trimEndIndex(text, statementStart, i);
            if (start < end) {
                statements.push({
                    start,
                    end,
                    placeholders: currentPlaceholders.filter(placeholder => placeholder.start >= start && placeholder.end <= end)
                });
            }
            statementStart = i + 1;
            currentPlaceholders = [];
        }

        i++;
    }

    const start = trimStartIndex(text, statementStart, text.length);
    const end = trimEndIndex(text, statementStart, text.length);
    if (start < end) {
        statements.push({
            start,
            end,
            placeholders: currentPlaceholders.filter(placeholder => placeholder.start >= start && placeholder.end <= end)
        });
    }
    return statements;
}

function renderBoundStatement(text: string, bindings: unknown[], statement: BoundStatement, dialect: Dialect): RenderedSql {
    if (dialect === 'mysql') {
        return {
            sql: text.slice(statement.start, statement.end),
            bindings: statement.placeholders.map(placeholder => bindings[placeholder.bindingIndex])
        };
    }

    const statementBindings: unknown[] = [];
    const placeholderMap = new Map<number, number>();
    let sqlText = '';
    let cursor = statement.start;

    for (const placeholder of statement.placeholders) {
        sqlText += text.slice(cursor, placeholder.start);
        let mapped = placeholderMap.get(placeholder.bindingIndex);
        if (mapped === undefined) {
            statementBindings.push(bindings[placeholder.bindingIndex]);
            mapped = statementBindings.length;
            placeholderMap.set(placeholder.bindingIndex, mapped);
        }
        sqlText += `$${mapped}`;
        cursor = placeholder.end;
    }

    sqlText += text.slice(cursor, statement.end);
    return {
        sql: sqlText,
        bindings: statementBindings
    };
}

function splitSqlStatements(text: string): string[] {
    const statements: string[] = [];
    let statementStart = 0;
    let quote: "'" | '"' | '`' | undefined;
    let dollarQuote: string | undefined;
    let inLineComment = false;
    let inBlockComment = false;
    let i = 0;

    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (char === '\n' || char === '\r') inLineComment = false;
            i++;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i += 2;
            } else {
                i++;
            }
            continue;
        }

        if (dollarQuote) {
            if (text.startsWith(dollarQuote, i)) {
                i += dollarQuote.length;
                dollarQuote = undefined;
            } else {
                i++;
            }
            continue;
        }

        if (quote) {
            if ((quote === "'" || quote === '"') && char === '\\') {
                i += 2;
                continue;
            }

            if (char === quote) {
                if (next === quote) {
                    i += 2;
                    continue;
                }
                quote = undefined;
            }
            i++;
            continue;
        }

        if (char === '-' && next === '-') {
            inLineComment = true;
            i += 2;
            continue;
        }

        if (char === '#') {
            inLineComment = true;
            i++;
            continue;
        }

        if (char === '/' && next === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            i++;
            continue;
        }

        if (char === '$') {
            const marker = readDollarQuoteMarker(text, i);
            if (marker) {
                dollarQuote = marker;
                i += marker.length;
                continue;
            }
        }

        if (char === ';') {
            const statement = text.slice(statementStart, i).trim();
            if (statement) statements.push(statement);
            statementStart = i + 1;
        }

        i++;
    }

    const statement = text.slice(statementStart).trim();
    if (statement) statements.push(statement);
    return statements;
}

function readDollarQuoteMarker(text: string, start: number): string | undefined {
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(start));
    return match?.[0];
}

function trimStartIndex(text: string, start: number, end: number): number {
    while (start < end && /\s/.test(text[start])) start++;
    return start;
}

function trimEndIndex(text: string, start: number, end: number): number {
    while (end > start && /\s/.test(text[end - 1])) end--;
    return end;
}

function isAutoIncrementSentinel(value: unknown): boolean {
    return value === undefined || value === null || value === 0;
}

export function flattenMutexKey(key: MutexKey | MutexKey[]): string {
    const parts = Array.isArray(key) ? key : [key];
    return parts
        .map(part => {
            if (part === null) return 'null';
            if (typeof part === 'bigint') return part.toString();
            if (typeof part === 'function') return part.name || 'anonymous';
            if (typeof part === 'object') {
                if (typeof part.toString === 'function' && part.toString !== Object.prototype.toString) return part.toString();
                if (part.constructor?.name && part.constructor.name !== 'Object') return part.constructor.name;
                return JSON.stringify(part);
            }
            return String(part);
        })
        .join(':');
}

export function logSql(text: string, bindings: unknown[] = []): void {
    const remainingBindings = [...bindings];
    console.log(text.replace(/\?/g, () => JSON.stringify(remainingBindings.shift())));
}

function hashLockKey(key: string): { high: number; low: number } {
    let high = 0x811c9dc5;
    let low = 0x01000193;

    for (let i = 0; i < key.length; i++) {
        const char = key.charCodeAt(i);
        high ^= char;
        high = Math.imul(high, 0x01000193);
        low ^= char + i;
        low = Math.imul(low, 0x811c9dc5);
    }

    return { high: toSignedInt32(high), low: toSignedInt32(low) };
}

function toSignedInt32(value: number): number {
    return value | 0;
}
