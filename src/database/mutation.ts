import { isDeepStrictEqual } from 'node:util';

import type { BaseDatabase } from './database';
import type { EntityMetadata } from './metadata';
import type { DatabaseSession } from './session';

export type DatabaseEntityMutationOperation = 'create' | 'update' | 'delete';
export type DatabaseQueryMutationOperation = 'update' | 'delete';
export type DatabaseEntitySnapshot = Readonly<Record<string, unknown>>;

export interface DatabaseEntityMutation {
    readonly kind: 'entity';
    readonly operation: DatabaseEntityMutationOperation;
    readonly entity: object;
    readonly metadata: EntityMetadata;
    readonly before: DatabaseEntitySnapshot | null;
    readonly after: DatabaseEntitySnapshot | null;
    readonly changedFields: readonly string[];
}

/**
 * A mutation performed directly by QueryBuilder. It deliberately does not pretend to contain an
 * entity before/after image: consumers that require one can reject it or load the affected rows in
 * their own policy layer.
 */
export interface DatabaseQueryMutation {
    readonly kind: 'query';
    readonly operation: DatabaseQueryMutationOperation;
    readonly metadata: EntityMetadata;
    readonly primaryKeys: readonly Readonly<Record<string, unknown>>[];
    /** Persisted values requested by interceptors immediately before the query mutation. */
    readonly before: readonly DatabaseEntitySnapshot[];
    /** Persisted property names changed by the patch, including fields nested under `$inc`. */
    readonly changedFields: readonly string[];
    readonly patch?: Readonly<Record<string, unknown>>;
}

export type DatabaseMutation = DatabaseEntityMutation | DatabaseQueryMutation;

export interface DatabaseMutationCommitContext {
    readonly database: BaseDatabase;
    readonly session: DatabaseSession;
    readonly mutations: readonly DatabaseMutation[];
}

export interface DatabaseMutationInterceptor {
    /** Limits capture and delivery to entity classes relevant to this interceptor. */
    observes?(metadata: EntityMetadata): boolean;
    /** Requests persisted property values needed to validate a QueryBuilder mutation. */
    querySnapshotFields?(metadata: EntityMetadata): readonly string[];
    beforeCommit(context: DatabaseMutationCommitContext): void | Promise<void>;
}

interface PendingEntityMutation {
    readonly sequence: number;
    readonly entity: object;
    readonly metadata: EntityMetadata;
    readonly primaryKeys: readonly unknown[];
    readonly before: DatabaseEntitySnapshot | null;
    readonly after: DatabaseEntitySnapshot | null;
}

interface PendingQueryMutation {
    readonly sequence: number;
    readonly mutation: DatabaseQueryMutation;
}

export interface DatabaseMutationCheckpoint {
    readonly entityMutations: ReadonlyMap<object, PendingEntityMutation>;
    readonly queryMutations: readonly PendingQueryMutation[];
    readonly nextSequence: number;
}

export class DatabaseMutationAccumulator {
    private entityMutations = new Map<object, PendingEntityMutation>();
    private queryMutations: PendingQueryMutation[] = [];
    private nextSequence = 1;

    recordEntity(entity: object, metadata: EntityMetadata, before: DatabaseEntitySnapshot | null, after: DatabaseEntitySnapshot | null): void {
        const primaryKeys = getPrimaryKeyValues(metadata, after ?? before);
        const existingEntry = this.entityMutations.has(entity)
            ? ([entity, this.entityMutations.get(entity)!] as const)
            : [...this.entityMutations].find(
                  ([, pending]) =>
                      pending.metadata.classType === metadata.classType &&
                      primaryKeys.length > 0 &&
                      isDeepStrictEqual(pending.primaryKeys, primaryKeys)
              );
        const existing = existingEntry?.[1];
        const pending: PendingEntityMutation = {
            sequence: existing?.sequence ?? this.nextSequence++,
            entity,
            metadata,
            primaryKeys,
            before: existing ? existing.before : before,
            after
        };

        if (existingEntry && existingEntry[0] !== entity) this.entityMutations.delete(existingEntry[0]);
        if (pending.before === null && pending.after === null) this.entityMutations.delete(entity);
        else this.entityMutations.set(entity, pending);
    }

    recordQuery(mutation: DatabaseQueryMutation): void {
        this.queryMutations.push({
            sequence: this.nextSequence++,
            mutation: {
                ...mutation,
                primaryKeys: mutation.primaryKeys.map(primaryKey => cloneRecord(primaryKey)),
                before: mutation.before.map(snapshot => cloneRecord(snapshot)),
                changedFields: [...mutation.changedFields],
                ...(mutation.patch ? { patch: cloneRecord(mutation.patch) } : {})
            }
        });
    }

    checkpoint(): DatabaseMutationCheckpoint {
        return {
            entityMutations: new Map(this.entityMutations),
            queryMutations: [...this.queryMutations],
            nextSequence: this.nextSequence
        };
    }

    restore(checkpoint: DatabaseMutationCheckpoint): void {
        this.entityMutations = new Map(checkpoint.entityMutations);
        this.queryMutations = [...checkpoint.queryMutations];
        this.nextSequence = checkpoint.nextSequence;
    }

    getMutations(): DatabaseMutation[] {
        const mutations: Array<{ sequence: number; mutation: DatabaseMutation }> = this.queryMutations.map(item => ({ ...item }));
        for (const pending of this.entityMutations.values()) {
            const mutation = createEntityMutation(pending);
            if (mutation) mutations.push({ sequence: pending.sequence, mutation });
        }
        return mutations.sort((left, right) => left.sequence - right.sequence).map(item => item.mutation);
    }
}

function createEntityMutation(pending: PendingEntityMutation): DatabaseEntityMutation | undefined {
    const { before, after } = pending;
    if (before !== null && after !== null && isDeepStrictEqual(before, after)) return undefined;

    const operation: DatabaseEntityMutationOperation = before === null ? 'create' : after === null ? 'delete' : 'update';
    const changedFields = getChangedFields(before, after);
    return {
        kind: 'entity',
        operation,
        entity: pending.entity,
        metadata: pending.metadata,
        before,
        after,
        changedFields
    };
}

function getChangedFields(before: DatabaseEntitySnapshot | null, after: DatabaseEntitySnapshot | null): string[] {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    return [...keys].filter(key => !isDeepStrictEqual(before?.[key], after?.[key]));
}

function getPrimaryKeyValues(metadata: EntityMetadata, snapshot: DatabaseEntitySnapshot | null): unknown[] {
    if (!snapshot) return [];
    const values = metadata.primaryKeys.map(primaryKey => snapshot[primaryKey.propertyName]);
    return values.every(value => value !== undefined && value !== null) ? values : [];
}

function cloneRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
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
