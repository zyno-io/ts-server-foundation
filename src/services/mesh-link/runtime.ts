import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';

import WebSocket from 'ws';

import { getCurrentApp } from '../../app';
import { createWebSocketUpgradeHandler, installWebSocketUpgradeHandler, removeWebSocketUpgradeHandler } from '../../http';
import { SrpcMeshAuthenticationError, SrpcOwnerUnavailableError } from '../../srpc/types';
import { MeshLinkAuthenticator, type MeshLinkAuthIdentity } from './auth';
import { MeshLinkPeer, type MeshLinkRequestHandler } from './peer';
import type { MeshLinkFrame, MeshLinkFrameHeader } from './protocol';

export interface MeshLinkRuntimeOptions {
    path: string;
    secret: string;
    httpServer?: Server;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    maxFrameBytes: number;
    maxBufferedBytes: number;
}

type MeshRoute = (peer: MeshLinkPeer, frame: MeshLinkFrame) => Promise<MeshLinkFrame>;

const runtimes = new WeakMap<object, MeshLinkRuntime>();
const processId = randomUUID();

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
    private readonly wsServer = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
    private readonly authenticator: MeshLinkAuthenticator;
    private readonly routes = new Map<string, MeshRoute>();
    private readonly peersByUrl = new Map<string, Promise<MeshLinkPeer>>();
    private readonly peersByProcessId = new Map<string, { peer: MeshLinkPeer; direction: 'inbound' | 'outbound' }>();
    private readonly acceptedPeers = new Set<MeshLinkPeer>();
    private readonly allPeers = new Set<MeshLinkPeer>();
    private readonly peerCloseHandlers = new Set<(processId: string) => void>();
    private readonly cleanupUpgradeHandler: () => void;
    private readonly idleTimer: ReturnType<typeof setInterval>;
    private closed = false;

    constructor(
        private readonly options: MeshLinkRuntimeOptions,
        private readonly onClose?: () => void
    ) {
        validateRuntimeOptions(options);
        this.authenticator = new MeshLinkAuthenticator(options.secret);
        this.wsServer.on('connection', (ws, request) => this.acceptPeer(ws, request));
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
            options.maxBufferedBytes !== this.options.maxBufferedBytes
        ) {
            throw new Error('All sRPC mesh servers sharing an HTTP listener must use identical mesh-link transport configuration');
        }
    }

    register(meshKey: string, route: MeshRoute): () => void {
        if (this.routes.has(meshKey)) throw new Error(`sRPC mesh key is already registered in this process: ${meshKey}`);
        this.routes.set(meshKey, route);
        return () => {
            if (this.routes.get(meshKey) === route) this.routes.delete(meshKey);
            if (this.routes.size === 0) this.close();
        };
    }

    onPeerClosed(handler: (processId: string) => void): () => void {
        this.peerCloseHandlers.add(handler);
        return () => this.peerCloseHandlers.delete(handler);
    }

    async request(
        url: string,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id'>,
        body: Uint8Array,
        timeoutMs: number,
        remoteProcessId?: string
    ): Promise<MeshLinkFrame> {
        const peer = await this.getPeer(url, remoteProcessId);
        return peer.request(header, body, timeoutMs);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.idleTimer);
        this.cleanupUpgradeHandler();
        for (const peer of this.acceptedPeers) peer.close(1001, 'sRPC mesh runtime stopped');
        this.acceptedPeers.clear();
        for (const peerPromise of this.peersByUrl.values())
            void peerPromise.then(
                peer => peer.close(1001, 'sRPC mesh runtime stopped'),
                () => {}
            );
        this.peersByUrl.clear();
        this.peersByProcessId.clear();
        this.allPeers.clear();
        this.routes.clear();
        this.peerCloseHandlers.clear();
        this.wsServer.close();
        this.onClose?.();
    }

    private readonly verifyClient = (
        info: { origin: string; secure: boolean; req: IncomingMessage },
        cb: (res: boolean, code?: number, message?: string) => void
    ): void => {
        try {
            const url = new URL(info.req.url ?? '', 'http://localhost');
            this.authenticator.verify(readIdentity(url), this.options.path);
            cb(true);
        } catch (error) {
            cb(false, error instanceof SrpcMeshAuthenticationError ? 403 : 400, 'Mesh authentication failed');
        }
    };

    private acceptPeer(ws: WebSocket, request: IncomingMessage): void {
        const url = new URL(request.url ?? '', 'http://localhost');
        const identity = readIdentity(url);
        const peer = this.createPeer(identity.processId, ws, 'inbound');
        this.acceptedPeers.add(peer);
        ws.once('close', () => this.acceptedPeers.delete(peer));
    }

    private async getPeer(rawUrl: string, remoteProcessId?: string): Promise<MeshLinkPeer> {
        if (remoteProcessId) {
            const byProcess = this.peersByProcessId.get(remoteProcessId)?.peer;
            if (byProcess?.connected) return byProcess;
        }
        const url = new URL(rawUrl);
        const key = `${url.protocol}//${url.host}${url.pathname}`;
        const existing = this.peersByUrl.get(key);
        if (existing) {
            const peer = await existing;
            if (peer.connected) return peer;
            this.peersByUrl.delete(key);
        }

        const connecting = this.connect(url, remoteProcessId);
        this.peersByUrl.set(key, connecting);
        try {
            const peer = await connecting;
            return peer;
        } catch (error) {
            if (this.peersByUrl.get(key) === connecting) this.peersByUrl.delete(key);
            throw error;
        }
    }

    private connect(url: URL, remoteProcessId?: string): Promise<MeshLinkPeer> {
        const identity = this.authenticator.createIdentity(processId, this.options.path);
        url.searchParams.set('processId', identity.processId);
        url.searchParams.set('timestamp', String(identity.timestamp));
        url.searchParams.set('nonce', identity.nonce);
        url.searchParams.set('signature', identity.signature);

        return new Promise<MeshLinkPeer>((resolve, reject) => {
            const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: this.options.connectTimeoutMs });
            const timeout = setTimeout(() => {
                ws.terminate();
                reject(new SrpcOwnerUnavailableError('unknown', new Error('sRPC mesh link connection timed out')));
            }, this.options.connectTimeoutMs);
            timeout.unref?.();
            ws.once('open', () => {
                clearTimeout(timeout);
                resolve(this.createPeer(remoteProcessId ?? 'remote', ws, 'outbound'));
            });
            ws.once('error', error => {
                clearTimeout(timeout);
                reject(new SrpcOwnerUnavailableError('unknown', error));
            });
        });
    }

    private createPeer(remoteProcessId: string, ws: WebSocket, direction: 'inbound' | 'outbound'): MeshLinkPeer {
        const handler: MeshLinkRequestHandler = async (peer, frame) => {
            const meshKey = frame.header.meshKey;
            const route = meshKey ? this.routes.get(meshKey) : undefined;
            if (!route) throw new Error(`No local sRPC mesh route for key: ${meshKey ?? '(missing)'}`);
            return route(peer, frame);
        };
        const peer = new MeshLinkPeer(remoteProcessId, ws, this.options.maxFrameBytes, this.options.maxBufferedBytes, handler);
        this.allPeers.add(peer);
        if (remoteProcessId !== 'remote') this.resolveDuplicatePeer(remoteProcessId, peer, direction);
        peer.onClose(() => {
            this.allPeers.delete(peer);
            if (this.peersByProcessId.get(remoteProcessId)?.peer === peer) this.peersByProcessId.delete(remoteProcessId);
            if ([...this.allPeers].some(candidate => candidate.processId === remoteProcessId && candidate.connected)) return;
            for (const closeHandler of this.peerCloseHandlers) closeHandler(remoteProcessId);
        });
        return peer;
    }

    private resolveDuplicatePeer(remoteProcessId: string, peer: MeshLinkPeer, direction: 'inbound' | 'outbound'): void {
        const existing = this.peersByProcessId.get(remoteProcessId);
        if (!existing?.peer.connected) {
            this.peersByProcessId.set(remoteProcessId, { peer, direction });
            return;
        }
        const preferredDirection = processId < remoteProcessId ? 'outbound' : 'inbound';
        if (direction === preferredDirection && existing.direction !== preferredDirection) {
            this.peersByProcessId.set(remoteProcessId, { peer, direction });
            existing.peer.close(1000, 'Duplicate sRPC mesh link');
        } else {
            peer.close(1000, 'Duplicate sRPC mesh link');
        }
    }

    private closeIdlePeers(): void {
        const deadline = Date.now() - this.options.idleTimeoutMs;
        for (const [url, peerPromise] of this.peersByUrl) {
            void peerPromise.then(peer => {
                if (peer.idleSince < deadline) {
                    peer.close(1000, 'sRPC mesh link idle');
                    if (this.peersByUrl.get(url) === peerPromise) this.peersByUrl.delete(url);
                }
            });
        }
    }
}

function readIdentity(url: URL): MeshLinkAuthIdentity {
    return {
        processId: url.searchParams.get('processId') ?? '',
        timestamp: Number(url.searchParams.get('timestamp')),
        nonce: url.searchParams.get('nonce') ?? '',
        signature: url.searchParams.get('signature') ?? ''
    };
}

function validateRuntimeOptions(options: MeshLinkRuntimeOptions): void {
    if (!options.path.startsWith('/') || options.path.includes('?') || options.path.includes('#')) {
        throw new Error('sRPC mesh-link path must be an absolute URL path');
    }
    if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 100) {
        throw new Error('sRPC mesh-link connect timeout must be at least 100ms');
    }
    if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1_000) {
        throw new Error('sRPC mesh-link idle timeout must be at least 1000ms');
    }
    if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1_024 || options.maxFrameBytes > 64 * 1024 * 1024) {
        throw new Error('sRPC mesh-link frame limit must be between 1KiB and 64MiB');
    }
    if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < options.maxFrameBytes) {
        throw new Error('sRPC mesh-link buffered-byte limit must be at least the frame limit');
    }
}
