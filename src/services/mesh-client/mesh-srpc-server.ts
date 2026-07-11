import type { BaseMessage, ISrpcServerOptions, SrpcDisconnectCause, SrpcMeta, SrpcStream } from '../../srpc/types';
import type { MeshBroadcastMap, MeshBroadcastOptions, MeshServiceOptions } from '../mesh';

import { SrpcServer } from '../../srpc/SrpcServer';
import { createLogger } from '../logger';
import { MeshClientRegistry } from './mesh-client-registry';
import { MeshClientService } from './mesh-client-service';
import { ClientDisconnectedError, type MeshClientRegistryBackend, type RegisteredClient } from './types';

// --- Options ---

export interface MeshSrpcServerOptions<TMeta, TRegistryMeta = TMeta> {
    meshKey: string;
    meshOptions?: MeshServiceOptions;
    registryBackend?: MeshClientRegistryBackend<TRegistryMeta>;
    extractMetadata?: (stream: SrpcStream<TMeta>) => TRegistryMeta;
}

// --- MeshSrpcServer ---

export class MeshSrpcServer<
    TMeta extends SrpcMeta = SrpcMeta,
    TClientOutput extends BaseMessage = BaseMessage,
    TServerOutput extends BaseMessage = BaseMessage,
    TRegistryMeta = TMeta,
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    TBroadcasts extends MeshBroadcastMap = {}
> extends SrpcServer<TMeta, TClientOutput, TServerOutput> {
    private meshClientService: MeshClientService<TRegistryMeta, TBroadcasts>;
    private meshLogger = createLogger(this);
    private extractMetadataFn?: (stream: SrpcStream<TMeta>) => TRegistryMeta;

    private connectedCallbacks = new Set<(clientId: string, metadata: TRegistryMeta) => void | Promise<void>>();
    private disconnectedCallbacks = new Set<(clientId: string, metadata: TRegistryMeta) => void | Promise<void>>();
    private orphanedCallbacks = new Set<(nodeId: number, clients: RegisteredClient<TRegistryMeta>[]) => void | Promise<void>>();

    // Track metadata for connect/disconnect callbacks.
    private clientMetadata = new Map<string, TRegistryMeta>();
    private lifecycleConnectedStreams = new WeakSet<SrpcStream<TMeta>>();

    // Serialize registry mutations per client to prevent race conditions
    // without letting slow user callbacks block reconnects.
    private clientRegistryChains = new Map<string, Promise<void>>();
    private clientCallbackChains = new Map<string, Promise<void>>();

    // Microtask-debounced sync tracking
    private pendingSyncs = new Set<string>();

    constructor(options: ISrpcServerOptions<TClientOutput, TServerOutput> & MeshSrpcServerOptions<TMeta, TRegistryMeta>) {
        super(options);

        this.extractMetadataFn = options.extractMetadata;

        // Cast needed: MeshClientServiceOptions doesn't carry TBroadcasts,
        // but the broadcast generic only affects registerBroadcastHandler/broadcast
        // which are type-safe at the call site.
        this.meshClientService = new MeshClientService({
            key: options.meshKey,
            meshOptions: options.meshOptions,
            registryBackend: options.registryBackend,
            clientInvokeFn: async (clientId: string, type: string, data: unknown, timeoutMs?: number): Promise<unknown> => {
                const stream = this.streamsByClientId.get(clientId);
                if (!stream) {
                    throw new ClientDisconnectedError(clientId);
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return super.invoke(stream, type as any, data as any, timeoutMs);
            },
            clientUpdateMetaFn: (clientId: string, metadata: TRegistryMeta): boolean => {
                const stream = this.streamsByClientId.get(clientId);
                if (!stream) return false;

                // Merge registry metadata onto stream.meta.
                // The proxy traps fire scheduleSyncStreamMeta for each set,
                // but microtask debounce batches them into a single Redis update.
                const meta = stream.meta as Record<string, unknown>;
                const update = metadata as Record<string, unknown>;
                for (const key of Object.keys(update)) {
                    meta[key] = update[key];
                }
                return true;
            }
        }) as MeshClientService<TRegistryMeta, TBroadcasts>;

        // Wire up cross-pod duplicate detection: disconnect local stream when
        // the same client connects on a different node.
        this.meshClientService.onClientSuperseded(async clientId => {
            const stream = this.getCurrentStreamByClientId(clientId);
            if (stream) {
                this.meshLogger.info('Disconnecting superseded client', { clientId });
                this.cleanupStream(stream, 'supersede');
            }
        });

        // Wire up mesh node cleanup callback
        this.meshClientService.onNodeClientsOrphaned(async (nodeId, orphaned) => {
            for (const cb of this.orphanedCallbacks) {
                try {
                    await cb(nodeId, orphaned);
                } catch (err) {
                    this.meshLogger.warn('orphaned callback error', { err, nodeId });
                }
            }
        });
    }

    ////////////////////////////////////////
    // Post-establish check - reserve mesh ownership before activation

    /**
     * Defers stream activation until mesh reservation succeeds.
     * Installs meta proxy and reserves the client atomically in Redis
     * (respecting allowSupersede for v2), all serialized in the per-client
     * registry chain. Reserved clients remain hidden from lookup/invoke until
     * onStreamActivated promotes them to active.
     *
     * If registration returns a conflict, cleanupStream is called
     * (which fires onStreamDisconnected and drains the queue) so
     * no connection handlers or RPCs ever run on the rejected stream.
     */
    protected override postEstablishCheck(stream: SrpcStream<TMeta>): Promise<boolean> {
        // Install proxy before anything can mutate meta (even though
        // onStreamConnected hasn't fired yet, code may hold a reference).
        this.installMetaProxy(stream);

        const metadata = snapshotMetadata(this.extractMeta(stream));
        this.clientMetadata.set(stream.clientId, metadata);

        const allowSupersede = !(stream.protocolVersion >= 2 && !stream.supersede);

        return this.enqueueClientRegistry(stream.clientId, async () => {
            // Stream cleaned up during queue wait (disconnect / reconnect)
            if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) {
                return true;
            }

            const registered = await this.meshClientService.reserveClient(stream.clientId, metadata, allowSupersede);
            if (!registered) {
                this.meshLogger.warn('Rejecting stream due to cross-pod conflict', {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                this.cleanupStream(stream, 'conflict');
                return true;
            }

            return false;
        });
    }

    ////////////////////////////////////////
    // Lifecycle overrides - connection handlers + mesh callbacks

    private extractMeta(stream: SrpcStream<TMeta>): TRegistryMeta {
        return this.extractMetadataFn ? this.extractMetadataFn(stream) : (stream.meta as unknown as TRegistryMeta);
    }

    private static readonly PROXIED = Symbol('proxied');

    /**
     * Install a Proxy on stream.meta that schedules a microtask-debounced
     * sync to Redis whenever any property is mutated.
     *
     * This means handler code, connection handlers, and external code
     * (e.g. FreeSwitch controller) can all mutate stream.meta directly
     * and the mesh registry stays in sync - no manual sync calls needed.
     *
     * **Limitation:** Only top-level property mutations are tracked.
     * Nested mutations (e.g. `stream.meta.user.name = 'Bob'`) do NOT
     * trigger a sync. For nested metadata, either reassign the top-level
     * property (`stream.meta.user = { ...stream.meta.user, name: 'Bob' }`)
     * or call `updateClientMetadata()` explicitly.
     */
    private installMetaProxy(stream: SrpcStream<TMeta>): void {
        // Guard against double-proxy (e.g. meshStart backfill after postEstablishCheck)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((stream.meta as any)[MeshSrpcServer.PROXIED]) return;

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const clientId = stream.clientId;

        const proxied = new Proxy(stream.meta as Record<string, unknown>, {
            get(target, prop) {
                if (prop === MeshSrpcServer.PROXIED) return true;
                return target[prop as string];
            },
            set(target, prop, value) {
                target[prop as string] = value;
                self.scheduleSyncStreamMeta(clientId, stream);
                return true;
            },
            deleteProperty(target, prop) {
                delete target[prop as string];
                self.scheduleSyncStreamMeta(clientId, stream);
                return true;
            }
        });

        // Replace meta with proxied version.
        // stream is a plain object, so this is safe despite the readonly type.
        (stream as { meta: TMeta }).meta = proxied as TMeta;
    }

    /**
     * Schedule a microtask-debounced sync for a client.
     * Multiple synchronous mutations are batched into a single sync.
     */
    private scheduleSyncStreamMeta(clientId: string, stream: SrpcStream<TMeta>): void {
        if (this.pendingSyncs.has(clientId)) return;
        this.pendingSyncs.add(clientId);
        queueMicrotask(() => {
            this.pendingSyncs.delete(clientId);
            // Only sync if this stream is still current for this client.
            if (this.isCurrentStream(stream)) {
                this.syncStreamMeta(stream);
            }
        });
    }

    protected override async onStreamConnected(stream: SrpcStream<TMeta>): Promise<void> {
        // Run user-registered connection handlers after the initial ping.
        // They may mutate stream.meta; the proxy will sync those changes.
        await super.onStreamConnected(stream);
    }

    protected override async onStreamActivated(stream: SrpcStream<TMeta>): Promise<void> {
        const metadata = snapshotMetadata(this.extractMeta(stream));
        this.clientMetadata.set(stream.clientId, metadata);

        if (this.meshInstanceId !== 0) {
            const activated = await this.enqueueClientRegistry(stream.clientId, async () => {
                if (stream.lastPingAt < 0 || this.streamsByClientId.get(stream.clientId) !== stream) {
                    return false;
                }
                return this.meshClientService.activateClient(stream.clientId, metadata);
            });

            if (!activated) {
                this.meshLogger.warn('client activation missing mesh reservation', {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                this.cleanupStream(stream, 'disconnect');
                return;
            }
        }

        this.syncStreamMeta(stream);
        await this.enqueueClientCallback(stream.clientId, async () => {
            // Skip stale connection callbacks for streams that disconnected
            // or were replaced before activation finished.
            if (stream.lastPingAt < 0 || this.streamsByClientId.get(stream.clientId) !== stream) {
                return;
            }

            if (!this.clientMetadata.has(stream.clientId)) {
                this.meshLogger.warn('client metadata missing during activation', {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                return;
            }

            this.lifecycleConnectedStreams.add(stream);
            const metadata = this.clientMetadata.get(stream.clientId) as TRegistryMeta;
            for (const cb of this.connectedCallbacks) {
                try {
                    await cb(stream.clientId, metadata);
                } catch (err) {
                    this.meshLogger.warn('client connected callback error', {
                        err,
                        clientId: stream.clientId
                    });
                }
            }
        });
    }

    protected override onStreamDisconnected(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause): void {
        super.onStreamDisconnected(stream, cause);
        const publishedLifecycle = this.lifecycleConnectedStreams.has(stream);
        this.lifecycleConnectedStreams.delete(stream);

        void this.enqueueClientRegistry(stream.clientId, async () => {
            // If a replacement stream is already connected, this is a stale
            // disconnect (same-node reconnect). Skip unregister and callbacks,
            // and leave clientMetadata intact for the new stream.
            const currentStream = this.getCurrentStreamByClientId(stream.clientId);
            if (currentStream && currentStream !== stream) {
                return;
            }

            const hasMetadata = this.clientMetadata.has(stream.clientId);
            const metadata = this.clientMetadata.get(stream.clientId) as TRegistryMeta;
            const removed = await this.meshClientService.unregisterClient(stream.clientId);
            if (removed && hasMetadata && publishedLifecycle) {
                this.clientMetadata.delete(stream.clientId);
                void this.enqueueClientCallback(stream.clientId, async () => {
                    for (const cb of this.disconnectedCallbacks) {
                        try {
                            await cb(stream.clientId, metadata);
                        } catch (err) {
                            this.meshLogger.warn('client disconnected callback error', {
                                err,
                                clientId: stream.clientId
                            });
                        }
                    }
                });
            } else if (removed && publishedLifecycle) {
                this.meshLogger.warn('client metadata missing during disconnect cleanup', {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                this.clientMetadata.delete(stream.clientId);
            } else {
                this.clientMetadata.delete(stream.clientId);
            }
        });
    }

    ////////////////////////////////////////
    // Meta sync

    /**
     * Sync the current stream.meta to the mesh registry.
     * Called automatically by the meta proxy's microtask debounce.
     * Routed through enqueueClientRegistry so updates are serialized
     * after initial registration (prevents lost updates if registration
     * hasn't completed yet).
     */
    private syncStreamMeta(stream: SrpcStream<TMeta>): void {
        // Snapshot the current metadata so we compare values, not references.
        // Without this, the default path (no extractMetadataFn) returns the
        // same proxied object stored in clientMetadata, so shallowChanged
        // would always return false.
        const metadata = snapshotMetadata(this.extractMeta(stream));
        const existing = this.clientMetadata.get(stream.clientId);
        if (existing && !shallowChanged(existing, metadata)) return;

        this.clientMetadata.set(stream.clientId, metadata);
        // Write directly to the registry (always local/owning node).
        // Do NOT route through meshClientService.updateClientMetadata here -
        // that would loop back into clientUpdateMetaFn -> stream.meta -> proxy.
        void this.enqueueClientRegistry(stream.clientId, async () => {
            await this.clientRegistry.updateMetadata(stream.clientId, metadata);
        });
    }

    ////////////////////////////////////////
    // Client lifecycle serialization

    private enqueueClientRegistry<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.clientRegistryChains.get(clientId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        const safeNext = next.then(
            () => undefined,
            err => {
                this.meshLogger.warn('client registry error', { err, clientId });
            }
        );
        const chain = safeNext.finally(() => {
            // Clean up the chain entry if it's still ours
            if (this.clientRegistryChains.get(clientId) === chain) {
                this.clientRegistryChains.delete(clientId);
            }
        });
        this.clientRegistryChains.set(clientId, chain);
        return next;
    }

    private enqueueClientCallback<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.clientCallbackChains.get(clientId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        const safeNext = next.then(
            () => undefined,
            err => {
                this.meshLogger.warn('client callback error', { err, clientId });
            }
        );
        const chain = safeNext.finally(() => {
            if (this.clientCallbackChains.get(clientId) === chain) {
                this.clientCallbackChains.delete(clientId);
            }
        });
        this.clientCallbackChains.set(clientId, chain);
        return next;
    }

    ////////////////////////////////////////
    // Public API

    get meshInstanceId(): number {
        return this.meshClientService.instanceId;
    }

    get clientRegistry(): MeshClientRegistry<TRegistryMeta> {
        return this.meshClientService.clientRegistry;
    }

    /**
     * Update metadata for a client, regardless of which node owns it.
     * Routes through the mesh to the owning node so that stream.meta
     * reflects the change immediately and the proxy auto-syncs to Redis.
     * For local streams, you can also mutate stream.meta directly.
     */
    async updateClientMetadata(clientId: string, metadata: TRegistryMeta): Promise<boolean> {
        // Set clientMetadata eagerly so the proxy's deferred syncStreamMeta
        // sees shallowChanged=false and skips the redundant Redis write.
        const previous = this.clientMetadata.get(clientId);
        this.clientMetadata.set(clientId, snapshotMetadata(metadata));

        const updated = await this.meshClientService.updateClientMetadata(clientId, metadata);
        if (!updated) {
            // Restore on failure
            if (previous !== undefined) {
                this.clientMetadata.set(clientId, previous);
            } else {
                this.clientMetadata.delete(clientId);
            }
        }
        return updated;
    }

    onClientConnected(handler: (clientId: string, metadata: TRegistryMeta) => void | Promise<void>): void {
        this.connectedCallbacks.add(handler);
    }

    onClientDisconnected(handler: (clientId: string, metadata: TRegistryMeta) => void | Promise<void>): void {
        this.disconnectedCallbacks.add(handler);
    }

    onNodeClientsOrphaned(handler: (nodeId: number, clients: RegisteredClient<TRegistryMeta>[]) => void | Promise<void>): void {
        this.orphanedCallbacks.add(handler);
    }

    registerBroadcastHandler<K extends keyof TBroadcasts & string>(
        type: K,
        handler: (data: TBroadcasts[K], senderInstanceId: number) => void | Promise<void>
    ): void {
        this.meshClientService.registerBroadcastHandler(type, handler);
    }

    async broadcast<K extends keyof TBroadcasts & string>(type: K, data: TBroadcasts[K], options?: MeshBroadcastOptions): Promise<void> {
        return this.meshClientService.broadcast(type, data, options);
    }

    /**
     * Invoke a client method across any node in the mesh.
     * Overloaded: when called with a stream, delegates to SrpcServer.invoke.
     * When called with a clientId string, routes through the mesh.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override invoke(streamOrClientId: SrpcStream<TMeta> | string, prefix: any, data: any, timeoutMs?: number): Promise<any> {
        if (typeof streamOrClientId === 'string') {
            return this.meshClientService.invoke(streamOrClientId, prefix, data, timeoutMs);
        }
        return super.invoke(streamOrClientId, prefix, data, timeoutMs);
    }

    async meshStart(): Promise<void> {
        await this.meshClientService.start();

        // Backfill clients that connected before mesh tracking was running.
        // Route through enqueueClientRegistry so backfill registrations are
        // serialized with any concurrent disconnect for the same clientId.
        const backfillStreams = new Map<string, SrpcStream<TMeta>>();
        for (const [clientId, stream] of this.pendingStreamsByClientId) {
            backfillStreams.set(clientId, stream);
        }
        for (const [clientId, stream] of this.streamsByClientId) {
            if (!backfillStreams.has(clientId)) {
                backfillStreams.set(clientId, stream);
            }
        }

        const backfillPromises: Promise<void>[] = [];
        for (const [clientId, stream] of backfillStreams) {
            // Install proxy if not already proxied (streams that connected before meshStart)
            this.installMetaProxy(stream);

            if (!this.clientMetadata.has(clientId)) {
                const metadata = snapshotMetadata(this.extractMeta(stream));
                this.clientMetadata.set(clientId, metadata);
            }
            const metadata = this.clientMetadata.get(clientId)!;
            const allowSupersede = !(stream.protocolVersion >= 2 && !stream.supersede);
            void this.enqueueClientRegistry(clientId, async () => {
                // Only backfill the current stream (active or pending).
                const currentStream = this.getCurrentStreamByClientId(clientId);
                if (currentStream !== stream) return;

                const registered = stream.isActivated
                    ? await this.meshClientService.registerClient(clientId, metadata, allowSupersede)
                    : await this.meshClientService.reserveClient(clientId, metadata, allowSupersede);
                if (!registered) {
                    this.meshLogger.warn('Backfill rejected: cross-pod conflict', { clientId });
                    this.cleanupStream(stream, 'conflict');
                }
            });
            const chain = this.clientRegistryChains.get(clientId);
            if (chain) backfillPromises.push(chain);
        }
        await Promise.all(backfillPromises);
    }

    async meshStop(): Promise<void> {
        await this.meshClientService.stop();
        this.clientMetadata.clear();
    }
}

////////////////////////////////////////
// Helpers

function snapshotMetadata<T>(meta: T): T {
    if (Array.isArray(meta)) return [...meta] as T;
    if (!isPlainObject(meta)) return meta;
    return { ...meta };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function shallowChanged(a: unknown, b: unknown): boolean {
    if (a === b) return false;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a !== b;
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
        if (aObj[key] !== bObj[key]) return true;
    }
    return false;
}
