import { ReflectionKind, Type } from '../reflection';

import { sql, SqlFragment, SqlQuery } from './sql';
import type { BaseDatabase } from './database';
import { markEntityClean } from './entity';
import { ColumnMetadata, EntityClass, getEntityMetadata } from './metadata';
import type { DatabaseSession } from './session';
import { deserializeColumnValue, serializeColumnValue } from './values';

type Direction = 'asc' | 'desc';
type DirectionInput = Direction | 'ASC' | 'DESC' | 1 | -1;
export type FilterValue =
    | unknown
    | {
          $in?: unknown[];
          $nin?: unknown[];
          $ne?: unknown;
          $gt?: unknown;
          $gte?: unknown;
          $lt?: unknown;
          $lte?: unknown;
          $like?: unknown;
          $notLike?: unknown;
      };
export type FilterRecord = Record<string, FilterValue>;
export type FilterQuery<T extends object = object> = Partial<Record<keyof T, FilterValue>> & FilterRecord;
export type PatchOperator = { $inc?: number };
export type PatchValue<T> = T | PatchOperator;
export type PatchRecord<T extends object> = Partial<{ [K in keyof T]: PatchValue<T[K]> }> & Record<string, unknown>;
const MYSQL_OFFSET_ONLY_LIMIT = '18446744073709551615';

export interface QueryMutationResult {
    affectedRows: number;
    readonly modified: number;
    primaryKeys: Record<string, unknown>[];
}

export class QueryBuilder<T extends object> {
    private filters: FilterRecord = {};
    private selected?: string[];
    private aggregateSelections: { field: string; fn: 'MAX' }[] = [];
    private order: { field: string; direction: Direction }[] = [];
    private limitValue?: number;
    private offsetValue?: number;

    constructor(
        private db: BaseDatabase,
        private Entity: EntityClass<T>,
        private session?: DatabaseSession
    ) {}

    filter(filter: FilterRecord): this {
        Object.assign(this.filters, filter);
        return this;
    }

    filterField(field: keyof T | string, value: FilterValue): this {
        return this.filter({ [String(field)]: value });
    }

    select(...fields: string[]): this {
        this.selected = fields;
        return this;
    }

    withMax(field: keyof T | string): this {
        this.aggregateSelections.push({ field: String(field), fn: 'MAX' });
        return this;
    }

    orderBy(field: string, direction: DirectionInput = 'asc'): this {
        this.order.push({ field, direction: normalizeDirection(direction) });
        return this;
    }

    sort(field: string | Record<string, DirectionInput>, direction: DirectionInput = 'asc'): this {
        if (typeof field === 'string') return this.orderBy(field, direction);
        for (const [name, value] of Object.entries(field)) this.orderBy(name, value);
        return this;
    }

    limit(limit: number): this {
        this.limitValue = limit;
        return this;
    }

    offset(offset: number): this {
        this.offsetValue = offset;
        return this;
    }

    skip(offset: number): this {
        return this.offset(offset);
    }

    async find(): Promise<T[]> {
        const rows = await this.runRead(() => this.db.rawFind<Record<string, unknown>>(this.toSelectSql(), this.session));
        return rows.map(row => this.hydrate(row));
    }

    async findField<K extends keyof T>(field: K): Promise<T[K][]> {
        const fieldName = String(field);
        const columnName = this.resolveColumnName(fieldName);
        const aggregate = this.aggregateSelections.find(item => item.field === fieldName || this.resolveColumnName(item.field) === columnName);
        const fields = aggregate
            ? [sql`${sql.rawTrusted(aggregate.fn)}(${sql.identifier(columnName)}) AS ${sql.identifier(columnName)}`]
            : [sql.identifier(columnName)];
        const rows = await this.runRead(() =>
            this.db.rawFind<Record<string, unknown>>(this.buildSelectSql(fields, { includeOrderAndPaging: !aggregate }), this.session)
        );
        const column = getEntityMetadata(this.Entity).columns.find(item => item.propertyName === fieldName || item.columnName === columnName);
        return rows.map(row => coerceColumnValue(getRowValue(row, columnName, fieldName), column, this.db.driver.dialect) as T[K]);
    }

    async findOneFieldOrUndefined<K extends keyof T>(field: K): Promise<T[K] | undefined> {
        return this.withTemporaryLimit(1, async () => (await this.findField(field))[0]);
    }

    async findOneField<K extends keyof T>(field: K): Promise<T[K]> {
        const value = await this.findOneFieldOrUndefined(field);
        if (value === undefined) throw new Error('Item not found');
        return value;
    }

    async findOneOrUndefined(): Promise<T | undefined> {
        return this.withTemporaryLimit(1, async () => (await this.find())[0]);
    }

    async findOne(): Promise<T> {
        const entity = await this.findOneOrUndefined();
        if (!entity) throw new Error('Item not found');
        return entity;
    }

    async has(): Promise<boolean> {
        return !!(await this.findOneOrUndefined());
    }

    async count(): Promise<number> {
        const row = await this.runRead(() => this.db.rawFindOne<Record<string, unknown>>(this.toCountSql(), this.session));
        const value = row ? getRowValue(row, 'count', 'count') : 0;
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'number') return value;
        return Number(value ?? 0);
    }

    async patchMany(patch: PatchRecord<T>): Promise<QueryMutationResult> {
        return this.runMutation(async () => {
            const metadata = getEntityMetadata(this.Entity);
            const patchSet = this.renderPatchSet(patch);
            if (!patchSet) return createMutationResult(0, []);

            const primaryKeys = await this.findPrimaryKeys();
            if (!primaryKeys.length) return createMutationResult(0, []);

            const result = await this.db.rawExecute(
                sql`UPDATE ${sql.identifier(metadata.tableName)} SET ${patchSet} WHERE ${renderPrimaryKeyRowsWhere(metadata.primaryKeys, primaryKeys, this.db.driver.dialect)}`,
                this.session
            );

            return createMutationResult(result.affectedRows, primaryKeys);
        });
    }

    async patchOne(patch: PatchRecord<T>): Promise<QueryMutationResult> {
        return this.runMutation(async () => {
            const metadata = getEntityMetadata(this.Entity);
            const primaryKey = this.requirePrimaryKeyFilter('patchOne');
            const patchSet = this.renderPatchSet(patch);
            if (!patchSet) return createMutationResult(0, []);

            const result = await this.db.rawExecute(
                sql`UPDATE ${sql.identifier(metadata.tableName)} SET ${patchSet} WHERE ${this.renderWhere()!}`,
                this.session
            );
            return createMutationResult(result.affectedRows, result.affectedRows ? [primaryKey] : []);
        });
    }

    async deleteMany(): Promise<QueryMutationResult> {
        return this.runMutation(async () => {
            const metadata = getEntityMetadata(this.Entity);
            const primaryKeys = await this.findPrimaryKeys();
            if (!primaryKeys.length) return createMutationResult(0, []);

            const result = await this.db.rawExecute(
                sql`DELETE FROM ${sql.identifier(metadata.tableName)} WHERE ${renderPrimaryKeyRowsWhere(metadata.primaryKeys, primaryKeys, this.db.driver.dialect)}`,
                this.session
            );

            return createMutationResult(result.affectedRows, primaryKeys);
        });
    }

    async deleteOne(): Promise<QueryMutationResult> {
        return this.runMutation(async () => {
            const metadata = getEntityMetadata(this.Entity);
            const primaryKey = this.requirePrimaryKeyFilter('deleteOne');
            const result = await this.db.rawExecute(
                sql`DELETE FROM ${sql.identifier(metadata.tableName)} WHERE ${this.renderWhere()!}`,
                this.session
            );
            return createMutationResult(result.affectedRows, result.affectedRows ? [primaryKey] : []);
        });
    }

    toSelectSql(): SqlQuery {
        const metadata = getEntityMetadata(this.Entity);
        const fields = this.aggregateSelections.length
            ? this.aggregateSelections.map(item => {
                  const columnName = this.resolveColumnName(item.field);
                  return sql`${sql.rawTrusted(item.fn)}(${sql.identifier(columnName)}) AS ${sql.identifier(columnName)}`;
              })
            : this.selected?.length
              ? this.selected.map(field => sql.identifier(this.resolveColumnName(field)))
              : metadata.columns.map(column => sql.identifier(column.columnName));
        return this.buildSelectSql(fields, { includeOrderAndPaging: !this.aggregateSelections.length });
    }

    toCountSql(): SqlQuery {
        return this.buildSelectSql([sql`COUNT(*) AS ${sql.identifier('count')}`], {
            includeOrderAndPaging: false
        });
    }

    private buildSelectSql(fields: SqlFragment[], options: { includeOrderAndPaging: boolean }): SqlQuery {
        const metadata = getEntityMetadata(this.Entity);
        let query = sql`SELECT ${sql.join(fields)} FROM ${sql.identifier(metadata.tableName)}`;
        const where = this.renderWhere();
        if (where) query = sql`${query} WHERE ${where}`;
        if (options.includeOrderAndPaging) {
            if (this.order.length) {
                query = sql`${query} ORDER BY ${sql.join(
                    this.order.map(
                        item => sql`${sql.identifier(this.resolveColumnName(item.field))} ${sql.rawTrusted(item.direction.toUpperCase())}`
                    ),
                    sql`, `
                )}`;
            }
            if (this.limitValue !== undefined) query = sql`${query} LIMIT ${this.limitValue}`;
            else if (this.offsetValue !== undefined && this.db.driver.dialect === 'mysql')
                query = sql`${query} LIMIT ${sql.rawTrusted(MYSQL_OFFSET_ONLY_LIMIT)}`;
            if (this.offsetValue !== undefined) query = sql`${query} OFFSET ${this.offsetValue}`;
        }
        return query;
    }

    private renderWhere(): SqlQuery | undefined {
        return renderFilterRecord(this.filters, field => this.resolveColumn(field), this.db.driver.dialect);
    }

    private async findPrimaryKeys(): Promise<Record<string, unknown>[]> {
        const metadata = getEntityMetadata(this.Entity);
        const rows = await this.db.rawFind<Record<string, unknown>>(
            this.buildSelectSql(
                metadata.primaryKeys.map(column => sql.identifier(column.columnName)),
                { includeOrderAndPaging: true }
            ),
            this.session
        );
        return rows.map(row =>
            Object.fromEntries(
                metadata.primaryKeys.map(column => [
                    column.propertyName,
                    coerceColumnValue(getRowValue(row, column.columnName, column.propertyName), column, this.db.driver.dialect)
                ])
            )
        );
    }

    private hydrate(row: Record<string, unknown>): T {
        const entity = new this.Entity();
        const metadata = getEntityMetadata(this.Entity);
        for (const column of metadata.columns) {
            (entity as Record<string, unknown>)[column.propertyName] = coerceColumnValue(
                getRowValue(row, column.columnName, column.propertyName),
                column,
                this.db.driver.dialect
            );
        }
        markEntityClean(entity);
        if (this.selected === undefined && this.aggregateSelections.length === 0) this.session?.manage(entity);
        return entity;
    }

    private resolveColumnName(field: string): string {
        return this.resolveColumn(field)?.columnName ?? field;
    }

    private resolveColumn(field: string): ColumnMetadata | undefined {
        const metadata = getEntityMetadata(this.Entity);
        return metadata.columns.find(column => column.propertyName === field || column.columnName === field);
    }

    private renderPatchSet(patch: PatchRecord<T>): SqlQuery | undefined {
        const metadata = getEntityMetadata(this.Entity);
        const patchRecord = patch as Record<string, unknown>;
        const patchColumns = metadata.columns.filter(column => Object.hasOwn(patchRecord, column.propertyName));
        const incPatch = isRecord(patchRecord.$inc) ? patchRecord.$inc : undefined;
        const incrementColumns = incPatch
            ? metadata.columns.filter(
                  column => !column.primaryKey && !Object.hasOwn(patchRecord, column.propertyName) && Object.hasOwn(incPatch, column.propertyName)
              )
            : [];
        const updateColumns = [...patchColumns, ...incrementColumns];
        if (!updateColumns.length) return undefined;

        return sql.join(
            updateColumns.map(column => {
                if (incPatch && Object.hasOwn(incPatch, column.propertyName)) {
                    return sql`${sql.identifier(column.columnName)} = ${sql.identifier(column.columnName)} + ${incPatch[column.propertyName]}`;
                }
                return sql`${sql.identifier(column.columnName)} = ${serializeColumnValue(column, patchRecord[column.propertyName], this.db.driver.dialect)}`;
            }),
            sql`, `
        );
    }

    private requirePrimaryKeyFilter(operation: 'patchOne' | 'deleteOne'): Record<string, unknown> {
        const metadata = getEntityMetadata(this.Entity);
        const result: Record<string, unknown> = {};

        for (const primaryKey of metadata.primaryKeys) {
            const filterKey = Object.hasOwn(this.filters, primaryKey.propertyName)
                ? primaryKey.propertyName
                : Object.hasOwn(this.filters, primaryKey.columnName)
                  ? primaryKey.columnName
                  : undefined;
            const value = filterKey === undefined ? undefined : this.filters[filterKey];
            if (filterKey === undefined || value === null || value === undefined || isFilterOperator(value)) {
                throw new Error(`${operation} requires an exact filter for primary key ${metadata.classType.name}.${primaryKey.propertyName}`);
            }
            result[primaryKey.propertyName] = value;
        }

        return result;
    }

    private async withTemporaryLimit<R>(limit: number, worker: () => Promise<R>): Promise<R> {
        const previousLimit = this.limitValue;
        this.limitValue = limit;
        try {
            return await worker();
        } finally {
            this.limitValue = previousLimit;
        }
    }

    private runMutation<R>(worker: () => Promise<R>): Promise<R> {
        return this.session ? this.session.trackOperation(worker) : worker();
    }

    private runRead<R>(worker: () => Promise<R>): Promise<R> {
        return this.session ? this.session.withoutAutoFlush(worker) : worker();
    }
}

function createMutationResult(affectedRows: number, primaryKeys: Record<string, unknown>[]): QueryMutationResult {
    const result = { affectedRows, primaryKeys } as QueryMutationResult;
    Object.defineProperty(result, 'modified', {
        enumerable: false,
        value: affectedRows
    });
    return result;
}

function normalizeDirection(direction: DirectionInput): Direction {
    if (direction === -1) return 'desc';
    if (direction === 1) return 'asc';
    return direction.toLowerCase() === 'desc' ? 'desc' : 'asc';
}

function renderPrimaryKeyRowsWhere(primaryKeys: ColumnMetadata[], rows: Record<string, unknown>[], dialect: 'postgres' | 'mysql'): SqlQuery {
    if (primaryKeys.length === 1) {
        const primaryKey = primaryKeys[0];
        return sql`${sql.identifier(primaryKey.columnName)} IN (${sql.join(rows.map(row => sql`${serializeColumnValue(primaryKey, row[primaryKey.propertyName], dialect)}`))})`;
    }

    return sql.join(
        rows.map(
            row =>
                sql`(${sql.join(
                    primaryKeys.map(
                        primaryKey =>
                            sql`${sql.identifier(primaryKey.columnName)} = ${serializeColumnValue(primaryKey, row[primaryKey.propertyName], dialect)}`
                    ),
                    sql` AND `
                )})`
        ),
        sql` OR `
    );
}

function getRowValue(row: Record<string, unknown>, columnName: string, propertyName: string): unknown {
    if (Object.hasOwn(row, columnName)) return row[columnName];
    return row[propertyName];
}

function coerceColumnValue(value: unknown, column: ColumnMetadata | undefined, dialect: 'postgres' | 'mysql'): unknown {
    if (!column) return value;
    if (value === null) return null;
    if (value === undefined) return value;
    value = deserializeColumnValue(column, value, dialect);
    if (isBooleanColumn(column)) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'bigint') return value !== 0n;
        if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
    }
    if (isBigIntType(column.type)) {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
        if (typeof value === 'string' && value.trim() !== '') {
            try {
                return BigInt(value);
            } catch {
                return value;
            }
        }
    }
    if (isNumberType(column.type) && typeof value === 'string' && value.trim() !== '') {
        const numberValue = Number(value);
        if (Number.isFinite(numberValue)) return numberValue;
    }
    return value;
}

function isBooleanColumn(column: ColumnMetadata): boolean {
    return typeof column.defaultValue === 'boolean' || isBooleanType(column.type);
}

function isBooleanType(type: Type): boolean {
    if (type.kind === ReflectionKind.boolean) return true;
    if ((type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) && 'types' in type) {
        return type.types.some(child => isBooleanType(child));
    }
    return false;
}

function isNumberType(type: Type): boolean {
    if (type.kind === ReflectionKind.number) return true;
    if ((type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) && 'types' in type) {
        return type.types.some(child => isNumberType(child));
    }
    return false;
}

function isBigIntType(type: Type): boolean {
    if (type.kind === ReflectionKind.bigint) return true;
    if ((type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) && 'types' in type) {
        return type.types.some(child => isBigIntType(child));
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFilterOperator(value: FilterValue): boolean {
    return isRecord(value) && Object.keys(value).some(key => key.startsWith('$'));
}

function renderFilter(field: string, value: FilterValue, column: ColumnMetadata | undefined, dialect: 'postgres' | 'mysql'): SqlQuery {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const op = value as {
            $in?: unknown[];
            $nin?: unknown[];
            $ne?: unknown;
            $gt?: unknown;
            $gte?: unknown;
            $lt?: unknown;
            $lte?: unknown;
        };
        const clauses: SqlQuery[] = [];
        if ('$in' in op) {
            const values = op.$in ?? [];
            clauses.push(
                values.length
                    ? sql`${sql.identifier(field)} IN (${sql.join(values.map(v => sql`${serializeColumnValue(column, v, dialect)}`))})`
                    : sql`1 = 0`
            );
        }
        if ('$nin' in op) {
            const values = op.$nin ?? [];
            const nonNullValues = values.filter(value => value !== null && value !== undefined);
            if (!nonNullValues.length) clauses.push(sql`${sql.identifier(field)} IS NOT NULL`);
            else if (nonNullValues.length === values.length) {
                clauses.push(
                    sql`${sql.identifier(field)} NOT IN (${sql.join(nonNullValues.map(v => sql`${serializeColumnValue(column, v, dialect)}`))})`
                );
            } else {
                clauses.push(
                    sql`${sql.identifier(field)} IS NOT NULL AND ${sql.identifier(field)} NOT IN (${sql.join(nonNullValues.map(v => sql`${serializeColumnValue(column, v, dialect)}`))})`
                );
            }
        }
        if ('$ne' in op)
            clauses.push(
                op.$ne === null
                    ? sql`${sql.identifier(field)} IS NOT NULL`
                    : sql`${sql.identifier(field)} <> ${serializeColumnValue(column, op.$ne, dialect)}`
            );
        if ('$gt' in op) clauses.push(sql`${sql.identifier(field)} > ${serializeColumnValue(column, op.$gt, dialect)}`);
        if ('$gte' in op) clauses.push(sql`${sql.identifier(field)} >= ${serializeColumnValue(column, op.$gte, dialect)}`);
        if ('$lt' in op) clauses.push(sql`${sql.identifier(field)} < ${serializeColumnValue(column, op.$lt, dialect)}`);
        if ('$lte' in op) clauses.push(sql`${sql.identifier(field)} <= ${serializeColumnValue(column, op.$lte, dialect)}`);
        if ('$like' in op) clauses.push(sql`${sql.identifier(field)} LIKE ${serializeColumnValue(column, op.$like, dialect)}`);
        if ('$notLike' in op) clauses.push(sql`${sql.identifier(field)} NOT LIKE ${serializeColumnValue(column, op.$notLike, dialect)}`);
        if (clauses.length) return sql.join(clauses, sql` AND `);
    }
    if (value === null || value === undefined) return sql`${sql.identifier(field)} IS NULL`;
    return sql`${sql.identifier(field)} = ${serializeColumnValue(column, value, dialect)}`;
}

function renderFilterRecord(
    filters: FilterRecord,
    resolveColumn: (field: string) => ColumnMetadata | undefined,
    dialect: 'postgres' | 'mysql'
): SqlQuery | undefined {
    const clauses: SqlQuery[] = [];
    for (const [field, value] of Object.entries(filters)) {
        if (field === '$and' || field === '$or') {
            const children = Array.isArray(value) ? value : [];
            const rendered = children
                .map(child => renderFilterRecord(child as FilterRecord, resolveColumn, dialect))
                .filter((child): child is SqlQuery => child !== undefined);
            if (rendered.length) clauses.push(sql`(${sql.join(rendered, field === '$and' ? sql` AND ` : sql` OR `)})`);
            else if (field === '$or') clauses.push(sql`1 = 0`);
            continue;
        }

        const column = resolveColumn(field);
        clauses.push(renderFilter(column?.columnName ?? field, value, column, dialect));
    }
    return clauses.length ? sql.join(clauses, sql` AND `) : undefined;
}
