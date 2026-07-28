import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import WebSocket from 'ws';

import {
    acquireMeshLinkRuntime,
    decodeMeshLinkFrame,
    encodeMeshLinkFrame,
    getMeshLinkProcessId,
    installUpgradeClaimHandling,
    MeshLinkAuthenticator,
    MeshLinkPeer,
    SrpcBackpressureError,
    resolveMeshLinkAdvertiseUrl
} from '../src';

const secret = 'mesh-link-test-secret-with-enough-entropy';
const path = '/_tsf/mesh-test';
const servers: Server[] = [];
const runtimes: ReturnType<typeof acquireMeshLinkRuntime>[] = [];
const originalPodIp = process.env.POD_IP;

afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    if (originalPodIp === undefined) delete process.env.POD_IP;
    else process.env.POD_IP = originalPodIp;
});

describe('sRPC mesh links', () => {
    it('preserves binary payloads over an authenticated lazy WebSocket', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const first = createRuntime(firstServer);
        const second = createRuntime(secondServer);
        const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

        second.register('binary-test', async (_peer, frame) => ({
            header: { type: 'result', reason: frame.header.reason },
            body: Buffer.from(frame.body).reverse()
        }));

        const response = await first.request(
            urlFor(secondServer),
            {
                type: 'invoke',
                meshKey: 'binary-test',
                clientId: 'client-1',
                connectionId: 'connection-1',
                reason: 'round-trip'
            },
            payload,
            2_000
        );

        assert.equal(response.header.reason, 'round-trip');
        assert.deepEqual(response.body, Buffer.from(payload).reverse());
    });

    it('rejects unauthenticated peers', async () => {
        const server = await listen();
        createRuntime(server);
        const ws = new WebSocket(urlFor(server));
        const result = await new Promise<'open' | 'rejected'>(resolve => {
            ws.once('open', () => resolve('open'));
            ws.once('unexpected-response', () => resolve('rejected'));
            ws.once('error', () => resolve('rejected'));
        });
        assert.equal(result, 'rejected');
        ws.terminate();
    });

    it('rejects replayed authentication nonces', () => {
        const auth = new MeshLinkAuthenticator(secret);
        const identity = auth.createIdentity('process-1', path);
        auth.verify(identity, path);
        assert.throws(() => auth.verify(identity, path), /replayed/);
    });

    it('bounds and validates binary protocol frames', () => {
        const encoded = encodeMeshLinkFrame({ type: 'streamWrite', meshKey: 'test', streamId: 2 }, Buffer.from('payload'));
        const decoded = decodeMeshLinkFrame(encoded, encoded.length);
        assert.equal(decoded.header.type, 'streamWrite');
        assert.equal(decoded.header.meshKey, 'test');
        assert.deepEqual(decoded.body, Buffer.from('payload'));
        assert.throws(() => decodeMeshLinkFrame(encoded, encoded.length - 1), /configured limit/);
        assert.throws(() => decodeMeshLinkFrame(Buffer.from([0, 0, 0, 20]), 100), /header length/);
    });

    it('prefers POD_IP and the actual listening port for its default advertised URL', async () => {
        const server = await listen();
        process.env.POD_IP = '10.42.7.19';
        assert.equal(resolveMeshLinkAdvertiseUrl({ path, httpServer: server }), `ws://10.42.7.19:${(server.address() as AddressInfo).port}${path}`);
    });

    it('connects to the pathname advertised by a remote node', async () => {
        const sourceServer = await listen();
        const targetServer = await listen();
        const source = createRuntime(sourceServer);
        const targetPath = '/reverse-proxy/mesh';
        const targetWebSocketServer = new WebSocket.Server({ noServer: true });
        let requestedPath: string | undefined;
        targetServer.on('upgrade', (request, socket, head) => {
            requestedPath = new URL(request.url ?? '', 'http://localhost').pathname;
            if (requestedPath !== targetPath) {
                socket.destroy();
                return;
            }
            targetWebSocketServer.handleUpgrade(request, socket, head, ws => targetWebSocketServer.emit('connection', ws, request));
        });
        targetWebSocketServer.on('connection', ws => {
            ws.on('message', data => {
                const request = decodeMeshLinkFrame(Buffer.from(data as ArrayBuffer), 1024 * 1024);
                ws.send(encodeMeshLinkFrame({ type: 'result', replyTo: request.header.id }, Buffer.from('ok')));
            });
        });

        const response = await source.request(
            `ws://127.0.0.1:${(targetServer.address() as AddressInfo).port}${targetPath}`,
            { type: 'invoke', meshKey: 'proxy-test', clientId: 'client-1' },
            new Uint8Array(),
            2_000
        );

        assert.equal(requestedPath, targetPath);
        assert.equal(response.body.toString(), 'ok');
        source.close();
        await new Promise<void>(resolve => targetWebSocketServer.close(() => resolve()));
    });

    it('includes the outgoing frame in the buffered-byte limit', () => {
        const ws = new FakeWebSocket();
        const peer = new MeshLinkPeer('remote', ws as unknown as WebSocket, 1024, 1024, async () => ({
            header: { type: 'result' },
            body: Buffer.alloc(0)
        }));
        ws.bufferedAmount = 1000;

        assert.throws(() => peer.send({ type: 'ping' }), SrpcBackpressureError);
        assert.equal(ws.sent.length, 0);

        ws.bufferedAmount = 0;
        peer.send({ type: 'ping' });
        assert.equal(ws.sent.length, 1);
        peer.close();
    });
});

class FakeWebSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    bufferedAmount = 0;
    readonly sent: Buffer[] = [];

    send(data: Buffer): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = WebSocket.CLOSED;
        this.emit('close');
    }

    ping(): void {}
}

async function listen(): Promise<Server> {
    const server = createServer();
    installUpgradeClaimHandling(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    servers.push(server);
    return server;
}

function createRuntime(httpServer: Server): ReturnType<typeof acquireMeshLinkRuntime> {
    const runtime = acquireMeshLinkRuntime({
        path,
        secret,
        httpServer,
        connectTimeoutMs: 1_000,
        idleTimeoutMs: 10_000,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 1024 * 1024
    });
    runtimes.push(runtime);
    assert.ok(getMeshLinkProcessId());
    return runtime;
}

function urlFor(server: Server): string {
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}
