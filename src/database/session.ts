import type { ReceiveType } from '../reflection';

import type { BaseDatabase } from './database';
import type { DriverConnection, ExecuteResult } from './driver';
import type { EntityClass } from './metadata';
import type { QueryBuilder } from './query';
import type { SqlInput } from './sql';
import type { MutexKey } from './database';
import { hasEntitySnapshot } from './entity';

export interface DatabaseSessionOptions {
    transactional?: boolean;
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
        while (this.pendingOperations.size) {
            await Promise.allSettled(this.pendingOperations);
        }
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
        await this.flush();
        await this.connection!.savepoint(name);
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        this.assertTransactional('savepoints');
        await this.connection!.rollbackToSavepoint(name);
    }

    async withSavepoint<T>(name: string, worker: () => Promise<T>): Promise<T> {
        await this.savepoint(name);
        const queuedBefore = new Set(this.queued);
        const managedBefore = new Set(this.managed);
        const removedBefore = new Set(this.removed);
        const preCommitHookCount = this.preCommitHooks.length;
        const postCommitHookCount = this.postCommitHooks.length;
        try {
            return await worker();
        } catch (error) {
            await this.rollbackToSavepoint(name);
            this.queued = queuedBefore;
            this.managed = managedBefore;
            this.removed = removedBefore;
            this.preCommitHooks.length = preCommitHookCount;
            this.postCommitHooks.length = postCommitHookCount;
            throw error;
        }
    }

    async flush(): Promise<void> {
        if (this.flushing) return;
        this.flushing = true;
        try {
            for (const entity of [...this.queued]) {
                if (this.removed.has(entity)) {
                    this.queued.delete(entity);
                    continue;
                }
                await this.db.saveEntity(entity, this);
                this.queued.delete(entity);
                this.managed.add(entity);
            }
            for (const entity of [...this.managed]) {
                if (this.queued.has(entity)) continue;
                if (this.removed.has(entity)) continue;
                await this.db.saveEntity(entity, this);
            }
            for (const entity of [...this.removed]) {
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

    async runPreCommitHooks(): Promise<void> {
        for (const hook of this.preCommitHooks) await hook();
    }

    async runPostCommitHooks(): Promise<void> {
        for (const hook of this.postCommitHooks) await hook();
    }

    private assertTransactional(feature: string): void {
        if (!this.isTransactional || !this.connection) throw new Error(`Database ${feature} require an active transaction`);
    }
}

export type DbSession = DatabaseSession;

export interface DatabaseSessionRawQuery {
    execute(): Promise<ExecuteResult>;
    find<T = Record<string, unknown>>(): Promise<T[]>;
    findOne<T = Record<string, unknown>>(): Promise<T | undefined>;
}
