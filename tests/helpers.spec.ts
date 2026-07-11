import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, it } from 'node:test';

import {
    assertInput,
    asyncMap,
    BaseAppConfig,
    Cache,
    chunk,
    createApp,
    createSemaphore,
    createRedisOptions,
    extractDate,
    extractKV,
    extractUpdates,
    execProcess,
    fromJson,
    getContext,
    getContextProp,
    getErrorMessage,
    getPackageName,
    getPackageVersion,
    isValidEmail,
    MutexAcquisitionError,
    objectEntries,
    objectKeys,
    patchObject,
    PipeError,
    removeContextProp,
    resetCacheRedisConnection,
    resetMutexRedisConnection,
    resetPackageJsonCache,
    safePipe,
    safeJsonStringify,
    setContextProp,
    sleepMs,
    toArray,
    toError,
    toJson,
    Transformer,
    tryOrError,
    tryOrErrorSync,
    unique,
    withResourceCleanup,
    withMutex,
    withMutexes,
    uuid4,
    uuid7FromDate,
    withContext,
    withContextData
} from '../src';
import { flattenMutexKey as flattenHelperMutexKey } from '../src/helpers';

describe('helper utilities', () => {
    it('supports array helpers', async () => {
        assert.deepStrictEqual(toArray('a'), ['a']);
        assert.deepStrictEqual(toArray(['a']), ['a']);
        assert.deepStrictEqual(unique([1, 1, 2]), [1, 2]);
        assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
        assert.deepStrictEqual(await asyncMap([1, 2, 3], async value => value * 2), [2, 4, 6]);
    });

    it('supports object helpers', () => {
        const state = { name: 'Alice', details: { age: 30, city: 'NYC' }, unchanged: true };
        const updates = extractUpdates(
            state,
            { name: 'Alice', details: { age: 31 }, unchanged: true } as Partial<typeof state>,
            undefined,
            'matches'
        );

        assert.deepStrictEqual(objectKeys(state), ['name', 'details', 'unchanged']);
        assert.deepStrictEqual(objectEntries({ a: 1 }), [['a', 1]]);
        assert.deepStrictEqual(updates, { details: { age: 31 } });
        assert.deepStrictEqual(patchObject({ a: 1, b: 2 }, { a: 2 }), { a: 2, b: 2 });
        assert.deepStrictEqual(extractKV([{ id: 'a', value: 1 }], 'id', 'value'), { a: 1 });
    });

    it('supports transformer helper chains', async () => {
        const result = await Transformer.create([
            { id: 1, name: 'Alice', secret: 'hidden' },
            { id: 2, name: 'Bob', secret: 'hidden' }
        ])
            .narrow('id', 'name')
            .applyEach(item => ({ ...item, label: `${item.id}:${item.name}` }))
            .applyEachAsync(async item => ({ ...item, asyncLabel: item.label.toUpperCase() }))
            .get();

        assert.deepStrictEqual(result, [
            { id: 1, name: 'Alice', label: '1:Alice', asyncLabel: '1:ALICE' },
            { id: 2, name: 'Bob', label: '2:Bob', asyncLabel: '2:BOB' }
        ]);

        assert.deepStrictEqual(
            await Transformer.create([1])
                .applyEach(value => value + 1, false)
                .get(),
            [1]
        );
        await assert.rejects(() => Transformer.create([1]).execute(), /No executor defined/);
    });

    it('supports date, semaphore, validation, and error helpers', async () => {
        const semaphore = createSemaphore();
        let released = false;
        const wait = semaphore.promise.then(() => {
            released = true;
        });

        semaphore.release();
        await wait;
        await sleepMs(0);

        assert.equal(released, true);
        assert.equal(extractDate(new Date('2024-01-02T03:04:05Z')), '2024-01-02');
        assert.equal(isValidEmail('test@example.com'), true);
        assert.equal(isValidEmail('bad'), false);
        assert.doesNotThrow(() => assertInput('value', 'field'));
        assert.throws(() => assertInput('', 'field'), /field is required/);

        const error = toError('message', new Error('cause'));
        assert.equal(getErrorMessage(error), 'message');
        assert.equal((error as Error & { cause?: Error }).cause?.message, 'cause');
        assert.ok(
            tryOrErrorSync(() => {
                throw new Error('sync');
            }) instanceof Error
        );
        assert.ok(
            (await tryOrError(async () => {
                throw new Error('async');
            })) instanceof Error
        );
    });

    it('supports async context helpers', async () => {
        assert.equal(getContext(), undefined);

        await withContext(async () => {
            setContextProp('name', 'outer');
            assert.equal(getContextProp('name'), 'outer');
            await withContextData({ name: 'inner', extra: 7 }, async () => {
                assert.equal(getContextProp('name'), 'inner');
                assert.equal(getContextProp('extra'), 7);
            });
            assert.equal(getContextProp('name'), 'outer');
            removeContextProp('name');
            assert.equal(getContextProp('name'), undefined);
        });
    });

    it('supports local mutex helpers', async () => {
        const firstEntered = createSemaphore();
        const releaseFirst = createSemaphore();
        let secondDidWait = false;

        const first = withMutex({
            key: ['local', 'mutex'],
            fn: async didWait => {
                assert.equal(didWait, false);
                firstEntered.release();
                await releaseFirst.promise;
                return 'first';
            }
        });
        await firstEntered.promise;

        const second = withMutex({
            key: ['local', 'mutex'],
            retryCount: 100,
            retryDelay: 1,
            fn: async didWait => {
                secondDidWait = didWait;
                return 'second';
            }
        });

        await sleepMs(5);
        releaseFirst.release();

        assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second']);
        assert.equal(secondDidWait, true);
        assert.equal(await withMutexes({ keys: ['a', 'b'], fn: async didWait => didWait }), false);
        assert.equal(flattenHelperMutexKey(['a', 1, null, 7n]), 'a:1:null:7');
        assert.match(flattenHelperMutexKey({ a: 1 }), /^[0-9a-f]{32}$/);
    });

    it('preserves didWait across nested mutex helpers', async () => {
        const firstEntered = createSemaphore();
        const releaseFirst = createSemaphore();
        const first = withMutex({
            key: 'nested-wait-a',
            fn: async () => {
                firstEntered.release();
                await releaseFirst.promise;
            }
        });
        await firstEntered.promise;

        const second = withMutexes({
            keys: ['nested-wait-a', 'nested-wait-b'],
            retryCount: 100,
            retryDelay: 1,
            fn: async didWait => didWait
        });

        await sleepMs(5);
        releaseFirst.release();

        assert.equal(await second, true);
        await first;
    });

    it('supports Redis mutex mode with retry and release', async () => {
        resetMutexRedisConnection();
        let acquireAttempts = 0;
        const calls: string[] = [];
        const fakeRedis = {
            eval: async (script: string, _numberOfKeys: 1, key: string, ...args: Array<string | number>) => {
                calls.push(`${script.includes('exists') ? 'acquire' : script.includes('pexpire') ? 'renew' : 'release'}:${key}`);
                if (script.includes('exists')) return ++acquireAttempts === 1 ? 0 : 1;
                if (script.includes('pexpire')) return 1;
                if (script.includes('del')) return 1;
                throw new Error(`unexpected script ${args.join(',')}`);
            }
        };

        const result = await withMutex({
            key: ['redis', 'lock'],
            mode: 'redis',
            retryCount: 3,
            retryDelay: 1,
            renewInterval: 1000,
            redis: () => ({ prefix: 'unit', client: fakeRedis }),
            fn: async didWait => `waited:${didWait}`
        });
        await sleepMs(0);

        assert.equal(result, 'waited:true');
        assert.deepStrictEqual(calls, ['acquire:unit:redis:lock', 'acquire:unit:redis:lock', 'release:unit:redis:lock']);
    });

    it('resolves prefixed Redis connection options from app config', () => {
        process.env.APP_ENV = 'test';
        process.env.REDIS_HOST = 'redis-default';
        process.env.REDIS_PORT = '6379';
        process.env.REDIS_PREFIX = 'default-prefix';
        process.env.CACHE_REDIS_HOST = 'redis-cache';
        process.env.CACHE_REDIS_PORT = '6380';
        process.env.CACHE_REDIS_PREFIX = 'cache-prefix';
        process.env.MUTEX_REDIS_HOST = 'redis-mutex';
        process.env.BROADCAST_REDIS_HOST = 'redis-broadcast';
        process.env.MESH_REDIS_HOST = 'redis-mesh';
        process.env.BULL_REDIS_HOST = 'redis-bull';
        process.env.BULL_REDIS_PREFIX = 'bull-prefix';

        createApp({ config: BaseAppConfig });

        const defaultRedis = createRedisOptions();
        const cacheRedis = createRedisOptions('CACHE');
        const mutexRedis = createRedisOptions('MUTEX');
        const broadcastRedis = createRedisOptions('BROADCAST');
        const meshRedis = createRedisOptions('MESH');
        const bullRedis = createRedisOptions('BULL');

        assert.equal(defaultRedis.options.host, 'redis-default');
        assert.equal(defaultRedis.prefix, 'default-prefix');
        assert.equal(cacheRedis.options.host, 'redis-cache');
        assert.equal(cacheRedis.options.port, 6380);
        assert.equal(cacheRedis.prefix, 'cache-prefix');
        assert.equal(mutexRedis.options.host, 'redis-mutex');
        assert.equal(mutexRedis.prefix, 'default-prefix');
        assert.equal(broadcastRedis.options.host, 'redis-broadcast');
        assert.equal(meshRedis.options.host, 'redis-mesh');
        assert.equal(bullRedis.options.host, 'redis-bull');
        assert.equal(bullRedis.prefix, 'bull-prefix');
    });

    it('aborts Redis mutex callbacks when lock renewal fails', async () => {
        resetMutexRedisConnection();
        const calls: string[] = [];
        let sawAbort = false;
        let assertionThrew = false;
        let cleanupDone = false;
        let releasedBeforeCleanup = false;
        const fakeRedis = {
            eval: async (script: string, _numberOfKeys: 1, key: string) => {
                calls.push(`${script.includes('exists') ? 'acquire' : script.includes('pexpire') ? 'renew' : 'release'}:${key}`);
                if (script.includes('exists')) return 1;
                if (script.includes('pexpire')) return 0;
                if (script.includes('del')) {
                    releasedBeforeCleanup = !cleanupDone;
                    return 0;
                }
                throw new Error('unexpected script');
            }
        };

        await assert.rejects(
            () =>
                withMutex({
                    key: ['redis', 'abort'],
                    mode: 'redis',
                    retryCount: 1,
                    retryDelay: 1,
                    renewInterval: 10,
                    redis: () => ({ prefix: 'unit', client: fakeRedis }),
                    fn: async (_didWait, context) => {
                        assert.ok(context);
                        assert.equal(context.signal.aborted, false);
                        assert.equal(context.key, 'unit:redis:abort');
                        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
                        sawAbort = true;
                        assert.equal(context.signal.reason instanceof MutexAcquisitionError, true);
                        try {
                            context.assertNotAborted();
                        } catch (error) {
                            assertionThrew = error instanceof MutexAcquisitionError;
                        }
                        await sleepMs(1);
                        cleanupDone = true;
                        return 'ignored';
                    }
                }),
            error => error instanceof MutexAcquisitionError && /Key missing or value mismatch/.test(error.message)
        );

        assert.equal(sawAbort, true);
        assert.equal(assertionThrew, true);
        assert.equal(releasedBeforeCleanup, false);
        assert.deepStrictEqual(calls, ['acquire:unit:redis:abort', 'renew:unit:redis:abort', 'release:unit:redis:abort']);
    });

    it('does not enter nested Redis mutex callbacks after an outer lock aborts during inner acquisition', async () => {
        resetMutexRedisConnection();
        let callbackEntered = false;
        const calls: string[] = [];
        const fakeRedis = {
            eval: async (script: string, _numberOfKeys: 1, key: string) => {
                calls.push(`${script.includes('exists') ? 'acquire' : script.includes('pexpire') ? 'renew' : 'release'}:${key}`);
                if (script.includes('exists')) return key.endsWith(':a-outer') ? 1 : 0;
                if (script.includes('pexpire')) return key.endsWith(':a-outer') ? 0 : 1;
                if (script.includes('del')) return 0;
                throw new Error('unexpected script');
            }
        };

        await assert.rejects(
            () =>
                withMutexes({
                    keys: ['a-outer', 'b-inner'],
                    mode: 'redis',
                    retryCount: 20,
                    retryDelay: 5,
                    renewInterval: 10,
                    redis: () => ({ prefix: 'unit', client: fakeRedis }),
                    fn: async () => {
                        callbackEntered = true;
                        return 'should-not-run';
                    }
                }),
            error => error instanceof MutexAcquisitionError && /Key missing or value mismatch/.test(error.message)
        );

        assert.equal(callbackEntered, false);
        assert.deepStrictEqual(calls.slice(0, 4), ['acquire:unit:a-outer', 'acquire:unit:b-inner', 'renew:unit:a-outer', 'release:unit:a-outer']);
    });

    it('propagates outer Redis mutex aborts through nested mutex contexts', async () => {
        resetMutexRedisConnection();
        let sawAbort = false;
        const fakeRedis = {
            eval: async (script: string, _numberOfKeys: 1, key: string) => {
                if (script.includes('exists')) return 1;
                if (script.includes('pexpire')) return key.includes('outer') ? 0 : 1;
                if (script.includes('del')) return 0;
                throw new Error('unexpected script');
            }
        };

        await assert.rejects(
            () =>
                withMutexes({
                    keys: ['outer', 'inner'],
                    mode: 'redis',
                    retryCount: 1,
                    retryDelay: 1,
                    renewInterval: 10,
                    redis: () => ({ prefix: 'unit', client: fakeRedis }),
                    fn: async (_didWait, context) => {
                        assert.ok(context);
                        assert.match(context.key, /outer/);
                        assert.match(context.key, /inner/);
                        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
                        sawAbort = true;
                        assert.throws(() => context.assertNotAborted(), MutexAcquisitionError);
                        return 'ignored';
                    }
                }),
            error => error instanceof MutexAcquisitionError && /Key missing or value mismatch/.test(error.message)
        );

        assert.equal(sawAbort, true);
    });

    it('orders multi-key Redis mutex acquisition to avoid inverse-order deadlocks', async () => {
        resetMutexRedisConnection();
        const store = new Map<string, string>();
        const firstEntered = createSemaphore();
        const releaseFirst = createSemaphore();
        let secondDidWait = false;
        const fakeRedis = {
            eval: async (script: string, _numberOfKeys: 1, key: string, lockId: string) => {
                if (script.includes('exists')) {
                    if (store.has(key)) return 0;
                    store.set(key, lockId);
                    return 1;
                }
                if (script.includes('pexpire')) return store.get(key) === lockId ? 1 : 0;
                if (script.includes('del')) {
                    if (store.get(key) !== lockId) return 0;
                    store.delete(key);
                    return 1;
                }
                throw new Error('unexpected script');
            }
        };

        const first = withMutexes({
            keys: ['b', 'a'],
            mode: 'redis',
            retryCount: 100,
            retryDelay: 1,
            renewInterval: 1000,
            redis: () => ({ prefix: 'unit', client: fakeRedis }),
            fn: async didWait => {
                assert.equal(didWait, false);
                firstEntered.release();
                await releaseFirst.promise;
                return 'first';
            }
        });
        await firstEntered.promise;

        const second = withMutexes({
            keys: ['a', 'b'],
            mode: 'redis',
            retryCount: 100,
            retryDelay: 1,
            renewInterval: 1000,
            redis: () => ({ prefix: 'unit', client: fakeRedis }),
            fn: async didWait => {
                secondDidWait = didWait;
                return 'second';
            }
        });

        await sleepMs(5);
        releaseFirst.release();

        assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second']);
        assert.equal(secondDidWait, true);
        assert.equal(store.size, 0);
    });

    it('rejects Redis mutexes that lose ownership before normal release', async () => {
        resetMutexRedisConnection();
        const fakeRedis = {
            eval: async (script: string) => {
                if (script.includes('exists')) return 1;
                if (script.includes('pexpire')) return 1;
                if (script.includes('del')) return 0;
                throw new Error('unexpected script');
            }
        };

        await assert.rejects(
            () =>
                withMutex({
                    key: 'release-mismatch',
                    mode: 'redis',
                    retryCount: 1,
                    retryDelay: 1,
                    renewInterval: 1000,
                    redis: () => ({ prefix: 'unit', client: fakeRedis }),
                    fn: async () => 'done'
                }),
            error => error instanceof MutexAcquisitionError && /Failed to release mutex/.test(error.message)
        );
    });

    it('builds Redis options and supports cache helpers', async t => {
        const originalConfigPath = process.env.CONFIG_PATH;
        process.env.CONFIG_PATH = join(tmpdir(), `tsf-empty-config-${process.pid}-${Date.now()}`);
        t.after(() => {
            if (originalConfigPath === undefined) delete process.env.CONFIG_PATH;
            else process.env.CONFIG_PATH = originalConfigPath;
        });

        process.env.APP_ENV = 'test';
        delete process.env.REDIS_HOST;
        delete process.env.REDIS_PORT;
        delete process.env.REDIS_PREFIX;
        delete process.env.REDIS_SENTINEL_HOST;
        delete process.env.REDIS_SENTINEL_PORT;
        delete process.env.REDIS_SENTINEL_NAME;
        delete process.env.CACHE_REDIS_HOST;
        delete process.env.CACHE_REDIS_PORT;
        delete process.env.CACHE_REDIS_PREFIX;
        delete process.env.CACHE_REDIS_SENTINEL_HOST;
        delete process.env.CACHE_REDIS_SENTINEL_PORT;
        delete process.env.CACHE_REDIS_SENTINEL_NAME;

        class RedisConfig extends BaseAppConfig {
            REDIS_HOST = 'redis.local';
            REDIS_PORT = 6380;
            REDIS_PREFIX = 'root-prefix';
            CACHE_REDIS_HOST = 'cache.local';
            CACHE_REDIS_PORT = 6381;
            CACHE_REDIS_PREFIX = 'cache-prefix';
        }

        createApp({ config: RedisConfig, enableHealthcheck: false });
        resetCacheRedisConnection();

        assert.deepStrictEqual(createRedisOptions(), {
            prefix: 'root-prefix',
            options: {
                host: 'redis.local',
                port: 6380
            }
        });
        assert.deepStrictEqual(createRedisOptions('CACHE'), {
            prefix: 'cache-prefix',
            options: {
                host: 'cache.local',
                port: 6381
            }
        });

        const store = new Map<string, string>();
        const sets: Array<{ key: string; value: string; ttl: number }> = [];
        const cache = new Cache(() => ({
            prefix: 'unit',
            client: {
                get: (key: string) => store.get(key) ?? null,
                set: (key: string, value: string, _mode: 'EX', ttl: number) => {
                    sets.push({ key, value, ttl });
                    store.set(key, value);
                }
            }
        }));

        await cache.set('plain', 'value', 10);
        await cache.setObj('object', { ok: true }, 20);

        assert.equal(await cache.get('plain'), 'value');
        assert.deepStrictEqual(await cache.getObj('object'), { ok: true });
        assert.deepStrictEqual(sets, [
            { key: 'unit:cache:plain', value: 'value', ttl: 10 },
            { key: 'unit:cache:object', value: '{"ok":true}', ttl: 20 }
        ]);
    });

    it('times out local mutex acquisition', async () => {
        const entered = createSemaphore();
        const release = createSemaphore();
        const first = withMutex({
            key: 'timeout-mutex',
            fn: async () => {
                entered.release();
                await release.promise;
            }
        });
        await entered.promise;

        await assert.rejects(
            () =>
                withMutex({
                    key: 'timeout-mutex',
                    retryCount: 1,
                    retryDelay: 5,
                    fn: async () => 'late'
                }),
            error => error instanceof MutexAcquisitionError
        );

        release.release();
        await first;
    });

    it('supports serialization and uuid helpers', () => {
        const circular: Record<string, unknown> = { name: 'root' };
        circular.self = circular;
        const serialized = toJson({ ok: true });
        const uuid = uuid7FromDate(new Date('2024-01-02T03:04:05.006Z'));
        const randomId = uuid4();

        assert.deepStrictEqual(fromJson(serialized), { ok: true });
        assert.deepStrictEqual(JSON.parse(safeJsonStringify(circular)), {
            name: 'root',
            self: '[Circular]'
        });
        assert.match(uuid, /^018cc820-d88e-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.match(randomId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates monotonic UUIDv7 values within a timestamp', () => {
        const date = new Date('2024-01-02T03:04:05.006Z');
        const ids = Array.from({ length: 20 }, () => uuid7FromDate(date));
        assert.deepStrictEqual([...ids].sort(), ids);
    });

    it('supports process execution helpers', async () => {
        let spawned = false;
        const result = await execProcess(process.execPath, ['-e', "process.stdout.write('ok'); process.stderr.write('warn')"], {
            onSpawn: () => {
                spawned = true;
            }
        });

        assert.equal(spawned, true);
        assert.equal(result.code, 0);
        assert.equal(result.stdout.toString(), 'ok');
        assert.equal(result.stderr.toString(), 'warn');

        const nonZero = await execProcess(process.execPath, ['-e', 'process.exit(7)'], {
            errorOnNonZero: false
        });
        assert.equal(nonZero.code, 7);

        await assert.rejects(
            () => execProcess(process.execPath, ['-e', 'process.exit(2)']),
            error =>
                error instanceof Error &&
                /Failure during execution of process/.test(error.message) &&
                error.cause instanceof Error &&
                error.cause.message === 'Process exited with code 2'
        );

        await assert.rejects(
            () =>
                execProcess(process.execPath, ['-e', "setTimeout(() => process.stdout.write('late'), 20)"], {
                    onSpawn: () => {
                        throw new Error('spawn callback failed');
                    }
                }),
            error =>
                error instanceof Error &&
                /Failure during execution of process/.test(error.message) &&
                error.cause instanceof Error &&
                error.cause.message === 'spawn callback failed'
        );
    });

    it('supports package metadata helpers', () => {
        resetPackageJsonCache();
        assert.equal(getPackageName(), '@zyno-io/ts-server-foundation');
        assert.match(getPackageVersion() ?? '', /^\d+\.\d+\.\d+/);
    });

    it('supports stream helpers and resource cleanup', async () => {
        let piped = '';
        const output = new Writable({
            write(chunk, _encoding, callback) {
                piped += chunk.toString();
                callback();
            }
        });

        await safePipe(Readable.from(['alpha', '-', 'beta']), output);
        assert.equal(piped, 'alpha-beta');

        const failedInput = new Readable({
            read() {
                this.destroy(new Error('read failed'));
            }
        });
        await assert.rejects(
            () =>
                safePipe(
                    failedInput,
                    new Writable({
                        write(_chunk, _encoding, callback) {
                            callback();
                        }
                    })
                ),
            error => error instanceof PipeError && error.side === 'input' && error.cause.message === 'read failed'
        );

        const tempFile = join(tmpdir(), `tsf-resource-${process.pid}-${Date.now()}`);
        const stream = new PassThrough();
        const cleanupResult = await withResourceCleanup(async tracker => {
            await writeFile(tempFile, 'temporary');
            tracker.addFile(tempFile);
            tracker.addStream(stream);
            return 'cleaned';
        });

        assert.equal(cleanupResult, 'cleaned');
        assert.equal(stream.destroyed, true);
        await assert.rejects(
            () => access(tempFile),
            error => (error as NodeJS.ErrnoException).code === 'ENOENT'
        );

        let observedError: unknown;
        await assert.rejects(
            () =>
                withResourceCleanup(
                    async () => {
                        throw new Error('cleanup failure');
                    },
                    error => {
                        observedError = error;
                    }
                ),
            /cleanup failure/
        );
        assert.ok(observedError instanceof Error);
        assert.equal(observedError.message, 'cleanup failure');

        const failedStreamFile = join(tmpdir(), `tsf-resource-stream-error-${process.pid}-${Date.now()}`);
        const failedStream = new PassThrough();
        await assert.rejects(
            () =>
                withResourceCleanup(async tracker => {
                    tracker.addStream(failedStream);
                    failedStream.destroy(new Error('tracked stream failed'));
                    await sleepMs(0);
                    await writeFile(failedStreamFile, 'late temporary');
                    tracker.addFile(failedStreamFile);
                    return 'ignored';
                }),
            /tracked stream failed/
        );
        await assert.rejects(
            () => access(failedStreamFile),
            error => (error as NodeJS.ErrnoException).code === 'ENOENT'
        );
    });
});
