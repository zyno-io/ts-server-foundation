import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';

import WebSocket from 'ws';

import { getCurrentApp } from '../../app';
import { assertSafeTimerMs, MAX_SAFE_TIMER_MS } from '../../helpers';
import { createWebSocketUpgradeHandler, installWebSocketUpgradeHandler, removeWebSocketUpgradeHandler } from '../../http';
import { SrpcMeshAuthenticationError, SrpcOwnerUnavailableError } from '../../srpc/types';
import {
    createMeshLinkEndpointKeyPair,
    MeshLinkAuthenticator,
    signMeshLinkEndpointProof,
    verifyMeshLinkEndpointProof,
    type MeshLinkAuthIdentity,
    type MeshLinkEndpointKeyPair
} from './auth';
import { MeshLinkPeer, type MeshLinkIncomingBudget, type MeshLinkRequestHandler } from './peer';
import { MeshLinkProtocolVersion, type MeshLinkFrame, type MeshLinkFrameHeader } from './protocol';

export interface MeshLinkRuntimeOptions {
    path: string;
    secret: string;
    httpServer?: Server;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    maxFrameBytes: number;
    maxBufferedBytes: number;
    maxPeers?: number;
    maxInboundPeers?: number;
    maxOutboundPeers?: number;
    maxCachedUrls?: number;
    /** Maximum static, owned, and resolver-created endpoint pins. */
    maxEndpointPins?: number;
    endpointPins?: Readonly<Record<string, string>>;
}

type MeshRoute = (peer: MeshLinkPeer, frame: MeshLinkFrame) => Promise<MeshLinkFrame>;
export interface MeshLinkResolvedEndpointPin {
    publicKey: string;
    /** Absolute local deadline; resolvers should derive this from the live lease. */
    expiresAt: number;
}
export type MeshLinkEndpointPinResolver = (processId: string, endpointId: string) => Promise<string | MeshLinkResolvedEndpointPin | undefined>;

interface EndpointPin {
    publicKey: string;
    processId?: string;
    expiresAt: number;
    owners: Set<symbol>;
}

const runtimes = new WeakMap<object, MeshLinkRuntime>();
const processId = randomUUID();
const HandshakeIdentityHeaders = {
    processId: 'x-tsf-mesh-process-id',
    endpointId: 'x-tsf-mesh-endpoint-id',
    timestamp: 'x-tsf-mesh-timestamp',
    nonce: 'x-tsf-mesh-nonce',
    signature: 'x-tsf-mesh-signature',
    requesterEndpointId: 'x-tsf-mesh-requester-endpoint-id',
    requestNonce: 'x-tsf-mesh-request-nonce'
} as const;

export function getMeshLinkProcessId(): string {
    return processId;
}

export function acquireMeshLinkRuntime(options: MeshLinkRuntimeOptions): MeshLinkRuntime {
    const owner = options.httpServer ?? getCurrentApp().http;
    const existing = runtimes.get(owner);
    if (existing) {
        existing.assertCompatible(options);
        return existing;
    }
    const runtime = new MeshLinkRuntime(options, () => runtimes.delete(owner));
    runtimes.set(owner, runtime);
    return runtime;
}

export class MeshLinkRuntime {
    private readonly wsServer: WebSocket.Server;
    private readonly authenticator: MeshLinkAuthenticator;
    private readonly routes = new Map<string, MeshRoute>();
    private readonly endpointPins = new Map<string, EndpointPin>();
    private readonly endpointPinResolvers = new Set<MeshLinkEndpointPinResolver>();
    private readonly peersByUrl = new Map<string, Promise<MeshLinkPeer>>();
    private readonly peersByIdentity = new Map<string, { peer: MeshLinkPeer; direction: 'inbound' | 'outbound' }>();
    private readonly acceptedPeers = new Set<MeshLinkPeer>();
    private readonly allPeers = new Set<MeshLinkPeer>();
    private readonly peerDirections = new WeakMap<MeshLinkPeer, 'inbound' | 'outbound'>();
    private readonly connectingSockets = new Set<WebSocket>();
    private readonly peerCloseHandlers = new Set<(processId: string, endpointId: string) => void>();
    private readonly incomingBudget: MeshLinkIncomingBudget = { activeRequests: 0, activeBytes: 0 };
    private readonly cleanupUpgradeHandler: () => void;
    private readonly idleTimer: ReturnType<typeof setInterval>;
    private readonly endpointId = randomUUID();
    private readonly endpointKeyPair: MeshLinkEndpointKeyPair;
    private pendingHandshakes = 0;
    private closed = false;

    constructor(
        private readonly options: MeshLinkRuntimeOptions,
        private readonly onClose?: () => void
    ) {
        validateRuntimeOptions(options);
        this.authenticator = new MeshLinkAuthenticator(options.secret);
        this.endpointKeyPair = createMeshLinkEndpointKeyPair();
        for (const [endpointId, publicKey] of Object.entries(options.endpointPins ?? {})) {
            this.endpointPins.set(endpointId, { publicKey, expiresAt: Number.POSITIVE_INFINITY, owners: new Set() });
        }
        if (this.endpointPins.size > this.maxEndpointPins) throw new Error('sRPC mesh-link endpoint pin limit is exceeded');
        this.wsServer = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: options.maxFrameBytes });
        this.wsServer.on('connection', (ws, request) => this.acceptPeer(ws, request));
        this.wsServer.on('headers', (headers, request) => this.addHandshakeIdentityHeaders(headers, request));
        if (options.httpServer) {
            const handler = installWebSocketUpgradeHandler({
                httpServer: options.httpServer,
                wsPath: options.path,
                wsServer: this.wsServer,
                verifyClient: this.verifyClient
            });
            this.cleanupUpgradeHandler = () => removeWebSocketUpgradeHandler(options.httpServer!, options.path, handler);
        } else {
            const handler = createWebSocketUpgradeHandler({
                wsPath: options.path,
                wsServer: this.wsServer,
                verifyClient: this.verifyClient
            });
            this.cleanupUpgradeHandler = getCurrentApp().http.registerUpgradeHandler(handler);
        }
        this.idleTimer = setInterval(() => this.closeIdlePeers(), Math.max(1_000, Math.floor(options.idleTimeoutMs / 2)));
        this.idleTimer.unref?.();
    }

    assertCompatible(options: MeshLinkRuntimeOptions): void {
        if (
            options.path !== this.options.path ||
            options.secret !== this.options.secret ||
            options.connectTimeoutMs !== this.options.connectTimeoutMs ||
            options.idleTimeoutMs !== this.options.idleTimeoutMs ||
            options.maxFrameBytes !== this.options.maxFrameBytes ||
            options.maxBufferedBytes !== this.options.maxBufferedBytes ||
            normalizedResourceLimits(options) !== normalizedResourceLimits(this.options) ||
            normalizedPins(options.endpointPins) !== normalizedPins(this.options.endpointPins)
        ) {
            throw new Error('All sRPC mesh servers sharing an HTTP listener must use identical mesh-link transport configuration');
        }
    }

    get id(): string {
        return this.endpointId;
    }

    get publicKey(): string {
        return this.endpointKeyPair.publicKey;
    }

    /** Install a membership pin before accepting or selecting that endpoint. */
    pinEndpoint(endpointId: string, publicKey: string, processId?: string, ttlMs = 30_000): () => void {
        if (!endpointId || !publicKey) throw new Error('sRPC mesh endpoint pin requires an endpoint ID and public key');
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_147_483_647) throw new Error('sRPC mesh endpoint pin TTL is invalid');
        const owner = Symbol(endpointId);
        this.pruneEndpointPins();
        const existing = this.endpointPins.get(endpointId);
        if (
            existing &&
            (existing.owners.size > 0 || existing.expiresAt > Date.now()) &&
            (existing.publicKey !== publicKey || (existing.processId !== undefined && processId !== undefined && existing.processId !== processId))
        ) {
            throw new SrpcMeshAuthenticationError('Conflicting sRPC mesh endpoint membership pin');
        }
        const pin: EndpointPin = existing ?? { publicKey, processId, expiresAt: Date.now() + ttlMs, owners: new Set<symbol>() };
        if (!existing && this.endpointPins.size >= this.maxEndpointPins) {
            throw new SrpcMeshAuthenticationError('Too many sRPC mesh endpoint membership pins');
        }
        pin.publicKey = publicKey;
        pin.processId = processId ?? pin.processId;
        pin.expiresAt = Math.max(pin.expiresAt, Date.now() + ttlMs);
        pin.owners.add(owner);
        this.endpointPins.set(endpointId, pin);
        return () => {
            const current = this.endpointPins.get(endpointId);
            if (!current) return;
            current.owners.delete(owner);
            if (current.owners.size === 0 && current.expiresAt !== Number.POSITIVE_INFINITY) this.endpointPins.delete(endpointId);
        };
    }

    /** Resolve a missing pin from a live membership source during the WebSocket
     * handshake. The resolver must validate the process+endpoint lease itself. */
    registerEndpointPinResolver(resolver: MeshLinkEndpointPinResolver): () => void {
        this.endpointPinResolvers.add(resolver);
        return () => this.endpointPinResolvers.delete(resolver);
    }

    get isClosed(): boolean {
        return this.closed;
    }

    register(meshKey: string, route: MeshRoute): () => void {
        if (this.closed) throw new Error('sRPC mesh runtime is closed');
        if (this.routes.has(meshKey)) throw new Error(`sRPC mesh key is already registered in this process: ${meshKey}`);
        this.routes.set(meshKey, route);
        return () => {
            if (this.routes.get(meshKey) === route) this.routes.delete(meshKey);
            this.closeIfUnused();
        };
    }

    onPeerClosed(handler: (processId: string, endpointId: string) => void): () => void {
        this.peerCloseHandlers.add(handler);
        return () => this.peerCloseHandlers.delete(handler);
    }

    async request(
        url: string,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id'>,
        body: Uint8Array,
        timeoutMs: number,
        remoteProcessId?: string,
        remoteEndpointId?: string,
        remoteEndpointPublicKey?: string
    ): Promise<MeshLinkFrame> {
        this.assertOpen();
        assertSafeTimerMs(timeoutMs, 'sRPC mesh request timeout');
        const clientId = header.clientId ?? 'unknown';
        const deadlineAt = Date.now() + timeoutMs;
        const peer = await this.getPeer(url, deadlineAt, clientId, remoteProcessId, remoteEndpointId, remoteEndpointPublicKey);
        this.assertOpen();
        const dispatchTimeoutMs = remainingRequestMs(deadlineAt, clientId);
        return peer.request(
            {
                ...header,
                ...(header.timeoutMs !== undefined ? { timeoutMs: Math.min(header.timeoutMs, dispatchTimeoutMs) } : {})
            },
            body,
            dispatchTimeoutMs
        );
    }

    /**
     * Send a reverse tunnel frame to the current winning link for an
     * authenticated identity.  Do not retain a peer object here: duplicate
     * link arbitration can legitimately replace it while a tunnel is open.
     */
    async requestPeer(
        remoteProcessId: string,
        remoteEndpointId: string | undefined,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id'>,
        body: Uint8Array,
        timeoutMs: number,
        remoteEndpointPublicKey?: string
    ): Promise<MeshLinkFrame> {
        this.assertOpen();
        if (remoteEndpointId !== undefined && !remoteEndpointPublicKey) {
            throw new SrpcMeshAuthenticationError('sRPC mesh reverse routing requires the endpoint membership key');
        }
        const matches = [...this.peersByIdentity.values()].filter(
            candidate =>
                candidate.peer.processId === remoteProcessId &&
                (remoteEndpointId === undefined || candidate.peer.endpointId === remoteEndpointId) &&
                (remoteEndpointPublicKey === undefined || candidate.peer.publicKey === remoteEndpointPublicKey)
        );
        const peer = matches.length === 1 ? matches[0].peer : undefined;
        if (!peer?.connected) throw new SrpcOwnerUnavailableError(header.clientId ?? 'unknown');
        return peer.request(
            {
                ...header,
                ...(header.timeoutMs !== undefined ? { timeoutMs: Math.min(header.timeoutMs, timeoutMs) } : {})
            },
            body,
            timeoutMs
        );
    }

    closePeer(remoteProcessId: string | undefined, remoteEndpointId: string | undefined, reason: string, remoteEndpointPublicKey?: string): void {
        if (!remoteProcessId && !remoteEndpointId) return;
        if (remoteEndpointId !== undefined && !remoteEndpointPublicKey) {
            throw new SrpcMeshAuthenticationError('sRPC mesh peer close requires the endpoint membership key');
        }
        for (const { peer } of this.peersByIdentity.values()) {
            if (
                (remoteProcessId === undefined || peer.processId === remoteProcessId) &&
                (remoteEndpointId === undefined || peer.endpointId === remoteEndpointId) &&
                (remoteEndpointPublicKey === undefined || peer.publicKey === remoteEndpointPublicKey)
            ) {
                peer.close(1012, reason);
            }
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.idleTimer);
        this.cleanupUpgradeHandler();
        for (const peer of this.allPeers) peer.close(1001, 'sRPC mesh runtime stopped');
        this.acceptedPeers.clear();
        for (const socket of this.connectingSockets) socket.terminate();
        this.connectingSockets.clear();
        for (const peerPromise of this.peersByUrl.values())
            void peerPromise.then(
                peer => peer.close(1001, 'sRPC mesh runtime stopped'),
                () => {}
            );
        this.peersByUrl.clear();
        this.peersByIdentity.clear();
        this.allPeers.clear();
        this.routes.clear();
        this.peerCloseHandlers.clear();
        this.wsServer.close();
        this.onClose?.();
    }

    private closeIfUnused(): void {
        if (this.routes.size === 0) this.close();
    }

    private readonly verifyClient = (
        info: { origin: string; secure: boolean; req: IncomingMessage },
        cb: (res: boolean, code?: number, message?: string) => void
    ): void => {
        if (this.closed || this.pendingHandshakes >= this.maxInboundPeers || !this.canCreatePeer('inbound', this.pendingHandshakes)) {
            cb(false, 503, 'Mesh peer capacity reached');
            return;
        }
        this.pendingHandshakes++;
        void this.verifyIncomingClient(info.req)
            .then(
                () => cb(!this.closed, this.closed ? 503 : undefined, this.closed ? 'Mesh runtime closed' : undefined),
                error => cb(false, error instanceof SrpcMeshAuthenticationError ? 403 : 400, 'Mesh authentication failed')
            )
            .finally(() => {
                this.pendingHandshakes = Math.max(0, this.pendingHandshakes - 1);
            });
    };

    private async verifyIncomingClient(request: IncomingMessage): Promise<void> {
        try {
            const url = new URL(request.url ?? '', 'http://localhost');
            readProtocolVersion(url);
            const identity = readIdentity(url);
            // Direct runtime callers may authenticate an endpoint with a local
            // membership pin without knowing its endpoint ID in advance. Bind
            // the proof to this endpoint only when the caller supplied an
            // audience; the endpoint proof and membership-pin checks below
            // still authenticate every request in either case.
            this.verifyEndpointProof(identity, 'request', undefined, identity.audienceEndpointId === undefined ? undefined : this.endpointId, true);
            await this.authorizeEndpointPin(identity);
            // Only a proof authorized by membership may consume replay-cache
            // capacity. A group-secret holder cannot saturate it with invalid
            // endpoint signatures.
            this.authenticator.verify(identity, this.options.path, 'request');
        } catch (error) {
            throw error;
        }
    }

    private acceptPeer(ws: WebSocket, request: IncomingMessage): void {
        const url = new URL(request.url ?? '', 'http://localhost');
        const identity = readIdentity(url);
        if (!this.canCreatePeer('inbound')) {
            ws.close(1013, 'sRPC mesh inbound peer limit reached');
            return;
        }
        const peer = this.createPeer(identity.processId, ws, 'inbound', identity.endpointId ?? identity.processId, identity.endpointPublicKey ?? '');
        this.acceptedPeers.add(peer);
        ws.once('close', () => this.acceptedPeers.delete(peer));
        this.resolveDuplicatePeer(identity.processId, peer, 'inbound');
    }

    private async getPeer(
        rawUrl: string,
        deadlineAt: number,
        clientId: string,
        remoteProcessId?: string,
        remoteEndpointId?: string,
        remoteEndpointPublicKey?: string
    ): Promise<MeshLinkPeer> {
        this.assertOpen();
        const url = new URL(rawUrl);
        const key = meshUrlKey(url);
        const existing = this.peersByUrl.get(key);
        if (existing) {
            this.peersByUrl.delete(key);
            this.peersByUrl.set(key, existing);
            const peer = await waitForPeer(existing, deadlineAt, clientId);
            if (
                peer.connected &&
                (!remoteProcessId || peer.processId === remoteProcessId) &&
                (!remoteEndpointId || peer.endpointId === remoteEndpointId) &&
                (!remoteEndpointPublicKey || peer.publicKey === remoteEndpointPublicKey)
            ) {
                return peer;
            }
            if (peer.connected) peer.close(1000, 'sRPC mesh endpoint identity changed');
            this.peersByUrl.delete(key);
        }

        if (this.peersByUrl.size >= this.maxCachedUrls) this.evictUrlCacheEntry();
        const connecting = this.connect(url, remoteProcessId, remoteEndpointId, remoteEndpointPublicKey);
        this.peersByUrl.set(key, connecting);
        void connecting.catch(() => {
            if (this.peersByUrl.get(key) === connecting) this.peersByUrl.delete(key);
        });
        return waitForPeer(connecting, deadlineAt, clientId);
    }

    private connect(url: URL, remoteProcessId?: string, remoteEndpointId?: string, remoteEndpointPublicKey?: string): Promise<MeshLinkPeer> {
        if (!this.canCreatePeer('outbound')) {
            return Promise.reject(new SrpcOwnerUnavailableError('unknown', new Error('sRPC mesh outbound peer limit reached')));
        }
        const identity = this.authenticator.createIdentity(processId, this.options.path, 'request', this.endpointId, undefined, remoteEndpointId);
        url.searchParams.set('protocolVersion', String(MeshLinkProtocolVersion));
        url.searchParams.set('processId', identity.processId);
        url.searchParams.set('endpointId', identity.endpointId!);
        url.searchParams.set('timestamp', String(identity.timestamp));
        url.searchParams.set('nonce', identity.nonce);
        url.searchParams.set('signature', identity.signature);
        if (identity.audienceEndpointId) url.searchParams.set('audienceEndpointId', identity.audienceEndpointId);
        this.addEndpointProof(url.searchParams, identity, 'request');

        return new Promise<MeshLinkPeer>((resolve, reject) => {
            const ws = new WebSocket(url, {
                perMessageDeflate: false,
                handshakeTimeout: this.options.connectTimeoutMs,
                maxPayload: this.options.maxFrameBytes
            });
            this.connectingSockets.add(ws);
            let serverIdentity: MeshLinkAuthIdentity | undefined;
            let settled = false;
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                this.connectingSockets.delete(ws);
                ws.terminate();
                reject(error);
            };
            const timeout = setTimeout(() => {
                fail(new SrpcOwnerUnavailableError('unknown', new Error('sRPC mesh link connection timed out')));
            }, this.options.connectTimeoutMs);
            timeout.unref?.();
            ws.once('upgrade', response => {
                try {
                    serverIdentity = readHandshakeIdentity(response.headers);
                    this.verifyEndpointProof(serverIdentity, 'response', {
                        endpointId: this.endpointId,
                        nonce: identity.nonce
                    });
                    if (remoteProcessId && serverIdentity.processId !== remoteProcessId) {
                        throw new SrpcMeshAuthenticationError('sRPC mesh server identity does not match the expected process');
                    }
                    if (remoteEndpointId && serverIdentity.endpointId !== remoteEndpointId) {
                        throw new SrpcMeshAuthenticationError('sRPC mesh server identity does not match the expected endpoint');
                    }
                    if (remoteEndpointPublicKey && serverIdentity.endpointPublicKey !== remoteEndpointPublicKey) {
                        throw new SrpcMeshAuthenticationError('sRPC mesh server endpoint key does not match the expected membership pin');
                    }
                    this.authenticator.verify(serverIdentity, this.options.path, 'response', {
                        endpointId: this.endpointId,
                        nonce: identity.nonce
                    });
                } catch (error) {
                    fail(error instanceof Error ? error : new SrpcMeshAuthenticationError());
                }
            });
            ws.once('open', () => {
                if (settled) return;
                if (!serverIdentity) {
                    fail(new SrpcMeshAuthenticationError('sRPC mesh server did not provide a handshake identity'));
                    return;
                }
                if (this.closed) {
                    fail(new SrpcOwnerUnavailableError('unknown', new Error('sRPC mesh runtime is closed')));
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                this.connectingSockets.delete(ws);
                const peer = this.createPeer(serverIdentity.processId, ws, 'outbound', serverIdentity.endpointId!, serverIdentity.endpointPublicKey!);
                resolve(this.resolveDuplicatePeer(serverIdentity.processId, peer, 'outbound'));
            });
            ws.once('error', error => {
                fail(new SrpcOwnerUnavailableError('unknown', error));
            });
        });
    }

    private createPeer(
        remoteProcessId: string,
        ws: WebSocket,
        direction: 'inbound' | 'outbound',
        remoteEndpointId = remoteProcessId,
        remoteEndpointPublicKey = ''
    ): MeshLinkPeer {
        const handler: MeshLinkRequestHandler = async (peer, frame) => {
            const meshKey = frame.header.meshKey;
            const route = meshKey ? this.routes.get(meshKey) : undefined;
            if (!route) throw new Error(`No local sRPC mesh route for key: ${meshKey ?? '(missing)'}`);
            return route(peer, frame);
        };
        const peer = new MeshLinkPeer(
            remoteProcessId,
            ws,
            this.options.maxFrameBytes,
            this.options.maxBufferedBytes,
            handler,
            remoteEndpointId,
            this.incomingBudget,
            remoteEndpointPublicKey
        );
        this.allPeers.add(peer);
        this.peerDirections.set(peer, direction);
        peer.onClose(() => {
            this.allPeers.delete(peer);
            this.pruneEndpointPins();
            const identity = peerIdentity(peer);
            if (this.peersByIdentity.get(identity)?.peer === peer) this.peersByIdentity.delete(identity);
            if ([...this.allPeers].some(candidate => peerIdentity(candidate) === identity && candidate.connected)) return;
            for (const closeHandler of this.peerCloseHandlers) {
                try {
                    closeHandler(remoteProcessId, remoteEndpointId);
                } catch {
                    // Consumer callbacks must not prevent transport cleanup.
                }
            }
        });
        return peer;
    }

    private resolveDuplicatePeer(remoteProcessId: string, peer: MeshLinkPeer, direction: 'inbound' | 'outbound'): MeshLinkPeer {
        const identity = peerIdentity(peer);
        const existing = this.peersByIdentity.get(identity);
        if (!existing?.peer.connected) {
            this.peersByIdentity.set(identity, { peer, direction });
            return peer;
        }
        const preferredDirection = this.endpointId < peer.endpointId ? 'outbound' : 'inbound';
        if (direction === preferredDirection && existing.direction !== preferredDirection) {
            this.peersByIdentity.set(identity, { peer, direction });
            existing.peer.close(1000, 'Duplicate sRPC mesh link');
            return peer;
        } else {
            peer.close(1000, 'Duplicate sRPC mesh link');
            return existing.peer;
        }
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('sRPC mesh runtime is closed');
    }

    private addHandshakeIdentityHeaders(headers: string[], request: IncomingMessage): void {
        const requestIdentity = readIdentity(new URL(request.url ?? '', 'http://localhost'));
        const identity = this.authenticator.createIdentity(processId, this.options.path, 'response', this.endpointId, {
            endpointId: requestIdentity.endpointId ?? '',
            nonce: requestIdentity.nonce
        });
        const proof = this.endpointProof(identity, 'response', {
            endpointId: requestIdentity.endpointId ?? '',
            nonce: requestIdentity.nonce
        });
        headers.push(
            `${HandshakeIdentityHeaders.processId}: ${identity.processId}`,
            `${HandshakeIdentityHeaders.endpointId}: ${identity.endpointId}`,
            `${HandshakeIdentityHeaders.timestamp}: ${identity.timestamp}`,
            `${HandshakeIdentityHeaders.nonce}: ${identity.nonce}`,
            `${HandshakeIdentityHeaders.signature}: ${identity.signature}`,
            `${HandshakeIdentityHeaders.requesterEndpointId}: ${identity.requesterEndpointId}`,
            `${HandshakeIdentityHeaders.requestNonce}: ${identity.requestNonce}`,
            `x-tsf-mesh-endpoint-public-key: ${proof.publicKey}`,
            `x-tsf-mesh-endpoint-signature: ${proof.signature}`
        );
    }

    private closeIdlePeers(): void {
        this.pruneEndpointPins();
        const deadline = Date.now() - this.options.idleTimeoutMs;
        for (const peer of this.allPeers) {
            if (!peer.connected || (peer.idleSince < deadline && !peer.hasActiveWork)) peer.close(1000, 'sRPC mesh link idle');
        }
        for (const [url, peerPromise] of this.peersByUrl) {
            void peerPromise.then(
                peer => {
                    if (!peer.connected && this.peersByUrl.get(url) === peerPromise) this.peersByUrl.delete(url);
                },
                () => {
                    if (this.peersByUrl.get(url) === peerPromise) this.peersByUrl.delete(url);
                }
            );
        }
    }

    private get maxPeers(): number {
        return this.options.maxPeers ?? 1_024;
    }

    private get maxEndpointPins(): number {
        return this.options.maxEndpointPins ?? this.maxPeers * 2;
    }

    private get maxInboundPeers(): number {
        return this.options.maxInboundPeers ?? Math.max(1, Math.floor(this.maxPeers / 2));
    }

    private get maxOutboundPeers(): number {
        return this.options.maxOutboundPeers ?? this.maxPeers - this.maxInboundPeers;
    }

    private get maxCachedUrls(): number {
        return this.options.maxCachedUrls ?? this.maxPeers;
    }

    private canCreatePeer(direction: 'inbound' | 'outbound', pending = 0): boolean {
        if (this.allPeers.size + this.connectingSockets.size + pending >= this.maxPeers) return false;
        let matching = 0;
        for (const peer of this.allPeers) {
            if (this.peerDirections.get(peer) === direction) matching++;
        }
        if (direction === 'outbound') matching += this.connectingSockets.size;
        return matching + pending < (direction === 'inbound' ? this.maxInboundPeers : this.maxOutboundPeers);
    }

    private evictUrlCacheEntry(): void {
        const candidate = this.peersByUrl.entries().next().value as [string, Promise<MeshLinkPeer>] | undefined;
        if (!candidate) return;
        const [key, peerPromise] = candidate;
        this.peersByUrl.delete(key);
        // The identity map may still own this peer and other callers may be using
        // it. Cache eviction drops only the URL reference.
        void peerPromise.catch(() => {});
    }

    private addEndpointProof(params: URLSearchParams, identity: MeshLinkAuthIdentity, purpose: 'request' | 'response'): void {
        const proof = this.endpointProof(
            identity,
            purpose,
            purpose === 'response' ? { endpointId: identity.requesterEndpointId ?? '', nonce: identity.requestNonce ?? '' } : undefined
        );
        params.set('endpointPublicKey', proof.publicKey);
        params.set('endpointSignature', proof.signature);
    }

    private endpointProof(
        identity: MeshLinkAuthIdentity,
        purpose: 'request' | 'response',
        responseTo?: { endpointId: string; nonce: string }
    ): { publicKey: string; signature: string } {
        const proofIdentity = { ...identity, endpointPublicKey: this.endpointKeyPair.publicKey };
        return {
            publicKey: this.endpointKeyPair.publicKey,
            signature: signMeshLinkEndpointProof(this.endpointKeyPair.privateKey, proofIdentity, this.options.path, purpose, responseTo)
        };
    }

    private verifyEndpointProof(
        identity: MeshLinkAuthIdentity,
        purpose: 'request' | 'response',
        responseTo?: { endpointId: string; nonce: string },
        audienceEndpointId?: string,
        deferPinAuthorization = false
    ): void {
        if (!identity.endpointId || !identity.endpointPublicKey || !identity.endpointSignature) {
            throw new SrpcMeshAuthenticationError('sRPC mesh endpoint proof is missing');
        }
        if (!verifyMeshLinkEndpointProof(identity, this.options.path, purpose, responseTo)) {
            throw new SrpcMeshAuthenticationError('sRPC mesh endpoint proof is invalid');
        }
        if (purpose === 'request' && audienceEndpointId && identity.audienceEndpointId !== audienceEndpointId) {
            throw new SrpcMeshAuthenticationError('sRPC mesh request proof was issued for another endpoint');
        }
        if (deferPinAuthorization) return;
        const pin = this.getEndpointPin(identity.processId, identity.endpointId);
        if (pin === undefined || pin.publicKey !== identity.endpointPublicKey) {
            throw new SrpcMeshAuthenticationError('sRPC mesh endpoint key does not match its membership pin');
        }
    }

    private async authorizeEndpointPin(identity: MeshLinkAuthIdentity): Promise<void> {
        const endpointId = identity.endpointId!;
        const publicKey = identity.endpointPublicKey!;
        const pinned = this.getEndpointPin(identity.processId, endpointId);
        if (pinned !== undefined) {
            if (pinned.publicKey !== publicKey) throw new SrpcMeshAuthenticationError('sRPC mesh endpoint key does not match its membership pin');
            return;
        }
        for (const resolver of this.endpointPinResolvers) {
            const result = await withTimeout(
                resolver(identity.processId, endpointId),
                this.options.connectTimeoutMs,
                'sRPC mesh endpoint pin resolver timed out'
            );
            if (this.closed) throw new SrpcOwnerUnavailableError('unknown', new Error('sRPC mesh runtime is closed'));
            if (result === undefined) continue;
            const resolved = typeof result === 'string' ? { publicKey: result, expiresAt: Date.now() + 1_000 } : result;
            if (resolved.publicKey !== publicKey || !Number.isFinite(resolved.expiresAt) || resolved.expiresAt <= Date.now()) {
                throw new SrpcMeshAuthenticationError('sRPC mesh endpoint key does not match its live membership pin');
            }
            this.pruneEndpointPins();
            if (this.endpointPins.size >= this.maxEndpointPins) {
                throw new SrpcMeshAuthenticationError('Too many sRPC mesh endpoint membership pins');
            }
            this.endpointPins.set(endpointId, {
                publicKey: resolved.publicKey,
                processId: identity.processId,
                expiresAt: resolved.expiresAt,
                owners: new Set()
            });
            return;
        }
        throw new SrpcMeshAuthenticationError('sRPC mesh endpoint has no live membership pin');
    }

    private getEndpointPin(processId: string, endpointId: string): EndpointPin | undefined {
        const pin = this.endpointPins.get(endpointId);
        if (!pin) return undefined;
        if (pin.processId !== undefined && pin.processId !== processId) return undefined;
        if (pin.expiresAt <= Date.now() && pin.owners.size === 0) {
            this.endpointPins.delete(endpointId);
            return undefined;
        }
        return pin;
    }

    private pruneEndpointPins(): void {
        const now = Date.now();
        for (const [endpointId, pin] of this.endpointPins) {
            if (pin.owners.size === 0 && pin.expiresAt <= now) this.endpointPins.delete(endpointId);
        }
    }
}

function peerIdentity(peer: MeshLinkPeer): string {
    return `${peer.processId}:${peer.endpointId}:${peer.publicKey}`;
}

function readIdentity(url: URL): MeshLinkAuthIdentity {
    return {
        processId: url.searchParams.get('processId') ?? '',
        endpointId: url.searchParams.get('endpointId') ?? undefined,
        audienceEndpointId: url.searchParams.get('audienceEndpointId') ?? undefined,
        endpointPublicKey: url.searchParams.get('endpointPublicKey') ?? undefined,
        endpointSignature: url.searchParams.get('endpointSignature') ?? undefined,
        timestamp: Number(url.searchParams.get('timestamp')),
        nonce: url.searchParams.get('nonce') ?? '',
        signature: url.searchParams.get('signature') ?? ''
    };
}

function readProtocolVersion(url: URL): number {
    const raw = url.searchParams.get('protocolVersion');
    if (raw === null) throw new SrpcMeshAuthenticationError('Missing sRPC mesh handshake protocol version');
    const version = Number(raw);
    if (version !== MeshLinkProtocolVersion) {
        throw new SrpcMeshAuthenticationError('Unsupported sRPC mesh handshake protocol version');
    }
    return version;
}

function meshUrlKey(url: URL): string {
    const key = new URL(url);
    for (const parameter of [
        'protocolVersion',
        'processId',
        'endpointId',
        'timestamp',
        'nonce',
        'signature',
        'audienceEndpointId',
        'endpointPublicKey',
        'endpointSignature'
    ]) {
        key.searchParams.delete(parameter);
    }
    key.searchParams.sort();
    return key.toString();
}

function readHandshakeIdentity(headers: IncomingMessage['headers']): MeshLinkAuthIdentity {
    const identity = {
        processId: readHeader(headers, HandshakeIdentityHeaders.processId),
        endpointId: readHeader(headers, HandshakeIdentityHeaders.endpointId),
        requesterEndpointId: readHeader(headers, HandshakeIdentityHeaders.requesterEndpointId),
        requestNonce: readHeader(headers, HandshakeIdentityHeaders.requestNonce),
        endpointPublicKey: readHeader(headers, 'x-tsf-mesh-endpoint-public-key'),
        endpointSignature: readHeader(headers, 'x-tsf-mesh-endpoint-signature'),
        timestamp: Number(readHeader(headers, HandshakeIdentityHeaders.timestamp)),
        nonce: readHeader(headers, HandshakeIdentityHeaders.nonce),
        signature: readHeader(headers, HandshakeIdentityHeaders.signature)
    };
    if (!identity.processId || !identity.endpointId || !identity.nonce || !identity.signature || !Number.isFinite(identity.timestamp)) {
        throw new SrpcMeshAuthenticationError('sRPC mesh server did not provide a handshake identity');
    }
    return identity;
}

function readHeader(headers: IncomingMessage['headers'], name: string): string {
    const value = headers[name];
    return typeof value === 'string' ? value : '';
}

async function waitForPeer(promise: Promise<MeshLinkPeer>, deadlineAt: number, clientId: string): Promise<MeshLinkPeer> {
    const remaining = remainingRequestMs(deadlineAt, clientId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new SrpcOwnerUnavailableError(clientId, new Error('sRPC mesh link connection timed out'))),
                    remaining
                );
                timer.unref?.();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function remainingRequestMs(deadlineAt: number, clientId: string): number {
    const remaining = Math.ceil(deadlineAt - Date.now());
    if (remaining < 1) {
        throw new SrpcOwnerUnavailableError(clientId, new Error('sRPC mesh link connection timed out'));
    }
    return Math.min(remaining, MAX_SAFE_TIMER_MS);
}

function validateRuntimeOptions(options: MeshLinkRuntimeOptions): void {
    if (!options.path.startsWith('/') || options.path.includes('?') || options.path.includes('#')) {
        throw new Error('sRPC mesh-link path must be an absolute URL path');
    }
    if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 100 || options.connectTimeoutMs > MAX_SAFE_TIMER_MS) {
        throw new Error('sRPC mesh-link connect timeout must be between 100ms and the platform timer limit');
    }
    if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1_000 || options.idleTimeoutMs > MAX_SAFE_TIMER_MS) {
        throw new Error('sRPC mesh-link idle timeout must be between 1000ms and the platform timer limit');
    }
    if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1_024 || options.maxFrameBytes > 64 * 1024 * 1024) {
        throw new Error('sRPC mesh-link frame limit must be between 1KiB and 64MiB');
    }
    if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < options.maxFrameBytes) {
        throw new Error('sRPC mesh-link buffered-byte limit must be at least the frame limit');
    }
    for (const [name, value] of [
        ['maxPeers', options.maxPeers],
        ['maxInboundPeers', options.maxInboundPeers],
        ['maxOutboundPeers', options.maxOutboundPeers],
        ['maxCachedUrls', options.maxCachedUrls],
        ['maxEndpointPins', options.maxEndpointPins]
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`sRPC mesh-link ${name} must be a positive integer`);
    }
    const maxPeers = options.maxPeers ?? 1_024;
    const maxInbound = options.maxInboundPeers ?? Math.max(1, Math.floor(maxPeers / 2));
    const maxOutbound = options.maxOutboundPeers ?? maxPeers - maxInbound;
    if (maxPeers < 2 || maxInbound + maxOutbound > maxPeers) {
        throw new Error('sRPC mesh-link peer limits require at least two total slots and inbound+outbound no greater than total');
    }
}

function normalizedResourceLimits(options: MeshLinkRuntimeOptions): string {
    const maxPeers = options.maxPeers ?? 1_024;
    const maxInboundPeers = options.maxInboundPeers ?? Math.max(1, Math.floor(maxPeers / 2));
    return JSON.stringify({
        maxPeers,
        maxInboundPeers,
        maxOutboundPeers: options.maxOutboundPeers ?? maxPeers - maxInboundPeers,
        maxCachedUrls: options.maxCachedUrls ?? maxPeers,
        maxEndpointPins: options.maxEndpointPins ?? maxPeers * 2
    });
}

function normalizedPins(pins: Readonly<Record<string, string>> | undefined): string {
    return JSON.stringify(Object.entries(pins ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SrpcMeshAuthenticationError(message)), timeoutMs);
        timer.unref?.();
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}
