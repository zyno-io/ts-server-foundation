import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { SrpcBackpressureError, SrpcIndeterminateDeliveryError, SrpcMeshProtocolError, SrpcOwnerUnavailableError } from '../../srpc/types';
import { decodeMeshLinkFrame, encodeMeshLinkFrame, type MeshLinkFrame, type MeshLinkFrameHeader } from './protocol';

const MaxInFlightRequests = 4_096;
const PingIntervalMs = 15_000;
const PongTimeoutMs = 30_000;

interface PendingRequest {
    clientId: string;
    accepted: boolean;
    resolve: (frame: MeshLinkFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export type MeshLinkRequestHandler = (peer: MeshLinkPeer, frame: MeshLinkFrame) => Promise<MeshLinkFrame>;

export class MeshLinkPeer {
    private readonly pending = new Map<string, PendingRequest>();
    private readonly closeHandlers = new Set<() => void>();
    private closed = false;
    private closeNotified = false;
    private lastActivityAt = Date.now();
    private lastPongAt = Date.now();
    private activeIncomingRequests = 0;
    private readonly pingTimer: ReturnType<typeof setInterval>;

    constructor(
        readonly processId: string,
        private readonly ws: WebSocket,
        private readonly maxFrameBytes: number,
        private readonly maxBufferedBytes: number,
        private readonly handler: MeshLinkRequestHandler
    ) {
        ws.binaryType = 'nodebuffer';
        ws.on('message', data => this.handleMessage(toBuffer(data)));
        ws.on('close', () => this.handleClose());
        ws.on('error', () => this.handleClose());
        ws.on('pong', () => {
            this.lastPongAt = Date.now();
        });
        this.pingTimer = setInterval(() => this.ping(), PingIntervalMs);
        this.pingTimer.unref?.();
    }

    get connected(): boolean {
        return !this.closed && this.ws.readyState === WebSocket.OPEN;
    }

    get idleSince(): number {
        return this.lastActivityAt;
    }

    onClose(handler: () => void): () => void {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }

    async request(header: Omit<MeshLinkFrameHeader, 'version' | 'id'>, body: Uint8Array, timeoutMs: number): Promise<MeshLinkFrame> {
        if (this.pending.size >= MaxInFlightRequests) throw new SrpcBackpressureError('Too many in-flight sRPC mesh requests');
        const id = randomUUID();
        const clientId = header.clientId ?? 'unknown';
        return new Promise<MeshLinkFrame>((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(id);
                this.pending.delete(id);
                reject(
                    pending?.accepted ? new SrpcIndeterminateDeliveryError(clientId) : new Error(`sRPC mesh request timed out after ${timeoutMs}ms`)
                );
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { clientId, accepted: false, resolve, reject, timer });
            try {
                this.send({ ...header, id }, body);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    send(header: Omit<MeshLinkFrameHeader, 'version'>, body: Uint8Array = new Uint8Array()): void {
        if (!this.connected) throw new SrpcOwnerUnavailableError(header.clientId ?? 'unknown');
        const encoded = encodeMeshLinkFrame(header, body);
        if (encoded.length > this.maxFrameBytes) throw new SrpcMeshProtocolError('sRPC mesh frame exceeds the configured limit');
        if (this.ws.bufferedAmount + encoded.length > this.maxBufferedBytes) throw new SrpcBackpressureError();
        this.lastActivityAt = Date.now();
        this.ws.send(encoded);
    }

    close(code = 1000, reason = 'sRPC mesh peer closed'): void {
        if (this.closed) return;
        this.closed = true;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason.slice(0, 123));
        this.handleClose();
    }

    private handleMessage(data: Buffer): void {
        this.lastActivityAt = Date.now();
        let frame: MeshLinkFrame;
        try {
            frame = decodeMeshLinkFrame(data, this.maxFrameBytes);
        } catch {
            this.close(4000, 'Invalid sRPC mesh frame');
            return;
        }

        const replyTo = frame.header.replyTo;
        if (replyTo) {
            const pending = this.pending.get(replyTo);
            if (!pending) return;
            if (frame.header.type === 'accepted') {
                pending.accepted = true;
                return;
            }
            clearTimeout(pending.timer);
            this.pending.delete(replyTo);
            if (frame.header.ok === false) {
                const error = new Error(frame.header.error ?? 'Remote sRPC mesh operation failed');
                error.name = frame.header.errorName ?? 'Error';
                if (frame.header.userError !== undefined) {
                    (error as Error & { isUserError?: boolean }).isUserError = frame.header.userError;
                }
                pending.reject(error);
            } else {
                pending.resolve(frame);
            }
            return;
        }

        if (!frame.header.id) {
            this.close(4000, 'Missing sRPC mesh request ID');
            return;
        }
        const requestId = frame.header.id;
        if (this.activeIncomingRequests >= MaxInFlightRequests) {
            this.sendReply({
                type: 'result',
                replyTo: requestId,
                ok: false,
                error: 'Too many in-flight sRPC mesh requests',
                errorName: 'SrpcBackpressureError'
            });
            return;
        }
        this.activeIncomingRequests++;
        this.send({ type: 'accepted', replyTo: requestId });
        this.handler(this, frame)
            .then(
                response => this.sendReply({ ...response.header, type: 'result', replyTo: requestId, ok: true }, response.body),
                error =>
                    this.sendReply({
                        type: 'result',
                        replyTo: requestId,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                        errorName: error instanceof Error ? error.name : undefined,
                        userError: error instanceof Error && 'isUserError' in error ? Boolean(error.isUserError) : undefined
                    })
            )
            .finally(() => {
                this.activeIncomingRequests--;
            });
    }

    private handleClose(): void {
        if (this.closeNotified) return;
        this.closeNotified = true;
        this.closed = true;
        clearInterval(this.pingTimer);
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(pending.accepted ? new SrpcIndeterminateDeliveryError(pending.clientId) : new SrpcOwnerUnavailableError(pending.clientId));
            this.pending.delete(id);
        }
        for (const handler of this.closeHandlers) handler();
        this.closeHandlers.clear();
    }

    private sendReply(header: Omit<MeshLinkFrameHeader, 'version'>, body?: Uint8Array): void {
        try {
            this.send(header, body);
        } catch {
            // The requester observes link closure through its pending request.
        }
    }

    private ping(): void {
        if (!this.connected) return;
        if (this.lastPongAt < Date.now() - PongTimeoutMs) {
            this.ws.terminate();
            return;
        }
        this.ws.ping();
    }
}

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}
