import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { CliServiceCommand, createApp, MySQLDriver, type MySQLPoolLike, onServerShutdown } from '../src';

const originalEnv = { ...process.env };

afterEach(() => {
    process.env = { ...originalEnv };
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(finish => {
        resolve = finish;
    });
    return { promise, resolve };
}

function createServiceApp() {
    process.env.APP_ENV = 'test';
    process.env.DEVCONSOLE_ENABLED = 'false';
    return createApp({ enableHealthcheck: false, frameworkConfig: { port: 0 } });
}

function createPool(order: string[]) {
    let ended = false;
    let acquisitions = 0;
    const pool: MySQLPoolLike = {
        async getConnection() {
            assert.equal(ended, false);
            acquisitions++;
            return {
                async query<T>() {
                    return [[] as T, undefined] as [T, unknown];
                },
                async execute<T>() {
                    return [{} as T, undefined] as [T, unknown];
                },
                release() {}
            };
        },
        async end() {
            ended = true;
            order.push('pool-closed');
        }
    };
    return {
        pool,
        get ended() {
            return ended;
        },
        get acquisitions() {
            return acquisitions;
        }
    };
}

describe('CLI service shutdown', () => {
    for (const shutdown of ['SIGTERM', 'command.stop'] as const) {
        it(`drains an in-flight MySQL task before closing its pool on ${shutdown}`, { timeout: 5000 }, async t => {
            const order: string[] = [];
            const taskStarted = deferred();
            const finishTask = deferred();
            const shutdownEntered = deferred();
            const shutdownHookStarted = deferred();
            const finishShutdownHook = deferred();
            const exited = deferred();
            const exits: unknown[] = [];
            t.mock.method(process, 'exit', (code?: number | string | null) => {
                exits.push(code);
                exited.resolve();
                return undefined as never;
            });
            const app = createServiceApp();
            const pool = createPool(order);
            const driver = new MySQLDriver(pool.pool);
            app.on(onServerShutdown, () => shutdownEntered.resolve(), 10);

            class Service extends CliServiceCommand {
                protected async runService(): Promise<void> {
                    while (this.shouldRun) {
                        const initialConnection = await driver.acquire();
                        await initialConnection.release();
                        taskStarted.resolve();
                        await finishTask.promise;
                        // The current message can need another connection after shutdown is requested.
                        const renewalConnection = await driver.acquire();
                        await renewalConnection.release();
                        order.push('task-finished');
                    }
                }

                protected async shutdownService(): Promise<void> {
                    shutdownHookStarted.resolve();
                    await finishShutdownHook.promise;
                    const connection = await driver.acquire();
                    await connection.release();
                    order.push('service-finished');
                }
            }

            const command = new Service();
            const execution = command.execute();
            try {
                await taskStarted.promise;
                if (shutdown === 'SIGTERM') process.emit('SIGTERM');
                else command.stop();
                const concurrentStop = app.stop();
                let stopFinished = false;
                void concurrentStop.then(() => {
                    stopFinished = true;
                });
                await shutdownEntered.promise;
                await setImmediate();
                assert.equal(pool.ended, false);
                assert.equal(stopFinished, false);
                assert.deepStrictEqual(exits, []);

                finishTask.resolve();
                await shutdownHookStarted.promise;
                await setImmediate();
                assert.equal(pool.acquisitions, 2);
                assert.equal(pool.ended, false);
                assert.equal(stopFinished, false);
                assert.deepStrictEqual(exits, []);

                finishShutdownHook.resolve();
                await Promise.all([execution, concurrentStop]);
                if (shutdown === 'SIGTERM') await exited.promise;
                assert.deepStrictEqual(exits, shutdown === 'SIGTERM' ? [0] : []);
                assert.equal(pool.acquisitions, 3);
                assert.deepStrictEqual(order, ['task-finished', 'service-finished', 'pool-closed']);
                await assert.rejects(() => driver.acquire(), /MySQL pool is closed/);
            } finally {
                finishTask.resolve();
                finishShutdownHook.resolve();
                await execution;
                await app.stop();
            }
        });
    }

    it('drains services without a runService override', { timeout: 5000 }, async () => {
        const started = deferred();
        const order: string[] = [];
        const app = createServiceApp();
        const pool = createPool(order);
        const driver = new MySQLDriver(pool.pool);
        class Service extends CliServiceCommand {
            protected async startService(): Promise<void> {
                started.resolve();
            }

            protected async shutdownService(): Promise<void> {
                const connection = await driver.acquire();
                await connection.release();
                order.push('service-finished');
            }
        }

        const execution = new Service().execute();
        await started.promise;
        await Promise.all([app.stop(), execution]);
        assert.deepStrictEqual(order, ['service-finished', 'pool-closed']);
        await assert.rejects(() => driver.acquire(), /MySQL pool is closed/);
    });

    for (const failure of ['runService', 'shutdownService'] as const) {
        it(`releases the drain barrier when ${failure} fails`, { timeout: 5000 }, async () => {
            const taskStarted = deferred();
            const finishTask = deferred();
            const shutdownEntered = deferred();
            const order: string[] = [];
            const app = createServiceApp();
            const pool = createPool(order);
            const driver = new MySQLDriver(pool.pool);
            app.on(onServerShutdown, () => shutdownEntered.resolve(), 10);
            const error = new Error(`${failure} failed`);
            class Service extends CliServiceCommand {
                protected async runService(): Promise<void> {
                    taskStarted.resolve();
                    await finishTask.promise;
                    if (failure === 'runService') throw error;
                }

                protected async shutdownService(): Promise<void> {
                    if (failure === 'shutdownService') throw error;
                }
            }

            const execution = new Service().execute();
            const rejected = assert.rejects(execution, error);
            await taskStarted.promise;
            const stopping = app.stop();
            await shutdownEntered.promise;
            finishTask.resolve();
            await Promise.all([stopping, rejected]);
            assert.deepStrictEqual(order, ['pool-closed']);
            await assert.rejects(() => driver.acquire(), /MySQL pool is closed/);
        });
    }
});
