import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';

import {
    BaseAppConfig,
    createApp,
    eventDispatcher,
    FileUpload,
    http,
    HttpBody,
    HttpRequest,
    HttpResponse,
    httpWorkflow,
    MemoryHttpResponse,
    temporaryFiles
} from '../src';
import { getHttpRequestErrorState } from '../src/http/request-error-state';

describe('HTTP request lifecycle', () => {
    it('shares request cancellation and completion across module reloads', async () => {
        const filename = require.resolve('../src/http/request-lifecycle');
        const cached = require.cache[filename];
        const request = HttpRequest.GET('/reload');
        const signal = request.signal;
        try {
            delete require.cache[filename];
            const reloaded = require(filename) as typeof import('../src/http/request-lifecycle');
            assert.equal(reloaded.getRequestSignal(request), signal);
            request.setDeadline(10);
            await delay(20);
            assert.equal(reloaded.getRequestSignal(request).aborted, true);
            reloaded.finishRequestLifecycle(request);
            await assert.rejects(request.workspace(), /completed/);
        } finally {
            if (cached) require.cache[filename] = cached;
        }
    });

    it('allocates lazily, shares concurrent workspace access, and refuses allocation after completion', async t => {
        const create = t.mock.method(temporaryFiles, 'createWorkspace');
        let directory = '';
        @http.controller()
        class Controller {
            @http.GET('/plain')
            plain(request: HttpRequest) {
                assert.equal(request.signal, request.signal);
                return { ok: true };
            }

            @http.GET('/files')
            async files(request: HttpRequest) {
                const [first, second] = await Promise.all([request.workspace(), request.workspace()]);
                assert.equal(first, second);
                directory = first.directory;
                await writeFile(first.path(), 'output');
                return { ok: true };
            }
        }
        const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
        try {
            await app.http.request(HttpRequest.GET('/plain'));
            assert.equal(create.mock.callCount(), 0);
            const request = HttpRequest.GET('/files');
            const response = await app.http.request(request);
            assert.equal(response.statusCode, 200);
            assert.equal(create.mock.callCount(), 1);
            await assert.rejects(access(directory), { code: 'ENOENT' });
            await assert.rejects(request.workspace(), /completed/);
            assert.equal(create.mock.callCount(), 1);
            const previousSignal = request.signal;
            const repeated = await app.http.request(request);
            assert.equal(repeated.statusCode, 200);
            assert.notEqual(request.signal, previousSignal);
            assert.equal(create.mock.callCount(), 2);
            await assert.rejects(access(directory), { code: 'ENOENT' });
        } finally {
            await app.stop();
        }
    });

    it('keeps request cancellation and files isolated between concurrent requests', async () => {
        const contexts: { request: HttpRequest; response: MemoryHttpResponse; directory: string; release: () => void }[] = [];
        let bothReady!: () => void;
        const ready = new Promise<void>(resolve => {
            bothReady = resolve;
        });
        @http.controller()
        class Controller {
            @http.GET('/files')
            async files(request: HttpRequest, response: HttpResponse): Promise<void> {
                const workspace = await request.workspace();
                await writeFile(workspace.path(), 'still in use');
                let release!: () => void;
                const gate = new Promise<void>(resolve => {
                    release = resolve;
                });
                contexts.push({ request, response: response as MemoryHttpResponse, directory: workspace.directory, release });
                if (contexts.length === 2) bothReady();
                await gate;
                request.signal.throwIfAborted();
                await pipeline(Readable.from(['complete']), response, { signal: request.signal });
            }
        }
        const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
        const firstResponse = new MemoryHttpResponse();
        const secondResponse = new MemoryHttpResponse();
        const firstRequest = HttpRequest.GET('/files');
        const secondRequest = HttpRequest.GET('/files');
        const first = app.router.handle(firstRequest, firstResponse);
        const second = app.router.handle(secondRequest, secondResponse);
        try {
            await ready;
            const a = contexts.find(item => item.request === firstRequest)!;
            const b = contexts.find(item => item.request === secondRequest)!;
            assert.notEqual(a.directory, b.directory);
            const closed = once(firstResponse, 'close');
            firstResponse.destroy();
            await closed;
            assert.equal(a.request.signal.aborted, true);
            assert.equal(b.request.signal.aborted, false);
            a.release();
            await first;
            assert.equal(getHttpRequestErrorState(firstRequest), undefined);
            await assert.rejects(access(a.directory), { code: 'ENOENT' });
            await access(b.directory);
            b.release();
            await second;
            assert.equal(secondResponse.bodyString, 'complete');
            await assert.rejects(access(b.directory), { code: 'ENOENT' });
        } finally {
            for (const context of contexts) context.release();
            await Promise.allSettled([first, second]);
            await app.stop();
        }
    });

    it('keeps a stable signal, tightens deadlines, reports deadline failures, and clears successful deadlines/listeners', async () => {
        @http.controller()
        class Controller {
            @http.GET('/expire')
            async expire(request: HttpRequest): Promise<void> {
                const signal = request.signal;
                request.setDeadline(10);
                request.setDeadline(60_000);
                assert.equal(request.signal, signal);
                await delay(60_000, undefined, { signal });
            }

            @http.GET('/success')
            success(request: HttpRequest) {
                request.setDeadline(20);
                assert.throws(() => request.setDeadline(0), /positive timer/);
                assert.throws(() => request.setDeadline(Infinity), /positive timer/);
                return { ok: true };
            }
        }
        const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
        try {
            const expired = HttpRequest.GET('/expire');
            const response = await app.http.request(expired);
            assert.equal(response.statusCode, 500);
            assert.equal(expired.signal.reason.name, 'TimeoutError');
            assert.ok(getHttpRequestErrorState(expired));
            const request = HttpRequest.GET('/success');
            const success = new MemoryHttpResponse();
            const closeListeners = success.listenerCount('close');
            const errorListeners = success.listenerCount('error');
            await app.router.handle(request, success);
            await delay(40);
            assert.equal(request.signal.aborted, false, 'completion must cancel its deadline timer');
            assert.equal(success.listenerCount('close'), closeListeners);
            assert.equal(success.listenerCount('error'), errorListeners);
            assert.throws(() => request.setDeadline(10), /completed/);
        } finally {
            await app.stop();
        }
    });

    for (const aborted of [false, true]) {
        it(`records an independent ${aborted ? 'AbortError' : 'error'} after disconnect`, async t => {
            const error = Object.assign(new Error('independent failure'), {
                name: aborted ? 'AbortError' : 'Error',
                cause: new Error('another operation')
            });
            @http.controller()
            class Controller {
                @http.GET('/fail')
                async fail(_request: HttpRequest, response: HttpResponse): Promise<void> {
                    const closed = once(response, 'close');
                    response.destroy();
                    await closed;
                    throw error;
                }
            }
            const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
            try {
                const request = HttpRequest.GET('/fail');
                const response = new MemoryHttpResponse();
                const end = t.mock.method(response, 'end');
                await app.router.handle(request, response);
                assert.equal(getHttpRequestErrorState(request)?.error, error);
                assert.equal(end.mock.callCount(), 0);
            } finally {
                await app.stop();
            }
        });
    }

    it('keeps the workspace and cancellation active through the response workflow', async () => {
        let directory = '';
        @http.controller()
        class Controller {
            @http.GET('/response')
            async response(request: HttpRequest) {
                const files = await request.workspace();
                directory = files.directory;
                return { ok: true };
            }
        }
        class Listener {
            @eventDispatcher.listen(httpWorkflow.onResponse)
            async response(event: typeof httpWorkflow.onResponse.event) {
                const files = await event.request.workspace();
                assert.equal(files.directory, directory);
                await writeFile(files.path('response-work'), 'output');
                assert.equal(event.request.signal.aborted, false);
                throw new Error('response workflow failed');
            }
        }
        const app = createApp({ config: BaseAppConfig, controllers: [Controller], listeners: [Listener] });
        try {
            await assert.rejects(app.http.request(HttpRequest.GET('/response')), /response workflow failed/);
            await assert.rejects(access(directory), { code: 'ENOENT' });
        } finally {
            await app.stop();
        }
    });

    for (const multipart of [false, true]) {
        it(`cancels an unfinished ${multipart ? 'multipart' : 'JSON'} body before controller invocation`, async t => {
            const body = multipart
                ? '--test\r\nContent-Disposition: form-data; name="file"; filename="input.raw"\r\nContent-Type: application/octet-stream\r\n\r\npartial'
                : '{"value":"partial';
            let started = false;
            let reading!: () => void;
            const ready = new Promise<void>(resolve => {
                reading = resolve;
            });
            const source = new Readable({
                read() {
                    if (started) return;
                    started = true;
                    this.push(body);
                    reading();
                }
            });
            const headers = { 'content-type': multipart ? 'multipart/form-data; boundary=test' : 'application/json' };
            const request = new HttpRequest('POST', '/body', headers, undefined, source);
            const create = t.mock.method(temporaryFiles, 'createWorkspace');
            let invoked = false;
            @http.controller()
            class Controller {
                @http.POST('/body')
                body(_body: HttpBody<{ file?: FileUpload; value?: string }>) {
                    invoked = true;
                    return { ok: true };
                }
            }
            const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
            try {
                request.setDeadline(10_000);
                const pending = app.http.request(request);
                await ready;
                request.setDeadline(20);
                const response = await pending;
                assert.equal(response.statusCode, 500);
                assert.equal(request.signal.reason.name, 'TimeoutError');
                assert.equal(source.destroyed, true);
                assert.equal(invoked, false);
                for (const call of create.mock.calls) {
                    const files = await call.result;
                    assert.ok(files);
                    await assert.rejects(access(files.directory), { code: 'ENOENT' });
                }
            } finally {
                await app.stop();
                source.destroy();
            }
        });
    }
});
