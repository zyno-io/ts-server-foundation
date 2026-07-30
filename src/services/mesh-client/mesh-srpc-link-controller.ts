import { randomUUID } from 'node:crypto';

import { byteStreamDestroyReason, type SrpcByteStream } from '../../srpc/SrpcByteStream';
import {
    SrpcError,
    SrpcBackpressureError,
    SrpcClientNotFoundError,
    SrpcIndeterminateDeliveryError,
    SrpcStaleConnectionError,
    SrpcMeshAuthenticationError,
    SrpcMeshProtocolError,
    SrpcOwnerUnavailableError,
    SrpcStreamClosedError,
    type SrpcConnection,
    type SrpcMeta,
    type SrpcStream
} from '../../srpc/types';
import type { MeshNode } from '../mesh';
import type { MeshLinkFrame, MeshLinkFrameHeader } from '../mesh-link';
import { MeshLinkPeer, MeshLinkRuntime } from '../mesh-link';
import type { MeshClientRemoteTransport, MeshClientService } from './mesh-client-service';
import { MeshRemoteSrpcConnection, type MeshRemoteConnectionTransport } from './mesh-srpc-remote-connection';
import { ClientDisconnectedError, ClientInvocationError, type RegisteredClient } from './types';

const InitialSenderIdReservationSize = 32;
const SenderIdReservationSize = 32;
const MaxSenderRoutes = 131_072;
const MaxSenderRoutesPerConnection = 512;
const MaxAttachedReceivers = 1_024;
const MaxAttachedReceiversPerConnection = 128;
const MaxRemoteConnections = 4_096;
const MaxEndpointPins = MaxRemoteConnections * 2;
const RemoteConnectionIdleTtlMs = 5 * 60_000;
const MaxListResolutionConcurrency = 16;
const PeerMembershipTtlMs = 30_000;
const RemoteConnectionPruneIntervalMs = 60_000;
const ReservationTtlMs = 30_000;
const MaxReservationTtlMs = 30 * 60_000;
const MaxReservations = 8_192;
const MaxHandleCapabilities = 8_192;
const MaxIssuedSenderGrants = 4_096;
const MaxIssuedSenderGrantsPerCapability = 128;
const HandleCapabilityIdleTtlMs = 10 * 60_000;
const IssuedSenderGrantTtlMs = 30_000;
const TerminalForwardTtlMs = 30_000;
const TerminalSenderRouteTtlMs = 30_000;
const MaxTerminalSenderRoutes = 8_192;
const MaxTerminalForwards = 4_096;
const MaxConcurrentTerminalRetries = 32;
const TerminalRetryTickMs = 250;
const CleanupMarkerMaxAgeMs = 5 * 60_000;

interface SenderRoute {
    clientId: string;
    capability?: string;
    /** True only after the requester authenticated allocation of this ID. */
    active: boolean;
    peerIdentity: string;
    peerProcessId: string;
    peerEndpointId?: string;
    peerPublicKey?: string;
    expiresAt?: number;
}

interface HandleReservation {
    reservationId: string;
    clientId: string;
    connectionId: string;
    capability: string;
    peerIdentity: string;
    peerProcessId: string;
    peerEndpointId?: string;
    peerPublicKey?: string;
    ids: number[];
    expiresAt: number;
    confirmed: boolean;
}

interface HandleCapability {
    clientId: string;
    connectionId: string;
    capability: string;
    peerIdentity: string;
    peerProcessId: string;
    peerEndpointId?: string;
    peerPublicKey?: string;
    requiresExactSenderGrant?: boolean;
    expiresAt: number;
}

interface RevokedRemoteCapability {
    clientId: string;
    connectionId: string;
    peerIdentity: string;
    expiresAt: number;
}

type CapabilityRevocationAuthority<TMeta> =
    | { kind: 'connection'; connection: MeshRemoteSrpcConnection<TMeta> }
    | { kind: 'cleanup'; marker: CleanupMarker }
    | { kind: 'tombstone' };

interface AttachedReceiver {
    receiver: SrpcByteStream;
    clientId: string;
    connectionId: string;
    streamId: number;
    capability?: string;
    peerIdentity: string;
    peerProcessId: string;
    peerEndpointId?: string;
    peerPublicKey?: string;
}

interface CleanupTarget {
    clientId: string;
    connectionId: string;
    ownerNodeId: number;
    ownerProcessId?: string;
    ownerEndpointId?: string;
    ownerEndpointPublicKey?: string;
    capability: string;
}

interface CleanupMarker {
    target: CleanupTarget;
    createdAt?: number;
    attempts?: number;
    nextRetryAt?: number;
    retrying?: Promise<void>;
}

interface TerminalForward {
    processId: string;
    endpointId?: string;
    publicKey?: string;
    header: Omit<MeshLinkFrameHeader, 'version' | 'id'>;
    body: Uint8Array;
    expiresAt: number;
    attempts: number;
    nextRetryAt: number;
    retrying?: Promise<void>;
}

export interface MeshLocalInvokeResult {
    body: Uint8Array;
    issuedSenderIds: number[];
    requiresExactSenderGrant?: boolean;
}

export class MeshLinkCapabilityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MeshLinkCapabilityError';
    }
}

interface RemoteConnectionResolution<TMeta> {
    clientId: string;
    connectionId: string;
    endpointId?: string;
    invalidated: boolean;
    promise: Promise<MeshRemoteSrpcConnection<TMeta>>;
}

export interface MeshSrpcLinkControllerOptions<TMeta extends SrpcMeta, TRegistryMeta> {
    meshKey: string;
    requestTimeoutMs: number;
    runtime: MeshLinkRuntime;
    service: MeshClientService<TRegistryMeta, Record<string, unknown>>;
    getLocalConnection(clientId: string): SrpcStream<TMeta> | undefined;
    /** Includes a pending stream, which is not yet visible in active registry lookups. */
    hasLocalFenceConnection?(clientId: string, connectionId: string): boolean;
    invokeLocal(
        clientId: string,
        connectionId: string,
        prefix: string,
        data: Uint8Array,
        timeoutMs: number
    ): Promise<Uint8Array | MeshLocalInvokeResult>;
    serviceInvokeLocal?(clientId: string, connectionId: string, type: string, data: unknown, timeoutMs: number): Promise<unknown>;
    reserveLocalSenderIds(clientId: string, connectionId: string, count: number): number[];
    writeLocalStream(clientId: string, connectionId: string, streamId: number, data: Uint8Array): Promise<void>;
    finishLocalStream(clientId: string, connectionId: string, streamId: number): Promise<void>;
    destroyLocalStream(clientId: string, connectionId: string, streamId: number, error?: string): Promise<void>;
    attachLocalReceiver(clientId: string, connectionId: string, streamId: number): SrpcByteStream;
    disconnectLocal(clientId: string, connectionId: string, reason?: string): Promise<void | boolean>;
    updateLocalMetadata(clientId: string, connectionId: string, metadata: Partial<TMeta>): Promise<TRegistryMeta | void>;
}

export class MeshSrpcLinkController<TMeta extends SrpcMeta, TRegistryMeta>
    implements MeshRemoteConnectionTransport<TRegistryMeta>, MeshClientRemoteTransport<TRegistryMeta>
{
    private readonly remoteConnections = new Map<string, MeshRemoteSrpcConnection<TRegistryMeta>>();
    private readonly resolvingRemoteConnections = new Map<string, RemoteConnectionResolution<TRegistryMeta>>();
    private readonly senderRoutes = new Map<string, SenderRoute>();
    private readonly terminalSenderRoutes = new Map<string, SenderRoute & { expiresAt: number }>();
    private readonly attachedReceivers = new Map<string, AttachedReceiver>();
    private readonly issuedSenderGrants = new Map<string, SenderRoute>();
    private readonly reservations = new Map<string, HandleReservation>();
    private readonly handleCapabilities = new Map<string, HandleCapability>();
    private readonly revokedRemoteCapabilities = new Map<string, RevokedRemoteCapability>();
    private readonly cleanupMarkers = new Map<string, CleanupMarker>();
    private readonly terminalForwards = new Map<string, TerminalForward>();
    private readonly closedOwnerIdentities = new Set<string>();
    private readonly verifiedPeers = new WeakMap<MeshLinkPeer, { verifiedAt: number }>();
    private readonly verifyingPeers = new WeakMap<MeshLinkPeer, Promise<void>>();
    private readonly unregisterPeerCloseHandler: () => void;
    private readonly unregisterEndpointPinResolver: () => void;
    private readonly endpointPinUnregisters = new Map<string, () => void>();
    private readonly remoteConnectionPruneTimer: ReturnType<typeof setInterval>;
    private readonly terminalRetryTimer: ReturnType<typeof setInterval>;
    private closePromise?: Promise<void>;
    private closed = false;

    constructor(private readonly options: MeshSrpcLinkControllerOptions<TMeta, TRegistryMeta>) {
        this.unregisterEndpointPinResolver =
            options.runtime.registerEndpointPinResolver?.(async (processId, endpointId) => {
                const nodes = await this.options.service.mesh.getNodes();
                const matching = nodes.filter(
                    node => node.processId === processId && node.linkEndpointId === endpointId && node.linkEndpointPublicKey
                );
                const keys = new Set(matching.map(node => node.linkEndpointPublicKey!));
                return keys.size === 1 ? [...keys][0] : undefined;
            }) ?? (() => {});
        this.unregisterPeerCloseHandler = options.runtime.onPeerClosed((processId, endpointId) => {
            this.rememberClosedOwnerIdentity(endpointId || processId);
            for (const connection of this.remoteConnections.values()) {
                if (connection.ownerEndpointId ? connection.ownerEndpointId === endpointId : connection.ownerProcessId === processId) {
                    this.invalidate(connection);
                }
            }
            for (const [key, marker] of this.cleanupMarkers) {
                const target = marker.target;
                if (target.ownerEndpointId ? target.ownerEndpointId !== endpointId : target.ownerProcessId !== processId) {
                    continue;
                }
                this.cleanupMarkers.delete(key);
            }
            for (const [key, route] of this.senderRoutes) {
                if (route.peerIdentity === endpointId || route.peerIdentity === processId) void this.abandonRoute(key, route);
            }
            for (const [key, route] of this.terminalSenderRoutes) {
                if (route.peerIdentity === endpointId || route.peerIdentity === processId) this.terminalSenderRoutes.delete(key);
            }
            for (const [key, terminal] of this.terminalForwards) {
                if (terminal.endpointId ? terminal.endpointId === endpointId : terminal.processId === processId) {
                    this.terminalForwards.delete(key);
                }
            }
            for (const [key, attached] of this.attachedReceivers) {
                if (attached.peerIdentity === endpointId || attached.peerIdentity === processId) {
                    this.attachedReceivers.delete(key);
                    safeDestroy(attached.receiver, new Error('sRPC mesh peer disconnected'));
                }
            }
            this.abandonPeerReservations(processId, endpointId);
            for (const [capability, handle] of this.handleCapabilities) {
                if (handle.peerIdentity === endpointId || handle.peerIdentity === processId) {
                    this.handleCapabilities.delete(capability);
                }
            }
            for (const [capability, revoked] of this.revokedRemoteCapabilities) {
                if (revoked.peerIdentity === endpointId || revoked.peerIdentity === processId) {
                    this.revokedRemoteCapabilities.delete(capability);
                }
            }
            for (const [key, grant] of this.issuedSenderGrants) {
                if (grant.peerIdentity === endpointId || grant.peerIdentity === processId) {
                    this.abandonIssuedSenderGrant(key, grant, 'sRPC mesh peer disconnected');
                }
            }
            this.pruneEndpointPins();
        });
        this.remoteConnectionPruneTimer = setInterval(() => {
            this.pruneRemoteConnections();
            this.pruneReservations();
            this.pruneEndpointPins();
            void this.retryCleanupMarkers();
            void this.retryTerminalForwards();
        }, RemoteConnectionPruneIntervalMs);
        this.remoteConnectionPruneTimer.unref?.();
        this.terminalRetryTimer = setInterval(() => {
            void this.retryTerminalForwards();
        }, TerminalRetryTickMs);
        this.terminalRetryTimer.unref?.();
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.closeInternal();
        return this.closePromise;
    }

    private async closeInternal(): Promise<void> {
        this.closed = true;
        clearInterval(this.remoteConnectionPruneTimer);
        clearInterval(this.terminalRetryTimer);
        const resolving = [...this.resolvingRemoteConnections.values()].map(resolution => resolution.promise);
        for (const resolution of this.resolvingRemoteConnections.values()) resolution.invalidated = true;
        for (const connection of this.remoteConnections.values()) this.releaseAndMarkStale(connection, true);
        this.remoteConnections.clear();
        for (const { receiver } of this.attachedReceivers.values()) safeDestroy(receiver, new Error('sRPC mesh link stopped'));
        this.attachedReceivers.clear();
        const localCleanup: Promise<void>[] = [];
        for (const capability of [...this.handleCapabilities.keys()]) {
            this.removeHandleCapability(capability, 'sRPC mesh link stopped');
        }
        for (const [key, route] of this.senderRoutes) localCleanup.push(this.abandonRoute(key, route));
        for (const [key, grant] of this.issuedSenderGrants) {
            localCleanup.push(this.abandonIssuedSenderGrant(key, grant, 'sRPC mesh link stopped'));
        }
        this.terminalSenderRoutes.clear();
        this.reservations.clear();
        this.handleCapabilities.clear();
        this.revokedRemoteCapabilities.clear();
        await Promise.allSettled(resolving);
        await settleWithin(localCleanup, Math.min(2_000, this.options.requestTimeoutMs));
        await this.drainCleanupMarkers();
        await this.drainTerminalForwards();
        for (const terminal of this.terminalForwards.values()) {
            this.closePinnedPeer(terminal, 'sRPC mesh terminal acknowledgement timed out');
        }
        this.terminalForwards.clear();
        for (const marker of this.cleanupMarkers.values()) {
            this.closeCleanupTargetPeer(marker.target, 'sRPC mesh capability cleanup was not acknowledged');
        }
        this.cleanupMarkers.clear();
        this.unregisterPeerCloseHandler();
        this.unregisterEndpointPinResolver();
        for (const unregister of this.endpointPinUnregisters.values()) unregister();
        this.endpointPinUnregisters.clear();
    }

    async resolveClient(
        clientId: string,
        deadlineAt = Date.now() + this.options.requestTimeoutMs
    ): Promise<SrpcConnection<TMeta | TRegistryMeta> | undefined> {
        const record = await withinDeadline(this.options.service.clientRegistry.getClient(clientId), deadlineAt, clientId);
        if (!record) {
            this.invalidateClientConnections(clientId);
            return undefined;
        }
        const local = this.options.getLocalConnection(clientId);
        if (local?.id === record.connectionId) return local;
        return this.resolveRegisteredClient(record, deadlineAt);
    }

    async listClients(): Promise<SrpcConnection<TMeta | TRegistryMeta>[]> {
        const records = await this.options.service.clientRegistry.listClients();
        const currentConnectionKeys = new Set(
            records.flatMap(record => (record.connectionId ? [connectionKey(record.clientId, record.connectionId)] : []))
        );
        for (const [key, connection] of this.remoteConnections) {
            if (!currentConnectionKeys.has(key)) this.invalidate(connection);
        }
        const clients = await mapWithConcurrency(records, MaxListResolutionConcurrency, async record => {
            const local = this.options.getLocalConnection(record.clientId);
            if (local && local.id === record.connectionId) return local;
            try {
                return await this.resolveRegisteredClient(record);
            } catch (error) {
                if (error instanceof SrpcStaleConnectionError || error instanceof MeshLinkCapabilityError) return undefined;
                throw error;
            }
        });
        return clients.flatMap(client => (client ? [client] : []));
    }

    async invoke(
        connection: SrpcConnection<TMeta | TRegistryMeta>,
        prefix: string,
        data: Uint8Array,
        timeoutMs: number,
        deadlineAt = Date.now() + timeoutMs
    ): Promise<Uint8Array> {
        const local = this.options.getLocalConnection(connection.clientId);
        if (local === connection) {
            return invokeBody(
                await withinDeadline(
                    this.options.invokeLocal(connection.clientId, connection.id, prefix, data, remainingDeadline(deadlineAt, connection.clientId)),
                    deadlineAt,
                    connection.clientId
                )
            );
        }
        if (!(connection instanceof MeshRemoteSrpcConnection)) throw new SrpcStaleConnectionError(connection.clientId);
        await this.assertCurrent(connection, deadlineAt);
        const frame = await this.requestOwner(
            connection,
            {
                type: 'invoke',
                prefix,
                timeoutMs: remainingDeadline(deadlineAt, connection.clientId),
                // Mesh-link frames are authenticated by the peer session; do
                // not let an owner reset this budget after route transit.
                deadlineAt
            },
            data,
            remainingDeadline(deadlineAt, connection.clientId),
            deadlineAt
        );
        if (frame.header.errorName === 'SrpcError')
            throw new SrpcError(frame.header.error ?? 'Remote sRPC invocation failed', frame.header.userError);
        return frame.body;
    }

    async disconnect(connection: MeshRemoteSrpcConnection<TRegistryMeta>, reason?: string): Promise<void> {
        await this.assertCurrent(connection);
        try {
            await this.requestOwner(connection, { type: 'disconnect', reason }, new Uint8Array(), this.options.requestTimeoutMs);
        } finally {
            // A close is terminal from the caller's perspective even when the
            // wire outcome is indeterminate. Preserve the original error but
            // fence this handle and retain owner cleanup for retry.
            this.invalidate(connection);
        }
    }

    /** Generic MeshClientService invocation over the authenticated mesh link. */
    async invokeClient(
        nodeId: number,
        request: { clientId: string; connectionId: string; type: string; data: unknown; timeoutMs?: number; deadlineAt?: number }
    ): Promise<unknown> {
        const deadlineAt = request.deadlineAt ?? Date.now() + (request.timeoutMs ?? this.options.requestTimeoutMs);
        const timeoutMs = Math.min(request.timeoutMs ?? this.options.requestTimeoutMs, remainingDeadline(deadlineAt, request.clientId));
        const response = await this.requestClientOwner(
            nodeId,
            request.clientId,
            request.connectionId,
            { type: 'clientInvoke', timeoutMs, deadlineAt },
            Buffer.from(JSON.stringify({ type: request.type, data: request.data })),
            timeoutMs,
            deadlineAt
        );
        const parsed = JSON.parse(response.body.toString('utf8')) as { data?: unknown; connectionId?: string };
        if (parsed.connectionId !== request.connectionId) throw new SrpcStaleConnectionError(request.clientId);
        return parsed.data;
    }

    /** Exact-generation physical fence used by ownership takeover and close. */
    async fenceClient(nodeId: number, request: { clientId: string; connectionId: string; reason?: string; timeoutMs?: number }): Promise<boolean> {
        const timeoutMs = request.timeoutMs ?? this.options.requestTimeoutMs;
        const response = await this.requestClientOwner(
            nodeId,
            request.clientId,
            request.connectionId,
            { type: 'fenceClient', reason: request.reason, timeoutMs },
            new Uint8Array(),
            timeoutMs
        );
        return (JSON.parse(response.body.toString('utf8')) as { fenced?: unknown }).fenced === true;
    }

    async updateClientMetadata(nodeId: number, request: { clientId: string; connectionId: string; metadata: TRegistryMeta }): Promise<boolean> {
        const response = await this.requestClientOwner(
            nodeId,
            request.clientId,
            request.connectionId,
            { type: 'clientUpdateMetadata' },
            Buffer.from(JSON.stringify({ metadata: request.metadata })),
            this.options.requestTimeoutMs
        );
        return (JSON.parse(response.body.toString('utf8')) as { updated?: unknown }).updated === true;
    }

    async reserveSenderIds(connection: MeshRemoteSrpcConnection<TRegistryMeta>): Promise<number[]> {
        await this.assertCurrent(connection);
        return this.reserveAndConfirm(connection, SenderIdReservationSize);
    }

    async releaseSenderIds(connection: MeshRemoteSrpcConnection<TRegistryMeta>, ids: number[]): Promise<void> {
        if (!ids.length) return;
        if (!isValidReservedIds(ids, MaxSenderRoutesPerConnection)) return;
        const node = await this.options.service.mesh.getNode(connection.ownerNodeId);
        await this.releaseReservation(
            connection.clientId,
            connection.id,
            node,
            ids,
            connection.ownerProcessId,
            connection.ownerEndpointId,
            connection.capability
        );
    }

    private async releaseReservation(
        clientId: string,
        connectionId: string,
        node: MeshNode | undefined,
        ids: number[],
        processId?: string,
        endpointId?: string,
        capability?: string,
        closeCapability = false
    ): Promise<void> {
        if (!node?.linkUrl || (typeof this.options.runtime.pinEndpoint === 'function' && !node.linkEndpointPublicKey)) {
            if (closeCapability) throw new MeshLinkCapabilityError('Remote sRPC owner no longer advertises a direct mesh link');
            return;
        }
        if (ids.length > 0 ? !isValidReservedIds(ids, MaxSenderRoutesPerConnection) : !closeCapability) return;
        await this.options.runtime.request(
            node.linkUrl,
            {
                type: 'releaseStreamIds',
                meshKey: this.options.meshKey,
                clientId,
                connectionId,
                ids,
                capability,
                closeCapability
            },
            new Uint8Array(),
            this.options.requestTimeoutMs,
            processId ?? node.processId,
            endpointId ?? node.linkEndpointId,
            node.linkEndpointPublicKey
        );
    }

    async updateMetadata(connection: MeshRemoteSrpcConnection<TRegistryMeta>, metadata: Partial<TMeta>): Promise<TRegistryMeta> {
        await this.assertCurrent(connection);
        const response = await this.requestOwner(
            connection,
            { type: 'updateMetadata' },
            Buffer.from(JSON.stringify({ metadata })),
            this.options.requestTimeoutMs
        );
        return (JSON.parse(response.body.toString('utf8')) as { metadata: TRegistryMeta }).metadata;
    }

    async writeStream(connection: MeshRemoteSrpcConnection<TRegistryMeta>, streamId: number, data: Uint8Array): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'streamWrite', streamId }, data, this.options.requestTimeoutMs);
    }

    async finishStream(connection: MeshRemoteSrpcConnection<TRegistryMeta>, streamId: number): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'streamFinish', streamId }, new Uint8Array(), this.options.requestTimeoutMs);
    }

    async destroyStream(connection: MeshRemoteSrpcConnection<TRegistryMeta>, streamId: number, error?: unknown): Promise<void> {
        if (!connection.connected) return;
        await this.requestOwner(
            connection,
            { type: 'streamDestroy', streamId, reason: byteStreamDestroyReason(error) },
            new Uint8Array(),
            this.options.requestTimeoutMs
        );
    }

    private async reserveAndConfirm(connection: MeshRemoteSrpcConnection<TRegistryMeta>, count: number): Promise<number[]> {
        const deadlineAt = Date.now() + this.options.requestTimeoutMs;
        const reservationId = randomUUID();
        const response = await this.retryReservation(() =>
            this.requestOwner(
                connection,
                { type: 'reserveStreamIds', count, reservationId },
                new Uint8Array(),
                remainingDeadline(deadlineAt, connection.clientId),
                deadlineAt
            )
        );
        if (response.header.capability !== connection.capability) throw new SrpcMeshAuthenticationError('Invalid sRPC mesh reservation capability');
        const ids = validateReservedIds(response.header.ids, count);
        try {
            await this.retryReservation(() =>
                this.requestOwner(
                    connection,
                    { type: 'confirmStreamIds', reservationId },
                    new Uint8Array(),
                    remainingDeadline(deadlineAt, connection.clientId),
                    deadlineAt
                )
            );
        } catch (error) {
            this.invalidate(connection);
            throw error;
        }
        return ids;
    }

    private async retryReservation(request: () => Promise<MeshLinkFrame>): Promise<MeshLinkFrame> {
        try {
            return await request();
        } catch (error) {
            if (!(error instanceof SrpcIndeterminateDeliveryError)) throw error;
            return request();
        }
    }

    async attachReceiver(connection: MeshRemoteSrpcConnection<TRegistryMeta>, streamId: number): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'streamAttach', streamId }, new Uint8Array(), this.options.requestTimeoutMs);
    }

    async activateSender(connection: MeshRemoteSrpcConnection<TRegistryMeta>, streamId: number): Promise<void> {
        try {
            await this.assertCurrent(connection);
            await this.requestOwner(connection, { type: 'streamActivate', streamId }, new Uint8Array(), this.options.requestTimeoutMs);
        } catch (error) {
            this.invalidate(connection);
            throw error;
        }
    }

    async route(peer: MeshLinkPeer, frame: MeshLinkFrame): Promise<MeshLinkFrame> {
        this.assertOpen();
        this.assertLeaseSafe();
        const header = frame.header;
        const receivedInvokeDeadlineAt =
            header.type === 'invoke' || header.type === 'clientInvoke'
                ? validatedFrameDeadline(
                      header.deadlineAt,
                      header.timeoutMs,
                      typeof header.clientId === 'string' ? header.clientId : 'unknown',
                      Date.now()
                  )
                : undefined;
        // The WebSocket handshake authenticates the endpoint. Fresh membership
        // is required before a new invocation, reservation, or client-control
        // side effect; established byte-stream frames use a bounded cache so a
        // large stream does not perform one Redis lookup per chunk.
        await this.verifyPeerMembership(
            peer,
            header.type === 'invoke' ||
                header.type === 'reserveStreamIds' ||
                header.type === 'disconnect' ||
                header.type === 'updateMetadata' ||
                header.type === 'clientInvoke' ||
                header.type === 'fenceClient' ||
                header.type === 'clientUpdateMetadata'
        );
        this.assertLeaseSafe();
        if (!peer.connected) throw new SrpcStaleConnectionError(frame.header.clientId ?? 'unknown');
        const clientId = requiredString(header.clientId, 'clientId');
        const connectionId = requiredString(header.connectionId, 'connectionId');
        const streamId = header.streamId;
        const local = this.options.getLocalConnection(clientId);
        this.pruneReservations();

        let revocationAuthority: CapabilityRevocationAuthority<TRegistryMeta> | undefined;
        if (
            header.type !== 'reserveStreamIds' &&
            header.type !== 'confirmStreamIds' &&
            header.type !== 'releaseStreamIds' &&
            header.type !== 'revokeCapability' &&
            header.type !== 'clientInvoke' &&
            header.type !== 'fenceClient' &&
            header.type !== 'clientUpdateMetadata'
        ) {
            this.assertFrameCapability(peer, header, clientId, connectionId);
        }
        if (header.type === 'revokeCapability') {
            revocationAuthority = this.assertCapabilityRevocation(peer, header, clientId, connectionId);
        }

        switch (header.type) {
            case 'clientInvoke': {
                if (local?.id !== connectionId) throw new SrpcStaleConnectionError(clientId);
                const request = JSON.parse(frame.body.toString('utf8')) as { type?: unknown; data?: unknown };
                if (typeof request.type !== 'string' || request.type.length === 0) {
                    throw new SrpcMeshProtocolError('Invalid mesh client invocation type');
                }
                this.assertLeaseSafe();
                const invokeLocal = this.options.serviceInvokeLocal;
                if (!invokeLocal) throw new MeshLinkCapabilityError('Local mesh client invocation is not configured');
                const result = await invokeLocal(
                    clientId,
                    connectionId,
                    request.type,
                    request.data,
                    remainingDeadline(receivedInvokeDeadlineAt!, clientId)
                );
                this.assertLeaseSafe();
                return {
                    header: { type: 'result' },
                    body: Buffer.from(JSON.stringify({ data: result, connectionId }))
                };
            }
            case 'fenceClient': {
                let fenced = false;
                if (local?.id === connectionId || this.options.hasLocalFenceConnection?.(clientId, connectionId) === true) {
                    this.assertLeaseSafe();
                    fenced = (await this.options.disconnectLocal(clientId, connectionId, header.reason)) !== false;
                    this.assertLeaseSafe();
                } else {
                    // Absence is a completed exact fence only when the registry
                    // no longer identifies this node and connection as owner.
                    const current = await this.options.service.clientRegistry.getClient(clientId);
                    fenced = !current || current.nodeId !== this.options.service.instanceId || current.connectionId !== connectionId;
                }
                return { header: { type: 'result' }, body: Buffer.from(JSON.stringify({ fenced })) };
            }
            case 'clientUpdateMetadata': {
                if (local?.id !== connectionId) throw new SrpcStaleConnectionError(clientId);
                const metadata = (JSON.parse(frame.body.toString('utf8')) as { metadata?: Partial<TMeta> }).metadata;
                this.assertLeaseSafe();
                await this.options.updateLocalMetadata(clientId, connectionId, metadata as Partial<TMeta>);
                this.assertLeaseSafe();
                return { header: { type: 'result' }, body: Buffer.from(JSON.stringify({ updated: true })) };
            }
            case 'invoke':
                this.assertLeaseSafe();
                const invoked = await this.options.invokeLocal(
                    clientId,
                    connectionId,
                    requiredString(header.prefix, 'prefix'),
                    frame.body,
                    remainingDeadline(receivedInvokeDeadlineAt!, clientId)
                );
                if (isMeshInvokeResult(invoked) && invoked.requiresExactSenderGrant !== false) {
                    await this.grantIssuedSenderIds(peer, header, clientId, connectionId, invoked);
                }
                return {
                    header: { type: 'result' },
                    body: Buffer.from(invokeBody(invoked))
                };
            case 'reserveStreamIds': {
                this.assertLeaseSafe();
                return this.reserveRoute(peer, header, clientId, connectionId);
            }
            case 'confirmStreamIds':
                return this.confirmReservation(peer, header, clientId, connectionId);
            case 'releaseStreamIds': {
                if (header.closeCapability) {
                    const capability = requiredString(header.capability, 'capability');
                    if (!isOpaqueId(capability)) throw new SrpcMeshAuthenticationError('Invalid sRPC mesh handle capability');
                    this.closeHandleCapability(peer, clientId, connectionId, capability);
                    return emptyResult();
                }
                const ids = validateReservedIds(header.ids, MaxSenderRoutesPerConnection);
                const peerIdentity = senderRoutePeerIdentity(peer);
                for (const id of ids) {
                    const route = this.senderRoutes.get(routeKey(connectionId, id));
                    if (!route || route.clientId !== clientId || route.peerIdentity !== peerIdentity || route.capability !== header.capability) {
                        throw new SrpcMeshAuthenticationError('sRPC mesh sender-route release is not owned by this peer');
                    }
                }
                for (const id of ids) {
                    this.assertLeaseSafe();
                    await this.abandonRoute(routeKey(connectionId, id));
                }
                return emptyResult();
            }
            case 'streamActivate':
                requireStreamId(streamId);
                if (local?.id !== connectionId) throw new SrpcStaleConnectionError(clientId);
                this.assertLocalStreamOwnership(peer, header, clientId, connectionId, streamId!);
                this.activateSenderRoute(connectionId, streamId!, header.capability!);
                return emptyResult();
            case 'streamWrite':
                requireStreamId(streamId);
                if (local?.id === connectionId) {
                    this.assertLocalStreamOwnership(peer, header, clientId, connectionId, streamId!);
                    this.activateSenderRoute(connectionId, streamId!, header.capability!);
                    this.assertLeaseSafe();
                    await this.options.writeLocalStream(clientId, connectionId, streamId!, frame.body);
                } else {
                    if (!this.getRemoteConnection(clientId, connectionId).receiveWrite(streamId!, frame.body)) {
                        throw new SrpcBackpressureError(`Remote sRPC byte stream ${streamId} receiver is not draining`);
                    }
                }
                return emptyResult();
            case 'streamFinish':
                requireStreamId(streamId);
                if (local?.id === connectionId) {
                    const key = routeKey(connectionId, streamId!);
                    const route = this.senderRoutes.get(key);
                    this.assertLocalStreamOwnership(peer, header, clientId, connectionId, streamId!);
                    this.assertLeaseSafe();
                    await this.options.finishLocalStream(clientId, connectionId, streamId!);
                    if (route && this.senderRoutes.get(key) === route) {
                        this.senderRoutes.delete(key);
                        this.rememberTerminalSenderRoute(key, route);
                    }
                } else {
                    this.getRemoteConnection(clientId, connectionId).receiveFinish(streamId!);
                }
                return emptyResult();
            case 'streamDestroy':
                requireStreamId(streamId);
                if (local?.id === connectionId) {
                    const key = routeKey(connectionId, streamId!);
                    const terminalRoute = this.getTerminalSenderRoute(key);
                    this.assertLocalStreamOwnership(peer, header, clientId, connectionId, streamId!);
                    this.senderRoutes.delete(key);
                    this.terminalSenderRoutes.delete(key);
                    const attached = this.attachedReceivers.get(key);
                    if (attached) {
                        this.attachedReceivers.delete(key);
                        safeDestroy(attached.receiver, header.reason !== undefined ? new Error(header.reason) : undefined);
                    } else if (!terminalRoute) {
                        this.assertLeaseSafe();
                        await this.options.destroyLocalStream(clientId, connectionId, streamId!, header.reason);
                    }
                } else {
                    this.getRemoteConnection(clientId, connectionId).receiveDestroy(streamId!, header.reason);
                }
                return emptyResult();
            case 'streamAttach':
                requireStreamId(streamId);
                const handle = header.capability ? this.handleCapabilities.get(header.capability) : undefined;
                if (handle?.requiresExactSenderGrant || this.issuedSenderGrants.has(routeKey(connectionId, streamId!))) {
                    this.assertIssuedSenderGrant(peer, header, clientId, connectionId, streamId!);
                }
                this.assertLeaseSafe();
                this.attachLocalReceiver(peer, clientId, connectionId, streamId!, header.capability);
                this.issuedSenderGrants.delete(routeKey(connectionId, streamId!));
                return emptyResult();
            case 'revokeCapability':
                this.acceptCapabilityRevocation(revocationAuthority!, clientId, connectionId, senderRoutePeerIdentity(peer), header.capability!);
                return emptyResult();
            case 'disconnect':
                this.assertLeaseSafe();
                await this.options.disconnectLocal(clientId, connectionId, header.reason);
                return emptyResult();
            case 'updateMetadata':
                this.assertLeaseSafe();
                const metadata = await this.options.updateLocalMetadata(
                    clientId,
                    connectionId,
                    (JSON.parse(frame.body.toString('utf8')) as { metadata?: Partial<TMeta> }).metadata as Partial<TMeta>
                );
                return {
                    header: { type: 'result' },
                    body: Buffer.from(JSON.stringify({ metadata: metadata as TRegistryMeta }))
                };
            default:
                throw new Error(`Unsupported sRPC mesh operation: ${header.type}`);
        }
    }

    forwardClientDestroy(connectionId: string, streamId: number, error?: string): boolean {
        const key = routeKey(connectionId, streamId);
        const route = this.senderRoutes.get(key) ?? this.getTerminalSenderRoute(key);
        if (!route) return false;
        this.senderRoutes.delete(key);
        this.terminalSenderRoutes.delete(key);
        this.queueTerminalForward(
            route.peerProcessId,
            route.peerEndpointId,
            route.peerPublicKey,
            {
                type: 'streamDestroy',
                meshKey: this.options.meshKey,
                clientId: route.clientId,
                connectionId,
                streamId,
                reason: error,
                capability: route.capability
            },
            new Uint8Array()
        );
        return true;
    }

    /** Core byte-stream teardown guard: only an authenticated route may
     * consume a sender owned by the opposite mesh endpoint. */
    hasSenderRoute(connectionId: string, streamId: number): boolean {
        const key = routeKey(connectionId, streamId);
        const route = this.senderRoutes.get(key) ?? this.getTerminalSenderRoute(key);
        return Boolean(route && (route.expiresAt === undefined || route.expiresAt > Date.now()));
    }

    invalidateConnection(clientId: string, connectionId: string): void {
        const key = connectionKey(clientId, connectionId);
        this.invalidateResolution(key);
        const cached = this.remoteConnections.get(key);
        if (cached) {
            this.releaseAndMarkStale(cached);
            this.remoteConnections.delete(key);
        }
        this.deleteSenderRoutes(connectionId);
    }

    private async resolveRegisteredClient(
        record: RegisteredClient<TRegistryMeta>,
        deadlineAt = Date.now() + this.options.requestTimeoutMs
    ): Promise<MeshRemoteSrpcConnection<TRegistryMeta>> {
        if (this.closed) throw new SrpcStaleConnectionError(record.clientId);
        if (!record.connectionId) {
            throw new MeshLinkCapabilityError(`Remote sRPC client ${record.clientId} was registered by a mesh version without connection fencing`);
        }
        const key = connectionKey(record.clientId, record.connectionId);
        const node = await withinDeadline(this.options.service.mesh.getNode(record.nodeId), deadlineAt, record.clientId);
        this.assertNodeCapability(record.nodeId, node);
        const cached = this.remoteConnections.get(key);
        if (cached?.connected) {
            cached.applyMetadata(record.metadata);
            cached.touch();
            return cached;
        }

        const resolving = this.resolvingRemoteConnections.get(key);
        if (resolving) return withinDeadline(resolving.promise, deadlineAt, record.clientId);
        this.pruneRemoteConnections();
        if (this.remoteConnections.size + this.resolvingRemoteConnections.size + this.cleanupMarkers.size >= MaxRemoteConnections) {
            throw new SrpcBackpressureError('Too many remote sRPC connections');
        }

        const resolution = {
            clientId: record.clientId,
            connectionId: record.connectionId,
            endpointId: node.linkEndpointId,
            invalidated: false
        } as RemoteConnectionResolution<TRegistryMeta>;
        const promise = this.createRemoteConnection(record, key, resolution, deadlineAt);
        resolution.promise = promise;
        this.resolvingRemoteConnections.set(key, resolution);
        try {
            return await promise;
        } finally {
            if (this.resolvingRemoteConnections.get(key) === resolution) {
                this.resolvingRemoteConnections.delete(key);
            }
        }
    }

    private async createRemoteConnection(
        record: RegisteredClient<TRegistryMeta>,
        key: string,
        resolution: RemoteConnectionResolution<TRegistryMeta>,
        deadlineAt: number
    ): Promise<MeshRemoteSrpcConnection<TRegistryMeta>> {
        const connectionId = requiredString(record.connectionId, 'connectionId');
        const node = await withinDeadline(this.options.service.mesh.getNode(record.nodeId), deadlineAt, record.clientId);
        this.assertNodeCapability(record.nodeId, node);
        const ownerIdentity = node.linkEndpointId ?? node.processId;
        if (ownerIdentity) this.closedOwnerIdentities.delete(ownerIdentity);
        const reservationId = randomUUID();
        const response = await this.retryReservation(() =>
            this.options.runtime.request(
                node.linkUrl,
                {
                    type: 'reserveStreamIds',
                    meshKey: this.options.meshKey,
                    clientId: record.clientId,
                    connectionId,
                    count: InitialSenderIdReservationSize,
                    reservationId
                },
                new Uint8Array(),
                remainingDeadline(deadlineAt, record.clientId),
                node.processId,
                node.linkEndpointId,
                node.linkEndpointPublicKey
            )
        );
        const initialIds = validateReservedIds(response.header.ids, InitialSenderIdReservationSize);
        const capability = response.header.capability;
        if (!isOpaqueId(capability)) throw new SrpcMeshAuthenticationError('Missing sRPC mesh handle capability');
        const cleanupTarget: CleanupTarget = {
            clientId: record.clientId,
            connectionId,
            ownerNodeId: record.nodeId,
            ownerProcessId: node.processId,
            ownerEndpointId: node.linkEndpointId,
            ownerEndpointPublicKey: node.linkEndpointPublicKey,
            capability
        };
        try {
            await this.retryReservation(() =>
                this.options.runtime.request(
                    node.linkUrl,
                    {
                        type: 'confirmStreamIds',
                        meshKey: this.options.meshKey,
                        clientId: record.clientId,
                        connectionId,
                        capability,
                        reservationId
                    },
                    new Uint8Array(),
                    remainingDeadline(deadlineAt, record.clientId),
                    node.processId,
                    node.linkEndpointId,
                    node.linkEndpointPublicKey
                )
            );
        } catch (error) {
            this.queueCleanup(cleanupTarget, this.closed);
            throw error;
        }
        const current = await withinDeadline(this.options.service.clientRegistry.getClient(record.clientId), deadlineAt, record.clientId);
        if (!current || current.connectionId !== connectionId || current.nodeId !== record.nodeId) {
            resolution.invalidated = true;
            this.queueCleanup(cleanupTarget, this.closed);
            throw new SrpcStaleConnectionError(record.clientId);
        }
        this.invalidateOtherGenerations(record.clientId, connectionId);
        const connection = new MeshRemoteSrpcConnection<TRegistryMeta>({
            id: connectionId,
            clientId: record.clientId,
            meta: current.metadata,
            connectedAt: current.connectedAt,
            ownerNodeId: current.nodeId,
            ownerProcessId: node.processId,
            ownerEndpointId: node.linkEndpointId,
            ownerEndpointPublicKey: node.linkEndpointPublicKey,
            capability,
            senderIds: initialIds,
            transport: this
        });
        if (this.closed || resolution.invalidated || this.resolvingRemoteConnections.get(key) !== resolution) {
            this.releaseAndMarkStale(connection, this.closed);
            throw new SrpcStaleConnectionError(record.clientId);
        }
        this.remoteConnections.set(key, connection);
        return connection;
    }

    private async assertCurrent(
        connection: MeshRemoteSrpcConnection<TRegistryMeta>,
        deadlineAt = Date.now() + this.options.requestTimeoutMs
    ): Promise<RegisteredClient<TRegistryMeta>> {
        if (!connection.connected) throw new SrpcStaleConnectionError(connection.clientId);
        const current = await withinDeadline(this.options.service.clientRegistry.getClient(connection.clientId), deadlineAt, connection.clientId);
        if (!current || current.connectionId !== connection.id || current.nodeId !== connection.ownerNodeId) {
            this.invalidate(connection);
            throw new SrpcStaleConnectionError(connection.clientId);
        }
        connection.touch();
        return current;
    }

    private async requestOwner(
        connection: MeshRemoteSrpcConnection<TRegistryMeta>,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id' | 'meshKey' | 'clientId' | 'connectionId'>,
        body: Uint8Array,
        timeoutMs: number,
        deadlineAt = Date.now() + timeoutMs
    ): Promise<MeshLinkFrame> {
        const current = await withinDeadline(this.options.service.clientRegistry.getClient(connection.clientId), deadlineAt, connection.clientId);
        if (!current || current.connectionId !== connection.id || current.nodeId !== connection.ownerNodeId) {
            this.invalidate(connection);
            throw new SrpcStaleConnectionError(connection.clientId);
        }
        connection.touch();
        const node = await withinDeadline(this.options.service.mesh.getNode(current.nodeId), deadlineAt, connection.clientId);
        this.assertNodeCapability(current.nodeId, node);
        try {
            const dispatchTimeoutMs = Math.min(timeoutMs, remainingDeadline(deadlineAt, connection.clientId));
            return await this.options.runtime.request(
                node.linkUrl,
                {
                    ...header,
                    ...(header.timeoutMs !== undefined ? { timeoutMs: Math.min(header.timeoutMs, dispatchTimeoutMs) } : {}),
                    meshKey: this.options.meshKey,
                    clientId: connection.clientId,
                    connectionId: connection.id,
                    capability: connection.capability
                },
                body,
                dispatchTimeoutMs,
                node.processId,
                node.linkEndpointId,
                node.linkEndpointPublicKey
            );
        } catch (error) {
            const reconstructed = reconstructRemoteError(error, connection.clientId);
            if (reconstructed instanceof SrpcStaleConnectionError) this.invalidate(connection);
            throw reconstructed;
        }
    }

    /** Direct client-service operations do not use an sRPC stream capability,
     * but are still bound to the current registry generation and pinned owner
     * endpoint before a frame is dispatched. */
    private async requestClientOwner(
        nodeId: number,
        clientId: string,
        connectionId: string,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id' | 'meshKey' | 'clientId' | 'connectionId'>,
        body: Uint8Array,
        timeoutMs: number,
        deadlineAt = Date.now() + timeoutMs
    ): Promise<MeshLinkFrame> {
        this.assertOpen();
        const node = await withinDeadline(this.options.service.mesh.getNode(nodeId), deadlineAt, clientId);
        this.assertNodeCapability(nodeId, node);
        try {
            const dispatchTimeoutMs = Math.min(timeoutMs, remainingDeadline(deadlineAt, clientId));
            return await this.options.runtime.request(
                node.linkUrl,
                {
                    ...header,
                    ...(header.timeoutMs !== undefined ? { timeoutMs: Math.min(header.timeoutMs, dispatchTimeoutMs) } : {}),
                    meshKey: this.options.meshKey,
                    clientId,
                    connectionId
                },
                body,
                dispatchTimeoutMs,
                node.processId,
                node.linkEndpointId,
                node.linkEndpointPublicKey
            );
        } catch (error) {
            throw reconstructRemoteError(error, clientId);
        }
    }

    private assertNodeCapability(
        nodeId: number,
        node: MeshNode | undefined
    ): asserts node is MeshNode & {
        linkUrl: string;
        linkEndpointId: string;
        linkEndpointPublicKey: string;
    } {
        if (!node?.linkUrl || !node.linkEndpointId || !node.linkEndpointPublicKey) {
            throw new MeshLinkCapabilityError(`Remote sRPC owner ${nodeId} does not advertise a pinned direct mesh link`);
        }
        this.pinNode(node);
    }

    private supportsDirectLink(node: MeshNode | undefined): node is MeshNode & {
        linkUrl: string;
        linkEndpointId: string;
        linkEndpointPublicKey: string;
    } {
        const supported = Boolean(node?.linkUrl && node.linkEndpointId && node.linkEndpointPublicKey);
        if (supported && node) this.pinNode(node);
        return supported;
    }

    private pinNode(node: MeshNode): void {
        if (!node.linkEndpointId || !node.linkEndpointPublicKey) return;
        const existing = this.endpointPinUnregisters.get(node.linkEndpointId);
        if (existing) return;
        if (this.endpointPinUnregisters.size >= MaxEndpointPins) this.pruneEndpointPins();
        if (this.endpointPinUnregisters.size >= MaxEndpointPins) {
            throw new SrpcBackpressureError('Too many pinned sRPC mesh endpoints');
        }
        const unregister = this.options.runtime.pinEndpoint?.(node.linkEndpointId, node.linkEndpointPublicKey);
        if (unregister) this.endpointPinUnregisters.set(node.linkEndpointId, unregister);
    }

    /** Pins remain only while a live connection or terminal-cleanup obligation
     * can address the endpoint.  Runtime pins themselves are ref-counted; this
     * releases the controller's last reference once no such obligation exists. */
    private pruneEndpointPins(): void {
        const live = new Set<string>();
        for (const connection of this.remoteConnections.values()) if (connection.ownerEndpointId) live.add(connection.ownerEndpointId);
        for (const resolution of this.resolvingRemoteConnections.values()) if (resolution.endpointId) live.add(resolution.endpointId);
        for (const marker of this.cleanupMarkers.values()) if (marker.target.ownerEndpointId) live.add(marker.target.ownerEndpointId);
        for (const terminal of this.terminalForwards.values()) if (terminal.endpointId) live.add(terminal.endpointId);
        for (const route of this.senderRoutes.values()) if (route.peerEndpointId) live.add(route.peerEndpointId);
        for (const route of this.terminalSenderRoutes.values()) if (route.peerEndpointId) live.add(route.peerEndpointId);
        for (const reservation of this.reservations.values()) if (reservation.peerEndpointId) live.add(reservation.peerEndpointId);
        for (const capability of this.handleCapabilities.values()) if (capability.peerEndpointId) live.add(capability.peerEndpointId);
        for (const receiver of this.attachedReceivers.values()) if (receiver.peerEndpointId) live.add(receiver.peerEndpointId);
        for (const [endpointId, unregister] of this.endpointPinUnregisters) {
            if (!live.has(endpointId)) {
                unregister();
                this.endpointPinUnregisters.delete(endpointId);
            }
        }
    }

    private attachLocalReceiver(peer: MeshLinkPeer, clientId: string, connectionId: string, streamId: number, capability?: string): void {
        this.assertOpen();
        if (!peer.connected) throw new SrpcStaleConnectionError(clientId);
        const key = routeKey(connectionId, streamId);
        if (this.attachedReceivers.has(key)) throw new Error(`sRPC byte stream ${streamId} is already attached`);
        if (
            this.attachedReceivers.size >= MaxAttachedReceivers ||
            this.countReceiversForConnection(connectionId) >= MaxAttachedReceiversPerConnection
        ) {
            throw new SrpcBackpressureError('Too many attached remote sRPC byte stream receivers');
        }
        const receiver = this.options.attachLocalReceiver(clientId, connectionId, streamId);
        const attached: AttachedReceiver = {
            receiver,
            clientId,
            connectionId,
            streamId,
            capability,
            peerIdentity: senderRoutePeerIdentity(peer),
            peerProcessId: peer.processId,
            peerEndpointId: peer.endpointId,
            peerPublicKey: peer.publicKey
        };
        this.attachedReceivers.set(key, attached);
        let terminalForwarded = false;
        const forward = (type: 'streamWrite' | 'streamFinish' | 'streamDestroy', body: Uint8Array, reason?: string) => {
            if (attached.capability) {
                const handle = this.handleCapabilities.get(attached.capability);
                if (handle) handle.expiresAt = this.handleCapabilityExpiresAt();
            }
            return this.options.runtime.requestPeer(
                attached.peerProcessId,
                attached.peerEndpointId,
                { type, meshKey: this.options.meshKey, clientId, connectionId, streamId, reason, capability: attached.capability },
                body,
                this.options.requestTimeoutMs,
                attached.peerPublicKey
            );
        };
        receiver.on('data', (chunk: Buffer) => {
            receiver.pause();
            void forward('streamWrite', chunk).then(
                () => receiver.resume(),
                error => safeDestroy(receiver, error instanceof Error ? error : new Error(String(error)))
            );
        });
        receiver.once('end', () => {
            terminalForwarded = true;
            this.attachedReceivers.delete(key);
            this.queueTerminalForward(
                attached.peerProcessId,
                attached.peerEndpointId,
                attached.peerPublicKey,
                { type: 'streamFinish', meshKey: this.options.meshKey, clientId, connectionId, streamId, capability: attached.capability },
                new Uint8Array()
            );
        });
        receiver.once('error', error => {
            terminalForwarded = true;
            this.attachedReceivers.delete(key);
            this.queueTerminalForward(
                attached.peerProcessId,
                attached.peerEndpointId,
                attached.peerPublicKey,
                {
                    type: 'streamDestroy',
                    meshKey: this.options.meshKey,
                    clientId,
                    connectionId,
                    streamId,
                    reason: error.message,
                    capability: attached.capability
                },
                new Uint8Array()
            );
        });
        receiver.once('close', () => {
            this.attachedReceivers.delete(key);
            if (terminalForwarded) return;
            terminalForwarded = true;
            this.queueTerminalForward(
                attached.peerProcessId,
                attached.peerEndpointId,
                attached.peerPublicKey,
                { type: 'streamDestroy', meshKey: this.options.meshKey, clientId, connectionId, streamId, capability: attached.capability },
                new Uint8Array()
            );
        });
    }

    private queueTerminalForward(
        processId: string,
        endpointId: string | undefined,
        publicKey: string | undefined,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id'>,
        body: Uint8Array
    ): void {
        const key = `${processId}:${endpointId ?? ''}:${header.connectionId ?? ''}:${header.streamId ?? 0}:${header.type}:${header.capability ?? ''}`;
        const existing = this.terminalForwards.get(key);
        if (!existing && this.terminalForwards.size >= MaxTerminalForwards) {
            this.closePinnedPeer({ processId, endpointId, publicKey }, 'sRPC mesh terminal retry capacity exceeded');
            return;
        }
        const now = Date.now();
        this.terminalForwards.set(key, {
            processId,
            endpointId,
            publicKey,
            header,
            body,
            expiresAt: existing?.expiresAt ?? now + TerminalForwardTtlMs,
            attempts: existing?.attempts ?? 0,
            nextRetryAt: 0,
            retrying: existing?.retrying
        });
        void this.retryTerminalForward(key).catch(() => {});
    }

    private async retryTerminalForwards(force = false): Promise<void> {
        const now = Date.now();
        const eligible: string[] = [];
        for (const [key, terminal] of this.terminalForwards) {
            if (terminal.expiresAt <= now) {
                this.terminalForwards.delete(key);
                this.closePinnedPeer(terminal, 'sRPC mesh terminal acknowledgement timed out');
                continue;
            }
            if (!terminal.retrying && (force || terminal.nextRetryAt <= now)) eligible.push(key);
            if (eligible.length >= MaxConcurrentTerminalRetries) break;
        }
        await Promise.allSettled(eligible.map(key => this.retryTerminalForward(key, force)));
    }

    private async retryTerminalForward(key: string, force = false): Promise<void> {
        const terminal = this.terminalForwards.get(key);
        if (!terminal || terminal.retrying) return terminal?.retrying;
        const now = Date.now();
        if (terminal.expiresAt <= now) {
            this.terminalForwards.delete(key);
            this.closePinnedPeer(terminal, 'sRPC mesh terminal acknowledgement timed out');
            return;
        }
        if (!force && terminal.nextRetryAt > now) return;
        const timeoutMs = Math.max(1, Math.min(2_000, this.options.requestTimeoutMs, terminal.expiresAt - now));
        const attempt = this.options.runtime
            .requestPeer(terminal.processId, terminal.endpointId, terminal.header, terminal.body, timeoutMs, terminal.publicKey)
            .then(() => {
                if (this.terminalForwards.get(key) === terminal) this.terminalForwards.delete(key);
            })
            .catch(() => {
                terminal.attempts++;
                terminal.nextRetryAt = Date.now() + Math.min(2_000, 100 * 2 ** Math.min(terminal.attempts - 1, 5));
            });
        terminal.retrying = attempt;
        try {
            await attempt;
        } finally {
            if (terminal.retrying === attempt) terminal.retrying = undefined;
        }
    }

    private async drainTerminalForwards(): Promise<void> {
        const deadline = Date.now() + Math.min(2_000, this.options.requestTimeoutMs);
        while (this.terminalForwards.size > 0 && Date.now() < deadline) {
            await this.retryTerminalForwards(true);
            if ([...this.terminalForwards.values()].some(terminal => terminal.retrying)) {
                await Promise.allSettled([...this.terminalForwards.values()].flatMap(terminal => (terminal.retrying ? [terminal.retrying] : [])));
            }
            if (this.terminalForwards.size > 0) await pauseForDrain(deadline);
        }
    }

    private closePinnedPeer(target: { processId?: string; endpointId?: string; publicKey?: string }, reason: string): void {
        try {
            this.options.runtime.closePeer(target.processId, target.endpointId, reason, target.publicKey);
        } catch {
            // No safe unpinned close is attempted.
        }
    }

    private reserveRoute(peer: MeshLinkPeer, header: MeshLinkFrameHeader, clientId: string, connectionId: string): MeshLinkFrame {
        const count = header.count;
        const reservationId = header.reservationId;
        if (!Number.isSafeInteger(count) || count! < 1 || count! > SenderIdReservationSize || !isOpaqueId(reservationId)) {
            throw new SrpcBackpressureError('Invalid remote sRPC byte stream reservation size');
        }
        const identity = senderRoutePeerIdentity(peer);
        const key = reservationKey(identity, reservationId!);
        const prior = this.reservations.get(key);
        if (prior) {
            if (prior.clientId !== clientId || prior.connectionId !== connectionId || prior.capability !== (header.capability ?? prior.capability)) {
                throw new SrpcMeshAuthenticationError('sRPC mesh reservation is not owned by this handle');
            }
            return emptyResult({ ids: prior.ids, capability: prior.capability });
        }
        if (this.reservations.size >= MaxReservations) throw new SrpcBackpressureError('Too many provisional remote sRPC reservations');
        if (header.capability) this.assertFrameCapability(peer, header, clientId, connectionId);
        if (!header.capability && this.handleCapabilities.size >= MaxHandleCapabilities) {
            throw new SrpcBackpressureError('Too many remote sRPC handle capabilities');
        }
        if (
            this.senderRoutes.size + count! > MaxSenderRoutes ||
            this.countRoutesForConnection(connectionId) + count! > MaxSenderRoutesPerConnection
        ) {
            throw new SrpcBackpressureError('Too many reserved remote sRPC byte streams');
        }
        const capability = header.capability ?? randomUUID();
        const ids = this.options.reserveLocalSenderIds(clientId, connectionId, count!);
        const reservation: HandleReservation = {
            reservationId: reservationId!,
            clientId,
            connectionId,
            capability,
            peerIdentity: identity,
            peerProcessId: peer.processId,
            peerEndpointId: peer.endpointId,
            peerPublicKey: peer.publicKey,
            ids,
            expiresAt: this.reservationExpiresAt(),
            confirmed: false
        };
        this.reservations.set(key, reservation);
        for (const id of ids) {
            this.senderRoutes.set(routeKey(connectionId, id), {
                clientId,
                capability,
                active: false,
                peerIdentity: identity,
                peerProcessId: peer.processId,
                peerEndpointId: peer.endpointId,
                peerPublicKey: peer.publicKey
            });
        }
        return emptyResult({ ids, capability });
    }

    private confirmReservation(peer: MeshLinkPeer, header: MeshLinkFrameHeader, clientId: string, connectionId: string): MeshLinkFrame {
        if (!isOpaqueId(header.reservationId) || !isOpaqueId(header.capability)) {
            throw new SrpcMeshAuthenticationError('Missing sRPC mesh reservation confirmation capability');
        }
        const key = reservationKey(senderRoutePeerIdentity(peer), header.reservationId!);
        const reservation = this.reservations.get(key);
        if (
            !reservation ||
            reservation.clientId !== clientId ||
            reservation.connectionId !== connectionId ||
            reservation.capability !== header.capability
        ) {
            throw new SrpcMeshAuthenticationError('sRPC mesh reservation confirmation is not owned by this peer');
        }
        const existing = this.handleCapabilities.get(reservation.capability);
        if (
            existing &&
            (existing.clientId !== clientId || existing.connectionId !== connectionId || existing.peerIdentity !== reservation.peerIdentity)
        ) {
            throw new SrpcMeshAuthenticationError('sRPC mesh handle capability was rebound');
        }
        if (!existing && this.handleCapabilities.size >= MaxHandleCapabilities) {
            if (this.reservations.get(key) === reservation) this.reservations.delete(key);
            for (const id of reservation.ids) {
                const route = this.senderRoutes.get(routeKey(reservation.connectionId, id));
                if (
                    route?.capability === reservation.capability &&
                    route.clientId === reservation.clientId &&
                    route.peerIdentity === reservation.peerIdentity
                ) {
                    void this.abandonRoute(routeKey(reservation.connectionId, id), route);
                }
            }
            throw new SrpcBackpressureError('Too many remote sRPC handle capabilities');
        }
        reservation.confirmed = true;
        reservation.expiresAt = this.reservationExpiresAt();
        this.handleCapabilities.set(reservation.capability, {
            clientId,
            connectionId,
            capability: reservation.capability,
            peerIdentity: reservation.peerIdentity,
            peerProcessId: reservation.peerProcessId,
            peerEndpointId: reservation.peerEndpointId,
            peerPublicKey: reservation.peerPublicKey,
            requiresExactSenderGrant: this.options.getLocalConnection(clientId)?.features?.has('sender-announcements'),
            expiresAt: this.handleCapabilityExpiresAt()
        });
        return emptyResult({ ids: reservation.ids, capability: reservation.capability });
    }

    private assertFrameCapability(peer: MeshLinkPeer, header: MeshLinkFrameHeader, clientId: string, connectionId: string): void {
        if (!isOpaqueId(header.capability)) throw new SrpcMeshAuthenticationError('Missing sRPC mesh handle capability');
        const identity = senderRoutePeerIdentity(peer);
        const handle = this.handleCapabilities.get(header.capability);
        if (handle) {
            if (handle.clientId !== clientId || handle.connectionId !== connectionId || handle.peerIdentity !== identity) {
                throw new SrpcMeshAuthenticationError('sRPC mesh handle is not owned by this peer');
            }
            handle.expiresAt = this.handleCapabilityExpiresAt();
            return;
        }

        // Reverse frames terminate at a resolved remote connection rather than
        // at an owner-side reservation. Bind those to its owner identity too.
        const connection = this.remoteConnections.get(connectionKey(clientId, connectionId));
        if (
            !connection ||
            connection.capability !== header.capability ||
            (connection.ownerEndpointId ? peer.endpointId !== connection.ownerEndpointId : peer.processId !== connection.ownerProcessId)
        ) {
            throw new SrpcMeshAuthenticationError('sRPC mesh handle is not owned by this peer');
        }
    }

    private assertCapabilityRevocation(
        peer: MeshLinkPeer,
        header: MeshLinkFrameHeader,
        clientId: string,
        connectionId: string
    ): CapabilityRevocationAuthority<TRegistryMeta> {
        if (!isOpaqueId(header.capability)) throw new SrpcMeshAuthenticationError('Missing sRPC mesh handle capability');
        const capability = header.capability;
        const peerIdentity = senderRoutePeerIdentity(peer);
        const connection = this.remoteConnections.get(connectionKey(clientId, connectionId));
        if (
            connection?.connected &&
            connection.capability === capability &&
            (connection.ownerEndpointId ? peer.endpointId === connection.ownerEndpointId : peer.processId === connection.ownerProcessId)
        ) {
            return { kind: 'connection', connection };
        }
        const marker = this.cleanupMarkers.get(capability);
        const target = marker?.target;
        if (
            marker &&
            target &&
            target.capability === capability &&
            target.clientId === clientId &&
            target.connectionId === connectionId &&
            (target.ownerEndpointId ? peer.endpointId === target.ownerEndpointId : peer.processId === target.ownerProcessId)
        ) {
            return { kind: 'cleanup', marker };
        }
        const revoked = this.revokedRemoteCapabilities.get(capability);
        if (revoked?.expiresAt !== undefined && revoked.expiresAt <= Date.now()) {
            this.revokedRemoteCapabilities.delete(capability);
        } else if (revoked && revoked.clientId === clientId && revoked.connectionId === connectionId && revoked.peerIdentity === peerIdentity) {
            return { kind: 'tombstone' };
        }
        throw new SrpcMeshAuthenticationError('sRPC mesh capability revocation is not owned by this peer');
    }

    private acceptCapabilityRevocation(
        authority: CapabilityRevocationAuthority<TRegistryMeta>,
        clientId: string,
        connectionId: string,
        peerIdentity: string,
        capability: string
    ): void {
        if (authority.kind === 'tombstone') return;
        this.rememberRevokedRemoteCapability(clientId, connectionId, peerIdentity, capability);
        if (authority.kind === 'cleanup') {
            if (this.cleanupMarkers.get(capability) === authority.marker) this.cleanupMarkers.delete(capability);
            this.pruneEndpointPins();
            return;
        }
        const connection = authority.connection;
        const key = connectionKey(connection.clientId, connection.id);
        connection.takeReservedSenderIds();
        connection.markStale();
        if (this.remoteConnections.get(key) === connection) this.remoteConnections.delete(key);
        this.invalidateResolution(key);
        this.cleanupMarkers.delete(capability);
        this.pruneEndpointPins();
    }

    private rememberRevokedRemoteCapability(clientId: string, connectionId: string, peerIdentity: string, capability: string): void {
        const now = Date.now();
        for (const [existing, revoked] of this.revokedRemoteCapabilities) {
            if (revoked.expiresAt <= now) this.revokedRemoteCapabilities.delete(existing);
        }
        while (!this.revokedRemoteCapabilities.has(capability) && this.revokedRemoteCapabilities.size >= MaxHandleCapabilities) {
            const oldest = this.revokedRemoteCapabilities.keys().next().value;
            if (oldest === undefined) break;
            this.revokedRemoteCapabilities.delete(oldest);
        }
        this.revokedRemoteCapabilities.set(capability, {
            clientId,
            connectionId,
            peerIdentity,
            expiresAt: now + TerminalForwardTtlMs
        });
    }

    private assertLocalStreamOwnership(
        peer: MeshLinkPeer,
        header: MeshLinkFrameHeader,
        clientId: string,
        connectionId: string,
        streamId: number
    ): void {
        const key = routeKey(connectionId, streamId);
        const route = this.senderRoutes.get(key) ?? this.getTerminalSenderRoute(key);
        if (route) {
            if (route.clientId === clientId && route.capability === header.capability && route.peerIdentity === senderRoutePeerIdentity(peer)) {
                return;
            }
            throw new SrpcMeshAuthenticationError('sRPC mesh stream is not owned by this handle');
        }
        const attached = this.attachedReceivers.get(routeKey(connectionId, streamId));
        if (attached && attached.capability === header.capability && attached.peerIdentity === senderRoutePeerIdentity(peer)) return;
        throw new SrpcMeshAuthenticationError('sRPC mesh stream is not owned by this handle');
    }

    private activateSenderRoute(connectionId: string, streamId: number, capability: string): void {
        const route = this.senderRoutes.get(routeKey(connectionId, streamId));
        if (!route || route.capability !== capability) {
            throw new SrpcMeshAuthenticationError('sRPC mesh sender route is not owned by this handle');
        }
        route.active = true;
        const handle = this.handleCapabilities.get(capability);
        if (handle) handle.expiresAt = this.handleCapabilityExpiresAt();
    }

    private async grantIssuedSenderIds(
        peer: MeshLinkPeer,
        header: MeshLinkFrameHeader,
        clientId: string,
        connectionId: string,
        result: Uint8Array | MeshLocalInvokeResult
    ): Promise<void> {
        this.assertLeaseSafe();
        if (!header.capability || !isMeshInvokeResult(result)) return;
        const handle = this.handleCapabilities.get(header.capability);
        if (
            this.closed ||
            !peer.connected ||
            !handle ||
            handle.clientId !== clientId ||
            handle.connectionId !== connectionId ||
            handle.peerIdentity !== senderRoutePeerIdentity(peer)
        ) {
            await Promise.allSettled(
                result.issuedSenderIds.map(id => this.options.destroyLocalStream(clientId, connectionId, id, 'sRPC mesh invocation became stale'))
            );
            throw new SrpcStaleConnectionError(clientId);
        }
        const count = [...this.issuedSenderGrants.values()].filter(grant => grant.capability === header.capability).length;
        if (
            this.issuedSenderGrants.size + result.issuedSenderIds.length > MaxIssuedSenderGrants ||
            count + result.issuedSenderIds.length > MaxIssuedSenderGrantsPerCapability
        ) {
            await Promise.allSettled(
                result.issuedSenderIds.map(id => this.options.destroyLocalStream(clientId, connectionId, id, 'Too many unclaimed sRPC mesh streams'))
            );
            throw new SrpcBackpressureError('Too many unclaimed sRPC mesh streams');
        }
        for (const streamId of result.issuedSenderIds) {
            if (Number.isSafeInteger(streamId) && streamId > 0) {
                this.issuedSenderGrants.set(routeKey(connectionId, streamId), {
                    clientId,
                    capability: header.capability,
                    active: true,
                    peerIdentity: senderRoutePeerIdentity(peer),
                    peerProcessId: peer.processId,
                    peerEndpointId: peer.endpointId,
                    peerPublicKey: peer.publicKey,
                    expiresAt: Date.now() + IssuedSenderGrantTtlMs
                });
            }
        }
    }

    private assertIssuedSenderGrant(peer: MeshLinkPeer, header: MeshLinkFrameHeader, clientId: string, connectionId: string, streamId: number): void {
        const key = routeKey(connectionId, streamId);
        const grant = this.issuedSenderGrants.get(key);
        if (grant?.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
            void this.abandonIssuedSenderGrant(key, grant, 'sRPC mesh sender grant expired');
            throw new SrpcMeshAuthenticationError('sRPC mesh stream attachment grant expired');
        }
        if (!grant || grant.clientId !== clientId || grant.capability !== header.capability || grant.peerIdentity !== senderRoutePeerIdentity(peer)) {
            throw new SrpcMeshAuthenticationError('sRPC mesh stream attachment was not issued to this handle');
        }
    }

    private pruneReservations(): void {
        const now = Date.now();
        for (const [key, reservation] of this.reservations) {
            if (reservation.expiresAt >= now) continue;
            this.reservations.delete(key);
            if (!reservation.confirmed) {
                for (const id of reservation.ids) void this.abandonRoute(routeKey(reservation.connectionId, id));
            }
        }
        for (const [key, grant] of this.issuedSenderGrants) {
            if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
                this.abandonIssuedSenderGrant(key, grant, 'sRPC mesh sender grant expired');
            }
        }
        for (const [key, route] of this.terminalSenderRoutes) {
            if (route.expiresAt <= now) this.terminalSenderRoutes.delete(key);
        }
        for (const [capability, handle] of this.handleCapabilities) {
            if (handle.expiresAt < now) {
                if (this.isCapabilityActive(capability)) handle.expiresAt = this.handleCapabilityExpiresAt();
                else this.removeHandleCapability(capability, 'sRPC mesh handle expired');
            }
        }
        for (const [capability, revoked] of this.revokedRemoteCapabilities) {
            if (revoked.expiresAt <= now) this.revokedRemoteCapabilities.delete(capability);
        }
    }

    private rememberTerminalSenderRoute(key: string, route: SenderRoute): void {
        const now = Date.now();
        for (const [existingKey, existing] of this.terminalSenderRoutes) {
            if (existing.expiresAt <= now) this.terminalSenderRoutes.delete(existingKey);
        }
        while (this.terminalSenderRoutes.size >= MaxTerminalSenderRoutes) {
            const oldest = this.terminalSenderRoutes.keys().next().value;
            if (oldest === undefined) break;
            this.terminalSenderRoutes.delete(oldest);
        }
        this.terminalSenderRoutes.set(key, {
            ...route,
            expiresAt: now + TerminalSenderRouteTtlMs
        });
    }

    private getTerminalSenderRoute(key: string): (SenderRoute & { expiresAt: number }) | undefined {
        const route = this.terminalSenderRoutes.get(key);
        if (!route) return undefined;
        if (route.expiresAt > Date.now()) return route;
        this.terminalSenderRoutes.delete(key);
        return undefined;
    }

    private reservationExpiresAt(): number {
        const retryWindow = Number.isFinite(this.options.requestTimeoutMs) ? this.options.requestTimeoutMs * 2 : ReservationTtlMs;
        return Date.now() + Math.min(MaxReservationTtlMs, Math.max(ReservationTtlMs, retryWindow));
    }

    private handleCapabilityExpiresAt(): number {
        return Date.now() + HandleCapabilityIdleTtlMs;
    }

    private abandonPeerReservations(processId: string, endpointId: string): void {
        for (const [key, reservation] of this.reservations) {
            if (reservation.peerIdentity !== endpointId && reservation.peerIdentity !== processId) continue;
            this.reservations.delete(key);
            for (const id of reservation.ids) void this.abandonRoute(routeKey(reservation.connectionId, id));
        }
    }

    private async abandonRoute(key: string, known?: SenderRoute): Promise<void> {
        const route = known ?? this.senderRoutes.get(key);
        if (!route) return;
        if (known && this.senderRoutes.get(key) !== known) return;
        this.senderRoutes.delete(key);
        if (route.active === false) return;
        const [connectionId, streamId] = splitRouteKey(key);
        try {
            await this.options.destroyLocalStream(route.clientId, connectionId, streamId, 'sRPC mesh sender reservation abandoned');
        } catch {
            // The owning client may already be disconnected; the route is
            // deliberately removed regardless.
        }
    }

    private async abandonIssuedSenderGrant(key: string, grant: SenderRoute, reason: string): Promise<void> {
        if (this.issuedSenderGrants.get(key) !== grant) return;
        this.issuedSenderGrants.delete(key);
        const [connectionId, streamId] = splitRouteKey(key);
        await this.options.destroyLocalStream(grant.clientId, connectionId, streamId, reason).catch(() => {});
    }

    private closeHandleCapability(peer: MeshLinkPeer, clientId: string, connectionId: string, capability: string): void {
        const handle = this.handleCapabilities.get(capability);
        if (!handle) return;
        if (handle.clientId !== clientId || handle.connectionId !== connectionId || handle.peerIdentity !== senderRoutePeerIdentity(peer)) {
            throw new SrpcMeshAuthenticationError('sRPC mesh handle capability is not owned by this connection');
        }
        this.removeHandleCapability(capability, 'sRPC mesh handle released', false);
    }

    private removeHandleCapability(capability: string, reason: string, notifyPeer = true): void {
        const handle = this.handleCapabilities.get(capability);
        if (!handle) return;
        this.handleCapabilities.delete(capability);
        if (notifyPeer) {
            const target = {
                processId: handle.peerProcessId,
                endpointId: handle.peerEndpointId,
                publicKey: handle.peerPublicKey
            };
            if (typeof this.options.runtime.requestPeer === 'function') {
                this.queueTerminalForward(
                    handle.peerProcessId,
                    handle.peerEndpointId,
                    handle.peerPublicKey,
                    {
                        type: 'revokeCapability',
                        meshKey: this.options.meshKey,
                        clientId: handle.clientId,
                        connectionId: handle.connectionId,
                        capability,
                        reason
                    },
                    new Uint8Array()
                );
            } else {
                this.closePinnedPeer(target, reason);
            }
        }
        for (const [key, route] of this.senderRoutes) {
            if (route.capability === capability) void this.abandonRoute(key, route);
        }
        for (const [key, route] of this.terminalSenderRoutes) {
            if (route.capability === capability) this.terminalSenderRoutes.delete(key);
        }
        for (const [key, attached] of this.attachedReceivers) {
            if (attached.capability !== capability) continue;
            this.attachedReceivers.delete(key);
            safeDestroy(attached.receiver, new Error(reason));
        }
        for (const [key, reservation] of this.reservations) {
            if (reservation.capability === capability) this.reservations.delete(key);
        }
        for (const [key, grant] of this.issuedSenderGrants) {
            if (grant.capability !== capability) continue;
            this.abandonIssuedSenderGrant(key, grant, reason);
        }
    }

    private isCapabilityActive(capability: string): boolean {
        for (const route of this.senderRoutes.values()) {
            if (route.capability === capability && route.active === true) return true;
        }
        for (const attached of this.attachedReceivers.values()) if (attached.capability === capability) return true;
        for (const grant of this.issuedSenderGrants.values()) {
            if (grant.capability === capability && grant.expiresAt !== undefined && grant.expiresAt > Date.now()) return true;
        }
        return false;
    }

    private getRemoteConnection(clientId: string, connectionId: string): MeshRemoteSrpcConnection<TRegistryMeta> {
        const connection = this.remoteConnections.get(connectionKey(clientId, connectionId));
        if (!connection?.connected) throw new SrpcStaleConnectionError(clientId);
        return connection;
    }

    private invalidate(connection: MeshRemoteSrpcConnection<TRegistryMeta>): void {
        this.releaseAndMarkStale(connection);
        const key = connectionKey(connection.clientId, connection.id);
        if (this.remoteConnections.get(key) === connection) {
            this.remoteConnections.delete(key);
            this.invalidateResolution(key);
            this.deleteSenderRoutes(connection.id);
        }
    }

    private invalidateResolution(key: string): void {
        const resolution = this.resolvingRemoteConnections.get(key);
        if (resolution) resolution.invalidated = true;
    }

    private invalidateClientConnections(clientId: string): void {
        for (const connection of this.remoteConnections.values()) {
            if (connection.clientId === clientId) this.invalidate(connection);
        }
        for (const resolution of this.resolvingRemoteConnections.values()) {
            if (resolution.clientId === clientId) resolution.invalidated = true;
        }
    }

    private invalidateOtherGenerations(clientId: string, connectionId: string): void {
        for (const connection of this.remoteConnections.values()) {
            if (connection.clientId === clientId && connection.id !== connectionId) this.invalidate(connection);
        }
        for (const resolution of this.resolvingRemoteConnections.values()) {
            if (resolution.clientId === clientId && resolution.connectionId !== connectionId) resolution.invalidated = true;
        }
    }

    private pruneRemoteConnections(): void {
        const deadline = Date.now() - RemoteConnectionIdleTtlMs;
        for (const connection of this.remoteConnections.values()) {
            if (!connection.connected || (!connection.hasActiveStreams && connection.idleSince < deadline)) this.invalidate(connection);
        }
    }

    private async verifyPeerMembership(peer: MeshLinkPeer, forceRevalidate = false): Promise<void> {
        const cached = this.verifiedPeers.get(peer);
        if (!forceRevalidate && cached && cached.verifiedAt >= Date.now() - PeerMembershipTtlMs) return;
        // Mutating routed frames require an observation made for that frame;
        // they must not inherit authority from an older in-flight lookup.
        const existing = forceRevalidate ? undefined : this.verifyingPeers.get(peer);
        if (existing) return existing;
        const verification = (async () => {
            const nodes = await this.options.service.mesh.getNodes();
            this.assertOpen();
            this.assertLeaseSafe();
            const endpointVerified = nodes.some(
                node =>
                    node.processId === peer.processId &&
                    node.linkEndpointId === peer.endpointId &&
                    (typeof this.options.runtime.pinEndpoint !== 'function' || node.linkEndpointPublicKey === peer.publicKey)
            );
            if (!endpointVerified) {
                throw new SrpcMeshAuthenticationError('sRPC mesh peer is not a live member of this mesh');
            }
            this.verifiedPeers.set(peer, { verifiedAt: Date.now() });
        })();
        this.verifyingPeers.set(peer, verification);
        try {
            await verification;
        } finally {
            if (this.verifyingPeers.get(peer) === verification) this.verifyingPeers.delete(peer);
        }
    }

    private countRoutesForConnection(connectionId: string): number {
        return countPrefixedKeys(this.senderRoutes, connectionId);
    }

    private countReceiversForConnection(connectionId: string): number {
        return countPrefixedKeys(this.attachedReceivers, connectionId);
    }

    private deleteSenderRoutes(connectionId: string): void {
        const capabilities = new Set<string>();
        for (const handle of this.handleCapabilities.values()) {
            if (handle.connectionId === connectionId) capabilities.add(handle.capability);
        }
        for (const capability of capabilities) {
            this.removeHandleCapability(capability, 'sRPC client connection closed');
        }
        for (const [key, route] of this.senderRoutes) {
            if (key.startsWith(`${connectionId}:`)) void this.abandonRoute(key, route);
        }
        for (const key of this.terminalSenderRoutes.keys()) {
            if (key.startsWith(`${connectionId}:`)) this.terminalSenderRoutes.delete(key);
        }
        for (const [key, reservation] of this.reservations) {
            if (reservation.connectionId === connectionId) this.reservations.delete(key);
        }
        for (const [key, attached] of this.attachedReceivers) {
            if (attached.connectionId !== connectionId) continue;
            this.attachedReceivers.delete(key);
            safeDestroy(attached.receiver, new Error('sRPC client connection closed'));
        }
        for (const [key, grant] of this.issuedSenderGrants) {
            if (!key.startsWith(`${connectionId}:`)) continue;
            this.abandonIssuedSenderGrant(key, grant, 'sRPC client connection closed');
        }
    }

    private releaseAndMarkStale(connection: MeshRemoteSrpcConnection<TRegistryMeta>, allowClosed = false): void {
        connection.takeReservedSenderIds();
        connection.markStale();
        this.queueCleanup(cleanupTargetForConnection(connection), allowClosed);
    }

    private queueCleanup(target: CleanupTarget, allowClosed = false): void {
        const cleanup = this.rememberCleanup(target, allowClosed);
        if (cleanup) void this.retryCleanupMarker(cleanup.key, cleanup.marker).catch(() => {});
    }

    private rememberCleanup(target: CleanupTarget, allowClosed = false): { key: string; marker: CleanupMarker } | undefined {
        if ((this.closed && !allowClosed) || this.closedOwnerIdentities.has(cleanupOwnerIdentity(target))) return;
        const key = target.capability;
        const marker = this.cleanupMarkers.get(key) ?? { target, createdAt: Date.now(), attempts: 0, nextRetryAt: 0 };
        this.cleanupMarkers.set(key, marker);
        return { key, marker };
    }

    private async retryCleanupMarkers(force = false): Promise<void> {
        if (this.options.runtime.isClosed) {
            for (const marker of this.cleanupMarkers.values()) {
                this.closeCleanupTargetPeer(marker.target, 'sRPC mesh runtime closed before capability cleanup');
            }
            this.cleanupMarkers.clear();
            return;
        }
        const now = Date.now();
        await Promise.allSettled(
            [...this.cleanupMarkers]
                .filter(([, marker]) => force || (marker.nextRetryAt ?? 0) <= now)
                .map(([key, marker]) => this.retryCleanupMarker(key, marker, force))
        );
    }

    private async retryCleanupMarker(key: string, marker: CleanupMarker, force = false): Promise<void> {
        if (this.options.runtime.isClosed) {
            this.closeCleanupTargetPeer(marker.target, 'sRPC mesh runtime closed before capability cleanup');
            if (this.cleanupMarkers.get(key) === marker) this.cleanupMarkers.delete(key);
            return;
        }
        if (marker.retrying) return marker.retrying;
        if (!force && (marker.nextRetryAt ?? 0) > Date.now()) return;
        const attempt = (async () => {
            if ((marker.createdAt ?? 0) + CleanupMarkerMaxAgeMs <= Date.now()) {
                this.closeCleanupTargetPeer(marker.target, 'sRPC mesh capability cleanup expired');
                if (this.cleanupMarkers.get(key) === marker) this.cleanupMarkers.delete(key);
                return;
            }
            const target = marker.target;
            const node = await this.options.service.mesh.getNode(target.ownerNodeId);
            // A concurrent authenticated owner revocation supersedes this
            // requester-side cleanup obligation. Do not send a stale cleanup
            // or close a shared peer after the exact marker was consumed.
            if (this.cleanupMarkers.get(key) !== marker) return;
            if (
                !this.supportsDirectLink(node) ||
                (target.ownerEndpointId
                    ? node.linkEndpointId !== target.ownerEndpointId
                    : target.ownerProcessId !== undefined && node.processId !== target.ownerProcessId)
            ) {
                this.closeCleanupTargetPeer(target, 'sRPC mesh capability owner changed before cleanup');
                if (this.cleanupMarkers.get(key) === marker) this.cleanupMarkers.delete(key);
                return;
            }
            await this.releaseReservation(
                target.clientId,
                target.connectionId,
                node,
                [],
                target.ownerProcessId,
                target.ownerEndpointId,
                target.capability,
                true
            );
            if (this.cleanupMarkers.get(key) === marker) this.cleanupMarkers.delete(key);
        })().catch(error => {
            marker.attempts = (marker.attempts ?? 0) + 1;
            marker.nextRetryAt = Date.now() + Math.min(30_000, 250 * 2 ** Math.min(marker.attempts, 7));
            throw error;
        });
        marker.retrying = attempt;
        try {
            await attempt;
        } finally {
            if (marker.retrying === attempt) marker.retrying = undefined;
        }
    }

    private async drainCleanupMarkers(): Promise<void> {
        const deadline = Date.now() + Math.min(2_000, this.options.requestTimeoutMs);
        while (this.cleanupMarkers.size > 0 && Date.now() < deadline) {
            await this.retryCleanupMarkers(true);
            if (this.cleanupMarkers.size > 0) await pauseForDrain(deadline);
        }
    }

    private closeCleanupTargetPeer(target: CleanupTarget, reason: string): void {
        this.closePinnedPeer(
            {
                processId: target.ownerProcessId,
                endpointId: target.ownerEndpointId,
                publicKey: target.ownerEndpointPublicKey
            },
            reason
        );
    }

    private rememberClosedOwnerIdentity(identity: string): void {
        this.closedOwnerIdentities.delete(identity);
        this.closedOwnerIdentities.add(identity);
        while (this.closedOwnerIdentities.size > MaxRemoteConnections) {
            const oldest = this.closedOwnerIdentities.values().next().value;
            if (oldest === undefined) break;
            this.closedOwnerIdentities.delete(oldest);
        }
    }

    private assertLeaseSafe(): void {
        // Structural test/custom service doubles written before lease fencing
        // may omit the hook. The production MeshClientService always supplies
        // it, and route work remains fail-closed through membership checks.
        const assertLeaseSafe = this.options.service.mesh.assertLeaseSafe;
        if (typeof assertLeaseSafe === 'function') assertLeaseSafe.call(this.options.service.mesh);
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('sRPC mesh link controller is closed');
    }
}

function senderRoutePeerIdentity(peer: MeshLinkPeer): string {
    return peer.endpointId;
}

function cleanupTargetForConnection(connection: MeshRemoteSrpcConnection<unknown>): CleanupTarget {
    if (!connection.capability) throw new SrpcMeshAuthenticationError('Missing sRPC mesh handle capability');
    return {
        clientId: connection.clientId,
        connectionId: connection.id,
        ownerNodeId: connection.ownerNodeId,
        ownerProcessId: connection.ownerProcessId,
        ownerEndpointId: connection.ownerEndpointId,
        ownerEndpointPublicKey: connection.ownerEndpointPublicKey,
        capability: connection.capability
    };
}

function cleanupOwnerIdentity(target: CleanupTarget): string {
    return target.ownerEndpointId ?? target.ownerProcessId ?? `node:${target.ownerNodeId}`;
}

function emptyResult(header: Partial<MeshLinkFrameHeader> = {}): MeshLinkFrame {
    return {
        header: { type: 'result', ...header },
        body: Buffer.alloc(0)
    };
}

function requiredString(value: string | undefined, name: string): string {
    if (!value) throw new Error(`Missing sRPC mesh ${name}`);
    return value;
}

function requireStreamId(value: number | undefined): void {
    if (!Number.isSafeInteger(value) || value! <= 0) throw new Error('Invalid sRPC mesh stream ID');
}

function connectionKey(clientId: string, connectionId: string): string {
    return `${clientId}:${connectionId}`;
}

function routeKey(connectionId: string, streamId: number): string {
    return `${connectionId}:${streamId}`;
}

function splitRouteKey(key: string): [string, number] {
    const separator = key.lastIndexOf(':');
    return [key.slice(0, separator), Number(key.slice(separator + 1))];
}

function reservationKey(peerIdentity: string, reservationId: string): string {
    return `${peerIdentity}:${reservationId}`;
}

function isOpaqueId(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 16 && value.length <= 256;
}

function validateReservedIds(ids: number[] | undefined, maxCount = SenderIdReservationSize): number[] {
    if (!isValidReservedIds(ids, maxCount)) {
        throw new SrpcBackpressureError('Invalid remote sRPC byte stream reservation response');
    }
    return ids;
}

function isValidReservedIds(ids: number[] | undefined, maxCount: number): ids is number[] {
    return Boolean(
        ids && ids.length >= 1 && ids.length <= maxCount && new Set(ids).size === ids.length && ids.every(id => Number.isSafeInteger(id) && id > 0)
    );
}

function countPrefixedKeys(map: Map<string, unknown>, connectionId: string): number {
    let count = 0;
    for (const key of map.keys()) {
        if (key.startsWith(`${connectionId}:`)) count++;
    }
    return count;
}

function safeDestroy(receiver: SrpcByteStream, error?: Error): void {
    if (receiver.destroyed) return;
    try {
        receiver.destroy(error);
    } catch {}
}

function isMeshInvokeResult(value: Uint8Array | MeshLocalInvokeResult): value is MeshLocalInvokeResult {
    return !(value instanceof Uint8Array) && 'body' in value;
}

function invokeBody(value: Uint8Array | MeshLocalInvokeResult): Uint8Array {
    return isMeshInvokeResult(value) ? value.body : value;
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(values.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, values.length) }, async () => {
            while (nextIndex < values.length) {
                const index = nextIndex++;
                results[index] = await fn(values[index]);
            }
        })
    );
    return results;
}

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
    if (promises.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>(resolve => {
            timer = setTimeout(resolve, Math.max(1, timeoutMs));
            timer.unref?.();
        })
    ]);
    if (timer) clearTimeout(timer);
}

function remainingDeadline(deadlineAt: number, clientId: string): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
        throw new SrpcOwnerUnavailableError(clientId, new Error('sRPC mesh operation timed out'));
    }
    return remaining;
}

function validatedFrameDeadline(deadlineAt: unknown, timeoutMs: unknown, clientId: string, receivedAt = Date.now()): number {
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
        throw new SrpcStaleConnectionError(clientId);
    }
    // deadlineAt is a foreign epoch and cannot be compared safely across
    // independently skewed hosts. timeoutMs is the authenticated residual
    // budget; subsequent local awaits decrement this receiver-local deadline.
    void deadlineAt;
    return receivedAt + timeout;
}

async function withinDeadline<T>(promise: Promise<T>, deadlineAt: number, clientId: string): Promise<T> {
    const remaining = remainingDeadline(deadlineAt, clientId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new SrpcOwnerUnavailableError(clientId, new Error('sRPC mesh operation timed out'))), remaining);
                timer.unref?.();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function pauseForDrain(deadlineAt: number): Promise<void> {
    const delay = Math.min(10, Math.max(0, deadlineAt - Date.now()));
    if (delay <= 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, delay));
}

function reconstructRemoteError(error: unknown, clientId: string): Error {
    if (!(error instanceof Error)) return new Error(String(error));
    switch (error.name) {
        case 'SrpcError':
            return new SrpcError(error.message, 'isUserError' in error && typeof error.isUserError === 'boolean' ? error.isUserError : undefined);
        case 'SrpcClientNotFoundError':
            return new SrpcClientNotFoundError(clientId);
        case 'SrpcStaleConnectionError':
            return new SrpcStaleConnectionError(clientId);
        case 'SrpcOwnerUnavailableError':
            return new SrpcOwnerUnavailableError(clientId, error);
        case 'SrpcIndeterminateDeliveryError':
            return new SrpcIndeterminateDeliveryError(clientId, error);
        case 'SrpcMeshProtocolError':
            return new SrpcMeshProtocolError(error.message);
        case 'SrpcMeshAuthenticationError':
            return new SrpcMeshAuthenticationError(error.message);
        case 'SrpcBackpressureError':
            return new SrpcBackpressureError(error.message);
        case 'SrpcStreamClosedError':
            return new SrpcStreamClosedError(error.message);
        case 'ClientDisconnectedError':
            return new ClientDisconnectedError(clientId);
        case 'ClientInvocationError':
            return new ClientInvocationError(error.message);
        default:
            return error;
    }
}
