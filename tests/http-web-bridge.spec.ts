import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { createApp, http, HttpBadRequestError, HttpRequest, HttpRequestStream, webResponse } from '../src';

function delayedStream(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (index >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[index++]));
        },
        cancel() {
            onCancel?.();
        }
    });
}

describe('web request/response bridge', () => {
    it('builds a web request with the decoded body and filtered headers', async () => {
        const request = new HttpRequest(
            'POST',
            '/rpc?x=1',
            { host: 'api.example.com', 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-custom': 'yes' },
            gzipSync(JSON.stringify({ hello: 'world' }))
        );

        const web = await request.toWebRequest();

        assert.equal(web.method, 'POST');
        assert.equal(web.url, 'http://api.example.com/rpc?x=1');
        assert.equal(web.headers.get('content-type'), 'application/json');
        assert.equal(web.headers.get('x-custom'), 'yes');
        assert.equal(web.headers.get('content-encoding'), null);
        assert.equal(web.headers.get('content-length'), null);
        assert.deepStrictEqual(await web.json(), { hello: 'world' });
        assert.equal(web.signal.aborted, false);
    });

    it('omits the body for GET and uses forwarded origin only when proxy headers are trusted', async () => {
        const headers = { host: 'internal:8080', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.com, internal' };

        const untrusted = await HttpRequest.GET('/path', headers).toWebRequest();
        assert.equal(untrusted.url, 'http://internal:8080/path');
        assert.equal(untrusted.body, null);

        const trustedRequest = HttpRequest.GET('/path', headers);
        trustedRequest.trustProxyHeaders = true;
        assert.equal((await trustedRequest.toWebRequest()).url, 'https://public.example.com/path');
    });

    it('takes only the path and query from the request target', async () => {
        const request = HttpRequest.GET('//evil.example/x/url?q=1', { host: 'internal', 'x-forwarded-host': 'public.example.com' });
        request.trustProxyHeaders = true;
        assert.equal((await request.toWebRequest()).url, 'http://public.example.com/x/url?q=1');
        assert.equal((await HttpRequest.GET('/\\evil.example/x', { host: 'internal' }).toWebRequest()).url.startsWith('http://internal/'), true);
    });

    it('rejects a request whose host cannot form a URL or is not a bare authority', async () => {
        for (const host of ['bad host', 'good.example/admin', 'user:pw@good.example']) {
            await assert.rejects(HttpRequest.GET('/path', { host }).toWebRequest(), HttpBadRequestError, host);
        }
        // An empty query or fragment in the host parses away and cannot displace the routed path.
        for (const host of ['good.example?', 'good.example#']) {
            assert.equal((await HttpRequest.GET('/path?a=1', { host }).toWebRequest()).url, 'http://good.example/path?a=1');
        }
    });

    it('writes status, headers, repeated cookies, and a streamed body before the request finishes', async () => {
        @http.controller('/bridge')
        class BridgeController {
            @http.POST('echo')
            async echo(request: HttpRequest) {
                const web = await request.toWebRequest();
                const body = await web.text();
                return webResponse(
                    new Response(delayedStream(['echo:', body]), {
                        status: 201,
                        headers: [
                            ['content-type', 'text/plain'],
                            ['set-cookie', 'a=1'],
                            ['set-cookie', 'b=2'],
                            ['x-from', 'web']
                        ]
                    })
                );
            }

            @http.GET('empty')
            empty() {
                return webResponse(new Response(null, { status: 204, headers: { 'x-empty': 'true' } }));
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [BridgeController] });

        const response = await app.request(HttpRequest.POST('/bridge/echo', 'payload', { 'content-type': 'text/plain' }));
        assert.equal(response.statusCode, 201);
        assert.equal(response.text, 'echo:payload');
        assert.equal(response.getHeader('x-from'), 'web');
        assert.deepStrictEqual(response.rawHeaders['set-cookie'], ['a=1', 'b=2']);

        const empty = await app.request(HttpRequest.GET('/bridge/empty'));
        assert.equal(empty.statusCode, 204);
        assert.equal(empty.text, '');
        assert.equal(empty.getHeader('x-empty'), 'true');
    });

    it('turns a body that fails before its first chunk into a 500, and rejects consumed multipart bodies', async () => {
        @http.controller('/failing')
        class FailingController {
            @http.GET('early')
            early() {
                const body = new ReadableStream<Uint8Array>({
                    pull() {
                        throw new Error('source failed');
                    }
                });
                return webResponse(new Response(body, { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '10' } }));
            }

            @http.POST('forward')
            async forward(request: HttpRequest) {
                await request.toWebRequest();
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [FailingController] });
        const early = await app.request(HttpRequest.GET('/failing/early'));
        assert.equal(early.statusCode, 500);
        assert.equal(early.getHeader('content-length'), undefined);

        const server = await app.http.listen(0, '127.0.0.1');
        try {
            const form = new FormData();
            form.set('field', 'x');
            const multipart = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/failing/forward`, {
                method: 'POST',
                body: form
            });
            assert.equal(multipart.status, 415);
        } finally {
            server.closeAllConnections();
            await app.stop();
        }
    });

    it('aborts without crashing when a body fails after its first chunk', async () => {
        const failAfterFirst = (contentType: string) => {
            let sent = false;
            return webResponse(
                new Response(
                    new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            await new Promise(resolve => setTimeout(resolve, 5));
                            if (sent) throw new Error('source failed mid-stream');
                            sent = true;
                            controller.enqueue(new TextEncoder().encode('first'));
                        }
                    }),
                    { headers: { 'content-type': contentType } }
                )
            );
        };

        @http.controller('/midstream')
        class MidstreamController {
            @http.GET('plain')
            plain() {
                return failAfterFirst('text/plain');
            }

            @http.GET('events')
            events() {
                return failAfterFirst('text/event-stream');
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [MidstreamController] });
        const memory = await app.request(HttpRequest.GET('/midstream/plain'));
        assert.equal(memory.statusCode, 500);

        const server = await app.http.listen(0, '127.0.0.1');
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            for (const path of ['plain', 'events']) {
                const response = await fetch(`${base}/midstream/${path}`);
                assert.equal(response.status, 200);
                await assert.rejects(response.text());
            }
            // Give a stray 'error' event the chance to crash the process before the test ends.
            await new Promise(resolve => setTimeout(resolve, 50));
        } finally {
            server.closeAllConnections();
            await app.stop();
        }
    });

    it('forwards the raw body and its content-encoding on HttpRequestStream routes', async () => {
        @http.controller('/raw')
        class RawController {
            @http.POST()
            async forward(request: HttpRequestStream) {
                const web = await request.toWebRequest();
                const bytes = Buffer.from(await web.arrayBuffer());
                return { encoding: web.headers.get('content-encoding'), gzipMagic: bytes[0] === 0x1f && bytes[1] === 0x8b };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [RawController] });
        const server = await app.http.listen(0, '127.0.0.1');
        try {
            const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/raw`, {
                method: 'POST',
                headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
                body: gzipSync(JSON.stringify({ a: 1 }))
            });
            assert.deepStrictEqual(await response.json(), { encoding: 'gzip', gzipMagic: true });
        } finally {
            server.closeAllConnections();
            await app.stop();
        }
    });

    it('stops the middleware chain when the client disconnects during a streamed middleware result', async () => {
        let controllerRan = false;
        let canceled!: () => void;
        const canceledPromise = new Promise<void>(resolve => (canceled = resolve));
        const deny = () =>
            webResponse(
                new Response(
                    delayedStream(
                        Array.from({ length: 200 }, (_, index) => `chunk ${index}\n`),
                        () => canceled()
                    ),
                    { status: 401, headers: { 'content-type': 'text/plain' } }
                )
            );

        @http.middleware(deny)
        @http.controller('/guarded')
        class GuardedController {
            @http.POST()
            act() {
                controllerRan = true;
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [GuardedController] });
        const server = await app.http.listen(0, '127.0.0.1');
        try {
            const abort = new AbortController();
            const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/guarded`, {
                method: 'POST',
                signal: abort.signal
            });
            assert.equal(response.status, 401);
            await response.body!.getReader().read();
            abort.abort();
            await canceledPromise;
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(controllerRan, false);
        } finally {
            server.closeAllConnections();
            await app.stop();
        }
    });

    it('streams over a Node server and cancels the source when the client disconnects', async () => {
        let canceled!: () => void;
        const canceledPromise = new Promise<void>(resolve => (canceled = resolve));

        @http.controller('/stream')
        class StreamController {
            @http.GET('finite')
            finite() {
                return webResponse(new Response(delayedStream(['one,', 'two,', 'three']), { headers: { 'content-type': 'text/plain' } }));
            }

            @http.GET('events')
            events() {
                const infinite = Array.from({ length: 10_000 }, (_, index) => `data: ${index}\n\n`);
                return webResponse(
                    new Response(
                        delayedStream(infinite, () => canceled()),
                        { headers: { 'content-type': 'text/event-stream' } }
                    )
                );
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [StreamController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const finite = await fetch(`${base}/stream/finite`);
            assert.equal(finite.status, 200);
            assert.equal(finite.headers.get('content-type'), 'text/plain');
            assert.equal(await finite.text(), 'one,two,three');

            const abort = new AbortController();
            const events = await fetch(`${base}/stream/events`, { signal: abort.signal });
            assert.equal(events.headers.get('content-type'), 'text/event-stream');
            const reader = events.body!.getReader();
            const first = await reader.read();
            assert.match(new TextDecoder().decode(first.value), /^data: 0/);
            abort.abort();
            await canceledPromise;
        } finally {
            server.closeAllConnections();
            await app.stop();
        }
    });
});
