import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { deferred, SrpcClient, type BaseMessage } from '../src';

interface Message extends BaseMessage {
    dEchoRequest?: { value: string };
    dEchoResponse?: { value: string };
    dChangedNotification?: { value: string };
}

const JsonMessage = {
    encode: (message: Message) => Buffer.from(JSON.stringify(message)),
    decode: (bytes: Uint8Array): Message => JSON.parse(Buffer.from(bytes).toString('utf8'))
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };

class TestSocket {
    readyState = 1;
    bufferedAmount = 0;
    sent: Message[] = [];

    send(bytes: Uint8Array) {
        this.sent.push(JsonMessage.decode(bytes));
    }

    close() {
        this.readyState = 3;
    }
}

function createHarness(context: TestContext, protocolVersion: 3 | 4 = 4) {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const client = new SrpcClient<Message, Message>(logger, 'ws://localhost/test', JsonMessage, JsonMessage, 'client', {}, 'secret', {
        protocolVersion,
        enableReconnect: false
    });
    const runtime = client as any;
    const socket = new TestSocket();
    runtime.ws = socket;
    runtime.generation = 1;
    client.isConnected = true;
    context.after(() => client.disconnect());
    const receive = (message: Message): Promise<void> => runtime.handleMessage(socket, 1, JsonMessage.encode(message));
    return { client, runtime, socket, receive };
}

describe('sRPC client receipt race', () => {
    it('sends only the result when a response finishes before three seconds', async context => {
        const { client, runtime, socket, receive } = createHarness(context);
        const result = deferred<{ value: string }>();
        client.registerMessageHandler('dEcho', () => result.promise);
        const handling = receive({ requestId: 'fast', dEchoRequest: { value: 'fast' } });
        context.mock.timers.tick(2_999);
        assert.deepEqual(socket.sent, []);
        result.resolve({ value: 'fast' });
        await handling;
        context.mock.timers.tick(3_000);
        assert.deepEqual(socket.sent, [{ requestId: 'fast', reply: true, dEchoResponse: { value: 'fast' } }]);
        assert.equal(runtime.requestAcknowledgmentsByGeneration.size, 0);
    });

    it('sends only a fast error response', async context => {
        const { client, socket, receive } = createHarness(context);
        client.registerMessageHandler('dEcho', () => {
            throw new Error('failed');
        });
        await receive({ requestId: 'error', dEchoRequest: { value: 'error' } });
        context.mock.timers.tick(3_000);
        assert.equal(socket.sent.length, 1);
        assert.equal(socket.sent[0].reply, true);
        assert.match(socket.sent[0].error ?? '', /failed/);
        assert.equal(socket.sent[0].requestAck, undefined);
    });

    it('sends one receipt at three seconds, then the later result', async context => {
        const { client, socket, receive } = createHarness(context);
        const result = deferred<{ value: string }>();
        client.registerMessageHandler('dEcho', () => result.promise);
        const handling = receive({ requestId: 'slow', dEchoRequest: { value: 'slow' } });
        context.mock.timers.tick(2_999);
        assert.deepEqual(socket.sent, []);
        context.mock.timers.tick(1);
        assert.deepEqual(socket.sent, [{ requestId: 'slow', requestAck: true }]);
        context.mock.timers.tick(6_000);
        assert.equal(socket.sent.length, 1);
        result.resolve({ value: 'slow' });
        await handling;
        assert.deepEqual(socket.sent[1], { requestId: 'slow', reply: true, dEchoResponse: { value: 'slow' } });
    });

    it('cancels the old receipt and result on disconnect without touching a replacement', async context => {
        const { client, runtime, socket, receive } = createHarness(context);
        const result = deferred<{ value: string }>();
        client.registerMessageHandler('dEcho', () => result.promise);
        const handling = receive({ requestId: 'old', dEchoRequest: { value: 'old' } });
        context.mock.timers.tick(1_000);
        client.disconnect();
        assert.equal(runtime.requestAcknowledgmentsByGeneration.size, 0);
        const replacement = new TestSocket();
        runtime.ws = replacement;
        runtime.generation = 2;
        client.isConnected = true;
        context.mock.timers.tick(3_000);
        result.resolve({ value: 'old' });
        await handling;
        assert.deepEqual(socket.sent, []);
        assert.deepEqual(replacement.sent, []);
        assert.equal(client.isConnected, true);
    });

    for (const protocolVersion of [3, 4] as const) {
        it(`does not schedule receipts for notifications or fast v${protocolVersion} responses`, async context => {
            const { client, socket, receive } = createHarness(context, protocolVersion);
            client.registerMessageHandler('dEcho', () => ({ value: 'legacy' }));
            client.registerNotificationHandler('dChanged', () => {});
            await receive({ requestId: 'legacy', dEchoRequest: { value: 'legacy' } });
            await receive({ dChangedNotification: { value: 'notification' } });
            context.mock.timers.tick(3_000);
            assert.equal(socket.sent.length, 1);
            assert.equal(socket.sent[0].requestAck, undefined);
        });
    }

    it('cancels only the completed request while another handler remains pending', async context => {
        const { client, runtime, socket, receive } = createHarness(context);
        const fast = deferred<{ value: string }>();
        const slow = deferred<{ value: string }>();
        client.registerMessageHandler('dEcho', data => (data.value === 'fast' ? fast.promise : slow.promise));
        const fastHandling = receive({ requestId: 'fast', dEchoRequest: { value: 'fast' } });
        const slowHandling = receive({ requestId: 'slow', dEchoRequest: { value: 'slow' } });
        context.mock.timers.tick(1_000);
        fast.resolve({ value: 'fast' });
        await fastHandling;
        assert.equal(runtime.requestAcknowledgmentsByGeneration.get(1).size, 1);
        context.mock.timers.tick(2_000);
        assert.deepEqual(
            socket.sent.map(message => [message.requestId, message.requestAck]),
            [
                ['fast', undefined],
                ['slow', true]
            ]
        );
        slow.resolve({ value: 'slow' });
        await slowHandling;
        assert.equal(runtime.requestAcknowledgmentsByGeneration.size, 0);
    });
});
