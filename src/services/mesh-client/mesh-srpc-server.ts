import type { BaseMessage, ISrpcServerOptions, SrpcConnection, SrpcDisconnectCause, SrpcMeta, SrpcStream } from '../../srpc/types';
import type { MeshBroadcastMap, MeshBroadcastOptions, MeshServiceOptions } from '../mesh';

import { getCurrentApp, onServerBootstrap, onServerShutdownRequested } from '../../app';
import { assertSafeTimerMs, uuid7 } from '../../helpers';
import { SrpcByteStream } from '../../srpc/SrpcByteStream';
import { SrpcError, SrpcOwnerUnavailableError, SrpcStaleConnectionError } from '../../srpc/types';
import { SrpcServer } from '../../srpc/SrpcServer';
import { createLogger } from '../logger';
import { acquireMeshLinkRuntime, getMeshLinkProcessId, resolveMeshLinkAdvertiseUrl, type MeshLinkRuntime } from '../mesh-link';
import { MeshClientRegistry } from './mesh-client-registry';
import type { MeshClientRedisRegistryOptions } from './mesh-client-redis-registry';
import { MeshClientService } from './mesh-client-service';
import { MeshRemoteSrpcConnection } from './mesh-srpc-remote-connection';
import { MeshLinkCapabilityError, MeshSrpcLinkController, type MeshLocalInvokeResult } from './mesh-srpc-link-controller';
import { ClientDisconnectedError, ClientInvocationError, type MeshClientRegistryBackend, type RegisteredClient } from './types';

// --- Options ---

export interface MeshSrpcServerOptions<TMeta, TRegistryMeta = TMeta> {
    meshKey: string;
    meshOptions?: MeshServiceOptions;
    registryBackend?: MeshClientRegistryBackend<TRegistryMeta>;
    /** Limits for the built-in Redis registry. Ignored with registryBackend. */
    registryOptions?: MeshClientRedisRegistryOptions;
    extractMetadata?: (stream: SrpcStream<TMeta>) => TRegistryMeta;
    meshLink?: {
        advertiseUrl?: string;
        path?: string;
        secret?: string;
        connectTimeoutMs?: number;
        requestTimeoutMs?: number;
        idleTimeoutMs?: number;
        maxFrameBytes?: number;
        maxBufferedBytes?: number;
        maxEndpointPins?: number;
    };
}

// --- MeshSrpcServer ---

export class MeshSrpcServer<
    TMeta extends SrpcMeta = SrpcMeta,
    TClientOutput extends BaseMessage = BaseMessage,
    TServerOutput extends BaseMessage = BaseMessage,
    TRegistryMeta = TMeta,
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    TBroadcasts extends MeshBroadcastMap = {}
> extends SrpcServer<TMeta, TClientOutput, TServerOutput, TRegistryMeta> {
    private meshClientService: MeshClientService<TRegistryMeta, TBroadcasts>;
    private meshLogger = createLogger(this);
    private extractMetadataFn?: (stream: SrpcStream<TMeta>) => TRegistryMeta;
    private readonly meshKey: string;
    private readonly meshLinkOptions: MeshSrpcServerOptions<TMeta, TRegistryMeta>['meshLink'];
    private meshLinkRuntime?: MeshLinkRuntime;
    private meshLinkController?: MeshSrpcLinkController<TMeta, TRegistryMeta>;
    private unregisterMeshLinkRoute?: () => void;
    private meshStartPromise?: Promise<void>;
    private meshStopPromise?: Promise<void>;
    private meshRunning = false;
    private meshStopping = false;
    private meshClosed = false;
    private meshLinkRequestTimeoutMs = 30_000;
    private readonly unregisterLifecycleHandlers: (() => void)[] = [];
    private readonly announcedSenderIds = new Map<string, Set<number>>();
    private readonly pendingMeshInvocationRequestIds = new Set<string>();
    private readonly failedMeshInvocationTombstones = new Map<string, number>();
    private failedMeshInvocationOverflowUntil = 0;

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
        this.meshKey = options.meshKey;
        this.meshLinkOptions = options.meshLink;

        // Cast needed: MeshClientServiceOptions doesn't carry TBroadcasts,
        // but the broadcast generic only affects registerBroadcastHandler/broadcast
        // which are type-safe at the call site.
        this.meshClientService = new MeshClientService({
            key: options.meshKey,
            meshOptions: options.meshOptions,
            registryBackend: options.registryBackend,
            registryOptions: {
                ...options.registryOptions,
                maxClientIdBytes: options.registryOptions?.maxClientIdBytes ?? options.maxClientIdBytes,
                maxMetadataBytes: options.registryOptions?.maxMetadataBytes ?? options.maxClientMetadataBytes,
                maxAuthReplayPrincipals: options.registryOptions?.maxAuthReplayPrincipals ?? options.maxAuthReplayPrincipals
            },
            clientInvokeFn: async (clientId: string, type: string, data: unknown, timeoutMs?: number, connectionId?: string): Promise<unknown> => {
                const stream = this.streamsByClientId.get(clientId);
                if (!stream || (connectionId !== undefined && stream.id !== connectionId)) {
                    throw new ClientDisconnectedError(clientId);
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return super.invoke(stream, type as any, data as any, timeoutMs);
            },
            clientProjectMetaFn: (clientId: string, metadata: unknown, connectionId?: string) => {
                const stream = this.streamsByClientId.get(clientId);
                if (!stream || (connectionId !== undefined && stream.id !== connectionId)) {
                    return { updated: false, metadata: undefined as TRegistryMeta };
                }
                return {
                    updated: true,
                    metadata: this.projectMetadataWithoutMutation(stream, metadata as Partial<TMeta>)
                };
            },
            clientApplyMetaFn: (clientId: string, metadata: unknown, connectionId?: string) => {
                const stream = this.streamsByClientId.get(clientId);
                if (!stream || (connectionId !== undefined && stream.id !== connectionId)) return false;
                const projected = this.applyMetadataToLocalStream(stream, metadata as Partial<TMeta>);
                this.clientMetadata.set(clientId, snapshotMetadata(projected));
                return true;
            }
        }) as MeshClientService<TRegistryMeta, TBroadcasts>;
        const authNonceConsumer = this.meshClientService.getAuthNonceConsumer();
        if (authNonceConsumer) this.setAuthNonceConsumer(authNonceConsumer);

        // Wire up cross-pod duplicate detection: disconnect local stream when
        // the same client connects on a different node.
        this.meshClientService.onClientSuperseded(async (clientId, connectionId, reason) => {
            const stream = connectionId === undefined ? this.getCurrentStreamByClientId(clientId) : this.streamsById.get(connectionId);
            // Exact-generation absence is already a completed fence. This is
            // important for same-node supersession: core closes the old stream
            // synchronously before the replacement's private registry claim.
            if (!stream) return connectionId !== undefined;
            if (stream.clientId !== clientId || (connectionId !== undefined && stream.id !== connectionId)) return false;
            if (connectionId !== undefined) {
                this.meshLogger.info('Disconnecting client through exact mesh transport', { clientId, connectionId });
                await super.disconnectClient(stream, reason);
                return true;
            }
            this.meshLogger.info('Disconnecting superseded client', { clientId });
            this.cleanupStream(stream, 'supersede');
            return true;
        });

        // A lost mesh lease is a split-brain boundary.  Do not wait for the
        // normal shutdown path: synchronously fence every local stream so a
        // stale link cannot keep serving after another node takes ownership.
        this.meshClientService.onLeaseLost(async reason => {
            this.meshLogger.warn('Fencing local sRPC streams after mesh lease loss', { reason });
            const streams = new Set<SrpcStream<TMeta>>([
                ...(this.streamsByClientId?.values() ?? []),
                ...(this.pendingStreamsByClientId?.values() ?? [])
            ]);
            for (const stream of streams) {
                if (this.isCurrentStream(stream)) this.cleanupStream(stream, 'disconnect');
            }
            await this.meshLinkController?.close();
        });

        // Wire up mesh node cleanup callback
        this.meshClientService.onNodeClientsOrphaned(async (nodeId, orphaned) => {
            const failures: unknown[] = [];
            for (const cb of this.orphanedCallbacks) {
                try {
                    await cb(nodeId, orphaned);
                } catch (err) {
                    this.meshLogger.warn('orphaned callback error', { err, nodeId });
                    failures.push(err);
                }
            }
            if (failures.length > 0) {
                throw new AggregateError(failures, `Failed to deliver orphaned clients for mesh node ${nodeId}`);
            }
        });

        try {
            const app = getCurrentApp();
            this.unregisterLifecycleHandlers.push(
                app.on(onServerBootstrap, () => this.meshStart()),
                app.on(onServerShutdownRequested, () => this.meshStop())
            );
        } catch {
            // Standalone servers using an explicit httpServer retain the
            // idempotent meshStart()/meshStop() lifecycle.
        }
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

        const allowSupersede = stream.supersede;

        return this.enqueueClientRegistry(stream.clientId, async () => {
            // Stream cleaned up during queue wait (disconnect / reconnect)
            if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) {
                return true;
            }

            const registered = await this.meshClientService.reserveClient(stream.clientId, metadata, allowSupersede, stream.id);
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

    protected override async onStreamWillActivate(stream: SrpcStream<TMeta>): Promise<void> {
        const metadata = snapshotMetadata(this.extractMeta(stream));

        if (this.meshInstanceId !== 0) {
            const activated = await this.enqueueClientRegistry(stream.clientId, async () => {
                if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) {
                    return false;
                }
                return this.meshClientService.activateClient(stream.clientId, metadata, stream.id);
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

        // The registry now has an exact active CAS before user connection
        // handlers or public local activation can observe this stream.
        this.clientMetadata.set(stream.clientId, metadata);
    }

    protected override async onStreamActivated(stream: SrpcStream<TMeta>): Promise<void> {
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
            // Sender routes belong to this fenced connection, even when a
            // replacement stream for the same client is already current.
            this.meshLinkController?.invalidateConnection(stream.clientId, stream.id);
            // Always CAS-unregister the exact old generation. A replacement
            // reservation can fail after core closes this stream; skipping the
            // CAS would then leave the dead generation registered forever.
            // Only lifecycle callbacks and shared metadata cleanup are stale
            // when a replacement exists.
            const hasMetadata = this.clientMetadata.has(stream.clientId);
            const metadata = this.clientMetadata.get(stream.clientId) as TRegistryMeta;
            const removed = await this.meshClientService.unregisterClient(stream.clientId, stream.id);
            // A replacement may become current while the exact Redis CAS is in
            // flight. Re-read before touching shared metadata or callbacks.
            const currentStream = this.getCurrentStreamByClientId(stream.clientId);
            const replacementExists = currentStream !== undefined && currentStream !== stream;
            if (replacementExists) return;
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

        // Write directly to the registry (always local/owning node).
        // Do NOT route through meshClientService.updateClientMetadata here -
        // that would loop back into clientUpdateMetaFn -> stream.meta -> proxy.
        void this.enqueueClientRegistry(stream.clientId, async () => {
            const updated = await this.clientRegistry.updateMetadata(stream.clientId, metadata, stream.id);
            if (!updated) {
                throw new SrpcStaleConnectionError(stream.clientId);
            }
            if (!this.isCurrentStream(stream)) return;
            this.clientMetadata.set(stream.clientId, metadata);
        }).catch(error => {
            if (!this.isCurrentStream(stream) || stream.lastPingAt < 0) return;
            this.meshLogger.warn('client metadata remains dirty; scheduling retry', {
                error,
                clientId: stream.clientId
            });
            setTimeout(
                () => {
                    if (this.isCurrentStream(stream) && stream.lastPingAt >= 0) this.syncStreamMeta(stream);
                },
                Math.min(1_000, this.meshLinkRequestTimeoutMs)
            ).unref?.();
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

    get startupState(): 'stopped' | 'starting' | 'ready' | 'draining' {
        if (this.meshStopping || this.meshStopPromise) return 'draining';
        if (this.meshStartPromise) return 'starting';
        return this.meshRunning ? 'ready' : 'stopped';
    }

    ready(): Promise<void> {
        return this.meshStart();
    }

    /**
     * Update metadata for a client, regardless of which node owns it.
     * Routes through the mesh to the owning node so that stream.meta
     * reflects the change immediately and the proxy auto-syncs to Redis.
     * For local streams, you can also mutate stream.meta directly.
     */
    override async updateClientMetadata(
        connectionOrClientId: SrpcConnection<TMeta | TRegistryMeta> | string,
        metadata: Partial<TMeta>
    ): Promise<boolean> {
        const clientId = typeof connectionOrClientId === 'string' ? connectionOrClientId : connectionOrClientId.clientId;
        let connection: SrpcConnection<TMeta | TRegistryMeta> | undefined;
        if (typeof connectionOrClientId === 'string') {
            if (!this.meshLinkController) return this.meshClientService.updateClientMetadata(clientId, metadata as TRegistryMeta);
            connection = await this.resolveClient(clientId);
            if (!connection) return false;
        } else {
            connection = connectionOrClientId;
        }
        if (connection instanceof MeshRemoteSrpcConnection) {
            if (!this.meshLinkController) throw new SrpcStaleConnectionError(clientId);
            // Capability errors are raised before a direct write is attempted.
            // Accepted and indeterminate direct writes are never replayed.
            const projected = await this.meshLinkController.updateMetadata(connection, metadata);
            connection.applyMetadata(projected);
            return true;
        }
        if (this.streamsByClientId.get(clientId) !== connection) throw new SrpcStaleConnectionError(clientId);

        const localConnection = connection as SrpcStream<TMeta>;
        // Claim registry ownership before changing the live stream. A stale
        // local handle must not produce a provisional meta side effect.
        const projected = this.projectMetadataWithoutMutation(localConnection, metadata);
        const updated = await this.clientRegistry.updateMetadata(clientId, projected, localConnection.id);
        if (!updated) {
            throw new SrpcStaleConnectionError(clientId);
        }
        await this.assertCurrentMeshStream(localConnection);
        this.applyMetadataToLocalStream(localConnection, metadata);
        this.clientMetadata.set(clientId, snapshotMetadata(projected));
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

    override async resolveClient(clientId: string, deadlineAt?: number): Promise<SrpcConnection<TMeta | TRegistryMeta> | undefined> {
        // A running mesh link owns the generation fence.  Returning the local
        // map first can expose a stream that the registry has already
        // superseded on another node.
        if (this.meshLinkController) return this.meshLinkController.resolveClient(clientId, deadlineAt);
        return this.streamsByClientId.get(clientId);
    }

    override async listClients(): Promise<SrpcConnection<TMeta | TRegistryMeta>[]> {
        if (!this.meshLinkController) return super.listClients();
        return this.meshLinkController.listClients();
    }

    override async disconnectClient(connectionOrClientId: SrpcConnection<TMeta | TRegistryMeta> | string, reason?: string): Promise<boolean> {
        const connection = typeof connectionOrClientId === 'string' ? await this.resolveClient(connectionOrClientId) : connectionOrClientId;
        if (!connection) return false;
        if (connection instanceof MeshRemoteSrpcConnection) {
            await connection.close(reason);
            return true;
        }
        if (!('lastPingAt' in connection)) throw new SrpcStaleConnectionError(connection.clientId);
        return super.disconnectClient(connection as SrpcStream<TMeta>, reason);
    }

    /**
     * Invoke a client method across any node in the mesh.
     * Overloaded: when called with a stream, delegates to SrpcServer.invoke.
     * When called with a clientId string, routes through the mesh.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override async invoke(
        connectionOrClientId: SrpcConnection<TMeta | TRegistryMeta> | string,
        prefix: any,
        data: any,
        timeoutMs = 30_000
    ): Promise<any> {
        assertSafeTimerMs(timeoutMs, 'Mesh sRPC invocation timeout');
        const deadlineAt = Date.now() + timeoutMs;
        const remaining = (): number => {
            const value = deadlineAt - Date.now();
            if (value <= 0)
                throw new ClientInvocationError(
                    `Client invocation timed out: ${typeof connectionOrClientId === 'string' ? connectionOrClientId : connectionOrClientId.clientId}`
                );
            return value;
        };
        let connection: SrpcConnection<TMeta | TRegistryMeta> | undefined;
        connection = typeof connectionOrClientId === 'string' ? await this.resolveClient(connectionOrClientId, deadlineAt) : connectionOrClientId;
        if (!connection) {
            throw new ClientDisconnectedError(typeof connectionOrClientId === 'string' ? connectionOrClientId : connectionOrClientId.clientId);
        }
        if (!(connection instanceof MeshRemoteSrpcConnection)) {
            return super.invoke(connection as SrpcStream<TMeta>, prefix, data, remaining());
        }
        if (!this.meshLinkController) throw new ClientDisconnectedError(connection.clientId);
        try {
            const response = await this.meshLinkController.invoke(
                connection,
                prefix,
                this.encodeMeshInvokeRequest(prefix, data),
                remaining(),
                deadlineAt
            );
            const decoded = this.decodeMeshInvokeResponse(prefix, response);
            if (decoded == null) throw new Error('Invalid response from remote sRPC client');
            return decoded;
        } catch (error) {
            if (error instanceof Error && error.name === 'SrpcError')
                throw new SrpcError(error.message, 'isUserError' in error && typeof error.isUserError === 'boolean' ? error.isUserError : undefined);
            throw error;
        }
    }

    async meshStart(): Promise<void> {
        if (this.meshClosed) throw new Error('sRPC mesh server is closed');
        if (this.meshStopPromise) {
            await this.meshStopPromise;
            return this.meshStart();
        }
        if (this.meshRunning) return;
        if (this.meshStartPromise) return this.meshStartPromise;
        const start = (async () => {
            try {
                await this.startMesh();
            } catch (error) {
                await this.rollbackMeshStart();
                throw error;
            }
        })();
        this.meshStartPromise = start;
        try {
            await start;
        } finally {
            if (this.meshStartPromise === start) this.meshStartPromise = undefined;
        }
    }

    private async startMesh(): Promise<void> {
        const linkConfig = this.resolveMeshLinkConfig();
        if (linkConfig) {
            this.meshLinkRequestTimeoutMs = linkConfig.requestTimeoutMs;
            const advertiseUrl = resolveMeshLinkAdvertiseUrl({
                advertiseUrl: linkConfig.advertiseUrl,
                path: linkConfig.path,
                httpServer: this.options.httpServer
            });
            this.meshLinkRuntime = acquireMeshLinkRuntime(linkConfig);
            this.meshLinkController = this.createMeshLinkController(this.meshLinkRuntime);
            this.meshClientService.setRemoteTransport(this.meshLinkController);
            this.unregisterMeshLinkRoute = this.meshLinkRuntime.register(this.meshKey, (peer, frame) => this.meshLinkController!.route(peer, frame));
            await this.meshClientService.mesh.updateNodeMetadata({
                processId: getMeshLinkProcessId(),
                linkEndpointId: this.meshLinkRuntime.id,
                linkEndpointPublicKey: this.meshLinkRuntime.publicKey,
                linkUrl: advertiseUrl,
                startedAt: Date.now()
            });
        }

        await this.meshClientService.start();
        this.meshRunning = true;

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
            const allowSupersede = stream.supersede;
            const backfill = this.enqueueClientRegistry(clientId, async () => {
                // Only backfill the current stream (active or pending).
                const currentStream = this.getCurrentStreamByClientId(clientId);
                if (currentStream !== stream) return;

                const registered = stream.isActivated
                    ? await this.meshClientService.registerClient(clientId, metadata, allowSupersede, stream.id)
                    : await this.meshClientService.reserveClient(clientId, metadata, allowSupersede, stream.id);
                if (!registered) {
                    this.meshLogger.warn('Backfill rejected: cross-pod conflict', { clientId });
                    this.cleanupStream(stream, 'conflict');
                    throw new Error(`Failed to backfill mesh ownership for client ${clientId}`);
                }
            });
            backfillPromises.push(backfill.then(() => undefined));
        }
        await Promise.all(backfillPromises);
    }

    async meshStop(): Promise<void> {
        if (this.meshStopPromise) return this.meshStopPromise;
        const stop = this.stopMesh();
        this.meshStopPromise = stop;
        try {
            await stop;
        } finally {
            if (this.meshStopPromise === stop) this.meshStopPromise = undefined;
        }
    }

    private async stopMesh(): Promise<void> {
        if (this.meshStartPromise) {
            try {
                await this.meshStartPromise;
            } catch {
                return;
            }
        }
        if (!this.meshRunning) return;
        this.meshRunning = false;
        this.meshStopping = true;
        try {
            // Fence local delivery first. This queues exact unregister work
            // while the mesh service is still available to persist it.
            const streams = new Set<SrpcStream<TMeta>>([
                ...(this.streamsByClientId?.values() ?? []),
                ...(this.pendingStreamsByClientId?.values() ?? [])
            ]);
            for (const stream of streams) {
                if (this.isCurrentStream(stream)) this.cleanupStream(stream, 'disconnect');
            }
            await Promise.allSettled([...(this.clientRegistryChains?.values() ?? [])]);
            await Promise.allSettled([...(this.clientCallbackChains?.values() ?? [])]);
            await this.meshLinkController?.close();
            this.meshClientService.setRemoteTransport(undefined);
            this.unregisterMeshLinkRoute?.();
            this.unregisterMeshLinkRoute = undefined;
            await this.meshClientService.stop();
            this.meshLinkController = undefined;
            this.meshLinkRuntime = undefined;
            this.clientMetadata.clear();
        } finally {
            this.meshStopping = false;
        }
    }

    private async rollbackMeshStart(): Promise<void> {
        this.meshRunning = false;
        await this.meshLinkController?.close();
        this.meshClientService.setRemoteTransport(undefined);
        this.unregisterMeshLinkRoute?.();
        this.unregisterMeshLinkRoute = undefined;
        this.meshLinkController = undefined;
        if (this.meshClientService.instanceId !== 0) await this.meshClientService.stop();
        this.meshLinkRuntime = undefined;
        this.clientMetadata.clear();
    }

    override close(): void {
        this.meshClosed = true;
        for (const unregister of this.unregisterLifecycleHandlers.splice(0)) unregister();
        void this.meshStop().catch(error => this.meshLogger.warn('sRPC mesh shutdown failed', { error }));
        super.close();
    }

    protected override handleByteSubstreamOperation(
        stream: SrpcStream<TMeta>,
        operation: NonNullable<TClientOutput['byteStreamOperation']>,
        requestId?: string
    ): void {
        const invocationKey = requestId ? meshInvocationKey(stream.id, requestId) : undefined;
        this.pruneFailedMeshInvocationTombstones();
        const pendingInvocation = invocationKey !== undefined && this.pendingMeshInvocationRequestIds.has(invocationKey);
        if (
            invocationKey &&
            (this.failedMeshInvocationTombstones.has(invocationKey) || (!pendingInvocation && this.failedMeshInvocationOverflowUntil > Date.now())) &&
            operation.write?.chunk.byteLength === 0 &&
            isAnnouncedClientSenderId(operation.streamId)
        ) {
            this.destroyFailedMeshInvocationSender(stream, operation.streamId);
            return;
        }
        if (invocationKey && pendingInvocation && operation.write?.chunk.byteLength === 0) {
            const ids = this.announcedSenderIds.get(invocationKey) ?? new Set<number>();
            if (isAnnouncedClientSenderId(operation.streamId) && !ids.has(operation.streamId)) {
                if (ids.size >= 128) {
                    this.destroyFailedMeshInvocationSender(stream, operation.streamId);
                    return;
                }
                ids.add(operation.streamId);
            }
            this.announcedSenderIds.set(invocationKey, ids);
        }
        if (operation.destroy && this.meshLinkController?.forwardClientDestroy(stream.id, operation.streamId, operation.destroy.error)) {
            return;
        }
        super.handleByteSubstreamOperation(stream, operation, requestId);
    }

    private rememberFailedMeshInvocation(invocationKey: string): void {
        this.pruneFailedMeshInvocationTombstones();
        const expiresAt = Date.now() + 60_000;
        if (!this.failedMeshInvocationTombstones.has(invocationKey) && this.failedMeshInvocationTombstones.size >= 4_096) {
            // Keep every still-live exact fence. While saturated, a single
            // bounded overflow fence rejects late announcements for any
            // invocation that is no longer actively pending.
            this.failedMeshInvocationOverflowUntil = Math.max(this.failedMeshInvocationOverflowUntil, expiresAt);
            return;
        }
        this.failedMeshInvocationTombstones.set(invocationKey, expiresAt);
    }

    private pruneFailedMeshInvocationTombstones(now = Date.now()): void {
        for (const [key, expiresAt] of this.failedMeshInvocationTombstones) {
            if (expiresAt > now) continue;
            this.failedMeshInvocationTombstones.delete(key);
        }
        if (this.failedMeshInvocationOverflowUntil <= now) this.failedMeshInvocationOverflowUntil = 0;
    }

    private destroyFailedMeshInvocationSender(stream: SrpcStream<TMeta>, streamId: number): void {
        try {
            void this.writeByteStreamOperation(stream, {
                streamId,
                destroy: { error: 'sRPC mesh invocation failed before sender handoff' }
            }).catch(() => {});
        } catch {}
    }

    protected override hasExternalByteStreamSender(stream: SrpcStream<TMeta>, streamId: number): boolean {
        return this.meshLinkController?.hasSenderRoute(stream.id, streamId) === true;
    }

    private createMeshLinkController(runtime: MeshLinkRuntime): MeshSrpcLinkController<TMeta, TRegistryMeta> {
        const getLocal = (clientId: string, connectionId?: string): SrpcStream<TMeta> => {
            const stream = this.streamsByClientId.get(clientId);
            if (!stream || (connectionId && stream.id !== connectionId)) throw new ClientDisconnectedError(clientId);
            return stream;
        };
        const getFenceLocal = (clientId: string, connectionId: string): SrpcStream<TMeta> => {
            const stream = this.streamsById.get(connectionId);
            if (!stream || stream.clientId !== clientId) throw new ClientDisconnectedError(clientId);
            return stream;
        };
        return new MeshSrpcLinkController({
            meshKey: this.meshKey,
            requestTimeoutMs: this.meshLinkRequestTimeoutMs,
            runtime,
            service: this.meshClientService,
            getLocalConnection: clientId => this.streamsByClientId.get(clientId),
            hasLocalFenceConnection: (clientId, connectionId) => {
                const stream = this.streamsById.get(connectionId);
                return stream?.clientId === clientId;
            },
            invokeLocal: async (clientId, connectionId, prefix, encoded, timeoutMs) => {
                const stream = getLocal(clientId, connectionId);
                const data = this.decodeMeshInvokeRequest(prefix, encoded);
                const requestId = uuid7();
                const invocationKey = meshInvocationKey(stream.id, requestId);
                this.pendingMeshInvocationRequestIds.add(invocationKey);
                try {
                    const response = await this.invokeMeshClientWithRequestId(stream, prefix, data, timeoutMs, requestId);
                    const issuedSenderIds = [...(this.announcedSenderIds.get(invocationKey) ?? [])];
                    await this.assertCurrentMeshStream(stream);
                    return {
                        body: this.encodeMeshInvokeResponse(prefix, response),
                        issuedSenderIds,
                        requiresExactSenderGrant: stream.features?.has('sender-announcements') === true
                    } satisfies MeshLocalInvokeResult;
                } catch (error) {
                    this.rememberFailedMeshInvocation(invocationKey);
                    for (const streamId of this.announcedSenderIds.get(invocationKey) ?? []) {
                        this.destroyFailedMeshInvocationSender(stream, streamId);
                    }
                    throw error;
                } finally {
                    this.pendingMeshInvocationRequestIds.delete(invocationKey);
                    this.announcedSenderIds.delete(invocationKey);
                }
            },
            serviceInvokeLocal: async (clientId, connectionId, type, data, timeoutMs) => {
                const stream = getLocal(clientId, connectionId);
                return super.invoke(stream, type as never, data as never, timeoutMs);
            },
            reserveLocalSenderIds: (clientId, connectionId, count) => this.reserveByteStreamSenderIds(getLocal(clientId, connectionId), count),
            writeLocalStream: (clientId, connectionId, streamId, data) =>
                this.writeByteStreamOperation(getLocal(clientId, connectionId), {
                    streamId,
                    write: { chunk: new Uint8Array(data) }
                }),
            finishLocalStream: (clientId, connectionId, streamId) =>
                this.writeByteStreamOperation(getLocal(clientId, connectionId), { streamId, finish: {} }),
            destroyLocalStream: (clientId, connectionId, streamId, error) =>
                this.writeByteStreamOperation(getLocal(clientId, connectionId), { streamId, destroy: { error } }),
            attachLocalReceiver: (clientId, connectionId, streamId) => SrpcByteStream.createReceiver(getLocal(clientId, connectionId), streamId),
            disconnectLocal: async (clientId, connectionId, reason) => {
                const stream = getFenceLocal(clientId, connectionId);
                await super.disconnectClient(stream, reason);
                return true;
            },
            updateLocalMetadata: async (clientId, connectionId, metadata) => {
                const stream = getLocal(clientId, connectionId);
                const projected = this.projectMetadataWithoutMutation(stream, metadata);
                if (!(await this.clientRegistry.updateMetadata(clientId, projected, connectionId))) {
                    throw new SrpcStaleConnectionError(clientId);
                }
                await this.assertCurrentMeshStream(stream);
                this.applyMetadataToLocalStream(stream, metadata);
                this.clientMetadata.set(clientId, snapshotMetadata(projected));
                return projected;
            }
        });
    }

    /** @internal Isolates the core invoke boundary for focused failure-path verification. */
    private invokeMeshClientWithRequestId(
        stream: SrpcStream<TMeta>,
        prefix: string,
        data: unknown,
        timeoutMs: number,
        requestId: string
    ): Promise<unknown> {
        return super.invokeWithRequestId(stream, prefix as never, data as never, timeoutMs, requestId);
    }

    private applyMetadataToLocalStream(stream: SrpcStream<TMeta>, metadata: Partial<TMeta>): TRegistryMeta {
        if (metadata && typeof metadata === 'object') Object.assign(stream.meta as object, metadata);
        return snapshotMetadata(this.extractMeta(stream));
    }

    /**
     * A successful exact registry CAS does not prove that the generation is
     * still current: an owner fence can commit a replacement while Redis I/O
     * is in flight. Call this immediately before a local side effect or a
     * successful response that represents local delivery.
     */
    private async assertCurrentMeshStream(stream: SrpcStream<TMeta>): Promise<void> {
        const current = await this.clientRegistry.getClient(stream.clientId);
        if (
            !this.isCurrentStream(stream) ||
            !stream.connected ||
            !current ||
            current.nodeId !== this.meshClientService.instanceId ||
            current.connectionId !== stream.id
        ) {
            throw new SrpcStaleConnectionError(stream.clientId);
        }
    }

    private projectMetadataWithoutMutation(stream: SrpcStream<TMeta>, metadata: Partial<TMeta>): TRegistryMeta {
        const merged = { ...(stream.meta as object), ...(metadata as object) } as TMeta;
        if (!this.extractMetadataFn) return snapshotMetadata(merged as unknown as TRegistryMeta);
        // Run the caller's projection against a shallow stream clone with a
        // merged meta clone. No observable live stream property is touched,
        // including when the projection is a primitive.
        const clone = Object.assign(Object.create(Object.getPrototypeOf(stream)), stream, { meta: merged }) as SrpcStream<TMeta>;
        return snapshotMetadata(this.extractMetadataFn(clone));
    }

    private resolveMeshLinkConfig() {
        let config;
        try {
            config = getCurrentApp().config;
        } catch {
            config = undefined;
        }
        const secret = this.meshLinkOptions?.secret ?? config?.MESH_LINK_SECRET;
        if (!secret) return undefined;
        const path = this.meshLinkOptions?.path ?? config?.MESH_LINK_PATH ?? '/_tsf/mesh';
        if (path === this.options.wsPath) throw new Error('sRPC client and mesh-link WebSocket paths must be different');
        const requestTimeoutMs = this.meshLinkOptions?.requestTimeoutMs ?? config?.MESH_LINK_REQUEST_TIMEOUT_MS ?? 30_000;
        assertSafeTimerMs(requestTimeoutMs, 'sRPC mesh-link request timeout');
        return {
            advertiseUrl: this.meshLinkOptions?.advertiseUrl ?? config?.MESH_LINK_ADVERTISE_URL,
            path,
            secret,
            httpServer: this.options.httpServer,
            connectTimeoutMs: this.meshLinkOptions?.connectTimeoutMs ?? config?.MESH_LINK_CONNECT_TIMEOUT_MS ?? 5_000,
            requestTimeoutMs,
            idleTimeoutMs: this.meshLinkOptions?.idleTimeoutMs ?? config?.MESH_LINK_IDLE_TIMEOUT_MS ?? 60_000,
            maxFrameBytes: this.meshLinkOptions?.maxFrameBytes ?? config?.MESH_LINK_MAX_FRAME_BYTES ?? 8 * 1024 * 1024,
            maxBufferedBytes: this.meshLinkOptions?.maxBufferedBytes ?? config?.MESH_LINK_MAX_BUFFERED_BYTES ?? 16 * 1024 * 1024,
            maxEndpointPins: this.meshLinkOptions?.maxEndpointPins
        };
    }
}

////////////////////////////////////////
// Helpers

function meshInvocationKey(streamId: string, requestId: string): string {
    return `${streamId}:${requestId}`;
}

function isAnnouncedClientSenderId(streamId: number): boolean {
    return Number.isSafeInteger(streamId) && streamId > 0 && streamId <= 0x7fffffff && streamId % 2 === 1;
}

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
