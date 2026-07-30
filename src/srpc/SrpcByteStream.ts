import { Duplex } from 'node:stream';

const ByteStreamInfo = Symbol('ByteStreamInfo');

interface IByteStreamInfo {
    receivers: Map<number, SrpcByteStream>;
    senders: Map<number, SrpcByteStream>;
    nextId: number;
    step: number;
    pendingReceivers?: Map<number, IPendingReceiver>;
    pendingReceiverBytes: number;
    pendingReceiverChunkBytes: number;
    terminalSenders: Map<number, number>;
}

interface IPendingReceiver {
    chunks: Buffer[];
    bytes: number;
    errorBytes: number;
    finished: boolean;
    destroyed: boolean;
    destroyedError?: Error;
    timeout?: ReturnType<typeof setTimeout>;
}

export interface IByteStream {
    [ByteStreamInfo]?: IByteStreamInfo;
    write(streamId: number, data: unknown): boolean | void | Promise<boolean | void>;
    finish(streamId: number): boolean | void | Promise<boolean | void>;
    destroy(streamId: number, err?: unknown): boolean | void | Promise<boolean | void>;
    attachDisconnectHandler(handler: () => void): void;
    detachDisconnectHandler(handler: () => void): void;
    getBufferedAmount(): number;
    parentStreamId: string;
    allocateSenderId?(): number;
    attachReceiver?(streamId: number): void | Promise<void>;
    announceSender?(streamId: number): void;
    receiverBufferChanged?(streamId: number, bufferedBytes: number): void;
    /** Parity owned by senders on the remote endpoint. */
    remoteSenderIdParity?: 0 | 1;
}

export interface IByteStreamable {
    byteStream: IByteStream;
    /** Resolve a context-pinned transport, or reject a stale async context. */
    resolveByteStream?(): IByteStream;
}

export function byteStreamDestroyReason(error: unknown): string | undefined {
    if (error === undefined) return undefined;
    return error instanceof Error ? error.message : String(error);
}

const PENDING_RECEIVER_MAX_BYTES = 2 * 1024 * 1024;
const PENDING_RECEIVER_MAX_CHUNK_TOTAL_BYTES = 2 * 1024 * 1024;
const PENDING_RECEIVER_MAX_COUNT = 1024;
const PENDING_RECEIVER_TTL_MS = 5000;
const MaxByteStreamId = 0x7fffffff;
const PENDING_DESTROY_ERROR_MAX_BYTES = 1024;
const PENDING_RECEIVER_MAX_TOTAL_BYTES = PENDING_RECEIVER_MAX_CHUNK_TOTAL_BYTES + PENDING_RECEIVER_MAX_COUNT * PENDING_DESTROY_ERROR_MAX_BYTES;
const TERMINAL_SENDER_TTL_MS = 60_000;
const TERMINAL_SENDER_MAX_COUNT = 65_536;

export class SrpcByteStream extends Duplex {
    private readonly _id: number;
    /** The transport generation this substream was created against. */
    private readonly transport: IByteStream;
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
        this.transport = stream.resolveByteStream?.() ?? stream.byteStream;
        SrpcByteStream.ensureTransportInfo(this.transport);
        this.transport.attachDisconnectHandler(this.handleDisconnect);

        const info = this.transport[ByteStreamInfo]!;
        if (id === 0) {
            if (this.transport.allocateSenderId) {
                try {
                    this._id = this.transport.allocateSenderId();
                } catch (error) {
                    this.transport.detachDisconnectHandler(this.handleDisconnect);
                    throw error;
                }
            } else {
                this._id = info.nextId;
                info.nextId += info.step;
            }
            if (!Number.isSafeInteger(this._id) || this._id <= 0 || this._id > MaxByteStreamId) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error('sRPC byte stream ID space exhausted');
            }
            pruneTerminalSenders(info);
            if (info.terminalSenders.size >= TERMINAL_SENDER_MAX_COUNT) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error('Too many recently finished sRPC byte streams');
            }
            if (
                info.senders.has(this._id) ||
                info.receivers.has(this._id) ||
                info.pendingReceivers?.has(this._id) ||
                info.terminalSenders.has(this._id) ||
                (this.transport.remoteSenderIdParity != null && this._id % 2 === this.transport.remoteSenderIdParity)
            ) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error(`Invalid or colliding sRPC byte stream sender ID ${this._id}`);
            }
            this.isSender = true;
            info.senders.set(this._id, this);
            try {
                this.transport.announceSender?.(this._id);
            } catch (error) {
                info.senders.delete(this._id);
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw error;
            }
        } else {
            if (!Number.isSafeInteger(id) || id <= 0 || id > MaxByteStreamId) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error('Invalid stream ID');
            }
            pruneTerminalSenders(info);
            if (this.transport.remoteSenderIdParity != null && id % 2 !== this.transport.remoteSenderIdParity) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error('Invalid remote sender stream ID');
            }
            if (info.senders.has(id)) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error(`Stream ${id} collides with a local sender`);
            }
            if (info.terminalSenders.has(id)) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error(`Stream ${id} collides with a recently finished local sender`);
            }
            if (info.receivers.has(id)) {
                this.transport.detachDisconnectHandler(this.handleDisconnect);
                throw new Error(`Stream ${id} already exists`);
            }
            this._id = id;
            this.isSender = false;
            info.receivers.set(this._id, this);
            this.flushPendingReceiver(info);
            this.on('end', () => this.cleanup());
            if (this.transport.attachReceiver) {
                Promise.resolve(this.transport.attachReceiver(this._id)).catch(error => {
                    this.destroy(error instanceof Error ? error : new Error(String(error)));
                });
            }
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
            pendingReceiverBytes: 0,
            pendingReceiverChunkBytes: 0,
            terminalSenders: new Map()
        };
    }

    static createReceiver(stream: IByteStreamable, id: number): SrpcByteStream {
        if (!Number.isSafeInteger(id) || id <= 0 || id > MaxByteStreamId) throw new Error('Invalid stream ID');
        return new SrpcByteStream(stream, id);
    }

    static createSender(stream: IByteStreamable): SrpcByteStream {
        return new SrpcByteStream(stream);
    }

    static reserveSenderIds(stream: IByteStreamable, count: number): number[] {
        if (!Number.isSafeInteger(count) || count < 1 || count > 65_536) {
            throw new Error('Invalid sRPC byte stream ID reservation count');
        }
        const info = SrpcByteStream.ensureInfo(stream);
        const ids: number[] = [];
        for (let i = 0; i < count; i++) {
            pruneTerminalSenders(info);
            while (
                info.senders.has(info.nextId) ||
                info.receivers.has(info.nextId) ||
                info.pendingReceivers?.has(info.nextId) ||
                info.terminalSenders.has(info.nextId) ||
                (stream.byteStream.remoteSenderIdParity != null && info.nextId % 2 === stream.byteStream.remoteSenderIdParity)
            ) {
                info.nextId += info.step;
            }
            if (!Number.isSafeInteger(info.nextId) || info.nextId <= 0 || info.nextId > MaxByteStreamId) {
                throw new Error('sRPC byte stream ID space exhausted');
            }
            ids.push(info.nextId);
            info.nextId += info.step;
        }
        return ids;
    }

    static hasReceiver(stream: IByteStreamable, id: number): boolean {
        return SrpcByteStream.ensureInfo(stream).receivers.has(id);
    }

    static hasSender(stream: IByteStreamable, id: number): boolean {
        return SrpcByteStream.ensureInfo(stream).senders.has(id);
    }

    static hasTerminalSender(stream: IByteStreamable, id: number): boolean {
        const info = SrpcByteStream.ensureInfo(stream);
        pruneTerminalSenders(info);
        return (info.terminalSenders.get(id) ?? 0) > Date.now();
    }

    static consumeTerminalSender(stream: IByteStreamable, id: number): boolean {
        const info = SrpcByteStream.ensureInfo(stream);
        if (!SrpcByteStream.hasTerminalSender(stream, id)) return false;
        info.terminalSenders.delete(id);
        return true;
    }

    static getReceiverBufferedBytes(stream: IByteStreamable, id: number): number {
        return SrpcByteStream.ensureInfo(stream).receivers.get(id)?.readableLength ?? 0;
    }

    static writeReceiver(stream: IByteStreamable, id: number, data: unknown): boolean {
        const info = SrpcByteStream.ensureInfo(stream);
        const receiver = info.receivers.get(id);
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
        if (receiver) {
            if (receiver.remoteFinished) {
                SrpcByteStream.abortReceiver(stream, id, new Error(`SRPC byte stream ${id} received data after finish`));
                return false;
            }
            const accepted = receiver.push(chunk);
            receiver.notifyReceiverBufferChanged();
            return accepted;
        }

        const pending = requirePendingReceiver(info, id);
        if (pending.destroyed) return false;
        if (pending.finished) {
            retainPendingError(info, pending, new Error(`SRPC byte stream ${id} received data after finish`));
            return false;
        }

        if (
            pending.bytes + chunk.length > PENDING_RECEIVER_MAX_BYTES ||
            info.pendingReceiverChunkBytes + chunk.length > PENDING_RECEIVER_MAX_CHUNK_TOTAL_BYTES ||
            info.pendingReceiverBytes + chunk.length > PENDING_RECEIVER_MAX_TOTAL_BYTES
        ) {
            retainPendingError(info, pending, new Error('Pending receiver exceeded max buffered bytes'));
            pending.chunks = [];
            return false;
        }

        pending.chunks.push(chunk);
        pending.bytes += chunk.length;
        info.pendingReceiverChunkBytes += chunk.length;
        info.pendingReceiverBytes += chunk.length;
        return true;
    }

    static abortReceiver(stream: IByteStreamable, id: number, error?: unknown): void {
        const receiver = SrpcByteStream.ensureInfo(stream).receivers.get(id);
        if (receiver) {
            try {
                receiver.destroy(receiver.listenerCount('error') > 0 ? toError(error) : undefined);
            } catch {}
            return;
        }
        try {
            void Promise.resolve(stream.byteStream.destroy(id, error)).catch(() => {});
        } catch {}
    }

    static finishReceiver(stream: IByteStreamable, id: number): void {
        const info = SrpcByteStream.ensureInfo(stream);
        const receiver = info.receivers.get(id);
        if (receiver) {
            receiver.remoteFinished = true;
            receiver.push(null);
            receiver.notifyReceiverBufferChanged();
            return;
        }

        const pending = requirePendingReceiver(info, id);
        if (pending.destroyed) return;
        pending.finished = true;
    }

    static destroySubstream(stream: IByteStreamable, id: number, err?: string): void {
        const info = SrpcByteStream.ensureInfo(stream);
        const error = err !== undefined ? new Error(truncateUtf8(err, PENDING_DESTROY_ERROR_MAX_BYTES)) : undefined;
        const receiver = info.receivers.get(id);
        if (receiver) {
            receiver.remotelyDestroyed = true;
            try {
                receiver.destroy(error);
            } catch {}
            return;
        }

        const sender = info.senders.get(id);
        if (sender) {
            sender.remotelyDestroyed = true;
            try {
                sender.destroy(error);
            } catch {}
            return;
        }

        const pending = requirePendingReceiver(info, id);
        retainPendingDestroy(info, pending, error);
    }

    _read(): void {}

    override read(size?: number): any {
        const chunk = super.read(size);
        this.notifyReceiverBufferChanged();
        return chunk;
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            Promise.resolve(this.transport.write(this._id, chunk)).then(
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
            const info = this.transport[ByteStreamInfo]!;
            if (this.isSender && !reserveTerminalSender(info, this._id)) {
                callback(new Error('Too many recently finished sRPC byte streams'));
                return;
            }
            this.localFinished = true;
            Promise.resolve(this.transport.finish(this._id)).then(
                result => {
                    if (result === false) {
                        info.terminalSenders.delete(this._id);
                        callback(new Error(`SRPC byte stream ${this._id} is not writable`));
                        return;
                    }
                    // A normal writable finish is terminal for a sender. Do not rely
                    // on Node's optional auto-destroy to release the generation map.
                    this.cleanup();
                    callback();
                },
                error => {
                    info.terminalSenders.delete(this._id);
                    callback(error instanceof Error ? error : new Error(String(error)));
                }
            );
        } catch (error) {
            this.transport[ByteStreamInfo]?.terminalSenders.delete(this._id);
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        const normalSenderFinish = this.isSender && this.localFinished && !error;
        if (!this.remotelyDestroyed && !normalSenderFinish && (this.isSender || !this.remoteFinished)) {
            try {
                Promise.resolve(this.transport.destroy(this._id, error ?? undefined)).then(
                    result => {
                        this.cleanup();
                        callback(result === false ? new Error(`SRPC byte stream ${this._id} is not writable`) : error);
                    },
                    destroyError => {
                        this.cleanup();
                        callback(destroyError instanceof Error ? destroyError : new Error(String(destroyError)));
                    }
                );
                return;
            } catch (destroyError) {
                this.cleanup();
                callback(destroyError instanceof Error ? destroyError : new Error(String(destroyError)));
                return;
            }
        }
        this.cleanup();
        callback(error);
    }

    private flushPendingReceiver(info: IByteStreamInfo): void {
        const pending = info.pendingReceivers?.get(this._id);
        if (!pending) return;
        deletePendingReceiver(info, this._id, pending);
        if (pending.destroyed) {
            this.remotelyDestroyed = true;
            this.destroy(pending.destroyedError);
            return;
        }
        for (const chunk of pending.chunks) this.push(chunk);
        this.notifyReceiverBufferChanged();
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
        const info = this.transport[ByteStreamInfo];
        const ownsCurrentEntry = this.isSender ? info?.senders.get(this._id) === this : info?.receivers.get(this._id) === this;
        if (!this.isSender && ownsCurrentEntry) {
            try {
                this.transport.receiverBufferChanged?.(this._id, 0);
            } catch {}
        }
        if (ownsCurrentEntry) {
            if (this.isSender) {
                info?.senders.delete(this._id);
            } else info?.receivers.delete(this._id);
        }
        this.transport.detachDisconnectHandler(this.handleDisconnect);
    }

    private notifyReceiverBufferChanged(): void {
        if (this.isSender || this.cleaned) return;
        try {
            this.transport.receiverBufferChanged?.(this._id, this.readableLength);
        } catch {}
    }

    private static ensureInfo(stream: IByteStreamable): IByteStreamInfo {
        return SrpcByteStream.ensureTransportInfo(stream.byteStream);
    }

    private static ensureTransportInfo(transport: IByteStream): IByteStreamInfo {
        transport[ByteStreamInfo] ??= {
            receivers: new Map(),
            senders: new Map(),
            nextId: 1,
            step: 1,
            pendingReceiverBytes: 0,
            pendingReceiverChunkBytes: 0,
            terminalSenders: new Map()
        };
        return transport[ByteStreamInfo]!;
    }
}

function getPendingReceiver(info: IByteStreamInfo, id: number): IPendingReceiver | undefined {
    info.pendingReceivers ??= new Map();
    const existing = info.pendingReceivers.get(id);
    if (existing) return existing;
    if (info.pendingReceivers.size >= PENDING_RECEIVER_MAX_COUNT) return undefined;

    const pending: IPendingReceiver = { chunks: [], bytes: 0, errorBytes: 0, finished: false, destroyed: false };
    pending.timeout = setTimeout(() => {
        deletePendingReceiver(info, id, pending);
    }, PENDING_RECEIVER_TTL_MS);
    pending.timeout.unref?.();
    info.pendingReceivers.set(id, pending);
    return pending;
}

function requirePendingReceiver(info: IByteStreamInfo, id: number): IPendingReceiver {
    const pending = getPendingReceiver(info, id);
    if (!pending) throw new Error(`Too many pending sRPC byte stream receivers while processing stream ${id}`);
    return pending;
}

function toError(error: unknown): Error | undefined {
    if (error === undefined) return undefined;
    return error instanceof Error ? error : new Error(String(error));
}

function releasePendingReceiverBytes(info: IByteStreamInfo, pending: IPendingReceiver): void {
    if (pending.bytes <= 0 && pending.errorBytes <= 0) return;
    info.pendingReceiverBytes = Math.max(0, info.pendingReceiverBytes - pending.bytes - pending.errorBytes);
    info.pendingReceiverChunkBytes = Math.max(0, info.pendingReceiverChunkBytes - pending.bytes);
    pending.bytes = 0;
    pending.errorBytes = 0;
}

function retainPendingError(info: IByteStreamInfo, pending: IPendingReceiver, error: Error): void {
    retainPendingDestroy(info, pending, error);
}

function retainPendingDestroy(info: IByteStreamInfo, pending: IPendingReceiver, error?: Error): void {
    releasePendingReceiverBytes(info, pending);
    pending.chunks = [];
    pending.destroyed = true;
    pending.destroyedError = undefined;
    if (!error) return;
    const availableBytes = Math.max(0, Math.min(PENDING_DESTROY_ERROR_MAX_BYTES, PENDING_RECEIVER_MAX_TOTAL_BYTES - info.pendingReceiverBytes));
    const message = truncateUtf8(error.message, availableBytes);
    pending.destroyedError = new Error(message);
    pending.errorBytes = Buffer.byteLength(message);
    info.pendingReceiverBytes += pending.errorBytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(value) <= maxBytes) return value;
    let truncated = Buffer.from(value).subarray(0, maxBytes).toString('utf8');
    while (Buffer.byteLength(truncated) > maxBytes) truncated = truncated.slice(0, -1);
    return truncated;
}

function reserveTerminalSender(info: IByteStreamInfo, id: number): boolean {
    pruneTerminalSenders(info);
    if (!info.terminalSenders.has(id) && info.terminalSenders.size >= TERMINAL_SENDER_MAX_COUNT) return false;
    info.terminalSenders.set(id, Date.now() + TERMINAL_SENDER_TTL_MS);
    return true;
}

function pruneTerminalSenders(info: IByteStreamInfo, now = Date.now()): void {
    for (const [id, expiresAt] of info.terminalSenders) {
        if (expiresAt <= now) info.terminalSenders.delete(id);
    }
}

function deletePendingReceiver(info: IByteStreamInfo, id: number, pending: IPendingReceiver): void {
    releasePendingReceiverBytes(info, pending);
    if (pending.timeout) clearTimeout(pending.timeout);
    info.pendingReceivers?.delete(id);
}

function clearPendingReceivers(info: IByteStreamInfo): void {
    for (const [id, pending] of info.pendingReceivers ?? []) deletePendingReceiver(info, id, pending);
}
