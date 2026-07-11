import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    ClientDisconnectedError,
    ClientInvocationError,
    ClientNotFoundError,
    MeshClientRegistry,
    MeshClientService,
    type MeshClientRegistryBackend,
    type RegisteredClient,
    type RegisterResult
} from '../src';

interface TestMeta {
    role: string;
}

interface StoredClient<TMeta> extends RegisteredClient<TMeta> {
    state: 'active' | 'pending';
}

class InMemoryRegistryBackend<TMeta> implements MeshClientRegistryBackend<TMeta> {
    readonly clients = new Map<string, StoredClient<TMeta>>();

    async register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        return this.store(clientId, nodeId, metadata, allowSupersede, 'active');
    }

    async reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        return this.store(clientId, nodeId, metadata, allowSupersede, 'pending');
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId) return false;
        this.clients.set(clientId, { ...existing, metadata, state: 'active' });
        return true;
    }

    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        if (this.clients.get(clientId)?.nodeId !== nodeId) return false;
        this.clients.delete(clientId);
        return true;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId) return false;
        this.clients.set(clientId, { ...existing, metadata });
        return true;
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        const client = this.clients.get(clientId);
        return client?.state === 'active' ? this.withoutState(client) : undefined;
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        return [...this.clients.values()].filter(client => client.state === 'active').map(client => this.withoutState(client));
    }

    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        return (await this.listClients()).filter(client => client.nodeId === nodeId);
    }

    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const removed = [...this.clients.values()].filter(client => client.nodeId === nodeId);
        for (const client of removed) this.clients.delete(client.clientId);
        return removed.map(client => this.withoutState(client));
    }

    private async store(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        state: 'active' | 'pending'
    ): Promise<RegisterResult> {
        const existing = this.clients.get(clientId);
        if (existing && existing.nodeId !== nodeId && !allowSupersede) {
            return { status: 'conflict', ownerNodeId: existing.nodeId };
        }
        this.clients.set(clientId, {
            clientId,
            nodeId,
            connectedAt: Date.now(),
            metadata,
            state
        });
        return { status: 'ok', supersededNodeId: existing && existing.nodeId !== nodeId ? existing.nodeId : null };
    }

    private withoutState(client: StoredClient<TMeta>): RegisteredClient<TMeta> {
        const { state: _state, ...registered } = client;
        return registered;
    }
}

describe('mesh client tracking', () => {
    it('keeps reservations hidden and preserves conflict and supersession results', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientRegistry(1, backend);
        const second = new MeshClientRegistry(2, backend);

        assert.deepStrictEqual(await first.reserve('pending', { role: 'pending' }), {
            status: 'ok',
            supersededNodeId: null
        });
        assert.equal(await first.getClient('pending'), undefined);
        assert.deepStrictEqual(await first.listClients(), []);
        assert.equal(await first.activate('pending', { role: 'active' }), true);
        assert.equal((await first.getClient('pending'))?.metadata.role, 'active');

        assert.deepStrictEqual(await second.register('pending', { role: 'blocked' }, false), {
            status: 'conflict',
            ownerNodeId: 1
        });
        assert.deepStrictEqual(await second.register('pending', { role: 'moved' }), {
            status: 'ok',
            supersededNodeId: 1
        });
        assert.deepStrictEqual(await first.listClientsForNode(), []);
        assert.equal((await second.getClient('pending'))?.metadata.role, 'moved');
    });

    it('routes local and remote delivery and persists accepted remote metadata', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const deliveries: string[] = [];
        let liveMetadata = { role: 'initial' };
        const first = new MeshClientService<TestMeta>({
            key: 'in-memory-first',
            registryBackend: backend,
            clientInvokeFn: async (clientId, type) => {
                deliveries.push(`${clientId}:${type}`);
                if (type === 'disconnect') throw new ClientDisconnectedError(clientId);
                if (type === 'fail') throw new Error('delivery failed');
                return { owner: 1 };
            },
            clientUpdateMetaFn: (_clientId, metadata) => {
                liveMetadata = metadata;
                return true;
            }
        });
        const second = new MeshClientService<TestMeta>({
            key: 'in-memory-second',
            registryBackend: backend,
            clientInvokeFn: async () => ({ owner: 2 })
        });

        assert.equal(await first.registerClient('before-start', { role: 'ignored' }), true);
        await assert.rejects(first.invoke('before-start', 'notify', {}), ClientNotFoundError);

        markRunning(first, 1, backend);
        markRunning(second, 2, backend);
        routeMeshCalls(second, first);
        assert.equal(await first.registerClient('client-1', liveMetadata, false), true);

        assert.deepStrictEqual(await first.invoke('client-1', 'local', {}), { owner: 1 });
        assert.deepStrictEqual(await second.invoke('client-1', 'remote', {}), { owner: 1 });
        assert.deepStrictEqual(deliveries, ['client-1:local', 'client-1:remote']);
        await assert.rejects(second.invoke('client-1', 'disconnect', {}), ClientDisconnectedError);
        await assert.rejects(second.invoke('client-1', 'fail', {}), ClientInvocationError);

        assert.equal(await second.updateClientMetadata('client-1', { role: 'updated' }), true);
        assert.deepStrictEqual(liveMetadata, { role: 'updated' });
        assert.deepStrictEqual((await second.clientRegistry.getClient('client-1'))?.metadata, { role: 'updated' });

        assert.equal(await second.registerClient('client-1', { role: 'conflict' }, false), false);
        const superseded: string[] = [];
        first.onClientSuperseded(clientId => {
            superseded.push(clientId);
        });
        assert.equal(await second.registerClient('client-1', { role: 'second' }), true);
        await Promise.resolve();
        assert.deepStrictEqual(superseded, ['client-1']);
    });
});

type MutableMeshClientService<TMeta> = {
    running: boolean;
    registry: MeshClientRegistry<TMeta>;
    mesh: {
        _instanceId: number;
        handlers: Map<string, (data: unknown) => unknown>;
        invoke: (instanceId: number, type: string, data: unknown, timeoutMs?: number) => Promise<unknown>;
    };
};

function markRunning<TMeta>(service: MeshClientService<TMeta>, nodeId: number, backend: MeshClientRegistryBackend<TMeta>): void {
    const mutable = service as unknown as MutableMeshClientService<TMeta>;
    mutable.running = true;
    mutable.registry = new MeshClientRegistry(nodeId, backend);
    mutable.mesh._instanceId = nodeId;
}

function routeMeshCalls<TMeta>(caller: MeshClientService<TMeta>, target: MeshClientService<TMeta>): void {
    const callerMesh = (caller as unknown as MutableMeshClientService<TMeta>).mesh;
    const targetMesh = (target as unknown as MutableMeshClientService<TMeta>).mesh;
    callerMesh.invoke = async (_instanceId, type, data) => {
        const handler = targetMesh.handlers.get(type);
        if (!handler) throw new Error(`Missing in-memory mesh handler: ${type}`);
        return handler(data);
    };
}
