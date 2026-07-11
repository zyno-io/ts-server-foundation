import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { BaseAppConfig, BaseJob, createApp, HttpRequest, SrpcClient, WorkerJob, WorkerService } from '../src';
import {
    DevConsoleClientMessage,
    DevConsoleServerMessage,
    type DevConsoleClientMessage as DCClientMsg,
    type DevConsoleServerMessage as DCServerMsg
} from '../src/devconsole/generated/devconsole';
import { DevConsoleStore, RingBuffer, type DevConsoleDatabaseQueryEntry } from '../src/devconsole';

const originalEnv = { ...process.env };

class DevConsoleTestConfig extends BaseAppConfig {
    APP_ENV = 'development';
    API_SECRET = 'do-not-display';
    PUBLIC_LABEL = 'visible';
}

class DevConsoleWorkerTestConfig extends BaseAppConfig {
    APP_ENV = 'test';
    DEVCONSOLE_ENABLED = true;
}

@WorkerJob({ queueName: 'devconsole-history' })
class DevConsoleHistoryJob extends BaseJob<{ index: number }, number> {
    handle(data: { index: number }): number {
        return data.index;
    }
}

afterEach(() => {
    process.env = { ...originalEnv };
});

describe('devconsole', () => {
    it('keeps ring buffers bounded and ordered', () => {
        const buffer = new RingBuffer<number>(3);

        for (const value of [1, 2, 3, 4, 5]) buffer.push(value);

        assert.equal(buffer.length, 3);
        assert.deepStrictEqual(buffer.toArray(), [3, 4, 5]);
        buffer.clear();
        assert.equal(buffer.length, 0);
        assert.deepStrictEqual(buffer.toArray(), []);
    });

    it('updates stored database queries when completion or error events arrive', () => {
        const store = new DevConsoleStore();
        const events: Array<{ type: string; data: unknown }> = [];
        store.onEvent = (type, data) => events.push({ type, data });
        const started: DevConsoleDatabaseQueryEntry = {
            id: 'dbq-1',
            timestamp: Date.now(),
            sql: 'SELECT 1',
            params: [],
            status: 'running'
        };

        store.addDatabaseQuery(started);
        store.completeDatabaseQuery({ ...started, status: 'error', durationMs: 7, error: 'boom' });

        const [entry] = store.dbQueries.toArray();
        assert.equal(entry.status, 'error');
        assert.equal(entry.durationMs, 7);
        assert.equal(entry.error, 'boom');
        assert.equal(events[0].type, 'db:query');
        assert.equal(events[1].type, 'db:query:complete');
        assert.equal((events[1].data as DevConsoleDatabaseQueryEntry).status, 'error');
    });

    it('is disabled in test by default and can be explicitly enabled', async () => {
        process.env.APP_ENV = 'test';
        const disabled = createApp({});
        assert.equal((await disabled.request(HttpRequest.GET('/_devconsole'))).statusCode, 404);

        process.env.APP_ENV = 'test';
        process.env.DEVCONSOLE_ENABLED = 'true';
        const enabled = createApp({});
        try {
            const response = await enabled.request(HttpRequest.GET('/_devconsole'));
            assert.equal(response.statusCode, 200);
            assert.match(String(response.getHeader('content-type')), /text\/html/);
        } finally {
            await enabled.stop();
        }
    });

    it('serves the full SPA shell and built assets in development', async () => {
        process.env.APP_ENV = 'development';
        const app = createApp({ config: BaseAppConfig });
        try {
            const root = await app.request(HttpRequest.GET('/_devconsole'));
            assert.equal(root.statusCode, 200);
            assert.match(root.text, /<div id="app"><\/div>/);

            const rootWithSlash = await app.request(HttpRequest.GET('/_devconsole/'));
            assert.equal(rootWithSlash.statusCode, 200);

            const assetPath = root.text.match(/\/_devconsole\/assets\/[^"]+\.js/)?.[0];
            assert.ok(assetPath);
            const asset = await app.request(HttpRequest.GET(assetPath));
            assert.equal(asset.statusCode, 200);
            assert.match(String(asset.getHeader('content-type')), /javascript/);

            const devConsoleOpenapi = await app.request(HttpRequest.GET('/_devconsole/openapi.json'));
            const openapi = await app.request(HttpRequest.GET('/openapi.json'));
            assert.equal(devConsoleOpenapi.statusCode, 404);
            assert.equal(openapi.statusCode, 200);
            assert.equal(openapi.json.openapi, '3.1.0');
            assert.equal(openapi.json.paths['/_devconsole'], undefined);
        } finally {
            await app.stop();
        }
    });

    it('serves /_devconsole/ before app static SPA fallback', async () => {
        const staticDir = mkdtempSync(join(tmpdir(), 'tsf-devconsole-static-'));
        writeFileSync(join(staticDir, 'index.html'), '<main>app static shell</main>');

        process.env.APP_ENV = 'development';
        const app = createApp({
            config: BaseAppConfig,
            staticFiles: { directory: staticDir }
        });

        try {
            const response = await app.request(HttpRequest.GET('/_devconsole/'));

            assert.equal(response.statusCode, 200);
            assert.match(response.text, /<div id="app"><\/div>/);
            assert.doesNotMatch(response.text, /app static shell/);
        } finally {
            await app.stop();
            rmSync(staticDir, { recursive: true, force: true });
        }
    });

    it('rejects forwarded devconsole HTTP requests', async () => {
        process.env.APP_ENV = 'development';
        const app = createApp({});
        try {
            const request = HttpRequest.GET('/_devconsole', { 'x-forwarded-for': '127.0.0.1' });
            const response = await app.request(request);
            assert.equal(response.statusCode, 401);

            const realIpRequest = HttpRequest.GET('/_devconsole', { 'x-real-ip': '203.0.113.10' });
            const realIpResponse = await app.request(realIpRequest);
            assert.equal(realIpResponse.statusCode, 401);
        } finally {
            await app.stop();
        }
    });

    it('serves the DevConsole SRPC surface over WebSocket', async () => {
        process.env.APP_ENV = 'development';
        const app = createApp({ config: DevConsoleTestConfig });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        const largeBody = Buffer.alloc(64 * 1024 + 17, 'x');
        await app.request(HttpRequest.POST('/devconsole-large-body', largeBody));
        const client = new SrpcClient<DCClientMsg, DCServerMsg>(
            { info() {}, warn() {}, error() {}, debug() {} },
            `ws://127.0.0.1:${address.port}/_devconsole/ws`,
            DevConsoleClientMessage,
            DevConsoleServerMessage,
            'devconsole-test',
            undefined,
            'unused-local-devconsole-secret',
            { enableReconnect: false }
        );

        try {
            await client.connect();
            const overview = await client.invoke('uGetOverview', {});
            assert.equal(overview.name, '@zyno-io/ts-server-foundation');
            assert.equal(overview.env, 'development');

            const routes = await client.invoke('uGetRoutes', {});
            assert.equal(
                routes.routes.some(route => route.path.startsWith('/_devconsole')),
                false
            );

            const env = JSON.parse((await client.invoke('uGetEnv', {})).jsonData) as Record<string, unknown>;
            assert.equal(env.API_SECRET, '****');
            assert.equal(env.PUBLIC_LABEL, 'visible');

            const repl = await client.invoke('uReplEval', {
                code: '[resolve(config.constructor) === config, r(config.constructor) === config, $(config.constructor) === config]'
            });
            assert.equal(repl.error, undefined);
            assert.match(repl.output, /true.*true.*true/);

            const requests = JSON.parse((await client.invoke('uGetRequests', {})).jsonData) as Array<{
                url: string;
                requestBody: string | null;
            }>;
            const captured = requests.find(request => request.url === '/devconsole-large-body');
            assert.ok(captured?.requestBody);
            assert.equal(Buffer.byteLength(captured.requestBody.split('\n... truncated ')[0]), 64 * 1024);
            assert.match(captured.requestBody, /\.\.\. truncated 17 byte\(s\)$/);
        } finally {
            client.disconnect();
            await app.stop();
        }
    });

    it('keeps observers active after stop and listen restart', async () => {
        process.env.APP_ENV = 'development';
        const app = createApp({});
        let server = await app.http.listen(0, '127.0.0.1');
        await app.stop();

        server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        await app.request(HttpRequest.GET('/captured-after-restart'));
        const client = new SrpcClient<DCClientMsg, DCServerMsg>(
            { info() {}, warn() {}, error() {}, debug() {} },
            `ws://127.0.0.1:${address.port}/_devconsole/ws`,
            DevConsoleClientMessage,
            DevConsoleServerMessage,
            'devconsole-restart-test',
            undefined,
            'unused-local-devconsole-secret',
            { enableReconnect: false }
        );

        try {
            await client.connect();
            const response = await client.invoke('uGetRequests', {});
            const requests = JSON.parse(response.jsonData) as Array<{ url: string }>;
            assert.equal(
                requests.some(request => request.url === '/captured-after-restart'),
                true
            );
        } finally {
            client.disconnect();
            await app.stop();
        }
    });

    it('returns only the latest 200 in-memory worker records', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({
            config: DevConsoleWorkerTestConfig,
            enableWorker: true,
            providers: [DevConsoleHistoryJob]
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        const worker = app.get(WorkerService);
        for (let index = 0; index < 205; index++) await worker.runJob(DevConsoleHistoryJob, { index });

        const client = new SrpcClient<DCClientMsg, DCServerMsg>(
            { info() {}, warn() {}, error() {}, debug() {} },
            `ws://127.0.0.1:${address.port}/_devconsole/ws`,
            DevConsoleClientMessage,
            DevConsoleServerMessage,
            'devconsole-worker-history',
            undefined,
            'unused-local-devconsole-secret',
            { enableReconnect: false }
        );

        try {
            await client.connect();
            const response = await client.invoke('uGetWorkersJobs', {});
            const workers = JSON.parse(response.jsonData) as {
                history: Array<{ result: number }>;
            };
            assert.equal(workers.history.length, 200);
            assert.equal(workers.history[0].result, 204);
            assert.equal(workers.history.at(-1)?.result, 5);
        } finally {
            client.disconnect();
            await app.stop();
        }
    });
});
