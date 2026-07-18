import type { ReceiveType } from '../reflection';
import { isDeepStrictEqual } from 'node:util';

import type { BaseDatabase } from './database';
import type { DriverConnection, ExecuteResult } from './driver';
import type { EntityClass } from './metadata';
import type { QueryBuilder } from './query';
import type { SqlInput } from './sql';
import type { MutexKey } from './database';
import { getEntitySnapshot, hasEntitySnapshot, markEntityClean, markEntityNew } from './entity';
import type { EntityMetadata } from './metadata';
import { DatabaseMutationAccumulator, type DatabaseEntitySnapshot, type DatabaseMutation, type DatabaseQueryMutation } from './mutation';

export interface DatabaseSessionOptions {
    transactional?: boolean;
}

interface TransactionStateEntry {
    value: unknown;
    checkpoint(value: unknown): unknown;
    restore(value: unknown, checkpoint: unknown): void;
}

interface DatabaseSessionCheckpoint {
    sequence: number;
    queued: Set<object>;
    managed: Set<object>;
    removed: Set<object>;
    managedSnapshots: Map<object, Record<string, unknown>>;
    touchedEntitySnapshots: Map<object, EntityInstanceCheckpointState>;
    mutationEntitySnapshots: EntityMutationCheckpointState[];
    insertedEntities: Map<object, InsertedEntityState>;
    preCommitHookCount: number;
    postCommitHookCount: number;
    pendingOperationErrorCount: number;
    mutations: ReturnType<DatabaseMutationAccumulator['checkpoint']>;
    transactionStates: Map<object, { entry: TransactionStateEntry; checkpoint: unknown }>;
}

interface InsertedEntityState {
    metadata: EntityMetadata;
    autoIncrementField?: string;
    previousAutoIncrementValue?: unknown;
}

interface EntityMutationCheckpointState {
    entity: object;
    metadata: EntityMetadata;
    primaryKeys: readonly unknown[];
    snapshot: DatabaseEntitySnapshot | null;
}

interface EntityInstanceCheckpointState {
    persisted: boolean;
    snapshot: DatabaseEntitySnapshot;
}

export class DatabaseSession {
    private queued = new Set<object>();
    private managed = new Set<object>();
    private removed = new Set<object>();
    private pendingOperations = new Set<Promise<unknown>>();
    private pendingOperationErrors: unknown[] = [];
    private preCommitHooks: (() => Promise<void>)[] = [];
    private postCommitHooks: (() => Promise<void>)[] = [];
    private flushing = false;
    private autoFlushSuppressionDepth = 0;
    private readonly mutationAccumulator = new DatabaseMutationAccumulator();
    private insertedEntities = new Map<object, InsertedEntityState>();
    private readonly touchedEntities = new Map<object, EntityMetadata>();
    private readonly transactionStates = new Map<object, TransactionStateEntry>();
    private readonly savepointCheckpoints = new Map<string, DatabaseSessionCheckpoint>();
    private nextSavepointSequence = 1;

    constructor(
        readonly db: BaseDatabase,
        private readonly connection?: DriverConnection,
        private readonly options: DatabaseSessionOptions = {}
    ) {}

    getConnection(): DriverConnection | undefined {
        return this.connection;
    }

    get isFlushing(): boolean {
        return this.flushing;
    }

    get shouldAutoFlush(): boolean {
        return !this.flushing && this.autoFlushSuppressionDepth === 0;
    }

    get isTransactional(): boolean {
        return this.options.transactional ?? false;
    }

    add(...entities: object[]): void {
        for (const entity of entities) {
            this.removed.delete(entity);
            this.queued.add(entity);
        }
    }

    manage(...entities: object[]): void {
        for (const entity of entities) this.managed.add(entity);
    }

    removeQueued(...entities: object[]): void {
        for (const entity of entities) this.queued.delete(entity);
    }

    unmanage(...entities: object[]): void {
        for (const entity of entities) {
            this.queued.delete(entity);
            this.managed.delete(entity);
            this.removed.delete(entity);
        }
    }

    remove(...entities: object[]): void {
        for (const entity of entities) {
            const wasQueued = this.queued.delete(entity);
            if (!wasQueued || this.managed.has(entity) || hasEntitySnapshot(entity)) {
                this.removed.add(entity);
            }
            this.managed.delete(entity);
        }
    }

    trackOperation<T>(worker: () => Promise<T>): Promise<T> {
        let promise: Promise<T>;
        try {
            promise = worker();
        } catch (error) {
            promise = Promise.reject(error);
        }

        const tracked = promise.then(
            () => {
                this.pendingOperations.delete(tracked);
            },
            error => {
                this.pendingOperationErrors.push(error);
                this.pendingOperations.delete(tracked);
            }
        );
        this.pendingOperations.add(tracked);
        promise.catch(() => {});
        tracked.catch(() => {});
        return promise;
    }

    async waitForPendingOperations(): Promise<void> {
        await this.settlePendingOperations();
        if (this.pendingOperationErrors.length) {
            const [error] = this.pendingOperationErrors;
            this.pendingOperationErrors = [];
            throw error;
        }
    }

    async withoutAutoFlush<T>(worker: () => Promise<T>): Promise<T> {
        this.autoFlushSuppressionDepth++;
        try {
            return await worker();
        } finally {
            this.autoFlushSuppressionDepth--;
        }
    }

    query<T extends object>(Entity: EntityClass<T>): QueryBuilder<T> {
        return this.db.query(Entity, this);
    }

    async rawQuery<T = Record<string, unknown>>(input: SqlInput): Promise<T[]> {
        await this.flush();
        return this.db.rawQuery<T>(input, this);
    }

    async rawFind<T = Record<string, unknown>>(input: SqlInput): Promise<T[]> {
        return this.rawQuery<T>(input);
    }

    async rawFindOne<T = Record<string, unknown>>(input: SqlInput): Promise<T | undefined> {
        return (await this.rawFind<T>(input))[0];
    }

    async rawExecute(input: SqlInput): Promise<ExecuteResult> {
        await this.flush();
        return this.db.rawExecute(input, this);
    }

    raw(input: SqlInput): DatabaseSessionRawQuery {
        return {
            execute: () => this.rawExecute(input),
            find: <T = Record<string, unknown>>() => this.rawFind<T>(input),
            findOne: <T = Record<string, unknown>>() => this.rawFindOne<T>(input)
        };
    }

    async rawFindUnsafe<T = Record<string, unknown>>(text: string, bindings: unknown[] = [], type?: ReceiveType<T>): Promise<T[]> {
        await this.flush();
        return this.db.rawFindUnsafe<T>(text, bindings, this, type);
    }

    async rawFindOneUnsafe<T = Record<string, unknown>>(text: string, bindings: unknown[] = [], type?: ReceiveType<T>): Promise<T | undefined> {
        await this.flush();
        return this.db.rawFindOneUnsafe<T>(text, bindings, this, type);
    }

    async rawExecuteUnsafe(text: string, bindings: unknown[] = [], type?: unknown): Promise<ExecuteResult> {
        await this.flush();
        return this.db.rawExecuteUnsafe(text, bindings, this, type);
    }

    async acquireSessionLock(key: MutexKey | MutexKey[]): Promise<void> {
        await this.db.acquireSessionLock(key, this);
    }

    async savepoint(name: string): Promise<void> {
        this.assertTransactional('savepoints');
        await this.waitForPendingOperations();
        await this.flush();
        await this.connection!.savepoint(name);
        this.savepointCheckpoints.set(name, this.createCheckpoint());
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        this.assertTransactional('savepoints');
        const checkpoint = this.savepointCheckpoints.get(name);
        if (!checkpoint) throw new Error(`Unknown database savepoint ${name}`);
        await this.settlePendingOperations();
        await this.connection!.rollbackToSavepoint(name);
        this.restoreCheckpoint(checkpoint);
        for (const [savepointName, candidate] of this.savepointCheckpoints) {
            if (candidate.sequence > checkpoint.sequence) this.savepointCheckpoints.delete(savepointName);
        }
    }

    async withSavepoint<T>(name: string, worker: () => Promise<T>): Promise<T> {
        await this.savepoint(name);
        try {
            return await worker();
        } catch (error) {
            await this.rollbackToSavepoint(name);
            throw error;
        }
    }

    /** Stores transaction-local policy state that participates in savepoint rollback. */
    getTransactionState<T, TCheckpoint>(
        key: object,
        create: () => T,
        checkpoint: (value: T) => TCheckpoint,
        restore: (value: T, checkpoint: TCheckpoint) => void
    ): T {
        const existing = this.transactionStates.get(key);
        if (existing) return existing.value as T;
        const value = create();
        this.transactionStates.set(key, {
            value,
            checkpoint: state => checkpoint(state as T),
            restore: (state, saved) => restore(state as T, saved as TCheckpoint)
        });
        return value;
    }

    async flush(): Promise<void> {
        if (this.flushing) return;
        this.flushing = true;
        try {
            for (const entity of this.queued) {
                if (this.removed.has(entity)) {
                    this.queued.delete(entity);
                    continue;
                }
                await this.db.saveEntity(entity, this);
                this.queued.delete(entity);
                this.managed.add(entity);
            }
            for (const entity of this.managed) {
                if (this.queued.has(entity)) continue;
                if (this.removed.has(entity)) continue;
                await this.db.saveEntity(entity, this);
            }
            for (const entity of this.removed) {
                await this.db.deleteEntity(entity, this);
                this.unmanage(entity);
            }
        } finally {
            this.flushing = false;
        }
    }

    addPreCommitHook(hook: () => Promise<void>): void {
        this.preCommitHooks.push(hook);
    }

    addPostCommitHook(hook: () => Promise<void>): void {
        this.postCommitHooks.push(hook);
    }

    recordEntityMutation(
        entity: object,
        metadata: EntityMetadata,
        before: DatabaseEntitySnapshot | null,
        after: DatabaseEntitySnapshot | null
    ): void {
        this.touchedEntities.set(entity, metadata);
        this.mutationAccumulator.recordEntity(entity, metadata, before, after);
    }

    /** Tracks successful inserts so savepoint rollback can restore reusable entity instances. */
    recordEntityInsert(entity: object, metadata: EntityMetadata, autoIncrementField?: string, previousAutoIncrementValue?: unknown): void {
        this.touchedEntities.set(entity, metadata);
        if (!this.insertedEntities.has(entity)) {
            this.insertedEntities.set(entity, { metadata, autoIncrementField, previousAutoIncrementValue });
        }
    }

    recordQueryMutation(mutation: DatabaseQueryMutation): void {
        this.mutationAccumulator.recordQuery(mutation);
    }

    getMutations(): readonly DatabaseMutation[] {
        return this.mutationAccumulator.getMutations();
    }

    async runPreCommitHooks(): Promise<void> {
        for (const hook of this.preCommitHooks) await hook();
    }

    async runPostCommitHooks(): Promise<void> {
        for (const hook of this.postCommitHooks) await hook();
    }

    private createCheckpoint(): DatabaseSessionCheckpoint {
        const managedSnapshots = new Map<object, Record<string, unknown>>();
        for (const entity of this.managed) managedSnapshots.set(entity, getEntitySnapshot(entity));
        const mutationEntitySnapshots: EntityMutationCheckpointState[] = [];
        for (const mutation of this.mutationAccumulator.getMutations()) {
            if (mutation.kind !== 'entity') continue;
            mutationEntitySnapshots.push({
                entity: mutation.entity,
                metadata: mutation.metadata,
                primaryKeys: getLogicalPrimaryKeys(mutation.metadata, mutation.after ?? mutation.before),
                snapshot: mutation.after
            });
        }
        const touchedEntitySnapshots = new Map<object, EntityInstanceCheckpointState>();
        for (const entity of this.touchedEntities.keys()) {
            touchedEntitySnapshots.set(entity, {
                persisted: hasEntitySnapshot(entity),
                snapshot: getEntitySnapshot(entity)
            });
        }
        return {
            sequence: this.nextSavepointSequence++,
            queued: new Set(this.queued),
            managed: new Set(this.managed),
            removed: new Set(this.removed),
            managedSnapshots,
            touchedEntitySnapshots,
            mutationEntitySnapshots,
            insertedEntities: new Map(this.insertedEntities),
            preCommitHookCount: this.preCommitHooks.length,
            postCommitHookCount: this.postCommitHooks.length,
            pendingOperationErrorCount: this.pendingOperationErrors.length,
            mutations: this.mutationAccumulator.checkpoint(),
            transactionStates: new Map([...this.transactionStates].map(([key, entry]) => [key, { entry, checkpoint: entry.checkpoint(entry.value) }]))
        };
    }

    private restoreCheckpoint(checkpoint: DatabaseSessionCheckpoint): void {
        const currentMutations = this.mutationAccumulator.getMutations();
        const restoreDirectives: EntityMutationCheckpointState[] = [];
        for (const mutation of currentMutations) {
            if (mutation.kind !== 'entity') continue;
            const primaryKeys = getLogicalPrimaryKeys(mutation.metadata, mutation.after ?? mutation.before);
            const saved = checkpoint.mutationEntitySnapshots.find(candidate =>
                sameLogicalEntity(candidate, mutation.metadata, primaryKeys, mutation.entity)
            );
            restoreDirectives.push({
                entity: mutation.entity,
                metadata: mutation.metadata,
                primaryKeys,
                snapshot: saved ? saved.snapshot : mutation.before
            });
        }
        for (const [entity, state] of this.insertedEntities) {
            if (checkpoint.insertedEntities.has(entity)) continue;
            const primaryKeys = getLogicalPrimaryKeys(state.metadata, getEntitySnapshot(entity));
            if (!restoreDirectives.some(candidate => sameLogicalEntity(candidate, state.metadata, primaryKeys, entity))) {
                restoreDirectives.push({ entity, metadata: state.metadata, primaryKeys, snapshot: null });
            }
        }
        for (const [entity, metadata] of this.touchedEntities) {
            const savedInstance = checkpoint.touchedEntitySnapshots.get(entity);
            if (savedInstance) {
                Object.assign(entity, savedInstance.snapshot);
                if (savedInstance.persisted) markEntityClean(entity);
                else markEntityNew(entity);
                continue;
            }
            const primaryKeys = getLogicalPrimaryKeys(metadata, getEntitySnapshot(entity));
            const directive = restoreDirectives.find(candidate => sameLogicalEntity(candidate, metadata, primaryKeys, entity));
            if (!directive) continue;
            if (directive.snapshot) {
                Object.assign(entity, directive.snapshot);
                markEntityClean(entity);
                continue;
            }
            const insertedState = this.insertedEntities.get(entity);
            if (metadata.primaryKey.autoIncrement) {
                (entity as Record<string, unknown>)[metadata.primaryKey.propertyName] = insertedState?.previousAutoIncrementValue ?? 0;
            }
            markEntityNew(entity);
        }
        this.queued = new Set(checkpoint.queued);
        this.managed = new Set(checkpoint.managed);
        this.removed = new Set(checkpoint.removed);
        this.insertedEntities = new Map(checkpoint.insertedEntities);
        for (const [entity, snapshot] of checkpoint.managedSnapshots) {
            Object.assign(entity, snapshot);
            markEntityClean(entity);
        }
        this.preCommitHooks.length = checkpoint.preCommitHookCount;
        this.postCommitHooks.length = checkpoint.postCommitHookCount;
        this.pendingOperationErrors.length = checkpoint.pendingOperationErrorCount;
        this.mutationAccumulator.restore(checkpoint.mutations);

        for (const key of this.transactionStates.keys()) {
            if (!checkpoint.transactionStates.has(key)) this.transactionStates.delete(key);
        }
        for (const [key, saved] of checkpoint.transactionStates) {
            saved.entry.restore(saved.entry.value, saved.checkpoint);
            this.transactionStates.set(key, saved.entry);
        }
    }

    private assertTransactional(feature: string): void {
        if (!this.isTransactional || !this.connection) throw new Error(`Database ${feature} require an active transaction`);
    }

    private async settlePendingOperations(): Promise<void> {
        while (this.pendingOperations.size) await Promise.allSettled(this.pendingOperations);
    }
}

function getLogicalPrimaryKeys(metadata: EntityMetadata, snapshot: DatabaseEntitySnapshot | null): readonly unknown[] {
    if (!snapshot) return [];
    const values = metadata.primaryKeys.map(primaryKey => snapshot[primaryKey.propertyName]);
    return values.every(value => value !== undefined && value !== null) ? values : [];
}

function sameLogicalEntity(
    candidate: Pick<EntityMutationCheckpointState, 'entity' | 'metadata' | 'primaryKeys'>,
    metadata: EntityMetadata,
    primaryKeys: readonly unknown[],
    entity: object
): boolean {
    if (candidate.entity === entity) return true;
    return (
        candidate.metadata.classType === metadata.classType &&
        candidate.primaryKeys.length > 0 &&
        primaryKeys.length > 0 &&
        isDeepStrictEqual(candidate.primaryKeys, primaryKeys)
    );
}

export type DbSession = DatabaseSession;

export interface DatabaseSessionRawQuery {
    execute(): Promise<ExecuteResult>;
    find<T = Record<string, unknown>>(): Promise<T[]>;
    findOne<T = Record<string, unknown>>(): Promise<T | undefined>;
}
