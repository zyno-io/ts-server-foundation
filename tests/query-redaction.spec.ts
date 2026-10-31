import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

import {
    createApp,
    createQueryKeyMatcher,
    DEFAULT_REDACTED_QUERY_KEYS,
    getTracer,
    http,
    type HttpResponse,
    redactQuery,
    redactUrlQuery,
    resetLogSink,
    setLogSink,
    type LogEntry
} from '../src';
import { DEFAULT_REDACTED_QUERY_KEYS as OtelDefaultRedactedQueryKeys, init, resetTelemetryForTests } from '../src/telemetry/otel';

const requireFromTest = createRequire(__filename);

afterEach(() => {
    resetTelemetryForTests();
    resetLogSink();
});

function get(port: number, path: string): Promise<number> {
    const nodeHttp = requireFromTest('http') as typeof import('node:http');
    return new Promise((resolve, reject) => {
        const request = nodeHttp.request({ host: '127.0.0.1', port, path, method: 'GET' }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
        });
        request.on('error', reject);
        request.end();
    });
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

describe('query redaction', () => {
    const matches = createQueryKeyMatcher();

    it('redacts default keys case/separator-insensitively and keeps everything else as sent', () => {
        assert.equal(
            redactUrlQuery('/cdr?q=Jane%20Doe&page=2&Phone_Numbers=%2B15555550123&PHONE-NUMBER=1&limit=50&sort=-createdAt', matches),
            '/cdr?q=REDACTED&page=2&Phone_Numbers=REDACTED&PHONE-NUMBER=REDACTED&limit=50&sort=-createdAt'
        );
        assert.equal(
            redactUrlQuery('/x?filter[email]=a%40b.c&filter%5Bstatus%5D=open#frag', matches),
            '/x?filter[email]=REDACTED&filter%5Bstatus%5D=open#REDACTED'
        );
        assert.equal(redactUrlQuery('https://h.example/tts?text=hello+world&voice=Rex', matches), 'https://h.example/tts?text=REDACTED&voice=Rex');
        assert.equal(redactUrlQuery('/plain', matches), '/plain');
        assert.equal(redactUrlQuery('/flag?q&page=1', matches), '/flag?q&page=1');
        assert.equal(
            redactUrlQuery('/oauth?code=abc&state=xyz&token=t&password=p&name=n&search=s&query=y&phone=1&phones=2', matches),
            '/oauth?code=REDACTED&state=REDACTED&token=REDACTED&password=REDACTED&name=REDACTED&search=REDACTED&query=REDACTED&phone=REDACTED&phones=REDACTED'
        );
    });

    it('redacts credential parameters and URL fragments', () => {
        assert.equal(
            redactUrlQuery('/cb?jwt=a&access_token=b&idToken=c&refresh-token=d&api_key=e&secret=f&signature=g&sig=h&page=1', matches),
            '/cb?jwt=REDACTED&access_token=REDACTED&idToken=REDACTED&refresh-token=REDACTED&api_key=REDACTED&secret=REDACTED&signature=REDACTED&sig=REDACTED&page=1'
        );
        assert.equal(redactUrlQuery('/x?a=1#&q=secret', matches), '/x?a=1#REDACTED');
        assert.equal(redactUrlQuery('/x#access_token=secret', matches), '/x#REDACTED');
        assert.equal(redactUrlQuery('/x#frag?q=secret', matches), '/x#REDACTED');
    });

    it('fails closed when a key cannot be decoded', () => {
        assert.equal(redactUrlQuery('/x?%E0%A4%A=secret&page=1', matches), '/x?REDACTED');
    });

    it('supports custom and empty key lists', () => {
        assert.equal(redactUrlQuery('/x?mrn=1&q=2', createQueryKeyMatcher([...DEFAULT_REDACTED_QUERY_KEYS, 'mrn'])), '/x?mrn=REDACTED&q=REDACTED');
        const disabled = createQueryKeyMatcher([]);
        assert.equal(redactUrlQuery('/x?mrn=1&q=2', disabled), '/x?mrn=1&q=2');
        // An empty list logs URLs exactly as received: no fail-closed rewrite and no fragment rewrite.
        assert.equal(redactUrlQuery('/x?%E0%A4%A=secret&page=1#frag', disabled), '/x?%E0%A4%A=secret&page=1#frag');
        assert.equal(redactQuery('%E0%A4%A=secret', disabled), '%E0%A4%A=secret');
        // The /otel entry exposes the same default list so a bootstrap can extend it before loading the root package.
        assert.equal(OtelDefaultRedactedQueryKeys, DEFAULT_REDACTED_QUERY_KEYS);
    });

    it('redacts query values in real request log lines', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/query-redaction-logging')
        class QueryRedactionLoggingController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({ controllers: [QueryRedactionLoggingController], defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'e2e' } });
        const server = await app.http.listen(0, '127.0.0.1');
        const { port } = server.address() as AddressInfo;

        try {
            assert.equal(await get(port, '/query-redaction-logging?q=Jane&phoneNumbers=%2B15555550123&page=2'), 200);
            const lines = entries.filter(entry => entry.message === 'Request' || entry.message === 'Response');
            assert.deepEqual(
                lines.map(entry => [entry.message, entry.data?.url]),
                [
                    ['Request', '/query-redaction-logging?q=REDACTED&phoneNumbers=REDACTED&page=2'],
                    ['Response', '/query-redaction-logging?q=REDACTED&phoneNumbers=REDACTED&page=2']
                ]
            );
            assert.ok(!JSON.stringify(entries).includes('15555550123'));
            assert.ok(!JSON.stringify(entries).includes('Jane'));
        } finally {
            await app.stop();
        }
    });

    it('honours requestLogging.redactQueryKeys', async () => {
        const entries: LogEntry[] = [];

        @http.controller('/query-redaction-custom')
        class QueryRedactionCustomController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        // `as const` lists (and the readonly default) must be accepted.
        const customKeys = ['mrn'] as const;
        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({
            controllers: [QueryRedactionCustomController],
            defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'e2e' },
            requestLogging: { redactQueryKeys: customKeys }
        });
        const server = await app.http.listen(0, '127.0.0.1');
        const { port } = server.address() as AddressInfo;

        try {
            await get(port, '/query-redaction-custom?mrn=123&q=visible');
            assert.equal(entries.find(entry => entry.message === 'Request')?.data?.url, '/query-redaction-custom?mrn=REDACTED&q=visible');
        } finally {
            await app.stop();
        }
    });

    it('redacts the URL on stream-hook, abort and 5xx log lines', async () => {
        const entries: LogEntry[] = [];
        let stream: Readable | undefined;

        @http.controller('/query-redaction-lines')
        class QueryRedactionLinesController {
            @http.GET('/stream')
            stream(response: HttpResponse): void {
                response.writeHead(200, { 'content-type': 'text/plain' });
                stream = new Readable({ read() {} });
                stream.pipe(response).once('error', () => {});
            }

            @http.GET('/fail')
            fail(): never {
                throw new Error('boom');
            }
        }

        process.env.APP_ENV = 'test';
        setLogSink(entry => entries.push(entry));
        const app = createApp({ controllers: [QueryRedactionLinesController], defaultConfig: { HTTP_REQUEST_LOGGING_MODE: 'e2e' } });
        const server = await app.http.listen(0, '127.0.0.1');
        const { port } = server.address() as AddressInfo;
        const nodeHttp = requireFromTest('http') as typeof import('node:http');
        const aborted = nodeHttp.request({ host: '127.0.0.1', port, path: '/query-redaction-lines/stream?q=Jane&page=1', method: 'GET' });
        aborted.on('error', () => {});
        aborted.end();

        try {
            await waitFor(() => entries.some(entry => entry.message === 'Response stream hooked by controller'));
            aborted.destroy();
            await waitFor(() => entries.some(entry => entry.message === 'Request aborted during processing'));
            assert.equal(await get(port, '/query-redaction-lines/fail?phoneNumbers=%2B15555550123'), 500);
            await waitFor(() => entries.some(entry => entry.message === 'Request processing error'));

            const urlsByMessage = Object.fromEntries(entries.map(entry => [entry.message, entry.data?.url]));
            assert.equal(urlsByMessage['Response stream hooked by controller'], '/query-redaction-lines/stream?q=REDACTED&page=1');
            assert.equal(urlsByMessage['Request aborted during processing'], '/query-redaction-lines/stream?q=REDACTED&page=1');
            assert.equal(urlsByMessage['Request processing error'], '/query-redaction-lines/fail?phoneNumbers=REDACTED');
            assert.ok(!JSON.stringify(entries).includes('Jane'));
            assert.ok(!JSON.stringify(entries).includes('15555550123'));
        } finally {
            stream?.destroy();
            aborted.destroy();
            await app.stop();
        }
    });

    it('redacts incoming HTTP span URL attributes before export', async () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'query-redaction', spanProcessors: [new SimpleSpanProcessor({ exporter })] });
        // `http` was loaded before telemetry init; requiring it again lets the HTTP instrumentation patch
        // `Server.prototype.emit`, as it would when init runs first in an application bootstrap.
        const instrumentedHttp = requireFromTest('http') as typeof import('node:http');
        assert.ok((instrumentedHttp.Server.prototype.emit as { __wrapped?: boolean }).__wrapped, 'HTTP instrumentation is active');

        @http.controller('/query-redaction-span')
        class QueryRedactionSpanController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ controllers: [QueryRedactionSpanController] });
        const server = await app.http.listen(0, '127.0.0.1');
        const { port } = server.address() as AddressInfo;

        // Read spans before stopping the app: app shutdown also shuts telemetry down, which clears the exporter.
        let serverSpans: ReturnType<InMemorySpanExporter['getFinishedSpans']>;
        try {
            assert.equal(await get(port, '/query-redaction-span?text=call+me&phoneNumbers=%2B15555550123&page=2'), 200);
            const deadline = Date.now() + 1_000;
            while (!exporter.getFinishedSpans().some(span => span.kind === SpanKind.SERVER) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            serverSpans = exporter.getFinishedSpans().filter(span => span.kind === SpanKind.SERVER);
        } finally {
            await app.stop();
        }

        assert.equal(serverSpans.length, 1, 'expected one incoming HTTP span');
        const attributes = serverSpans[0].attributes;
        const urlAttributes = (['http.url', 'http.target', 'url.full', 'url.query'] as const).filter(key => typeof attributes[key] === 'string');
        assert.ok(urlAttributes.length > 0, 'incoming span carries URL attributes');
        for (const key of urlAttributes) {
            const value = attributes[key] as string;
            assert.ok(value.includes('text=REDACTED&phoneNumbers=REDACTED&page=2'), `${key}=${value}`);
        }
        assert.ok(!JSON.stringify(attributes).includes('15555550123'));
        assert.ok(!JSON.stringify(attributes).includes('call'));
    });

    it('rewrites every URL attribute on server spans, fails closed, and leaves client spans alone', () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'query-redaction-manual', spanProcessors: [new SimpleSpanProcessor({ exporter })] });
        const tracer = getTracer();
        assert.ok(tracer);

        tracer
            .startSpan('GET', {
                kind: SpanKind.SERVER,
                attributes: {
                    'http.url': 'http://api.example/cdr?q=Jane&page=1',
                    'http.target': '/cdr?q=Jane&page=1',
                    'url.full': 'http://api.example/cdr?%E0%A4%A=x',
                    'url.query': 'q=Jane&page=1'
                }
            })
            .end();
        tracer.startSpan('GET', { kind: SpanKind.CLIENT, attributes: { 'url.full': 'http://vendor.example/lookup?q=Jane' } }).end();

        const [serverSpan, clientSpan] = exporter.getFinishedSpans();
        assert.deepEqual(serverSpan.attributes, {
            'http.url': 'http://api.example/cdr?q=REDACTED&page=1',
            'http.target': '/cdr?q=REDACTED&page=1',
            'url.full': 'http://api.example/cdr?REDACTED',
            'url.query': 'q=REDACTED&page=1'
        });
        assert.equal(clientSpan.attributes['url.full'], 'http://vendor.example/lookup?q=Jane');
    });
});
