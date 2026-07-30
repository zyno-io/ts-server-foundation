import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { assertSafeTimerMs } from '../../helpers';
import { serializeSrpcError, SrpcBackpressureError, SrpcError, SrpcIndeterminateDeliveryError, SrpcOwnerUnavailableError } from '../../srpc/types';
import { decodeMeshLinkFrame, encodeMeshLinkFrame, MeshLinkProtocolVersion, type MeshLinkFrame, type MeshLinkFrameHeader } from './protocol';

const MaxInFlightRequests = 4_096;
const MaxInFlightRequestBytes = 64 * 1024 * 1024;
const MaxCompletedRequests = 4_096;
const MaxCompletedRequestBytes = 64 * 1024 * 1024;
const CompletedTombstoneReserveBytes = 2 * 1024 * 1024;
const PingIntervalMs = 15_000;
const PongTimeoutMs = 30_000;
const CompletedRequestTtlMs = 60_000;

interface PendingRequest {
    clientId: string;
    accepted: boolean;
    dispatched: boolean;
    resolve: (frame: MeshLinkFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface CompletedIncomingRequest {
    header: Omit<MeshLinkFrameHeader, 'version'>;
    body?: Buffer;
    expiresAt: number;
    retainedBytes: number;
}

export type MeshLinkRequestHandler = (peer: MeshLinkPeer, frame: MeshLinkFrame) => Promise<MeshLinkFrame>;

export interface MeshLinkIncomingBudget {
    activeRequests: number;
    activeBytes: number;
}

export class MeshLinkPeer {
    private readonly pending = new Map<string, PendingRequest>();
    private readonly closeHandlers = new Set<() => void>();
    private closed = false;
    private closeNotified = false;
    private lastActivityAt = Date.now();
    private lastPongAt = Date.now();
    private activeIncomingRequests = 0;
    private activeIncomingBytes = 0;
    private readonly activeIncoming = new Map<string, number>();
    /** Per-handler reservations that guarantee a completed-request tombstone can be retained. */
    private readonly activeIncomingTombstones = new Map<string, number>();
    private activeIncomingTombstoneBytes = 0;
    private readonly completedIncoming = new Map<string, CompletedIncomingRequest>();
    private completedIncomingBytes = 0;
    private readonly pingTimer: ReturnType<typeof setInterval>;

    constructor(
        readonly processId: string,
        private readonly ws: WebSocket,
        private readonly maxFrameBytes: number,
        private readonly maxBufferedBytes: number,
        private readonly handler: MeshLinkRequestHandler,
        readonly endpointId = processId,
        private readonly incomingBudget?: MeshLinkIncomingBudget,
        /** Verified v2 endpoint signing key (SPKI DER/base64). */
        readonly publicKey = ''
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

    get hasActiveWork(): boolean {
        return this.pending.size > 0 || this.activeIncomingRequests > 0;
    }

    onClose(handler: () => void): () => void {
        if (this.closeNotified) {
            let active = true;
            queueMicrotask(() => {
                if (active) handler();
            });
            return () => {
                active = false;
            };
        }
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }

    async request(header: Omit<MeshLinkFrameHeader, 'version' | 'id'>, body: Uint8Array, timeoutMs: number): Promise<MeshLinkFrame> {
        assertSafeTimerMs(timeoutMs, 'sRPC mesh request timeout');
        if (this.pending.size >= MaxInFlightRequests) throw new SrpcBackpressureError('Too many in-flight sRPC mesh requests');
        const id = randomUUID();
        const clientId = header.clientId ?? 'unknown';
        return new Promise<MeshLinkFrame>((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(id);
                this.pending.delete(id);
                reject(
                    pending?.dispatched ? new SrpcIndeterminateDeliveryError(clientId) : new Error(`sRPC mesh request timed out after ${timeoutMs}ms`)
                );
            }, timeoutMs);
            timer.unref?.();
            const pending: PendingRequest = { clientId, accepted: false, dispatched: false, resolve, reject, timer };
            this.pending.set(id, pending);
            try {
                this.send({ ...header, id }, body);
                pending.dispatched = true;
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    send(header: Omit<MeshLinkFrameHeader, 'version'>, body: Uint8Array = new Uint8Array()): void {
        if (!this.connected) throw new SrpcOwnerUnavailableError(header.clientId ?? 'unknown');
        const encoded = encodeMeshLinkFrame(header, body, this.maxFrameBytes);
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
                if (typeof frame.header.userError === 'boolean') {
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
        this.pruneCompletedIncoming();
        if (this.activeIncoming.has(requestId)) {
            // The first frame owns the handler and budget. Re-acknowledge a retry
            // without overwriting its accounting or executing the handler twice.
            this.sendReply({ type: 'accepted', replyTo: requestId });
            return;
        }
        const completed = this.completedIncoming.get(requestId);
        if (completed) {
            this.sendReply(completed.header, completed.body);
            return;
        }
        const requestBytes = data.length;
        const tombstone = this.createCompletedTombstone(requestId);
        if (
            this.activeIncomingRequests >= MaxInFlightRequests ||
            this.activeIncomingBytes + requestBytes > MaxInFlightRequestBytes ||
            (this.incomingBudget !== undefined &&
                (this.incomingBudget.activeRequests >= MaxInFlightRequests ||
                    this.incomingBudget.activeBytes + requestBytes > MaxInFlightRequestBytes))
        ) {
            this.sendReply({
                type: 'result',
                replyTo: requestId,
                ok: false,
                error: 'Too many in-flight sRPC mesh requests or bytes',
                errorName: 'SrpcBackpressureError'
            });
            return;
        }
        if (!this.canReserveCompletedRequest(tombstone.retainedBytes)) {
            this.sendReply({
                type: 'result',
                replyTo: requestId,
                ok: false,
                error: 'Completed sRPC mesh request dedupe capacity is full',
                errorName: 'SrpcBackpressureError'
            });
            return;
        }
        this.activeIncomingRequests++;
        this.activeIncomingBytes += requestBytes;
        this.activeIncoming.set(requestId, requestBytes);
        this.activeIncomingTombstones.set(requestId, tombstone.retainedBytes);
        this.activeIncomingTombstoneBytes += tombstone.retainedBytes;
        if (this.incomingBudget) {
            this.incomingBudget.activeRequests++;
            this.incomingBudget.activeBytes += requestBytes;
        }
        try {
            this.send({ type: 'accepted', replyTo: requestId });
        } catch {
            // Do not process a request that we could not acknowledge. The
            // requester may safely retry it, and this callback must not leak
            // an in-flight slot when the socket is closing or backpressured.
            this.releaseIncomingRequest(requestId);
            this.close(1011, 'Unable to acknowledge sRPC mesh request');
            return;
        }
        this.handler(this, frame)
            .then(
                response => {
                    const header = { ...response.header, type: 'result' as const, replyTo: requestId, ok: true };
                    const body = Buffer.from(response.body);
                    this.rememberCompleted(requestId, header, body);
                    this.sendReply(header, body);
                },
                error => {
                    const serialized = serializeSrpcError(error);
                    const header = {
                        type: 'result',
                        replyTo: requestId,
                        ok: false,
                        error: error instanceof SrpcError ? serialized.error : error instanceof Error ? error.message : String(error),
                        errorName: error instanceof Error ? error.name : undefined,
                        ...(error instanceof SrpcError && typeof serialized.userError === 'boolean' ? { userError: serialized.userError } : {})
                    } satisfies Omit<MeshLinkFrameHeader, 'version'>;
                    this.rememberCompleted(requestId, header);
                    this.sendReply(header);
                }
            )
            .finally(() => {
                this.releaseIncomingRequest(requestId);
            });
    }

    private releaseIncomingRequest(requestId: string): void {
        const requestBytes = this.activeIncoming.get(requestId);
        if (requestBytes === undefined) return;
        this.activeIncoming.delete(requestId);
        this.activeIncomingRequests = Math.max(0, this.activeIncomingRequests - 1);
        this.activeIncomingBytes = Math.max(0, this.activeIncomingBytes - requestBytes);
        const tombstoneBytes = this.activeIncomingTombstones.get(requestId);
        if (tombstoneBytes !== undefined) {
            this.activeIncomingTombstones.delete(requestId);
            this.activeIncomingTombstoneBytes = Math.max(0, this.activeIncomingTombstoneBytes - tombstoneBytes);
        }
        if (this.incomingBudget) {
            this.incomingBudget.activeRequests = Math.max(0, this.incomingBudget.activeRequests - 1);
            this.incomingBudget.activeBytes = Math.max(0, this.incomingBudget.activeBytes - requestBytes);
        }
    }

    private handleClose(): void {
        if (this.closeNotified) return;
        this.closeNotified = true;
        this.closed = true;
        clearInterval(this.pingTimer);
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(
                pending.dispatched ? new SrpcIndeterminateDeliveryError(pending.clientId) : new SrpcOwnerUnavailableError(pending.clientId)
            );
            this.pending.delete(id);
        }
        // Running handlers cannot be cancelled. Keep their shared budget charged
        // until their finally blocks finish, even though this peer is no longer
        // eligible for new work.
        for (const handler of this.closeHandlers) {
            try {
                handler();
            } catch {
                // Close cleanup must remain deterministic even when a consumer throws.
            }
        }
        this.closeHandlers.clear();
    }

    private sendReply(header: Omit<MeshLinkFrameHeader, 'version'>, body?: Uint8Array): void {
        try {
            this.send(header, body);
        } catch {
            // A failed terminal reply makes the remote delivery result
            // unknowable. Fence the peer so its close handlers release any
            // capabilities and grants tied to this transport generation.
            this.close(1011, 'Unable to send sRPC mesh reply');
        }
    }

    private rememberCompleted(requestId: string, header: Omit<MeshLinkFrameHeader, 'version'>, body?: Buffer): void {
        const retainedBytes = Buffer.byteLength(JSON.stringify(header)) + (body?.byteLength ?? 0);
        if (retainedBytes <= MaxCompletedRequestBytes - CompletedTombstoneReserveBytes) {
            if (
                this.storeCompleted(requestId, {
                    header,
                    body,
                    expiresAt: Date.now() + CompletedRequestTtlMs,
                    retainedBytes
                })
            ) {
                return;
            }
        }

        // The side effect already completed, so forgetting the request ID
        // would permit a retry to execute it again. Retain a small bounded
        // tombstone and tell duplicate callers the original response cannot
        // be replayed.
        const tombstone = this.createCompletedTombstone(requestId);
        if (!this.storeCompleted(requestId, tombstone)) {
            // Every accepted request reserves enough completed-cache capacity
            // for this tombstone before its handler starts. Keep this guard for
            // direct internal callers, which do not hold that reservation.
            return;
        }
    }

    private createCompletedTombstone(requestId: string): CompletedIncomingRequest {
        const header = {
            type: 'result',
            replyTo: requestId,
            ok: false,
            error: 'Completed sRPC mesh response is no longer replayable',
            errorName: 'SrpcIndeterminateDeliveryError'
        } satisfies Omit<MeshLinkFrameHeader, 'version'>;
        return {
            header,
            expiresAt: Date.now() + CompletedRequestTtlMs,
            retainedBytes: Buffer.byteLength(JSON.stringify(header))
        };
    }

    private canReserveCompletedRequest(tombstoneBytes: number): boolean {
        return (
            this.completedIncoming.size + this.activeIncoming.size < MaxCompletedRequests &&
            this.completedIncomingBytes + this.activeIncomingTombstoneBytes + tombstoneBytes <= MaxCompletedRequestBytes
        );
    }

    private storeCompleted(requestId: string, completed: CompletedIncomingRequest): boolean {
        this.pruneCompletedIncoming();
        const existing = this.completedIncoming.get(requestId);
        const activeTombstoneBytes = this.activeIncomingTombstones.get(requestId) ?? 0;
        const activeReservationCount = activeTombstoneBytes === 0 ? 0 : 1;
        const projectedCount = this.completedIncoming.size - Number(existing !== undefined) + 1 + this.activeIncoming.size - activeReservationCount;
        const projectedBytes =
            this.completedIncomingBytes -
            (existing?.retainedBytes ?? 0) +
            completed.retainedBytes +
            this.activeIncomingTombstoneBytes -
            activeTombstoneBytes;
        if (projectedCount > MaxCompletedRequests || projectedBytes > MaxCompletedRequestBytes) return false;
        this.removeCompleted(requestId);
        this.completedIncoming.set(requestId, completed);
        this.completedIncomingBytes += completed.retainedBytes;
        return true;
    }

    private removeCompleted(requestId: string): void {
        const completed = this.completedIncoming.get(requestId);
        if (!completed) return;
        this.completedIncoming.delete(requestId);
        this.completedIncomingBytes = Math.max(0, this.completedIncomingBytes - completed.retainedBytes);
    }

    private pruneCompletedIncoming(): void {
        const now = Date.now();
        for (const [requestId, completed] of this.completedIncoming) {
            if (completed.expiresAt <= now) this.removeCompleted(requestId);
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
