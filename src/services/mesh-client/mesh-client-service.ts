import { createLogger } from '../logger';
import { MeshService, type MeshBroadcastMap, type MeshBroadcastOptions, type MeshServiceOptions } from '../mesh';
import { MeshClientRedisRegistry } from './mesh-client-redis-registry';
import { MeshClientRegistry } from './mesh-client-registry';
import { ClientDisconnectedError, ClientInvocationError, ClientNotFoundError, type MeshClientRegistryBackend, type RegisteredClient } from './types';

// --- Internal Mesh Message Types ---

type ForwardRequest = { clientId: string; type: string; data: unknown; timeoutMs?: number };
type ForwardResponse = { data?: unknown; error?: string; errorName?: string };

type KickClientRequest = { clientId: string };
type KickClientResponse = { kicked: boolean };

type UpdateMetaRequest = { clientId: string; metadata: unknown };
type UpdateMetaResponse = { updated: boolean };

type ForwardMessages = {
    forward: { request: ForwardRequest; response: ForwardResponse };
    kickClient: { request: KickClientRequest; response: KickClientResponse };
    updateMeta: { request: UpdateMetaRequest; response: UpdateMetaResponse };
};

// --- Options ---

export interface MeshClientServiceOptions<TMeta> {
    key: string;
    meshOptions?: MeshServiceOptions;
    registryBackend?: MeshClientRegistryBackend<TMeta>;
    clientInvokeFn: (clientId: string, type: string, data: unknown, timeoutMs?: number) => Promise<unknown>;
    clientUpdateMetaFn?: (clientId: string, metadata: TMeta) => boolean;
}

// --- MeshClientService ---

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class MeshClientService<TMeta, TBroadcasts extends MeshBroadcastMap = {}> {
    // Exposed for MeshSrpcServer to access internals
    /** @internal */
    readonly mesh: MeshService<ForwardMessages, TBroadcasts>;
    private logger = createLogger(this);
    private registry: MeshClientRegistry<TMeta>;
    private backend: MeshClientRegistryBackend<TMeta>;
    private clientInvokeFn: MeshClientServiceOptions<TMeta>['clientInvokeFn'];
    private clientUpdateMetaFn: MeshClientServiceOptions<TMeta>['clientUpdateMetaFn'];
    private nodeCleanedUpCallbacks: ((nodeId: number, orphaned: RegisteredClient<TMeta>[]) => void | Promise<void>)[] = [];
    private clientSupersededCallbacks: ((clientId: string) => void | Promise<void>)[] = [];

    constructor(options: MeshClientServiceOptions<TMeta>) {
        this.backend = options.registryBackend ?? new MeshClientRedisRegistry<TMeta>(`_mc:${options.key}`);
        this.clientInvokeFn = options.clientInvokeFn;
        this.clientUpdateMetaFn = options.clientUpdateMetaFn;

        this.mesh = new MeshService<ForwardMessages, TBroadcasts>(`_mc:${options.key}`, options.meshOptions);
        this.mesh.registerHandler('forward', async (req: ForwardRequest): Promise<ForwardResponse> => {
            try {
                const result = await this.clientInvokeFn(req.clientId, req.type, req.data, req.timeoutMs);
                return { data: result };
            } catch (err) {
                return {
                    error: err instanceof Error ? err.message : String(err),
                    errorName: err instanceof Error ? err.name : undefined
                };
            }
        });

        this.mesh.registerHandler('kickClient', async (req: KickClientRequest): Promise<KickClientResponse> => {
            let kicked = false;
            for (const cb of this.clientSupersededCallbacks) {
                try {
                    await cb(req.clientId);
                    kicked = true;
                } catch (err) {
                    this.logger.warn('client superseded callback error', { err, clientId: req.clientId });
                }
            }
            return { kicked };
        });

        this.mesh.registerHandler('updateMeta', async (req: UpdateMetaRequest): Promise<UpdateMetaResponse> => {
            const metadata = req.metadata as TMeta;
            if (this.clientUpdateMetaFn && !this.clientUpdateMetaFn(req.clientId, metadata)) return { updated: false };
            return { updated: await this.registry.updateMetadata(req.clientId, metadata) };
        });

        this.mesh.setNodeCleanedUpCallback(async (nodeId: number) => {
            const orphaned = await this.backend.cleanupNode(nodeId);
            if (orphaned.length > 0) {
                for (const cb of this.nodeCleanedUpCallbacks) {
                    try {
                        await cb(nodeId, orphaned);
                    } catch (err) {
                        this.logger.warn('node cleanup callback error', { err, nodeId });
                    }
                }
            }
        });

        // Placeholder registry - will be re-created in start() with the real instanceId
        this.registry = new MeshClientRegistry<TMeta>(0, this.backend);
    }

    onNodeClientsOrphaned(cb: (nodeId: number, orphaned: RegisteredClient<TMeta>[]) => void | Promise<void>): void {
        this.nodeCleanedUpCallbacks.push(cb);
    }

    onClientSuperseded(cb: (clientId: string) => void | Promise<void>): void {
        this.clientSupersededCallbacks.push(cb);
    }

    get instanceId(): number {
        return this.mesh.instanceId;
    }

    get clientRegistry(): MeshClientRegistry<TMeta> {
        return this.registry;
    }

    private running = false;

    async start(): Promise<void> {
        await this.mesh.start();
        this.registry = new MeshClientRegistry<TMeta>(this.mesh.instanceId, this.backend);
        this.running = true;
    }

    async stop(): Promise<void> {
        this.running = false;
        try {
            // Clean up our own clients
            if (this.mesh.instanceId !== 0) {
                await this.registry.cleanupNode();
            }
        } finally {
            await this.mesh.stop();
        }
    }

    /**
     * Register a client on this node. Returns true if registered, false if
     * another node owns the client and `allowSupersede` is false (conflict).
     */
    async registerClient(clientId: string, metadata: TMeta, allowSupersede = true): Promise<boolean> {
        if (!this.running) return true;
        const result = await this.registry.register(clientId, metadata, allowSupersede);
        if (result.status === 'conflict') {
            return false;
        }
        if (result.supersededNodeId !== null) {
            this.mesh.invoke(result.supersededNodeId, 'kickClient', { clientId }).catch(err => {
                this.logger.warn('failed to kick superseded client', {
                    err,
                    clientId,
                    supersededNodeId: result.supersededNodeId
                });
            });
        }
        return true;
    }

    /**
     * Reserve ownership of a clientId without exposing it for lookup/invoke
     * until activation completes.
     */
    async reserveClient(clientId: string, metadata: TMeta, allowSupersede = true): Promise<boolean> {
        if (!this.running) return true;
        const result = await this.registry.reserve(clientId, metadata, allowSupersede);
        if (result.status === 'conflict') {
            return false;
        }
        if (result.supersededNodeId !== null) {
            this.mesh.invoke(result.supersededNodeId, 'kickClient', { clientId }).catch(err => {
                this.logger.warn('failed to kick superseded client', {
                    err,
                    clientId,
                    supersededNodeId: result.supersededNodeId
                });
            });
        }
        return true;
    }

    /**
     * Promote a same-node reservation to an active, discoverable client.
     */
    async activateClient(clientId: string, metadata: TMeta): Promise<boolean> {
        if (!this.running) return false;
        return this.registry.activate(clientId, metadata);
    }

    async unregisterClient(clientId: string): Promise<boolean> {
        if (!this.running) return false;
        return this.registry.unregister(clientId);
    }

    async updateClientMetadata(clientId: string, metadata: TMeta): Promise<boolean> {
        if (!this.running) return false;

        const client = await this.registry.getClient(clientId);
        if (!client) return false;

        // Local - apply to stream.meta and update registry directly.
        if (client.nodeId === this.mesh.instanceId) {
            if (this.clientUpdateMetaFn && !this.clientUpdateMetaFn(clientId, metadata)) return false;
            return this.registry.updateMetadata(clientId, metadata);
        }

        // Remote - route through mesh to the owning node
        try {
            const response = await this.mesh.invoke(client.nodeId, 'updateMeta', { clientId, metadata });
            return response.updated;
        } catch (err) {
            this.logger.warn('cross-pod metadata update failed', {
                err,
                clientId,
                targetNodeId: client.nodeId
            });
            return false;
        }
    }

    registerBroadcastHandler<K extends keyof TBroadcasts & string>(
        type: K,
        handler: (data: TBroadcasts[K], senderInstanceId: number) => void | Promise<void>
    ): void {
        this.mesh.registerBroadcastHandler(type, handler);
    }

    async broadcast<K extends keyof TBroadcasts & string>(type: K, data: TBroadcasts[K], options?: MeshBroadcastOptions): Promise<void> {
        return this.mesh.broadcast(type, data, options);
    }

    async invoke(clientId: string, type: string, data: unknown, timeoutMs?: number): Promise<unknown> {
        if (!this.running) {
            throw new ClientNotFoundError(clientId);
        }

        const client = await this.registry.getClient(clientId);
        if (!client) {
            throw new ClientNotFoundError(clientId);
        }

        // Local delivery
        if (client.nodeId === this.mesh.instanceId) {
            return this.clientInvokeFn(clientId, type, data, timeoutMs);
        }

        // Remote delivery via mesh
        const response = await this.mesh.invoke(client.nodeId, 'forward', { clientId, type, data, timeoutMs }, timeoutMs);

        if (response.error !== undefined) {
            if (response.errorName === 'ClientDisconnectedError') {
                throw new ClientDisconnectedError(clientId);
            }
            throw new ClientInvocationError(response.error);
        }

        return response.data;
    }
}
