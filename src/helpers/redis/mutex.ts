import { createHash, randomUUID } from 'node:crypto';

import { getAppConfig } from '../../app/resolver';
import { sleepMs } from '../utils/date';
import { createRedis, type RedisConnection } from './redis';

export type MutexKey = any;
export interface MutexContext {
    key: string;
    lockId?: string;
    signal: AbortSignal;
    assertNotAborted(): void;
}
export type MutexFn<R = unknown> = (didWait: boolean, context?: MutexContext) => Promise<R>;

export interface MutexOptions<T> {
    key: MutexKey | MutexKey[];
    fn: MutexFn<T>;
    retryCount?: number;
    retryDelay?: number;
    renewInterval?: number;
    mode?: 'local' | 'redis';
    redis?: RedisMutexProvider;
    signal?: AbortSignal;
}

export interface RedisMutexClient {
    eval(script: string, numberOfKeys: 1, key: string, ...args: Array<string | number>): Promise<unknown> | unknown;
}

export type RedisMutexProvider = () => RedisConnection<RedisMutexClient>;

export interface MutexObservation {
    id: string;
    key: string;
    mode: 'local' | 'redis';
    type: 'pending' | 'acquired' | 'released' | 'error' | 'failed';
    startedAt: number;
    at: number;
    waited?: boolean;
    error?: unknown;
}

export type MutexObserver = (entry: MutexObservation) => void;

const DefaultMutexOptions = {
    retryCount: 30,
    retryDelay: 1000,
    renewInterval: 1000
};

const localMutexes = new Map<string, Promise<void>>();
let defaultRedisConnection: RedisConnection<RedisMutexClient> | undefined;
const mutexObservers = new Set<MutexObserver>();

const ACQUIRE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 1 then
    return 0
end
redis.call("set", KEYS[1], ARGV[1], "px", ARGV[2])
return 1
`;
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call("pexpire", KEYS[1], ARGV[2])
return 1
`;
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call("del", KEYS[1])
return 1
`;

export class MutexAcquisitionError extends Error {
    constructor(message = 'Failed to acquire mutex within timeout') {
        super(message);
        this.name = 'MutexAcquisitionError';
    }
}

export async function withMutex<T>(options: MutexOptions<T>): Promise<T> {
    const resolved = { ...DefaultMutexOptions, ...options };
    const key = flattenMutexKey(resolved.key);
    const mode = resolved.mode ?? getConfiguredMutexMode();

    if (mode === 'redis') return redisMutexExec(key, resolved);

    return localMutexExec(key, resolved);
}

export function registerMutexObserver(observer: MutexObserver): () => void {
    mutexObservers.add(observer);
    return () => mutexObservers.delete(observer);
}

export function withMutexes<T>(options: Omit<MutexOptions<T>, 'key'> & { keys: Array<MutexOptions<T>['key']> }): Promise<T> {
    return withMutexesInternal({ ...options, keys: orderMutexKeys(options.keys) }, 0, false, []);
}

function withMutexesInternal<T>(
    options: Omit<MutexOptions<T>, 'key'> & { keys: Array<MutexOptions<T>['key']> },
    index: number,
    didAnyWait: boolean,
    contexts: MutexContext[]
): Promise<T> {
    const currentKey = options.keys[index];
    const parentContext = createCompositeMutexContext(contexts, options.signal);
    parentContext.assertNotAborted();
    if (currentKey === undefined) return options.fn(didAnyWait, parentContext);

    return withMutex({
        ...options,
        key: currentKey,
        signal: parentContext.signal,
        fn: (didWait, context) => {
            return withMutexesInternal(options, index + 1, didAnyWait || didWait, [...contexts, context!]);
        }
    });
}

export function flattenMutexKey(key: MutexKey | MutexKey[]): string {
    if (Array.isArray(key)) return key.map(part => flattenMutexKey(part)).join(':');
    if (key === null) return 'null';

    if (typeof key === 'object') {
        if ('name' in key && typeof key.name === 'string') return key.name;
        const constructorName = key.constructor?.name;
        if (constructorName && constructorName !== 'Object') return constructorName;

        const jsonKey = JSON.stringify(key);
        const objectKey = jsonKey && jsonKey !== '{}' ? jsonKey : String(key);
        return createHash('md5').update(objectKey).digest('hex');
    }

    return String(key);
}

async function localMutexExec<T>(
    key: string,
    options: Required<Pick<MutexOptions<T>, 'fn' | 'retryCount' | 'retryDelay' | 'renewInterval'>> & MutexOptions<T>
): Promise<T> {
    const observationId = randomUUID();
    const startedAt = Date.now();
    const deadline = Date.now() + options.retryCount * options.retryDelay;
    let didWait = false;
    let acquired = false;
    notifyMutexObservers({
        id: observationId,
        key,
        mode: 'local',
        type: 'pending',
        startedAt,
        at: startedAt
    });

    try {
        while (localMutexes.has(key)) {
            throwIfSignalAborted(options.signal, key);
            didWait = true;
            const current = localMutexes.get(key)!;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new MutexAcquisitionError();
            await Promise.race([current.catch(() => {}), sleepOrAbort(Math.min(options.retryDelay, remaining), options.signal, key)]);
        }
        throwIfSignalAborted(options.signal, key);
    } catch (error) {
        notifyMutexObservers({
            id: observationId,
            key,
            mode: 'local',
            type: 'failed',
            startedAt,
            at: Date.now(),
            waited: didWait,
            error
        });
        throw error;
    }

    let release!: () => void;
    const lock = new Promise<void>(resolve => {
        release = resolve;
    });
    localMutexes.set(key, lock);
    acquired = true;
    notifyMutexObservers({
        id: observationId,
        key,
        mode: 'local',
        type: 'acquired',
        startedAt,
        at: Date.now(),
        waited: didWait
    });

    try {
        const context = createMutexContext(key, undefined, new AbortController(), options.signal);
        context.assertNotAborted();
        return await options.fn(didWait, context);
    } catch (error) {
        notifyMutexObservers({
            id: observationId,
            key,
            mode: 'local',
            type: 'error',
            startedAt,
            at: Date.now(),
            waited: didWait,
            error
        });
        throw error;
    } finally {
        if (localMutexes.get(key) === lock) {
            localMutexes.delete(key);
            release();
        }
        if (acquired)
            notifyMutexObservers({
                id: observationId,
                key,
                mode: 'local',
                type: 'released',
                startedAt,
                at: Date.now(),
                waited: didWait
            });
    }
}

async function redisMutexExec<T>(
    key: string,
    options: Required<Pick<MutexOptions<T>, 'fn' | 'retryCount' | 'retryDelay' | 'renewInterval'>> & MutexOptions<T>
): Promise<T> {
    const observationId = randomUUID();
    const startedAt = Date.now();
    const lockId = randomUUID();
    const { client, prefix } = (options.redis ?? getDefaultRedisConnection)();
    const redisKey = `${prefix}:${key}`;
    const lockTtl = options.renewInterval * 3;
    const maxAttempts = Math.max(1, options.retryCount);
    let acquired = false;
    notifyMutexObservers({
        id: observationId,
        key: redisKey,
        mode: 'redis',
        type: 'pending',
        startedAt,
        at: startedAt
    });

    try {
        for (let attempts = 1; attempts <= maxAttempts; attempts++) {
            throwIfSignalAborted(options.signal, redisKey);
            if (Number(await evalRedisScript(client, ACQUIRE_SCRIPT, redisKey, lockId, lockTtl)) === 1) {
                acquired = true;
                notifyMutexObservers({
                    id: observationId,
                    key: redisKey,
                    mode: 'redis',
                    type: 'acquired',
                    startedAt,
                    at: Date.now(),
                    waited: attempts > 1
                });
                const result = await runWithRedisLock(
                    client,
                    redisKey,
                    lockId,
                    lockTtl,
                    options.renewInterval,
                    context => options.fn(attempts > 1, context),
                    options.signal
                );
                notifyMutexObservers({
                    id: observationId,
                    key: redisKey,
                    mode: 'redis',
                    type: 'released',
                    startedAt,
                    at: Date.now(),
                    waited: attempts > 1
                });
                return result;
            }

            if (attempts < maxAttempts) {
                await sleepOrAbort(options.retryDelay, options.signal, redisKey);
            }
        }

        throw new MutexAcquisitionError();
    } catch (error) {
        notifyMutexObservers({
            id: observationId,
            key: redisKey,
            mode: 'redis',
            type: acquired ? 'error' : 'failed',
            startedAt,
            at: Date.now(),
            error
        });
        throw error;
    }
}

async function runWithRedisLock<T>(
    client: RedisMutexClient,
    key: string,
    lockId: string,
    lockTtl: number,
    renewInterval: number,
    fn: (context: MutexContext) => Promise<T>,
    parentSignal?: AbortSignal
): Promise<T> {
    throwIfSignalAborted(parentSignal, key);
    const abortController = new AbortController();
    let rejectRenewal!: (error: unknown) => void;
    const renewalFailure = new Promise<never>((_, reject) => {
        rejectRenewal = reject;
    });
    const context = createMutexContext(key, lockId, abortController);
    let lockFailed = false;
    let interval: NodeJS.Timeout | undefined;
    const failLock = (error: Error) => {
        if (lockFailed) return;
        lockFailed = true;
        if (interval) clearInterval(interval);
        rejectRenewal(error);
        abortController.abort(error);
    };
    const abortFromParent = () => failLock(getAbortError(parentSignal, key));
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    interval = setInterval(
        () => {
            evalRedisScript(client, RENEW_SCRIPT, key, lockId, lockTtl)
                .then(result => {
                    if (Number(result) !== 1) failLock(new MutexAcquisitionError(`Key missing or value mismatch for ${key}`));
                })
                .catch(error => failLock(new MutexAcquisitionError(`Failed to renew mutex ${key} ${lockId}: ${String(error)}`)));
        },
        Math.max(1, Math.floor(renewInterval / 2))
    );

    const callback = Promise.resolve().then(() => {
        context.assertNotAborted();
        return fn(context);
    });
    let lockError: unknown;
    let result: T | undefined;
    let errorToThrow: unknown;
    try {
        result = await Promise.race([
            callback,
            renewalFailure.catch(error => {
                lockError = error;
                throw error;
            })
        ]);
    } catch (error) {
        if (lockError !== undefined) await callback.catch(() => {});
        errorToThrow = error;
    } finally {
        parentSignal?.removeEventListener('abort', abortFromParent);
        if (interval) clearInterval(interval);
        const releaseResult = await evalRedisScript(client, RELEASE_SCRIPT, key, lockId).catch(error => {
            console.warn(`Failed to release mutex ${key} ${lockId}`, error);
            return undefined;
        });
        if (releaseResult !== undefined && Number(releaseResult) !== 1 && !lockFailed && errorToThrow === undefined) {
            errorToThrow = new MutexAcquisitionError(`Failed to release mutex ${key} ${lockId}: key missing or value mismatch`);
        }
    }

    if (errorToThrow !== undefined) throw errorToThrow;
    return result as T;
}

function createMutexContext(key: string, lockId?: string, abortController = new AbortController(), parentSignal?: AbortSignal): MutexContext {
    if (parentSignal?.aborted) abortController.abort(parentSignal.reason);
    else
        parentSignal?.addEventListener('abort', () => abortController.abort(parentSignal.reason), {
            once: true
        });

    return {
        key,
        lockId,
        signal: abortController.signal,
        assertNotAborted() {
            if (!abortController.signal.aborted) return;
            const reason = abortController.signal.reason;
            throw reason instanceof Error ? reason : new MutexAcquisitionError(`Mutex ${key} was aborted`);
        }
    };
}

function createCompositeMutexContext(contexts: MutexContext[], parentSignal?: AbortSignal): MutexContext {
    if (contexts.length === 0) return createMutexContext('', undefined, new AbortController(), parentSignal);
    if (contexts.length === 1 && !parentSignal) return contexts[0];

    const abortController = new AbortController();
    for (const context of contexts) {
        if (context.signal.aborted) {
            abortCompositeMutexContext(abortController, context);
            break;
        }
        context.signal.addEventListener('abort', () => abortCompositeMutexContext(abortController, context), { once: true });
    }
    if (parentSignal?.aborted) abortController.abort(parentSignal.reason);
    else
        parentSignal?.addEventListener('abort', () => abortController.abort(parentSignal.reason), {
            once: true
        });

    return {
        key: contexts.map(context => context.key).join(','),
        signal: abortController.signal,
        assertNotAborted() {
            for (const context of contexts) context.assertNotAborted();
            throwIfSignalAborted(parentSignal, contexts.map(context => context.key).join(','));
            if (!abortController.signal.aborted) return;
            const reason = abortController.signal.reason;
            throw reason instanceof Error ? reason : new MutexAcquisitionError('Mutex group was aborted');
        }
    };
}

function abortCompositeMutexContext(abortController: AbortController, context: MutexContext): void {
    if (abortController.signal.aborted) return;
    abortController.abort(context.signal.reason);
}

function orderMutexKeys(keys: Array<MutexOptions<unknown>['key']>): Array<MutexOptions<unknown>['key']> {
    const seen = new Set<string>();
    return [...keys]
        .map(key => ({ key, flattened: flattenMutexKey(key) }))
        .sort((a, b) => a.flattened.localeCompare(b.flattened))
        .filter(({ flattened }) => {
            if (seen.has(flattened)) return false;
            seen.add(flattened);
            return true;
        })
        .map(({ key }) => key);
}

function evalRedisScript(client: RedisMutexClient, script: string, key: string, ...args: Array<string | number>): Promise<unknown> {
    return Promise.resolve().then(() => client.eval(script, 1, key, ...args));
}

function sleepOrAbort(ms: number, signal: AbortSignal | undefined, key: string): Promise<void> {
    if (!signal) return sleepMs(ms);
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(getAbortError(signal, key));
            return;
        }

        const cleanup = () => signal.removeEventListener('abort', handleAbort);
        const timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const handleAbort = () => {
            clearTimeout(timeout);
            cleanup();
            reject(getAbortError(signal, key));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
    });
}

function throwIfSignalAborted(signal: AbortSignal | undefined, key: string): void {
    if (!signal?.aborted) return;
    throw getAbortError(signal, key);
}

function getAbortError(signal: AbortSignal | undefined, key: string): Error {
    const reason = signal?.reason;
    return reason instanceof Error ? reason : new MutexAcquisitionError(`Mutex ${key} was aborted`);
}

function getDefaultRedisConnection(): RedisConnection<RedisMutexClient> {
    defaultRedisConnection ??= createRedis('MUTEX') as RedisConnection<RedisMutexClient>;
    return defaultRedisConnection;
}

export function resetMutexRedisConnection(): void {
    defaultRedisConnection = undefined;
}

function notifyMutexObservers(entry: MutexObservation): void {
    for (const observer of mutexObservers) {
        try {
            observer(entry);
        } catch {
            // Observers must never affect mutex behavior.
        }
    }
}

function getConfiguredMutexMode(): 'local' | 'redis' {
    try {
        return getAppConfig().MUTEX_MODE ?? 'local';
    } catch {
        return 'local';
    }
}
