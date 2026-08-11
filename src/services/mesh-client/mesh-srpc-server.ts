import type {
    BaseMessage,
    InvokePrefixes,
    ISrpcServerOptions,
    RequestData,
    ResponseData,
    SrpcConnection,
    SrpcDisconnectCause,
    SrpcMeta,
    SrpcStream
} from '../../srpc/types';
import type { Server } from 'node:http';
import type { MeshBroadcastMap, MeshBroadcastOptions, MeshServiceOptions } from '../mesh';

import { getCurrentApp, onServerBootstrap, onServerShutdownRequested } from '../../app';
import { assertSafeTimerMs, toError, uuid7 } from '../../helpers';
import { SrpcByteStream } from '../../srpc/SrpcByteStream';
import { SrpcError, SrpcOwnerUnavailableError, SrpcStaleConnectionError } from '../../srpc/types';
import { SrpcServer } from '../../srpc/SrpcServer';
import { createLogger } from '../logger';
import { acquireMeshLinkRuntime, getMeshLinkProcessId, resolveMeshLinkAdvertiseUrl, type MeshLinkRuntime } from '../mesh-link';
import { MeshClientRegistry } from './mesh-client-registry';
import type { MeshClientRedisRegistryOptions } from './mesh-client-redis-registry';
import { MeshClientService } from './mesh-client-service';
import type { MeshSrpcConnection } from './srpc-registry-metadata';
import { MeshRemoteSrpcConnection } from './mesh-srpc-remote-connection';
import { MeshLinkCapabilityError, MeshSrpcLinkController, type MeshLocalInvokeResult } from './mesh-srpc-link-controller';
import { ClientDisconnectedError, ClientInvocationError, type MeshClientRegistryBackend, type RegisteredClient } from './types';

// --- Options ---

export interface MeshSrpcServerOptions<TMeta, TRegistryMeta = TMeta> {
    meshKey: string;
    meshOptions?: MeshServiceOptions;
    /**
     * Register meshStart()/meshStop() with the current App lifecycle.
     * Defaults to true. Disable this when the application needs bounded or
     * custom mesh startup/shutdown handling.
     */
    autoLifecycle?: boolean;
    registryBackend?: MeshClientRegistryBackend<TRegistryMeta>;
    /** Limits for the built-in Redis registry. Ignored with registryBackend. */
    registryOptions?: MeshClientRedisRegistryOptions;
    extractRegistryMetadata?: (stream: SrpcStream<TMeta>) => TRegistryMeta;
    meshLink?: {
        advertiseUrl?: string;
        path?: string;
        secret?: string;
        /**
         * Explicit mesh-link listener. When omitted, mesh upgrades use the
         * running application HTTP listener, independent of the sRPC client
         * listener. Before an application listener exists, TSF preserves the
         * legacy fallback to the sRPC server's supplied httpServer.
         */
        httpServer?: Server;
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
    private extractRegistryMetadataFn?: (stream: SrpcStream<TMeta>) => TRegistryMeta;
    private readonly meshKey: string;
    private readonly meshLinkOptions: MeshSrpcServerOptions<TMeta, TRegistryMeta>['meshLink'];
    private meshLinkRuntime?: MeshLinkRuntime;
    private meshLinkController?: MeshSrpcLinkController<TMeta, TRegistryMeta>;
    private unregisterMeshLinkRoute?: () => void;
    private meshStartPromise?: Promise<void>;
    private meshStopPromise?: Promise<void>;
    private meshFatalCleanupPromise?: Promise<void>;
    private meshLeaseCleanupPromise?: Promise<void>;
    private meshLeaseCleanupRequired = false;
    private meshLeaseCleanupRetryTimer?: ReturnType<typeof setTimeout>;
    private meshLeaseCleanupRetryMs = 1_000;
    /** Retry a fresh, fenced mesh generation after Redis becomes available again. */
    private meshRecoveryTimer?: ReturnType<typeof setTimeout>;
    private meshRecoveryPromise?: Promise<void>;
    private meshRecoveryGeneration = 0;
    private meshRecoveryAttempt = 0;
    private meshRecoveryEnabled = true;
    /** @internal Overridable by focused recovery tests. */
    private meshRecoveryRetryMs = 1_000;
    /** @internal Overridable by focused recovery tests. */
    private meshRecoveryMaxRetryMs = 30_000;
    /**
     * A start that shutdown abandoned. New starts wait for its eventual
     * rollback so a late mesh start cannot overlap a replacement lifecycle.
     */
    private meshPendingStartCleanup?: Promise<void>;
    /** A detached controller close from a cancelled, not-yet-ready start. */
    private meshPendingLinkClose?: Promise<void>;
    private meshCleanupFailure?: Error;
    private meshStartGeneration = 0;
    private meshStartCancelled = false;
    private meshStartRollbackFailure?: Error;
    private meshRunning = false;
    private meshLeaseFailure?: Error;
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

    // Track registry metadata for connect/disconnect callbacks.
    private clientRegistryMetadata = new Map<string, TRegistryMeta>();
    private lifecycleConnectedStreams = new WeakSet<SrpcStream<TMeta>>();
    /**
     * Lifecycle disconnects captured before a cancelled startup fully fences
     * mesh membership. Their callbacks cannot run until rollback has released
     * the abandoned membership, otherwise consumers can observe a false
     * offline transition while ownership is still indeterminate.
     */
    private pendingStartDisconnects = new Map<
        SrpcStream<TMeta>,
        { clientId: string; connectionId: string; nodeId: number; metadata: TRegistryMeta }
    >();
    private pendingStartDisconnectFenceDeadlines = new Map<SrpcStream<TMeta>, number>();
    private pendingStartDisconnectCallbackQueued = new WeakSet<SrpcStream<TMeta>>();
    private rollbackGatedDisconnects = new WeakSet<SrpcStream<TMeta>>();
    private meshSupersedeReconcileMs = 30_000;
    private meshSupersedeReconcileRetryMs = 10;

    // Serialize registry mutations per client to prevent race conditions
    // without letting slow user callbacks block reconnects.
    private clientRegistryChains = new Map<string, Promise<void>>();
    private clientCallbackChains = new Map<string, Promise<void>>();

    // Microtask-debounced sync tracking
    private pendingSyncs = new Set<string>();

    constructor(options: ISrpcServerOptions<TClientOutput, TServerOutput> & MeshSrpcServerOptions<TMeta, TRegistryMeta>) {
        super(options);

        this.extractRegistryMetadataFn = options.extractRegistryMetadata;
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
                this.clientRegistryMetadata.set(clientId, snapshotMetadata(projected));
                return true;
            }
        }) as MeshClientService<TRegistryMeta, TBroadcasts>;
        const authNonceConsumer = this.meshClientService.getAuthNonceConsumer();
        if (authNonceConsumer) this.setAuthNonceConsumer(authNonceConsumer);

        // Wire up cross-pod duplicate detection: disconnect local stream when
        // the same client connects on a different node.
        this.meshClientService.onClientSuperseded((clientId, connectionId, reason) => this.handleClientSuperseded(clientId, connectionId, reason));

        // A lost mesh lease is a split-brain boundary.  Do not wait for the
        // normal shutdown path: synchronously fence every local stream so a
        // stale link cannot keep serving after another node takes ownership.
        this.meshClientService.onLeaseLost(reason => this.beginMeshLeaseCleanup(reason));

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

        if (options.autoLifecycle !== false) {
            try {
                const app = getCurrentApp();
                this.unregisterLifecycleHandlers.push(
                    app.on(onServerBootstrap, () => this.meshStart()),
                    app.on(onServerShutdownRequested, () => this.meshStop())
                );
            } catch {
                // Standalone servers using an explicit mesh-link listener retain the
                // idempotent meshStart()/meshStop() lifecycle.
            }
        }
    }

    ////////////////////////////////////////
    // Post-establish check - reserve mesh ownership before activation

    /** Fence the exact local generation when a newer owner claims the client. */
    private async handleClientSuperseded(clientId: string, connectionId: string | undefined, reason?: string): Promise<boolean> {
        const isTakeoverFence = connectionId !== undefined && reason === 'supersede';
        if (isTakeoverFence) this.markPendingStartDisconnectFence(clientId, connectionId);
        const stream = connectionId === undefined ? this.getCurrentStreamByClientId(clientId) : this.streamsById.get(connectionId);
        // Exact-generation absence is already a completed fence. This is
        // important for same-node supersession: core closes the old stream
        // synchronously before the replacement's private registry claim.
        if (!stream) return connectionId !== undefined;
        if (stream.clientId !== clientId || (connectionId !== undefined && stream.id !== connectionId)) return false;
        if (connectionId !== undefined) {
            if (isTakeoverFence) {
                this.captureDeferredDisconnect(stream);
                this.markPendingStartDisconnectFence(clientId, connectionId);
            }
            const snapshot = this.pendingStartDisconnects.get(stream);
            const deadline = this.pendingStartDisconnectFenceDeadlines.get(stream);
            // Reserve this client's lifecycle ordering before cleanup lets a
            // same-node replacement enqueue its connected callback. Startup
            // shutdown snapshots instead wait for rollback to dispatch.
            if (isTakeoverFence && !this.rollbackGatedDisconnects?.has(stream) && snapshot && deadline !== undefined)
                this.queuePendingStartDisconnectCallback(stream, snapshot, deadline);
            this.meshLogger.info('Disconnecting client through exact mesh transport', { clientId, connectionId, reason });
            // This is a replacement ownership generation, not an ordinary
            // client disconnect. Preserve the supersede cause so local
            // lifecycle consumers do not emit disconnect side effects for
            // a client that remains connected on another mesh node.
            this.cleanupStream(stream, isTakeoverFence ? 'supersede' : 'disconnect');
            return true;
        }
        this.meshLogger.info('Disconnecting superseded client', { clientId, reason });
        this.cleanupStream(stream, reason === 'supersede' ? 'supersede' : 'disconnect');
        return true;
    }

    /** Fence streams and release the link route after the mesh lease is lost. */
    private beginMeshLeaseCleanup(reason?: Error): Promise<void> {
        if (this.meshLeaseCleanupPromise) return this.meshLeaseCleanupPromise;
        this.meshLeaseCleanupRequired = true;
        this.clearMeshLeaseCleanupRetry();

        // Install the join barrier before synchronous stream teardown begins.
        // A disconnect handler may re-enter meshStop() from cleanupStream().
        let resolveCleanup!: () => void;
        let rejectCleanup!: (error: unknown) => void;
        const tracked = new Promise<void>((resolve, reject) => {
            resolveCleanup = resolve;
            rejectCleanup = reject;
        });
        this.meshLeaseCleanupPromise = tracked;

        let cleanup: Promise<void>;
        try {
            cleanup = this.handleMeshLeaseLost(reason);
        } catch (error) {
            cleanup = Promise.reject(error);
        }
        void cleanup.then(resolveCleanup, rejectCleanup);
        void tracked.then(
            () => {
                this.meshLeaseCleanupRequired = false;
                if (this.meshLeaseCleanupPromise === tracked) this.meshLeaseCleanupPromise = undefined;
                this.scheduleMeshRecovery();
            },
            error => {
                if (this.meshLeaseCleanupPromise === tracked) this.meshLeaseCleanupPromise = undefined;
                this.meshLogger.warn('mesh lease-loss cleanup failed; retained for retry', { error });
                this.scheduleMeshLeaseCleanupRetry();
            }
        );
        return tracked;
    }

    private scheduleMeshLeaseCleanupRetry(): void {
        if (!this.meshLeaseCleanupRequired || this.meshLeaseCleanupRetryTimer || this.meshClosed) return;
        this.meshLeaseCleanupRetryTimer = setTimeout(() => {
            this.meshLeaseCleanupRetryTimer = undefined;
            void this.beginMeshLeaseCleanup().catch(() => {});
        }, this.meshLeaseCleanupRetryMs);
        this.meshLeaseCleanupRetryTimer.unref?.();
    }

    private clearMeshLeaseCleanupRetry(): void {
        if (!this.meshLeaseCleanupRetryTimer) return;
        clearTimeout(this.meshLeaseCleanupRetryTimer);
        this.meshLeaseCleanupRetryTimer = undefined;
    }

    /**
     * Lease loss is a hard split-brain boundary, but not a permanent process
     * failure. Once the exact old ownership is removed, start a new mesh
     * generation. Existing streams were already fenced and must reconnect.
     */
    private scheduleMeshRecovery(): void {
        const generation = this.meshRecoveryGeneration;
        if (!this.canRecoverMesh(generation) || this.meshRunning || this.meshRecoveryTimer || this.meshRecoveryPromise) return;

        const delay = Math.min(this.meshRecoveryRetryMs * 2 ** this.meshRecoveryAttempt, this.meshRecoveryMaxRetryMs);
        this.meshRecoveryTimer = setTimeout(() => {
            this.meshRecoveryTimer = undefined;
            if (!this.canRecoverMesh(generation) || this.meshRunning) return;

            const recovery = this.attemptMeshRecovery(generation);
            const tracked = recovery.then(() => undefined);
            this.meshRecoveryPromise = tracked;
            void recovery.then(
                () => {
                    if (this.meshRecoveryPromise !== tracked) return;
                    this.meshRecoveryPromise = undefined;
                    this.scheduleMeshRecovery();
                },
                error => {
                    if (this.meshRecoveryPromise !== tracked) return;
                    this.meshRecoveryPromise = undefined;
                    if (!this.canRecoverMesh(generation)) return;
                    this.meshLeaseFailure = toError(error);
                    this.meshRecoveryAttempt++;
                    this.meshLogger.warn('sRPC mesh recovery attempt failed; will retry', {
                        error: this.meshLeaseFailure,
                        attempt: this.meshRecoveryAttempt
                    });
                    this.scheduleMeshRecovery();
                }
            );
        }, delay);
        this.meshRecoveryTimer.unref?.();
    }

    private async attemptMeshRecovery(generation: number): Promise<boolean> {
        if (!this.canRecoverMesh(generation)) return true;

        // meshStart deliberately rejects a lease-fenced instance. The cleanup
        // barrier above has removed its exact old ownership, so this is now a
        // safe new generation rather than a resurrection of the old one.
        this.meshLeaseFailure = undefined;
        try {
            const start = this.startMeshLifecycle(false);
            await start;
        } catch (error) {
            if (!this.canRecoverMesh(generation)) return true;
            this.meshLeaseFailure = toError(error);
            this.meshRecoveryAttempt++;
            this.meshLogger.warn('sRPC mesh recovery attempt failed; will retry', {
                error: this.meshLeaseFailure,
                attempt: this.meshRecoveryAttempt
            });
            return false;
        }

        if (!this.canRecoverMesh(generation)) return true;
        this.meshRecoveryAttempt = 0;
        this.meshLogger.info('sRPC mesh recovered after lease loss');
        return true;
    }

    private canRecoverMesh(generation: number): boolean {
        return (
            generation === this.meshRecoveryGeneration &&
            this.meshRecoveryEnabled &&
            !this.meshClosed &&
            !this.meshStopping &&
            !this.meshCleanupFailure &&
            !this.meshLeaseCleanupRequired
        );
    }

    private cancelMeshRecovery(disable = false): void {
        if (disable) this.meshRecoveryEnabled = false;
        this.meshRecoveryGeneration++;
        this.meshRecoveryAttempt = 0;
        if (!this.meshRecoveryTimer) return;
        clearTimeout(this.meshRecoveryTimer);
        this.meshRecoveryTimer = undefined;
    }

    private async handleMeshLeaseLost(reason?: Error): Promise<void> {
        this.cancelMeshRecovery();
        this.meshLogger.warn('Fencing local sRPC streams after mesh lease loss', { reason });
        this.meshRunning = false;
        this.meshLeaseFailure ??= reason ?? new Error('sRPC mesh lease was lost');
        this.capturePendingStartDisconnects();
        const streams = new Set<SrpcStream<TMeta>>([...(this.streamsByClientId?.values() ?? []), ...(this.pendingStreamsByClientId?.values() ?? [])]);
        for (const stream of streams) {
            if (this.isCurrentStream(stream)) this.cleanupStream(stream, 'disconnect');
        }

        // meshStop() deliberately returns once meshRunning is false, so lease
        // loss must release the route here. Otherwise the shared runtime keeps
        // dispatching this mesh key to a closed controller forever.
        try {
            await Promise.allSettled([...(this.clientRegistryChains?.values() ?? [])]);
            await this.meshClientService.cleanupRegistryOwnership();
            await this.dispatchPendingStartDisconnects();
        } finally {
            await this.releaseMeshLinkResources(false);
        }
    }

    /**
     * A mesh client is never admitted until this process can reserve its
     * ownership in the shared registry. This centralizes the readiness gate
     * rather than requiring each application authorizer to remember it.
     */
    protected override beforeClientAdmission(): Promise<void> {
        return this.ready();
    }

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

        const registryMetadata = snapshotMetadata(this.extractRegistryMetadata(stream));
        this.clientRegistryMetadata.set(stream.clientId, registryMetadata);

        const allowSupersede = stream.supersede;

        return this.enqueueClientRegistry(stream.clientId, async () => {
            // Stream cleaned up during queue wait (disconnect / reconnect)
            if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) {
                return true;
            }

            const registered = await this.meshClientService.reserveClient(stream.clientId, registryMetadata, allowSupersede, stream.id);
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

    private extractRegistryMetadata(stream: SrpcStream<TMeta>): TRegistryMeta {
        return this.extractRegistryMetadataFn ? this.extractRegistryMetadataFn(stream) : (stream.meta as unknown as TRegistryMeta);
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
        const registryMetadata = snapshotMetadata(this.extractRegistryMetadata(stream));

        if (this.meshClientService.isRunning && this.meshStartPromise) await this.meshStartPromise;

        if (this.meshClientService.isRunning) {
            const activated = await this.enqueueClientRegistry(stream.clientId, async () => {
                if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) {
                    return false;
                }
                return this.meshClientService.activateClient(stream.clientId, registryMetadata, stream.id);
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
        this.clientRegistryMetadata.set(stream.clientId, registryMetadata);
    }

    protected override async onStreamActivated(stream: SrpcStream<TMeta>): Promise<void> {
        // A partially-started mesh can already have an instance ID while its
        // client registry is still unavailable. Backfill will publish this
        // stream once startup completes; avoid treating that transient state
        // as a stale metadata write and scheduling retry churn.
        if (this.meshClientService.isRunning) this.syncStreamMeta(stream);
        await this.enqueueClientCallback(stream.clientId, async () => {
            // Skip stale connection callbacks for streams that disconnected
            // or were replaced before activation finished.
            if (stream.lastPingAt < 0 || this.streamsByClientId.get(stream.clientId) !== stream) {
                return;
            }

            if (!this.clientRegistryMetadata.has(stream.clientId)) {
                this.meshLogger.warn('client registry metadata missing during activation', {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                return;
            }

            this.lifecycleConnectedStreams.add(stream);
            const registryMetadata = this.clientRegistryMetadata.get(stream.clientId) as TRegistryMeta;
            for (const cb of this.connectedCallbacks) {
                try {
                    await cb(stream.clientId, registryMetadata);
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
        const deferredDisconnect = this.pendingStartDisconnects?.get(stream);
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
            const hasRegistryMetadata = this.clientRegistryMetadata.has(stream.clientId);
            const registryMetadata = this.clientRegistryMetadata.get(stream.clientId) as TRegistryMeta;
            const removed = await this.meshClientService.unregisterClient(stream.clientId, stream.id);
            // A replacement may become current while the exact Redis CAS is in
            // flight. Re-read before touching shared metadata or callbacks.
            const currentStream = this.getCurrentStreamByClientId(stream.clientId);
            const replacementExists = currentStream !== undefined && currentStream !== stream;
            if (replacementExists) {
                // A cancelled-start snapshot survives a merely local,
                // tentative replacement. That replacement can still be
                // rejected, in which case the original offline lifecycle
                // transition must not be lost. A committed remote handoff is
                // reconciled from the exact registry record before dispatch.
                if (deferredDisconnect && !this.rollbackGatedDisconnects.has(stream) && this.pendingStartDisconnectFenceDeadlines.has(stream)) {
                    void this.dispatchPendingStartDisconnects(stream).catch(error => {
                        this.meshCleanupFailure = toError(error);
                        this.meshLogger.warn('failed to reconcile deferred supersede disconnect', {
                            error: this.meshCleanupFailure,
                            clientId: stream.clientId
                        });
                    });
                } else if (!deferredDisconnect) {
                    this.pendingStartDisconnects?.delete(stream);
                }
                return;
            }
            // A mesh ownership fence intentionally closes only this local
            // generation. The client remains present on the replacement node,
            // so release our stale metadata without publishing an offline
            // lifecycle event.
            if (cause === 'supersede') {
                if (deferredDisconnect && !this.rollbackGatedDisconnects.has(stream) && this.pendingStartDisconnectFenceDeadlines.has(stream)) {
                    this.clientRegistryMetadata.delete(stream.clientId);
                    void this.dispatchPendingStartDisconnects(stream).catch(error => {
                        this.meshCleanupFailure = toError(error);
                        this.meshLogger.warn('failed to reconcile deferred supersede disconnect', {
                            error: this.meshCleanupFailure,
                            clientId: stream.clientId
                        });
                    });
                    return;
                }
                this.pendingStartDisconnects?.delete(stream);
                this.clientRegistryMetadata.delete(stream.clientId);
                return;
            }
            // A full shutdown fence can make the exact unregister return
            // false even though this stream was already published as
            // connected. Preserve the callback snapshot and emit it only
            // after the cancelled start's ownership cleanup succeeds.
            if (deferredDisconnect) {
                this.clientRegistryMetadata.delete(stream.clientId);
                return;
            }
            if (removed && hasRegistryMetadata && publishedLifecycle) {
                this.clientRegistryMetadata.delete(stream.clientId);
                void this.enqueueClientCallback(stream.clientId, async () => {
                    for (const cb of this.disconnectedCallbacks) {
                        try {
                            await cb(stream.clientId, registryMetadata);
                        } catch (err) {
                            this.meshLogger.warn('client disconnected callback error', {
                                err,
                                clientId: stream.clientId
                            });
                        }
                    }
                });
            } else if (removed && publishedLifecycle) {
                this.meshLogger.warn('client registry metadata missing during disconnect cleanup', {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                this.clientRegistryMetadata.delete(stream.clientId);
            } else {
                this.clientRegistryMetadata.delete(stream.clientId);
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
        // Snapshot the current registry metadata so we compare values, not references.
        // Without this, the default path (no extractRegistryMetadataFn) returns the
        // same proxied object stored in clientRegistryMetadata, so shallowChanged
        // would always return false.
        const registryMetadata = snapshotMetadata(this.extractRegistryMetadata(stream));
        const existing = this.clientRegistryMetadata.get(stream.clientId);
        if (existing && !shallowChanged(existing, registryMetadata)) return;

        // Pre-start clients are intentionally served locally. Keep the latest
        // snapshot for startup backfill instead of writing through the
        // placeholder registry, which would otherwise retry as stale.
        if (!this.meshClientService.isRunning) {
            if (this.isCurrentStream(stream)) this.clientRegistryMetadata.set(stream.clientId, registryMetadata);
            return;
        }

        // Write directly to the registry (always local/owning node).
        // Do NOT route through meshClientService.updateClientMetadata here -
        // that would loop back into clientUpdateMetaFn -> stream.meta -> proxy.
        void this.enqueueClientRegistry(stream.clientId, async () => {
            const updated = await this.clientRegistry.updateMetadata(stream.clientId, registryMetadata, stream.id);
            if (!updated) {
                throw new SrpcStaleConnectionError(stream.clientId);
            }
            if (!this.isCurrentStream(stream)) return;
            this.clientRegistryMetadata.set(stream.clientId, registryMetadata);
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

    get startupState(): 'stopped' | 'starting' | 'ready' | 'draining' | 'failed' {
        if (this.meshLeaseFailure) return 'failed';
        if (this.meshCleanupFailure) return 'failed';
        if (this.meshStopping || this.meshStopPromise || this.meshPendingStartCleanup || this.meshPendingLinkClose) return 'draining';
        if (this.meshStartPromise) return 'starting';
        return this.meshRunning ? 'ready' : 'stopped';
    }

    ready(): Promise<void> {
        if (this.meshLeaseFailure) return Promise.reject(this.meshLeaseFailure);
        return this.meshStart();
    }

    /**
     * Read a generation-fenced registry record without materializing a remote
     * connection, link capability, or byte-stream sender pool. Use this for
     * connection-state and metadata decisions; resolveClient() is for an imminent
     * invoke, byte stream, metadata mutation, or disconnect.
     */
    async getRegisteredClient(clientId: string): Promise<RegisteredClient<TRegistryMeta> | undefined> {
        if (!this.meshRunning) {
            const stream = this.streamsByClientId.get(clientId);
            if (!stream) return undefined;
            return {
                clientId: stream.clientId,
                nodeId: this.meshInstanceId,
                connectionId: stream.id,
                connectedAt: stream.connectedAt,
                metadata: snapshotMetadata(this.extractRegistryMetadata(stream))
            };
        }
        return this.clientRegistry.getClient(clientId);
    }

    /** Registry-only counterpart to listClients(); it never creates remote handles. */
    async listRegisteredClients(): Promise<RegisteredClient<TRegistryMeta>[]> {
        if (!this.meshRunning) {
            return [...this.streamsByClientId.values()].map(stream => ({
                clientId: stream.clientId,
                nodeId: this.meshInstanceId,
                connectionId: stream.id,
                connectedAt: stream.connectedAt,
                metadata: snapshotMetadata(this.extractRegistryMetadata(stream))
            }));
        }
        return this.clientRegistry.listClients();
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
        this.clientRegistryMetadata.set(clientId, snapshotMetadata(projected));
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

    override async resolveClient(clientId: string, deadlineAt?: number): Promise<MeshSrpcConnection<TMeta, TRegistryMeta> | undefined> {
        // A running mesh link owns the generation fence.  Returning the local
        // map first can expose a stream that the registry has already
        // superseded on another node.
        if (this.meshLinkController) return this.meshLinkController.resolveClient(clientId, deadlineAt);
        return this.streamsByClientId.get(clientId);
    }

    override async listClients(): Promise<MeshSrpcConnection<TMeta, TRegistryMeta>[]> {
        if (!this.meshLinkController) return this.getLocalStreams();
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
    override invoke<P extends InvokePrefixes<TServerOutput, TClientOutput>>(
        connectionOrClientId: MeshSrpcConnection<TMeta, TRegistryMeta> | string,
        prefix: P,
        data: RequestData<TServerOutput, P>,
        timeoutMs?: number
    ): Promise<ResponseData<TClientOutput, P>>;
    override invoke(
        connectionOrClientId: SrpcConnection<TMeta | TRegistryMeta> | string,
        prefix: string,
        data: unknown,
        timeoutMs?: number
    ): Promise<unknown>;
    override async invoke(
        connectionOrClientId: SrpcConnection<TMeta | TRegistryMeta> | string,
        prefix: string,
        data: unknown,
        timeoutMs = 30_000
    ): Promise<unknown> {
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
            return super.invoke(connection as SrpcStream<TMeta>, prefix as never, data as never, remaining());
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
        return this.startMeshLifecycle(true);
    }

    private async startMeshLifecycle(enableRecovery: boolean): Promise<void> {
        if (enableRecovery) this.meshRecoveryEnabled = true;
        if (this.meshLeaseFailure) throw this.meshLeaseFailure;
        if (this.meshCleanupFailure) throw this.meshCleanupFailure;
        if (this.meshClosed) throw new Error('sRPC mesh server is closed');
        if (this.meshStopPromise) {
            await this.meshStopPromise;
            return this.startMeshLifecycle(enableRecovery);
        }
        // A shutdown is allowed to return before an uncooperative underlying
        // mesh start settles. Do not let a new start overlap that deferred
        // rollback or inherit its partially-created membership.
        if (this.meshPendingStartCleanup) {
            await this.meshPendingStartCleanup;
            return this.startMeshLifecycle(enableRecovery);
        }
        if (this.meshPendingLinkClose) {
            await this.meshPendingLinkClose;
            return this.startMeshLifecycle(enableRecovery);
        }
        if (this.meshRunning) return;
        if (this.meshStartPromise) {
            if (!this.meshStartCancelled) return this.meshStartPromise;
            // A caller arriving after shutdown requested cancellation must not
            // inherit the cancelled start's rejection. Wait for its rollback,
            // then begin a fresh lifecycle.
            await this.meshStartPromise.catch(() => {});
            return this.startMeshLifecycle(enableRecovery);
        }
        const generation = (this.meshStartGeneration ?? 0) + 1;
        this.meshStartGeneration = generation;
        this.meshStartCancelled = false;
        this.meshStartRollbackFailure = undefined;
        this.meshClientService.prepareStart?.();
        const start = (async () => {
            try {
                await this.startMesh(generation);
            } catch (error) {
                try {
                    await this.rollbackMeshStart();
                } catch (rollbackError) {
                    this.meshStartRollbackFailure = toError(rollbackError);
                    // A cancelled start gets one deferred rollback retry after
                    // its original startup settles. Do not permanently fail
                    // future starts until that recovery barrier also fails.
                    if (!this.meshStartCancelled) this.meshCleanupFailure = this.meshStartRollbackFailure;
                    throw this.meshStartRollbackFailure;
                }
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

    private assertMeshStartCurrent(generation: number): void {
        if (this.meshStartGeneration !== generation || this.meshStopping || this.meshClosed) {
            throw new Error('sRPC mesh startup was cancelled');
        }
    }

    private async startMesh(generation: number): Promise<void> {
        const linkConfig = this.resolveMeshLinkConfig();
        if (linkConfig) {
            this.meshLinkRequestTimeoutMs = linkConfig.requestTimeoutMs;
            const advertiseUrl = resolveMeshLinkAdvertiseUrl({
                advertiseUrl: linkConfig.advertiseUrl,
                path: linkConfig.path,
                // resolveMeshLinkConfig selects the actual listener. Undefined
                // intentionally means the application HTTP listener rather than
                // an isolated sRPC client listener (for example mTLS).
                httpServer: linkConfig.httpServer
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
            this.assertMeshStartCurrent(generation);
        }

        await this.meshClientService.start();
        this.assertMeshStartCurrent(generation);
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
            this.assertMeshStartCurrent(generation);
            // Install proxy if not already proxied (streams that connected before meshStart)
            this.installMetaProxy(stream);

            // Resnapshot even if a local pre-start mutation previously
            // populated the cache. The live stream is authoritative.
            const registryMetadata = snapshotMetadata(this.extractRegistryMetadata(stream));
            this.clientRegistryMetadata.set(clientId, registryMetadata);
            const allowSupersede = stream.supersede;
            const backfill = this.enqueueClientRegistry(clientId, async () => {
                this.assertMeshStartCurrent(generation);
                // Only backfill the current stream (active or pending).
                const currentStream = this.getCurrentStreamByClientId(clientId);
                if (currentStream !== stream) return;

                const registered = stream.isActivated
                    ? await this.meshClientService.registerClient(clientId, registryMetadata, allowSupersede, stream.id)
                    : await this.meshClientService.reserveClient(clientId, registryMetadata, allowSupersede, stream.id);
                if (!registered) {
                    this.meshLogger.warn('Backfill rejected: cross-pod conflict', { clientId });
                    this.cleanupStream(stream, 'conflict');
                    throw new Error(`Failed to backfill mesh ownership for client ${clientId}`);
                }
            });
            backfillPromises.push(backfill.then(() => undefined));
        }
        await Promise.all(backfillPromises);
        this.assertMeshStartCurrent(generation);
    }

    async meshStop(): Promise<void> {
        // A normal lifecycle stop must not be followed by a background
        // recovery, even when it joins lease cleanup already underway.
        this.cancelMeshRecovery(true);
        if (this.meshFatalCleanupPromise) return this.meshFatalCleanupPromise;
        if (this.meshLeaseCleanupPromise) return this.meshLeaseCleanupPromise;
        if (this.meshLeaseCleanupRequired) return this.beginMeshLeaseCleanup();
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
        const start = this.meshStartPromise;
        if (start) {
            // Do not await a start that is blocked on an unavailable
            // dependency. Detach the directly-owned mesh transport now, then
            // arrange a best-effort rollback when the dependency eventually
            // returns. This keeps shutdown bounded and prevents a late start
            // from resurrecting delivery resources.
            this.meshStartGeneration++;
            this.meshStartCancelled = true;
            this.meshRunning = false;
            this.meshStopping = true;
            let setupFailure: Error | undefined;
            try {
                const failures: Error[] = [];
                // Fence membership first. It does not clear lifecycle metadata,
                // and makes every subsequent best-effort local cleanup safe.
                try {
                    this.meshClientService.fenceForShutdown?.();
                } catch (error) {
                    failures.push(toError(error));
                }
                try {
                    this.capturePendingStartDisconnects();
                } catch (error) {
                    failures.push(toError(error));
                }
                try {
                    this.disconnectAllMeshStreams();
                } catch (error) {
                    failures.push(toError(error));
                }
                try {
                    await this.releaseMeshLinkResources(false);
                } catch (error) {
                    failures.push(toError(error));
                }
                if (failures.length === 1) setupFailure = failures[0];
                else if (failures.length > 1) setupFailure = new AggregateError(failures, 'sRPC mesh pending-start shutdown setup failed');
                if (setupFailure) throw setupFailure;
            } finally {
                this.meshStopping = false;
                // A setup failure must not strand a late start without its
                // rollback barrier. The deferred retry also retains captured
                // offline callbacks until ownership is conclusively cleaned.
                this.deferPendingMeshStartRollback(start, setupFailure);
            }
            return;
        }
        if (!this.meshRunning) return;
        this.meshRunning = false;
        this.meshStopping = true;
        const failures: Error[] = [];
        try {
            // Fence admission before taking the stream snapshot below. Cleanup
            // can await registry/controller work, so delaying this until the
            // final MeshClientService.stop() would allow a late connection to
            // reserve and activate outside that snapshot.
            this.meshClientService.fenceAdmission?.();
            // Fence local delivery first. This queues exact unregister work
            // while the mesh service is still available to persist it.
            this.disconnectAllMeshStreams();
            await Promise.allSettled([...(this.clientRegistryChains?.values() ?? [])]);
        } catch (error) {
            failures.push(toError(error));
        }
        try {
            await this.releaseMeshLinkResources(false);
        } catch (error) {
            failures.push(toError(error));
        }
        try {
            await this.meshClientService.stop();
        } catch (error) {
            failures.push(toError(error));
        }
        try {
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, 'sRPC mesh shutdown failed');
        } catch (error) {
            // Once normal shutdown has fenced delivery, a failed registry or
            // membership cleanup cannot safely be followed by a fresh start.
            // Preserve the failure as a durable lifecycle barrier.
            this.meshCleanupFailure = toError(error);
            throw this.meshCleanupFailure;
        } finally {
            this.meshStopping = false;
        }
    }

    private disconnectAllMeshStreams(): void {
        const streams = new Set<SrpcStream<TMeta>>([...(this.streamsByClientId?.values() ?? []), ...(this.pendingStreamsByClientId?.values() ?? [])]);
        for (const stream of streams) {
            if (this.isCurrentStream(stream)) this.cleanupStream(stream, 'disconnect');
        }
    }

    private capturePendingStartDisconnects(): void {
        this.pendingStartDisconnects ??= new Map();
        this.rollbackGatedDisconnects ??= new WeakSet();
        const streams = new Set<SrpcStream<TMeta>>([...(this.streamsByClientId?.values() ?? []), ...(this.pendingStreamsByClientId?.values() ?? [])]);
        for (const stream of streams) {
            if (!this.isCurrentStream(stream) || !this.lifecycleConnectedStreams?.has(stream) || !this.clientRegistryMetadata.has(stream.clientId))
                continue;
            this.captureDeferredDisconnect(stream);
            this.rollbackGatedDisconnects.add(stream);
        }
    }

    private captureDeferredDisconnect(stream: SrpcStream<TMeta>): void {
        this.pendingStartDisconnects ??= new Map();
        if (
            this.pendingStartDisconnects.has(stream) ||
            !this.lifecycleConnectedStreams?.has(stream) ||
            !this.clientRegistryMetadata.has(stream.clientId)
        )
            return;
        this.pendingStartDisconnects.set(stream, {
            clientId: stream.clientId,
            connectionId: stream.id,
            nodeId: this.meshClientService.instanceId,
            metadata: snapshotMetadata(this.clientRegistryMetadata.get(stream.clientId) as TRegistryMeta)
        });
    }

    private async dispatchPendingStartDisconnects(targetStream?: SrpcStream<TMeta>): Promise<void> {
        if (!this.pendingStartDisconnects) return;
        const pending = targetStream
            ? (() => {
                  const snapshot = this.pendingStartDisconnects.get(targetStream);
                  return snapshot ? [[targetStream, snapshot] as const] : [];
              })()
            : [...this.pendingStartDisconnects.entries()];
        await Promise.all(
            pending.map(async ([stream, snapshot]) => {
                const { clientId, metadata } = snapshot;
                let fenceDeadline = this.pendingStartDisconnectFenceDeadlines?.get(stream);
                if (this.rollbackGatedDisconnects?.has(stream)) {
                    // A fence can arrive after shutdown detached the old
                    // stream. Verify the post-rollback registry first, then
                    // retain this exact generation through one full claim
                    // window so a late private claim may publish safely.
                    const detectionDeadline = fenceDeadline ?? Date.now() + this.meshSupersedeReconcileMs;
                    if (!(await this.shouldDispatchPendingStartDisconnect(snapshot, undefined, detectionDeadline))) {
                        this.pendingStartDisconnects?.delete(stream);
                        this.pendingStartDisconnectFenceDeadlines?.delete(stream);
                        return;
                    }
                    if (fenceDeadline === undefined) {
                        fenceDeadline = detectionDeadline;
                        this.pendingStartDisconnectFenceDeadlines.set(stream, fenceDeadline);
                    }
                }
                if (fenceDeadline !== undefined) {
                    this.queuePendingStartDisconnectCallback(stream, snapshot, fenceDeadline, !this.rollbackGatedDisconnects?.has(stream));
                } else if (await this.shouldDispatchPendingStartDisconnect(snapshot)) {
                    // An in-flight remote exact fence can consume this
                    // snapshot while registry reconciliation awaits.
                    if (!this.pendingStartDisconnects?.has(stream)) return;
                    // Queue application work behind the per-client callback
                    // chain, but do not make global restart safety depend on
                    // user code settling. Ownership reconciliation above is
                    // the lifecycle barrier.
                    void this.enqueueClientCallback(clientId, async () => {
                        for (const cb of this.disconnectedCallbacks) {
                            try {
                                await cb(clientId, metadata);
                            } catch (err) {
                                this.meshLogger.warn('client disconnected callback error', { err, clientId });
                            }
                        }
                    }).catch(error => this.meshLogger.warn('deferred client disconnected callback error', { error, clientId }));
                }
                this.pendingStartDisconnects?.delete(stream);
            })
        );
    }

    private async shouldDispatchPendingStartDisconnect(
        snapshot: {
            clientId: string;
            connectionId: string;
            nodeId: number;
            metadata: TRegistryMeta;
        },
        fenceDeadline?: number,
        lookupRetryDeadline = fenceDeadline,
        retryDelayMs = this.meshSupersedeReconcileRetryMs
    ): Promise<boolean> {
        const registry = this.meshClientService.clientRegistry;
        retryDelayMs = Math.max(1, retryDelayMs ?? 10);
        let current;
        try {
            current = await registry.getClient(snapshot.clientId);
        } catch (error) {
            if (lookupRetryDeadline !== undefined && Date.now() < lookupRetryDeadline) {
                await new Promise<void>(resolve => {
                    const timer = setTimeout(resolve, Math.min(retryDelayMs, lookupRetryDeadline - Date.now()));
                    timer.unref?.();
                });
                return this.shouldDispatchPendingStartDisconnect(
                    snapshot,
                    fenceDeadline,
                    lookupRetryDeadline,
                    Math.min(Math.max(retryDelayMs * 2, 1), 1_000)
                );
            }
            throw toError(error);
        }
        if (
            (!current || (current.nodeId === snapshot.nodeId && current.connectionId === snapshot.connectionId)) &&
            fenceDeadline !== undefined &&
            Date.now() < fenceDeadline
        ) {
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, Math.min(retryDelayMs, fenceDeadline - Date.now()));
                timer.unref?.();
            });
            return this.shouldDispatchPendingStartDisconnect(
                snapshot,
                fenceDeadline,
                lookupRetryDeadline,
                Math.min(Math.max(retryDelayMs * 2, 1), 1_000)
            );
        }
        if (!current) return true;
        if (current.nodeId !== snapshot.nodeId || current.connectionId !== snapshot.connectionId) return false;
        throw new Error(`Cannot reconcile deferred mesh disconnect for ${snapshot.clientId}: exact old generation is still registered`);
    }

    private queuePendingStartDisconnectCallback(
        stream: SrpcStream<TMeta>,
        snapshot: { clientId: string; connectionId: string; nodeId: number; metadata: TRegistryMeta },
        fenceDeadline: number,
        pollForReplacement = true
    ): void {
        if (this.pendingStartDisconnectCallbackQueued.has(stream)) return;
        this.pendingStartDisconnectCallbackQueued.add(stream);
        if (!this.rollbackGatedDisconnects.has(stream)) this.pendingStartDisconnects?.delete(stream);
        const { clientId, metadata } = snapshot;
        void this.enqueueClientCallback(clientId, async () => {
            if (!pollForReplacement && Date.now() < fenceDeadline) {
                await new Promise<void>(resolve => {
                    const timer = setTimeout(resolve, fenceDeadline - Date.now());
                    timer.unref?.();
                });
            }
            // Lease-loss/rollback snapshots perform one deadline lookup rather
            // than polling Redis per client throughout the claim window. Only
            // actual takeover fences poll early, using exponential backoff.
            const lookupRetryDeadline = pollForReplacement ? fenceDeadline : Date.now() + Math.min(this.meshSupersedeReconcileMs ?? 30_000, 5_000);
            const shouldDispatch = await this.shouldDispatchPendingStartDisconnect(
                snapshot,
                pollForReplacement ? fenceDeadline : undefined,
                lookupRetryDeadline
            );
            // Reconciliation state must not retain the stream for the lifetime
            // of arbitrary application callback work.
            this.pendingStartDisconnectFenceDeadlines.delete(stream);
            if (!shouldDispatch) return;
            for (const cb of this.disconnectedCallbacks) {
                try {
                    await cb(clientId, metadata);
                } catch (err) {
                    this.meshLogger.warn('client disconnected callback error', { err, clientId });
                }
            }
        })
            .catch(error => {
                this.failDeferredDisconnectReconciliation(toError(error), clientId);
            })
            .finally(() => {
                this.pendingStartDisconnectFenceDeadlines.delete(stream);
                this.pendingStartDisconnectCallbackQueued.delete(stream);
            });
    }

    private markPendingStartDisconnectFence(clientId: string, connectionId: string): void {
        for (const [stream, snapshot] of this.pendingStartDisconnects ?? []) {
            if (snapshot.clientId === clientId && snapshot.connectionId === connectionId) {
                this.pendingStartDisconnectFenceDeadlines.set(stream, Date.now() + this.meshSupersedeReconcileMs);
            }
        }
    }

    private failDeferredDisconnectReconciliation(error: Error, clientId: string): void {
        if (this.meshFatalCleanupPromise) {
            this.meshCleanupFailure = new AggregateError(
                [this.meshCleanupFailure ?? error, error],
                'Multiple deferred mesh disconnect reconciliation failures'
            );
            return;
        }
        this.meshCleanupFailure = error;
        this.meshRunning = false;
        const failures = [error];
        try {
            // Preserve immutable lifecycle snapshots before fencing membership;
            // unregisters after the fence can no longer prove exact removal.
            this.capturePendingStartDisconnects();
        } catch (captureError) {
            failures.push(toError(captureError));
        }
        try {
            this.meshClientService.fenceForShutdown?.();
        } catch (fenceError) {
            failures.push(toError(fenceError));
        }
        const cleanup = (async () => {
            try {
                this.disconnectAllMeshStreams();
            } catch (cleanupError) {
                failures.push(toError(cleanupError));
            }
            // Let exact unregister work snapshot lifecycle metadata and queue
            // its callbacks before link release clears the shared cache.
            await Promise.allSettled([...(this.clientRegistryChains?.values() ?? [])]);
            try {
                await this.releaseMeshLinkResources(false);
            } catch (cleanupError) {
                failures.push(toError(cleanupError));
            }
            try {
                await this.meshClientService.stop();
                try {
                    await this.dispatchPendingStartDisconnects();
                } catch (dispatchError) {
                    failures.push(toError(dispatchError));
                }
            } catch (cleanupError) {
                failures.push(toError(cleanupError));
            }
            this.meshCleanupFailure =
                failures.length === 1 ? failures[0] : new AggregateError(failures, 'Deferred mesh disconnect reconciliation cleanup failed');
            this.meshLogger.warn('deferred client disconnect reconciliation failed; mesh ownership fenced', {
                error: this.meshCleanupFailure,
                clientId
            });
        })();
        this.meshFatalCleanupPromise = cleanup.catch(cleanupError => {
            this.meshCleanupFailure = new AggregateError(
                [this.meshCleanupFailure, toError(cleanupError)],
                'Deferred mesh disconnect reconciliation cleanup failed'
            );
            this.meshLogger.warn('deferred mesh disconnect cleanup failed unexpectedly', { cleanupError });
        });
    }

    /** Release mesh-link resources without waiting for mesh membership I/O. */
    private async releaseMeshLinkResources(waitForClose = true): Promise<void> {
        const controller = this.meshLinkController;
        const failures: Error[] = [];
        try {
            this.meshClientService.setRemoteTransport(undefined);
        } catch (error) {
            failures.push(toError(error));
        }
        try {
            this.unregisterMeshLinkRoute?.();
        } catch (error) {
            failures.push(toError(error));
        } finally {
            this.unregisterMeshLinkRoute = undefined;
        }
        let close: Promise<void> | undefined;
        try {
            close = controller?.close();
        } catch (error) {
            failures.push(toError(error));
        } finally {
            if (this.meshLinkController === controller) {
                this.meshLinkController = undefined;
                this.meshLinkRuntime = undefined;
            }
            this.clientRegistryMetadata.clear();
        }
        if (!waitForClose && close) {
            this.trackDetachedLinkClose(close);
        } else if (close) {
            try {
                await close;
            } catch (error) {
                failures.push(toError(error));
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Failed to release sRPC mesh-link resources');
    }

    private trackDetachedLinkClose(close: Promise<void>): void {
        this.meshPendingLinkClose = close;
        void close.then(
            () => {
                if (this.meshPendingLinkClose === close) this.meshPendingLinkClose = undefined;
            },
            error => {
                if (this.meshPendingLinkClose === close) {
                    this.meshCleanupFailure = toError(error);
                    this.meshLogger.warn('failed to close detached sRPC mesh link', { error: this.meshCleanupFailure });
                }
            }
        );
    }

    private deferPendingMeshStartRollback(start: Promise<void>, setupFailure?: Error): void {
        if (this.meshPendingStartCleanup) return;
        // `start` already rolls itself back on cancellation. The fulfilled
        // branch is defensive: it covers a future start path that fails to
        // observe the generation fence. Consume every failure here because
        // shutdown intentionally does not await the original start promise.
        const cleanup = start.then(
            () => this.rollbackMeshStart(),
            // meshStart already attempted rollback before rejecting. Retry
            // only a failed rollback so its error remains a cleanup barrier.
            async () => {
                if (this.meshStartRollbackFailure === undefined && setupFailure === undefined) return;
                await this.rollbackMeshStart();
                this.meshStartRollbackFailure = undefined;
            }
        );
        const pendingLinkClose = this.meshPendingLinkClose;
        // Registry/membership cleanup is the offline safety boundary. A
        // controller close may be stuck behind its own request timeout, but
        // must not indefinitely suppress an already-confirmed lifecycle
        // disconnect callback. It remains a restart barrier below.
        const cleanupAndCallbacks = cleanup.then(() => this.dispatchPendingStartDisconnects());
        const barrier = pendingLinkClose ? Promise.all([cleanupAndCallbacks, pendingLinkClose]).then(() => undefined) : cleanupAndCallbacks;
        this.meshPendingStartCleanup = barrier;
        void barrier.then(
            () => {
                if (this.meshPendingStartCleanup === barrier) {
                    this.meshPendingStartCleanup = undefined;
                    if (this.meshPendingLinkClose === pendingLinkClose) this.meshPendingLinkClose = undefined;
                }
            },
            error => {
                this.meshCleanupFailure = toError(error);
                this.meshLogger.warn('failed to roll back cancelled sRPC mesh startup', { error: this.meshCleanupFailure });
            }
        );
    }

    private async rollbackMeshStart(): Promise<void> {
        this.meshRunning = false;
        await this.releaseMeshLinkResources(false);
        await this.meshClientService.stop();
    }

    override close(): void {
        this.cancelMeshRecovery();
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
                return (
                    stream?.clientId === clientId ||
                    [...this.pendingStartDisconnects.values()].some(
                        snapshot => snapshot.clientId === clientId && snapshot.connectionId === connectionId
                    )
                );
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
                        requiresExactSenderGrant: stream.capabilities?.has('sender-announcements') === true
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
            fenceLocal: async (clientId, connectionId, reason) => this.handleClientSuperseded(clientId, connectionId, reason),
            updateLocalMetadata: async (clientId, connectionId, metadata) => {
                const stream = getLocal(clientId, connectionId);
                const projected = this.projectMetadataWithoutMutation(stream, metadata);
                if (!(await this.clientRegistry.updateMetadata(clientId, projected, connectionId))) {
                    throw new SrpcStaleConnectionError(clientId);
                }
                await this.assertCurrentMeshStream(stream);
                this.applyMetadataToLocalStream(stream, metadata);
                this.clientRegistryMetadata.set(clientId, snapshotMetadata(projected));
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
        return snapshotMetadata(this.extractRegistryMetadata(stream));
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
        if (!this.extractRegistryMetadataFn) return snapshotMetadata(merged as unknown as TRegistryMeta);
        // Run the caller's projection against a shallow stream clone with a
        // merged meta clone. No observable live stream property is touched,
        // including when the projection is a primitive.
        const clone = Object.assign(Object.create(Object.getPrototypeOf(stream)), stream, { meta: merged }) as SrpcStream<TMeta>;
        return snapshotMetadata(this.extractRegistryMetadataFn(clone));
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
            httpServer: this.resolveMeshLinkHttpServer(),
            connectTimeoutMs: this.meshLinkOptions?.connectTimeoutMs ?? config?.MESH_LINK_CONNECT_TIMEOUT_MS ?? 5_000,
            requestTimeoutMs,
            idleTimeoutMs: this.meshLinkOptions?.idleTimeoutMs ?? config?.MESH_LINK_IDLE_TIMEOUT_MS ?? 60_000,
            maxFrameBytes: this.meshLinkOptions?.maxFrameBytes ?? config?.MESH_LINK_MAX_FRAME_BYTES ?? 8 * 1024 * 1024,
            maxBufferedBytes: this.meshLinkOptions?.maxBufferedBytes ?? config?.MESH_LINK_MAX_BUFFERED_BYTES ?? 16 * 1024 * 1024,
            maxEndpointPins: this.meshLinkOptions?.maxEndpointPins
        };
    }

    /**
     * Normal applications start mesh links after their main HTTP listener is
     * bound, so omitting meshLink.httpServer intentionally hosts upgrades
     * there.  Standalone servers historically supplied only options.httpServer
     * and may have no live application listener; retain that safe fallback so
     * their advertised listener and upgrade listener cannot diverge.
     */
    private resolveMeshLinkHttpServer(): Server | undefined {
        if (this.meshLinkOptions?.httpServer) return this.meshLinkOptions.httpServer;
        try {
            if (getCurrentApp().http.getAddress()) return undefined;
        } catch {
            // No application exists; use the standalone sRPC listener below.
        }
        return this.options.httpServer;
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
