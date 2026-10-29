import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createApp, createDistributedMethod, createRedis, createRedisOptions, Env, LeaderService } from '../../src';
import { formatTestDatabaseName } from '../../src/testing/database-name';

export async function runIsolationWorker(id: string, initialNamespace: string | undefined): Promise<void> {
    assert.equal(Env.TSF_TEST_NAMESPACE, initialNamespace, 'the worker namespace must exist before importing resource helpers');
    const directory = Env.TSF_TEST_WORKER_FIXTURE_DIR!;
    const appOptions = {
        enableHealthcheck: false,
        defaultConfig: {
            REDIS_PREFIX: 'same-application',
            BROADCAST_REDIS_PREFIX: 'same-broadcast',
            BULL_REDIS_PREFIX: 'same-queue'
        }
    };
    const app = createApp(appOptions);
    const prefixes = Object.fromEntries(['', 'CACHE', 'MUTEX', 'BROADCAST', 'MESH', 'BULL'].map(name => [name, createRedisOptions(name).prefix]));
    let cleanup: (() => Promise<unknown>) | undefined;
    let leader: LeaderService | undefined;

    try {
        // A helper inherits the worker's namespace without requiring a Node test context or preload.
        const helperEnv = { ...process.env };
        delete helperEnv.NODE_TEST_CONTEXT;
        const helper = spawnSync(
            process.execPath,
            [
                '-e',
                `
            const { createApp, createRedisOptions } = require(${JSON.stringify(join(__dirname, '../../src'))});
            createApp(${JSON.stringify(appOptions)});
            process.stdout.write(JSON.stringify(createRedisOptions().prefix));
        `
            ],
            { encoding: 'utf8', timeout: 20_000, env: helperEnv }
        );
        assert.equal(helper.status, 0, helper.stderr);
        assert.equal(JSON.parse(helper.stdout), prefixes['']);

        if (Env.TSF_TEST_WORKER_FIXTURE_LIVE_REDIS === '1') {
            const workerLeader = new LeaderService('same-leader', { ttlMs: 1_000, renewalIntervalMs: 250, retryDelayMs: 50 });
            leader = workerLeader;
            workerLeader.start();
            await waitFor(async () => workerLeader.isLeader);
            const { client, prefix } = createRedis('CACHE');
            const key = `${prefix}:same-key`;
            cleanup = () => client.del(key);
            let flushes = 0;
            const flush = createDistributedMethod({ name: 'same-flush' }, async () => {
                flushes++;
            });
            const channel = `${prefixes.BROADCAST}:broadcast`;
            await waitFor(async () => {
                const subscribers = await client.pubsub('NUMSUB', channel);
                return Number(subscribers[1]) > 0;
            });
            await client.set(key, id, 'EX', 30);
            writeFileSync(join(directory, `${id}.ready`), '');
            await waitFor(async () => existsSync(join(directory, 'a.ready')) && existsSync(join(directory, 'b.ready')));

            // Both workers wrote the same logical key and subscribed to the same logical event.
            const value = await client.get(key);
            assert.equal(value, id);
            const subscribers = await client.pubsub('NUMSUB', channel);
            assert.equal(Number(subscribers[1]), 1, 'another test worker subscribed to this broadcast namespace');
            await flush(undefined);
            assert.equal(flushes, 1);
        }

        const databaseName = formatTestDatabaseName('worker', [process.pid, 1]);
        writeFileSync(join(directory, `${id}.json`), JSON.stringify({ namespace: Env.TSF_TEST_NAMESPACE, prefixes, databaseName }));
    } finally {
        try {
            await cleanup?.();
        } finally {
            await leader?.stop();
            await app.stop();
        }
    }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (true) {
        const ready = await predicate();
        if (ready) return;
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Redis isolation fixture');
        await sleep(10);
    }
}
