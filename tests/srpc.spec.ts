import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import WebSocket from 'ws';

import {
    BaseAppConfig,
    createApp,
    createLogger,
    SrpcByteStream,
    SrpcClient,
    SrpcConflictError,
    SrpcError,
    SrpcMessageFns,
    SrpcMeta,
    SrpcServer,
    SrpcStream,
    deferred,
    registerSrpcObserver
} from '../src';
import type { BaseMessage, IByteStreamable, SrpcClientOptions, SrpcObservation } from '../src';

const originalEnv = { ...process.env };
const secret = 'srpc-test-secret';

interface ClientMessage extends BaseMessage {
    uEchoRequest?: { message: string };
    uComplexRequest?: {
        stringField: string;
        intField: number;
        boolField: boolean;
        arrayField: string[];
        mapField: Record<string, string>;
    };
    uSlowRequest?: { delayMs: number };
    uErrorRequest?: { message: string; userError?: boolean };
    uUploadRequest?: { streamId: number; filename: string };
    uDownloadRequest?: { filename: string };
    dNotifyResponse?: { received: number };
    dComputeResponse?: { result: number };
}

interface ServerMessage extends BaseMessage {
    uEchoResponse?: { message: string };
    uComplexResponse?: { result: string; count: number };
    uSlowResponse?: { ok: boolean };
    uErrorResponse?: { ok: boolean };
    uUploadResponse?: { bytesReceived: number };
    uDownloadResponse?: { streamId: number; bytesTotal: number };
    dNotifyRequest?: { message: string };
    dComputeRequest?: { number: number; operation: 'square' | 'double' };
}

class SrpcTestConfig extends BaseAppConfig {
    APP_ENV = 'test';
    SRPC_AUTH_SECRET = secret;
    SRPC_AUTH_CLOCK_DRIFT_MS = 60_000;
    USE_REAL_IP_HEADER = true;
}

const JsonMessage: SrpcMessageFns<any> = {
    encode(message: unknown) {
        return {
            finish: () => Buffer.from(JSON.stringify(message, bytesReplacer))
        };
    },
    decode(input: Uint8Array) {
        return JSON.parse(Buffer.from(input).toString('utf8'), bytesReviver);
    }
};

afterEach(() => {
    process.env = { ...originalEnv };
});

describe('srpc', () => {
    it('ignores late replies only within the configured tombstone window and cleans up failed sends', async () => {
        const server = Object.create(SrpcServer.prototype) as any;
        const sent: Record<string, unknown>[] = [];
        const closed: [number, string][] = [];
        server.options = { lateReplyTombstoneTtlMs: 5 };
        server.logger = createLogger('SrpcLateReplyTest');
        server.lateReplyTombstonesByStream = new WeakMap();
        server.writeToStream = (_stream: unknown, message: Record<string, unknown>) => {
            sent.push(message);
            return true;
        };

        const stream = {
            $queue: new Map(),
            $ws: { close: (code: number, reason: string) => closed.push([code, reason]) },
            isActivated: true
        };
        const request = server.invoke(stream as any, 'dNotify', { message: 'late reply' }, 1);
        await assert.rejects(request, /Request timeout after 1ms/);
        const requestId = sent[0]?.requestId;
        assert.equal(typeof requestId, 'string');

        server.handleStreamDataReceived(stream, { requestId, reply: true, dNotifyResponse: { received: 1 } });
        assert.deepEqual(closed, []);

        await delay(15);
        server.handleStreamDataReceived(stream, { requestId, reply: true, dNotifyResponse: { received: 1 } });
        assert.deepEqual(closed, [[4000, 'Unknown request ID']]);

        server.writeToStream = () => {
            throw new Error('encode failed');
        };
        const sendFailureStream = { $queue: new Map() };
        await assert.rejects(server.invoke(sendFailureStream as any, 'dNotify', { message: 'fail' }), /encode failed/);
        assert.equal(sendFailureStream.$queue.size, 0);
    });

    it('connects with HMAC auth and invokes in both directions', async () => {
        const harness = await createHarness();
        const connected = deferred<SrpcStream<SrpcMeta>>();
        harness.server.registerConnectionHandler(stream => connected.resolve(stream));
        harness.server.registerMessageHandler('uEcho', (_stream, data) => ({
            message: `Echo: ${data.message}`
        }));
        harness.server.registerMessageHandler('uComplex', (_stream, data) => ({
            result: `Processed: ${data.stringField}, ${data.intField}, ${data.boolField}`,
            count: data.arrayField.length + Object.keys(data.mapField).length
        }));

        const client = harness.createClient('client-1', { tenant: 'alpha' });
        client.registerMessageHandler('dNotify', data => ({ received: data.message.length }));
        client.registerMessageHandler('dCompute', data => ({
            result: data.operation === 'square' ? data.number * data.number : data.number * 2
        }));

        try {
            await client.connect();
            const stream = await connected.promise;

            assert.equal(client.isConnected, true);
            assert.equal(stream.clientId, 'client-1');
            assert.deepEqual(stream.meta, { tenant: 'alpha' });

            const echo = await client.invoke('uEcho', { message: 'hello' });
            assert.deepEqual(echo, { message: 'Echo: hello' });

            const complex = await client.invoke('uComplex', {
                stringField: 'test',
                intField: 42,
                boolField: true,
                arrayField: ['a', 'b', 'c'],
                mapField: { left: 'right', up: 'down' }
            });
            assert.deepEqual(complex, {
                result: 'Processed: test, 42, true',
                count: 5
            });

            const concurrent = await Promise.all(Array.from({ length: 10 }, (_, i) => client.invoke('uEcho', { message: `Message ${i}` })));
            assert.deepEqual(
                concurrent.map(response => response.message),
                Array.from({ length: 10 }, (_, i) => `Echo: Message ${i}`)
            );

            const notified = await harness.server.invoke(stream, 'dNotify', {
                message: 'server-to-client'
            });
            assert.deepEqual(notified, { received: 'server-to-client'.length });

            const computed = await harness.server.invoke(stream, 'dCompute', {
                number: 5,
                operation: 'square'
            });
            assert.deepEqual(computed, { result: 25 });
        } finally {
            await harness.close();
        }
    });

    it('queues client requests until server activation completes', async () => {
        const harness = await createHarness();
        const activationGate = deferred<void>();
        let handled = false;

        harness.server.registerConnectionHandler(() => activationGate.promise);
        harness.server.registerMessageHandler('uEcho', (_stream, data) => {
            handled = true;
            return { message: `Echo: ${data.message}` };
        });

        const client = harness.createClient('client-activation');

        try {
            await client.connect();
            const response = client.invoke('uEcho', { message: 'queued' });
            await delay(20);

            assert.equal(handled, false);

            activationGate.resolve();
            assert.deepEqual(await response, { message: 'Echo: queued' });
            assert.equal(handled, true);
        } finally {
            await harness.close();
        }
    });

    it('rejects invalid HMAC credentials', async () => {
        const harness = await createHarness();
        const badClient = harness.createClient('bad-client', {}, 'wrong-secret');

        try {
            await assert.rejects(badClient.connect(), /Connection failed|Unexpected server response|Failed authentication/);
            assert.equal(badClient.isConnected, false);
        } finally {
            await harness.close();
        }
    });

    it('lets a custom authorizer replace HMAC auth and merge authorization metadata', async () => {
        const harness = await createHarness();
        const connected = deferred<SrpcStream<SrpcMeta>>();
        let keyFetcherCalls = 0;
        let receivedQuery: Record<string, unknown> | undefined;
        harness.server.setClientKeyFetcher(() => {
            keyFetcherCalls++;
            return false;
        });
        harness.server.setClientAuthorizer(query => {
            receivedQuery = query;
            return query.cid === 'authorized-client' ? { authorizedRole: 'worker' } : false;
        });
        harness.server.registerConnectionHandler(stream => connected.resolve(stream));

        const client = harness.createClient('authorized-client', { tenant: 'alpha' }, 'not-the-hmac-secret');
        const rejected = harness.createClient('rejected-client', {}, 'not-the-hmac-secret');

        try {
            await client.connect();
            const stream = await connected.promise;

            assert.equal(keyFetcherCalls, 0);
            assert.equal(receivedQuery?.cid, 'authorized-client');
            assert.equal(receivedQuery?.['m--tenant'], 'alpha');
            assert.deepEqual(stream.meta, { tenant: 'alpha', authorizedRole: 'worker' });
            await assert.rejects(rejected.connect(), /Connection failed|Unexpected server response|Failed authentication/);
        } finally {
            await harness.close();
        }
    });

    it('rejects signed handshakes outside the configured clock drift', async () => {
        const harness = await createHarness();

        try {
            const url = createSignedRawWebSocketUrl(harness.port, 'stale-client', Date.now() - 120_000);
            await assertWebSocketRejected(url, 403);
        } finally {
            await harness.close();
        }
    });

    it('rejects duplicate protocol-v2 clients unless superseded', async () => {
        const harness = await createHarness();
        const client1 = harness.createClient('shared-client');
        const client2 = harness.createClient('shared-client');
        const client3 = harness.createClient('shared-client');
        const disconnected = deferred<string>();
        client1.registerDisconnectHandler(cause => disconnected.resolve(cause));

        try {
            await client1.connect();
            await assert.rejects(client2.connect(), error => error instanceof SrpcConflictError);

            await client3.connect({ supersede: true });
            assert.equal(await disconnected.promise, 'supersede');
            assert.equal(client1.isConnected, false);
            assert.equal(client3.isConnected, true);
        } finally {
            await harness.close();
        }
    });

    it('keeps legacy protocol-v1 duplicate replacement behavior', async () => {
        const harness = await createHarness();
        const first = harness.createClient('legacy-shared', {}, secret, { protocolVersion: 1 });
        const second = harness.createClient('legacy-shared', {}, secret, { protocolVersion: 1 });
        const disconnected = deferred<string>();
        first.registerDisconnectHandler(cause => disconnected.resolve(cause));

        try {
            await first.connect();
            await second.connect();

            assert.equal(await disconnected.promise, 'supersede');
            assert.equal(first.isConnected, false);
            assert.equal(second.isConnected, true);
        } finally {
            await harness.close();
        }
    });

    it('runs class message handlers and emits connection, message, and disconnect observations', async () => {
        const harness = await createHarness();
        const observations: SrpcObservation[] = [];
        const disconnected = deferred<void>();
        const unregister = registerSrpcObserver(entry => {
            observations.push(entry);
            if (entry.type === 'disconnection' && entry.stream.clientId === 'observed-client') disconnected.resolve();
        });

        class EchoHandler {
            handle(_stream: SrpcStream<SrpcMeta>, data: { message: string }) {
                return { message: `Class: ${data.message}` };
            }
        }

        harness.server.registerMessageHandler('uEcho', EchoHandler);
        const client = harness.createClient('observed-client');

        try {
            await client.connect();
            assert.deepEqual(await client.invoke('uEcho', { message: 'hello' }), { message: 'Class: hello' });
            client.disconnect();
            await disconnected.promise;

            assert.equal(
                observations.some(entry => entry.type === 'connection' && entry.stream.clientId === 'observed-client'),
                true
            );
            assert.equal(
                observations.some(
                    entry =>
                        entry.type === 'message' && entry.direction === 'inbound' && (entry.data as ClientMessage).uEchoRequest?.message === 'hello'
                ),
                true
            );
            assert.equal(
                observations.some(
                    entry =>
                        entry.type === 'message' &&
                        entry.direction === 'outbound' &&
                        (entry.data as ServerMessage).uEchoResponse?.message === 'Class: hello'
                ),
                true
            );
            assert.equal(
                observations.some(
                    entry => entry.type === 'disconnection' && entry.stream.clientId === 'observed-client' && entry.cause === 'disconnect'
                ),
                true
            );
        } finally {
            unregister();
            await harness.close();
        }
    });

    it('reconnects after an unexpected disconnect and answers an explicit ping check', async () => {
        const harness = await createHarness();
        const reconnected = deferred<SrpcStream<SrpcMeta>>();
        let connectionCount = 0;
        harness.server.registerConnectionHandler(stream => {
            connectionCount++;
            if (connectionCount === 2) reconnected.resolve(stream);
        });
        const client = harness.createClient('reconnecting-client', {}, secret, { enableReconnect: true });

        try {
            await client.connect();
            harness.server.streamsByClientId.get('reconnecting-client')?.$ws.terminate();

            await withTimeout(reconnected.promise, 3_000, 'SRPC client did not reconnect');
            await waitForCondition(() => client.isConnected, 1_000, 'SRPC client handshake did not finish after reconnect');
            client.triggerConnectionCheck();
            await delay(20);
            assert.equal(client.isConnected, true);
        } finally {
            await harness.close();
        }
    });

    it('returns user errors and request timeouts', async () => {
        const harness = await createHarness();
        harness.server.registerMessageHandler('uError', (_stream, data) => {
            throw new SrpcError(data.message, data.userError);
        });
        harness.server.registerMessageHandler('uSlow', async (_stream, data) => {
            await delay(data.delayMs);
            return { ok: true };
        });

        const client = harness.createClient('client-errors');

        try {
            await client.connect();
            await assert.rejects(client.invoke('uError', { message: 'expected failure', userError: true }), /expected failure/);
            await assert.rejects(client.invoke('uSlow', { delayMs: 50 }, 5), /Request timeout after 5ms/);
        } finally {
            await harness.close();
        }
    });

    it('streams bytes from client to server through SrpcByteStream', async () => {
        const harness = await createHarness();
        harness.server.registerMessageHandler('uUpload', async (stream, data) => {
            const receiver = SrpcByteStream.createReceiver(stream, data.streamId);
            const chunks: Buffer[] = [];
            for await (const chunk of receiver) chunks.push(Buffer.from(chunk as Buffer));
            return { bytesReceived: Buffer.concat(chunks).length };
        });

        const client = harness.createClient('client-upload');

        try {
            await client.connect();
            const sender = SrpcByteStream.createSender(client);
            const upload = client.invoke('uUpload', { streamId: sender.id, filename: 'payload.bin' });
            sender.write(Buffer.from('abc'));
            sender.end(Buffer.from('def'));

            assert.deepEqual(await upload, { bytesReceived: 6 });
        } finally {
            await harness.close();
        }
    });

    it('streams bytes in both directions over real WebSockets', async () => {
        const harness = await createHarness();
        harness.server.registerMessageHandler('uUpload', async (stream, data) => {
            const receiver = SrpcByteStream.createReceiver(stream, data.streamId);
            const body = await collectByteStream(receiver);
            return { bytesReceived: body.length };
        });
        harness.server.registerMessageHandler('uDownload', (stream, data) => {
            const body = Buffer.from(`Test file contents for ${data.filename}`, 'utf8');
            const sender = SrpcByteStream.createSender(stream);
            queueMicrotask(() => sender.end(body));
            return { streamId: sender.id, bytesTotal: body.length };
        });

        const client = harness.createClient('client-byte-parity');

        try {
            await client.connect();

            const uploadData = Buffer.from('Hello from client byte stream!', 'utf8');
            const sender = SrpcByteStream.createSender(client);
            const upload = client.invoke('uUpload', { streamId: sender.id, filename: 'test.txt' });
            sender.end(uploadData);
            assert.deepEqual(await upload, { bytesReceived: uploadData.length });

            const download = await client.invoke('uDownload', { filename: 'download.txt' });
            const receiver = SrpcByteStream.createReceiver(client, download.streamId);
            assert.equal((await collectByteStream(receiver)).toString('utf8'), 'Test file contents for download.txt');
            assert.equal(download.bytesTotal, 'Test file contents for download.txt'.length);

            const largePayload = Buffer.alloc(1024 * 1024, 'x');
            const largeSender = SrpcByteStream.createSender(client);
            const largeUpload = client.invoke('uUpload', {
                streamId: largeSender.id,
                filename: 'large.bin'
            });
            largeSender.end(largePayload);
            assert.deepEqual(await largeUpload, { bytesReceived: largePayload.length });

            const textChunks = ['Hello ', 'from ', 'chunked ', 'stream!'];
            const chunkSender = SrpcByteStream.createSender(client);
            const chunkUpload = client.invoke('uUpload', {
                streamId: chunkSender.id,
                filename: 'chunks.txt'
            });
            for (const chunk of textChunks) chunkSender.write(Buffer.from(chunk, 'utf8'));
            chunkSender.end();
            assert.deepEqual(await chunkUpload, { bytesReceived: textChunks.join('').length });

            const readableData = 'Stream from Readable!';
            const readableSender = SrpcByteStream.createSender(client);
            const readableUpload = client.invoke('uUpload', {
                streamId: readableSender.id,
                filename: 'readable.txt'
            });
            const readableFinished = new Promise<void>((resolve, reject) => {
                readableSender.once('finish', resolve);
                readableSender.once('error', reject);
            });
            Readable.from([Buffer.from(readableData, 'utf8')]).pipe(readableSender);
            await readableFinished;
            assert.deepEqual(await readableUpload, { bytesReceived: readableData.length });
        } finally {
            await harness.close();
        }
    });

    it('accepts raw legacy WebSocket clients using signed query auth', async () => {
        const harness = await createHarness();
        harness.server.registerMessageHandler('uEcho', (_stream, data) => ({
            message: `Echo: ${data.message}`
        }));

        try {
            const response = await invokeRawWebSocketEcho(harness.port, 'raw-client', 'Hello via raw WS');
            assert.deepEqual(response, { message: 'Echo: Hello via raw WS' });
        } finally {
            await harness.close();
        }
    });

    it('claims matched upgrades so later upgrade listeners do not touch SRPC sockets', async () => {
        const harness = await createHarness();
        let laterListenerCalls = 0;
        harness.httpServer.on('upgrade', () => {
            laterListenerCalls++;
        });

        const client = harness.createClient('client-upgrade-claim');

        try {
            await client.connect();
            assert.equal(laterListenerCalls, 0);
        } finally {
            await harness.close();
        }
    });

    it('rejects unmatched app-level WebSocket upgrades', async () => {
        const harness = await createHarness();

        try {
            await assertUnmatchedUpgradeRejected(harness.port);
        } finally {
            await harness.close();
        }
    });

    it('dedupes and unregisters explicit httpServer upgrade handlers', async () => {
        const httpServer = createServer();
        await listenHttpServer(httpServer);
        const before = httpServer.rawListeners('upgrade').length;

        const first = new SrpcServer<SrpcMeta, ClientMessage, ServerMessage>({
            logger: createLogger('SrpcExternalOne'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/external-srpc',
            httpServer,
            logLevel: false
        });
        const afterFirst = httpServer.rawListeners('upgrade').length;

        const second = new SrpcServer<SrpcMeta, ClientMessage, ServerMessage>({
            logger: createLogger('SrpcExternalTwo'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/external-srpc',
            httpServer,
            logLevel: false
        });

        try {
            assert.equal(httpServer.rawListeners('upgrade').length, afterFirst);
            second.close();
            assert.equal(httpServer.rawListeners('upgrade').length, afterFirst);
            first.close();
            assert.equal(httpServer.rawListeners('upgrade').length, before);
        } finally {
            first.close();
            second.close();
            await closeHttpServer(httpServer);
        }
    });

    it('does not reject upgrades claimed by other handlers', async () => {
        const httpServer = createServer();
        httpServer.on('upgrade', (request, socket) => {
            if (request.url?.startsWith('/other')) {
                setTimeout(() => {
                    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
                    setTimeout(() => socket.end(), 1100).unref();
                }, 20).unref();
            }
        });
        const srpcServer = new SrpcServer<SrpcMeta, ClientMessage, ServerMessage>({
            logger: createLogger('SrpcOtherUpgrade'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/srpc',
            httpServer,
            logLevel: false
        });
        await listenHttpServer(httpServer);
        const port = (httpServer.address() as AddressInfo).port;
        const socket = new Socket();

        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.connect(port, '127.0.0.1', resolve);
            });
            const response = new Promise<string>(resolve => {
                const chunks: Buffer[] = [];
                socket.on('data', data => chunks.push(Buffer.from(data)));
                socket.once('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
            });
            socket.write('GET /other HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');

            const text = await response;
            assert.match(text, /^HTTP\/1\.1 101/);
            assert.doesNotMatch(text, /400 Bad Request/);
        } finally {
            socket.destroy();
            srpcServer.close();
            await closeHttpServer(httpServer);
        }
    });

    it('bounds pending byte-stream receivers and propagates local receiver aborts', async () => {
        const destroys: Array<{ streamId: number; error?: unknown }> = [];
        const stream = createFakeByteStreamable(destroys);

        SrpcByteStream.writeReceiver(stream, 10, Buffer.alloc(2 * 1024 * 1024 + 1));
        const oversizedReceiver = SrpcByteStream.createReceiver(stream, 10);
        const oversizedError = await streamError(oversizedReceiver);

        assert.match(oversizedError.message, /exceeded max buffered bytes/);

        destroys.length = 0;
        const receiver = SrpcByteStream.createReceiver(stream, 12);
        receiver.on('error', () => {});
        receiver.destroy(new Error('stop upload'));
        await streamClosed(receiver);

        assert.equal(destroys.length, 1);
        assert.equal(destroys[0].streamId, 12);
        assert.match(String(destroys[0].error), /stop upload/);
    });

    it('enforces total pending byte-stream buffering limits', async () => {
        const stream = createFakeByteStreamable([]);

        SrpcByteStream.writeReceiver(stream, 100, Buffer.alloc(1024 * 1024));
        SrpcByteStream.writeReceiver(stream, 101, Buffer.alloc(1024 * 1024));
        SrpcByteStream.writeReceiver(stream, 102, Buffer.alloc(1));

        const overLimitReceiver = SrpcByteStream.createReceiver(stream, 102);
        const error = await streamError(overLimitReceiver);

        assert.match(error.message, /exceeded max buffered bytes/);
    });

    it('fails byte-stream writes when the parent stream is not writable', async () => {
        const stream = createFakeByteStreamable([]);
        stream.byteStream.write = () => false;
        const sender = SrpcByteStream.createSender(stream);
        sender.on('error', () => {});

        const error = await new Promise<Error>((resolve, reject) => {
            sender.write(Buffer.from('drop'), err => {
                if (err) resolve(err);
                else reject(new Error('write unexpectedly succeeded'));
            });
        });

        assert.match(error.message, /not writable/);
    });

    it('waits for async parent byte-stream writes before acknowledging chunks', async () => {
        const stream = createFakeByteStreamable([]);
        const writeGate = deferred<void>();
        stream.byteStream.write = () => writeGate.promise;
        const sender = SrpcByteStream.createSender(stream);
        let callbackCalled = false;

        const writeDone = new Promise<void>((resolve, reject) => {
            sender.write(Buffer.from('delayed'), err => {
                callbackCalled = true;
                if (err) reject(err);
                else resolve();
            });
        });

        await delay(5);
        assert.equal(callbackCalled, false);

        writeGate.resolve();
        await writeDone;

        assert.equal(callbackCalled, true);
    });

    it('propagates async parent byte-stream write failures', async () => {
        const stream = createFakeByteStreamable([]);
        stream.byteStream.write = () => Promise.reject(new Error('send failed'));
        const sender = SrpcByteStream.createSender(stream);
        sender.on('error', () => {});

        const error = await new Promise<Error>((resolve, reject) => {
            sender.write(Buffer.from('drop'), err => {
                if (err) resolve(err);
                else reject(new Error('write unexpectedly succeeded'));
            });
        });

        assert.match(error.message, /send failed/);
    });
});

async function createHarness() {
    process.env.APP_ENV = 'test';
    const app = createApp({
        config: SrpcTestConfig,
        enableHealthcheck: false,
        frameworkConfig: { port: 0 }
    });
    const server = new SrpcServer<SrpcMeta, ClientMessage, ServerMessage>({
        logger: createLogger('SrpcTest'),
        clientMessage: JsonMessage,
        serverMessage: JsonMessage,
        wsPath: '/srpc-test',
        logLevel: false
    });
    server.setClientKeyFetcher(clientId => (clientId ? secret : false));

    const httpServer = await app.http.listen(0, '127.0.0.1');
    const port = (httpServer.address() as AddressInfo).port;
    const clients: SrpcClient<ClientMessage, ServerMessage>[] = [];

    return {
        app,
        server,
        httpServer,
        port,
        createClient(clientId: string, meta: SrpcMeta = {}, clientSecret = secret, clientOptions?: SrpcClientOptions) {
            const client = new SrpcClient<ClientMessage, ServerMessage>(
                createLogger(`SrpcClient:${clientId}`),
                `ws://127.0.0.1:${port}/srpc-test`,
                JsonMessage,
                JsonMessage,
                clientId,
                meta,
                clientSecret,
                { enableReconnect: false, ...clientOptions }
            );
            clients.push(client);
            return client;
        },
        async close() {
            for (const client of clients) client.disconnect();
            server.close();
            await app.stop();
        }
    };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function listenHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function collectByteStream(stream: SrpcByteStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

function invokeRawWebSocketEcho(port: number, clientId: string, message: string): Promise<NonNullable<ServerMessage['uEchoResponse']>> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(createSignedRawWebSocketUrl(port, clientId));
        const requestId = randomUUID();
        const pongBuffer = encodeRawSrpcMessage<ClientMessage>({ pingPong: {} });
        const requestBuffer = encodeRawSrpcMessage<ClientMessage>({
            requestId,
            uEchoRequest: { message }
        });
        let requestSent = false;
        let finished = false;

        const timeout = setTimeout(() => finish(new Error('Raw WebSocket SRPC test timed out')), 1000);

        const finish = (error?: Error, response?: NonNullable<ServerMessage['uEchoResponse']>) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            ws.removeAllListeners();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
            if (error) reject(error);
            else resolve(response!);
        };

        ws.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
        ws.once('close', code => {
            if (!finished) finish(new Error(`WebSocket closed before SRPC response (code: ${code})`));
        });
        ws.on('message', data => {
            const decoded = JsonMessage.decode(webSocketDataToBuffer(data)) as ServerMessage;

            if (decoded.pingPong) {
                ws.send(pongBuffer);
                if (!requestSent) {
                    requestSent = true;
                    ws.send(requestBuffer);
                }
                return;
            }

            if (decoded.reply && decoded.requestId === requestId && decoded.uEchoResponse) {
                finish(undefined, decoded.uEchoResponse);
            }
        });
    });
}

function createSignedRawWebSocketUrl(port: number, clientId: string, timestamp = Date.now()): string {
    const authv = 1;
    const appv = '0.0.0';
    const ts = String(timestamp);
    const id = randomUUID();
    const signature = createHmac('sha256', secret).update(`${authv}\n${appv}\n${ts}\n${id}\n${clientId}\n`).digest('hex');
    const params = new URLSearchParams({
        authv: String(authv),
        appv,
        ts,
        id,
        cid: clientId,
        signature,
        'm--testEnv': 'testapp-ws'
    });
    return `ws://127.0.0.1:${port}/srpc-test?${params.toString()}`;
}

function assertWebSocketRejected(url: string, expectedStatus: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket rejection timed out'));
        }, 1_000);

        ws.once('unexpected-response', (_request, response) => {
            clearTimeout(timeout);
            response.resume();
            if (response.statusCode === expectedStatus) resolve();
            else reject(new Error(`Expected WebSocket status ${expectedStatus}, received ${response.statusCode}`));
        });
        ws.once('open', () => {
            clearTimeout(timeout);
            ws.close();
            reject(new Error('WebSocket unexpectedly connected'));
        });
        ws.once('error', () => {
            // `unexpected-response` carries the HTTP status for authentication failures.
        });
    });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            timeout.unref?.();
        })
    ]);
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await delay(5);
    }
}

function encodeRawSrpcMessage<T>(message: T): Buffer {
    const encoded = JsonMessage.encode(message);
    const bytes = 'finish' in encoded ? encoded.finish() : encoded;
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function webSocketDataToBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

function assertUnmatchedUpgradeRejected(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: '127.0.0.1',
            port,
            path: '/missing-srpc',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': Buffer.from(randomUUID()).toString('base64')
            }
        });
        const timeout = setTimeout(() => {
            req.destroy();
            reject(new Error('Unmatched upgrade test timed out'));
        }, 3000);

        req.on('upgrade', () => {
            clearTimeout(timeout);
            reject(new Error('Upgrade should not have succeeded for unmatched path'));
        });
        req.on('response', res => {
            clearTimeout(timeout);
            res.resume();
            if (res.statusCode === 400) resolve();
            else reject(new Error(`Expected unmatched upgrade status 400 but got ${res.statusCode}`));
        });
        req.on('error', () => {
            clearTimeout(timeout);
            resolve();
        });
        req.end();
    });
}

function createFakeByteStreamable(destroys: Array<{ streamId: number; error?: unknown }>): IByteStreamable {
    const disconnectHandlers = new Set<() => void>();
    return {
        byteStream: {
            parentStreamId: 'fake-parent',
            write: () => true,
            finish: () => {},
            destroy: (streamId: number, error?: unknown) => {
                destroys.push({ streamId, error });
            },
            attachDisconnectHandler: (handler: () => void) => {
                disconnectHandlers.add(handler);
            },
            detachDisconnectHandler: (handler: () => void) => {
                disconnectHandlers.delete(handler);
            },
            getBufferedAmount: () => 0
        }
    };
}

function streamError(stream: SrpcByteStream): Promise<Error> {
    return new Promise(resolve => {
        stream.once('error', error => resolve(error));
    });
}

function streamClosed(stream: SrpcByteStream): Promise<void> {
    return new Promise(resolve => {
        stream.once('close', resolve);
    });
}

function bytesReplacer(_key: string, value: unknown): unknown {
    if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
    if (isBufferJson(value)) return { $bytes: Buffer.from(value.data).toString('base64') };
    return value;
}

function bytesReviver(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && '$bytes' in value && typeof value.$bytes === 'string') {
        return Buffer.from(value.$bytes, 'base64');
    }
    return value;
}

function isBufferJson(value: unknown): value is { type: 'Buffer'; data: number[] } {
    return (
        !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)
    );
}
