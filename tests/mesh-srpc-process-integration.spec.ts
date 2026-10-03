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
    deferred,
    getMeshLinkProcessId,
    getSrpcRegistryMetadata,
    isLocalSrpcStream,
    MeshSrpcServer,
    SrpcClient,
    SrpcOwnerUnavailableError,
    type SrpcMessageFns
} from '../src';
import type { MeshSrpcConnection, SrpcStream } from '../src';

const redisSkip = process.env.REDIS_HOST ? false : 'set REDIS_HOST to run multi-process mesh integration tests';
const clientPath = '/mesh-process-client';
const meshPath = '/_tsf/mesh-process';
const meshSecret = 'mesh-process-integration-secret';
const MeshProcessTestTimeoutMs = 30_000;
const MeshChildStartupTimeoutMs = 15_000;

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
    it('uses the application listener across processes and fences a crashed remote owner', { timeout: MeshProcessTestTimeoutMs }, async () => {
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
        let child: MeshNode | undefined;
        let localClient: SrpcClient<MeshClientMessage, MeshServerMessage> | undefined;
        let childClient: SrpcClient<MeshClientMessage, MeshServerMessage> | undefined;

        try {
            const httpServer = await app.http.listen(0, '127.0.0.1');
            const parentPort = (httpServer.address() as AddressInfo).port;
            await server.meshStart();
            const meshNode = await startMeshNode(meshKey);
            child = meshNode;
            localClient = createClient(`ws://127.0.0.1:${parentPort}${clientPath}`, 'parent-client', 'parent');
            const meshChildClient = createClient(`ws://127.0.0.1:${meshNode.port}${clientPath}`, 'child-client', 'child');
            childClient = meshChildClient;
            const orphaned: Array<{ nodeId: number; clientId: string; connectionId: string; role: string }> = [];
            server.onNodeClientsOrphaned((nodeId, clients) => {
                orphaned.push(
                    ...clients.map(client => ({ nodeId, clientId: client.clientId, connectionId: client.connectionId, role: client.metadata.role }))
                );
            });

            await localClient.connect();
            await meshChildClient.connect();
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
            assert.equal(remoteConnection.ownerNodeId, meshNode.nodeId);
            assert.equal(remoteConnection.ownerProcessId, meshNode.meshProcessId);
            assert.notEqual(remoteConnection.ownerProcessId, getMeshLinkProcessId());
            assert.notEqual(meshNode.osPid, process.pid);
            assert.deepEqual(await server.invoke(local, 'dEcho', { value: 'local' }), { value: 'local', node: 'parent' });
            assert.deepEqual(await server.invoke(remote, 'dEcho', { value: 'remote' }), { value: 'remote', node: 'child' });

            await server.disconnectClient(remote, 'planned remote disconnect');
            await waitFor(async () => (await server.getRegisteredClient('child-client')) === undefined);
            await waitFor(() => !remoteConnection.connected);
            await waitFor(() => !meshChildClient.isConnected);
            assert.equal(meshChildClient.isConnected, false);

            const orphanClient = createClient(`ws://127.0.0.1:${meshNode.port}${clientPath}`, 'orphan-client', 'orphan');
            try {
                await orphanClient.connect();
                await waitFor(async () => (await server.getRegisteredClient('orphan-client')) !== undefined);
                const orphanRecord = await server.getRegisteredClient('orphan-client');
                assert.ok(orphanRecord);
                const orphanConnection = await server.resolveClient('orphan-client');
                assert.ok(orphanConnection && !isLocalSrpcStream(orphanConnection));

                meshNode.child.kill('SIGKILL');
                await meshNode.exited;
                await waitFor(() => !orphanConnection.connected, 3_000);
                await assert.rejects(server.invoke(orphanConnection, 'dEcho', { value: 'after-crash' }));
                await waitFor(() => orphaned.some(client => client.nodeId === meshNode.nodeId && client.clientId === 'orphan-client'), 16_000);
                const orphan = orphaned.find(client => client.nodeId === meshNode.nodeId && client.clientId === 'orphan-client');
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
            localClient?.disconnect();
            childClient?.disconnect();
            if (child) {
                try {
                    await child.stop();
                } catch {
                    // The process may already have been intentionally killed.
                }
            }
            await server.meshStop().catch(() => {});
            server.close();
            await app.http.close();
            await app.stop();
            if (originalPodIp === undefined) delete process.env.POD_IP;
            else process.env.POD_IP = originalPodIp;
        }
    });
    for (const scenario of ['rpc-timeout', 'requester-stops', 'routing-timeout', 'acknowledged-timeout'] as const) {
        it(`applies the owner timeout policy across processes: ${scenario}`, { timeout: MeshProcessTestTimeoutMs }, async () => {
            const originalPodIp = process.env.POD_IP;
            process.env.POD_IP = '127.0.0.1';
            const meshKey = `mesh-timeout-${randomUUID()}`;
            const app = createApp({ enableHealthcheck: false });
            const server = new MeshSrpcServer<ClientMetadata, MeshClientMessage, MeshServerMessage, { role: string }>({
                logger: createLogger('MeshTimeoutRequester'),
                clientMessage: JsonMessage as SrpcMessageFns<MeshClientMessage>,
                serverMessage: JsonMessage as SrpcMessageFns<MeshServerMessage>,
                wsPath: clientPath,
                disconnectOnRequestTimeout: scenario === 'routing-timeout',
                meshKey,
                meshLink: { secret: meshSecret, path: meshPath },
                extractRegistryMetadata: stream => ({ role: stream.meta.role }),
                autoLifecycle: false
            });
            server.setClientAuthorizer(() => true);
            let child: MeshNode | undefined;
            let client: SrpcClient<MeshClientMessage, MeshServerMessage> | undefined;
            try {
                await app.http.listen(0, '127.0.0.1');
                await server.meshStart();
                child = await startMeshNode(meshKey, true);
                const owner = child;
                const clientId = `timeout-${scenario}`;
                client = createClient(`ws://127.0.0.1:${owner.port}${clientPath}`, clientId, 'owner', 4);
                if (scenario === 'rpc-timeout' || scenario === 'requester-stops') {
                    // Simulate a v4 runtime whose transport fails to acknowledge
                    // receipt; keep the socket and handler dispatch alive.
                    const runtime = client as any;
                    const writeMessage = runtime.writeMessage.bind(runtime);
                    runtime.writeMessage = (message: BaseMessage, generation: number) =>
                        message.requestAck ? true : writeMessage(message, generation);
                }
                const dispatched = deferred<void>();
                let agentCalls = 0;
                client.registerMessageHandler('dEcho', data => {
                    agentCalls++;
                    dispatched.resolve();
                    if (scenario === 'routing-timeout') return { value: data.value, node: 'owner' };
                    return new Promise<{ value: string; node: string }>(() => {});
                });
                await client.connect();
                await waitFor(async () => {
                    const record = await server.getRegisteredClient(clientId);
                    return record?.nodeId === owner.nodeId;
                });
                const connection = await server.resolveClient(clientId);
                assert.ok(connection && !isLocalSrpcStream(connection));

                if (scenario === 'routing-timeout') {
                    // Spend the caller's deadline in routing without issuing an
                    // agent RPC. A mesh deadline is not an agent timeout.
                    const registry = server.clientRegistry;
                    const getClient = registry.getClient.bind(registry);
                    const releaseLookup = deferred<void>();
                    let holdNextLookup = true;
                    registry.getClient = async id => {
                        if (id === clientId && holdNextLookup) {
                            holdNextLookup = false;
                            await releaseLookup.promise;
                        }
                        return getClient(id);
                    };
                    try {
                        await assert.rejects(server.invoke(connection, 'dEcho', { value: 'not-dispatched' }, 100), error => {
                            assert.ok(error instanceof SrpcOwnerUnavailableError);
                            assert.ok(error.cause instanceof Error);
                            assert.match(error.cause.message, /timed out/i);
                            return true;
                        });
                    } finally {
                        registry.getClient = getClient;
                        releaseLookup.resolve();
                    }
                    assert.equal(agentCalls, 0);
                    const response = await server.invoke(connection, 'dEcho', { value: 'healthy' }, 2_000);
                    assert.equal(response.value, 'healthy');
                    assert.equal(agentCalls, 1);
                    assert.deepEqual(owner.disconnected, []);
                    const record = await server.getRegisteredClient(clientId);
                    assert.equal(record?.connectionId, connection.id);
                } else {
                    const request = server.invoke(connection, 'dEcho', { value: 'unanswered' }, 5_000);
                    const rejection = assert.rejects(request);
                    await dispatched.promise;
                    if (scenario === 'requester-stops') await server.meshStop();
                    await rejection;
                    if (scenario === 'acknowledged-timeout') {
                        const record = await server.clientRegistry.getClient(clientId);
                        assert.equal(record?.connectionId, connection.id);
                        const current = await server.resolveClient(clientId);
                        assert.equal(current?.id, connection.id);
                        assert.deepEqual(owner.disconnected, []);
                        assert.equal(agentCalls, 1);
                        return;
                    }
                    await waitFor(() => owner.disconnected.some(item => item.clientId === clientId), 7_000);
                    await waitFor(async () => {
                        const record = await server.clientRegistry.getClient(clientId);
                        return record === undefined;
                    }, 2_000);
                    const disconnected = owner.disconnected.filter(item => item.clientId === clientId);
                    assert.deepEqual(disconnected, [{ clientId, connectionId: connection.id, cause: 'timeout' }]);
                    const resolved = await server.resolveClient(clientId);
                    assert.equal(resolved, undefined);
                    assert.equal(agentCalls, 1, 'an uncertain command must not be retried');
                }
            } finally {
                client?.disconnect();
                await child?.stop();
                await server.meshStop().catch(() => {});
                server.close();
                await app.http.close();
                await app.stop();
                if (originalPodIp === undefined) delete process.env.POD_IP;
                else process.env.POD_IP = originalPodIp;
            }
        });
    }
});

function createClient(url: string, clientId: string, node: string, protocolVersion: 3 | 4 = 3): SrpcClient<MeshClientMessage, MeshServerMessage> {
    const client = new SrpcClient<MeshClientMessage, MeshServerMessage>(
        createLogger(`MeshSrpcProcessClient-${clientId}`),
        url,
        JsonMessage as SrpcMessageFns<MeshClientMessage>,
        JsonMessage as SrpcMessageFns<MeshServerMessage>,
        clientId,
        { role: node, secret: `${node}-only` },
        'unused',
        { enableReconnect: false, connectTimeoutMs: 5_000, protocolVersion }
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
    disconnected: { clientId: string; connectionId: string; cause: string }[];
    stop(): Promise<void>;
}

async function startMeshNode(meshKey: string, disconnectOnRequestTimeout = false): Promise<MeshNode> {
    const fixture = join(__dirname, 'fixtures', 'mesh-srpc-node.js');
    const child = fork(fixture, [], {
        cwd: process.cwd(),
        silent: true,
        execArgv: ['--enable-source-maps'],
        env: {
            ...process.env,
            POD_IP: '127.0.0.1',
            TSF_MESH_KEY: meshKey,
            TSF_MESH_DISCONNECT_ON_REQUEST_TIMEOUT: disconnectOnRequestTimeout ? '1' : '0',
            TSF_MESH_SECRET: meshSecret,
            TSF_MESH_CLIENT_PATH: clientPath,
            TSF_MESH_LINK_PATH: meshPath
        }
    });
    const diagnostics: string[] = [];
    const disconnected: MeshNode['disconnected'] = [];
    child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
    child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => {
        resolveExit = resolve;
    });
    let exitedChild = false;
    let ready = false;
    child.once('exit', () => {
        exitedChild = true;
        resolveExit();
    });

    try {
        return await new Promise<MeshNode>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => fail(new Error(`Timed out starting mesh child:\n${diagnostics.join('')}`)), MeshChildStartupTimeoutMs);
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            };
            const succeed = (node: MeshNode) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(node);
            };
            child.once('exit', (code, signal) => {
                if (!ready) fail(new Error(`Mesh child exited before ready (${code ?? signal}):\n${diagnostics.join('')}`));
            });
            child.on('message', message => {
                if (!isRecord(message)) return;
                if (message.type === 'client-disconnected') {
                    disconnected.push({
                        clientId: String(message.clientId),
                        connectionId: String(message.connectionId),
                        cause: String(message.cause)
                    });
                    return;
                }
                if (message.type === 'error') {
                    fail(new Error(String(message.error)));
                    return;
                }
                if (message.type !== 'ready') return;
                ready = true;
                const port = Number(message.port);
                const nodeId = Number(message.nodeId);
                const meshProcessId = typeof message.meshProcessId === 'string' ? message.meshProcessId : '';
                const osPid = Number(message.osPid);
                if (!Number.isSafeInteger(port) || !Number.isSafeInteger(nodeId) || !meshProcessId || !Number.isSafeInteger(osPid)) {
                    fail(new Error(`Mesh child returned invalid ready message: ${JSON.stringify(message)}`));
                    return;
                }
                succeed({
                    child,
                    port,
                    nodeId,
                    meshProcessId,
                    osPid,
                    exited,
                    disconnected,
                    stop: async () => {
                        if (child.exitCode !== null || child.killed) return;
                        child.send({ type: 'stop' });
                        const stopped = Promise.race([
                            exited,
                            new Promise<void>((_resolve, rejectStop) => {
                                const stopTimeout = setTimeout(() => rejectStop(new Error('Timed out stopping mesh child')), 3_000);
                                stopTimeout.unref?.();
                            })
                        ]);
                        try {
                            await stopped;
                        } catch (error) {
                            child.kill('SIGKILL');
                            throw error;
                        }
                    }
                });
            });
        });
    } catch (error) {
        if (!exitedChild) child.kill('SIGKILL');
        await exited;
        throw error;
    }
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
