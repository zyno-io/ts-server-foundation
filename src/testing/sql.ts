import { mock } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { BaseDatabase } from '../database/database';
import type { DatabaseDriver, DriverConnection } from '../database/driver';
import { bindEntityDatabase, createEntity, getEntityFields, markEntityClean, type EntityFields } from '../database/entity';
import { getEntityMetadata, type EntityClass } from '../database/metadata';
import type { FilterRecord, FilterValue, PatchRecord, QueryMutationResult } from '../database/query';
import type { ClassType } from '../types';

const helpers: SqlTestingHelper[] = [];
let sqlMockDatabase: BaseDatabase | undefined;

export class SqlTestingHelper {
    private rows = new Map<ClassType, Record<string, unknown>[]>();

    mockEntity<T extends object>(entityClass: ClassType<T>, data: Partial<EntityFields<T>>[] | Partial<EntityFields<T>>): void {
        const rows = this.rows.get(entityClass) ?? [];
        rows.push(...cloneRows(entityClass, Array.isArray(data) ? data : [data]));
        this.rows.set(entityClass, rows);
        bindEntityDatabase(entityClass as EntityClass, getSqlMockDatabase());
        activateHelper(this);
        installMocks();
    }

    clearMocks(): void {
        this.rows.clear();
    }

    hasMock(entityClass: ClassType): boolean {
        return this.rows.has(entityClass);
    }

    createQuery<T extends object>(entityClass: EntityClass<T>): InMemoryQueryBuilder<T> {
        return new InMemoryQueryBuilder(entityClass, this.rows.get(entityClass) ?? []);
    }
}

class InMemoryQueryBuilder<T extends object> {
    private filters: FilterRecord = {};
    private selected?: string[];
    private order: { field: string; direction: 'asc' | 'desc' }[] = [];
    private limitValue?: number;
    private offsetValue?: number;

    constructor(
        private readonly entityClass: EntityClass<T>,
        private readonly rows: Record<string, unknown>[]
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

    orderBy(field: string, direction: 'asc' | 'desc' | 'ASC' | 'DESC' | 1 | -1 = 'asc'): this {
        this.order.push({ field, direction: normalizeDirection(direction) });
        return this;
    }

    sort(
        field: string | Record<string, 'asc' | 'desc' | 'ASC' | 'DESC' | 1 | -1>,
        direction: 'asc' | 'desc' | 'ASC' | 'DESC' | 1 | -1 = 'asc'
    ): this {
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
        return this.applyQuery().map(row => this.hydrate(row));
    }

    async findField<K extends keyof T>(field: K): Promise<T[K][]> {
        return this.applyQuery().map(row => row[String(field)] as T[K]);
    }

    async findOneFieldOrUndefined<K extends keyof T>(field: K): Promise<T[K] | undefined> {
        return this.limit(1)
            .findField(field)
            .then(rows => rows[0]);
    }

    async findOneField<K extends keyof T>(field: K): Promise<T[K]> {
        const value = await this.findOneFieldOrUndefined(field);
        if (value === undefined) throw new Error('Item not found');
        return value;
    }

    async findOneOrUndefined(): Promise<T | undefined> {
        return (await this.limit(1).find())[0];
    }

    async findOne(): Promise<T> {
        const entity = await this.findOneOrUndefined();
        if (!entity) throw new Error('Item not found');
        return entity;
    }

    async has(): Promise<boolean> {
        return this.applyQuery().length > 0;
    }

    async count(): Promise<number> {
        return this.applyQuery().length;
    }

    async patchMany(patch: PatchRecord<T>): Promise<QueryMutationResult> {
        const matches = this.applyQuery();
        for (const row of matches) this.applyPatch(row, patch);
        return createMutationResult(matches.length);
    }

    async patchOne(patch: PatchRecord<T>): Promise<QueryMutationResult> {
        const primaryKey = this.requirePrimaryKeyFilter('patchOne');
        const match = this.rows.find(row => matchesFilter(row, this.filters));
        if (!match) return createMutationResult(0);
        this.applyPatch(match, patch);
        return createMutationResult(1, [primaryKey]);
    }

    async deleteMany(): Promise<QueryMutationResult> {
        const matches = this.applyQuery();
        for (const row of matches) this.rows.splice(this.rows.indexOf(row), 1);
        return createMutationResult(matches.length);
    }

    async deleteOne(): Promise<QueryMutationResult> {
        const primaryKey = this.requirePrimaryKeyFilter('deleteOne');
        const index = this.rows.findIndex(row => matchesFilter(row, this.filters));
        if (index === -1) return createMutationResult(0);
        this.rows.splice(index, 1);
        return createMutationResult(1, [primaryKey]);
    }

    private applyPatch(row: Record<string, unknown>, patch: PatchRecord<T>): void {
        for (const [key, value] of Object.entries(patch)) {
            if (key === '$inc' || value === undefined) continue;
            row[key] = value;
        }
        if (isRecord(patch.$inc)) {
            for (const [key, value] of Object.entries(patch.$inc)) {
                row[key] = Number(row[key] ?? 0) + Number(value);
            }
        }
    }

    private requirePrimaryKeyFilter(operation: 'patchOne' | 'deleteOne'): Record<string, unknown> {
        const metadata = getEntityMetadata(this.entityClass);
        const result: Record<string, unknown> = {};

        for (const primaryKey of metadata.primaryKeys) {
            const filterKey = Object.hasOwn(this.filters, primaryKey.propertyName)
                ? primaryKey.propertyName
                : Object.hasOwn(this.filters, primaryKey.columnName)
                  ? primaryKey.columnName
                  : undefined;
            const value = filterKey === undefined ? undefined : this.filters[filterKey];
            if (filterKey === undefined || value === null || value === undefined || isOperatorRecord(value)) {
                throw new Error(`${operation} requires an exact filter for primary key ${metadata.classType.name}.${primaryKey.propertyName}`);
            }
            result[primaryKey.propertyName] = value;
        }

        return result;
    }

    private applyQuery(): Record<string, unknown>[] {
        let result = this.rows.filter(row => matchesFilter(row, this.filters));
        if (this.order.length) {
            result = [...result].sort((a, b) => {
                for (const item of this.order) {
                    const compared = compareValues(a[item.field], b[item.field]);
                    if (compared) return item.direction === 'desc' ? -compared : compared;
                }
                return 0;
            });
        }
        if (this.offsetValue !== undefined) result = result.slice(this.offsetValue);
        if (this.limitValue !== undefined) result = result.slice(0, this.limitValue);
        return result;
    }

    private hydrate(row: Record<string, unknown>): T {
        const source = this.selected?.length ? Object.fromEntries(this.selected.map(field => [field, row[field]])) : row;
        const entity = createEntity(this.entityClass, cloneRecord(source) as Partial<T>);
        markEntityClean(entity);
        return entity;
    }
}

class SqlTestingDriver implements DatabaseDriver {
    readonly dialect = 'mysql' as const;

    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    async acquire(): Promise<DriverConnection> {
        throw new Error('SQL test mocks are not configured for this entity');
    }
}

function getSqlMockDatabase(): BaseDatabase {
    return (sqlMockDatabase ??= new BaseDatabase(new SqlTestingDriver()));
}

function installMocks(): void {
    const descriptor = Object.getOwnPropertyDescriptor(BaseDatabase.prototype, 'query');
    if (descriptor && typeof descriptor.value === 'function' && 'mock' in descriptor.value) return;
    const originalQuery = BaseDatabase.prototype.query;
    mock.method(BaseDatabase.prototype, 'query', function (this: BaseDatabase, Entity: EntityClass, session?: unknown) {
        for (let index = helpers.length - 1; index >= 0; index--) {
            const helper = helpers[index];
            if (helper.hasMock(Entity)) return helper.createQuery(Entity);
        }
        return originalQuery.call(this, Entity, session as never);
    });
}

function activateHelper(helper: SqlTestingHelper): void {
    const index = helpers.indexOf(helper);
    if (index !== -1) helpers.splice(index, 1);
    helpers.push(helper);
}

function matchesFilter(row: Record<string, unknown>, filter: FilterRecord): boolean {
    for (const [field, expected] of Object.entries(filter)) {
        if (!matchesValue(row[field], expected)) return false;
    }
    return true;
}

function matchesValue(actual: unknown, expected: FilterValue): boolean {
    if (isOperatorRecord(expected)) {
        const inValues = Array.isArray(expected.$in) ? expected.$in : undefined;
        const notInValues = Array.isArray(expected.$nin) ? expected.$nin : undefined;
        if ('$in' in expected && !inValues?.some(item => isDeepStrictEqual(actual, item))) return false;
        if ('$nin' in expected && notInValues?.some(item => isDeepStrictEqual(actual, item))) return false;
        if ('$ne' in expected && isDeepStrictEqual(actual, expected.$ne)) return false;
        if ('$gt' in expected && compareValues(actual, expected.$gt) <= 0) return false;
        if ('$gte' in expected && compareValues(actual, expected.$gte) < 0) return false;
        if ('$lt' in expected && compareValues(actual, expected.$lt) >= 0) return false;
        if ('$lte' in expected && compareValues(actual, expected.$lte) > 0) return false;
        if ('$like' in expected && !like(String(actual ?? ''), String(expected.$like))) return false;
        if ('$notLike' in expected && like(String(actual ?? ''), String(expected.$notLike))) return false;
        return true;
    }
    return isDeepStrictEqual(actual, expected);
}

function isOperatorRecord(value: FilterValue): value is Record<string, unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value as Record<string, unknown>).some(key => key.startsWith('$'))
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function like(actual: string, pattern: string): boolean {
    const expression = pattern.split('%').map(escapeRegExp).join('.*').replace(/_/g, '.');
    return new RegExp(`^${expression}$`, 'i').test(actual);
}

function compareValues(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    return (a as any) > (b as any) ? 1 : -1;
}

function normalizeDirection(direction: 'asc' | 'desc' | 'ASC' | 'DESC' | 1 | -1): 'asc' | 'desc' {
    if (direction === -1) return 'desc';
    if (direction === 1) return 'asc';
    return direction.toLowerCase() === 'desc' ? 'desc' : 'asc';
}

function createMutationResult(affectedRows: number, primaryKeys: Record<string, unknown>[] = []): QueryMutationResult {
    const result = { affectedRows, primaryKeys } as unknown as QueryMutationResult;
    Object.defineProperty(result, 'modified', {
        enumerable: false,
        value: affectedRows
    });
    return result;
}

function cloneRows<T extends object>(entityClass: ClassType<T>, rows: readonly Partial<object>[]): Record<string, unknown>[] {
    return rows.map(row => getEntityFields(createEntity(entityClass, row as Partial<T>)));
}

function cloneRecord(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row };
}

function escapeRegExp(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
