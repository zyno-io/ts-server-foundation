import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    ClientDisconnectedError,
    ClientInvocationError,
    ClientNotFoundError,
    type MeshClientClaim,
    type MeshClientRecord,
    MeshClientRegistry,
    MeshClientService,
    MeshSrpcServer,
    SrpcError,
    SrpcIndeterminateDeliveryError,
    type MeshClientRegistryBackend,
    type RegisteredClient,
    type RegisterResult
} from '../src';
import { MeshSrpcLinkController } from '../src/services/mesh-client/mesh-srpc-link-controller';

interface TestMeta {
    role: string;
}

interface StoredClient<TMeta> extends RegisteredClient<TMeta> {
    state: 'active' | 'pending';
    claimId?: string;
}

class InMemoryRegistryBackend<TMeta> implements MeshClientRegistryBackend<TMeta> {
    readonly clients = new Map<string, StoredClient<TMeta>>();
    readonly claims = new Map<
        string,
        {
            claimId: string;
            client: StoredClient<TMeta>;
            previous?: StoredClient<TMeta>;
            preimage?: StoredClient<TMeta>;
        }
    >();

    async register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<RegisterResult> {
        return this.store(clientId, nodeId, metadata, allowSupersede, 'active', connectionId);
    }

    async reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<RegisterResult> {
        return this.store(clientId, nodeId, metadata, allowSupersede, 'pending', connectionId);
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId || existing.connectionId !== connectionId) return false;
        this.clients.set(clientId, { ...existing, metadata, state: 'active' });
        return true;
    }

    async unregister(clientId: string, nodeId: number, connectionId: string): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId || existing.connectionId !== connectionId) return false;
        this.clients.delete(clientId);
        return true;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId || existing.connectionId !== connectionId) return false;
        this.clients.set(clientId, { ...existing, metadata });
        return true;
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        const client = this.clients.get(clientId);
        return client?.state === 'active' ? this.withoutState(client) : undefined;
    }

    async getClientIncludingPending(clientId: string): Promise<StoredClient<TMeta> | undefined> {
        return this.clients.get(clientId);
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        return [...this.clients.values()].filter(client => client.state === 'active').map(client => this.withoutState(client));
    }

    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        return (await this.listClients()).filter(client => client.nodeId === nodeId);
    }

    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const removed = [...this.clients.values()].filter(client => client.nodeId === nodeId && client.state === 'active');
        for (const client of this.clients.values()) {
            if (client.nodeId === nodeId) this.clients.delete(client.clientId);
        }
        return removed.map(client => this.withoutState(client));
    }

    async cleanupNodeForFallback(nodeId: number, maxItems: number, maxBytes: number): Promise<RegisteredClient<TMeta>[]> {
        const removed = [...this.clients.values()]
            .filter(client => client.nodeId === nodeId && client.state === 'active')
            .map(client => this.withoutState(client));
        if ((removed.length > 0 && maxItems < 1) || (removed.length > 0 && Buffer.byteLength(JSON.stringify(removed)) > maxBytes)) {
            throw new Error('fallback orphan queue is full');
        }
        for (const client of this.clients.values()) {
            if (client.nodeId === nodeId) this.clients.delete(client.clientId);
        }
        return removed;
    }

    async claim(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        state: 'active' | 'pending',
        allowSupersede: boolean,
        connectionId: string
    ): Promise<MeshClientClaim<TMeta>> {
        const existingClaim = this.claims.get(clientId);
        if (existingClaim) {
            if (
                existingClaim.client.nodeId === nodeId &&
                existingClaim.client.connectionId === connectionId &&
                existingClaim.client.state === state
            ) {
                return {
                    status: 'ok',
                    claimId: existingClaim.claimId,
                    ...(existingClaim.previous ? { previous: existingClaim.previous } : {})
                };
            }
            return { status: 'conflict', ownerNodeId: this.clients.get(clientId)?.nodeId ?? null };
        }
        const existing = this.clients.get(clientId);
        if (existing && existing.nodeId !== nodeId && !allowSupersede) return { status: 'conflict', ownerNodeId: existing.nodeId };
        const previous = existing && (existing.nodeId !== nodeId || existing.connectionId !== connectionId) ? existing : undefined;
        const claimId = `${nodeId}:${connectionId}:${Date.now()}:${Math.random()}`;
        this.claims.set(clientId, {
            claimId,
            client: { clientId, nodeId, connectionId, connectedAt: Date.now(), metadata, state },
            previous,
            preimage: existing
        });
        return { status: 'ok', claimId, ...(previous ? { previous } : {}) };
    }

    async commitClaim(clientId: string, nodeId: number, claimId: string): Promise<boolean | 'previous-changed'> {
        const claim = this.claims.get(clientId);
        if (!claim) {
            const committed = this.clients.get(clientId);
            return committed?.nodeId === nodeId && committed.claimId === claimId;
        }
        if (claim.client.nodeId !== nodeId || claim.claimId !== claimId) return false;
        const current = this.clients.get(clientId);
        if (claim.previous) {
            if (current && !this.sameRecord(current, claim.previous)) {
                if (
                    claim.previous.claimId &&
                    current.claimId === claim.previous.claimId &&
                    current.nodeId === claim.previous.nodeId &&
                    current.connectionId === claim.previous.connectionId
                ) {
                    return 'previous-changed';
                }
                return false;
            }
        } else {
            if (claim.preimage ? !current || !this.sameRecord(current, claim.preimage) : Boolean(current)) return false;
        }
        this.clients.set(clientId, { ...claim.client, claimId });
        this.claims.delete(clientId);
        return true;
    }

    async removeClaimPrevious(clientId: string, nodeId: number, claimId: string): Promise<boolean> {
        const claim = this.claims.get(clientId);
        if (!claim || claim.client.nodeId !== nodeId || claim.claimId !== claimId || !claim.previous) return false;
        const current = this.clients.get(clientId);
        if (!current) return true;
        if (
            !this.sameRecord(current, claim.previous) &&
            (!claim.previous.claimId ||
                current.claimId !== claim.previous.claimId ||
                current.nodeId !== claim.previous.nodeId ||
                current.connectionId !== claim.previous.connectionId)
        ) {
            return false;
        }
        this.clients.delete(clientId);
        return true;
    }

    async abortClaim(clientId: string, nodeId: number, claimId: string): Promise<boolean> {
        const claim = this.claims.get(clientId);
        if (!claim || claim.client.nodeId !== nodeId || claim.claimId !== claimId) return false;
        this.claims.delete(clientId);
        return true;
    }

    async removeClaimResult(clientId: string, nodeId: number, claimId: string): Promise<boolean> {
        let removed = false;
        const current = this.clients.get(clientId);
        if (current?.nodeId === nodeId && current.claimId === claimId) {
            this.clients.delete(clientId);
            removed = true;
        }
        const claim = this.claims.get(clientId);
        if (claim?.client.nodeId === nodeId && claim.claimId === claimId) {
            this.claims.delete(clientId);
            removed = true;
        }
        return removed;
    }

    private async store(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        state: 'active' | 'pending',
        connectionId: string
    ): Promise<RegisterResult> {
        const existing = this.clients.get(clientId);
        // Direct register has no synchronous revocation acknowledgement;
        // only claim/commit may transfer a different owner.
        if (existing && (existing.nodeId !== nodeId || existing.connectionId !== connectionId)) {
            return { status: 'conflict', ownerNodeId: existing.nodeId };
        }
        this.clients.set(clientId, {
            clientId,
            nodeId,
            connectionId,
            connectedAt: Date.now(),
            metadata,
            state,
            claimId: existing?.claimId ?? `${nodeId}:${connectionId}:${Date.now()}:${Math.random()}`
        });
        const superseded = existing && existing.nodeId !== nodeId ? existing : undefined;
        return {
            status: 'ok',
            supersededNodeId: superseded?.nodeId ?? null,
            ...(superseded?.connectionId ? { supersededConnectionId: superseded.connectionId } : {})
        };
    }

    private withoutState(client: StoredClient<TMeta>): RegisteredClient<TMeta> {
        const { state: _state, claimId: _claimId, ...registered } = client;
        return registered;
    }

    private sameRecord(first: StoredClient<TMeta>, second: StoredClient<TMeta>): boolean {
        return (
            first.clientId === second.clientId &&
            first.nodeId === second.nodeId &&
            first.connectionId === second.connectionId &&
            first.processId === second.processId &&
            first.connectedAt === second.connectedAt &&
            first.state === second.state &&
            first.claimId === second.claimId &&
            JSON.stringify(first.metadata) === JSON.stringify(second.metadata)
        );
    }
}

describe('mesh client tracking', () => {
    it('does not bypass handler or disconnect fences after the mesh instance ID resets', async () => {
        let invokes = 0;
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'instance-reset-fence',
            registryBackend: backend,
            clientInvokeFn: async () => {
                invokes++;
            }
        });
        markRunning(service, 1, backend);
        const mutable = service as unknown as MutableMeshClientService<TestMeta> & {
            ownershipGeneration: number;
        };
        mutable.mesh._instanceId = 0;
        mutable.mesh.assertLeaseSafe = () => {
            throw new Error('expired lease');
        };
        await assert.rejects(service.invoke('client-1', 'message', {}), ClientNotFoundError);
        assert.equal(invokes, 0);

        mutable.mesh._instanceId = 1;
        mutable.mesh.assertLeaseSafe = () => {};
        assert.equal(await service.registerClient('client-1', { role: 'owner' }, true, 'connection-1'), true);
        let releaseLookup!: () => void;
        let lookupStarted = false;
        const lookupBlocked = new Promise<void>(resolve => {
            releaseLookup = resolve;
        });
        const getClient = backend.getClient.bind(backend);
        backend.getClient = async clientId => {
            lookupStarted = true;
            await lookupBlocked;
            return getClient(clientId);
        };
        let disconnectCallbacks = 0;
        service.onClientSuperseded(() => {
            disconnectCallbacks++;
            return true;
        });
        const disconnect = service.disconnectClient('client-1', 'connection-1', 'test');
        while (!lookupStarted) await new Promise<void>(resolve => setImmediate(resolve));
        (service as any).running = false;
        mutable.ownershipGeneration++;
        mutable.mesh._instanceId = 0;
        releaseLookup();

        assert.equal(await disconnect, false);
        assert.equal(disconnectCallbacks, 0);
    });

    it('keeps reservations hidden and preserves conflict and supersession results', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientRegistry(1, backend);
        const second = new MeshClientRegistry(2, backend);

        assert.deepStrictEqual(await first.reserve('pending', { role: 'pending' }, false, 'pending-connection'), {
            status: 'ok',
            supersededNodeId: null
        });
        assert.equal(await first.getClient('pending'), undefined);
        assert.deepStrictEqual(await first.listClients(), []);
        assert.equal(await first.activate('pending', { role: 'active' }, 'pending-connection'), true);
        assert.equal((await first.getClient('pending'))?.metadata.role, 'active');

        assert.deepStrictEqual(await second.register('pending', { role: 'blocked' }, false, 'blocked-connection'), {
            status: 'conflict',
            ownerNodeId: 1
        });
        assert.deepStrictEqual(await second.register('pending', { role: 'moved' }, true, 'moved-connection'), {
            status: 'conflict',
            ownerNodeId: 1
        });
        assert.equal((await first.getClient('pending'))?.metadata.role, 'active');
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

        assert.equal(await first.registerClient('before-start', { role: 'ignored' }, false, 'before-start-connection'), true);
        await assert.rejects(first.invoke('before-start', 'notify', {}), ClientNotFoundError);

        markRunning(first, 1, backend);
        markRunning(second, 2, backend);
        routeMeshCalls(second, first);
        assert.equal(await first.registerClient('client-1', liveMetadata, false, 'connection-1'), true);

        assert.deepStrictEqual(await first.invoke('client-1', 'local', {}), { owner: 1 });
        assert.deepStrictEqual(await second.invoke('client-1', 'remote', {}), { owner: 1 });
        assert.deepStrictEqual(deliveries, ['client-1:local', 'client-1:remote']);
        await assert.rejects(second.invoke('client-1', 'disconnect', {}), ClientDisconnectedError);
        await assert.rejects(second.invoke('client-1', 'fail', {}), ClientInvocationError);

        assert.equal(await second.updateClientMetadata('client-1', { role: 'updated' }), true);
        assert.deepStrictEqual(liveMetadata, { role: 'updated' });
        assert.deepStrictEqual((await second.clientRegistry.getClient('client-1'))?.metadata, { role: 'updated' });

        assert.equal(await second.registerClient('client-1', { role: 'conflict' }, false, 'connection-conflict'), false);
        const superseded: string[] = [];
        first.onClientSuperseded(clientId => {
            superseded.push(clientId);
        });
        assert.equal(await second.registerClient('client-1', { role: 'second' }, true, 'connection-2'), true);
        await Promise.resolve();
        assert.deepStrictEqual(superseded, ['client-1']);
    });

    it('preserves SrpcError messages and user-error state through fallback invocation forms', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        let nextError: Error = new SrpcError('expected', true);
        const owner = new MeshClientService<TestMeta>({
            key: 'fallback-srpc-error-owner',
            registryBackend: backend,
            clientInvokeFn: async () => {
                throw nextError;
            }
        });
        const requester = new MeshClientService<TestMeta>({
            key: 'fallback-srpc-error-requester',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(owner, 1, backend);
        markRunning(requester, 2, backend);
        routeMeshCalls(requester, owner);
        assert.equal(await owner.registerClient('client-1', { role: 'owner' }, false, 'connection-1'), true);
        const requesterMesh = (requester as unknown as MutableMeshClientService<TestMeta>).mesh;

        for (const pathway of [
            { name: 'string client ID', connectionId: undefined },
            { name: 'generation handle', connectionId: 'connection-1' }
        ]) {
            for (const expected of [
                { message: 'expected failure', userError: true },
                { message: '', userError: false },
                { message: '', userError: undefined }
            ]) {
                nextError = new SrpcError(expected.message, expected.userError);
                await assert.rejects(requester.invoke('client-1', pathway.name, {}, undefined, pathway.connectionId), error => {
                    assert.ok(error instanceof SrpcError);
                    assert.equal(error.message, expected.message);
                    assert.equal(error.isUserError, expected.userError);
                    return true;
                });
            }
        }
        const namedLikeSrpc = new Error('ordinary failure');
        namedLikeSrpc.name = 'SrpcError';
        nextError = namedLikeSrpc;
        await assert.rejects(
            requester.invoke('client-1', 'ordinary named error', {}),
            error => error instanceof ClientInvocationError && !(error instanceof SrpcError)
        );
    });

    it('persists an owner-projected metadata update over the mesh path', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const fullMetadata = { role: 'initial', secret: 'owner-only' };
        const owner = new MeshClientService<TestMeta>({
            key: 'projected-owner',
            registryBackend: backend,
            clientInvokeFn: async () => undefined,
            clientProjectMetaFn: (_clientId, update) => {
                const projected = update && typeof update === 'object' ? { ...fullMetadata, ...update } : fullMetadata;
                return { updated: true, metadata: { role: projected.role } };
            },
            clientApplyMetaFn: (_clientId, update) => {
                if (update && typeof update === 'object') Object.assign(fullMetadata, update);
                return true;
            }
        });
        const requester = new MeshClientService<TestMeta>({
            key: 'projected-requester',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(owner, 1, backend);
        markRunning(requester, 2, backend);
        routeMeshCalls(requester, owner);
        assert.equal(await owner.registerClient('client-1', { role: fullMetadata.role }, false, 'connection-1'), true);

        assert.equal(
            await requester.updateClientMetadata('client-1', { role: 'updated', secret: 'rotated-owner-only' } as unknown as TestMeta),
            true
        );

        assert.deepEqual(fullMetadata, { role: 'updated', secret: 'rotated-owner-only' });
        assert.deepEqual((await requester.clientRegistry.getClient('client-1'))?.metadata, { role: 'updated' });
    });

    it('rejects a delayed fenced forward after the owner reconnects', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        let deliveries = 0;
        const owner = new MeshClientService<TestMeta>({
            key: 'delayed-forward-owner',
            registryBackend: backend,
            clientInvokeFn: async () => {
                deliveries++;
                return { delivered: true };
            }
        });
        const requester = new MeshClientService<TestMeta>({
            key: 'delayed-forward-requester',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(owner, 1, backend);
        markRunning(requester, 2, backend);
        assert.equal(await owner.registerClient('client-1', { role: 'old' }, true, 'connection-1'), true);

        requester.setRemoteTransport({
            invokeClient: async (_nodeId, request) => {
                // The caller looked up connection-1, but delivery was delayed
                // until after the owner installed connection-2.
                backend.clients.set('client-1', {
                    clientId: 'client-1',
                    nodeId: 1,
                    connectionId: 'connection-2',
                    connectedAt: Date.now(),
                    metadata: { role: 'new' },
                    state: 'active'
                });
                return owner.invoke(request.clientId, request.type, request.data, request.timeoutMs, request.connectionId);
            },
            fenceClient: async () => false,
            updateClientMetadata: async () => false
        });

        await assert.rejects(requester.invoke('client-1', 'notify', {}), ClientDisconnectedError);
        assert.equal(deliveries, 0);
    });

    it('routes plain clientId invokes with the observed connection generation', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const owner = new MeshClientService<TestMeta>({
            key: 'unfenced-owner',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        const requester = new MeshClientService<TestMeta>({
            key: 'unfenced-requester',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(owner, 1, backend);
        markRunning(requester, 2, backend);
        assert.equal(await owner.registerClient('client-1', { role: 'old' }, true, 'connection-1'), true);

        const requests: unknown[] = [];
        requester.setRemoteTransport({
            invokeClient: async (_nodeId, request) => {
                requests.push(request);
                return 'compatible';
            },
            fenceClient: async () => false,
            updateClientMetadata: async () => false
        });

        assert.equal(await requester.invoke('client-1', 'read', {}), 'compatible');
        assert.deepEqual(requests, [{ clientId: 'client-1', type: 'read', data: {}, timeoutMs: undefined, connectionId: 'connection-1' }]);
        assert.equal(await requester.invoke('client-1', 'write', {}, undefined, 'connection-1'), 'compatible');
        assert.equal(requests.length, 2);
    });

    it('rejects a pinned invoke if the registry advanced before routing', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const requester = new MeshClientService<TestMeta>({
            key: 'advanced-before-routing',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(requester, 2, backend);
        await backend.register('client-1', 1, { role: 'new' }, true, 'connection-2');

        let routed = false;
        requester.setRemoteTransport({
            invokeClient: async () => {
                routed = true;
                return undefined;
            },
            fenceClient: async () => false,
            updateClientMetadata: async () => false
        });

        await assert.rejects(requester.invoke('client-1', 'write', {}, undefined, 'connection-1'), ClientDisconnectedError);
        assert.equal(routed, false);
    });

    it('does not publish a takeover until the exact old generation acknowledges its fence', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientService<TestMeta>({
            key: 'delayed-kick-first',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        const second = new MeshClientService<TestMeta>({
            key: 'delayed-kick-second',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(first, 1, backend);
        markRunning(second, 2, backend);

        const activeConnectionId = 'connection-1';
        let disconnects = 0;
        first.onClientSuperseded((_clientId, connectionId) => {
            if (connectionId !== activeConnectionId) return false;
            disconnects++;
            return true;
        });
        assert.equal(await first.registerClient('client-1', { role: 'first' }, true, activeConnectionId), true);

        let delayedKick: unknown;
        second.setRemoteTransport({
            invokeClient: async () => {
                throw new Error('Unexpected direct client invoke');
            },
            fenceClient: async (nodeId, request) => {
                assert.equal(nodeId, 1);
                delayedKick = request;
                return false;
            },
            updateClientMetadata: async () => false
        });

        assert.equal(await second.registerClient('client-1', { role: 'second' }, true, 'connection-2'), false);
        assert.deepEqual(delayedKick, {
            clientId: 'client-1',
            connectionId: 'connection-1',
            reason: 'supersede',
            timeoutMs: 30_000
        });
        assert.equal((await second.clientRegistry.getClient('client-1'))?.connectionId, 'connection-1');

        assert.equal(disconnects, 0);
    });

    it('does not let partial two-phase capabilities mutate over hidden pending generations', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        for (const [clientId, state] of [
            ['hidden-register', 'pending'],
            ['hidden-reserve', 'pending']
        ] as const) {
            backend.clients.set(clientId, {
                clientId,
                nodeId: 1,
                connectionId: `${clientId}-old`,
                connectedAt: Date.now(),
                metadata: { role: 'old' },
                state,
                claimId: `${clientId}-generation`
            });
        }
        let registerMutations = 0;
        let reserveMutations = 0;
        const register = backend.register.bind(backend);
        const reserve = backend.reserve.bind(backend);
        backend.register = async (...args) => {
            registerMutations++;
            return register(...args);
        };
        backend.reserve = async (...args) => {
            reserveMutations++;
            return reserve(...args);
        };
        const service = new MeshClientService<TestMeta>({
            key: 'partial-claim-capabilities',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 2, backend);

        assert.equal(await service.registerClient('hidden-register', { role: 'replacement' }, true, 'connection-new'), false);
        assert.equal(await service.reserveClient('hidden-reserve', { role: 'replacement' }, true, 'connection-new'), false);
        assert.equal(registerMutations, 0);
        assert.equal(reserveMutations, 0);

        backend.clients.set('same-generation', {
            clientId: 'same-generation',
            nodeId: 2,
            connectionId: 'connection-same',
            connectedAt: Date.now(),
            metadata: { role: 'before' },
            state: 'pending',
            claimId: 'same-stable-generation'
        });
        assert.equal(await service.registerClient('same-generation', { role: 'after' }, true, 'connection-same'), true);
        assert.equal(registerMutations, 0);
        assert.equal(backend.clients.get('same-generation')?.state, 'active');
        assert.deepEqual(backend.clients.get('same-generation')?.metadata, { role: 'after' });
    });

    it('does not mutate when a no-capability backend cannot prove pending-inclusive absence', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        for (const name of ['claim', 'commitClaim', 'abortClaim', 'removeClaimPrevious', 'removeClaimResult', 'getClientIncludingPending']) {
            (backend as any)[name] = undefined;
        }
        for (const clientId of ['hidden-register', 'hidden-reserve']) {
            backend.clients.set(clientId, {
                clientId,
                nodeId: 1,
                connectionId: `${clientId}-old`,
                connectedAt: Date.now(),
                metadata: { role: 'hidden' },
                state: 'pending',
                claimId: `${clientId}-generation`
            });
        }
        let registerMutations = 0;
        let reserveMutations = 0;
        backend.register = async () => {
            registerMutations++;
            throw new Error('register must not be called');
        };
        backend.reserve = async () => {
            reserveMutations++;
            throw new Error('reserve must not be called');
        };
        const service = new MeshClientService<TestMeta>({
            key: 'no-claim-capabilities',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 2, backend);

        assert.equal(await service.registerClient('hidden-register', { role: 'replacement' }, true, 'connection-new'), false);
        assert.equal(await service.reserveClient('hidden-reserve', { role: 'replacement' }, true, 'connection-new'), false);
        assert.equal(registerMutations, 0);
        assert.equal(reserveMutations, 0);
    });

    it('fails closed when any claim capability is absent', async () => {
        for (const missing of [
            'claim',
            'getClientIncludingPending',
            'commitClaim',
            'abortClaim',
            'removeClaimPrevious',
            'removeClaimResult'
        ] as const) {
            const backend = new InMemoryRegistryBackend<TestMeta>();
            (backend as any)[missing] = undefined;
            let mutations = 0;
            backend.register = async () => {
                mutations++;
                throw new Error('permissive register must not be called');
            };
            backend.reserve = async () => {
                mutations++;
                throw new Error('permissive reserve must not be called');
            };
            const service = new MeshClientService<TestMeta>({
                key: `partial-exact-claim-${missing}`,
                registryBackend: backend,
                clientInvokeFn: async () => undefined
            });
            markRunning(service, 2, backend);

            assert.equal(await service.registerClient('client', { role: 'new' }, true, 'connection'), false);
            assert.equal(await service.reserveClient('pending', { role: 'new' }, true, 'connection'), false);
            assert.equal(mutations, 0);
        }
    });

    it('keeps the old owner authoritative while a fencing acknowledgement is in flight', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientService<TestMeta>({ key: 'claim-first', registryBackend: backend, clientInvokeFn: async () => undefined });
        const second = new MeshClientService<TestMeta>({ key: 'claim-second', registryBackend: backend, clientInvokeFn: async () => undefined });
        markRunning(first, 1, backend);
        markRunning(second, 2, backend);
        assert.equal(await first.registerClient('client-1', { role: 'first' }, true, 'connection-1'), true);

        let acknowledge: (() => void) | undefined;
        second.setRemoteTransport({
            invokeClient: async () => {
                throw new Error('Unexpected direct client invoke');
            },
            fenceClient: async () => {
                await new Promise<void>(resolve => {
                    acknowledge = resolve;
                });
                return true;
            },
            updateClientMetadata: async () => false
        });
        const takeover = second.registerClient('client-1', { role: 'second' }, true, 'connection-2');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal((await first.clientRegistry.getClient('client-1'))?.connectionId, 'connection-1');
        acknowledge!();
        assert.equal(await takeover, true);
        assert.equal((await second.clientRegistry.getClient('client-1'))?.connectionId, 'connection-2');
    });

    it('commits a replacement after the exact old generation closes but its kick response is lost', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientService<TestMeta>({
            key: 'lost-exact-kick-first',
            registryBackend: backend,
            clientInvokeFn: async () => {
                throw new Error('fenced old generation must not receive delivery');
            }
        });
        const second = new MeshClientService<TestMeta>({
            key: 'lost-exact-kick-second',
            registryBackend: backend,
            clientInvokeFn: async () => 'replacement'
        });
        markRunning(first, 1, backend);
        markRunning(second, 2, backend);
        assert.equal(await first.registerClient('client-1', { role: 'old' }, true, 'connection-old'), true);

        let oldOpen = true;
        let closes = 0;
        first.onClientSuperseded(async (_clientId, connectionId) => {
            if (connectionId !== 'connection-old') return false;
            if (!oldOpen) return true;
            oldOpen = false;
            closes++;
            return true;
        });
        let kickAttempts = 0;
        second.setRemoteTransport({
            invokeClient: async () => {
                throw new Error('unexpected client invoke');
            },
            fenceClient: async (_nodeId, request) => {
                assert.equal(request.connectionId, 'connection-old');
                await first.disconnectClient(request.clientId, request.connectionId, request.reason);
                kickAttempts++;
                if (kickAttempts === 1) throw new SrpcIndeterminateDeliveryError(request.clientId);
                return true;
            },
            updateClientMetadata: async () => false
        });

        assert.equal(await second.registerClient('client-1', { role: 'replacement' }, true, 'connection-new'), true);
        assert.equal(oldOpen, false);
        assert.equal(closes, 1);
        assert.equal(kickAttempts, 2);
        assert.equal((await second.clientRegistry.getClient('client-1'))?.connectionId, 'connection-new');
        assert.equal(await second.invoke('client-1', 'notify', {}), 'replacement');
    });

    it('fences and replaces an exact pending generation across pending, activated, and absent commit preimages', async () => {
        for (const outcome of ['pending', 'activated', 'absent'] as const) {
            const backend = new InMemoryRegistryBackend<TestMeta>();
            let oldInvokes = 0;
            let newInvokes = 0;
            let oldClosed = false;
            const first = new MeshClientService<TestMeta>({
                key: `pending-takeover-first-${outcome}`,
                registryBackend: backend,
                clientInvokeFn: async () => {
                    oldInvokes++;
                    return 'old';
                }
            });
            const second = new MeshClientService<TestMeta>({
                key: `pending-takeover-second-${outcome}`,
                registryBackend: backend,
                clientInvokeFn: async () => {
                    newInvokes++;
                    return 'new';
                }
            });
            markRunning(first, 1, backend);
            markRunning(second, 2, backend);
            routeMeshCalls(second, first);
            assert.equal(await first.reserveClient('client-1', { role: 'pending-old' }, true, 'connection-old'), true);
            assert.equal((await first.clientRegistry.getClientIncludingPending('client-1'))?.state, 'pending');
            first.onClientSuperseded(async (_clientId, connectionId) => {
                assert.equal(connectionId, 'connection-old');
                if (outcome === 'activated') {
                    assert.equal(await first.activateClient('client-1', { role: 'activated-old' }, 'connection-old'), true);
                } else if (outcome === 'absent') {
                    assert.equal(await first.clientRegistry.unregister('client-1', 'connection-old'), true);
                }
                oldClosed = true;
                return true;
            });

            assert.equal(await second.registerClient('client-1', { role: 'active-new' }, true, 'connection-new'), true);
            const current = await second.clientRegistry.getClientIncludingPending('client-1');
            assert.equal(oldClosed, true);
            assert.equal(current?.nodeId, 2);
            assert.equal(current?.connectionId, 'connection-new');
            assert.equal(current?.state, 'active');
            assert.equal(backend.claims.size, 0);

            routeMeshCalls(first, second);
            assert.equal(await second.invoke('client-1', 'notify', {}), 'new');
            assert.equal(await first.invoke('client-1', 'notify', {}), 'new');
            assert.equal(oldInvokes, 0);
            assert.equal(newInvokes, 2);
        }
    });

    it('never reconciles a different generation that reuses the old node and connection IDs', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientService<TestMeta>({
            key: 'same-address-reconnect-first',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        const second = new MeshClientService<TestMeta>({
            key: 'same-address-reconnect-second',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(first, 1, backend);
        markRunning(second, 2, backend);
        routeMeshCalls(second, first);
        assert.equal(await first.reserveClient('client-1', { role: 'old' }, true, 'connection-reused'), true);
        first.onClientSuperseded(() => {
            const old = backend.clients.get('client-1')!;
            backend.clients.set('client-1', {
                ...old,
                connectedAt: old.connectedAt + 1,
                metadata: { role: 'replacement' },
                state: 'active',
                claimId: 'different-stable-generation'
            });
            return true;
        });

        assert.equal(await second.registerClient('client-1', { role: 'new-owner' }, true, 'connection-new'), false);
        const retained = await second.clientRegistry.getClientIncludingPending('client-1');
        assert.equal(retained?.nodeId, 1);
        assert.equal(retained?.connectionId, 'connection-reused');
        assert.equal(retained?.claimId, 'different-stable-generation');
        assert.equal(retained?.metadata.role, 'replacement');
    });

    it('removes a fenced old generation when takeover commit fails', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const first = new MeshClientService<TestMeta>({
            key: 'claim-repair-first',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        const second = new MeshClientService<TestMeta>({
            key: 'claim-repair-second',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(first, 1, backend);
        markRunning(second, 2, backend);
        assert.equal(await first.registerClient('client-1', { role: 'first' }, true, 'connection-1'), true);
        second.setRemoteTransport({
            invokeClient: async () => {
                throw new Error('Unexpected direct client invoke');
            },
            fenceClient: async () => true,
            updateClientMetadata: async () => false
        });
        backend.commitClaim = async () => false;
        const removePrevious = backend.removeClaimPrevious.bind(backend);
        let previousCleanupCalls = 0;
        backend.removeClaimPrevious = async (...args) => {
            previousCleanupCalls++;
            if (previousCleanupCalls === 1) throw new Error('previous cleanup response unavailable');
            return removePrevious(...args);
        };

        assert.equal(await second.registerClient('client-1', { role: 'second' }, true, 'connection-2'), false);
        assert.equal(previousCleanupCalls, 2);
        assert.equal(await second.clientRegistry.getClient('client-1'), undefined);
    });

    it('retries an ambiguously created claim with the same operation identity and payload', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'claim-create-response-loss',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const claim = backend.claim.bind(backend);
        const operations: string[] = [];
        const payloads: string[] = [];
        let storedClaimId: string | undefined;
        backend.claim = async (...args: any[]) => {
            operations.push(args[7]);
            payloads.push(JSON.stringify(args.slice(0, 7)));
            const result = await (claim as (...claimArgs: any[]) => Promise<MeshClientClaim<TestMeta>>)(...args);
            if (!storedClaimId && result.status === 'ok') {
                storedClaimId = result.claimId;
                throw new Error('claim creation response lost after storage');
            }
            if (result.status === 'ok') assert.equal(result.claimId, storedClaimId);
            return result;
        };

        assert.equal(await service.reserveClient('client-1', { role: 'pending' }, true, 'connection-1'), true);
        assert.equal(operations.length, 2);
        assert.equal(operations[0], operations[1]);
        assert.equal(payloads[0], payloads[1]);
        assert.equal((await service.clientRegistry.getClientIncludingPending('client-1'))?.claimId, storedClaimId);
        assert.equal(backend.claims.size, 0);
    });

    it('reconciles a lost pending-claim commit response through the exact raw registration', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'claim-response-loss-pending',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const commit = backend.commitClaim.bind(backend);
        let loseResponse = true;
        backend.commitClaim = async (...args) => {
            const result = await commit(...args);
            if (loseResponse) {
                loseResponse = false;
                throw new Error('commit response lost');
            }
            return result;
        };

        assert.equal(await service.reserveClient('client-1', { role: 'pending' }, true, 'connection-1'), true);
        assert.equal(await service.clientRegistry.getClient('client-1'), undefined);
        assert.equal((await service.clientRegistry.getClientIncludingPending('client-1'))?.state, 'pending');
    });

    it('retries the same claim commit idempotently when the raw reconciliation read is unavailable', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        backend.getClientIncludingPending = async () => undefined;
        const service = new MeshClientService<TestMeta>({
            key: 'claim-response-loss-pending-cleanup',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const commit = backend.commitClaim.bind(backend);
        let loseResponse = true;
        backend.commitClaim = async (...args) => {
            const result = await commit(...args);
            if (loseResponse) {
                loseResponse = false;
                throw new Error('commit response lost');
            }
            return result;
        };

        assert.equal(await service.reserveClient('client-1', { role: 'pending' }, true, 'connection-1'), true);
        assert.equal(backend.clients.get('client-1')?.claimId !== undefined, true);
        assert.equal(backend.claims.has('client-1'), false);
    });

    it('retries exact claim cleanup after an initial cleanup failure before reporting non-delivery', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'claim-response-loss-cleanup-retry',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const commit = backend.commitClaim.bind(backend);
        backend.commitClaim = async (...args) => {
            await commit(...args);
            throw new Error('commit transport unavailable');
        };
        backend.getClientIncludingPending = async () => {
            throw new Error('raw read unavailable');
        };
        const remove = backend.removeClaimResult.bind(backend);
        let cleanupCalls = 0;
        backend.removeClaimResult = async (...args) => {
            cleanupCalls++;
            if (cleanupCalls === 1) throw new Error('cleanup transport unavailable');
            return remove(...args);
        };

        assert.equal(await service.reserveClient('client-1', { role: 'pending' }, true, 'connection-1'), false);
        assert.equal(cleanupCalls, 2);
        assert.equal(backend.clients.has('client-1'), false);
        assert.equal(backend.claims.has('client-1'), false);
    });

    it('fences the service and removes deliverable ownership when exact claim reconciliation stays ambiguous', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        let deliveries = 0;
        const service = new MeshClientService<TestMeta>({
            key: 'claim-response-loss-fence',
            registryBackend: backend,
            clientInvokeFn: async () => {
                deliveries++;
            }
        });
        markRunning(service, 1, backend);
        const commit = backend.commitClaim.bind(backend);
        backend.commitClaim = async (...args) => {
            await commit(...args);
            throw new Error('commit response unavailable');
        };
        backend.getClientIncludingPending = async () => {
            throw new Error('raw read unavailable');
        };
        backend.removeClaimResult = async () => {
            throw new Error('exact cleanup unavailable');
        };
        const mutable = service as any;
        const mesh = mutable.mesh;
        delete mesh.assertLeaseSafe;
        mesh.running = true;
        mesh.generation = 1;
        mesh.leaseLost = false;
        mesh.leaseSafeUntil = performance.now() + 60_000;
        mesh.leaseLossCallbackTimeoutMs = 5;
        mesh.stopImpl = async () => {
            mesh.running = false;
            mesh._instanceId = 0;
        };
        let callbackEnteredResolve!: () => void;
        const callbackEntered = new Promise<void>(resolve => {
            callbackEnteredResolve = resolve;
        });
        service.onLeaseLost(async () => {
            callbackEnteredResolve();
            await new Promise<void>(() => {});
        });

        const reservation = service.reserveClient('client-1', { role: 'pending' }, true, 'connection-1');
        const rejectedReservation = assert.rejects(reservation, AggregateError);
        await callbackEntered;
        assert.equal(mesh.running, false);
        assert.equal(mesh.leaseLost, true);
        assert.equal(deliveries, 0);
        await rejectedReservation;
        assert.equal(mutable.running, false);
        assert.equal(backend.clients.has('client-1'), false);
        assert.equal(backend.claims.has('client-1'), false);
    });

    it('retries exact unregister obligations, preserves replacements, and fences persistent ambiguity', async () => {
        const transientBackend = new InMemoryRegistryBackend<TestMeta>();
        const transient = new MeshClientService<TestMeta>({
            key: 'transient-exact-unregister',
            registryBackend: transientBackend,
            clientInvokeFn: async () => undefined
        });
        markRunning(transient, 1, transientBackend);
        assert.equal(await transient.registerClient('client-1', { role: 'old' }, true, 'connection-old'), true);
        const unregisterTransient = transientBackend.unregister.bind(transientBackend);
        let transientAttempts = 0;
        transientBackend.unregister = async (...args) => {
            transientAttempts++;
            if (transientAttempts === 1) throw new Error('transient exact unregister failure');
            return unregisterTransient(...args);
        };
        assert.equal(await transient.unregisterClient('client-1', 'connection-old'), true);
        assert.equal(transientAttempts, 2);
        assert.equal(await transient.clientRegistry.getClientIncludingPending('client-1'), undefined);

        const replacementBackend = new InMemoryRegistryBackend<TestMeta>();
        const replacementService = new MeshClientService<TestMeta>({
            key: 'replacement-exact-unregister',
            registryBackend: replacementBackend,
            clientInvokeFn: async () => undefined
        });
        markRunning(replacementService, 1, replacementBackend);
        assert.equal(await replacementService.registerClient('client-1', { role: 'old' }, true, 'connection-old'), true);
        replacementBackend.unregister = async clientId => {
            replacementBackend.clients.set(clientId, {
                clientId,
                nodeId: 1,
                connectionId: 'connection-new',
                connectedAt: Date.now() + 1,
                metadata: { role: 'replacement' },
                state: 'active',
                claimId: 'replacement-claim'
            });
            throw new Error('old unregister response unavailable after reconnect');
        };
        assert.equal(await replacementService.unregisterClient('client-1', 'connection-old'), true);
        assert.equal((await replacementService.clientRegistry.getClient('client-1'))?.connectionId, 'connection-new');

        const persistentBackend = new InMemoryRegistryBackend<TestMeta>();
        const persistent = new MeshClientService<TestMeta>({
            key: 'persistent-exact-unregister',
            registryBackend: persistentBackend,
            clientInvokeFn: async () => undefined
        });
        markRunning(persistent, 1, persistentBackend);
        assert.equal(await persistent.registerClient('client-1', { role: 'ghost' }, true, 'connection-old'), true);
        persistentBackend.unregister = async () => {
            throw new Error('persistent unregister failure');
        };
        persistentBackend.getClientIncludingPending = async () => {
            throw new Error('persistent unregister read failure');
        };
        const mutable = persistent as any;
        const mesh = mutable.mesh;
        mutable.exactUnregisterDeadlineMs = 10;
        mutable.ownershipRetryIntervalMs = 1;
        delete mesh.assertLeaseSafe;
        mesh.running = true;
        mesh.generation = 1;
        mesh.leaseLost = false;
        mesh.leaseSafeUntil = performance.now() + 60_000;
        mesh.stopImpl = async () => {
            mesh.running = false;
            mesh._instanceId = 0;
        };
        await assert.rejects(persistent.unregisterClient('client-1', 'connection-old'), AggregateError);
        assert.equal(mutable.running, false);
        assert.equal(mesh.leaseLost, true);
        assert.equal(persistentBackend.clients.has('client-1'), false);
    });

    it('repairs committed ownership and activation when the absolute mesh lease expires mid-mutation', async () => {
        const prepareLease = (service: MeshClientService<TestMeta>, backend: InMemoryRegistryBackend<TestMeta>) => {
            markRunning(service, 1, backend);
            const mutable = service as any;
            const mesh = mutable.mesh;
            // Restore MeshService's real absolute-deadline assertion after the
            // in-memory harness installed its ordinary no-op lease check.
            delete mesh.assertLeaseSafe;
            mesh.running = true;
            mesh.generation = 1;
            mesh.leaseLost = false;
            mesh.leaseSafeUntil = performance.now() + 60_000;
            mesh.fenceLeaseLoss = () => {
                mesh.running = false;
                mesh.leaseLost = true;
                mutable.running = false;
                mutable.ownershipGeneration++;
            };
            return mesh;
        };

        const commitBackend = new InMemoryRegistryBackend<TestMeta>();
        const committing = new MeshClientService<TestMeta>({
            key: 'absolute-lease-commit-repair',
            registryBackend: commitBackend,
            clientInvokeFn: async () => undefined
        });
        const commitMesh = prepareLease(committing, commitBackend);
        const commit = commitBackend.commitClaim.bind(commitBackend);
        commitBackend.commitClaim = async (...args) => {
            const committed = await commit(...args);
            commitMesh.leaseSafeUntil = performance.now() - 1;
            return committed;
        };
        assert.equal(await committing.reserveClient('commit-client', { role: 'pending' }, true, 'commit-connection'), false);
        assert.equal(commitBackend.clients.has('commit-client'), false);

        const activationBackend = new InMemoryRegistryBackend<TestMeta>();
        const activating = new MeshClientService<TestMeta>({
            key: 'absolute-lease-activation-repair',
            registryBackend: activationBackend,
            clientInvokeFn: async () => undefined
        });
        const activationMesh = prepareLease(activating, activationBackend);
        assert.equal(await activating.reserveClient('activation-client', { role: 'pending' }, true, 'activation-connection'), true);
        const activate = activationBackend.activate.bind(activationBackend);
        activationBackend.activate = async (...args) => {
            const activated = await activate(...args);
            activationMesh.leaseSafeUntil = performance.now() - 1;
            return activated;
        };
        assert.equal(await activating.activateClient('activation-client', { role: 'active' }, 'activation-connection'), false);
        assert.equal(activationBackend.clients.has('activation-client'), false);
    });

    it('repairs an activation that races ownership shutdown', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'activation-race',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        assert.equal(await service.reserveClient('client-1', { role: 'pending' }, true, 'connection-1'), true);

        const originalActivate = backend.activate.bind(backend);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => {
            release = resolve;
        });
        backend.activate = async (...args) => {
            await blocked;
            return originalActivate(...args);
        };
        const activation = service.activateClient('client-1', { role: 'active' }, 'connection-1');
        (service as any).running = false;
        (service as any).ownershipGeneration++;
        release();

        assert.equal(await activation, false);
        assert.equal(await service.clientRegistry.getClient('client-1'), undefined);
        assert.equal(backend.clients.has('client-1'), false);
    });

    it('does not apply live metadata when the registry CAS fails', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const applied: TestMeta[] = [];
        const service = new MeshClientService<TestMeta>({
            key: 'metadata-cas',
            registryBackend: backend,
            clientInvokeFn: async () => undefined,
            clientProjectMetaFn: (_clientId, metadata) => ({ updated: true, metadata: metadata as TestMeta }),
            clientApplyMetaFn: (_clientId, metadata) => {
                applied.push(metadata as TestMeta);
                return true;
            }
        });
        markRunning(service, 1, backend);
        assert.equal(await service.registerClient('client-1', { role: 'before' }, false, 'connection-1'), true);
        backend.updateMetadata = async () => false;

        assert.equal(await service.updateClientMetadata('client-1', { role: 'after' }, 'connection-1'), false);
        assert.deepEqual(applied, []);
        assert.equal((await service.clientRegistry.getClient('client-1'))?.metadata.role, 'before');
    });

    it('nacks failed durable orphan callbacks and redelivers the same snapshot', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>() as InMemoryRegistryBackend<TestMeta> & {
            claimOrphaned: () => Promise<any>;
            ackOrphaned: () => Promise<boolean>;
            nackOrphaned: () => Promise<boolean>;
        };
        const delivery = {
            id: 'delivery-1',
            nodeId: 7,
            clients: [{ clientId: 'client-1', nodeId: 7, connectedAt: 1, metadata: { role: 'orphan' } }],
            claimToken: 'claim-1'
        };
        let available = true;
        let nacks = 0;
        let acks = 0;
        backend.claimOrphaned = async () => (available ? ((available = false), delivery) : undefined);
        backend.ackOrphaned = async () => {
            acks++;
            return true;
        };
        backend.nackOrphaned = async () => {
            nacks++;
            available = true;
            return true;
        };
        (backend as any).cleanupNodeAndEnqueueOrphaned = async () => [];
        const service = new MeshClientService<TestMeta>({
            key: 'orphan-redelivery',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        let attempts = 0;
        service.onNodeClientsOrphaned(() => {
            attempts++;
            if (attempts === 1) throw new Error('temporary callback failure');
        });

        await (service as any).drainDurableOrphans();
        assert.equal(nacks, 1);
        assert.equal(acks, 0);
        await (service as any).drainDurableOrphans();
        assert.equal(attempts, 2);
        assert.equal(acks, 1);
    });

    it('contains durable orphan claim failures for the next drain attempt', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>() as InMemoryRegistryBackend<TestMeta> & {
            claimOrphaned: () => Promise<any>;
            ackOrphaned: () => Promise<boolean>;
            nackOrphaned: () => Promise<boolean>;
        };
        let claims = 0;
        backend.claimOrphaned = async () => {
            claims++;
            if (claims === 1) throw new Error('temporary claim failure');
            return undefined;
        };
        backend.ackOrphaned = async () => true;
        backend.nackOrphaned = async () => true;
        (backend as any).cleanupNodeAndEnqueueOrphaned = async () => [];
        const service = new MeshClientService<TestMeta>({
            key: 'orphan-claim-retry',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });

        await (service as any).drainDurableOrphans();
        await (service as any).drainDurableOrphans();
        assert.equal(claims, 2);
    });

    it('nacks a blocked durable callback after ownership fencing and never ACKs it', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>() as InMemoryRegistryBackend<TestMeta> & {
            claimOrphaned: () => Promise<any>;
            ackOrphaned: () => Promise<boolean>;
            nackOrphaned: () => Promise<boolean>;
        };
        let available = true;
        let acks = 0;
        let nacks = 0;
        const delivery = {
            id: 'blocked',
            nodeId: 7,
            clients: [{ clientId: 'client', nodeId: 7, connectedAt: 1, metadata: { role: 'x' } }],
            claimToken: 'token'
        };
        backend.claimOrphaned = async () => (available ? ((available = false), delivery) : undefined);
        backend.ackOrphaned = async () => (++acks, true);
        backend.nackOrphaned = async () => (++nacks, (available = true), true);
        (backend as any).cleanupNodeAndEnqueueOrphaned = async () => [];
        const service = new MeshClientService<TestMeta>({ key: 'blocked-durable', registryBackend: backend, clientInvokeFn: async () => undefined });
        markRunning(service, 1, backend);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => {
            release = resolve;
        });
        service.onNodeClientsOrphaned(async () => blocked);
        const draining = (service as any).drainDurableOrphans();
        await new Promise(resolve => setImmediate(resolve));
        (service as any).running = false;
        (service as any).ownershipGeneration++;
        release();
        await draining;
        assert.equal(acks, 0);
        assert.ok(nacks >= 1);
        assert.ok(await backend.claimOrphaned());
    });

    it('retains a blocked fallback orphan callback after ownership fencing', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({ key: 'blocked-fallback', registryBackend: backend, clientInvokeFn: async () => undefined });
        markRunning(service, 1, backend);
        const mutable = service as any;
        const fallbackClients = [{ clientId: 'client', nodeId: 9, connectedAt: 1, metadata: { role: 'x' } }];
        mutable.enqueueFallbackOrphan(9, fallbackClients);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => {
            release = resolve;
        });
        let callbacks = 0;
        service.onNodeClientsOrphaned(async () => {
            callbacks++;
            await blocked;
        });
        const delivery = mutable.deliverOrphanCallbacks(9);
        const overlapping = mutable.deliverOrphanCallbacks(9);
        assert.equal(delivery, overlapping);
        await new Promise(resolve => setImmediate(resolve));
        mutable.running = false;
        mutable.ownershipGeneration++;
        release();
        await delivery;
        assert.ok(mutable.pendingOrphanCallbacks.has(9));
        assert.equal(callbacks, 1);
        mutable.running = true;
        mutable.ownershipGeneration++;
        await mutable.deliverOrphanCallbacks(9);
        assert.equal(mutable.pendingOrphanCallbacks.has(9), false);
    });

    it('does not reset an expired absolute deadline while forwarding to an owner', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        let invokes = 0;
        const owner = new MeshClientService<TestMeta>({
            key: 'absolute-forward-owner',
            registryBackend: backend,
            clientInvokeFn: async () => {
                invokes++;
            }
        });
        const caller = new MeshClientService<TestMeta>({
            key: 'absolute-forward-caller',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(owner, 2, backend);
        markRunning(caller, 1, backend);
        assert.equal(await owner.registerClient('client', { role: 'owner' }, false, 'connection'), true);
        routeMeshCalls(caller, owner);
        caller.setRemoteTransport({
            invokeClient: async (_nodeId, request) => {
                await new Promise(resolve => setTimeout(resolve, 15));
                return owner.invoke(request.clientId, request.type, request.data, request.timeoutMs, request.connectionId);
            },
            fenceClient: async () => false,
            updateClientMetadata: async () => false
        });
        await assert.rejects(caller.invoke('client', 'message', {}, 5, 'connection'), ClientInvocationError);
        assert.equal(invokes, 0);
    });

    it('keeps registry records intact when the fallback orphan queue is full, then drains and resumes', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-cap-lossless',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        const queued = [{ clientId: 'queued', nodeId: 7, connectedAt: 1, metadata: { role: 'queued' } }];
        mutable.enqueueFallbackOrphan(7, queued);
        await backend.register('waiting', 8, { role: 'waiting' }, false, 'connection');
        const cleanupCallback = mutable.mesh.nodeCleanedUpCallback as (nodeId: number) => Promise<void>;
        await assert.rejects(cleanupCallback(8), /fallback orphan queue is full/);
        assert.ok(await backend.getClient('waiting'));

        await mutable.deliverOrphanCallbacks(7);
        await cleanupCallback(8);
        assert.equal(await backend.getClient('waiting'), undefined);
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
    });

    it('counts a non-empty fallback snapshot as one item regardless of client count', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-item-obligation',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        await backend.register('first', 8, { role: 'first' }, false, 'first');
        await backend.register('second', 8, { role: 'second' }, false, 'second');
        let delivered: RegisteredClient<TestMeta>[] = [];
        service.onNodeClientsOrphaned((_nodeId, clients) => {
            delivered = clients;
        });

        await (service as any).mesh.nodeCleanedUpCallback(8);

        assert.deepEqual(delivered.map(client => client.clientId).sort(), ['first', 'second']);
        assert.equal((await backend.listClientsForNode(8)).length, 0);
        assert.equal((service as any).pendingOrphanCallbacks.size, 0);
    });

    it('does not enqueue an empty fallback snapshot when the item cap is occupied', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-empty-obligation',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        mutable.enqueueFallbackOrphan(7, [{ clientId: 'queued', nodeId: 7, connectedAt: 1, metadata: { role: 'queued' } }]);
        await backend.reserve('pending', 8, { role: 'pending' }, false, 'pending');

        await mutable.mesh.nodeCleanedUpCallback(8);

        assert.equal(await backend.getClientIncludingPending('pending'), undefined);
        assert.equal(mutable.pendingOrphanCallbacks.size, 1);
        assert.ok(mutable.pendingOrphanCallbacks.has(7));
    });

    it('serializes concurrent fallback cleanup admission before destructive backend cleanup', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-concurrent-admission',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        await backend.register('first', 8, { role: 'first' }, false, 'first');
        await backend.register('second', 9, { role: 'second' }, false, 'second');

        const cleanupNodeForFallback = backend.cleanupNodeForFallback.bind(backend);
        let signalCleanupEntered!: () => void;
        const cleanupEntered = new Promise<void>(resolve => {
            signalCleanupEntered = resolve;
        });
        let releaseCleanup!: () => void;
        const cleanupBlocked = new Promise<void>(resolve => {
            releaseCleanup = resolve;
        });
        backend.cleanupNodeForFallback = async (nodeId, maxItems, maxBytes) => {
            if (nodeId === 8) {
                signalCleanupEntered();
                await cleanupBlocked;
            }
            return cleanupNodeForFallback(nodeId, maxItems, maxBytes);
        };

        let signalCallbackEntered!: () => void;
        const callbackEntered = new Promise<void>(resolve => {
            signalCallbackEntered = resolve;
        });
        let releaseCallback!: () => void;
        const callbackBlocked = new Promise<void>(resolve => {
            releaseCallback = resolve;
        });
        service.onNodeClientsOrphaned(async nodeId => {
            if (nodeId === 8) {
                signalCallbackEntered();
                await callbackBlocked;
            }
        });

        const cleanupCallback = mutable.mesh.nodeCleanedUpCallback as (nodeId: number) => Promise<void>;
        const firstCleanup = cleanupCallback(8);
        await cleanupEntered;
        const secondCleanup = assert.rejects(cleanupCallback(9), /fallback orphan queue is full/);
        releaseCleanup();
        await callbackEntered;
        await secondCleanup;

        assert.equal(await backend.getClient('first'), undefined);
        assert.ok(await backend.getClient('second'));
        assert.equal(mutable.pendingOrphanCallbacks.size, 1);
        assert.ok(mutable.pendingOrphanCallbacks.size <= 1);

        releaseCallback();
        await firstCleanup;
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
    });

    it('accounts immutable fallback bytes despite arbitrary callback mutation', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-immutable',
            registryBackend: backend,
            maxPendingOrphanBytes: 4_096,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        const immutable = [{ clientId: 'client', nodeId: 9, connectedAt: 1, metadata: { role: 'original' } }];
        mutable.enqueueFallbackOrphan(9, immutable);
        const admittedBytes = mutable.pendingOrphanBytes;
        let attempts = 0;
        service.onNodeClientsOrphaned((_nodeId, clients) => {
            attempts++;
            clients[0].metadata.role = 'x'.repeat(10_000);
            if (attempts === 1) throw new Error('retry');
        });
        await mutable.deliverOrphanCallbacks(9);
        assert.equal(mutable.pendingOrphanBytes, admittedBytes);
        await mutable.deliverOrphanCallbacks(9);
        assert.equal(mutable.pendingOrphanBytes, 0);
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
    });

    it('finalizes fallback delivery from actual cleanup results after a reconnect race', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-reconnect',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        await backend.register('client', 8, { role: 'preview' }, false, 'old');
        backend.cleanupNodeForFallback = async () => {
            await backend.unregister('client', 8, 'old');
            await backend.register('client', 9, { role: 'reconnected' }, false, 'new');
            return [];
        };
        let delivered = 0;
        service.onNodeClientsOrphaned((_nodeId, clients) => {
            delivered += clients.length;
        });
        await (service as any).mesh.nodeCleanedUpCallback(8);
        assert.equal(delivered, 0);
        assert.equal((await backend.getClient('client'))?.nodeId, 9);
    });

    it('uses safe local fallback unless durable cleanup and enqueue are one atomic capability', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>() as InMemoryRegistryBackend<TestMeta> & {
            claimOrphaned: () => Promise<any>;
            ackOrphaned: () => Promise<boolean>;
            nackOrphaned: () => Promise<boolean>;
            enqueueOrphaned: () => Promise<void>;
        };
        let unsafeEnqueues = 0;
        let claims = 0;
        backend.claimOrphaned = async () => {
            claims++;
            return undefined;
        };
        backend.ackOrphaned = async () => true;
        backend.nackOrphaned = async () => true;
        backend.enqueueOrphaned = async () => {
            unsafeEnqueues++;
        };
        const service = new MeshClientService<TestMeta>({ key: 'partial-durable', registryBackend: backend, clientInvokeFn: async () => undefined });
        markRunning(service, 1, backend);
        await backend.register('client', 8, { role: 'orphan' }, false, 'connection');
        let delivered = 0;
        service.onNodeClientsOrphaned((_nodeId, clients) => {
            delivered += clients.length;
        });
        await (service as any).mesh.nodeCleanedUpCallback(8);
        assert.equal(unsafeEnqueues, 0);
        assert.equal(claims, 0);
        assert.equal(delivered, 1);
    });

    it('fails closed without atomic fallback cleanup and never calls destructive permissive cleanup', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>() as any;
        backend.cleanupNodeForFallback = undefined;
        let destructiveCalls = 0;
        backend.cleanupNode = async (nodeId: number) => {
            destructiveCalls++;
            const first = [...backend.clients.values()].find((client: StoredClient<TestMeta>) => client.nodeId === nodeId);
            if (first) backend.clients.delete(first.clientId);
            throw new Error('partial cleanup failure');
        };
        const service = new MeshClientService<TestMeta>({
            key: 'permissive-fail-closed',
            registryBackend: backend,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        await backend.register('first', 8, { role: 'first' }, false, 'first');
        await backend.register('second', 8, { role: 'second' }, false, 'second');
        await assert.rejects((service as any).mesh.nodeCleanedUpCallback(8), /lacks atomic bounded fallback cleanup/);
        assert.equal(destructiveCalls, 0);
        assert.equal((await backend.listClientsForNode(8)).length, 2);
    });

    it('rejects an oversized atomic fallback candidate before deletion or cap breach', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-actual-bound',
            registryBackend: backend,
            maxPendingOrphanBytes: 300,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        mutable.enqueueFallbackOrphan(7, [{ clientId: 'small', nodeId: 7, connectedAt: 1, metadata: { role: 'small' } }]);
        const before = mutable.pendingOrphanBytes;
        await backend.register('large', 8, { role: 'x'.repeat(500) }, false, 'large');
        await assert.rejects(mutable.mesh.nodeCleanedUpCallback(8), /fallback orphan queue is full/);
        assert.ok(await backend.getClient('large'));
        assert.equal(mutable.pendingOrphanBytes, before);
        assert.ok(mutable.pendingOrphanBytes <= 300);
    });

    it('expires finalized fallback entries independently and frees their exact accounting', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-expiry',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            pendingOrphanTtlMs: 10,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        mutable.enqueueFallbackOrphan(7, [{ clientId: 'old', nodeId: 7, connectedAt: 1, metadata: { role: 'old' } }]);
        let attempts = 0;
        service.onNodeClientsOrphaned(() => {
            attempts++;
            throw new Error('permanent failure');
        });
        await mutable.deliverOrphanCallbacks(7);
        mutable.pendingOrphanCallbacks.get(7).expiresAt = Date.now() - 1;
        mutable.retryOrphanCallbacks();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
        assert.equal(mutable.pendingOrphanBytes, 0);
        assert.equal(attempts, 1);
        mutable.enqueueFallbackOrphan(8, [{ clientId: 'new', nodeId: 8, connectedAt: 1, metadata: { role: 'new' } }]);
        const newExpiry = mutable.pendingOrphanCallbacks.get(8).expiresAt;
        assert.ok(newExpiry > Date.now());
        mutable.pruneFallbackOrphans(Date.now());
        assert.ok(mutable.pendingOrphanCallbacks.has(8));
    });

    it('expires a blocked in-flight fallback delivery and preserves later queue accounting', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-in-flight-expiry',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            maxPendingOrphanBytes: 1_024,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        mutable.enqueueFallbackOrphan(7, [{ clientId: 'blocked', nodeId: 7, connectedAt: 1, metadata: { role: 'blocked' } }]);

        let signalBlockedEntered!: () => void;
        const blockedEntered = new Promise<void>(resolve => {
            signalBlockedEntered = resolve;
        });
        let releaseBlocked!: () => void;
        const blocked = new Promise<void>(resolve => {
            releaseBlocked = resolve;
        });
        let signalReplacementEntered!: () => void;
        const replacementEntered = new Promise<void>(resolve => {
            signalReplacementEntered = resolve;
        });
        let releaseReplacement!: () => void;
        const replacementBlocked = new Promise<void>(resolve => {
            releaseReplacement = resolve;
        });
        service.onNodeClientsOrphaned(async nodeId => {
            if (nodeId === 7) {
                signalBlockedEntered();
                await blocked;
            } else if (nodeId === 8) {
                signalReplacementEntered();
                await replacementBlocked;
            }
        });

        const blockedDelivery = mutable.deliverOrphanCallbacks(7);
        await blockedEntered;
        mutable.pendingOrphanCallbacks.get(7).expiresAt = Date.now() - 1;
        mutable.retryOrphanCallbacks();
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
        assert.equal(mutable.pendingOrphanBytes, 0);
        assert.ok(mutable.fallbackDeliveryInFlight.has(7));

        await backend.register('replacement', 8, { role: 'replacement' }, false, 'replacement');
        const replacementCleanup = mutable.mesh.nodeCleanedUpCallback(8);
        await replacementEntered;
        const replacement = mutable.pendingOrphanCallbacks.get(8);
        assert.ok(replacement);
        assert.equal(mutable.pendingOrphanCallbacks.size, 1);
        assert.equal(mutable.pendingOrphanBytes, replacement.bytes);

        releaseBlocked();
        await blockedDelivery;
        assert.equal(mutable.pendingOrphanCallbacks.get(8), replacement);
        assert.equal(mutable.pendingOrphanBytes, replacement.bytes);

        releaseReplacement();
        await replacementCleanup;
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
        assert.equal(mutable.pendingOrphanBytes, 0);
    });

    it('does not let an expired same-node delivery delete its replacement', async () => {
        const backend = new InMemoryRegistryBackend<TestMeta>();
        const service = new MeshClientService<TestMeta>({
            key: 'fallback-same-node-replacement',
            registryBackend: backend,
            maxPendingOrphanItems: 1,
            clientInvokeFn: async () => undefined
        });
        markRunning(service, 1, backend);
        const mutable = service as any;
        mutable.enqueueFallbackOrphan(7, [{ clientId: 'old', nodeId: 7, connectedAt: 1, metadata: { role: 'old' } }]);

        let signalOldEntered!: () => void;
        const oldEntered = new Promise<void>(resolve => {
            signalOldEntered = resolve;
        });
        let releaseOld!: () => void;
        const oldBlocked = new Promise<void>(resolve => {
            releaseOld = resolve;
        });
        const delivered: string[] = [];
        service.onNodeClientsOrphaned(async (_nodeId, clients) => {
            delivered.push(clients[0].clientId);
            if (clients[0].clientId === 'old') {
                signalOldEntered();
                await oldBlocked;
            }
        });

        const oldDelivery = mutable.deliverOrphanCallbacks(7);
        await oldEntered;
        mutable.pendingOrphanCallbacks.get(7).expiresAt = Date.now() - 1;
        mutable.retryOrphanCallbacks();
        mutable.enqueueFallbackOrphan(7, [{ clientId: 'new', nodeId: 7, connectedAt: 2, metadata: { role: 'new' } }]);
        const replacement = mutable.pendingOrphanCallbacks.get(7);
        assert.ok(replacement);

        releaseOld();
        await oldDelivery;
        assert.equal(mutable.pendingOrphanCallbacks.get(7), replacement);
        assert.equal(mutable.pendingOrphanBytes, replacement.bytes);

        await mutable.deliverOrphanCallbacks(7);
        assert.deepEqual(delivered, ['old', 'new']);
        assert.equal(mutable.pendingOrphanCallbacks.size, 0);
        assert.equal(mutable.pendingOrphanBytes, 0);
    });
});

type MutableMeshClientService<TMeta> = {
    running: boolean;
    registry: MeshClientRegistry<TMeta>;
    mesh: {
        _instanceId: number;
        getNode: (instanceId: number) => Promise<{ instanceId: number } | undefined>;
        assertLeaseSafe: () => void;
    };
};

function markRunning<TMeta>(service: MeshClientService<TMeta>, nodeId: number, backend: MeshClientRegistryBackend<TMeta>): void {
    const mutable = service as unknown as MutableMeshClientService<TMeta>;
    mutable.running = true;
    mutable.registry = new MeshClientRegistry(nodeId, backend);
    mutable.mesh._instanceId = nodeId;
    mutable.mesh.getNode = async instanceId => ({ instanceId });
    mutable.mesh.assertLeaseSafe = () => {};
}

function routeMeshCalls<TMeta>(caller: MeshClientService<TMeta>, target: MeshClientService<TMeta>): void {
    caller.setRemoteTransport({
        invokeClient: async (_nodeId, request) => {
            try {
                return await target.invoke(request.clientId, request.type, request.data, request.timeoutMs, request.connectionId);
            } catch (error) {
                if (error instanceof SrpcError || error instanceof ClientDisconnectedError || error instanceof ClientInvocationError) throw error;
                throw new ClientInvocationError(error instanceof Error ? error.message : String(error));
            }
        },
        fenceClient: async (_nodeId, request) => {
            let fenced = false;
            for (const callback of (target as any).clientSupersededCallbacks as ((
                clientId: string,
                connectionId?: string,
                reason?: string
            ) => boolean | void | Promise<boolean | void>)[]) {
                if ((await callback(request.clientId, request.connectionId, request.reason)) !== false) fenced = true;
            }
            return fenced;
        },
        updateClientMetadata: async (_nodeId, request) => target.updateClientMetadata(request.clientId, request.metadata, request.connectionId)
    });
}
