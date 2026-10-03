import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import { createLogger, SrpcError, SrpcIndeterminateDeliveryError, SrpcServer, type BaseMessage } from '../src';

interface Message extends BaseMessage {
    dEchoRequest?: { value: string };
    dEchoResponse?: { value: string };
}

const JsonMessage = {
    encode: (message: Message) => Buffer.from(JSON.stringify(message)),
    decode: (bytes: Uint8Array): Message => JSON.parse(Buffer.from(bytes).toString('utf8'))
};

class TestSocket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    sent: Message[] = [];
    closes: [number, string][] = [];

    send(bytes: Uint8Array) {
        this.sent.push(JsonMessage.decode(bytes));
    }

    close(code: number, reason: string) {
        // An unresponsive client may never finish its close handshake.
        this.closes.push([code, reason]);
    }
}

function createHarness(context: TestContext, disconnectOnRequestTimeout?: boolean) {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const server = new SrpcServer({
        logger: createLogger('SrpcTimeoutTest'),
        clientMessage: JsonMessage,
        serverMessage: JsonMessage,
        httpServer: createServer(),
        wsPath: '/timeout-test',
        disconnectOnRequestTimeout
    }) as any;
    context.after(() => server.close());
    const disconnected: { id: string; cause: string }[] = [];
    server.registerDisconnectHandler((stream: { id: string }, cause: string) => disconnected.push({ id: stream.id, cause }));

    function connect(protocolVersion: 1 | 2 | 3 | 4 = 4) {
        const socket = new TestSocket();
        const stream = server.createStream(socket, {
            clientId: 'timeout-client',
            clientStreamId: 'client-stream',
            address: '127.0.0.1',
            protocolVersion,
            meta: {}
        });
        stream.isActivated = true;
        server.streamsById.set(stream.id, stream);
        server.streamsByClientId.set(stream.clientId, stream);
        server.publishedStreams.add(stream);
        return { stream, socket };
    }

    return { server, connect, disconnected };
}

describe('sRPC timeout disconnection policy', () => {
    for (const timeoutMs of [1_000, 3_000]) {
        it(`keeps v4 sessions when the ${timeoutMs}ms deadline leaves no receipt window`, async context => {
            const { server, connect, disconnected } = createHarness(context);
            const { stream, socket } = connect();
            const request = server.invoke(stream, 'dEcho', { value: 'short' }, timeoutMs);
            const rejection = assert.rejects(request, SrpcIndeterminateDeliveryError);
            context.mock.timers.tick(timeoutMs);
            await rejection;
            assert.equal(stream.connected, true);
            assert.deepEqual(socket.closes, []);
            assert.deepEqual(disconnected, []);
            server.handleStreamDataReceived(stream, { requestId: socket.sent[0].requestId, requestAck: true });
            assert.equal(stream.connected, true, 'a late receipt remains harmless');
        });
    }

    for (const option of [false]) {
        it(`keeps the stream usable for late replies when disconnectOnRequestTimeout is ${option}`, async context => {
            const { server, connect, disconnected } = createHarness(context, option);
            const { stream, socket } = connect();
            const request = server.invoke(stream, 'dEcho', { value: 'late' }, 4_000);
            const rejection = assert.rejects(request, SrpcIndeterminateDeliveryError);
            context.mock.timers.tick(4_000);
            await rejection;
            server.handleStreamDataReceived(stream, { requestId: socket.sent[0].requestId, reply: true, dEchoResponse: { value: 'late' } });

            assert.equal(stream.connected, true);
            assert.deepEqual(socket.closes, []);
            assert.deepEqual(disconnected, []);
        });
    }

    for (const protocolVersion of [1, 2, 3] as const) {
        it(`does not revoke legacy protocol v${protocolVersion} even when the policy is enabled`, async context => {
            const { server, connect, disconnected } = createHarness(context, true);
            const { stream, socket } = connect(protocolVersion);
            const request = server.invoke(stream, 'dEcho', { value: 'legacy' }, 4_000);
            const rejection = assert.rejects(request, SrpcIndeterminateDeliveryError);
            context.mock.timers.tick(4_000);
            await rejection;
            assert.equal(stream.connected, true);
            assert.deepEqual(socket.closes, []);
            assert.deepEqual(disconnected, []);
        });
    }

    it('revokes the exact generation before timeout is observed and settles other pending requests', async context => {
        const { server, connect, disconnected } = createHarness(context);
        const { stream, socket } = connect();
        const expired = server.invoke(stream, 'dEcho', { value: 'expired' }, 4_000);
        const pending = server.invoke(stream, 'dEcho', { value: 'pending' }, 10_000);
        const expiredRejection = assert.rejects(expired, error => {
            assert.ok(error instanceof SrpcIndeterminateDeliveryError);
            assert.ok(error.cause instanceof Error);
            assert.match(error.cause.message, /Request timeout after 4000ms/);
            assert.equal(stream.connected, false);
            assert.equal(server.streamsByClientId.has(stream.clientId), false);
            return true;
        });
        const pendingRejection = assert.rejects(pending, error => {
            assert.ok(error instanceof SrpcIndeterminateDeliveryError);
            assert.ok(error.cause instanceof Error);
            assert.equal(error.cause.message, 'Stream disconnected');
            return true;
        });
        context.mock.timers.tick(4_000);
        await Promise.all([expiredRejection, pendingRejection]);

        assert.equal(socket.readyState, 1, 'revocation must precede the socket close handshake');
        assert.deepEqual(socket.closes, [[4003, 'Stream terminated with cause: timeout']]);
        assert.equal(stream.$queue.size, 0);
        assert.equal(server.pendingServerRequestBytes.has(stream), false);
        const resolved = await server.resolveClient(stream.clientId);
        assert.equal(resolved, undefined);
        assert.deepEqual(disconnected, [{ id: stream.id, cause: 'timeout' }]);
        server.handleStreamDisconnected(stream, 4003);
        context.mock.timers.tick(10_000);
        assert.equal(socket.closes.length, 1);
        assert.equal(disconnected.length, 1);
    });

    it('acknowledges receipt without resolving, releasing, or extending the request, and keeps the session after result timeout', async context => {
        const { server, connect, disconnected } = createHarness(context);
        const { stream, socket } = connect();
        const request = server.invoke(stream, 'dEcho', { value: 'slow-handler' }, 4_000);
        const requestId = socket.sent[0].requestId;
        const rejection = assert.rejects(request, SrpcIndeterminateDeliveryError);
        const bytes = server.pendingServerRequestBytes.get(stream);
        context.mock.timers.tick(50);
        server.handleStreamDataReceived(stream, { requestId, requestAck: true });
        server.handleStreamDataReceived(stream, { requestId, requestAck: true });
        assert.equal(stream.$queue.size, 1);
        assert.equal(server.pendingServerRequestBytes.get(stream), bytes);
        context.mock.timers.tick(3_950);
        await rejection;
        assert.equal(stream.connected, true);
        assert.equal(stream.$queue.size, 0);
        assert.equal(server.pendingServerRequestBytes.has(stream), false);
        assert.deepEqual(socket.closes, []);
        assert.deepEqual(disconnected, []);
        server.handleStreamDataReceived(stream, { requestId, requestAck: true });
        server.handleStreamDataReceived(stream, { requestId, reply: true, dEchoResponse: { value: 'late' } });
        assert.equal(stream.connected, true);
    });

    for (const invalidAck of [
        { requestAck: true, requestId: undefined },
        { requestAck: true, requestId: 'unknown' },
        { requestAck: true, reply: true },
        { requestAck: true, error: 'bad' },
        { requestAck: true, dEchoResponse: { value: 'not-a-receipt' } },
        { requestAck: true, pingPong: {} }
    ]) {
        it(`rejects malformed or unknown acknowledgments: ${JSON.stringify(invalidAck)}`, async context => {
            const { server, connect } = createHarness(context);
            const { stream, socket } = connect();
            const request = server.invoke(stream, 'dEcho', { value: 'pending' }, 4_000);
            const rejection = assert.rejects(request, SrpcIndeterminateDeliveryError);
            server.handleStreamDataReceived(stream, { requestId: socket.sent[0].requestId, ...invalidAck });
            await rejection;
            assert.equal(stream.connected, false);
        });
    }

    it('leaves a replacement generation usable when an old request expires', async context => {
        const { server, connect, disconnected } = createHarness(context, true);
        const old = connect();
        const request = server.invoke(old.stream, 'dEcho', { value: 'old' }, 4_000);
        const rejection = assert.rejects(request, SrpcIndeterminateDeliveryError);
        const replacement = connect();
        context.mock.timers.tick(4_000);
        await rejection;

        assert.equal(old.stream.connected, false);
        assert.equal(old.socket.closes.length, 1);
        assert.equal(replacement.stream.connected, true);
        assert.deepEqual(replacement.socket.closes, []);
        const resolved = await server.resolveClient(old.stream.clientId);
        assert.equal(resolved, replacement.stream);
        assert.deepEqual(disconnected, [{ id: old.stream.id, cause: 'timeout' }]);
    });

    it('keeps successful calls and ordinary remote or encoding failures from triggering the policy', async context => {
        const { server, connect, disconnected } = createHarness(context, true);
        const { stream, socket } = connect();
        const success = server.invoke(stream, 'dEcho', { value: 'success' }, 4_000);
        server.handleStreamDataReceived(stream, { requestId: socket.sent[0].requestId, reply: true, dEchoResponse: { value: 'success' } });
        const response = await success;
        assert.equal(response.value, 'success');

        const failure = server.invoke(stream, 'dEcho', { value: 'denied' }, 4_000);
        server.handleStreamDataReceived(stream, { requestId: socket.sent[1].requestId, reply: true, error: 'Denied', userError: true });
        await assert.rejects(failure, error => error instanceof SrpcError && error.message === 'Denied' && error.isUserError === true);

        server.options.serverMessage = {
            encode() {
                throw new Error('encode failed');
            }
        };
        await assert.rejects(server.invoke(stream, 'dEcho', { value: 'invalid' }, 4_000), /encode failed/);
        context.mock.timers.tick(10_000);
        assert.equal(stream.connected, true);
        assert.equal(stream.$queue.size, 0);
        assert.deepEqual(socket.closes, []);
        assert.deepEqual(disconnected, []);
    });
});
