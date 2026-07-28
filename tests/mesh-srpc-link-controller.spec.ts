import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { finished } from 'node:stream/promises';
import { afterEach, describe, it } from 'node:test';

import {
    acquireMeshLinkRuntime,
    getMeshLinkProcessId,
    installUpgradeClaimHandling,
    MeshSrpcServer,
    SrpcByteStream,
    SrpcStaleConnectionError,
    type IByteStreamable,
    type RegisteredClient,
    type SrpcMeta
} from '../src';
import { MeshSrpcLinkController } from '../src/services/mesh-client/mesh-srpc-link-controller';

const secret = 'mesh-controller-test-secret-with-enough-entropy';
const path = '/_tsf/mesh-controller';
const servers: Server[] = [];
const runtimes: ReturnType<typeof acquireMeshLinkRuntime>[] = [];

afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('MeshSrpcLinkController', () => {
    it('rejects stale local handles before updating replacement metadata', async () => {
        const stale = { id: 'connection-1', clientId: 'client-1', meta: { role: 'stale' } };
        const current = { id: 'connection-2', clientId: 'client-1', meta: { role: 'current' } };
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.streamsByClientId = new Map([[current.clientId, current]]);
        server.clientMetadata = new Map([[current.clientId, { ...current.meta }]]);
        server.meshClientService = {
            updateClientMetadata: async (_clientId: string, metadata: SrpcMeta) => {
                Object.assign(current.meta, metadata);
                return true;
            }
        };

        await assert.rejects(server.updateClientMetadata(stale, { role: 'retargeted' }), SrpcStaleConnectionError);
        assert.deepEqual(current.meta, { role: 'current' });
    });

    it('uses one transparent remote handle for unary calls and byte streams', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const firstRuntime = runtime(firstServer);
        const secondRuntime = runtime(secondServer);
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            processId: getMeshLinkProcessId(),
            connectedAt: Date.now(),
            metadata: { role: 'endpoint' }
        };
        const records = new Map([[record.clientId, record]]);
        const nodes = new Map([
            [1, { instanceId: 1, hostname: 'first', self: true, processId: getMeshLinkProcessId(), linkUrl: url(firstServer) }],
            [2, { instanceId: 2, hostname: 'second', self: false, processId: getMeshLinkProcessId(), linkUrl: url(secondServer) }]
        ]);
        const ownerStream = { id: record.connectionId, clientId: record.clientId } as any;
        const ownerByteParent = createByteParent(record.connectionId!);
        const writes: Buffer[] = [];
        let finishedStreamId: number | undefined;
        let nextId = 2;

        const first = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'controller-test',
            requestTimeoutMs: 2_000,
            runtime: firstRuntime,
            service: fakeService(1, records, nodes),
            getLocalConnection: () => undefined,
            invokeLocal: async () => {
                throw new Error('not local');
            },
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not local');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const second = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'controller-test',
            requestTimeoutMs: 2_000,
            runtime: secondRuntime,
            service: fakeService(2, records, nodes),
            getLocalConnection: clientId => (clientId === record.clientId ? ownerStream : undefined),
            invokeLocal: async (_clientId, _connectionId, _prefix, data) => Buffer.from(data).reverse(),
            reserveLocalSenderIds: (_clientId, _connectionId, count) =>
                Array.from({ length: count }, () => {
                    const id = nextId;
                    nextId += 2;
                    return id;
                }),
            writeLocalStream: async (_clientId, _connectionId, _streamId, data) => {
                writes.push(Buffer.from(data));
            },
            finishLocalStream: async (_clientId, _connectionId, streamId) => {
                finishedStreamId = streamId;
            },
            destroyLocalStream: async () => {},
            attachLocalReceiver: (_clientId, _connectionId, streamId) => SrpcByteStream.createReceiver(ownerByteParent, streamId),
            disconnectLocal: async () => {
                records.delete(record.clientId);
            },
            updateLocalMetadata: async (_clientId, _connectionId, metadata) => {
                record.metadata = metadata;
            }
        });
        firstRuntime.register('controller-test', (peer, frame) => first.route(peer, frame));
        secondRuntime.register('controller-test', (peer, frame) => second.route(peer, frame));

        const connection = await first.resolveClient(record.clientId);
        assert.ok(connection);
        assert.equal(connection.id, record.connectionId);
        assert.deepEqual(connection.meta, { role: 'endpoint' });

        const response = await first.invoke(connection, 'dBinary', Buffer.from([0, 1, 2, 255]), 2_000);
        assert.deepEqual(response, Buffer.from([255, 2, 1, 0]));

        const sender = SrpcByteStream.createSender(connection);
        sender.end(Buffer.from('remote sender'));
        await finished(sender, { readable: false });
        assert.deepEqual(writes, [Buffer.from('remote sender')]);
        assert.equal(finishedStreamId, sender.id);

        const received: Buffer[] = [];
        const receiver = SrpcByteStream.createReceiver(connection, 9);
        receiver.on('data', chunk => received.push(Buffer.from(chunk)));
        await waitFor(() => SrpcByteStream.hasReceiver(ownerByteParent, 9));
        SrpcByteStream.writeReceiver(ownerByteParent, 9, Buffer.from('client data'));
        SrpcByteStream.finishReceiver(ownerByteParent, 9);
        await finished(receiver, { writable: false });
        assert.deepEqual(received, [Buffer.from('client data')]);

        const destroyedReceiver = SrpcByteStream.createReceiver(connection, 11);
        const destroyed = new Promise<void>(resolve => destroyedReceiver.once('close', resolve));
        await waitFor(() => SrpcByteStream.hasReceiver(ownerByteParent, 11));
        SrpcByteStream.destroySubstream(ownerByteParent, 11);
        await destroyed;

        secondRuntime.close();
        await waitFor(() => !connection.connected);
        await assert.rejects(first.invoke(connection, 'dBinary', Buffer.from('stale'), 2_000), SrpcStaleConnectionError);
        assert.equal(connection.connected, false);
    });
});

function fakeService(instanceId: number, records: Map<string, RegisteredClient<SrpcMeta>>, nodes: Map<number, any>): any {
    return {
        clientRegistry: {
            getClient: async (clientId: string) => records.get(clientId),
            listClients: async () => [...records.values()]
        },
        mesh: {
            instanceId,
            getNode: async (nodeId: number) => nodes.get(nodeId),
            getNodes: async () => [...nodes.values()]
        }
    };
}

function createByteParent(id: string): IByteStreamable {
    const disconnectHandlers = new Set<() => void>();
    const parent: IByteStreamable = {
        byteStream: {
            parentStreamId: id,
            write: () => {},
            finish: () => {},
            destroy: () => {},
            attachDisconnectHandler: handler => disconnectHandlers.add(handler),
            detachDisconnectHandler: handler => disconnectHandlers.delete(handler),
            getBufferedAmount: () => 0
        }
    };
    SrpcByteStream.init(parent, { startId: 2, step: 2 });
    return parent;
}

async function listen(): Promise<Server> {
    const server = createServer();
    installUpgradeClaimHandling(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
    return server;
}

function runtime(httpServer: Server): ReturnType<typeof acquireMeshLinkRuntime> {
    const value = acquireMeshLinkRuntime({
        path,
        secret,
        httpServer,
        connectTimeoutMs: 1_000,
        idleTimeoutMs: 10_000,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 1024 * 1024
    });
    runtimes.push(value);
    return value;
}

function url(server: Server): string {
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
