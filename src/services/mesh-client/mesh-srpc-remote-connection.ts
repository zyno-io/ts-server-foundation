import { SrpcByteStream, type IByteStream } from '../../srpc/SrpcByteStream';
import { SrpcBackpressureError, SrpcStaleConnectionError, SrpcStreamClosedError, type SrpcConnection } from '../../srpc/types';

export interface MeshRemoteConnectionTransport<TMeta> {
    reserveSenderIds(connection: MeshRemoteSrpcConnection<TMeta>): Promise<number[]>;
    releaseSenderIds?(connection: MeshRemoteSrpcConnection<TMeta>, ids: number[]): Promise<void>;
    disconnect(connection: MeshRemoteSrpcConnection<TMeta>, reason?: string): Promise<void>;
    writeStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number, data: Uint8Array): Promise<void>;
    finishStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void>;
    destroyStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number, error?: unknown): Promise<void>;
    attachReceiver(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void>;
    /** Optional v2 signal that an allocated sender ID became a live stream. */
    activateSender?(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void>;
}

export interface MeshRemoteSrpcConnectionOptions<TMeta> {
    id: string;
    clientId: string;
    meta: TMeta;
    connectedAt: number;
    ownerNodeId: number;
    ownerProcessId?: string;
    ownerEndpointId?: string;
    ownerEndpointPublicKey?: string;
    /** Opaque v2 handle capability minted by the remote owner. */
    capability?: string;
    senderIds: number[];
    /** Whether the owning mesh link supports returning unused reservations. */
    supportsSenderIdRelease?: boolean;
    transport: MeshRemoteConnectionTransport<TMeta>;
}

const MaxBackpressuredReceiverStreams = 128;
const MaxTrackedReceiverStreams = 1024;
const MaxBufferedReceiverBytes = 8 * 1024 * 1024;

export class MeshRemoteSrpcConnection<TMeta = object> implements SrpcConnection<TMeta> {
    readonly id: string;
    readonly clientId: string;
    readonly connectedAt: number;
    readonly ownerNodeId: number;
    readonly ownerProcessId?: string;
    readonly ownerEndpointId?: string;
    readonly ownerEndpointPublicKey?: string;
    readonly capability?: string;
    readonly byteStream: IByteStream;

    private readonly senderIds: number[];
    private readonly activeSenderIds = new Set<number>();
    private readonly transport: MeshRemoteConnectionTransport<TMeta>;
    private readonly supportsSenderIdRelease: boolean;
    private readonly disconnectHandlers = new Set<() => void>();
    private readonly backpressuredReceivers = new Set<number>();
    private readonly receiverBufferedBytes = new Map<number, number>();
    private _meta: TMeta;
    private stale = false;
    private refillPending?: Promise<void>;
    private lastUsedAt = Date.now();

    constructor(options: MeshRemoteSrpcConnectionOptions<TMeta>) {
        this.id = options.id;
        this.clientId = options.clientId;
        this._meta = options.meta;
        this.connectedAt = options.connectedAt;
        this.ownerNodeId = options.ownerNodeId;
        this.ownerProcessId = options.ownerProcessId;
        this.ownerEndpointId = options.ownerEndpointId;
        this.ownerEndpointPublicKey = options.ownerEndpointPublicKey;
        this.capability = options.capability;
        this.senderIds = [...options.senderIds];
        this.transport = options.transport;
        this.supportsSenderIdRelease = options.supportsSenderIdRelease ?? Boolean(options.transport.releaseSenderIds);
        this.byteStream = {
            parentStreamId: this.id,
            remoteSenderIdParity: 1,
            allocateSenderId: () => {
                this.assertConnected();
                this.touch();
                const id = this.senderIds.shift();
                if (id === undefined) {
                    this.refillSenderIds();
                    throw new SrpcStreamClosedError('No reserved remote sRPC byte stream IDs remain');
                }
                this.activeSenderIds.add(id);
                if (this.senderIds.length <= 16) this.refillSenderIds();
                return id;
            },
            attachReceiver: streamId => options.transport.attachReceiver(this, streamId),
            write: (streamId, data) => options.transport.writeStream(this, streamId, toBytes(data)),
            finish: streamId => this.finishStream(streamId),
            destroy: (streamId, error) => this.destroyStream(streamId, error),
            announceSender: streamId => this.activateSender(streamId),
            attachDisconnectHandler: handler => this.disconnectHandlers.add(handler),
            detachDisconnectHandler: handler => this.disconnectHandlers.delete(handler),
            getBufferedAmount: () => 0,
            receiverBufferChanged: (streamId, bufferedBytes) => this.updateReceiverBufferedBytes(streamId, bufferedBytes)
        };
        SrpcByteStream.init(this, { startId: 2, step: 2 });
    }

    get connected(): boolean {
        return !this.stale;
    }

    resolveByteStream(): IByteStream {
        this.assertConnected();
        return this.byteStream;
    }

    get meta(): TMeta {
        return this._meta;
    }

    get idleSince(): number {
        return this.lastUsedAt;
    }

    get hasActiveStreams(): boolean {
        return this.disconnectHandlers.size > 0;
    }

    touch(): void {
        this.lastUsedAt = Date.now();
    }

    applyMetadata(metadata: unknown): void {
        this._meta = metadata as TMeta;
    }

    async close(reason?: string): Promise<void> {
        this.assertConnected();
        try {
            await this.transport.disconnect(this, reason);
        } finally {
            this.markStale();
        }
    }

    receiveWrite(streamId: number, data: Uint8Array): boolean {
        this.assertConnected();
        try {
            this.touch();
            const hasReceiver = SrpcByteStream.hasReceiver(this, streamId);
            const wasBackpressured = this.backpressuredReceivers.has(streamId);
            const accepted = SrpcByteStream.writeReceiver(this, streamId, data);
            this.updateReceiverBufferedBytes(streamId, SrpcByteStream.getReceiverBufferedBytes(this, streamId));
            if (this.receiverBufferedBytes.size > MaxTrackedReceiverStreams || this.totalReceiverBufferedBytes() > MaxBufferedReceiverBytes) {
                const error = new SrpcBackpressureError('Remote sRPC byte stream receiver capacity exceeded');
                this.receiveDestroy(streamId, error.message);
                void this.transport.destroyStream(this, streamId, error).catch(() => {});
                return false;
            }
            if (accepted) return true;
            if (!hasReceiver) return false;
            // Readable.push(false) still accepted this chunk. Mesh relays pause
            // their receiver while a forwarded write is in flight, so multiple
            // chunks can arrive before it resumes. The aggregate receiver limit
            // above bounds that normal pressure without treating one mesh RTT as
            // a non-draining stream.
            if (!wasBackpressured && this.backpressuredReceivers.size < MaxBackpressuredReceiverStreams) {
                this.backpressuredReceivers.add(streamId);
            }
            return true;
        } catch (error) {
            this.markStale();
            throw error;
        }
    }

    receiveFinish(streamId: number): void {
        if (this.stale) return;
        try {
            this.touch();
            this.activeSenderIds.delete(streamId);
            this.clearReceiverPressure(streamId);
            SrpcByteStream.finishReceiver(this, streamId);
        } catch (error) {
            this.markStale();
            throw error;
        }
    }

    receiveDestroy(streamId: number, error?: string): void {
        if (this.stale) return;
        try {
            this.touch();
            this.activeSenderIds.delete(streamId);
            this.clearReceiverPressure(streamId);
            if (SrpcByteStream.consumeTerminalSender(this, streamId)) return;
            SrpcByteStream.destroySubstream(this, streamId, error);
        } catch (cause) {
            this.markStale();
            throw cause;
        }
    }

    markStale(): void {
        if (this.stale) return;
        this.stale = true;
        this.backpressuredReceivers.clear();
        this.receiverBufferedBytes.clear();
        const reservedSenderIds = this.takeReservedSenderIds();
        const handlers = [...this.disconnectHandlers];
        this.disconnectHandlers.clear();
        for (const handler of handlers) {
            try {
                handler();
            } catch {}
        }
        this.releaseReservedSenderIds(reservedSenderIds);
    }

    takeReservedSenderIds(): number[] {
        const ids = [...this.senderIds, ...this.activeSenderIds];
        this.senderIds.length = 0;
        this.activeSenderIds.clear();
        return this.supportsSenderIdRelease ? ids : [];
    }

    private async finishStream(streamId: number): Promise<void> {
        await this.transport.finishStream(this, streamId);
        this.activeSenderIds.delete(streamId);
    }

    private async destroyStream(streamId: number, error?: unknown): Promise<void> {
        await this.transport.destroyStream(this, streamId, error);
        this.activeSenderIds.delete(streamId);
    }

    private activateSender(streamId: number): void {
        const activate = this.transport.activateSender;
        if (!activate) return;
        void activate.call(this.transport, this, streamId).catch(() => {
            // Activation is the authority boundary for an allocated sender.
            // A failed signal leaves its ownership ambiguous, so fence the
            // complete handle and synchronously detach every substream.
            this.markStale();
        });
    }

    private refillSenderIds(): void {
        if (this.refillPending || this.stale) return;
        this.refillPending = this.transport
            .reserveSenderIds(this)
            .then(ids => {
                if (!this.stale) this.senderIds.push(...ids);
                else this.releaseReservedSenderIds(ids);
            })
            .catch(() => {})
            .finally(() => {
                this.refillPending = undefined;
            });
    }

    private assertConnected(): void {
        if (this.stale) throw new SrpcStaleConnectionError(this.clientId);
    }

    private updateReceiverBufferedBytes(streamId: number, bufferedBytes: number): void {
        const previous = this.receiverBufferedBytes.get(streamId) ?? 0;
        if (bufferedBytes < previous) this.backpressuredReceivers.delete(streamId);
        if (bufferedBytes > 0) this.receiverBufferedBytes.set(streamId, bufferedBytes);
        else this.receiverBufferedBytes.delete(streamId);
    }

    private clearReceiverPressure(streamId: number): void {
        this.backpressuredReceivers.delete(streamId);
        this.receiverBufferedBytes.delete(streamId);
    }

    private totalReceiverBufferedBytes(): number {
        let total = 0;
        for (const bytes of this.receiverBufferedBytes.values()) total += bytes;
        return total;
    }

    private releaseReservedSenderIds(ids: number[]): void {
        if (!this.supportsSenderIdRelease || !ids.length) return;
        const release = this.transport.releaseSenderIds;
        if (!release) return;
        try {
            void release(this, ids).catch(() => {});
        } catch {}
    }
}

function toBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    throw new TypeError('sRPC byte stream writes require Uint8Array data');
}
