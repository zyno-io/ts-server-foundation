import { Duplex } from 'node:stream';

const ByteStreamInfo = Symbol('ByteStreamInfo');

interface IByteStreamInfo {
    receivers: Map<number, SrpcByteStream>;
    senders: Map<number, SrpcByteStream>;
    nextId: number;
    step: number;
    pendingReceivers?: Map<number, IPendingReceiver>;
    pendingReceiverBytes: number;
}

interface IPendingReceiver {
    chunks: Buffer[];
    bytes: number;
    finished: boolean;
    destroyedError?: Error;
    timeout?: ReturnType<typeof setTimeout>;
}

export interface IByteStream {
    [ByteStreamInfo]?: IByteStreamInfo;
    write(streamId: number, data: unknown): boolean | void | Promise<boolean | void>;
    finish(streamId: number): void;
    destroy(streamId: number, err?: unknown): void;
    attachDisconnectHandler(handler: () => void): void;
    detachDisconnectHandler(handler: () => void): void;
    getBufferedAmount(): number;
    parentStreamId: string;
}

export interface IByteStreamable {
    byteStream: IByteStream;
}

const PENDING_RECEIVER_MAX_BYTES = 2 * 1024 * 1024;
const PENDING_RECEIVER_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const PENDING_RECEIVER_MAX_COUNT = 1024;
const PENDING_RECEIVER_TTL_MS = 5000;

export class SrpcByteStream extends Duplex {
    private readonly _id: number;
    private readonly parent: IByteStreamable;
    private readonly isSender: boolean;
    private cleaned = false;
    private remotelyDestroyed = false;
    private remoteFinished = false;
    private localFinished = false;

    get id(): number {
        return this._id;
    }

    constructor(stream: IByteStreamable, id = 0) {
        super();
        SrpcByteStream.ensureInfo(stream);
        this.parent = stream;
        this.parent.byteStream.attachDisconnectHandler(this.handleDisconnect);

        const info = stream.byteStream[ByteStreamInfo]!;
        if (id === 0) {
            this._id = info.nextId;
            info.nextId += info.step;
            this.isSender = true;
            info.senders.set(this._id, this);
        } else {
            this._id = id;
            this.isSender = false;
            info.receivers.set(this._id, this);
            this.flushPendingReceiver(info);
            this.on('end', () => this.cleanup());
        }
    }

    static init(stream: IByteStreamable, options: { startId: number; step: number }) {
        const existing = stream.byteStream[ByteStreamInfo];
        if (existing) clearPendingReceivers(existing);
        stream.byteStream[ByteStreamInfo] = {
            receivers: new Map(),
            senders: new Map(),
            nextId: options.startId,
            step: options.step,
            pendingReceiverBytes: 0
        };
    }

    static createReceiver(stream: IByteStreamable, id: number): SrpcByteStream {
        if (typeof id !== 'number') throw new Error('Missing stream ID');
        if (stream.byteStream[ByteStreamInfo]?.receivers.has(id)) throw new Error(`Stream ${id} already exists`);
        return new SrpcByteStream(stream, id);
    }

    static createSender(stream: IByteStreamable): SrpcByteStream {
        return new SrpcByteStream(stream);
    }

    static writeReceiver(stream: IByteStreamable, id: number, data: unknown): void {
        const info = SrpcByteStream.ensureInfo(stream);
        const receiver = info.receivers.get(id);
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
        if (receiver) {
            receiver.push(chunk);
            return;
        }

        const pending = getPendingReceiver(info, id);
        if (!pending) return;
        if (pending.destroyedError) return;

        if (
            pending.bytes + chunk.length > PENDING_RECEIVER_MAX_BYTES ||
            info.pendingReceiverBytes + chunk.length > PENDING_RECEIVER_MAX_TOTAL_BYTES
        ) {
            releasePendingReceiverBytes(info, pending);
            pending.destroyedError = new Error('Pending receiver exceeded max buffered bytes');
            pending.chunks = [];
            pending.bytes = 0;
            return;
        }

        pending.chunks.push(chunk);
        pending.bytes += chunk.length;
        info.pendingReceiverBytes += chunk.length;
    }

    static finishReceiver(stream: IByteStreamable, id: number): void {
        const info = SrpcByteStream.ensureInfo(stream);
        const receiver = info.receivers.get(id);
        if (receiver) {
            receiver.remoteFinished = true;
            receiver.push(null);
            return;
        }

        const pending = getPendingReceiver(info, id);
        if (!pending) return;
        if (pending.destroyedError) return;
        pending.finished = true;
    }

    static destroySubstream(stream: IByteStreamable, id: number, err?: string): void {
        const info = SrpcByteStream.ensureInfo(stream);
        const error = err ? new Error(err) : undefined;
        const receiver = info.receivers.get(id);
        if (receiver) {
            receiver.remotelyDestroyed = true;
            receiver.destroy(error);
            return;
        }

        const sender = info.senders.get(id);
        if (sender) {
            sender.remotelyDestroyed = true;
            sender.destroy(error);
            return;
        }

        const pending = getPendingReceiver(info, id);
        if (!pending) return;
        releasePendingReceiverBytes(info, pending);
        pending.destroyedError = error ?? new Error('Remote stream destroyed');
        pending.chunks = [];
        pending.bytes = 0;
    }

    _read(): void {}

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            Promise.resolve(this.parent.byteStream.write(this._id, chunk)).then(
                result => {
                    if (result === false) callback(new Error(`SRPC byte stream ${this._id} is not writable`));
                    else callback();
                },
                error => callback(error instanceof Error ? error : new Error(String(error)))
            );
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        try {
            this.localFinished = true;
            this.parent.byteStream.finish(this._id);
            callback();
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        const normalSenderFinish = this.isSender && this.localFinished && !error;
        if (!this.remotelyDestroyed && !normalSenderFinish && (this.isSender || !this.remoteFinished)) {
            this.parent.byteStream.destroy(this._id, error ?? undefined);
        }
        this.cleanup();
        callback(error);
    }

    private flushPendingReceiver(info: IByteStreamInfo): void {
        const pending = info.pendingReceivers?.get(this._id);
        if (!pending) return;
        deletePendingReceiver(info, this._id, pending);
        if (pending.destroyedError) {
            this.destroy(pending.destroyedError);
            return;
        }
        for (const chunk of pending.chunks) this.push(chunk);
        if (pending.finished) {
            this.remoteFinished = true;
            this.push(null);
        }
    }

    private readonly handleDisconnect = () => {
        this.remotelyDestroyed = true;
        this.destroy();
    };

    private cleanup(): void {
        if (this.cleaned) return;
        this.cleaned = true;
        const info = this.parent.byteStream[ByteStreamInfo];
        if (this.isSender) info?.senders.delete(this._id);
        else info?.receivers.delete(this._id);
        this.parent.byteStream.detachDisconnectHandler(this.handleDisconnect);
    }

    private static ensureInfo(stream: IByteStreamable): IByteStreamInfo {
        stream.byteStream[ByteStreamInfo] ??= {
            receivers: new Map(),
            senders: new Map(),
            nextId: 1,
            step: 1,
            pendingReceiverBytes: 0
        };
        return stream.byteStream[ByteStreamInfo]!;
    }
}

function getPendingReceiver(info: IByteStreamInfo, id: number): IPendingReceiver | undefined {
    info.pendingReceivers ??= new Map();
    const existing = info.pendingReceivers.get(id);
    if (existing) return existing;
    if (info.pendingReceivers.size >= PENDING_RECEIVER_MAX_COUNT) return undefined;

    const pending: IPendingReceiver = { chunks: [], bytes: 0, finished: false };
    pending.timeout = setTimeout(() => {
        deletePendingReceiver(info, id, pending);
    }, PENDING_RECEIVER_TTL_MS);
    pending.timeout.unref?.();
    info.pendingReceivers.set(id, pending);
    return pending;
}

function releasePendingReceiverBytes(info: IByteStreamInfo, pending: IPendingReceiver): void {
    if (pending.bytes <= 0) return;
    info.pendingReceiverBytes = Math.max(0, info.pendingReceiverBytes - pending.bytes);
    pending.bytes = 0;
}

function deletePendingReceiver(info: IByteStreamInfo, id: number, pending: IPendingReceiver): void {
    releasePendingReceiverBytes(info, pending);
    if (pending.timeout) clearTimeout(pending.timeout);
    info.pendingReceivers?.delete(id);
}

function clearPendingReceivers(info: IByteStreamInfo): void {
    for (const [id, pending] of info.pendingReceivers ?? []) deletePendingReceiver(info, id, pending);
}
