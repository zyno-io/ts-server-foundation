import { isDeepStrictEqual } from 'node:util';

import type { AutoIncrement } from '../reflection';

import { HttpNotFoundError } from '../http/errors';
import type { ClassType, HasDefault, ObjectKeysMatching, StringKeyOf } from '../types';
import type { BaseDatabase } from './database';
import type { DatabaseSession } from './session';
import { EntityClass, getEntityMetadata } from './metadata';
import type { FilterQuery, FilterRecord } from './query';

const EntityDatabase = new WeakMap<EntityClass, BaseDatabase>();
const OriginalSnapshot = new WeakMap<object, Record<string, unknown>>();
const EntityReferences = new WeakSet<object>();

export type EntityFilterInput<T extends object> = Partial<T> | FilterRecord | string | number;

export class ItemNotFound extends Error {
    constructor(message = 'Item not found') {
        super(message);
        this.name = 'ItemNotFound';
    }
}

export class BaseEntity {
    static query<T extends BaseEntity>(this: EntityClass<T>, session?: DatabaseSession) {
        return getEntityDatabase(this).query(this, session);
    }

    static getDatabase<T extends BaseEntity>(this: EntityClass<T>): BaseDatabase {
        return getEntityDatabase(this);
    }

    static registerDatabase<T extends BaseEntity>(this: EntityClass<T>, db: BaseDatabase): void {
        bindEntityDatabase(this, db);
    }

    static reference<T extends BaseEntity>(this: EntityClass<T>, value: Partial<T> | string | number): T {
        const data = typeof value === 'object' ? value : ({ [getPKFieldForEntity(this)]: value } as Partial<T>);
        const entity = createEntity(this, data);
        markEntityClean(entity);
        EntityReferences.add(entity);
        return entity;
    }

    async save(session?: DatabaseSession): Promise<void> {
        await getEntityDatabase(this.constructor as EntityClass).saveEntity(this, session);
    }

    async delete(session?: DatabaseSession): Promise<void> {
        await getEntityDatabase(this.constructor as EntityClass).deleteEntity(this, session);
    }

    async remove(session?: DatabaseSession): Promise<void> {
        await this.delete(session);
    }
}

export type BaseEntityClassType<T extends BaseEntity = BaseEntity> = EntityClass<T> & typeof BaseEntity;
type FieldsMatching<T, V> = {
    // oxlint-disable-next-line typescript/no-explicit-any -- any callable property must be excluded regardless of its parameter and return types
    [K in StringKeyOf<T>]: T[K] extends V ? (T[K] extends (...args: any[]) => any ? never : K) : never;
}[StringKeyOf<T>];
export type DataTypes = string | number | boolean | Date | object | null;
export type EntityFieldKeys<T extends object> = FieldsMatching<T, DataTypes>;
export type EntityFields<T extends object> = Pick<T, EntityFieldKeys<T>>;
export type EntityClassFields<T extends ClassType> = EntityFields<InstanceType<T>>;
export type EntityPick<T extends BaseEntity, K extends keyof EntityFields<T>> = BaseEntity & Pick<T, K>;
export type EntityOptionalKeys<T extends object> =
    | ObjectKeysMatching<T, HasDefault>
    | ObjectKeysMatching<T, null>
    | ObjectKeysMatching<T, AutoIncrement>;
export type EntityOptionals<T extends object> = {
    [K in keyof Pick<T, Extract<EntityOptionalKeys<T>, keyof T>>]?: T[K];
} & {
    [K in keyof Omit<T, EntityOptionalKeys<T>>]: T[K];
};
export type NewEntityFields<T extends object> = EntityOptionals<EntityFields<T>>;
export type EntityCreateData<T extends object, D extends T = T> = NewEntityFields<D> | Partial<T>;

export function bindEntityDatabase(entityClass: EntityClass, db: BaseDatabase): void {
    EntityDatabase.set(entityClass, db);
}

export function getEntityDatabase(entityClass: EntityClass): BaseDatabase {
    const db = EntityDatabase.get(entityClass);
    if (!db) throw new Error(`Entity ${entityClass.name} is not registered with a database`);
    return db;
}

export function createEntity<T extends object, D extends T = T>(Entity: ClassType<T>, data: EntityCreateData<T, D>): T {
    const entity = new Entity();
    Object.assign(entity, data);
    const metadata = getEntityMetadata(Entity as EntityClass);
    for (const column of metadata.columns) {
        if ((entity as Record<string, unknown>)[column.propertyName] === undefined) {
            if (column.autoIncrement) (entity as Record<string, unknown>)[column.propertyName] = 0;
            else if (column.nullable) (entity as Record<string, unknown>)[column.propertyName] = null;
        }
    }
    return entity;
}

export function createEntities<T extends object, D extends T = T>(Entity: ClassType<T>, data: EntityCreateData<T, D>[]): T[] {
    return data.map(item => createEntity(Entity, item));
}

export function createQueuedEntity<T extends object, D extends T = T>(
    Entity: ClassType<T>,
    data: EntityCreateData<T, D>,
    session: DatabaseSession
): T {
    const entity = createEntity(Entity, data);
    session.add(entity);
    return entity;
}

export function createQueuedEntities<T extends object, D extends T = T>(
    Entity: ClassType<T>,
    data: EntityCreateData<T, D>[],
    session: DatabaseSession
): T[] {
    const entities = createEntities(Entity, data);
    session.add(...entities);
    return entities;
}

export async function createPersistedEntity<T extends object, D extends T = T>(
    Entity: ClassType<T>,
    data: EntityCreateData<T, D>,
    session?: DatabaseSession
): Promise<T> {
    const entity = createEntity(Entity, data);
    await persistEntity(entity, session);
    return entity;
}

export async function persistEntity<T extends object>(entity: T, session?: DatabaseSession): Promise<void> {
    await persistEntities([entity], session);
}

export async function persistEntities<T extends object>(entities: T[], session?: DatabaseSession): Promise<void> {
    if (session) {
        session.add(...entities);
        await session.flush();
    } else {
        for (const entity of entities) await getEntityDatabase(entity.constructor as EntityClass).saveEntity(entity);
    }
}

export async function createPersistedEntities<T extends object, D extends T = T>(
    Entity: ClassType<T>,
    data: EntityCreateData<T, D>[],
    session?: DatabaseSession
): Promise<T[]> {
    const entities = createEntities(Entity, data);
    await persistEntities(entities, session);
    return entities;
}

export function markEntityClean(entity: object): void {
    OriginalSnapshot.set(entity, cloneRecord(getEntityFields(entity)));
}

/** Restores an entity instance to an unpersisted state. */
export function markEntityNew(entity: object): void {
    OriginalSnapshot.delete(entity);
}

export function getEntityOriginal<T extends object>(entity: T): Partial<T> {
    return cloneRecord((OriginalSnapshot.get(entity) as Record<string, unknown> | undefined) ?? {}) as Partial<T>;
}

export function hasEntitySnapshot(entity: object): boolean {
    return OriginalSnapshot.has(entity);
}

/** True only for the deliberately partial instance returned by `Entity.reference()`. */
export function isEntityReference(entity: object): boolean {
    return EntityReferences.has(entity);
}

export function getDirtyDetails<T extends object>(entity: T): Record<string, { original: unknown; current: unknown }> {
    const original = (OriginalSnapshot.get(entity) ?? {}) as Record<string, unknown>;
    const current = getEntityFields(entity);
    const result: Record<string, { original: unknown; current: unknown }> = {};
    for (const [key, value] of Object.entries(current)) {
        if (!isDeepStrictEqual(original[key], value)) result[key] = { original: cloneValue(original[key]), current: value };
    }
    return result;
}

export function getDirtyFields<T extends object>(entity: T): (keyof T)[] {
    return Object.keys(getDirtyDetails(entity)) as (keyof T)[];
}

export function isEntityDirty(entity: object): boolean {
    return getDirtyFields(entity).length > 0;
}

export function isFieldDirty<T extends object>(entity: T, field: keyof T): boolean {
    return getDirtyFields(entity).includes(field);
}

export function getFieldOriginal<T extends object, K extends keyof T>(entity: T, field: K): T[K] | undefined {
    return getEntityOriginal(entity)[field];
}

export function revertDirtyEntity(entity: object): void {
    Object.assign(entity, cloneRecord((OriginalSnapshot.get(entity) ?? {}) as Record<string, unknown>));
}

export function getEntityFields<T extends object>(entity: T): Record<string, unknown> {
    const metadata = getEntityMetadata(entity.constructor as EntityClass);
    return Object.fromEntries(metadata.columns.map(column => [column.propertyName, (entity as Record<string, unknown>)[column.propertyName]]));
}

/** Returns a detached copy of every persisted entity field. */
export function getEntitySnapshot<T extends object>(entity: T): Record<string, unknown> {
    return cloneRecord(getEntityFields(entity));
}

export function getPKFieldForEntity(Entity: EntityClass): string {
    return getEntityMetadata(Entity).primaryKey.propertyName;
}

export function getPKFieldForEntityInstance(entity: object): string {
    return getPKFieldForEntity(entity.constructor as EntityClass);
}

interface GetEntityOptions<Schema extends BaseEntityClassType, Field extends keyof EntityClassFields<Schema>> {
    schema: Schema;
    ids: unknown[];
    keyField?: Field;
    fields?: Field[];
    filter?: FilterQuery<InstanceType<Schema>>;
    txn?: DatabaseSession;
}

export async function getKeyedEntities<Schema extends BaseEntityClassType, Field extends keyof EntityClassFields<Schema>>(
    options: GetEntityOptions<Schema, Field>
): Promise<Record<string, EntityLookupResult<Schema, Field>>> {
    const { keyField, entities } = await getEntitiesByIdWithKeyName(options);
    return keyEntities(entities, keyField);
}

export async function getKeyedGroupedEntities<Schema extends BaseEntityClassType, Field extends keyof EntityClassFields<Schema>>(
    options: GetEntityOptions<Schema, Field>
): Promise<Record<string, Array<EntityLookupResult<Schema, Field>>>> {
    const { keyField, entities } = await getEntitiesByIdWithKeyName(options);
    const grouped: Record<string, Array<EntityLookupResult<Schema, Field>>> = {};
    for (const entity of entities) {
        const key = String((entity as Record<string, unknown>)[String(keyField)]);
        const current = Object.prototype.hasOwnProperty.call(grouped, key) ? grouped[key] : undefined;
        if (current) current.push(entity);
        else defineRecordValue(grouped, key, [entity]);
    }
    return grouped;
}

export async function getEntitiesById<Schema extends BaseEntityClassType, Field extends keyof EntityClassFields<Schema>>(
    options: GetEntityOptions<Schema, Field>
): Promise<Array<EntityLookupResult<Schema, Field>>> {
    const { entities } = await getEntitiesByIdWithKeyName(options);
    return entities;
}

export async function getEntitiesByIdWithKeyName<Schema extends BaseEntityClassType, Field extends keyof EntityClassFields<Schema>>({
    schema,
    ids,
    keyField,
    fields,
    filter,
    txn
}: GetEntityOptions<Schema, Field>): Promise<{
    keyField: Field | string;
    entities: Array<EntityLookupResult<Schema, Field>>;
}> {
    const resolvedKeyField = keyField ?? getPKFieldForEntity(schema);
    const resolvedIds = uniqueCompact(ids);
    if (!resolvedIds.length) return { keyField: resolvedKeyField, entities: [] };

    const query = txn ? txn.query(schema) : getEntityDatabase(schema).query(schema);
    const idFilter: FilterRecord = { [String(resolvedKeyField)]: { $in: resolvedIds } };
    query.filter(filter ? ({ $and: [idFilter, filter as FilterRecord] } as FilterRecord) : idFilter);
    if (fields?.length) query.select(...fields.map(String));
    const entities = (await query.find()) as Array<EntityLookupResult<Schema, Field>>;
    return { keyField: resolvedKeyField, entities };
}

interface ResolveRelatedOptions<
    Schema extends object,
    IdKey extends keyof EntityFields<Schema>,
    RelatedSchema extends BaseEntityClassType,
    RelatedKey extends string,
    RelatedFields extends keyof EntityClassFields<RelatedSchema>
> {
    src: Schema[];
    srcIdField: IdKey;
    targetField: RelatedKey;
    targetSchema: RelatedSchema;
    targetFields?: RelatedFields[];
    txn?: DatabaseSession;
}

export async function resolveRelated<
    Schema extends object,
    IdKey extends keyof EntityFields<Schema>,
    RelatedSchema extends BaseEntityClassType,
    RelatedKey extends string,
    RelatedFields extends keyof EntityClassFields<RelatedSchema>
>(options: ResolveRelatedOptions<Schema, IdKey, RelatedSchema, RelatedKey, RelatedFields>) {
    const { src, srcIdField, targetField, targetSchema, targetFields } = options;
    type RelatedType = EntityLookupResult<RelatedSchema, RelatedFields>;
    type RelatedFieldType = null extends Schema[IdKey] ? { [K in RelatedKey]?: RelatedType } : { [K in RelatedKey]: RelatedType };
    type ReturnType = Omit<Schema, IdKey> & RelatedFieldType;

    if (!src.length) return [] as ReturnType[];

    const subentitiesById = await getKeyedEntities({
        ids: src.map(entity => entity[srcIdField]),
        schema: targetSchema,
        fields: targetFields,
        txn: options.txn
    });

    for (const entity of src) {
        (entity as Record<string, unknown>)[targetField] = getOwnRecordValue(subentitiesById, String(entity[srcIdField]));
    }

    return src as ReturnType[];
}

interface ResolveRelatedByPivotOptions<
    Schema extends object,
    SrcIdField extends keyof EntityFields<Schema>,
    PivotSchema extends BaseEntityClassType,
    PivotIdKey extends keyof EntityClassFields<PivotSchema>,
    PivotRelatedKey extends keyof EntityClassFields<PivotSchema>,
    RelatedSchema extends BaseEntityClassType,
    RelatedKey extends string,
    RelatedFields extends keyof EntityClassFields<RelatedSchema>
> {
    src: Schema[];
    srcIdField?: SrcIdField;
    pivotSchema: PivotSchema;
    pivotIdKey: PivotIdKey;
    pivotRelatedKey: PivotRelatedKey;
    pivotFilter?: FilterQuery<InstanceType<PivotSchema>>;
    targetField: RelatedKey;
    targetSchema: RelatedSchema;
    targetFields?: RelatedFields[];
    txn?: DatabaseSession;
}

export async function resolveRelatedByPivot<
    Schema extends object,
    SrcIdField extends keyof EntityFields<Schema>,
    PivotSchema extends BaseEntityClassType,
    PivotIdKey extends keyof EntityClassFields<PivotSchema>,
    PivotRelatedKey extends keyof EntityClassFields<PivotSchema>,
    RelatedSchema extends BaseEntityClassType,
    RelatedKey extends string,
    RelatedFields extends keyof EntityClassFields<RelatedSchema>
>(options: ResolveRelatedByPivotOptions<Schema, SrcIdField, PivotSchema, PivotIdKey, PivotRelatedKey, RelatedSchema, RelatedKey, RelatedFields>) {
    const { src, srcIdField, pivotSchema, pivotIdKey, pivotRelatedKey, pivotFilter, targetField, targetSchema, targetFields } = options;
    type RelatedType = EntityLookupResult<RelatedSchema, RelatedFields>;
    type RelatedTypeWithPivot = RelatedType & { pivot: InstanceType<PivotSchema> };
    type ReturnType = Schema & { [K in RelatedKey]: RelatedTypeWithPivot[] };

    if (!src.length) return [] as ReturnType[];

    const sourcePkField = srcIdField ?? (getPKFieldForEntityInstance(src[0]) as SrcIdField);
    const pivotEntitiesBySourceId = await getKeyedGroupedEntities({
        ids: src.map(entity => (entity as Record<string, unknown>)[String(sourcePkField)]),
        schema: pivotSchema,
        keyField: pivotIdKey,
        filter: pivotFilter,
        txn: options.txn
    });

    const relatedEntitiesById = await getKeyedEntities({
        ids: Object.values(pivotEntitiesBySourceId).flatMap(pivots =>
            pivots.map(pivot => (pivot as Record<string, unknown>)[String(pivotRelatedKey)])
        ),
        schema: targetSchema,
        fields: targetFields,
        txn: options.txn
    });

    for (const entity of src) {
        const sourceId = String((entity as Record<string, unknown>)[String(sourcePkField)]);
        (entity as Record<string, unknown>)[targetField] =
            getOwnRecordValue(pivotEntitiesBySourceId, sourceId)?.map(pivot => ({
                ...getOwnRecordValue(relatedEntitiesById, String((pivot as Record<string, unknown>)[String(pivotRelatedKey)])),
                pivot
            })) ?? [];
    }

    return src as ReturnType[];
}

export async function resolveRelatedByPivotForOne<
    Schema extends object,
    SrcIdField extends keyof EntityFields<Schema>,
    PivotSchema extends BaseEntityClassType,
    PivotIdKey extends keyof EntityClassFields<PivotSchema>,
    PivotRelatedKey extends keyof EntityClassFields<PivotSchema>,
    RelatedSchema extends BaseEntityClassType,
    RelatedKey extends string,
    RelatedFields extends keyof EntityClassFields<RelatedSchema>
>(
    options: Omit<
        ResolveRelatedByPivotOptions<Schema, SrcIdField, PivotSchema, PivotIdKey, PivotRelatedKey, RelatedSchema, RelatedKey, RelatedFields>,
        'src'
    > & {
        src: Schema;
    }
) {
    return (
        await resolveRelatedByPivot({
            ...options,
            src: [options.src]
        })
    )[0];
}

export async function getEntityOrUndefined<T extends object>(Entity: EntityClass<T>, filter: EntityFilterInput<T>): Promise<T | undefined> {
    return getEntityDatabase(Entity).query(Entity).filter(normalizeEntityFilter(Entity, filter)).findOneOrUndefined();
}

export async function getEntity<T extends object>(Entity: EntityClass<T>, filter: EntityFilterInput<T>): Promise<T> {
    const entity = await getEntityOrUndefined(Entity, filter);
    if (!entity) throw new ItemNotFound();
    return entity;
}

export async function getEntityOr404<T extends object>(Entity: EntityClass<T>, filter: EntityFilterInput<T>): Promise<T> {
    const entity = await getEntityOrUndefined(Entity, filter);
    if (!entity) throw new HttpNotFoundError();
    return entity;
}

export async function entityExists<T extends object>(Entity: EntityClass<T>, filter: EntityFilterInput<T>): Promise<boolean> {
    return getEntityDatabase(Entity).query(Entity).filter(normalizeEntityFilter(Entity, filter)).has();
}

function normalizeEntityFilter<T extends object>(Entity: EntityClass<T>, filter: EntityFilterInput<T>): FilterRecord {
    if (typeof filter === 'object') return filter as FilterRecord;
    return { [getPKFieldForEntity(Entity)]: filter };
}

type EntityLookupResult<Schema extends BaseEntityClassType, Field extends keyof EntityClassFields<Schema>> = Field[] extends never[]
    ? InstanceType<Schema>
    : EntityPick<InstanceType<Schema>, Field>;

function uniqueCompact(values: unknown[]): unknown[] {
    return [...new Set(values.filter(value => value === 0 || value === 0n || Boolean(value)))];
}

function keyEntities<T extends object>(entities: T[], keyField: string | number | symbol): Record<string, T> {
    const keyed: Record<string, T> = {};
    for (const entity of entities) defineRecordValue(keyed, String((entity as Record<string, unknown>)[String(keyField)]), entity);
    return keyed;
}

function getOwnRecordValue<T>(record: Record<string, T>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function defineRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
    });
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, cloneValue(value)]));
}

function cloneValue<T>(value: T): T {
    if (value === null || value === undefined) return value;
    try {
        return structuredClone(value);
    } catch {
        if (value instanceof Date) return new Date(value.getTime()) as T;
        if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T;
        if (typeof value === 'object') return { ...(value as Record<string, unknown>) } as T;
        return value;
    }
}
