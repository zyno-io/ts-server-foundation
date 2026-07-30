import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import WebSocket from 'ws';

import {
    acquireMeshLinkRuntime,
    createMeshLinkEndpointKeyPair,
    decodeMeshLinkFrame,
    encodeMeshLinkFrame,
    getMeshLinkProcessId,
    installUpgradeClaimHandling,
    MeshLinkAuthenticator,
    MeshLinkPeer,
    MeshLinkProtocolVersion,
    signMeshLinkEndpointProof,
    SrpcBackpressureError,
    SrpcError,
    SrpcIndeterminateDeliveryError,
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
        pinPair(first, second);
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
            2_000,
            getMeshLinkProcessId(),
            second.id,
            second.publicKey
        );

        assert.equal(response.header.reason, 'round-trip');
        assert.deepEqual(response.body, Buffer.from(payload).reverse());
    });

    it('serializes direct-link SrpcError state as an optional boolean without losing empty messages', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const first = createRuntime(firstServer);
        const second = createRuntime(secondServer);
        pinPair(first, second);
        let nextError = new SrpcError('', true);
        second.register('srpc-error', async () => {
            throw nextError;
        });

        for (const userError of [true, false, undefined] as const) {
            nextError = new SrpcError('', userError);
            await assert.rejects(
                first.request(
                    urlFor(secondServer),
                    { type: 'invoke', meshKey: 'srpc-error', clientId: 'client' },
                    new Uint8Array(),
                    1_000,
                    getMeshLinkProcessId(),
                    second.id,
                    second.publicKey
                ),
                error => {
                    assert.ok(error instanceof Error);
                    assert.equal(error.name, 'SrpcError');
                    assert.equal(error.message, '');
                    assert.equal('isUserError' in error, typeof userError === 'boolean');
                    assert.equal((error as Error & { isUserError?: boolean }).isUserError, userError);
                    return true;
                }
            );
        }
    });

    it('keeps distinct listeners in one process on distinct peer endpoints', async () => {
        const sourceServer = await listen();
        const firstTargetServer = await listen();
        const secondTargetServer = await listen();
        const source = createRuntime(sourceServer);
        const firstTarget = createRuntime(firstTargetServer);
        const secondTarget = createRuntime(secondTargetServer);
        pinPair(source, firstTarget);
        pinPair(source, secondTarget);
        firstTarget.register('first-endpoint', async () => ({ header: { type: 'result' }, body: Buffer.from('first') }));
        secondTarget.register('second-endpoint', async () => ({ header: { type: 'result' }, body: Buffer.from('second') }));

        const first = await source.request(
            urlFor(firstTargetServer),
            { type: 'invoke', meshKey: 'first-endpoint', clientId: 'client-1' },
            new Uint8Array(),
            2_000,
            getMeshLinkProcessId(),
            firstTarget.id,
            firstTarget.publicKey
        );
        const second = await source.request(
            urlFor(secondTargetServer),
            { type: 'invoke', meshKey: 'second-endpoint', clientId: 'client-1' },
            new Uint8Array(),
            2_000,
            getMeshLinkProcessId(),
            secondTarget.id,
            secondTarget.publicKey
        );

        assert.equal(first.body.toString(), 'first');
        assert.equal(second.body.toString(), 'second');
    });

    it('bounds cold peer acquisition per caller without cancelling a shared connection', async () => {
        const server = await listen();
        const runtime = createRuntime(server) as any;
        let connectCalls = 0;
        let resolveConnect!: (peer: any) => void;
        const sharedConnect = new Promise<any>(resolve => {
            resolveConnect = resolve;
        });
        runtime.connect = () => {
            connectCalls++;
            return sharedConnect;
        };
        const requestHeader = {
            type: 'invoke',
            meshKey: 'cold-deadline',
            clientId: 'deadline-client',
            timeoutMs: 500
        };

        const startedAt = Date.now();
        const short = runtime.request('ws://127.0.0.1:9/cold', requestHeader, new Uint8Array(), 50);
        const long = runtime.request('ws://127.0.0.1:9/cold', requestHeader, new Uint8Array(), 500);
        await assert.rejects(
            short,
            error =>
                error instanceof Error &&
                error.name === 'SrpcOwnerUnavailableError' &&
                String((error as Error & { cause?: unknown }).cause).includes('connection timed out')
        );
        assert.ok(Date.now() - startedAt < 250);
        assert.equal(connectCalls, 1);

        let peerTimeout = 0;
        let transmittedTimeout = 0;
        resolveConnect({
            connected: true,
            processId: 'remote-process',
            endpointId: 'remote-endpoint',
            publicKey: 'remote-key',
            close: () => {},
            request: async (header: { timeoutMs?: number }, _body: Uint8Array, timeoutMs: number) => {
                peerTimeout = timeoutMs;
                transmittedTimeout = header.timeoutMs ?? 0;
                return { header: { type: 'result', id: 'response' }, body: Buffer.from('ok') };
            }
        });
        const response = await long;
        assert.equal(response.body.toString(), 'ok');
        assert.ok(peerTimeout > 0 && peerTimeout < 500);
        assert.ok(transmittedTimeout > 0 && transmittedTimeout <= peerTimeout);
        assert.equal(connectCalls, 1);
    });

    it('connects two v2 endpoints with membership public-key pins under the secure default', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const first = createRuntime(firstServer);
        const second = createRuntime(secondServer);
        first.pinEndpoint(second.id, second.publicKey);
        second.pinEndpoint(first.id, first.publicKey);
        second.register('pinned', async () => ({ header: { type: 'result' }, body: Buffer.from('pinned-ok') }));

        const response = await first.request(
            urlFor(secondServer),
            { type: 'invoke', meshKey: 'pinned', clientId: 'client-1' },
            new Uint8Array(),
            2_000,
            getMeshLinkProcessId(),
            second.id,
            second.publicKey
        );
        assert.equal(response.body.toString(), 'pinned-ok');
    });

    it('connects pinned endpoints when the optional remote identity is omitted', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const first = createRuntime(firstServer);
        const second = createRuntime(secondServer);
        pinPair(first, second);
        second.register('optional-identity', async () => ({ header: { type: 'result' }, body: Buffer.from('connected') }));

        const response = await first.request(
            urlFor(secondServer),
            { type: 'invoke', meshKey: 'optional-identity', clientId: 'client-1' },
            new Uint8Array(),
            2_000
        );

        assert.equal(response.body.toString(), 'connected');
    });

    it('resolves an inbound endpoint pin from live membership during a startup race', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const first = createRuntime(firstServer);
        const second = createRuntime(secondServer);
        first.pinEndpoint(second.id, second.publicKey);
        second.registerEndpointPinResolver(async (processId, endpointId) =>
            processId === getMeshLinkProcessId() && endpointId === first.id ? first.publicKey : undefined
        );
        second.register('resolver-pinned', async () => ({ header: { type: 'result' }, body: Buffer.from('resolver-ok') }));

        const response = await first.request(
            urlFor(secondServer),
            { type: 'invoke', meshKey: 'resolver-pinned', clientId: 'client-1' },
            new Uint8Array(),
            2_000,
            getMeshLinkProcessId(),
            second.id,
            second.publicKey
        );
        assert.equal(response.body.toString(), 'resolver-ok');
    });

    it('rejects non-v2 handshakes', async () => {
        const server = await listen();
        createRuntime(server);
        const target = new URL(urlFor(server));
        target.searchParams.set('protocolVersion', '1');
        const ws = new WebSocket(target);
        const result = await new Promise<'open' | 'rejected'>(resolve => {
            ws.once('open', () => resolve('open'));
            ws.once('unexpected-response', () => resolve('rejected'));
            ws.once('error', () => resolve('rejected'));
        });
        assert.equal(result, 'rejected');
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

    it('rejects an endpoint claim forged with the shared group secret and binds request proofs to their audience', async () => {
        const server = await listen();
        const victim = createMeshLinkEndpointKeyPair();
        const attacker = createMeshLinkEndpointKeyPair();
        const runtime = createRuntime(server, {
            endpointPins: { 'victim-endpoint': victim.publicKey }
        }) as any;
        const auth = new MeshLinkAuthenticator(secret);
        const identity = auth.createIdentity('attacker-process', path, 'request', 'victim-endpoint', undefined, runtime.id);
        identity.endpointPublicKey = attacker.publicKey;
        identity.endpointSignature = signMeshLinkEndpointProof(attacker.privateKey, identity, path, 'request');

        assert.throws(() => runtime.verifyEndpointProof(identity, 'request', undefined, runtime.id), /membership pin/);
        identity.endpointPublicKey = victim.publicKey;
        identity.endpointSignature = signMeshLinkEndpointProof(victim.privateKey, identity, path, 'request');
        assert.doesNotThrow(() => runtime.verifyEndpointProof(identity, 'request', undefined, runtime.id));
        // The invalid endpoint proof did not consume the group replay nonce.
        assert.doesNotThrow(() => auth.verify(identity, path, 'request'));

        const valid = auth.createIdentity('victim-process', path, 'request', 'victim-endpoint', undefined, 'another-endpoint');
        valid.endpointPublicKey = victim.publicKey;
        valid.endpointSignature = signMeshLinkEndpointProof(victim.privateKey, valid, path, 'request');
        assert.throws(() => runtime.verifyEndpointProof(valid, 'request', undefined, runtime.id), /another endpoint/);
    });

    it('does not accept a server response proof as a client request proof', () => {
        const auth = new MeshLinkAuthenticator(secret);
        const responseTo = { endpointId: 'requester-1', nonce: 'request-nonce-1' };
        const identity = auth.createIdentity('process-1', path, 'response', undefined, responseTo);
        assert.throws(() => auth.verify(identity, path), /authentication failed/);
        auth.verify(identity, path, 'response', responseTo);
    });

    it('rejects a response proof bound to another requester or request nonce', () => {
        const auth = new MeshLinkAuthenticator(secret);
        const identity = auth.createIdentity('process-1', path, 'response', undefined, {
            endpointId: 'requester-1',
            nonce: 'request-nonce-1'
        });
        assert.throws(() => auth.verify(identity, path, 'response', { endpointId: 'requester-2', nonce: 'request-nonce-1' }), /does not match/);
    });

    it('bounds and validates binary protocol frames', () => {
        const encoded = encodeMeshLinkFrame({ type: 'streamWrite', meshKey: 'test', streamId: 2 }, Buffer.from('payload'));
        const decoded = decodeMeshLinkFrame(encoded, encoded.length);
        assert.equal(decoded.header.type, 'streamWrite');
        assert.equal(decoded.header.meshKey, 'test');
        assert.deepEqual(decoded.body, Buffer.from('payload'));
        assert.throws(() => decodeMeshLinkFrame(encoded, encoded.length - 1), /configured limit/);
        assert.throws(() => decodeMeshLinkFrame(Buffer.from([0, 0, 0, 20]), 100), /header length/);
        assert.throws(() => encodeMeshLinkFrame({ type: 'ping' }, { byteLength: 1_024 } as Uint8Array, 100), /configured limit/);
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
        const targetAuthenticator = new MeshLinkAuthenticator(secret);
        const targetEndpoint = createMeshLinkEndpointKeyPair();
        const targetEndpointId = 'reverse-proxy-endpoint';
        const targetProcessId = 'reverse-proxy';
        source.pinEndpoint(targetEndpointId, targetEndpoint.publicKey, targetProcessId);
        let requestedPath: string | undefined;
        targetServer.on('upgrade', (request, socket, head) => {
            const requestUrl = new URL(request.url ?? '', 'http://localhost');
            requestedPath = requestUrl.pathname;
            if (requestedPath !== targetPath) {
                socket.destroy();
                return;
            }
            targetAuthenticator.verify(
                {
                    processId: requestUrl.searchParams.get('processId') ?? '',
                    endpointId: requestUrl.searchParams.get('endpointId') ?? '',
                    audienceEndpointId: requestUrl.searchParams.get('audienceEndpointId') ?? undefined,
                    timestamp: Number(requestUrl.searchParams.get('timestamp')),
                    nonce: requestUrl.searchParams.get('nonce') ?? '',
                    signature: requestUrl.searchParams.get('signature') ?? ''
                },
                path
            );
            targetWebSocketServer.handleUpgrade(request, socket, head, ws => targetWebSocketServer.emit('connection', ws, request));
        });
        targetWebSocketServer.on('connection', ws => {
            ws.on('message', data => {
                const request = decodeMeshLinkFrame(Buffer.from(data as ArrayBuffer), 1024 * 1024);
                ws.send(encodeMeshLinkFrame({ type: 'result', replyTo: request.header.id }, Buffer.from('ok')));
            });
        });
        targetWebSocketServer.on('headers', (headers, request) => {
            const requestUrl = new URL(request.url ?? '', 'http://localhost');
            const identity = targetAuthenticator.createIdentity(targetProcessId, path, 'response', targetEndpointId, {
                endpointId: requestUrl.searchParams.get('endpointId') ?? '',
                nonce: requestUrl.searchParams.get('nonce') ?? ''
            });
            const proofIdentity = { ...identity, endpointPublicKey: targetEndpoint.publicKey };
            const endpointSignature = signMeshLinkEndpointProof(targetEndpoint.privateKey, proofIdentity, path, 'response', {
                endpointId: requestUrl.searchParams.get('endpointId') ?? '',
                nonce: requestUrl.searchParams.get('nonce') ?? ''
            });
            headers.push(
                `x-tsf-mesh-process-id: ${identity.processId}`,
                `x-tsf-mesh-endpoint-id: ${identity.endpointId}`,
                `x-tsf-mesh-timestamp: ${identity.timestamp}`,
                `x-tsf-mesh-nonce: ${identity.nonce}`,
                `x-tsf-mesh-signature: ${identity.signature}`,
                `x-tsf-mesh-requester-endpoint-id: ${identity.requesterEndpointId}`,
                `x-tsf-mesh-request-nonce: ${identity.requestNonce}`,
                `x-tsf-mesh-endpoint-public-key: ${targetEndpoint.publicKey}`,
                `x-tsf-mesh-endpoint-signature: ${endpointSignature}`
            );
        });

        const response = await source.request(
            `ws://127.0.0.1:${(targetServer.address() as AddressInfo).port}${targetPath}`,
            { type: 'invoke', meshKey: 'proxy-test', clientId: 'client-1' },
            new Uint8Array(),
            2_000,
            targetProcessId,
            targetEndpointId,
            targetEndpoint.publicKey
        );

        assert.equal(requestedPath, targetPath);
        assert.equal(response.body.toString(), 'ok');
        source.close();
        await new Promise<void>(resolve => targetWebSocketServer.close(() => resolve()));
    });

    it('rejects a server that does not authenticate its upgrade response', async () => {
        const sourceServer = await listen();
        const targetServer = await listen();
        const source = createRuntime(sourceServer);
        const targetWebSocketServer = new WebSocket.Server({ noServer: true });
        targetServer.on('upgrade', (request, socket, head) => {
            targetWebSocketServer.handleUpgrade(request, socket, head, ws => targetWebSocketServer.emit('connection', ws, request));
        });

        await assert.rejects(
            source.request(urlFor(targetServer), { type: 'invoke', meshKey: 'missing-server-auth', clientId: 'client-1' }, new Uint8Array(), 2_000),
            /handshake identity/
        );

        source.close();
        await new Promise<void>(resolve => targetWebSocketServer.close(() => resolve()));
    });

    it('returns the live duplicate peer instead of a peer it just closed', async () => {
        const server = await listen();
        const runtime = createRuntime(server);
        const remoteProcessId = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz';
        const first = (runtime as any).createPeer(remoteProcessId, new FakeWebSocket() as unknown as WebSocket, 'outbound') as MeshLinkPeer;
        const winner = (runtime as any).resolveDuplicatePeer(remoteProcessId, first, 'outbound') as MeshLinkPeer;
        const candidate = (runtime as any).createPeer(remoteProcessId, new FakeWebSocket() as unknown as WebSocket, 'inbound') as MeshLinkPeer;

        const resolved = (runtime as any).resolveDuplicatePeer(remoteProcessId, candidate, 'inbound') as MeshLinkPeer;
        assert.equal(winner, first);
        assert.equal(resolved, first);
        assert.equal(first.connected, true);
        assert.equal(candidate.connected, false);
        first.close();
    });

    it('requires an endpoint key to select a reverse peer when endpoint claims conflict', async () => {
        const server = await listen();
        const runtime = createRuntime(server) as any;
        const first = {
            processId: 'remote-process',
            endpointId: 'claimed-endpoint',
            publicKey: 'key-a',
            connected: true,
            request: async () => ({ header: { type: 'result' }, body: Buffer.alloc(0) })
        };
        const second = {
            processId: 'remote-process',
            endpointId: 'claimed-endpoint',
            publicKey: 'key-b',
            connected: true,
            request: async () => ({ header: { type: 'result' }, body: Buffer.from('b') })
        };
        runtime.peersByIdentity.set('v2:remote-process:claimed-endpoint:key-a', { peer: first, direction: 'inbound' });
        runtime.peersByIdentity.set('v2:remote-process:claimed-endpoint:key-b', { peer: second, direction: 'inbound' });

        await assert.rejects(
            runtime.requestPeer('remote-process', 'claimed-endpoint', { type: 'invoke', clientId: 'client-1' }, new Uint8Array(), 1_000),
            /membership key/i
        );
        const response = await runtime.requestPeer(
            'remote-process',
            'claimed-endpoint',
            { type: 'invoke', clientId: 'client-1' },
            new Uint8Array(),
            1_000,
            'key-b'
        );
        assert.equal(response.body.toString(), 'b');
        runtime.close();
    });

    it('notifies close handlers attached after a peer has already closed', async () => {
        const peer = new MeshLinkPeer('remote', new FakeWebSocket() as unknown as WebSocket, 1024, 1024, async () => ({
            header: { type: 'result' },
            body: Buffer.alloc(0)
        }));
        peer.close();
        let notified = false;
        peer.onClose(() => {
            notified = true;
        });
        await Promise.resolve();
        assert.equal(notified, true);
    });

    it('rejects requests after the runtime has closed without opening a connection', async () => {
        const server = await listen();
        const runtime = createRuntime(server);
        runtime.close();

        await assert.rejects(
            runtime.request('ws://127.0.0.1:1/never', { type: 'invoke', meshKey: 'closed', clientId: 'client-1' }, new Uint8Array(), 1_000),
            /runtime is closed/
        );
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

    it('reports unresolved post-send close and timeout as indeterminate delivery', async () => {
        const closeSocket = new FakeWebSocket();
        const closePeer = new MeshLinkPeer('remote', closeSocket as unknown as WebSocket, 1024, 1024, async () => ({
            header: { type: 'result' },
            body: Buffer.alloc(0)
        }));
        const closedRequest = closePeer.request({ type: 'invoke', clientId: 'client-close' }, new Uint8Array(), 1_000);
        assert.equal(closeSocket.sent.length, 1);
        closeSocket.close();
        await assert.rejects(closedRequest, SrpcIndeterminateDeliveryError);

        const timeoutSocket = new FakeWebSocket();
        const timeoutPeer = new MeshLinkPeer('remote', timeoutSocket as unknown as WebSocket, 1024, 1024, async () => ({
            header: { type: 'result' },
            body: Buffer.alloc(0)
        }));
        const timedOutRequest = timeoutPeer.request({ type: 'invoke', clientId: 'client-timeout' }, new Uint8Array(), 5);
        assert.equal(timeoutSocket.sent.length, 1);
        await assert.rejects(timedOutRequest, SrpcIndeterminateDeliveryError);
        timeoutPeer.close();
    });

    it('drops an unacknowledgeable incoming request without leaking an in-flight slot', () => {
        const ws = new FakeWebSocket();
        let handled = 0;
        const peer = new MeshLinkPeer('remote', ws as unknown as WebSocket, 1024, 1024, async () => {
            handled++;
            return { header: { type: 'result' }, body: Buffer.alloc(0) };
        });
        ws.bufferedAmount = 1024;

        assert.doesNotThrow(() => {
            ws.emit('message', encodeMeshLinkFrame({ type: 'invoke', id: 'request-1' }, new Uint8Array()));
        });
        assert.equal(handled, 0);
        assert.equal((peer as any).activeIncomingRequests, 0);
        assert.equal(ws.readyState, WebSocket.CLOSED);
        peer.close();
    });

    it('closes the peer when the final result frame cannot be sent', async () => {
        const ws = new FakeWebSocket();
        let sends = 0;
        ws.send = data => {
            sends++;
            if (sends === 2) throw new Error('final response send failed');
            ws.sent.push(data);
        };
        const granted = new Set([1]);
        const peer = new MeshLinkPeer('remote', ws as unknown as WebSocket, 1024, 1024, async () => ({
            header: { type: 'result' },
            body: Buffer.from('ok')
        }));
        peer.onClose(() => granted.clear());

        ws.emit('message', encodeMeshLinkFrame({ type: 'invoke', id: 'request-with-grant' }, new Uint8Array()));
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.equal(ws.readyState, WebSocket.CLOSED);
        assert.equal(peer.connected, false);
        assert.equal(granted.size, 0);
    });

    it('shares incoming request pressure across peers in one runtime budget', () => {
        const budget = { activeRequests: 4_096, activeBytes: 0 };
        const ws = new FakeWebSocket();
        let handled = 0;
        const peer = new MeshLinkPeer(
            'remote',
            ws as unknown as WebSocket,
            1024,
            1024,
            async () => {
                handled++;
                return { header: { type: 'result' }, body: Buffer.alloc(0) };
            },
            'remote-endpoint',
            budget
        );

        ws.emit('message', encodeMeshLinkFrame({ type: 'invoke', id: 'request-1' }, new Uint8Array()));

        assert.equal(handled, 0);
        assert.equal(budget.activeRequests, 4_096);
        peer.close();
    });

    it('deduplicates repeated frame IDs and retains shared budget until a closed peer handler settles', async () => {
        const budget = { activeRequests: 0, activeBytes: 0 };
        const ws = new FakeWebSocket();
        let handled = 0;
        let finish!: () => void;
        const handlerDone = new Promise<void>(resolve => {
            finish = resolve;
        });
        const peer = new MeshLinkPeer(
            'remote',
            ws as unknown as WebSocket,
            1024,
            4096,
            async () => {
                handled++;
                await handlerDone;
                return { header: { type: 'result' }, body: Buffer.from('ok') };
            },
            'remote-endpoint',
            budget
        );
        const frame = encodeMeshLinkFrame({ type: 'invoke', id: 'same-request' }, new Uint8Array());

        ws.emit('message', frame);
        ws.emit('message', frame);
        assert.equal(handled, 1);
        assert.equal(budget.activeRequests, 1);

        peer.close();
        assert.equal(budget.activeRequests, 1);
        finish();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(budget.activeRequests, 0);
    });

    it('does not evict unexpired completed request IDs when dedupe capacity is full', async () => {
        const ws = new FakeWebSocket();
        let handled = 0;
        const peer = new MeshLinkPeer(
            'remote',
            ws as unknown as WebSocket,
            1024,
            4096,
            async () => {
                handled++;
                return { header: { type: 'result' }, body: Buffer.alloc(0) };
            },
            'remote-endpoint'
        ) as any;
        for (let index = 0; index < 4_096; index++) {
            const requestId = `completed-${index}`;
            peer.rememberCompleted(requestId, { type: 'result', replyTo: requestId, ok: true }, Buffer.alloc(0));
        }

        ws.emit('message', encodeMeshLinkFrame({ type: 'invoke', id: 'completed-0' }, new Uint8Array()));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(handled, 0);
        const replayed = decodeMeshLinkFrame(ws.sent.at(-1)!, 1024);
        assert.equal(replayed.header.replyTo, 'completed-0');

        ws.emit('message', encodeMeshLinkFrame({ type: 'invoke', id: 'fresh-request' }, new Uint8Array()));
        await new Promise<void>(resolve => setImmediate(resolve));

        const rejectedFresh = decodeMeshLinkFrame(ws.sent.at(-1)!, 1024);
        assert.equal(handled, 0);
        assert.equal(peer.completedIncoming.size, 4_096);
        assert.equal(peer.completedIncoming.has('completed-0'), true);
        assert.equal(rejectedFresh.header.replyTo, 'fresh-request');
        assert.equal(rejectedFresh.header.errorName, 'SrpcBackpressureError');
        peer.close();
    });

    it('accounts completed-response bytes and retains a tombstone when replay data cannot fit', () => {
        const ws = new FakeWebSocket();
        let handled = 0;
        const peer = new MeshLinkPeer(
            'remote',
            ws as unknown as WebSocket,
            1024,
            4096,
            async () => {
                handled++;
                return { header: { type: 'result' }, body: Buffer.from('unexpected') };
            },
            'remote-endpoint'
        ) as any;
        peer.rememberCompleted('completed-request', { type: 'result', replyTo: 'completed-request', ok: true }, Buffer.from('retained response'));
        assert.ok(peer.completedIncomingBytes > Buffer.byteLength('retained response'));
        peer.completedIncoming.get('completed-request').expiresAt = 0;
        peer.pruneCompletedIncoming();
        assert.equal(peer.completedIncomingBytes, 0);

        peer.rememberCompleted('tombstoned-request', { type: 'result', replyTo: 'tombstoned-request', ok: true }, {
            byteLength: 62 * 1024 * 1024 + 1
        } as Buffer);
        assert.equal(peer.completedIncoming.get('tombstoned-request').header.errorName, 'SrpcIndeterminateDeliveryError');
        ws.emit('message', encodeMeshLinkFrame({ type: 'invoke', id: 'tombstoned-request' }, new Uint8Array()));
        assert.equal(handled, 0);
        peer.close();
    });

    it('idle-evicts inbound peers that were never entered in the outbound URL cache', async () => {
        const server = await listen();
        const runtime = createRuntime(server) as any;
        let closed = 0;
        runtime.allPeers.add({
            connected: true,
            idleSince: 0,
            close: () => {
                closed++;
            }
        });

        runtime.closeIdlePeers();

        assert.equal(closed, 1);
        runtime.close();
    });

    it('keeps owner-held endpoint pins valid past TTL and releases the last reference', async () => {
        const server = await listen();
        const runtime = createRuntime(server) as any;
        const unregister = runtime.pinEndpoint('owned-endpoint', 'owned-key', 'owned-process', 1);
        runtime.endpointPins.get('owned-endpoint').expiresAt = 0;
        assert.ok(runtime.getEndpointPin('owned-process', 'owned-endpoint'));
        unregister();
        assert.equal(runtime.getEndpointPin('owned-process', 'owned-endpoint'), undefined);
    });

    it('bounds resolver-created endpoint pins and globally prunes expired churn', async () => {
        const server = await listen();
        const runtime = createRuntime(server, {
            maxEndpointPins: 4
        }) as any;
        runtime.registerEndpointPinResolver(async (_processId: string, endpointId: string) => ({
            publicKey: `key-${endpointId}`,
            expiresAt: Date.now() + 60_000
        }));
        const authorize = (index: number) =>
            runtime.authorizeEndpointPin(
                {
                    processId: `process-${index}`,
                    endpointId: `endpoint-${index}`,
                    endpointPublicKey: `key-endpoint-${index}`
                },
                2
            );
        for (let index = 0; index < 4; index++) await authorize(index);
        await assert.rejects(authorize(4), /Too many.*endpoint.*pins/i);
        assert.equal(runtime.endpointPins.size, 4);
        runtime.endpointPins.get('endpoint-0').expiresAt = 0;
        await authorize(4);
        assert.equal(runtime.endpointPins.size, 4);
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

function createRuntime(
    httpServer: Server,
    options: Partial<Parameters<typeof acquireMeshLinkRuntime>[0]> = {}
): ReturnType<typeof acquireMeshLinkRuntime> {
    const runtime = acquireMeshLinkRuntime({
        path,
        secret,
        httpServer,
        connectTimeoutMs: 1_000,
        idleTimeoutMs: 10_000,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 1024 * 1024,
        ...options
    });
    runtimes.push(runtime);
    assert.ok(getMeshLinkProcessId());
    return runtime;
}

function pinPair(first: ReturnType<typeof acquireMeshLinkRuntime>, second: ReturnType<typeof acquireMeshLinkRuntime>): void {
    first.pinEndpoint(second.id, second.publicKey, getMeshLinkProcessId());
    second.pinEndpoint(first.id, first.publicKey, getMeshLinkProcessId());
}

function urlFor(server: Server): string {
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}
