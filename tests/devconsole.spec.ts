import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { BaseAppConfig, BaseJob, createApp, http, HttpRequest, SrpcClient, WorkerJob, WorkerService } from '../src';
import {
    DevConsoleClientMessage,
    DevConsoleServerMessage,
    type DevConsoleClientMessage as DCClientMsg,
    type DevConsoleServerMessage as DCServerMsg
} from '../src/devconsole/generated/devconsole';
import { DevConsoleStore, RingBuffer, type DevConsoleDatabaseQueryEntry } from '../src/devconsole';
import {
    TSF_DEV_RUNNER_PID_ENV,
    TSF_DEV_RUN_ID_ENV,
    TSF_DEV_STATE_FILE_ENV,
    getDevStatePaths,
    readDevState,
    registerDevRun,
    unregisterDevRun
} from '../src/cli/dev-state';
import { runReplCli } from '../src/cli/tsf-repl';

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

@http.controller('/devconsole-capture')
class DevConsoleCaptureController {
    @http.POST()
    async post(request: HttpRequest) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return { body: Buffer.concat(chunks).toString() };
    }
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
        const app = createApp({ config: DevConsoleTestConfig, controllers: [DevConsoleCaptureController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const address = server.address() as AddressInfo;
        const largeBody = Buffer.alloc(64 * 1024 + 17, 'x');
        await app.request(HttpRequest.POST('/devconsole-large-body', largeBody));
        const streamedBody = 'captured streamed request body';
        const streamedResponse = await fetch(`http://127.0.0.1:${address.port}/devconsole-capture`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain', 'x-devconsole-test': 'captured' },
            body: streamedBody
        });
        assert.equal(streamedResponse.status, 200);
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
                requestHeaders: Record<string, string>;
                requestBody: string | null;
            }>;
            const streamed = requests.find(request => request.url === '/devconsole-capture');
            assert.equal(streamed?.requestHeaders['x-devconsole-test'], 'captured');
            assert.equal(streamed?.requestBody, streamedBody);
            const captured = requests.find(request => request.url === '/devconsole-large-body');
            assert.ok(captured?.requestBody);
            assert.equal(Buffer.byteLength(captured.requestBody.split('\n... truncated ')[0]), 64 * 1024);
            assert.match(captured.requestBody, /\.\.\. truncated 17 byte\(s\)$/);
        } finally {
            client.disconnect();
            await app.stop();
        }
    });

    it('publishes tsf-dev discovery state and serves one-shot CLI REPL evaluations', async () => {
        const projectDir = mkdtempSync(join(tmpdir(), 'tsf-repl-discovery-'));
        const previousCwd = process.cwd();
        writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'repl-discovery-test' }));
        process.chdir(projectDir);
        const { stateFile } = getDevStatePaths(projectDir);
        const runId = 'repl-discovery-run';
        const now = Date.now();
        registerDevRun(stateFile, {
            runId,
            runnerPid: process.pid,
            script: '.',
            command: ['server:start'],
            startedAt: now,
            updatedAt: now
        });
        process.env[TSF_DEV_STATE_FILE_ENV] = stateFile;
        process.env[TSF_DEV_RUN_ID_ENV] = runId;
        process.env[TSF_DEV_RUNNER_PID_ENV] = String(process.pid);
        process.env.APP_ENV = 'development';

        const app = createApp({ config: DevConsoleTestConfig });
        try {
            const server = await app.http.listen(0, '127.0.0.1');
            const address = server.address() as AddressInfo;
            const published = readDevState(stateFile)?.runs[runId];
            assert.equal(published?.appPid, process.pid);
            assert.equal(published?.devConsoleUrl, `ws://127.0.0.1:${address.port}/_devconsole/ws`);

            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let stdoutText = '';
            let stderrText = '';
            stdout.setEncoding('utf8');
            stderr.setEncoding('utf8');
            stdout.on('data', chunk => (stdoutText += chunk));
            stderr.on('data', chunk => (stderrText += chunk));

            const status = await runReplCli(['--eval', '[process.pid, config.APP_ENV]'], {
                stdout: stdout as unknown as NodeJS.WriteStream,
                stderr: stderr as unknown as NodeJS.WriteStream,
                stdin: process.stdin
            });
            assert.equal(status, 0, stderrText);
            assert.match(stdoutText, new RegExp(`\\[ ${process.pid}, 'development' \\]`));

            const outsideProject = mkdtempSync(join(tmpdir(), 'tsf-repl-url-'));
            process.chdir(outsideProject);
            try {
                const urlStatus = await runReplCli(['--url', published!.devConsoleUrl!, '--eval', 'process.pid'], {
                    stdout: stdout as unknown as NodeJS.WriteStream,
                    stderr: stderr as unknown as NodeJS.WriteStream,
                    stdin: process.stdin
                });
                assert.equal(urlStatus, 0, stderrText);
            } finally {
                process.chdir(projectDir);
                rmSync(outsideProject, { recursive: true, force: true });
            }

            const errorStatus = await runReplCli(['--pid', String(process.pid), '--eval', "throw new Error('repl probe')"], {
                stdout: stdout as unknown as NodeJS.WriteStream,
                stderr: stderr as unknown as NodeJS.WriteStream,
                stdin: process.stdin
            });
            assert.equal(errorStatus, 1);
            assert.match(stderrText, /Error: repl probe/);

            await app.stop();
            const stopped = readDevState(stateFile)?.runs[runId];
            assert.equal(stopped?.appPid, undefined);
            assert.equal(stopped?.devConsoleUrl, undefined);
        } finally {
            await app.stop();
            unregisterDevRun(stateFile, runId, process.pid);
            rmSync(stateFile, { force: true });
            rmSync(`${stateFile}.state-lock`, { force: true });
            process.chdir(previousCwd);
            rmSync(projectDir, { recursive: true, force: true });
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
