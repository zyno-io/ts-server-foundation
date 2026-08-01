import { createLogger } from '../logger';
import { randomUUID } from 'node:crypto';
import { assertSafeTimerMs } from '../../helpers';
import { MeshService, type MeshBroadcastMap, type MeshBroadcastOptions, type MeshServiceOptions } from '../mesh';
import { MeshClientRedisRegistry, type MeshClientRedisRegistryOptions } from './mesh-client-redis-registry';
import { MeshClientRegistry } from './mesh-client-registry';
import { getMeshLinkProcessId } from '../mesh-link';
import { SrpcIndeterminateDeliveryError } from '../../srpc/types';
import {
    ClientDisconnectedError,
    ClientInvocationError,
    ClientNotFoundError,
    type MeshClientRecord,
    type MeshClientRegistrationState,
    type MeshClientRegistryBackend,
    type RegisteredClient
} from './types';

// --- Direct mesh-link transport ---

/**
 * Point-to-point MeshClientService operations are transported over an
 * authenticated mesh link. Redis retains only mesh membership, registry, and
 * optional broadcast coordination.
 */
export interface MeshClientRemoteTransport<TMeta> {
    invokeClient(
        nodeId: number,
        request: { clientId: string; connectionId: string; type: string; data: unknown; timeoutMs?: number; deadlineAt?: number }
    ): Promise<unknown>;
    fenceClient(nodeId: number, request: { clientId: string; connectionId: string; reason?: string; timeoutMs?: number }): Promise<boolean>;
    updateClientMetadata(nodeId: number, request: { clientId: string; connectionId: string; metadata: TMeta }): Promise<boolean>;
}

const OwnershipClaimDeadlineMs = 30_000;
const MaxExactUnregisterObligations = 4_096;

// --- Options ---

export interface MeshClientServiceOptions<TMeta> {
    key: string;
    meshOptions?: MeshServiceOptions;
    registryBackend?: MeshClientRegistryBackend<TMeta>;
    /** Limits for the built-in Redis registry. Ignored with registryBackend. */
    registryOptions?: MeshClientRedisRegistryOptions;
    clientInvokeFn: (clientId: string, type: string, data: unknown, timeoutMs?: number, connectionId?: string) => Promise<unknown>;
    clientUpdateMetaFn?: (clientId: string, metadata: TMeta) => boolean;
    clientProjectMetaFn?: (clientId: string, metadata: unknown, connectionId?: string) => { updated: boolean; metadata: TMeta };
    clientApplyMetaFn?: (clientId: string, metadata: unknown, connectionId?: string) => boolean;
    /**
     * Bounded fallback for backends without durable orphan delivery.
     * Each non-empty node cleanup snapshot consumes one item.
     */
    maxPendingOrphanItems?: number;
    maxPendingOrphanBytes?: number;
    /** Expiry for finalized in-memory fallback obligations. Defaults to one hour. */
    pendingOrphanTtlMs?: number;
}

// --- MeshClientService ---

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class MeshClientService<TMeta, TBroadcasts extends MeshBroadcastMap = {}> {
    // Exposed for MeshSrpcServer to access internals
    /** @internal */
    readonly mesh: MeshService<TBroadcasts>;
    private logger = createLogger(this);
    private registry: MeshClientRegistry<TMeta>;
    private backend: MeshClientRegistryBackend<TMeta>;
    private clientInvokeFn: MeshClientServiceOptions<TMeta>['clientInvokeFn'];
    private clientUpdateMetaFn: MeshClientServiceOptions<TMeta>['clientUpdateMetaFn'];
    private clientProjectMetaFn: MeshClientServiceOptions<TMeta>['clientProjectMetaFn'];
    private clientApplyMetaFn: MeshClientServiceOptions<TMeta>['clientApplyMetaFn'];
    private remoteTransport?: MeshClientRemoteTransport<TMeta>;
    private nodeCleanedUpCallbacks: ((nodeId: number, orphaned: RegisteredClient<TMeta>[]) => void | Promise<void>)[] = [];
    private clientSupersededCallbacks: ((clientId: string, connectionId?: string, reason?: string) => boolean | void | Promise<boolean | void>)[] =
        [];
    private leaseLostCallbacks: ((reason?: Error) => void | Promise<void>)[] = [];
    private registryRefreshTimer?: ReturnType<typeof setInterval>;
    private registryRefreshInFlight?: Promise<void>;
    private orphanRetryTimer?: ReturnType<typeof setInterval>;
    private readonly pendingOrphanCallbacks = new Map<number, { encoded: string; bytes: number; expiresAt: number }>();
    private readonly fallbackDeliveryInFlight = new Map<number, Promise<void>>();
    private pendingOrphanBytes = 0;
    private readonly orphanClaimerId = randomUUID();
    private orphanDrainInFlight?: Promise<void>;
    private activeDurableOrphan?: { id: string; claimToken: string };
    private readonly registryRefreshIntervalMs: number;
    private readonly maxClientIdBytes: number;
    private readonly maxMetadataBytes: number;
    private lifecycle = Promise.resolve();
    private fallbackCleanupLifecycle = Promise.resolve();
    private readonly exactUnregisterObligations = new Map<string, Promise<boolean>>();
    private readonly exactUnregisterClientChains = new Map<string, Promise<void>>();
    private ownershipGeneration = 0;
    private hasStarted = false;
    private readonly maxPendingOrphanItems: number;
    private readonly maxPendingOrphanBytes: number;
    private readonly pendingOrphanTtlMs: number;
    /** @internal Overridable by focused ownership-failure tests. */
    private ownershipClaimDeadlineMs = OwnershipClaimDeadlineMs;
    /** @internal Overridable by focused ownership-failure tests. */
    private ownershipRetryIntervalMs = 10;
    /** @internal Overridable by focused ownership-failure tests. */
    private exactUnregisterDeadlineMs = 2_000;

    constructor(options: MeshClientServiceOptions<TMeta>) {
        this.backend = options.registryBackend ?? new MeshClientRedisRegistry<TMeta>(`_mc:${options.key}`, options.registryOptions);
        this.clientInvokeFn = options.clientInvokeFn;
        this.clientUpdateMetaFn = options.clientUpdateMetaFn;
        this.clientProjectMetaFn = options.clientProjectMetaFn;
        this.clientApplyMetaFn = options.clientApplyMetaFn;
        this.maxClientIdBytes = configuredServiceLimit(options.registryOptions?.maxClientIdBytes, 1_024, 'maxClientIdBytes');
        this.maxMetadataBytes = configuredServiceLimit(options.registryOptions?.maxMetadataBytes, 64 * 1024, 'maxMetadataBytes');
        this.registryRefreshIntervalMs = Math.max(1_000, options.meshOptions?.heartbeatIntervalMs ?? 5_000);
        this.maxPendingOrphanItems = configuredServiceLimit(options.maxPendingOrphanItems, 1_024, 'maxPendingOrphanItems');
        this.maxPendingOrphanBytes = configuredServiceLimit(options.maxPendingOrphanBytes, 16 * 1024 * 1024, 'maxPendingOrphanBytes');
        this.pendingOrphanTtlMs = configuredServiceLimit(options.pendingOrphanTtlMs, 60 * 60_000, 'pendingOrphanTtlMs');
        assertSafeTimerMs(this.pendingOrphanTtlMs, 'Mesh client fallback orphan TTL');

        this.mesh = new MeshService<TBroadcasts>(`_mc:${options.key}`, {
            ...options.meshOptions,
            nodeMetadata: options.meshOptions?.nodeMetadata
        });

        this.mesh.setNodeCleanedUpCallback(async (nodeId: number) => {
            if (!this.hasDurableOrphanBackend()) {
                await this.cleanupNodeForFallback(nodeId);
                await this.deliverOrphanCallbacks(nodeId);
                return;
            }
            const orphaned = await this.backend.cleanupNodeAndEnqueueOrphaned!(nodeId);
            if (orphaned.length > 0) {
                await this.drainDurableOrphans();
                return;
            }
            await this.drainDurableOrphans();
        });

        // Losing the mesh lease means this process can no longer prove that it
        // owns any local stream.  Fence before user code can deliver another
        // message; MeshSrpcServer registers the physical stream teardown.
        this.mesh.setLeaseLostCallback(async (reason?: Error) => {
            this.running = false;
            this.ownershipGeneration++;
            this.stopRegistryTimers();
            const active = this.activeDurableOrphan;
            if (active && this.backend.nackOrphaned) {
                // NACK is a lease-token CAS, so this only releases our exact
                // active claim and never touches a successor's delivery.
                void this.backend.nackOrphaned(active.id, active.claimToken).catch(() => {});
            }
            // Start every physical-delivery fence synchronously and contain
            // synchronous callback failures individually. The framework also
            // performs an early best-effort sweep for direct MeshClientService
            // users, but deliberately retains the exact node obligation so a
            // consumer's post-mutation barrier can sweep it again.
            const callbacks: Promise<void>[] = [];
            for (const callback of this.leaseLostCallbacks) {
                try {
                    callbacks.push(Promise.resolve(callback(reason)));
                } catch (error) {
                    callbacks.push(Promise.reject(error));
                }
            }
            callbacks.push(this.sweepRegistryOwnership());
            await Promise.allSettled(callbacks).then(results => {
                for (const result of results) {
                    if (result.status === 'rejected') this.logger.warn('mesh lease-loss callback failed', { error: result.reason });
                }
            });
        });

        // Placeholder registry - will be re-created in start() with the real instanceId
        this.registry = new MeshClientRegistry<TMeta>(0, this.backend, getMeshLinkProcessId());
    }

    onNodeClientsOrphaned(cb: (nodeId: number, orphaned: RegisteredClient<TMeta>[]) => void | Promise<void>): void {
        this.nodeCleanedUpCallbacks.push(cb);
    }

    onClientSuperseded(cb: (clientId: string, connectionId?: string, reason?: string) => boolean | void | Promise<boolean | void>): void {
        this.clientSupersededCallbacks.push(cb);
    }

    /** Fence local stream delivery after this mesh member loses its lease. */
    onLeaseLost(cb: (reason?: Error) => void | Promise<void>): void {
        this.leaseLostCallbacks.push(cb);
    }

    /** @internal Installed by MeshSrpcServer before the service starts. */
    setRemoteTransport(transport: MeshClientRemoteTransport<TMeta> | undefined): void {
        this.remoteTransport = transport;
    }

    get instanceId(): number {
        return this.mesh.instanceId;
    }

    get clientRegistry(): MeshClientRegistry<TMeta> {
        return this.registry;
    }

    /** Whether mesh membership and client ownership operations are active. */
    get isRunning(): boolean {
        return this.running;
    }

    getAuthNonceConsumer(): ((principal: string, nonce: string, expiresAt: number) => Promise<boolean>) | undefined {
        if (!this.backend.consumeAuthNonce) return undefined;
        return (principal, nonce, expiresAt) => this.backend.consumeAuthNonce!(principal, nonce, expiresAt);
    }

    private running = false;
    /** Synchronous shutdown fence that rejects new client admission. */
    private admissionFenced = false;
    /** Exact registry node ID whose ownership cleanup still must succeed. */
    private registryCleanupNodeId?: number;
    /** MeshService stop initiated by the synchronous shutdown fence. */
    private shutdownFencePromise?: Promise<void>;

    /**
     * Re-open admission for a new lifecycle after the prior stop has fully
     * completed. MeshSrpcServer only calls this after any cancelled start's
     * cleanup barrier has settled.
     */
    prepareStart(): void {
        if (!this.running) this.admissionFenced = false;
    }

    /** @internal Reject new ownership admission while preserving graceful drain delivery. */
    fenceAdmission(): void {
        this.admissionFenced = true;
    }

    /** @internal Immediately fence admission/delivery and stop mesh membership. */
    fenceForShutdown(): void {
        this.fenceAdmission();
        if (this.running) {
            this.running = false;
            this.ownershipGeneration++;
            this.stopRegistryTimers();
        }
        // MeshService.stop() synchronously clears its running flag before
        // serializing physical cleanup behind any in-flight start. Keep the
        // promise so normal/deferred cleanup cannot declare completion before
        // that membership stop has settled.
        if (!this.shutdownFencePromise) {
            const stop = this.mesh.stop();
            this.shutdownFencePromise = stop;
            // Observe the rejection immediately while preserving it for the
            // shutdown cleanup barrier below.
            void stop.catch(error => this.logger.warn('failed to stop fenced mesh membership', { error }));
        }
    }

    async start(): Promise<void> {
        return this.serializeLifecycle(() => this.doStart());
    }

    private async doStart(): Promise<void> {
        if (this.running) return;
        // Never let a new MeshService instance replace the registry node ID
        // while a prior lifecycle's cleanup remains unconfirmed.
        if (this.registryCleanupNodeId !== undefined) {
            throw new Error(`Mesh client registry cleanup is still required for node ${this.registryCleanupNodeId}`);
        }
        await this.mesh.start();
        if (this.admissionFenced) {
            // fenceForShutdown() may have already initiated the physical stop
            // while this start was pending. Reuse that lifecycle operation.
            await (this.shutdownFencePromise ?? this.mesh.stop());
            return;
        }
        this.registry.setNodeId(this.mesh.instanceId);
        this.running = true;
        this.hasStarted = true;
        this.registryCleanupNodeId = this.mesh.instanceId;
        this.ownershipGeneration++;
        this.registryRefreshTimer = setInterval(() => {
            if (this.registryRefreshInFlight) return;
            const refresh = this.registry.refreshNode().catch(error => this.logger.warn('mesh client registry refresh failed', { error }));
            this.registryRefreshInFlight = refresh;
            void refresh.finally(() => {
                if (this.registryRefreshInFlight === refresh) this.registryRefreshInFlight = undefined;
            });
        }, this.registryRefreshIntervalMs);
        this.registryRefreshTimer.unref?.();
        this.orphanRetryTimer = setInterval(() => this.retryOrphanCallbacks(), this.registryRefreshIntervalMs);
        this.orphanRetryTimer.unref?.();
        void this.drainDurableOrphans();
    }

    async stop(): Promise<void> {
        return this.serializeLifecycle(() => this.doStop());
    }

    /**
     * Best-effort exact-node sweep that retains the cleanup obligation. Lease
     * loss uses this before consumer mutation barriers have necessarily
     * settled; cleanupRegistryOwnership() performs the final sweep.
     */
    private async sweepRegistryOwnership(): Promise<void> {
        return this.serializeLifecycle(async () => {
            if (this.registryCleanupNodeId === undefined) return;
            await this.registry.cleanupNode(this.registryCleanupNodeId);
        });
    }

    /** @internal Removes retained registry ownership without stopping MeshService (safe from lease-loss callbacks). */
    async cleanupRegistryOwnership(): Promise<void> {
        return this.serializeLifecycle(async () => {
            const nodeId = this.registryCleanupNodeId;
            if (nodeId === undefined) return;
            await this.registry.cleanupNode(nodeId);
            if (this.registryCleanupNodeId === nodeId) this.registryCleanupNodeId = undefined;
        });
    }

    private async doStop(): Promise<void> {
        const shutdownFence = this.shutdownFencePromise;
        // The synchronous shutdown fence can stop MeshService (and reset its
        // instance ID) before this serialized service cleanup runs. Retain the
        // registry cleanup obligation for any lifecycle that reached ownership;
        // MeshClientRegistry keeps its assigned node ID independently.
        if (!this.running && this.mesh.instanceId === 0 && this.registryCleanupNodeId === undefined) {
            await shutdownFence;
            if (this.shutdownFencePromise === shutdownFence) this.shutdownFencePromise = undefined;
            return;
        }
        this.running = false;
        this.ownershipGeneration++;
        this.stopRegistryTimers();
        const active = this.activeDurableOrphan;
        if (active && this.backend.nackOrphaned) await this.backend.nackOrphaned(active.id, active.claimToken).catch(() => {});
        if (this.orphanDrainInFlight) await settleClientWork(this.orphanDrainInFlight, 2_000);
        try {
            // Clean up our own clients
            if (this.registryCleanupNodeId !== undefined) {
                await this.registry.cleanupNode(this.registryCleanupNodeId);
                this.registryCleanupNodeId = undefined;
            }
        } finally {
            // A synchronous shutdown fence may already own the MeshService
            // stop. Do not invoke a second physical stop while preserving its
            // rejection for the caller that completes cleanup.
            const meshStop = this.shutdownFencePromise ?? this.mesh.stop();
            try {
                await meshStop;
            } finally {
                if (this.shutdownFencePromise === meshStop) this.shutdownFencePromise = undefined;
            }
        }
    }

    private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.lifecycle.then(operation, operation);
        this.lifecycle = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    private stopRegistryTimers(): void {
        if (this.registryRefreshTimer) {
            clearInterval(this.registryRefreshTimer);
            this.registryRefreshTimer = undefined;
        }
        if (this.orphanRetryTimer) {
            clearInterval(this.orphanRetryTimer);
            this.orphanRetryTimer = undefined;
        }
    }

    private meshLeaseSafe(): boolean {
        try {
            this.mesh.assertLeaseSafe();
            return true;
        } catch {
            return false;
        }
    }

    private hasDurableOrphanBackend(): boolean {
        return Boolean(
            this.backend.cleanupNodeAndEnqueueOrphaned && this.backend.claimOrphaned && this.backend.ackOrphaned && this.backend.nackOrphaned
        );
    }

    private cleanupNodeForFallback(nodeId: number): Promise<void> {
        const cleanup = this.fallbackCleanupLifecycle.then(async () => {
            this.pruneFallbackOrphans();
            if (this.pendingOrphanCallbacks.has(nodeId)) return;
            if (!this.backend.cleanupNodeForFallback) {
                throw new Error('Mesh client registry backend lacks atomic bounded fallback cleanup');
            }
            const remainingItems = this.maxPendingOrphanItems - this.pendingOrphanCallbacks.size;
            const remainingBytes = this.maxPendingOrphanBytes - this.pendingOrphanBytes;
            const orphaned = await this.backend.cleanupNodeForFallback(nodeId, remainingItems, remainingBytes);
            if (orphaned.length === 0) return;
            this.enqueueFallbackOrphan(nodeId, orphaned);
        });
        this.fallbackCleanupLifecycle = cleanup.catch(() => {});
        return cleanup;
    }

    private retryOrphanCallbacks(): void {
        this.pruneFallbackOrphans();
        for (const nodeId of this.pendingOrphanCallbacks.keys()) {
            void this.deliverOrphanCallbacks(nodeId);
        }
        void this.drainDurableOrphans();
    }

    private enqueueFallbackOrphan(nodeId: number, orphaned: RegisteredClient<TMeta>[]): void {
        if (orphaned.length === 0) return;
        this.pruneFallbackOrphans();
        const encoded = JSON.stringify(orphaned);
        const bytes = Buffer.byteLength(encoded);
        const previous = this.pendingOrphanCallbacks.get(nodeId);
        const previousBytes = previous?.bytes ?? 0;
        if (
            (!previous && this.pendingOrphanCallbacks.size >= this.maxPendingOrphanItems) ||
            this.pendingOrphanBytes - previousBytes + bytes > this.maxPendingOrphanBytes
        ) {
            // This exception reaches MeshService cleanup, which NACKs its
            // source obligation.  Never replace or silently discard a
            // fallback snapshot when the bounded queue is full.
            throw new Error('Mesh client fallback orphan queue is full');
        }
        this.pendingOrphanCallbacks.set(nodeId, { encoded, bytes, expiresAt: Date.now() + this.pendingOrphanTtlMs });
        this.pendingOrphanBytes += bytes - previousBytes;
    }

    private pruneFallbackOrphans(now = Date.now()): void {
        for (const [nodeId, obligation] of this.pendingOrphanCallbacks) {
            if (obligation.expiresAt > now) continue;
            this.removeFallbackOrphan(nodeId, obligation);
        }
    }

    private removeFallbackOrphan(nodeId: number, obligation: { encoded: string; bytes: number; expiresAt: number }): boolean {
        if (this.pendingOrphanCallbacks.get(nodeId) !== obligation) return false;
        this.pendingOrphanCallbacks.delete(nodeId);
        this.pendingOrphanBytes -= obligation.bytes;
        return true;
    }

    private deliverOrphanCallbacks(nodeId: number): Promise<void> {
        const existing = this.fallbackDeliveryInFlight.get(nodeId);
        if (existing) return existing;
        const delivery = this.doDeliverOrphanCallbacks(nodeId);
        this.fallbackDeliveryInFlight.set(nodeId, delivery);
        void delivery.finally(() => {
            if (this.fallbackDeliveryInFlight.get(nodeId) === delivery) this.fallbackDeliveryInFlight.delete(nodeId);
        });
        return delivery;
    }

    private async doDeliverOrphanCallbacks(nodeId: number): Promise<void> {
        const obligation = this.pendingOrphanCallbacks.get(nodeId);
        if (!obligation) return;
        const generation = this.ownershipGeneration;
        const enforceFence = this.hasStarted || this.running;
        const canContinue = () => !enforceFence || this.isOwnershipGenerationSafe(generation);
        if (!canContinue()) return;
        try {
            if (obligation.encoded === '[]') {
                this.removeFallbackOrphan(nodeId, obligation);
                return;
            }
            for (const cb of this.nodeCleanedUpCallbacks) {
                if (!canContinue() || this.pendingOrphanCallbacks.get(nodeId) !== obligation) return;
                await cb(nodeId, JSON.parse(obligation.encoded) as RegisteredClient<TMeta>[]);
                if (!canContinue() || this.pendingOrphanCallbacks.get(nodeId) !== obligation) return;
            }
            if (!canContinue()) return;
            this.removeFallbackOrphan(nodeId, obligation);
        } catch (error) {
            // Retain the exact active-only snapshot and retry. This avoids a
            // transient consumer failure turning a dead-node cleanup into an
            // immortal orphan record or silently dropping its notification.
            if (this.pendingOrphanCallbacks.get(nodeId) === obligation) {
                this.logger.warn('node cleanup callback error; will retry', { error, nodeId });
            }
        }
    }

    private async drainDurableOrphans(): Promise<void> {
        if (!this.hasDurableOrphanBackend() || this.orphanDrainInFlight) {
            return this.orphanDrainInFlight;
        }
        const drain = (async () => {
            try {
                const generation = this.ownershipGeneration;
                const enforceFence = this.hasStarted || this.running;
                const canContinue = () => !enforceFence || (this.running && generation === this.ownershipGeneration && this.meshLeaseSafe());
                for (;;) {
                    if (!canContinue()) return;
                    const item = await this.backend.claimOrphaned!(this.orphanClaimerId);
                    if (!canContinue()) {
                        if (item) await this.backend.nackOrphaned!(item.id, item.claimToken).catch(() => {});
                        return;
                    }
                    if (!item) return;
                    this.activeDurableOrphan = { id: item.id, claimToken: item.claimToken };
                    try {
                        for (const callback of this.nodeCleanedUpCallbacks) {
                            if (!canContinue()) throw new Error('Mesh client orphan drain was fenced');
                            await callback(item.nodeId, item.clients);
                            if (!canContinue()) throw new Error('Mesh client orphan drain was fenced');
                        }
                        if (!canContinue()) throw new Error('Mesh client orphan drain was fenced');
                        if (!(await this.backend.ackOrphaned!(item.id, item.claimToken))) {
                            throw new Error('Lost durable orphan delivery claim before acknowledgement');
                        }
                    } catch (error) {
                        await this.backend.nackOrphaned!(item.id, item.claimToken).catch(() => {});
                        this.logger.warn('durable node cleanup callback error; will retry', { error, nodeId: item.nodeId });
                        return;
                    } finally {
                        if (this.activeDurableOrphan?.id === item.id && this.activeDurableOrphan.claimToken === item.claimToken) {
                            this.activeDurableOrphan = undefined;
                        }
                    }
                }
            } catch (error) {
                // Claim and parse failures are background failures too. Keep
                // the Redis obligation intact; a claimed item becomes
                // available again when its server-time lease expires.
                this.logger.warn('durable orphan drain failed; will retry', { error });
            }
        })();
        this.orphanDrainInFlight = drain;
        try {
            await drain;
        } finally {
            if (this.orphanDrainInFlight === drain) this.orphanDrainInFlight = undefined;
        }
    }

    /**
     * Register a client on this node. Returns true if registered, false if
     * another node owns the client and `allowSupersede` is false (conflict).
     */
    async registerClient(clientId: string, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<boolean> {
        const metadataSnapshot = this.validateClientRecord(clientId, metadata);
        if (this.admissionFenced) return false;
        if (!this.running) return !this.hasStarted;
        return this.takeOwnership(clientId, metadataSnapshot, 'active', allowSupersede, connectionId);
    }

    /**
     * Reserve ownership of a clientId without exposing it for lookup/invoke
     * until activation completes.
     */
    async reserveClient(clientId: string, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<boolean> {
        const metadataSnapshot = this.validateClientRecord(clientId, metadata);
        if (this.admissionFenced) return false;
        if (!this.running) return !this.hasStarted;
        return this.takeOwnership(clientId, metadataSnapshot, 'pending', allowSupersede, connectionId);
    }

    private async takeOwnership(
        clientId: string,
        metadata: TMeta,
        state: MeshClientRegistrationState,
        allowSupersede: boolean,
        connectionId: string
    ): Promise<boolean> {
        const generation = this.ownershipGeneration;
        const canCommit = () => this.isOwnershipGenerationSafe(generation);
        if (!canCommit()) return false;
        const claimOperationId = randomUUID();
        const claimDeadlineAt = Date.now() + this.ownershipClaimDeadlineMs;
        const claim = await this.createOwnershipClaim(clientId, metadata, state, allowSupersede, connectionId, claimOperationId, claimDeadlineAt);
        if (claim) {
            if (claim.status === 'conflict') return false;
            let fencedPrevious = false;
            try {
                if (!canCommit()) return false;
                if (claim.previous) {
                    if (!(await this.fencePreviousOwner(claim.previous, claimDeadlineAt))) return false;
                    fencedPrevious = true;
                }
                if (!canCommit()) return false;
                // The old generation was synchronously closed and acknowledged;
                // only now does Redis publish the new active/pending record.
                if (!canCommit()) return false;
                const committed = await this.commitOwnershipClaim(
                    clientId,
                    claim.claimId,
                    state,
                    connectionId,
                    fencedPrevious ? claim.previous : undefined
                );
                if (committed && !canCommit()) {
                    // A lease loss racing Redis' atomic commit is repaired by
                    // exact-claim removal before this call reports success.
                    await this.registry.removeClaimResult(clientId, claim.claimId);
                    return false;
                }
                return committed;
            } finally {
                if (fencedPrevious && !canCommit() && claim.previous) {
                    await this.registry.removeClaimPrevious(clientId, claim.claimId).catch(() => {});
                }
                await this.registry.abortClaim(clientId, claim.claimId).catch(error => {
                    this.logger.warn('failed to abort uncommitted mesh client claim', { error, clientId });
                });
            }
        }

        return false;
    }

    private async createOwnershipClaim(
        clientId: string,
        metadata: TMeta,
        state: MeshClientRegistrationState,
        allowSupersede: boolean,
        connectionId: string,
        operationId: string,
        deadlineAt: number
    ) {
        const errors: unknown[] = [];
        while (Date.now() < deadlineAt) {
            try {
                return await withinClientDeadline(
                    this.registry.claim(clientId, metadata, state, allowSupersede, connectionId, operationId),
                    deadlineAt,
                    clientId
                );
            } catch (error) {
                errors.push(error);
                if (Date.now() >= deadlineAt) break;
                await pauseOwnershipRetry(deadlineAt, this.ownershipRetryIntervalMs);
            }
        }
        const ambiguity = new AggregateError(errors, `Unable to reconcile exact mesh client claim creation for ${clientId}`);
        await this.fenceClaimAmbiguity(ambiguity);
        throw ambiguity;
    }

    private async commitOwnershipClaim(
        clientId: string,
        claimId: string,
        state: MeshClientRegistrationState,
        connectionId: string,
        fencedPrevious: MeshClientRecord<TMeta> | undefined
    ): Promise<boolean> {
        const errors: unknown[] = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const result = await this.registry.commitClaim(clientId, claimId);
                if (result === true) return true;
                if (result === 'previous-changed') {
                    if (!fencedPrevious) return false;
                    try {
                        if ((await this.registry.removeClaimPrevious(clientId, claimId)) !== true) {
                            errors.push(new Error(`Unable to remove changed fenced mesh client generation for ${clientId}`));
                        }
                    } catch (error) {
                        errors.push(error);
                        continue;
                    }
                }
            } catch (error) {
                errors.push(error);
            }

            try {
                const current = await this.registry.getClientIncludingPending(clientId);
                if (this.isCommittedClaim(current, claimId, state, connectionId)) return true;
            } catch (error) {
                errors.push(error);
            }
        }

        if (fencedPrevious && !(await this.removeFencedClaimPrevious(clientId, claimId, fencedPrevious, errors))) {
            const ambiguity = new AggregateError(errors, `Unable to remove fenced mesh client generation for ${clientId}`);
            await this.fenceClaimAmbiguity(ambiguity);
            throw ambiguity;
        }

        // A repeated commit could have applied despite every reply failing.
        // Before reporting a definite failure, remove or disprove the exact
        // claim result. Cleanup itself is retried because its first response
        // can fail before or after the atomic mutation.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const removed = await this.registry.removeClaimResult(clientId, claimId);
                if (removed === true) return false;
            } catch (error) {
                errors.push(error);
            }
            try {
                const current = await this.registry.getClientIncludingPending(clientId);
                if (this.isCommittedClaim(current, claimId, state, connectionId)) continue;
                return false;
            } catch (error) {
                errors.push(error);
            }
        }

        const ambiguity = new AggregateError(errors, `Unable to reconcile exact mesh client claim commit for ${clientId}`);
        await this.fenceClaimAmbiguity(ambiguity);
        throw ambiguity;
    }

    private async removeFencedClaimPrevious(
        clientId: string,
        claimId: string,
        previous: MeshClientRecord<TMeta>,
        errors: unknown[]
    ): Promise<boolean> {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if ((await this.registry.removeClaimPrevious(clientId, claimId)) === true) return true;
            } catch (error) {
                errors.push(error);
            }
            try {
                const current = await this.registry.getClientIncludingPending(clientId);
                // Absence, the newly committed claim, or a later reconnect all
                // prove that the physically-fenced predecessor is no longer
                // current. Never delete the latter two.
                if (!current || current.claimId === claimId || !this.isSameClientGeneration(current, previous)) return true;
            } catch (error) {
                errors.push(error);
            }
        }
        return false;
    }

    private isSameClientGeneration(first: MeshClientRecord<TMeta>, second: MeshClientRecord<TMeta>): boolean {
        if (first.nodeId !== second.nodeId || first.connectionId !== second.connectionId) return false;
        if (first.claimId !== undefined || second.claimId !== undefined) return first.claimId === second.claimId;
        return first.connectedAt === second.connectedAt;
    }

    private isCommittedClaim(
        current: MeshClientRecord<TMeta> | undefined,
        claimId: string,
        state: MeshClientRegistrationState,
        connectionId: string
    ): boolean {
        return (
            current?.nodeId === this.mesh.instanceId &&
            current.connectionId === connectionId &&
            current.state === state &&
            current.claimId === claimId
        );
    }

    private async fenceClaimAmbiguity(reason: Error): Promise<void> {
        if (this.running) {
            this.running = false;
            this.ownershipGeneration++;
            this.stopRegistryTimers();
        }
        // Revoke the underlying MeshService synchronously before arbitrary
        // stream/user callbacks can stall physical shutdown. Forward handlers
        // assert this exact lease fence before every side effect.
        await this.mesh.fence(reason);
        await this.registry.cleanupNode().catch(error => {
            this.logger.error('failed to clean registry after an indeterminate mesh client claim commit', { error });
        });
        // Stopping removes all records for this node and revokes its mesh
        // membership, so an unresolved exact claim cannot remain deliverable.
        await this.stop().catch(error => {
            this.logger.error('failed to stop after an indeterminate mesh client claim commit', { error });
        });
    }

    private async fencePreviousOwner(previous: MeshClientRecord<TMeta>, deadlineAt: number): Promise<boolean> {
        if (previous.nodeId === this.mesh.instanceId) {
            let fenced = false;
            for (const callback of this.clientSupersededCallbacks) {
                this.mesh.assertLeaseSafe();
                if ((await callback(previous.clientId, previous.connectionId, 'supersede')) !== false) fenced = true;
                this.mesh.assertLeaseSafe();
            }
            return fenced;
        }
        let indeterminate = false;
        while (Date.now() < deadlineAt) {
            try {
                const fenced = await this.requireRemoteTransport(previous.clientId).fenceClient(previous.nodeId, {
                    clientId: previous.clientId,
                    connectionId: previous.connectionId,
                    reason: 'supersede',
                    timeoutMs: remainingOwnershipDeadline(deadlineAt, previous.clientId)
                });
                if (fenced) return true;
                if (!indeterminate) return false;
            } catch (error) {
                if (!(error instanceof SrpcIndeterminateDeliveryError)) {
                    this.logger.warn('failed to fence superseded mesh client generation', { error, clientId: previous.clientId });
                    return false;
                }
                indeterminate = true;
            }

            try {
                const current = await withinClientDeadline(this.registry.getClientIncludingPending(previous.clientId), deadlineAt, previous.clientId);
                if (!current || !this.isSameClientGeneration(current, previous)) return true;
            } catch (error) {
                if (Date.now() >= deadlineAt) {
                    this.logger.warn('failed to reconcile superseded mesh client generation', { error, clientId: previous.clientId });
                    return false;
                }
            }
            await pauseOwnershipRetry(deadlineAt, this.ownershipRetryIntervalMs);
        }
        return false;
    }

    /**
     * Promote a same-node reservation to an active, discoverable client.
     */
    async activateClient(clientId: string, metadata: TMeta, connectionId: string): Promise<boolean> {
        if (this.admissionFenced) return false;
        const generation = this.ownershipGeneration;
        const canCommit = () => this.isOwnershipGenerationSafe(generation);
        if (!canCommit()) return false;
        const activated = await this.registry.activate(clientId, metadata, connectionId);
        if (!activated) return false;
        if (canCommit()) return true;
        // Activation raced lease loss/stop. Remove only the generation this
        // call promoted, never a replacement that may already own clientId.
        await this.registry.unregister(clientId, connectionId).catch(error => {
            this.logger.warn('failed to repair activation after ownership loss', { error, clientId, connectionId });
        });
        return false;
    }

    async unregisterClient(clientId: string, connectionId: string): Promise<boolean> {
        if (!this.running) return false;
        const key = `${clientId}\u0000${connectionId}`;
        const existing = this.exactUnregisterObligations.get(key);
        if (existing) return existing;
        if (this.exactUnregisterObligations.size >= MaxExactUnregisterObligations) {
            const error = new Error('Too many pending exact mesh client unregister obligations');
            await this.fenceClaimAmbiguity(error);
            throw error;
        }

        const previous = this.exactUnregisterClientChains.get(clientId) ?? Promise.resolve();
        const generation = this.ownershipGeneration;
        const obligation = previous.then(
            () => this.retryExactUnregister(clientId, connectionId, generation),
            () => this.retryExactUnregister(clientId, connectionId, generation)
        );
        const tail = obligation.then(
            () => undefined,
            () => undefined
        );
        this.exactUnregisterObligations.set(key, obligation);
        this.exactUnregisterClientChains.set(clientId, tail);
        try {
            return await obligation;
        } finally {
            if (this.exactUnregisterObligations.get(key) === obligation) this.exactUnregisterObligations.delete(key);
            if (this.exactUnregisterClientChains.get(clientId) === tail) this.exactUnregisterClientChains.delete(clientId);
        }
    }

    private async retryExactUnregister(clientId: string, connectionId: string, generation: number): Promise<boolean> {
        const errors: unknown[] = [];
        const deadlineAt = Date.now() + this.exactUnregisterDeadlineMs;
        while (Date.now() < deadlineAt) {
            if (!this.isOwnershipGenerationSafe(generation)) return false;
            try {
                if (await withinClientDeadline(this.registry.unregister(clientId, connectionId), deadlineAt, clientId)) return true;
            } catch (error) {
                errors.push(error);
            }
            if (Date.now() >= deadlineAt) break;
            try {
                const current = await withinClientDeadline(this.registry.getClientIncludingPending(clientId), deadlineAt, clientId);
                if (!current || current.nodeId !== this.mesh.instanceId || current.connectionId !== connectionId) return true;
            } catch (error) {
                errors.push(error);
            }
            await pauseOwnershipRetry(deadlineAt, this.ownershipRetryIntervalMs);
        }
        const ambiguity = new AggregateError(errors, `Unable to confirm exact mesh client unregister for ${clientId}`);
        await this.fenceClaimAmbiguity(ambiguity);
        throw ambiguity;
    }

    private isOwnershipGenerationSafe(generation: number): boolean {
        if (!this.running || this.ownershipGeneration !== generation) return false;
        try {
            this.mesh.assertLeaseSafe();
            return this.running && this.ownershipGeneration === generation;
        } catch {
            return false;
        }
    }

    async updateClientMetadata(clientId: string, metadata: TMeta, connectionId?: string): Promise<boolean> {
        this.validateClientRecord(clientId, metadata);
        if (!this.running) return false;
        const generation = this.ownershipGeneration;
        const canMutate = () => this.isOwnershipGenerationSafe(generation);

        const client = await this.registry.getClient(clientId);
        if (!client || !canMutate()) return false;

        // Local - apply to stream.meta and update registry directly.
        if (client.nodeId === this.mesh.instanceId) {
            const fencedConnectionId = connectionId ?? client.connectionId;
            const update = this.projectClientMetadata(clientId, metadata, fencedConnectionId);
            if (!update.updated) return false;
            this.mesh.assertLeaseSafe();
            const updated = await this.registry.updateMetadata(clientId, update.metadata, fencedConnectionId);
            if (!updated || !canMutate()) return false;
            this.mesh.assertLeaseSafe();
            return this.applyClientMetadata(clientId, metadata, fencedConnectionId);
        }

        // Remote - route through the authenticated mesh link and always include
        // the observed connection generation so old owners fail closed.
        try {
            if (connectionId !== undefined && client.connectionId !== connectionId) return false;
            const fencedConnectionId = connectionId ?? client.connectionId;
            return await this.requireRemoteTransport(clientId).updateClientMetadata(client.nodeId, {
                clientId,
                metadata,
                connectionId: fencedConnectionId
            });
        } catch (err) {
            this.logger.warn('cross-pod metadata update failed', {
                err,
                clientId,
                targetNodeId: client.nodeId
            });
            return false;
        }
    }

    private projectClientMetadata(clientId: string, metadata: unknown, connectionId?: string): { updated: boolean; metadata: TMeta } {
        if (this.clientProjectMetaFn) return this.clientProjectMetaFn(clientId, metadata, connectionId);
        const typedMetadata = metadata as TMeta;
        return { updated: true, metadata: typedMetadata };
    }

    private applyClientMetadata(clientId: string, metadata: unknown, connectionId?: string): boolean {
        if (this.clientApplyMetaFn) return this.clientApplyMetaFn(clientId, metadata, connectionId);
        if (this.clientUpdateMetaFn) return this.clientUpdateMetaFn(clientId, metadata as TMeta);
        return true;
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

    async invoke(clientId: string, type: string, data: unknown, timeoutMs?: number, connectionId?: string): Promise<unknown> {
        this.validateClientId(clientId);
        if (timeoutMs !== undefined) assertSafeTimerMs(timeoutMs, 'Mesh client invocation timeout');
        if (!this.running) {
            throw new ClientNotFoundError(clientId);
        }

        const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
        const remaining = (): number | undefined => {
            if (deadline === undefined) return undefined;
            const value = deadline - Date.now();
            if (value <= 0) throw new ClientInvocationError(`Client invocation timed out: ${clientId}`);
            return value;
        };

        const client = await withinClientDeadline(this.registry.getClient(clientId), deadline, clientId);
        if (!this.running) throw new ClientNotFoundError(clientId);
        if (!client) {
            throw new ClientNotFoundError(clientId);
        }
        if (connectionId !== undefined && client.connectionId !== connectionId) {
            throw new ClientDisconnectedError(clientId);
        }

        // Local delivery
        if (client.nodeId === this.mesh.instanceId) {
            this.mesh.assertLeaseSafe();
            return withinClientDeadline(
                this.clientInvokeFn(clientId, type, data, remaining(), connectionId ?? client.connectionId),
                deadline,
                clientId
            );
        }

        const fencedConnectionId = connectionId ?? client.connectionId;
        return withinClientDeadline(
            this.requireRemoteTransport(clientId).invokeClient(client.nodeId, {
                clientId,
                type,
                data,
                timeoutMs: remaining(),
                ...(deadline !== undefined ? { deadlineAt: deadline } : {}),
                connectionId: fencedConnectionId
            }),
            deadline,
            clientId
        );
    }

    async disconnectClient(clientId: string, connectionId?: string, reason?: string): Promise<boolean> {
        const generation = this.ownershipGeneration;
        const canDisconnect = () => this.isOwnershipGenerationSafe(generation);
        if (!canDisconnect()) return false;
        const client = await this.registry.getClient(clientId);
        if (!canDisconnect() || !client || (connectionId !== undefined && client.connectionId !== connectionId)) return false;
        if (client.nodeId === this.mesh.instanceId) {
            const fencedConnectionId = connectionId ?? client.connectionId;
            let kicked = false;
            for (const callback of this.clientSupersededCallbacks) {
                if (!canDisconnect()) return false;
                if ((await callback(clientId, fencedConnectionId, reason)) !== false) kicked = true;
                if (!canDisconnect()) return false;
            }
            return kicked;
        }
        const fencedConnectionId = connectionId ?? client.connectionId;
        if (!canDisconnect()) return false;
        const fenced = await this.requireRemoteTransport(clientId).fenceClient(client.nodeId, {
            clientId,
            connectionId: fencedConnectionId,
            reason
        });
        return canDisconnect() && fenced;
    }

    private requireRemoteTransport(clientId: string): MeshClientRemoteTransport<TMeta> {
        if (this.remoteTransport) return this.remoteTransport;
        throw new ClientInvocationError(`Direct mesh-link transport is required for remote client operation: ${clientId}`);
    }

    private validateClientRecord(clientId: string, metadata: TMeta): TMeta {
        this.validateClientId(clientId);
        const encoded = JSON.stringify(metadata);
        if (encoded === undefined) throw new Error('Mesh client metadata must be JSON-serializable');
        if (Buffer.byteLength(encoded) > this.maxMetadataBytes) {
            throw new Error(`Mesh client metadata exceeds the configured ${this.maxMetadataBytes}-byte limit`);
        }
        return JSON.parse(encoded) as TMeta;
    }

    private validateClientId(clientId: string): void {
        if (!clientId || Buffer.byteLength(clientId) > this.maxClientIdBytes) {
            throw new Error(`Mesh client ID must contain between 1 and ${this.maxClientIdBytes} UTF-8 bytes`);
        }
    }
}

async function withinClientDeadline<T>(promise: Promise<T>, deadlineAt: number | undefined, clientId: string): Promise<T> {
    if (deadlineAt === undefined) return promise;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ClientInvocationError(`Client invocation timed out: ${clientId}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new ClientInvocationError(`Client invocation timed out: ${clientId}`)), remaining);
                timer.unref?.();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function configuredServiceLimit(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new Error(`Mesh client service ${name} must be a positive integer`);
    }
    return resolved;
}

function remainingOwnershipDeadline(deadlineAt: number, clientId: string): number {
    const remaining = Math.ceil(deadlineAt - Date.now());
    if (remaining <= 0) throw new ClientInvocationError(`Mesh client ownership operation timed out: ${clientId}`);
    return remaining;
}

async function pauseOwnershipRetry(deadlineAt: number, intervalMs: number): Promise<void> {
    const delay = Math.min(intervalMs, Math.max(0, deadlineAt - Date.now()));
    if (delay <= 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, delay));
}

async function settleClientWork(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    await Promise.race([
        promise.then(
            () => undefined,
            () => undefined
        ),
        new Promise<void>(resolve => {
            const timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        })
    ]);
}
