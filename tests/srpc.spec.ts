import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { afterEach, describe, it } from 'node:test';
import WebSocket from 'ws';

import {
    BaseAppConfig,
    createApp,
    createLogger,
    SrpcBackpressureError,
    SrpcByteStream,
    SrpcClient,
    SrpcConflictError,
    SrpcError,
    SrpcIndeterminateDeliveryError,
    SrpcMessageFns,
    SrpcMeta,
    SrpcServer,
    SrpcStream,
    deferred,
    registerSrpcObserver
} from '../src';
import type { BaseMessage, IByteStreamable, ISrpcServerOptions, SrpcClientOptions, SrpcObservation } from '../src';

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
    dComputeResponse?: { result: number; streamId?: number };
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
    it('rejects invalid configured sRPC resource and timer limits', () => {
        const serverOptions = {
            logger: createLogger('SrpcResourceOptionsTest'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/srpc-resource-options'
        };
        for (const name of [
            'maxPendingClientRequests',
            'maxPendingClientRequestBytes',
            'maxInFlightClientRequests',
            'maxInFlightClientRequestBytes',
            'maxBufferedBytes',
            'maxMessageBytes',
            'maxPendingServerRequests',
            'maxPendingServerRequestBytes',
            'maxPendingHandshakes',
            'maxActiveStreams',
            'maxClientIdBytes',
            'maxClientMetadataBytes',
            'maxAuthReplayPrincipals'
        ]) {
            assert.throws(() => new SrpcServer({ ...serverOptions, [name]: 0 }), new RegExp(name));
        }
        assert.throws(() => new SrpcServer({ ...serverOptions, lateReplyTombstoneTtlMs: 0x80000000 }), /lateReplyTombstoneTtlMs/);

        const createClient = (clientOptions: SrpcClientOptions) =>
            new SrpcClient<ClientMessage, ServerMessage>(
                createLogger('SrpcClientResourceOptionsTest'),
                'ws://127.0.0.1:1/srpc-resource-options',
                JsonMessage,
                JsonMessage,
                'resource-options-client',
                undefined,
                undefined,
                clientOptions
            );
        for (const name of [
            'maxPendingRequests',
            'maxPendingRequestBytes',
            'maxInFlightServerRequests',
            'maxInFlightServerRequestBytes',
            'maxBufferedBytes',
            'maxMessageBytes'
        ]) {
            assert.throws(() => createClient({ [name]: 0 }), new RegExp(name));
        }
        assert.throws(() => createClient({ lateReplyTombstoneTtlMs: 0x80000000 }), /lateReplyTombstoneTtlMs/);
        assert.throws(() => createClient({ connectTimeoutMs: 0x80000000 }), /connectTimeoutMs/);
    });

    it('ignores bounded late replies and rejects unknown UUID replies', async () => {
        const server = Object.create(SrpcServer.prototype) as any;
        const sent: Record<string, unknown>[] = [];
        const closed: [number, string][] = [];
        server.options = { serverMessage: JsonMessage, lateReplyTombstoneTtlMs: 10 };
        server.logger = createLogger('SrpcLateReplyTest');
        server.pendingServerRequestBytes = new WeakMap();
        server.lateReplyTombstonesByStream = new WeakMap();

        const stream = {
            $queue: new Map(),
            $ws: {
                readyState: WebSocket.OPEN,
                bufferedAmount: 0,
                close: (code: number, reason: string) => closed.push([code, reason]),
                send: (data: Buffer) => sent.push(JsonMessage.decode(data))
            },
            clientId: 'late-reply-client',
            isActivated: true
        };
        const request = server.invoke(stream as any, 'dNotify', { message: 'late reply' }, 1);
        await assert.rejects(request, error => {
            assert.equal(error instanceof SrpcIndeterminateDeliveryError, true);
            assert.match(String((error as Error & { cause?: unknown }).cause), /Request timeout after 1ms/);
            return true;
        });
        const requestId = sent[0]?.requestId;
        assert.equal(typeof requestId, 'string');

        server.handleStreamDataReceived(stream, { requestId, reply: true, dNotifyResponse: { received: 1 } });
        assert.deepEqual(closed, []);

        await delay(15);
        server.handleStreamDataReceived(stream, { requestId, reply: true, dNotifyResponse: { received: 1 } });
        assert.deepEqual(closed, [[4000, 'Unknown request ID']]);

        const unknownClosed: [number, string][] = [];
        const unknownStream = {
            $queue: new Map(),
            $ws: {
                readyState: WebSocket.OPEN,
                bufferedAmount: 0,
                close: (code: number, reason: string) => unknownClosed.push([code, reason])
            },
            clientId: 'unknown-reply-client',
            isActivated: true
        };
        server.handleStreamDataReceived(unknownStream, { requestId: randomUUID(), reply: true, dNotifyResponse: { received: 1 } });
        assert.deepEqual(unknownClosed, [[4000, 'Unknown request ID']]);

        server.options = {
            serverMessage: {
                ...JsonMessage,
                encode() {
                    throw new Error('encode failed');
                }
            }
        };
        const sendFailureStream = { $queue: new Map() };
        await assert.rejects(server.invoke(sendFailureStream as any, 'dNotify', { message: 'fail' }), /encode failed/);
        assert.equal(sendFailureStream.$queue.size, 0);

        const client = Object.create(SrpcClient.prototype) as any;
        client.requestQueue = new Map();
        client.requestBytes = new Map();
        client.lateReplyTombstones = new Map();
        client.clientOptions = { lateReplyTombstoneTtlMs: 10 };
        client.clientId = 'late-reply-client';
        client.clientMessage = JsonMessage;
        client.generation = 1;
        const clientSent: Record<string, unknown>[] = [];
        const clientWs = {
            readyState: WebSocket.OPEN,
            bufferedAmount: 0,
            send: (data: Buffer) => clientSent.push(JsonMessage.decode(data))
        };
        client.ws = clientWs;
        const timedOutRequest = client.invoke('uEcho', { message: 'late reply' }, 1);
        await assert.rejects(timedOutRequest, SrpcIndeterminateDeliveryError);
        const timedOutRequestId = clientSent[0]?.requestId;
        assert.equal(typeof timedOutRequestId, 'string');
        const clientClosed: string[] = [];
        client.closeGenerationWithError = (_ws: unknown, _generation: number, _cause: string, reason: string) => clientClosed.push(reason);
        client.handleReply(clientWs, 1, timedOutRequestId, {
            requestId: timedOutRequestId,
            reply: true
        });
        assert.deepEqual(clientClosed, []);

        const unknownClientRequestId = randomUUID();
        client.handleReply(clientWs, 1, unknownClientRequestId, { requestId: unknownClientRequestId, reply: true });
        assert.deepEqual(clientClosed, ['Unknown request ID']);

        await delay(15);
        client.handleReply(clientWs, 1, timedOutRequestId, { requestId: timedOutRequestId, reply: true });
        assert.deepEqual(clientClosed, ['Unknown request ID', 'Unknown request ID']);
    });

    it('bounds pending server RPC count and encoded bytes and recovers after settlement', async () => {
        const server = Object.create(SrpcServer.prototype) as any;
        server.options = {
            serverMessage: JsonMessage,
            maxPendingServerRequests: 1,
            maxPendingServerRequestBytes: 512
        };
        server.pendingServerRequestBytes = new WeakMap();
        const sent: Record<string, unknown>[] = [];
        const stream = {
            clientId: 'server-pressure-client',
            $queue: new Map(),
            $ws: {
                readyState: WebSocket.OPEN,
                bufferedAmount: 0,
                close() {},
                send: (data: Buffer) => sent.push(JsonMessage.decode(data))
            }
        };

        const first = server.invoke(stream, 'dNotify', { message: 'first' }, 1_000);
        await assert.rejects(server.invoke(stream, 'dNotify', { message: 'second' }, 1_000), /Too many pending server SRPC requests/);
        const firstRequestId = sent[0].requestId as string;
        const firstQueueItem = stream.$queue.get(firstRequestId);
        stream.$queue.delete(firstRequestId);
        firstQueueItem.resolve({ dNotifyResponse: { received: 1 } });
        assert.deepEqual(await first, { received: 1 });
        assert.equal(server.pendingServerRequestBytes.get(stream), undefined);

        server.options.maxPendingServerRequestBytes = 16;
        await assert.rejects(server.invoke(stream, 'dNotify', { message: 'too large' }, 1_000), /Too many pending server SRPC request bytes/);
        assert.equal(stream.$queue.size, 0);

        server.options.maxPendingServerRequestBytes = 512;
        const recovered = server.invoke(stream, 'dNotify', { message: 'recovered' }, 1_000);
        const recoveredMessage = sent.at(-1)!;
        const recoveredRequestId = recoveredMessage.requestId as string;
        const recoveredQueueItem = stream.$queue.get(recoveredRequestId);
        stream.$queue.delete(recoveredRequestId);
        recoveredQueueItem.resolve({ dNotifyResponse: { received: 2 } });
        assert.deepEqual(await recovered, { received: 2 });
        assert.equal(server.pendingServerRequestBytes.get(stream), undefined);
    });

    it('encodes a client invocation once and sends the exact retained bytes', async () => {
        const client = Object.create(SrpcClient.prototype) as any;
        const sent: Buffer[] = [];
        let encodeCalls = 0;
        client.logger = createLogger('SrpcEncodeOnceTest');
        client.clientId = 'encode-once-client';
        client.clientOptions = {
            maxPendingRequestBytes: 32,
            maxMessageBytes: 64,
            maxBufferedBytes: 64
        };
        client.clientMessage = {
            encode() {
                encodeCalls++;
                return { finish: () => Buffer.alloc(32, encodeCalls) };
            },
            decode: JsonMessage.decode
        };
        client.requestQueue = new Map();
        client.requestBytes = new Map();
        client.generation = 1;
        client.ws = {
            readyState: WebSocket.OPEN,
            bufferedAmount: 0,
            close() {},
            send: (data: Buffer) => sent.push(Buffer.from(data))
        };

        const response = client.invoke('uEcho', { message: 'stateful' }, 1_000);
        assert.equal(encodeCalls, 1);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].byteLength, 32);
        assert.equal(sent[0][0], 1);
        assert.equal(client.requestBytes.values().next().value, 32);

        const requestId = client.requestQueue.keys().next().value as string;
        client.handleReply(client.ws, 1, requestId, {
            requestId,
            reply: true,
            uEchoResponse: { message: 'ok' }
        });
        assert.deepEqual(await response, { message: 'ok' });
        assert.equal(client.requestBytes.size, 0);
    });

    it('accounts raw client inbound frame bytes before dispatch', async () => {
        const client = Object.create(SrpcClient.prototype) as any;
        const closed: string[] = [];
        const ws = {
            close: (_code: number, reason: string) => closed.push(reason)
        };
        client.logger = createLogger('SrpcRawFrameBytesTest');
        client.clientOptions = {
            maxMessageBytes: 128,
            maxInFlightServerRequestBytes: 16
        };
        client.serverMessage = {
            encode: JsonMessage.encode,
            decode: () => ({
                requestId: randomUUID(),
                dNotifyRequest: { message: 'compact decoded request' }
            })
        };
        client.ws = ws;
        client.generation = 1;
        client.isConnected = true;
        client.handlerPressureByGeneration = new Map();

        await client.handleMessage(ws, 1, Buffer.alloc(32));
        assert.deepEqual(closed, ['Too many in-flight server requests']);
    });

    it('bounds pending, in-flight, and outgoing client RPC pressure per stream', async () => {
        const closed: string[] = [];
        const server = Object.create(SrpcServer.prototype) as any;
        server.options = {
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            maxPendingClientRequests: 2,
            maxInFlightClientRequests: 1,
            maxBufferedBytes: 16
        };
        server.streamMessageHandlers = new Map();
        server.pendingClientRequests = new WeakMap();
        server.pendingClientRequestBytes = new WeakMap();
        server.inFlightClientRequests = new WeakMap();
        server.inFlightClientRequestBytes = new WeakMap();
        server.blockedClientRequests = new WeakSet();
        const pendingStream = {
            isActivated: false,
            $queue: new Map(),
            $ws: { close: (_code: number, reason: string) => closed.push(reason) }
        };

        server.handleStreamDataReceived(pendingStream, { requestId: 'one', uEchoRequest: { message: 'one' } });
        server.handleStreamDataReceived(pendingStream, { requestId: 'two', uEchoRequest: { message: 'two' } });
        server.handleStreamDataReceived(pendingStream, { requestId: 'three', uEchoRequest: { message: 'three' } });
        assert.equal(server.pendingClientRequests.get(pendingStream), undefined);
        assert.equal(server.pendingClientRequestBytes.get(pendingStream), undefined);
        assert.deepEqual(closed, ['Too many pending client requests']);

        const handler = deferred<{ message: string }>();
        server.streamMessageHandlers.set('uEchoRequest', { resultType: 'uEchoResponse', handler: async () => handler.promise });
        server.writeToStream = () => true;
        const activeStream = {
            isActivated: true,
            $queue: new Map(),
            $ws: { close: (_code: number, reason: string) => closed.push(reason) }
        };
        server.handleStreamDataReceived(activeStream, { requestId: 'one', uEchoRequest: { message: 'one' } });
        server.handleStreamDataReceived(activeStream, { requestId: 'two', uEchoRequest: { message: 'two' } });
        assert.deepEqual(closed, ['Too many pending client requests', 'Too many in-flight client requests']);
        handler.resolve({ message: 'done' });
        await delay(0);
        assert.equal(server.inFlightClientRequests.get(activeStream), undefined);

        const writes: Buffer[] = [];
        const bufferedStream = {
            $ws: {
                readyState: WebSocket.OPEN,
                bufferedAmount: 16,
                close: (_code: number, reason: string) => closed.push(reason),
                send: (data: Buffer) => writes.push(data)
            }
        };
        assert.equal(
            (SrpcServer.prototype as any).writeToStream.call(server, bufferedStream, { dNotifyRequest: { message: 'backpressure' } }),
            false
        );
        assert.equal(writes.length, 0);
        assert.equal(closed.at(-1), 'sRPC stream outgoing buffer limit exceeded');
    });

    it('bounds retained pending and in-flight request bytes per stream', async () => {
        const closed: string[] = [];
        const server = Object.create(SrpcServer.prototype) as any;
        server.options = {
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            maxPendingClientRequests: 8,
            maxPendingClientRequestBytes: 32,
            maxInFlightClientRequests: 8,
            maxInFlightClientRequestBytes: 32
        };
        server.streamMessageHandlers = new Map();
        server.pendingClientRequests = new WeakMap();
        server.pendingClientRequestBytes = new WeakMap();
        server.inFlightClientRequests = new WeakMap();
        server.inFlightClientRequestBytes = new WeakMap();
        server.blockedClientRequests = new WeakSet();
        const pendingStream = { isActivated: false, $queue: new Map(), $ws: { close: (_code: number, reason: string) => closed.push(reason) } };
        server.handleStreamDataReceived(pendingStream, { requestId: 'one', uEchoRequest: { message: 'x'.repeat(64) } });
        assert.equal(closed.at(-1), 'Too many pending client request bytes');

        const handler = deferred<{ message: string }>();
        server.streamMessageHandlers.set('uEchoRequest', { resultType: 'uEchoResponse', handler: async () => handler.promise });
        server.writeToStream = () => true;
        const activeStream = { isActivated: true, $queue: new Map(), $ws: { close: (_code: number, reason: string) => closed.push(reason) } };
        server.handleStreamDataReceived(activeStream, { requestId: 'one', uEchoRequest: { message: 'x'.repeat(64) } });
        assert.equal(closed.at(-1), 'Too many in-flight client request bytes');
        assert.equal(server.inFlightClientRequestBytes.get(activeStream), undefined);
    });

    it('revokes server dispatch synchronously before protocol and backpressure closes', async () => {
        const server = Object.create(SrpcServer.prototype) as any;
        server.logger = createLogger('SrpcServerRevocationTest');
        server.options = {
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            maxPendingClientRequests: 8,
            maxPendingClientRequestBytes: 512,
            maxInFlightClientRequests: 8,
            maxInFlightClientRequestBytes: 512,
            maxBufferedBytes: 64
        };
        server.streamDisconnectionHandlers = new Set();
        server.streamMessageHandlers = new Map();
        server.blockedClientRequests = new WeakSet();
        server.pendingClientRequests = new WeakMap();
        server.pendingClientRequestBytes = new WeakMap();
        server.inFlightClientRequests = new WeakMap();
        server.inFlightClientRequestBytes = new WeakMap();
        server.pendingServerRequestBytes = new WeakMap();
        server.backpressuredByteStreams = new WeakMap();
        server.backpressuredByteStreamBytes = new WeakMap();
        server.initialPongWaiters = new WeakMap();
        server.publishedStreams = new WeakSet();
        server.streamsById = new Map();
        server.streamsByClientId = new Map();
        server.pendingStreamsByClientId = new Map();

        let streamSequence = 0;
        const makeStream = (active = true, bufferedAmount = 0) => {
            const closes: Array<[number, string]> = [];
            const sends: Buffer[] = [];
            let sendCallback: ((error?: Error) => void) | undefined;
            const clientId = `revocation-${++streamSequence}`;
            const ws = {
                readyState: WebSocket.OPEN,
                bufferedAmount,
                close: (code: number, reason: string) => closes.push([code, reason]),
                send: (data: Buffer, callback?: (error?: Error) => void) => {
                    sends.push(Buffer.from(data));
                    sendCallback = callback;
                },
                on() {}
            };
            const stream = {
                id: `stream-${streamSequence}`,
                clientId,
                clientStreamId: `client-stream-${streamSequence}`,
                lastPingAt: Date.now(),
                isActivated: active,
                $queue: new Map(),
                $ws: ws
            };
            server.streamsById.set(stream.id, stream);
            if (active) {
                server.streamsByClientId.set(clientId, stream);
                server.publishedStreams.add(stream);
            } else {
                server.pendingStreamsByClientId.set(clientId, stream);
                server.blockedClientRequests.add(stream);
            }
            return { stream, ws, closes, sends, takeSendCallback: () => sendCallback };
        };
        const makeActualStream = (clientId: string) => {
            const closes: Array<[number, string]> = [];
            const ws = {
                readyState: WebSocket.OPEN,
                bufferedAmount: 0,
                close: (code: number, reason: string) => closes.push([code, reason]),
                send() {},
                on() {},
                off() {}
            };
            const stream = server.createStream(ws, {
                clientStreamId: `${clientId}-transport`,
                clientId,
                appVersion: 'test',
                configureTs: Date.now(),
                protocolVersion: 2,
                features: new Set(),
                supersede: false,
                address: '127.0.0.1',
                meta: {}
            });
            stream.isActivated = true;
            server.streamsById.set(stream.id, stream);
            server.streamsByClientId.set(clientId, stream);
            server.publishedStreams.add(stream);
            return { stream, ws, closes };
        };

        let disconnects = 0;
        server.registerDisconnectHandler(() => {
            disconnects++;
        });
        let handlerCalls = 0;
        server.registerMessageHandler('uEcho', () => {
            handlerCalls++;
            return { message: 'handled' };
        });

        const decoded = makeStream();
        server.handleWsMessage(decoded.stream, Buffer.from('{'));
        server.handleWsMessage(decoded.stream, encodeRawSrpcMessage({ requestId: 'valid-after-invalid', uEchoRequest: { message: 'must-not-run' } }));
        assert.equal(handlerCalls, 0);
        assert.deepEqual(decoded.closes, [[4000, 'Invalid message format']]);
        assert.equal(decoded.stream.lastPingAt, -1);
        assert.equal(server.streamsById.has(decoded.stream.id), false);
        assert.equal(server.streamsByClientId.has(decoded.stream.clientId), false);
        assert.equal(disconnects, 1);

        let byteStreamOperations = 0;
        server.handleByteSubstreamOperation = () => {
            byteStreamOperations++;
        };
        server.handleStreamDataReceived(decoded.stream, {
            byteStreamOperation: { streamId: 2, write: { chunk: Buffer.from('buffered') } }
        });
        assert.equal(byteStreamOperations, 0);
        server.handleStreamDisconnected(decoded.stream, 4000);
        assert.equal(disconnects, 1);

        const pending = makeStream(false);
        server.handleStreamDataReceived(pending.stream, {
            requestId: 'pending',
            uEchoRequest: { message: 'pending' }
        });
        assert.equal(server.pendingClientRequests.get(pending.stream)?.length, 1);
        server.handleStreamDataReceived(pending.stream, {});
        assert.equal(server.pendingClientRequests.get(pending.stream), undefined);
        assert.equal(server.pendingClientRequestBytes.get(pending.stream), undefined);
        assert.equal(server.blockedClientRequests.has(pending.stream), false);

        const handlerRelease = deferred<{ message: string }>();
        server.streamMessageHandlers.set('uEchoRequest', {
            resultType: 'uEchoResponse',
            handler: () => handlerRelease.promise
        });
        const completing = makeStream();
        let queuedRejects = 0;
        completing.stream.$queue.set('outgoing-request', {
            exp: Date.now() + 1_000,
            resolve() {},
            reject() {
                queuedRejects++;
            }
        });
        server.pendingServerRequestBytes.set(completing.stream, 32);
        server.backpressuredByteStreams.set(completing.stream, new Set([2]));
        server.backpressuredByteStreamBytes.set(completing.stream, new Map([[2, 32]]));
        server.handleStreamDataReceived(completing.stream, {
            requestId: 'held-handler',
            uEchoRequest: { message: 'held' }
        });
        const queuedWrite = server.writeToStreamAsync(completing.stream, { pingPong: {} });
        server.handleStreamDataReceived(completing.stream, {});
        assert.equal(queuedRejects, 1);
        assert.equal(completing.stream.$queue.size, 0);
        assert.equal(server.inFlightClientRequests.get(completing.stream), undefined);
        assert.equal(server.inFlightClientRequestBytes.get(completing.stream), undefined);
        assert.equal(server.pendingServerRequestBytes.get(completing.stream), undefined);
        assert.equal(server.backpressuredByteStreams.get(completing.stream), undefined);
        assert.equal(server.backpressuredByteStreamBytes.get(completing.stream), undefined);
        handlerRelease.resolve({ message: 'late response' });
        await delay(0);
        assert.equal(completing.sends.length, 1);
        completing.takeSendCallback()?.();
        await assert.rejects(queuedWrite, /stream revoked/);
        assert.equal(completing.sends.length, 1);

        const delayedSurface = makeActualStream('delayed-server-surface');
        const enteredDelayedHandler = deferred<void>();
        const releaseDelayedHandler = deferred<void>();
        let staleByteStreamError: Error | undefined;
        server.streamMessageHandlers.set('uEchoRequest', {
            resultType: 'uEchoResponse',
            handler: async () => {
                enteredDelayedHandler.resolve();
                await releaseDelayedHandler.promise;
                try {
                    SrpcByteStream.createSender(delayedSurface.stream);
                } catch (error) {
                    staleByteStreamError = error as Error;
                }
                return { message: 'late' };
            }
        });
        server.handleStreamDataReceived(delayedSurface.stream, {
            requestId: 'delayed-byte-stream-handler',
            uEchoRequest: { message: 'held' }
        });
        await enteredDelayedHandler.promise;
        assert.equal(delayedSurface.stream.connected, true);
        server.handleStreamDataReceived(delayedSurface.stream, {});
        assert.equal(delayedSurface.stream.connected, false);
        releaseDelayedHandler.resolve();
        await delay(0);
        assert.match(staleByteStreamError?.message ?? '', /generation is revoked/);

        const unknownReply = makeStream();
        server.handleStreamDataReceived(unknownReply.stream, {
            requestId: 'not-an-srpc-id',
            reply: true
        });
        assert.deepEqual(unknownReply.closes, [[4000, 'Unknown request ID']]);
        assert.equal(unknownReply.stream.lastPingAt, -1);

        const outgoingPressure = makeStream(true, 64);
        assert.equal(server.writeToStream(outgoingPressure.stream, { pingPong: {} }), false);
        assert.deepEqual(outgoingPressure.closes, [[4000, 'sRPC stream outgoing buffer limit exceeded']]);
        assert.equal(outgoingPressure.stream.lastPingAt, -1);
        assert.equal(server.streamsByClientId.has(outgoingPressure.stream.clientId), false);

        server.options.maxMessageBytes = 32;
        server.options.maxBufferedBytes = 1_024;
        const oversizedSync = makeStream();
        assert.equal(server.writeToStream(oversizedSync.stream, { uEchoResponse: { message: 'x'.repeat(128) } }), false);
        assert.deepEqual(oversizedSync.closes, [[4000, 'sRPC stream outgoing message limit exceeded']]);

        const oversizedAsync = makeStream();
        await assert.rejects(
            server.writeToStreamAsync(oversizedAsync.stream, {
                byteStreamOperation: { streamId: 2, write: { chunk: Buffer.alloc(128) } }
            }),
            SrpcBackpressureError
        );
        assert.deepEqual(oversizedAsync.closes, [[4000, 'sRPC stream outgoing message limit exceeded']]);

        server.streamMessageHandlers.set('uEchoRequest', {
            resultType: 'uEchoResponse',
            handler: () => ({ message: 'x'.repeat(128) })
        });
        const oversizedHandler = makeStream();
        server.handleStreamDataReceived(oversizedHandler.stream, {
            requestId: 'oversized-handler-response',
            uEchoRequest: { message: 'small' }
        });
        await delay(0);
        assert.deepEqual(oversizedHandler.closes, [[4000, 'sRPC stream outgoing message limit exceeded']]);

        server.options.maxMessageBytes = 512;
        const callbackFailure = makeStream();
        const failedWrite = server.writeToStreamAsync(callbackFailure.stream, { pingPong: {} });
        callbackFailure.takeSendCallback()?.(new Error('async send failed'));
        await assert.rejects(failedWrite, /async send failed/);
        assert.deepEqual(callbackFailure.closes, [[4000, 'Failed to send response']]);
        assert.equal(callbackFailure.stream.lastPingAt, -1);

        const syncSendFailure = makeStream();
        syncSendFailure.ws.send = () => {
            throw new Error('sync server send failed');
        };
        assert.equal(server.writeToStream(syncSendFailure.stream, { pingPong: {} }), false);
        assert.deepEqual(syncSendFailure.closes, [[4000, 'Failed to send response']]);
        assert.equal(syncSendFailure.stream.lastPingAt, -1);
        const disconnectsAfterSyncFailure = disconnects;
        server.handleStreamDisconnected(syncSendFailure.stream, 4000);
        assert.equal(disconnects, disconnectsAfterSyncFailure);

        const asyncThrowFailure = makeStream();
        asyncThrowFailure.ws.send = () => {
            throw new Error('async server send throw');
        };
        await assert.rejects(server.writeToStreamAsync(asyncThrowFailure.stream, { pingPong: {} }), /async server send throw/);
        assert.deepEqual(asyncThrowFailure.closes, [[4000, 'Failed to send response']]);
        assert.equal(asyncThrowFailure.stream.lastPingAt, -1);

        const graceful = makeActualStream('graceful-reason');
        await graceful.stream.close('requested graceful reason');
        assert.deepEqual(graceful.closes, [[1000, 'requested graceful reason']]);
        assert.equal(graceful.stream.connected, false);
    });

    it('revokes client generations synchronously before protocol and backpressure closes', async () => {
        const makeClient = (bufferedAmount = 0) => {
            const client = new SrpcClient<ClientMessage, ServerMessage>(
                createLogger('SrpcClientRevocationTest'),
                'ws://127.0.0.1/srpc',
                JsonMessage,
                JsonMessage,
                'client-revocation',
                {},
                secret,
                {
                    enableReconnect: false,
                    maxBufferedBytes: 1_024,
                    maxMessageBytes: 512,
                    maxInFlightServerRequests: 8,
                    maxInFlightServerRequestBytes: 512
                }
            ) as any;
            const closes: Array<[number, string]> = [];
            const sends: Buffer[] = [];
            let sendCallback: ((error?: Error) => void) | undefined;
            const ws = {
                readyState: WebSocket.OPEN,
                bufferedAmount,
                close: (code: number, reason: string) => closes.push([code, reason]),
                send: (data: Buffer, callback?: (error?: Error) => void) => {
                    sends.push(Buffer.from(data));
                    sendCallback = callback;
                },
                on() {}
            };
            client.ws = ws;
            client.generation = 1;
            client.isConnected = true;
            client.intentionalDisconnect = false;
            return { client, ws, closes, sends, takeSendCallback: () => sendCallback };
        };
        const encodeServer = (message: ServerMessage) => encodeRawSrpcMessage(message);

        for (const failure of ['throw', 'backpressure'] as const) {
            const handshake = makeClient(failure === 'backpressure' ? 1_024 : 0);
            handshake.client.isConnected = false;
            let connectionRejects = 0;
            let messageListeners = 0;
            let staleHandlerCalls = 0;
            handshake.client.connectReject = () => {
                connectionRejects++;
            };
            handshake.client.registerMessageHandler('dNotify', () => {
                staleHandlerCalls++;
                return { received: 1 };
            });
            handshake.ws.on = () => {
                messageListeners++;
            };
            if (failure === 'throw') {
                handshake.ws.send = () => {
                    throw new Error('handshake pong send failed');
                };
            }

            handshake.client.handleInitialHandshake(handshake.ws, 1, encodeServer({ pingPong: {} }), () => {});
            assert.equal(handshake.client.ws, undefined);
            assert.equal(handshake.client.awaitingActivation, undefined);
            assert.equal(messageListeners, 0);
            assert.equal(connectionRejects, 1);
            assert.equal(handshake.client.reconnectionTimeout, undefined);
            assert.deepEqual(handshake.closes, [
                [4000, failure === 'throw' ? 'Failed to send SRPC message' : 'sRPC stream outgoing buffer limit exceeded']
            ]);

            await handshake.client.handleMessage(
                handshake.ws,
                1,
                encodeServer({ requestId: 'stale-handshake-request', dNotifyRequest: { message: 'must-not-run' } })
            );
            assert.equal(staleHandlerCalls, 0);
            handshake.client.handleClose(handshake.ws, 1, 4000, Buffer.alloc(0), () => {});
            assert.equal(connectionRejects, 1);
        }

        const intentional = makeClient();
        intentional.client.enableReconnect = true;
        let intentionalDisconnects = 0;
        let delayedHandlerCalls = 0;
        intentional.client.registerDisconnectHandler(() => {
            intentionalDisconnects++;
        });
        intentional.client.registerMessageHandler('dNotify', () => {
            delayedHandlerCalls++;
            return { received: 1 };
        });
        const intentionalByteStream = intentional.client.createByteStream(1);
        intentional.client.currentByteStream = intentionalByteStream;
        intentional.client.byteStreamsByGeneration.set(1, intentionalByteStream);
        SrpcByteStream.init({ byteStream: intentionalByteStream }, { startId: 1, step: 2 });
        const revokedReceiver = SrpcByteStream.createReceiver(intentional.client, 2);
        revokedReceiver.on('error', () => {});
        const pendingAtDisconnect = intentional.client.invoke('uEcho', { message: 'pending' }, 1_000);
        intentional.client.disconnect();
        await assert.rejects(pendingAtDisconnect, SrpcIndeterminateDeliveryError);
        assert.equal(intentional.client.ws, undefined);
        assert.equal(intentional.client.isConnected, false);
        assert.equal(intentional.client.enableReconnect, false);
        assert.equal(intentional.client.reconnectionTimeout, undefined);
        assert.equal(intentionalDisconnects, 1);
        assert.deepEqual(intentional.closes, [[1000, 'Client disconnect']]);
        assert.equal(revokedReceiver.destroyed, true);
        assert.throws(() => SrpcByteStream.createReceiver(intentional.client, 4), /stale handler generation/);
        await intentional.client.handleMessage(
            intentional.ws,
            1,
            encodeServer({ requestId: 'delayed-after-disconnect', dNotifyRequest: { message: 'must-not-run' } })
        );
        intentional.client.handleClose(intentional.ws, 1, 1000, Buffer.alloc(0), () => {});
        assert.equal(delayedHandlerCalls, 0);
        assert.equal(intentionalDisconnects, 1);

        const decoded = makeClient();
        let disconnects = 0;
        let handlerCalls = 0;
        let byteStreamOperations = 0;
        decoded.client.registerDisconnectHandler(() => {
            disconnects++;
        });
        decoded.client.registerMessageHandler('dNotify', () => {
            handlerCalls++;
            return { received: 1 };
        });
        decoded.client.handleByteStreamOperation = () => {
            byteStreamOperations++;
        };
        decoded.client.handlerPressureByGeneration.set(1, { requests: 1, bytes: 32 });
        decoded.client.byteStreamsByGeneration.set(1, {});
        decoded.client.byteStreamPressureByGeneration.set(1, {
            backpressured: new Set([2]),
            bufferedBytes: new Map([[2, 32]])
        });
        const pendingRequest = decoded.client.invoke('uEcho', { message: 'pending' }, 1_000);
        const invalid = decoded.client.handleMessage(decoded.ws, 1, Buffer.from('{'));
        const validAfterInvalid = decoded.client.handleMessage(
            decoded.ws,
            1,
            encodeServer({ requestId: 'valid-after-invalid', dNotifyRequest: { message: 'must-not-run' } })
        );
        await Promise.all([invalid, validAfterInvalid]);
        await assert.rejects(pendingRequest, SrpcIndeterminateDeliveryError);
        assert.equal(handlerCalls, 0);
        assert.deepEqual(decoded.closes, [[4000, 'Invalid message format']]);
        assert.equal(decoded.client.ws, undefined);
        assert.equal(decoded.client.isConnected, false);
        assert.equal(decoded.client.requestQueue.size, 0);
        assert.equal(decoded.client.requestBytes.size, 0);
        assert.equal(decoded.client.handlerPressureByGeneration.has(1), false);
        assert.equal(decoded.client.byteStreamsByGeneration.has(1), false);
        assert.equal(decoded.client.byteStreamPressureByGeneration.has(1), false);
        assert.equal(disconnects, 1);

        await decoded.client.handleMessage(
            decoded.ws,
            1,
            encodeServer({ byteStreamOperation: { streamId: 2, write: { chunk: Buffer.from('buffered') } } })
        );
        assert.equal(byteStreamOperations, 0);
        decoded.client.handleClose(decoded.ws, 1, 4000, Buffer.alloc(0), () => {});
        assert.equal(disconnects, 1);

        const completion = makeClient();
        const handlerRelease = deferred<{ received: number }>();
        let enteredHandler = 0;
        completion.client.registerMessageHandler('dNotify', () => {
            enteredHandler++;
            return handlerRelease.promise;
        });
        const queuedWrite = completion.client.writeMessageAsync({ pingPong: {} }, 1);
        const handling = completion.client.handleMessage(
            completion.ws,
            1,
            encodeServer({ requestId: 'held-handler', dNotifyRequest: { message: 'held' } })
        );
        assert.equal(enteredHandler, 1);
        await completion.client.handleMessage(completion.ws, 1, encodeServer({}));
        handlerRelease.resolve({ received: 1 });
        await handling;
        assert.equal(completion.sends.length, 1);
        completion.takeSendCallback()?.();
        await assert.rejects(queuedWrite, /generation revoked/);
        assert.equal(completion.sends.length, 1);
        assert.equal(completion.client.handlerPressureByGeneration.has(1), false);

        const unknownReply = makeClient();
        await unknownReply.client.handleMessage(unknownReply.ws, 1, encodeServer({ requestId: 'not-an-srpc-id', reply: true }));
        assert.deepEqual(unknownReply.closes, [[4000, 'Unknown request ID']]);
        assert.equal(unknownReply.client.ws, undefined);

        const outgoingPressure = makeClient(1_024);
        assert.equal(outgoingPressure.client.writeMessage({ pingPong: {} }, 1), false);
        assert.deepEqual(outgoingPressure.closes, [[4000, 'sRPC stream outgoing buffer limit exceeded']]);
        assert.equal(outgoingPressure.client.ws, undefined);
        assert.equal(outgoingPressure.client.isConnected, false);

        const syncSendFailure = makeClient();
        syncSendFailure.ws.send = () => {
            throw new Error('sync send failed');
        };
        assert.equal(syncSendFailure.client.writeMessage({ pingPong: {} }, 1), false);
        assert.deepEqual(syncSendFailure.closes, [[4000, 'Failed to send SRPC message']]);
        assert.equal(syncSendFailure.client.ws, undefined);

        const callbackSendFailure = makeClient();
        let callbackDisconnects = 0;
        callbackSendFailure.client.registerDisconnectHandler(() => {
            callbackDisconnects++;
        });
        const callbackWrite = callbackSendFailure.client.writeMessageAsync({ pingPong: {} }, 1);
        callbackSendFailure.takeSendCallback()?.(new Error('async callback send failed'));
        await assert.rejects(callbackWrite, /async callback send failed/);
        assert.deepEqual(callbackSendFailure.closes, [[4000, 'Failed to send SRPC message']]);
        assert.equal(callbackSendFailure.client.ws, undefined);
        assert.equal(callbackDisconnects, 1);
        callbackSendFailure.client.handleClose(callbackSendFailure.ws, 1, 4000, Buffer.alloc(0), () => {});
        assert.equal(callbackDisconnects, 1);

        const asyncThrowFailure = makeClient();
        asyncThrowFailure.ws.send = () => {
            throw new Error('async send throw');
        };
        await assert.rejects(asyncThrowFailure.client.writeMessageAsync({ pingPong: {} }, 1), /async send throw/);
        assert.deepEqual(asyncThrowFailure.closes, [[4000, 'Failed to send SRPC message']]);
        assert.equal(asyncThrowFailure.client.ws, undefined);

        const pongTimeout = makeClient();
        pongTimeout.client.lastPongMs = 0;
        pongTimeout.client.doPingPong();
        assert.deepEqual(pongTimeout.closes, [[4003, 'Pong timeout']]);
        assert.equal(pongTimeout.client.ws, undefined);
    });

    it('preserves the exact presence and text of client byte-stream destroy reasons', async () => {
        const client = new SrpcClient<ClientMessage, ServerMessage>(
            createLogger('SrpcClientDestroyReasonTest'),
            'ws://127.0.0.1/srpc',
            JsonMessage,
            JsonMessage,
            'destroy-reason-client',
            {},
            secret,
            { enableReconnect: false }
        ) as any;
        const messages: any[] = [];
        client.writeMessage = (message: unknown) => {
            messages.push(message);
            return true;
        };
        const transport = client.createByteStream(1);
        await transport.destroy(1);
        await transport.destroy(3, '');
        await transport.destroy(5, new Error(''));
        assert.deepEqual(
            messages.map(message => message.byteStreamOperation.destroy.error),
            [undefined, '', '']
        );
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
            assert.equal(stream.features?.has('sender-announcements'), true);
            assert.deepEqual(stream.meta, { tenant: 'alpha' });
            await waitForCondition(() => stream.isActivated, 1_000, 'SRPC stream was not activated after connection handlers');
            assert.equal(await harness.server.resolveClient('client-1'), stream);
            assert.deepEqual(await harness.server.listClients(), [stream]);
            assert.equal(await harness.server.updateClientMetadata(stream, { region: 'test' }), true);
            assert.deepEqual(stream.meta, { tenant: 'alpha', region: 'test' });

            const broadcasts: string[] = [];
            harness.server.registerBroadcastHandler('refresh', (data: { key: string }) => {
                broadcasts.push(data.key);
            });
            await harness.server.broadcast('refresh', { key: 'local' });
            assert.deepEqual(broadcasts, ['local']);

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
        const handlerEntered = deferred<void>();
        const requestReceived = deferred<void>();
        const responseReceived = deferred<NonNullable<ServerMessage['uEchoResponse']>>();
        let handled = false;

        const unregister = registerSrpcObserver(entry => {
            if (entry.type === 'message' && entry.stream.clientId === 'client-activation' && (entry.data as ClientMessage).uEchoRequest) {
                requestReceived.resolve();
            }
        });
        harness.server.registerConnectionHandler(() => {
            handlerEntered.resolve();
            return activationGate.promise;
        });
        harness.server.registerMessageHandler('uEcho', (_stream, data) => {
            handled = true;
            return { message: `Echo: ${data.message}` };
        });

        const socket = new WebSocket(createSignedRawWebSocketUrl(harness.port, 'client-activation'));
        const requestId = randomUUID();
        socket.on('message', data => {
            const message = JsonMessage.decode(webSocketDataToBuffer(data)) as ServerMessage;
            if (message.reply && message.requestId === requestId && message.uEchoResponse) responseReceived.resolve(message.uEchoResponse);
        });

        try {
            await waitForWebSocketOpen(socket);
            await handlerEntered.promise;
            socket.send(encodeRawSrpcMessage<ClientMessage>({ requestId, uEchoRequest: { message: 'queued' } }));
            await requestReceived.promise;

            assert.equal(handled, false);

            activationGate.resolve();
            assert.deepEqual(await responseReceived.promise, { message: 'Echo: queued' });
            assert.equal(handled, true);
        } finally {
            socket.close();
            await harness.close();
            unregister();
        }
    });

    it('allows activation handlers to run beyond the former ten-second client boundary', async () => {
        const harness = await createHarness();
        harness.server.registerConnectionHandler(() => delay(10_050));
        const client = harness.createClient('slow-activation');

        try {
            const startedAt = Date.now();
            await client.connect();
            assert.equal(Date.now() - startedAt >= 10_000, true);
            assert.equal(client.isConnected, true);
        } finally {
            await harness.close();
        }
    });

    it('clears a pending generation connect timer when connect is superseded', async () => {
        const harness = await createHarness();
        const entered = deferred<void>();
        const release = deferred<void>();
        harness.server.registerConnectionHandler(() => {
            entered.resolve();
            return release.promise;
        });
        const client = harness.createClient('pending-connect-timer');

        try {
            const first = client.connect();
            first.catch(() => {});
            await entered.promise;
            const originalClear = (client as any).clearConnectTimeout as (() => void) | undefined;
            assert.equal(typeof originalClear, 'function');
            let cleared = 0;
            (client as any).clearConnectTimeout = () => {
                cleared++;
                originalClear!();
            };

            const second = client.connect({ supersede: true });
            await assert.rejects(first, /superseded/);
            assert.equal(cleared, 1);
            release.resolve();
            await second;
        } finally {
            release.resolve();
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

    it('rejects signed handshakes outside a finite, positive, bounded clock drift', async () => {
        const harness = await createHarness();

        try {
            const url = createSignedRawWebSocketUrl(harness.port, 'stale-client', Date.now() - 120_000);
            await assertWebSocketRejected(url, 403);
            (harness.app.config as any).SRPC_AUTH_CLOCK_DRIFT_MS = Infinity;
            await assertWebSocketRejected(createSignedRawWebSocketUrl(harness.port, 'infinite-drift-client'), 403);
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

    it('automatically supersedes an established generation retained by the server after an asymmetric break', async () => {
        const harness = await createHarness();
        const connectedStreams: SrpcStream<SrpcMeta>[] = [];
        harness.server.registerConnectionHandler(stream => {
            connectedStreams.push(stream);
        });
        const client = harness.createClient('asymmetric-reconnect-client', {}, secret, { enableReconnect: true });

        try {
            await client.connect();
            const staleStream = harness.server.streamsByClientId.get('asymmetric-reconnect-client')!;
            const serverCloseListeners = staleStream.$ws.listeners('close');
            assert.equal(serverCloseListeners.length > 0, true);
            // Retain the server registry entry while allowing ws's own internal
            // close bookkeeping to run, modeling a missed remote close signal.
            staleStream.$ws.off('close', serverCloseListeners.at(-1)!);
            (client as any).ws.terminate();

            await waitForCondition(() => client.isConnected === false, 1_000, 'client did not observe the asymmetric break');
            await waitForCondition(() => connectedStreams.length === 2, 3_000, 'client did not supersede the stale server generation');
            await waitForCondition(() => client.isConnected === true, 1_000, 'client reconnect handshake did not complete');

            const replacement = harness.server.streamsByClientId.get('asymmetric-reconnect-client');
            assert.notStrictEqual(replacement, staleStream);
            assert.strictEqual(replacement, connectedStreams[1]);
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
            for (const expected of [
                { message: 'expected failure', userError: true },
                { message: '', userError: false },
                { message: '', userError: undefined }
            ]) {
                const request: { message: string; userError?: boolean } = { message: expected.message };
                if (expected.userError !== undefined) request.userError = expected.userError;
                await assert.rejects(client.invoke('uError', request), error => {
                    assert.ok(error instanceof SrpcError);
                    assert.equal(error.message, expected.message);
                    assert.equal(error.isUserError, expected.userError);
                    return true;
                });
            }
            await assert.rejects(client.invoke('uSlow', { delayMs: 50 }, 5), error => {
                assert.equal(error instanceof SrpcIndeterminateDeliveryError, true);
                assert.match(String((error as Error & { cause?: unknown }).cause), /Request timeout after 5ms/);
                return true;
            });
        } finally {
            await harness.close();
        }
    });

    it('preserves client-handler SrpcError identity and user-error state on the server', async () => {
        const harness = await createHarness();
        const client = harness.createClient('client-handler-error');
        let clientError = new SrpcError('client-side expected failure', true);
        client.registerMessageHandler('dNotify', () => {
            throw clientError;
        });

        try {
            await client.connect();
            const stream = harness.server.streamsByClientId.get('client-handler-error')!;
            for (const expected of [
                { message: 'client-side expected failure', userError: true },
                { message: '', userError: false },
                { message: '', userError: undefined }
            ]) {
                clientError = new SrpcError(expected.message, expected.userError);
                await assert.rejects(harness.server.invoke(stream, 'dNotify', { message: 'trigger' }), error => {
                    assert.ok(error instanceof SrpcError);
                    assert.equal(error.message, expected.message);
                    assert.equal(error.isUserError, expected.userError);
                    return true;
                });
            }
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

    it('accepts raw v2 WebSocket clients using canonical signed query auth', async () => {
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

    it('fails write, finish, and destroy deterministically at the pending receiver ID cap', () => {
        for (const operation of ['write', 'finish', 'destroy'] as const) {
            const stream = createFakeByteStreamable([]);
            for (let index = 0; index < 1_024; index++) {
                SrpcByteStream.finishReceiver(stream, index * 2 + 1);
            }
            const overflowId = 2_049;
            assert.throws(() => {
                if (operation === 'write') SrpcByteStream.writeReceiver(stream, overflowId, Buffer.from('must-not-drop'));
                else if (operation === 'finish') SrpcByteStream.finishReceiver(stream, overflowId);
                else SrpcByteStream.destroySubstream(stream, overflowId);
            }, /Too many pending sRPC byte stream receivers/);
            assert.equal(getByteStreamInfo(stream).pendingReceivers.size, 1_024);
        }
    });

    it('fences a real server stream when an unknown byte-stream operation exceeds the receiver ID cap', () => {
        for (const operation of ['write', 'finish', 'destroy'] as const) {
            const parent = createFakeByteStreamable([]);
            let revoked = false;
            const stream = Object.assign(parent, {
                id: `overflow-${operation}`,
                clientId: 'overflow-client',
                lastPingAt: 1,
                isActivated: true,
                $queue: new Map(),
                resolveByteStream: () => {
                    if (revoked) throw new Error('SRPC stream generation is revoked');
                    return parent.byteStream;
                }
            }) as any;
            for (let index = 0; index < 1_024; index++) {
                SrpcByteStream.finishReceiver(stream, index * 2 + 1);
            }
            const overflowId = 2_049;
            const byteStreamOperation =
                operation === 'write'
                    ? { streamId: overflowId, write: { chunk: Buffer.from('must-not-drop') } }
                    : operation === 'finish'
                      ? { streamId: overflowId, finish: {} }
                      : { streamId: overflowId, destroy: {} };
            const server = Object.create(SrpcServer.prototype) as any;
            server.options = {
                clientMessage: {
                    decode: () => ({ byteStreamOperation })
                }
            };
            server.logger = { warn: () => {} };
            server.isStreamDispatchAvailable = () => !revoked;
            server.backpressuredByteStreams = new WeakMap();
            server.backpressuredByteStreamBytes = new WeakMap();
            server.closeStreamWithError = (_stream: unknown, cause: string, reason: string) => {
                assert.equal(cause, 'badArg');
                assert.equal(reason, 'Invalid message format');
                revoked = true;
                stream.lastPingAt = -1;
            };

            server.handleWsMessage(stream, Buffer.alloc(0));
            assert.equal(revoked, true);
            assert.throws(() => SrpcByteStream.createReceiver(stream, overflowId), /generation is revoked/);
        }
    });

    it('retains a clean pending remote destroy as distinct terminal state without echoing it', async () => {
        const destroys: Array<{ streamId: number; error?: unknown }> = [];
        const stream = createFakeByteStreamable(destroys);
        SrpcByteStream.writeReceiver(stream, 11, Buffer.from('discarded'));
        SrpcByteStream.destroySubstream(stream, 11);
        const pending = getByteStreamInfo(stream).pendingReceivers.get(11);
        assert.equal(pending.destroyed, true);
        assert.equal(pending.destroyedError, undefined);
        assert.equal(pending.chunks.length, 0);

        const receiver = SrpcByteStream.createReceiver(stream, 11);
        await streamClosed(receiver);
        assert.equal((receiver as any).remotelyDestroyed, true);
        assert.equal(destroys.length, 0);

        const emptyReason = createFakeByteStreamable([]);
        SrpcByteStream.destroySubstream(emptyReason, 13, '');
        const emptyReceiver = SrpcByteStream.createReceiver(emptyReason, 13);
        assert.equal((await streamError(emptyReceiver)).message, '');
    });

    it('aborts an attached receiver when incoming writes exceed its readable buffer', async () => {
        const destroys: Array<{ streamId: number; error?: unknown }> = [];
        const stream = createFakeByteStreamable(destroys);
        const receiver = SrpcByteStream.createReceiver(stream, 14);
        const server = Object.create(SrpcServer.prototype) as SrpcServer;
        (server as any).backpressuredByteStreams = new WeakMap();
        (server as any).backpressuredByteStreamBytes = new WeakMap();

        for (let index = 0; index < 128 && !receiver.destroyed; index++) {
            (server as any).handleByteSubstreamOperation(stream, {
                streamId: 14,
                write: { chunk: Buffer.alloc(1024) }
            });
        }
        await streamClosed(receiver);

        assert.equal(receiver.destroyed, true);
        assert.equal(destroys.length, 1);
        assert.equal(destroys[0].streamId, 14);
    });

    it('bounds aggregate attached receiver bytes until buffered data is consumed', async () => {
        const destroys: Array<{ streamId: number; error?: unknown }> = [];
        const stream = createFakeByteStreamable(destroys);
        const server = Object.create(SrpcServer.prototype) as SrpcServer;
        (server as any).backpressuredByteStreams = new WeakMap();
        (server as any).backpressuredByteStreamBytes = new WeakMap();
        stream.byteStream.receiverBufferChanged = (streamId, bufferedBytes) =>
            (server as any).updateByteStreamBufferedBytes(stream, streamId, bufferedBytes);
        const first = SrpcByteStream.createReceiver(stream, 20);
        const second = SrpcByteStream.createReceiver(stream, 22);
        const rejected = SrpcByteStream.createReceiver(stream, 24);
        rejected.on('error', () => {});

        for (const streamId of [20, 22, 24]) {
            (server as any).handleByteSubstreamOperation(stream, {
                streamId,
                write: { chunk: Buffer.alloc(3 * 1024 * 1024) }
            });
        }
        await streamClosed(rejected);

        assert.equal(rejected.destroyed, true);
        assert.equal(
            destroys.some(entry => entry.streamId === 24),
            true
        );
        assert.equal(
            [...((server as any).backpressuredByteStreamBytes.get(stream) as Map<number, number>).values()].reduce(
                (total, bytes) => total + bytes,
                0
            ),
            6 * 1024 * 1024
        );

        (server as any).handleByteSubstreamOperation(stream, { streamId: 20, finish: {} });
        first.resume();
        await finished(first, { writable: false });
        assert.equal((server as any).backpressuredByteStreamBytes.get(stream)?.has(20) ?? false, false);

        const replacement = SrpcByteStream.createReceiver(stream, 26);
        replacement.on('error', () => {});
        (server as any).handleByteSubstreamOperation(stream, {
            streamId: 26,
            write: { chunk: Buffer.alloc(3 * 1024 * 1024) }
        });
        assert.equal(replacement.destroyed, false);

        second.destroy();
        replacement.destroy();
        await Promise.all([streamClosed(second), streamClosed(replacement)]);
    });

    it('starts a new backpressure episode after the receiver makes progress', async () => {
        const destroys: Array<{ streamId: number; error?: unknown }> = [];
        const stream = createFakeByteStreamable(destroys);
        const server = Object.create(SrpcServer.prototype) as SrpcServer;
        (server as any).backpressuredByteStreams = new WeakMap();
        (server as any).backpressuredByteStreamBytes = new WeakMap();
        stream.byteStream.receiverBufferChanged = (streamId, bufferedBytes) =>
            (server as any).updateByteStreamBufferedBytes(stream, streamId, bufferedBytes);
        const receiver = SrpcByteStream.createReceiver(stream, 28);
        receiver.on('error', () => {});
        const chunkBytes = receiver.readableHighWaterMark * 2;
        const write = (bytes: number) =>
            (server as any).handleByteSubstreamOperation(stream, {
                streamId: 28,
                write: { chunk: Buffer.alloc(bytes) }
            });

        write(chunkBytes);
        assert.equal((server as any).backpressuredByteStreams.get(stream)?.has(28), true);
        assert.equal(receiver.read(receiver.readableHighWaterMark)?.length, receiver.readableHighWaterMark);
        assert.equal((server as any).backpressuredByteStreams.get(stream)?.has(28) ?? false, false);

        write(chunkBytes);
        assert.equal(receiver.destroyed, false);
        write(1);
        await streamClosed(receiver);
        assert.equal(receiver.destroyed, true);
    });

    it('gives client receivers one bounded backpressure episode and resets it on progress', async () => {
        const destroys: Array<{ streamId: number; error?: unknown }> = [];
        const parent = createFakeByteStreamable(destroys);
        parent.byteStream.remoteSenderIdParity = 0;
        const client = Object.create(SrpcClient.prototype) as any;
        client.generation = 7;
        client.clientOptions = { maxBufferedBytes: 8 * 1024 * 1024 };
        client.byteStreamPressureByGeneration = new Map();
        client.resolveByteStream = () => parent.byteStream;
        parent.byteStream.receiverBufferChanged = (streamId, bufferedBytes) => client.updateByteStreamBufferedBytes(7, streamId, bufferedBytes);
        const receiver = SrpcByteStream.createReceiver(client, 2);
        receiver.on('error', () => {});
        const chunkBytes = receiver.readableHighWaterMark * 2;
        const write = (bytes: number) =>
            client.handleByteStreamOperation(7, {
                streamId: 2,
                write: { chunk: Buffer.alloc(bytes) }
            });

        write(chunkBytes);
        assert.equal(receiver.destroyed, false);
        assert.equal(client.byteStreamPressureByGeneration.get(7).backpressured.has(2), true);
        assert.equal(receiver.read(receiver.readableHighWaterMark)?.length, receiver.readableHighWaterMark);
        assert.equal(client.byteStreamPressureByGeneration.get(7).backpressured.has(2), false);

        write(chunkBytes);
        assert.equal(receiver.destroyed, false);
        write(1);
        await streamClosed(receiver);
        assert.equal(receiver.destroyed, true);
        assert.equal(
            destroys.some(entry => entry.streamId === 2),
            true
        );
    });

    it('rejects mixed and malformed byte-stream operations', () => {
        const stream = createFakeByteStreamable([]);
        const server = Object.create(SrpcServer.prototype) as any;
        const client = Object.create(SrpcClient.prototype) as any;
        client.resolveByteStream = () => stream.byteStream;

        for (const operation of [
            { streamId: 1, write: { chunk: Buffer.alloc(0) }, finish: {} },
            { streamId: 1, write: {} },
            { streamId: 1, write: 0 },
            { streamId: 1, finish: [] },
            { streamId: 1, finish: false },
            { streamId: 1, destroy: '' },
            { streamId: 1, destroy: { error: 42 } }
        ]) {
            assert.equal(server.validRemoteByteStreamOperation(stream, operation), false);
            assert.equal(client.validRemoteByteStreamOperation(operation), false);
        }
    });

    it('preserves abort errors for attached byte-stream receivers', async () => {
        const stream = createFakeByteStreamable([]);
        const receiver = SrpcByteStream.createReceiver(stream, 16);
        const error = new Error('remote upload cancelled');
        const observed = streamError(receiver);

        SrpcByteStream.abortReceiver(stream, 16, error);

        assert.strictEqual(await observed, error);
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

    it('bounds retained remote destroy errors and accounts them as pending receiver bytes', async () => {
        const stream = createFakeByteStreamable([]);
        SrpcByteStream.destroySubstream(stream, 104, 'é'.repeat(1024 * 1024));
        const info = getByteStreamInfo(stream);

        assert.equal(info.pendingReceiverBytes > 0, true);
        assert.equal(info.pendingReceiverBytes <= 1024, true);

        const receiver = SrpcByteStream.createReceiver(stream, 104);
        const error = await streamError(receiver);
        assert.equal(Buffer.byteLength(error.message) <= 1024, true);
        assert.equal(info.pendingReceiverBytes, 0);
    });

    it('rejects writes after attached and pending receiver finishes without pushing after EOF', async () => {
        const attached = createFakeByteStreamable([]);
        const receiver = SrpcByteStream.createReceiver(attached, 106);
        const attachedError = streamError(receiver);
        SrpcByteStream.finishReceiver(attached, 106);
        assert.equal(SrpcByteStream.writeReceiver(attached, 106, Buffer.from('late')), false);
        assert.match((await attachedError).message, /received data after finish/);

        const pending = createFakeByteStreamable([]);
        SrpcByteStream.writeReceiver(pending, 108, Buffer.alloc(1024 * 1024));
        SrpcByteStream.finishReceiver(pending, 108);
        assert.equal(SrpcByteStream.writeReceiver(pending, 108, Buffer.from('late')), false);
        const pendingInfo = getByteStreamInfo(pending);
        assert.equal(pendingInfo.pendingReceiverChunkBytes, 0);
        assert.equal(pendingInfo.pendingReceiverBytes <= 1024, true);
        const pendingReceiver = SrpcByteStream.createReceiver(pending, 108);
        assert.match((await streamError(pendingReceiver)).message, /received data after finish/);
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

    it('does not let delayed old-generation cleanup remove a reused stream ID', async () => {
        const parent = createFakeByteStreamable([]);
        const oldSender = SrpcByteStream.createSender(parent);
        assert.equal(oldSender.id, 1);

        SrpcByteStream.init(parent, { startId: 1, step: 2 });
        const currentSender = SrpcByteStream.createSender(parent);
        assert.equal(currentSender.id, oldSender.id);

        oldSender.destroy();
        await streamClosed(oldSender);

        assert.equal(SrpcByteStream.hasSender(parent, currentSender.id), true);
        currentSender.destroy();
        await streamClosed(currentSender);
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

    it('releases sender registrations after a successful terminal finish and propagates false terminal writes', async () => {
        const parent = createFakeByteStreamable([]);
        const sender = SrpcByteStream.createSender(parent);
        const finishedSender = new Promise<void>(resolve => sender.once('finish', resolve));
        sender.end(Buffer.from('done'));
        await finishedSender;
        assert.equal(SrpcByteStream.hasSender(parent, sender.id), false);
        assert.equal(SrpcByteStream.hasTerminalSender(parent, sender.id), true);
        assert.throws(() => SrpcByteStream.createReceiver(parent, sender.id), /recently finished local sender/);

        const server = Object.create(SrpcServer.prototype) as any;
        server.backpressuredByteStreams = new WeakMap();
        server.backpressuredByteStreamBytes = new WeakMap();
        server.handleByteSubstreamOperation(parent, { streamId: sender.id, destroy: { error: 'late destroy' } });
        assert.equal(SrpcByteStream.hasTerminalSender(parent, sender.id), false);

        parent.byteStream.finish = () => false;
        const rejected = SrpcByteStream.createSender(parent);
        rejected.on('error', () => {});
        rejected.end();
        const error = await streamError(rejected);
        assert.match(error.message, /not writable/);
        assert.equal(SrpcByteStream.hasTerminalSender(parent, rejected.id), false);
    });

    it('validates direct receiver construction and custom sender allocator collisions', async () => {
        const direct = createFakeByteStreamable([]);
        direct.byteStream.remoteSenderIdParity = 1;
        assert.throws(() => SrpcByteStream.createReceiver(direct, 0), /Invalid stream ID/);
        assert.throws(() => SrpcByteStream.createReceiver(direct, undefined as any), /Invalid stream ID/);
        assert.throws(() => new SrpcByteStream(direct, -1), /Invalid stream ID/);
        assert.throws(() => new SrpcByteStream(direct, Number.MAX_SAFE_INTEGER), /Invalid stream ID/);
        assert.throws(() => new SrpcByteStream(direct, 2), /Invalid remote sender stream ID/);
        const receiver = new SrpcByteStream(direct, 1);
        assert.throws(() => new SrpcByteStream(direct, 1), /already exists/);

        const allocated = createFakeByteStreamable([]);
        const activeSender = SrpcByteStream.createSender(allocated);
        allocated.byteStream.allocateSenderId = () => activeSender.id;
        assert.throws(() => SrpcByteStream.createSender(allocated), /colliding/);

        const receiverCollision = SrpcByteStream.createReceiver(allocated, 3);
        allocated.byteStream.allocateSenderId = () => receiverCollision.id;
        assert.throws(() => SrpcByteStream.createSender(allocated), /colliding/);

        const wrongParity = createFakeByteStreamable([]);
        wrongParity.byteStream.remoteSenderIdParity = 1;
        wrongParity.byteStream.allocateSenderId = () => 1;
        assert.throws(() => SrpcByteStream.createSender(wrongParity), /colliding/);

        const terminalCollision = createFakeByteStreamable([]);
        const finishedSender = SrpcByteStream.createSender(terminalCollision);
        const finished = new Promise<void>(resolve => finishedSender.once('finish', resolve));
        finishedSender.end();
        await finished;
        terminalCollision.byteStream.allocateSenderId = () => finishedSender.id;
        assert.throws(() => SrpcByteStream.createSender(terminalCollision), /colliding/);

        receiver.destroy();
        activeSender.destroy();
        receiverCollision.destroy();
        await Promise.all([streamClosed(receiver), streamClosed(activeSender), streamClosed(receiverCollision)]);
    });

    it('enforces the terminal sender bound while an active sender transitions to finished', async () => {
        const parent = createFakeByteStreamable([]);
        const sender = SrpcByteStream.createSender(parent);
        const info = getByteStreamInfo(parent);
        const expiresAt = Date.now() + 60_000;
        for (let index = 0; index < 65_536; index++) info.terminalSenders.set(index + 100, expiresAt);
        const errorPromise = streamError(sender);
        const closedPromise = streamClosed(sender);

        sender.end();

        assert.match((await errorPromise).message, /Too many recently finished/);
        assert.equal(info.terminalSenders.size, 65_536);
        await closedPromise;
    });

    it('rejects non-v2 handshakes', async () => {
        const harness = await createHarness();
        harness.server.registerMessageHandler('uEcho', (_stream, data) => ({ message: data.message }));
        try {
            const url = new URL(createSignedRawWebSocketUrl(harness.port, 'non-v2-auth'));
            url.searchParams.set('_v', '1');
            await assertWebSocketRejected(url.toString(), 400);
        } finally {
            await harness.close();
        }
    });

    it('optionally accepts legacy handshakes that omit the protocol version', async () => {
        const harness = await createHarness({ allowMissingProtocolVersion: true });
        const connected = deferred<SrpcStream<SrpcMeta>>();
        harness.server.setClientAuthorizer(() => true);
        harness.server.registerConnectionHandler(stream => connected.resolve(stream));
        const url = `ws://127.0.0.1:${harness.port}/srpc-test?id=${randomUUID()}&cid=legacy-client&appv=1`;
        const client = new WebSocket(url);

        try {
            await waitForWebSocketOpen(client);
            const stream = await connected.promise;
            assert.equal(stream.protocolVersion, 2);
            await waitForCondition(() => stream.isActivated, 1_000, 'Legacy stream was not activated without a ping response');
        } finally {
            client.close();
            await harness.close();
        }
    });

    it('activates after sending the ordered initial ping without waiting for a pong', async () => {
        const harness = await createHarness();
        const connected = deferred<SrpcStream<SrpcMeta>>();
        const receivedInitialPing = deferred<void>();
        harness.server.setClientAuthorizer(() => true);
        harness.server.registerConnectionHandler(stream => connected.resolve(stream));
        const url = `ws://127.0.0.1:${harness.port}/srpc-test?id=${randomUUID()}&cid=no-initial-pong&appv=1&_v=2`;
        const client = new WebSocket(url);

        client.on('message', data => {
            const message = JsonMessage.decode(webSocketDataToBuffer(data)) as ServerMessage;
            if (message.pingPong) receivedInitialPing.resolve();
        });

        try {
            await waitForWebSocketOpen(client);
            const stream = await connected.promise;
            await receivedInitialPing.promise;
            await waitForCondition(() => stream.isActivated, 1_000, 'Stream was not activated without a ping response');
            assert.equal(stream.connected, true);
        } finally {
            client.close();
            await harness.close();
        }
    });

    it('rejects replayed v2 credentials and validates invocation timer bounds', async () => {
        const harness = await createHarness();
        const url = createSignedRawWebSocketUrl(harness.port, 'replay-client');
        try {
            const first = new WebSocket(url);
            await new Promise<void>((resolve, reject) => {
                first.once('open', resolve);
                first.once('error', reject);
            });
            first.close();
            await assertWebSocketRejected(url, 403);
            const client = harness.createClient('timer-client');
            assert.throws(() => client.invoke('uEcho', { message: 'x' }, 0), /safe positive integer/);
            assert.throws(() => client.invoke('uEcho', { message: 'x' }, 0x80000000), /safe positive integer/);
        } finally {
            await harness.close();
        }
    });

    it('bounds pending handshakes, active streams, client IDs, and client metadata', async () => {
        const harness = await createHarness({
            maxPendingHandshakes: 1,
            maxActiveStreams: 1,
            maxClientIdBytes: 16,
            maxClientMetadataBytes: 32
        });
        const entered = deferred<void>();
        const release = deferred<void>();
        let authorizationCalls = 0;
        harness.server.setClientAuthorizer(async () => {
            authorizationCalls++;
            if (authorizationCalls === 1) {
                entered.resolve();
                await release.promise;
            }
            return true;
        });
        const unsignedUrl = (clientId: string, metadata = '') =>
            `ws://127.0.0.1:${harness.port}/srpc-test?id=${randomUUID()}&cid=${encodeURIComponent(clientId)}&appv=1&_v=2${metadata}`;
        const first = new WebSocket(unsignedUrl('pending-client'));
        try {
            await entered.promise;
            await assertWebSocketRejected(unsignedUrl('second-client'), 503);
            release.resolve();
            await new Promise<void>((resolve, reject) => {
                first.once('open', resolve);
                first.once('error', reject);
            });
            await assertWebSocketRejected(unsignedUrl('active-limit'), 503);
        } finally {
            release.resolve();
            first.terminate();
            await harness.close();
        }

        const validationHarness = await createHarness({
            maxClientIdBytes: 8,
            maxClientMetadataBytes: 16
        });
        validationHarness.server.setClientAuthorizer(() => true);
        try {
            await assertWebSocketRejected(
                `ws://127.0.0.1:${validationHarness.port}/srpc-test?id=${randomUUID()}&cid=client-too-long&appv=1&_v=2`,
                400
            );
            await assertWebSocketRejected(
                `ws://127.0.0.1:${validationHarness.port}/srpc-test?id=${randomUUID()}&cid=short&appv=1&_v=2&m--large=${'x'.repeat(32)}`,
                400
            );
        } finally {
            await validationHarness.close();
        }
    });

    it('publishes a live stream only after connection handlers complete', async () => {
        const harness = await createHarness();
        const entered = deferred<SrpcStream<SrpcMeta>>();
        const release = deferred<void>();
        const client = harness.createClient('activation-order');
        harness.server.registerConnectionHandler(async stream => {
            assert.equal(stream.isActivated, false);
            assert.equal(await harness.server.resolveClient(stream.clientId), undefined);
            entered.resolve(stream);
            await release.promise;
        });

        try {
            const connecting = client.connect();
            const stream = await entered.promise;
            let connected = false;
            void connecting.then(() => {
                connected = true;
            });
            await delay(5);
            assert.equal(connected, false);
            release.resolve();
            await connecting;
            assert.equal(stream.isActivated, true);
            assert.equal(await harness.server.resolveClient(stream.clientId), stream);
        } finally {
            await harness.close();
        }
    });

    it('does not emit disconnect lifecycle callbacks for streams that never publish', async () => {
        const harness = await createHarness();
        const lifecycle: string[] = [];
        const observations: SrpcObservation[] = [];
        const unregister = registerSrpcObserver(entry => {
            if (entry.stream.clientId === 'never-published' && (entry.type === 'connection' || entry.type === 'disconnection')) {
                observations.push(entry);
            }
        });
        harness.server.registerConnectionHandler(() => {
            throw new Error('activation rejected');
        });
        harness.server.registerDisconnectHandler(stream => lifecycle.push(stream.clientId));
        const client = harness.createClient('never-published');

        try {
            await assert.rejects(client.connect(), /Connection failed/);
            await delay(20);
            assert.deepEqual(lifecycle, []);
            assert.deepEqual(observations, []);
        } finally {
            unregister();
            await harness.close();
        }
    });

    it('processes server requests during activation without publishing client connectivity', async () => {
        const harness = await createHarness();
        const invoked = deferred<{ response: { result: number; streamId?: number }; bytes: Buffer }>();
        const client = harness.createClient('activation-invoke');
        client.registerMessageHandler('dCompute', async data => {
            const sender = SrpcByteStream.createSender(client);
            const senderFinished = new Promise<void>((resolve, reject) => {
                sender.once('finish', resolve);
                sender.once('error', reject);
            });
            sender.end(Buffer.from('activation-stream'));
            await senderFinished;
            return {
                result: data.operation === 'square' ? data.number * data.number : data.number * 2,
                streamId: sender.id
            };
        });
        harness.server.registerConnectionHandler(async stream => {
            assert.equal(client.isConnected, false);
            assert.equal(stream.isActivated, false);
            const response = await harness.server.invoke(stream, 'dCompute', { number: 6, operation: 'square' }, 1_000);
            const receiver = SrpcByteStream.createReceiver(stream, response.streamId!);
            invoked.resolve({ response, bytes: await collectByteStream(receiver) });
        });

        try {
            const connecting = client.connect();
            assert.deepEqual(await invoked.promise, {
                response: { result: 36, streamId: 1 },
                bytes: Buffer.from('activation-stream')
            });
            assert.equal(client.isConnected, false);
            await connecting;
            assert.equal(client.isConnected, true);
        } finally {
            await harness.close();
        }
    });

    it('reports sent requests as indeterminate across disconnect and manual reconnect boundaries', async () => {
        const harness = await createHarness();
        const entered = deferred<void>();
        const release = deferred<void>();
        harness.server.registerMessageHandler('uSlow', async () => {
            entered.resolve();
            await release.promise;
            return { ok: true };
        });
        const client = harness.createClient('indeterminate-boundary');
        const disconnectCauses: string[] = [];
        client.registerDisconnectHandler(cause => disconnectCauses.push(cause));

        try {
            await client.connect();
            const request = client.invoke('uSlow', { delayMs: 1 }, 5_000);
            await entered.promise;
            const reconnect = client.connect({ supersede: true });
            assert.deepEqual(disconnectCauses, ['supersede']);
            await assert.rejects(request, SrpcIndeterminateDeliveryError);
            await reconnect;
            assert.equal(client.isConnected, true);
            await delay(20);
            assert.deepEqual(disconnectCauses, ['supersede']);
        } finally {
            release.resolve();
            await harness.close();
        }
    });

    it('rejects sender creation from a delayed stale handler generation', async () => {
        const harness = await createHarness();
        const entered = deferred<void>();
        const release = deferred<void>();
        const staleError = deferred<Error>();
        const connected = deferred<SrpcStream<SrpcMeta>>();
        harness.server.registerConnectionHandler(stream => connected.resolve(stream));
        const client = harness.createClient('stale-handler', {}, secret, { enableReconnect: true });
        client.registerMessageHandler('dCompute', async () => {
            entered.resolve();
            await release.promise;
            try {
                SrpcByteStream.createSender(client);
            } catch (error) {
                staleError.resolve(error as Error);
            }
            return { result: 1 };
        });

        try {
            await client.connect();
            const stream = await connected.promise;
            void harness.server.invoke(stream, 'dCompute', { number: 1, operation: 'square' }, 5_000).catch(() => {});
            await entered.promise;
            stream.$ws.terminate();
            await waitForCondition(() => client.isConnected === false, 1_000, 'client did not enter reconnect state');
            await waitForCondition(() => client.isConnected === true, 3_000, 'client did not reconnect');
            release.resolve();
            assert.match((await staleError.promise).message, /stale handler generation/);
        } finally {
            release.resolve();
            await harness.close();
        }
    });

    it('validates byte-stream roles while allowing remote destroy of a local sender', async () => {
        const stream = createFakeByteStreamable([]);
        SrpcByteStream.init(stream, { startId: 2, step: 2 });
        stream.byteStream.remoteSenderIdParity = 1;
        const sender = SrpcByteStream.createSender(stream);
        assert.equal(sender.id, 2);
        assert.throws(() => SrpcByteStream.createReceiver(stream, 2), /Invalid remote sender stream ID/);

        const server = Object.create(SrpcServer.prototype) as any;
        assert.equal(server.validRemoteByteStreamOperation(stream, { streamId: sender.id, destroy: {} }), true);
        assert.equal(server.validRemoteByteStreamOperation(stream, { streamId: sender.id, write: { chunk: Buffer.alloc(0) } }), false);

        SrpcByteStream.init(stream, { startId: 4, step: 2 });
        const localSender = SrpcByteStream.createSender(stream);
        assert.equal(server.validRemoteByteStreamOperation(stream, { streamId: localSender.id, destroy: {} }), true);
        assert.equal(server.validRemoteByteStreamOperation(stream, { streamId: localSender.id, finish: {} }), false);
        assert.equal(server.validRemoteByteStreamOperation(stream, { streamId: 6, destroy: {} }), false);

        class ExternallyRoutedServer extends SrpcServer<SrpcMeta, ClientMessage, ServerMessage> {
            protected override hasExternalByteStreamSender(candidate: SrpcStream<SrpcMeta>, streamId: number): boolean {
                return candidate === (stream as unknown as SrpcStream<SrpcMeta>) && streamId === 6;
            }
        }
        const externallyRouted = Object.create(ExternallyRoutedServer.prototype) as any;
        assert.equal(externallyRouted.validRemoteByteStreamOperation(stream, { streamId: 6, destroy: {} }), true);
        assert.equal(externallyRouted.validRemoteByteStreamOperation(stream, { streamId: 8, destroy: {} }), false);
        assert.equal(externallyRouted.validRemoteByteStreamOperation(stream, { streamId: 6, finish: {} }), false);
        sender.destroy();
        localSender.destroy();
        await Promise.all([streamClosed(sender), streamClosed(localSender)]);
    });

    it('supports an explicit auth-v2 audience and code-unit metadata ordering', async () => {
        const harness = await createHarness();
        (harness.server as any).options.authAudience = 'srpc-workers';
        const accepted = harness.createClient('audience-ok', { ä: 'last', z: 'first' }, secret, { authAudience: 'srpc-workers' });
        const rejected = harness.createClient('audience-bad');
        try {
            await accepted.connect();
            await assert.rejects(rejected.connect(), /Connection failed|Unexpected server response|Failed authentication/);

            const signer = new SrpcClient<ClientMessage, ServerMessage>(
                createLogger('SrpcCanonicalAuth'),
                `ws://127.0.0.1:${harness.port}/srpc-test`,
                JsonMessage,
                JsonMessage,
                'canonical-order',
                { ä: 'last', z: 'first' },
                secret,
                { enableReconnect: false, authAudience: 'srpc-workers' }
            );
            (signer as any).streamId = randomUUID();
            const signedUrl = new URL((signer as any).generateWsUrl());
            const expectedCanonical = JSON.stringify({
                version: 2,
                path: '/srpc-test',
                audience: 'srpc-workers',
                appv: signedUrl.searchParams.get('appv'),
                ts: signedUrl.searchParams.get('ts'),
                nonce: signedUrl.searchParams.get('nonce'),
                id: signedUrl.searchParams.get('id'),
                cid: 'canonical-order',
                protocol: '2',
                supersede: '0',
                features: 'sender-announcements',
                metadata: { z: 'first', ä: 'last' }
            });
            assert.equal(signedUrl.searchParams.get('signature'), createHmac('sha256', secret).update(expectedCanonical).digest('hex'));
        } finally {
            await harness.close();
        }
    });

    it('bounds replay state fairly by principal and consults an atomic shared nonce consumer', async () => {
        const harness = await createHarness();
        const replayCache = (harness.server as any).authReplayNoncesByPrincipal as Map<string, Map<string, number>>;
        const nonce = randomUUID();
        const first = new WebSocket(createSignedRawWebSocketUrl(harness.port, 'nonce-principal-a', Date.now(), nonce));
        const second = new WebSocket(createSignedRawWebSocketUrl(harness.port, 'nonce-principal-b', Date.now(), nonce));
        let fairClient: WebSocket | undefined;
        let saturatedClient: WebSocket | undefined;
        try {
            await Promise.all([waitForWebSocketOpen(first), waitForWebSocketOpen(second)]);
            first.close();
            second.close();

            replayCache.clear();
            const expiresAt = Date.now() + 60_000;
            const noisyPrincipal = new Map<string, number>();
            for (let index = 0; index < 256; index++) noisyPrincipal.set(`nonce-${index}`, expiresAt);
            replayCache.set('noisy-principal', noisyPrincipal);
            await assertWebSocketRejected(createSignedRawWebSocketUrl(harness.port, 'noisy-principal'), 403);

            fairClient = new WebSocket(createSignedRawWebSocketUrl(harness.port, 'fair-principal'));
            await waitForWebSocketOpen(fairClient);
            assert.equal(replayCache.get('noisy-principal')?.size, 256);
            assert.equal(replayCache.get('fair-principal')?.size, 1);

            replayCache.clear();
            for (let index = 0; index < 256; index++) {
                replayCache.set(`saturated-principal-${index}`, new Map([[`nonce-${index}`, expiresAt]]));
            }
            const acceptedByShared: string[] = [];
            harness.server.setAuthNonceConsumer(principal => {
                acceptedByShared.push(principal);
                return true;
            });
            saturatedClient = new WebSocket(createSignedRawWebSocketUrl(harness.port, 'principal-after-local-saturation'));
            await waitForWebSocketOpen(saturatedClient);
            assert.deepEqual(acceptedByShared, ['principal-after-local-saturation']);
            assert.equal(replayCache.size, 256);
            assert.equal(replayCache.has('principal-after-local-saturation'), true);

            const consumed: Array<[string, string, number]> = [];
            harness.server.setAuthNonceConsumer((principal, consumedNonce, consumedExpiresAt) => {
                consumed.push([principal, consumedNonce, consumedExpiresAt]);
                return false;
            });
            await assertWebSocketRejected(createSignedRawWebSocketUrl(harness.port, 'shared-replay'), 403);
            assert.equal(consumed.length, 1);
            assert.equal(consumed[0][0], 'shared-replay');
            assert.equal(typeof consumed[0][1], 'string');
            assert.equal(consumed[0][2] > Date.now(), true);
        } finally {
            first.terminate();
            second.terminate();
            fairClient?.terminate();
            saturatedClient?.terminate();
            await harness.close();
        }
    });
});

async function createHarness(serverOptions: Partial<ISrpcServerOptions<ClientMessage, ServerMessage>> = {}) {
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
        logLevel: false,
        ...serverOptions
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

function createSignedRawWebSocketUrl(port: number, clientId: string, timestamp = Date.now(), nonceOverride?: string): string {
    const appv = '0.0.0';
    const ts = String(timestamp);
    const id = randomUUID();
    const nonce = nonceOverride ?? randomUUID();
    const metadata = { testEnv: 'testapp-ws' };
    const path = '/srpc-test';
    const signature = createHmac('sha256', secret)
        .update(
            JSON.stringify({
                version: 2,
                path,
                audience: path,
                appv,
                ts,
                nonce,
                id,
                cid: clientId,
                protocol: '2',
                supersede: '0',
                features: '',
                metadata
            })
        )
        .digest('hex');
    const params = new URLSearchParams({
        authv: '2',
        appv,
        ts,
        id,
        cid: clientId,
        signature,
        'm--testEnv': 'testapp-ws',
        nonce,
        aud: path,
        _v: '2'
    });
    return `ws://127.0.0.1:${port}/srpc-test?${params.toString()}`;
}

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
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

function getByteStreamInfo(stream: IByteStreamable): any {
    const symbol = Object.getOwnPropertySymbols(stream.byteStream).find(candidate => candidate.description === 'ByteStreamInfo');
    assert.ok(symbol);
    return (stream.byteStream as any)[symbol];
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
