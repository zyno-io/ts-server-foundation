import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

interface WorkerResult {
    namespace: string;
    prefixes: Record<string, string>;
    databaseName: string;
}

function runWorkers(namespace?: string, liveRedis = false): WorkerResult[] {
    const directory = mkdtempSync(join(tmpdir(), 'tsf-worker-isolation-'));
    try {
        const tests = join(directory, 'dist', 'tests');
        mkdirSync(tests, { recursive: true });
        writeFileSync(join(directory, 'package.json'), '{"name":"worker-isolation-fixture"}');
        for (const id of ['a', 'b']) {
            writeFileSync(
                join(tests, `${id}.spec.js`),
                `
                const { test } = require('node:test');
                const initialNamespace = process.env.TSF_TEST_NAMESPACE;
                const { runIsolationWorker } = require(${JSON.stringify(join(__dirname, 'fixtures/test-worker.js'))});
                test('worker ${id}', () => runIsolationWorker(${JSON.stringify(id)}, initialNamespace));
            `
            );
        }
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        delete env.TSF_TSCONFIG;
        delete env.TSF_TEST_NAMESPACE;
        if (namespace !== undefined) env.TSF_TEST_NAMESPACE = namespace;
        const result = spawnSync(process.execPath, [join(__dirname, '../src/cli/tsf-test.js'), '--test-concurrency=2'], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
                ...env,
                TSF_TEST_MYSQL_SESSION_MANAGER: '0',
                TSF_TEST_WORKER_FIXTURE_DIR: directory,
                TSF_TEST_WORKER_FIXTURE_LIVE_REDIS: liveRedis ? '1' : '0'
            }
        });
        assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
        return ['a', 'b'].map(id => JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8')) as WorkerResult);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

it(
    'isolates Redis caches and broadcast subscribers across parallel test workers',
    {
        skip: process.env.REDIS_HOST ? false : 'set REDIS_HOST to run Redis test isolation integration'
    },
    () => {
        const workers = runWorkers(undefined, true);
        assert.notEqual(workers[0].namespace, workers[1].namespace);
        for (const utility of ['', 'CACHE', 'MUTEX', 'BROADCAST', 'MESH', 'BULL']) {
            assert.notEqual(workers[0].prefixes[utility], workers[1].prefixes[utility]);
        }
    }
);

it('shares a fresh resource namespace before test imports across workers and separate runs', () => {
    const first = runWorkers();
    const second = runWorkers();
    const namespaces = [...first, ...second].map(worker => worker.namespace);
    assert.ok(namespaces.every(namespace => typeof namespace === 'string' && namespace.length > 0));
    assert.equal(new Set(namespaces).size, 4);
    for (const worker of [...first, ...second]) {
        assert.equal(worker.prefixes[''], `same-application:test:${worker.namespace}`);
        assert.ok(worker.databaseName.includes(`_${worker.namespace}_`));
        assert.match(worker.databaseName, /^[a-zA-Z0-9_]+$/);
        assert.ok(worker.databaseName.length <= 63);
    }
});

it('preserves explicit shared resource namespaces and allows opting out', () => {
    for (const namespace of ['shared_fixture', '']) {
        const workers = runWorkers(namespace);
        for (const worker of workers) {
            assert.equal(worker.namespace, namespace);
            const suffix = namespace ? ':test:shared_fixture' : '';
            assert.equal(worker.prefixes[''], `same-application${suffix}`);
            assert.equal(worker.prefixes.CACHE, `same-application${suffix}`);
            assert.equal(worker.prefixes.BROADCAST, `same-broadcast${suffix}`);
            assert.equal(worker.prefixes.BULL, `same-queue${suffix}`);
            if (namespace) assert.ok(worker.databaseName.includes('_shared_fixture_'));
        }
    }
});
