import { SrpcByteStream, type IByteStream } from '../../srpc/SrpcByteStream';
import { SrpcStaleConnectionError, SrpcStreamClosedError, type SrpcConnection, type SrpcMeta } from '../../srpc/types';

export interface MeshRemoteConnectionTransport<TMeta extends SrpcMeta> {
    reserveSenderIds(connection: MeshRemoteSrpcConnection<TMeta>): Promise<number[]>;
    disconnect(connection: MeshRemoteSrpcConnection<TMeta>, reason?: string): Promise<void>;
    writeStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number, data: Uint8Array): Promise<void>;
    finishStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void>;
    destroyStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number, error?: unknown): Promise<void>;
    attachReceiver(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void>;
}

export interface MeshRemoteSrpcConnectionOptions<TMeta extends SrpcMeta> {
    id: string;
    clientId: string;
    meta: TMeta;
    connectedAt: number;
    ownerNodeId: number;
    ownerProcessId?: string;
    senderIds: number[];
    transport: MeshRemoteConnectionTransport<TMeta>;
}

export class MeshRemoteSrpcConnection<TMeta extends SrpcMeta = SrpcMeta> implements SrpcConnection<TMeta> {
    readonly id: string;
    readonly clientId: string;
    readonly meta: TMeta;
    readonly connectedAt: number;
    readonly ownerNodeId: number;
    readonly ownerProcessId?: string;
    readonly byteStream: IByteStream;

    private readonly senderIds: number[];
    private readonly transport: MeshRemoteConnectionTransport<TMeta>;
    private readonly disconnectHandlers = new Set<() => void>();
    private stale = false;
    private refillPending?: Promise<void>;

    constructor(options: MeshRemoteSrpcConnectionOptions<TMeta>) {
        this.id = options.id;
        this.clientId = options.clientId;
        this.meta = options.meta;
        this.connectedAt = options.connectedAt;
        this.ownerNodeId = options.ownerNodeId;
        this.ownerProcessId = options.ownerProcessId;
        this.senderIds = [...options.senderIds];
        this.transport = options.transport;
        this.byteStream = {
            parentStreamId: this.id,
            allocateSenderId: () => {
                this.assertConnected();
                const id = this.senderIds.shift();
                if (id === undefined) throw new SrpcStreamClosedError('No reserved remote sRPC byte stream IDs remain');
                if (this.senderIds.length <= 128 && !this.refillPending) {
                    this.refillPending = this.transport
                        .reserveSenderIds(this)
                        .then(ids => {
                            if (!this.stale) this.senderIds.push(...ids);
                        })
                        .catch(() => {})
                        .finally(() => {
                            this.refillPending = undefined;
                        });
                }
                return id;
            },
            attachReceiver: streamId => options.transport.attachReceiver(this, streamId),
            write: (streamId, data) => options.transport.writeStream(this, streamId, toBytes(data)),
            finish: streamId => options.transport.finishStream(this, streamId),
            destroy: (streamId, error) => options.transport.destroyStream(this, streamId, error),
            attachDisconnectHandler: handler => this.disconnectHandlers.add(handler),
            detachDisconnectHandler: handler => this.disconnectHandlers.delete(handler),
            getBufferedAmount: () => 0
        };
        SrpcByteStream.init(this, { startId: 2, step: 2 });
    }

    get connected(): boolean {
        return !this.stale;
    }

    async close(reason?: string): Promise<void> {
        this.assertConnected();
        await this.transport.disconnect(this, reason);
        this.markStale();
    }

    receiveWrite(streamId: number, data: Uint8Array): void {
        this.assertConnected();
        SrpcByteStream.writeReceiver(this, streamId, data);
    }

    receiveFinish(streamId: number): void {
        if (this.stale) return;
        SrpcByteStream.finishReceiver(this, streamId);
    }

    receiveDestroy(streamId: number, error?: string): void {
        if (this.stale) return;
        SrpcByteStream.destroySubstream(this, streamId, error);
    }

    markStale(): void {
        if (this.stale) return;
        this.stale = true;
        for (const handler of this.disconnectHandlers) handler();
        this.disconnectHandlers.clear();
    }

    private assertConnected(): void {
        if (this.stale) throw new SrpcStaleConnectionError(this.clientId);
    }
}

function toBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    throw new TypeError('sRPC byte stream writes require Uint8Array data');
}
