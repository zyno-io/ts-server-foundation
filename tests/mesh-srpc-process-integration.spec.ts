import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
    type BaseMessage,
    createApp,
    createLogger,
    getMeshLinkProcessId,
    getSrpcRegistryMetadata,
    isLocalSrpcStream,
    MeshSrpcServer,
    SrpcClient,
    type SrpcMessageFns
} from '../src';
import type { MeshSrpcConnection, SrpcStream } from '../src';

const redisSkip = process.env.REDIS_HOST ? false : 'set REDIS_HOST to run multi-process mesh integration tests';
const clientPath = '/mesh-process-client';
const meshPath = '/_tsf/mesh-process';
const meshSecret = 'mesh-process-integration-secret';

interface MeshClientMessage extends BaseMessage {
    dEchoResponse?: { value: string; node: string };
}

interface MeshServerMessage extends BaseMessage {
    dEchoRequest?: { value: string };
}

interface ClientMetadata {
    role: string;
    secret?: string;
}

const JsonMessage: SrpcMessageFns<MeshClientMessage | MeshServerMessage> = {
    encode(message) {
        return Buffer.from(JSON.stringify(message));
    },
    decode(input) {
        return JSON.parse(Buffer.from(input).toString('utf8')) as MeshClientMessage | MeshServerMessage;
    }
};

describe('multi-process MeshSrpcServer integration', { skip: redisSkip }, () => {
    it('uses the application listener across processes and fences a crashed remote owner', async () => {
        const originalPodIp = process.env.POD_IP;
        process.env.POD_IP = '127.0.0.1';
        const meshKey = `mesh-process-${randomUUID()}`;
        const app = createApp({ enableHealthcheck: false });
        const server = new MeshSrpcServer<ClientMetadata, MeshClientMessage, MeshServerMessage, { role: string }>({
            logger: createLogger('MeshSrpcProcessParent'),
            clientMessage: JsonMessage as SrpcMessageFns<MeshClientMessage>,
            serverMessage: JsonMessage as SrpcMessageFns<MeshServerMessage>,
            wsPath: clientPath,
            meshKey,
            meshOptions: {
                heartbeatIntervalMs: 500,
                nodeTtlMs: 8_000,
                leaderOptions: { ttlMs: 1_000, renewalIntervalMs: 250, retryDelayMs: 150 }
            },
            meshLink: { secret: meshSecret, path: meshPath },
            extractRegistryMetadata: stream => ({ role: stream.meta.role }),
            autoLifecycle: false
        });
        server.setClientAuthorizer(() => true);
        const httpServer = await app.http.listen(0, '127.0.0.1');
        const parentPort = (httpServer.address() as AddressInfo).port;
        await server.meshStart();
        const child = await startMeshNode(meshKey);
        const localClient = createClient(`ws://127.0.0.1:${parentPort}${clientPath}`, 'parent-client', 'parent');
        const childClient = createClient(`ws://127.0.0.1:${child.port}${clientPath}`, 'child-client', 'child');
        let orphaned: Array<{ nodeId: number; clientId: string; connectionId: string; role: string }> = [];
        server.onNodeClientsOrphaned((nodeId, clients) => {
            orphaned.push(
                ...clients.map(client => ({ nodeId, clientId: client.clientId, connectionId: client.connectionId, role: client.metadata.role }))
            );
        });

        try {
            await localClient.connect();
            await childClient.connect();
            await waitFor(async () => (await server.getRegisteredClient('parent-client')) !== undefined);
            await waitFor(async () => (await server.getRegisteredClient('child-client')) !== undefined);

            const clients = await server.listClients();
            assert.deepEqual(clients.map(connection => connection.clientId).sort(), ['child-client', 'parent-client']);
            const local = clients.find(connection => connection.clientId === 'parent-client');
            const remote = clients.find(connection => connection.clientId === 'child-client');
            assert.ok(local && remote);
            assert.equal(isLocalSrpcStream(local), true);
            assert.equal(isLocalSrpcStream(remote), false);
            assert.strictEqual(local, server.streamsByClientId.get('parent-client'));
            assert.deepEqual(await server.getLocalStreams(), [local]);
            assert.deepEqual(
                getSrpcRegistryMetadata(local, stream => ({ role: stream.meta.role })),
                { role: 'parent' }
            );
            assert.deepEqual(
                getSrpcRegistryMetadata(remote, stream => ({ role: stream.meta.role })),
                { role: 'child' }
            );

            const remoteConnection = remote as Exclude<MeshSrpcConnection<ClientMetadata, { role: string }>, SrpcStream<ClientMetadata>>;
            assert.equal(remoteConnection.ownerNodeId, child.nodeId);
            assert.equal(remoteConnection.ownerProcessId, child.meshProcessId);
            assert.notEqual(remoteConnection.ownerProcessId, getMeshLinkProcessId());
            assert.notEqual(child.osPid, process.pid);
            assert.deepEqual(await server.invoke(local, 'dEcho', { value: 'local' }), { value: 'local', node: 'parent' });
            assert.deepEqual(await server.invoke(remote, 'dEcho', { value: 'remote' }), { value: 'remote', node: 'child' });

            await server.disconnectClient(remote, 'planned remote disconnect');
            await waitFor(async () => (await server.getRegisteredClient('child-client')) === undefined);
            await waitFor(() => !remoteConnection.connected);
            assert.equal(childClient.isConnected, false);

            const orphanClient = createClient(`ws://127.0.0.1:${child.port}${clientPath}`, 'orphan-client', 'orphan');
            try {
                await orphanClient.connect();
                await waitFor(async () => (await server.getRegisteredClient('orphan-client')) !== undefined);
                const orphanRecord = await server.getRegisteredClient('orphan-client');
                assert.ok(orphanRecord);
                const orphanConnection = await server.resolveClient('orphan-client');
                assert.ok(orphanConnection && !isLocalSrpcStream(orphanConnection));

                child.child.kill('SIGKILL');
                await child.exited;
                await waitFor(() => !orphanConnection.connected, 3_000);
                await assert.rejects(server.invoke(orphanConnection, 'dEcho', { value: 'after-crash' }));
                await waitFor(() => orphaned.some(client => client.nodeId === child.nodeId && client.clientId === 'orphan-client'), 16_000);
                const orphan = orphaned.find(client => client.nodeId === child.nodeId && client.clientId === 'orphan-client');
                assert.ok(orphan);
                assert.equal(orphan.role, 'orphan');
                assert.equal(orphan.connectionId, orphanRecord.connectionId);
                assert.equal(await server.getRegisteredClient('orphan-client'), undefined);
                assert.equal(
                    (await server.listRegisteredClients()).some(client => client.clientId === 'orphan-client'),
                    false
                );
                assert.equal(
                    (await server.listClients()).some(connection => connection.clientId === 'orphan-client'),
                    false
                );
            } finally {
                orphanClient.disconnect();
            }
        } finally {
            localClient.disconnect();
            childClient.disconnect();
            await child.stop();
            await server.meshStop().catch(() => {});
            server.close();
            await app.http.close();
            await app.stop();
            if (originalPodIp === undefined) delete process.env.POD_IP;
            else process.env.POD_IP = originalPodIp;
        }
    });
});

function createClient(url: string, clientId: string, node: string): SrpcClient<MeshClientMessage, MeshServerMessage> {
    const client = new SrpcClient<MeshClientMessage, MeshServerMessage>(
        createLogger(`MeshSrpcProcessClient-${clientId}`),
        url,
        JsonMessage as SrpcMessageFns<MeshClientMessage>,
        JsonMessage as SrpcMessageFns<MeshServerMessage>,
        clientId,
        { role: node, secret: `${node}-only` },
        'unused',
        { enableReconnect: false, connectTimeoutMs: 5_000 }
    );
    client.registerMessageHandler('dEcho', data => ({ value: data.value, node }));
    return client;
}

interface MeshNode {
    child: ChildProcess;
    port: number;
    nodeId: number;
    meshProcessId: string;
    osPid: number;
    exited: Promise<void>;
    stop(): Promise<void>;
}

async function startMeshNode(meshKey: string): Promise<MeshNode> {
    const fixture = join(__dirname, 'fixtures', 'mesh-srpc-node.js');
    const child = fork(fixture, [], {
        cwd: process.cwd(),
        silent: true,
        execArgv: ['--enable-source-maps'],
        env: {
            ...process.env,
            POD_IP: '127.0.0.1',
            TSF_MESH_KEY: meshKey,
            TSF_MESH_SECRET: meshSecret,
            TSF_MESH_CLIENT_PATH: clientPath,
            TSF_MESH_LINK_PATH: meshPath
        }
    });
    const diagnostics: string[] = [];
    child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
    child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => {
        resolveExit = resolve;
    });
    let ready = false;
    const node = await new Promise<MeshNode>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out starting mesh child:\n${diagnostics.join('')}`)), 5_000);
        timeout.unref?.();
        child.once('exit', (code, signal) => {
            resolveExit();
            if (!ready) reject(new Error(`Mesh child exited before ready (${code ?? signal}):\n${diagnostics.join('')}`));
        });
        child.on('message', message => {
            if (!isRecord(message)) return;
            if (message.type === 'error') {
                clearTimeout(timeout);
                reject(new Error(String(message.error)));
                return;
            }
            if (message.type !== 'ready') return;
            ready = true;
            clearTimeout(timeout);
            const port = Number(message.port);
            const nodeId = Number(message.nodeId);
            const meshProcessId = typeof message.meshProcessId === 'string' ? message.meshProcessId : '';
            const osPid = Number(message.osPid);
            if (!Number.isSafeInteger(port) || !Number.isSafeInteger(nodeId) || !meshProcessId || !Number.isSafeInteger(osPid)) {
                reject(new Error(`Mesh child returned invalid ready message: ${JSON.stringify(message)}`));
                return;
            }
            resolve({
                child,
                port,
                nodeId,
                meshProcessId,
                osPid,
                exited,
                stop: async () => {
                    if (child.exitCode !== null || child.killed) return;
                    child.send({ type: 'stop' });
                    await Promise.race([
                        exited,
                        new Promise<void>((_resolve, rejectStop) => {
                            const stopTimeout = setTimeout(() => rejectStop(new Error('Timed out stopping mesh child')), 3_000);
                            stopTimeout.unref?.();
                        })
                    ]).catch(error => {
                        child.kill('SIGKILL');
                        throw error;
                    });
                }
            });
        });
    });
    return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}
