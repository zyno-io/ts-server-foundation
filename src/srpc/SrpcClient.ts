import { createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import WebSocket from 'ws';

import { getCurrentApp } from '../app';
import { assertSafeTimerMs, MAX_SAFE_TIMER_MS, uuid7 } from '../helpers';
import { byteStreamDestroyReason, IByteStream, SrpcByteStream } from './SrpcByteStream';
import {
    BaseMessage,
    HandlerRequestData,
    InvokePrefixes,
    IQueuedRequest,
    ISrpcLogger,
    RequestData,
    RequestKeys,
    ResponseData,
    SrpcDisconnectCause,
    SrpcBackpressureError,
    SrpcError,
    SrpcIndeterminateDeliveryError,
    SrpcMessageFns,
    SrpcMeta,
    SrpcTrafficLogging,
    encodeSrpcMessage,
    serializeSrpcError,
    srpcMessageTypes
} from './types';

export class SrpcConflictError extends Error {
    constructor() {
        super('Client ID is already connected');
        this.name = 'SrpcConflictError';
    }
}

export interface SrpcClientOptions {
    enableReconnect?: boolean;
    logTraffic?: SrpcTrafficLogging;
    /** Audience signed into auth-v2 credentials. Defaults to the WebSocket path. */
    authAudience?: string;
    /** Advertise support for associating byte-stream senders with a handler request. */
    senderAnnouncements?: boolean;
    maxPendingRequests?: number;
    maxPendingRequestBytes?: number;
    maxInFlightServerRequests?: number;
    maxInFlightServerRequestBytes?: number;
    maxBufferedBytes?: number;
    maxMessageBytes?: number;
    /** Full WebSocket handshake + activation timeout. Defaults to 60 seconds. */
    connectTimeoutMs?: number;
    /** How long replies for locally abandoned requests are ignored. Defaults to 60 seconds. */
    lateReplyTombstoneTtlMs?: number;
}

const DefaultMaxRequests = 128;
const DefaultMaxBytes = 8 * 1024 * 1024;
const DefaultMaxMessageBytes = 8 * 1024 * 1024;
const DefaultConnectTimeoutMs = 60_000;
const DefaultLateReplyTombstoneTtlMs = 60_000;
const MaxLateReplyTombstones = 256;
const MaxByteStreamId = 0x7fffffff;
const MaxBackpressuredByteStreams = 1_024;

interface HandlerPressureState {
    requests: number;
    bytes: number;
}

interface ByteStreamPressureState {
    backpressured: Set<number>;
    bufferedBytes: Map<number, number>;
}

export class SrpcClient<TClientInput extends BaseMessage = BaseMessage, TServerOutput extends BaseMessage = BaseMessage> {
    private readonly handlerRequestId = new AsyncLocalStorage<{ requestId: string; generation: number }>();
    private ws?: WebSocket;
    private readonly streamConnectionHandlers = new Set<() => void>();
    private readonly streamDisconnectionHandlers = new Set<(cause: SrpcDisconnectCause) => void>();
    private readonly streamMessageHandlers = new Map<
        RequestKeys<TServerOutput>,
        { resultType: string; handler: (data: unknown) => Promise<unknown> | unknown }
    >();
    private readonly requestQueue = new Map<string, IQueuedRequest>();
    private readonly requestBytes = new Map<string, number>();
    private readonly lateReplyTombstones = new Map<string, number>();
    private connectResolve?: () => void;
    private connectReject?: (err: Error) => void;
    private reconnectionTimeout?: ReturnType<typeof setTimeout>;
    private pingInterval?: ReturnType<typeof setInterval>;
    private lastPongMs = 0;
    private intentionalDisconnect = false;
    private supersede = false;
    private hasEstablishedGeneration = false;
    private streamId = '';
    private enableReconnect: boolean;
    private senderAnnouncements: boolean;
    private generation = 0;
    private readonly handlerPressureByGeneration = new Map<number, HandlerPressureState>();
    private readonly byteStreamsByGeneration = new Map<number, IByteStream>();
    private readonly byteStreamPressureByGeneration = new Map<number, ByteStreamPressureState>();
    private readonly byteStreamDisconnectHandlersByGeneration = new Map<number, Set<() => void>>();
    private awaitingActivation?: { ws: WebSocket; generation: number; clearConnectTimeout: () => void };
    private clearConnectTimeout?: () => void;

    isConnected = false;

    constructor(
        private readonly logger: ISrpcLogger,
        private readonly uri: string,
        private readonly clientMessage: SrpcMessageFns<TClientInput>,
        private readonly serverMessage: SrpcMessageFns<TServerOutput>,
        private readonly clientId: string,
        private readonly clientMeta?: SrpcMeta,
        private readonly clientSecret?: string,
        private readonly clientOptions?: SrpcClientOptions
    ) {
        validateClientResourceOptions(clientOptions);
        this.enableReconnect = clientOptions?.enableReconnect !== false;
        this.senderAnnouncements = clientOptions?.senderAnnouncements !== false;
    }

    connect(options?: { supersede?: boolean }): Promise<void> {
        if (this.reconnectionTimeout) {
            clearTimeout(this.reconnectionTimeout);
            this.reconnectionTimeout = undefined;
        }

        const wasConnected = this.isConnected;
        this.clearConnectTimeout?.();
        this.connectReject?.(new Error('Connection superseded by new connect() call'));
        this.rejectAllRequests(new SrpcIndeterminateDeliveryError(this.clientId, new Error('Connection superseded by new connect() call')));
        this.connectResolve = undefined;
        this.connectReject = undefined;
        this.isConnected = false;
        this.awaitingActivation = undefined;
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = undefined;
        if (wasConnected) {
            for (const handler of this.streamDisconnectionHandlers) {
                try {
                    handler('supersede');
                } catch (error) {
                    this.logger.error('SRPC disconnect handler failed', error);
                }
            }
        }

        const previousGeneration = this.generation;
        const generation = ++this.generation;
        this.handlerPressureByGeneration.delete(previousGeneration);
        this.revokeByteStreamGeneration(previousGeneration);
        if (this.ws) {
            this.intentionalDisconnect = true;
            this.ws.close();
            this.ws = undefined;
        }

        this.intentionalDisconnect = false;
        this.supersede = options?.supersede ?? false;
        this.streamId = uuid7();
        this.currentByteStream = this.createByteStream(generation);
        this.byteStreamsByGeneration.set(generation, this.currentByteStream);
        this.currentByteStream.parentStreamId = this.streamId;
        SrpcByteStream.init({ byteStream: this.currentByteStream }, { startId: 1, step: 2 });

        const ws = new WebSocket(this.generateWsUrl(), { maxPayload: this.maxMessageBytes });
        ws.binaryType = 'nodebuffer';
        this.ws = ws;

        let connectTimeout: ReturnType<typeof setTimeout>;
        const clearConnectTimeout = () => {
            clearTimeout(connectTimeout);
            if (this.clearConnectTimeout === clearConnectTimeout) this.clearConnectTimeout = undefined;
        };
        this.clearConnectTimeout = clearConnectTimeout;
        connectTimeout = setTimeout(() => {
            if (!this.isCurrent(ws, generation)) return;
            this.revokeGeneration(ws, generation, 'timeout', false, new Error('Connection failed: timeout'));
            ws.close();
        }, this.connectTimeoutMs);

        ws.once('message', data => this.handleInitialHandshake(ws, generation, data, clearConnectTimeout));
        ws.on('close', (code, reason) => this.handleClose(ws, generation, code, reason, clearConnectTimeout));
        ws.on('error', error => this.handleError(ws, generation, error, clearConnectTimeout));

        const promise = new Promise<void>((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
        });
        promise.catch(() => {});
        return promise;
    }

    disconnect(): void {
        const ws = this.ws;
        const generation = this.generation;
        this.enableReconnect = false;
        this.intentionalDisconnect = true;
        this.clearConnectTimeout?.();
        if (this.reconnectionTimeout) clearTimeout(this.reconnectionTimeout);
        this.reconnectionTimeout = undefined;
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = undefined;
        if (ws && this.isCurrent(ws, generation)) {
            this.revokeGeneration(ws, generation, 'disconnect', true, new Error('Connection closed by client'));
        }
        ws?.close(1000, 'Client disconnect');
    }

    triggerConnectionCheck(): void {
        if (!this.isConnected) return;
        this.lastPongMs = Date.now() - 20_000;
        this.writeMessage({ pingPong: {} } as TClientInput);
    }

    private handleInitialHandshake(ws: WebSocket, generation: number, data: WebSocket.RawData, clearConnectTimeout: () => void): void {
        if (!this.isCurrent(ws, generation)) return;
        const message = this.decodeMessage(data);
        if (!message?.pingPong) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'Expected handshake ping');
            return;
        }

        this.lastPongMs = Date.now();
        if (!this.writeMessage({ pingPong: {} } as TClientInput, generation) || !this.isCurrent(ws, generation)) return;
        this.awaitingActivation = { ws, generation, clearConnectTimeout };
        ws.on('message', msgData => {
            void this.handleMessage(ws, generation, msgData).catch(error => {
                this.logger.warn('Failed to dispatch SRPC message', error);
                this.closeGenerationWithError(ws, generation, 'badArg', 'Invalid message format');
            });
        });
    }

    private completeConnection(ws: WebSocket, generation: number): void {
        if (!this.isCurrent(ws, generation) || this.isConnected) return;
        this.awaitingActivation?.clearConnectTimeout();
        this.awaitingActivation = undefined;
        this.isConnected = true;
        this.hasEstablishedGeneration = true;
        this.pingInterval = setInterval(() => this.doPingPong(), 55_000);
        this.pingInterval.unref?.();
        this.connectResolve?.();
        this.connectResolve = undefined;
        this.connectReject = undefined;
        for (const handler of this.streamConnectionHandlers) {
            try {
                handler();
            } catch (error) {
                this.logger.error('SRPC connection handler failed', error);
            }
        }
    }

    private handleClose(ws: WebSocket, generation: number, code: number, _reason: Buffer, clearConnectTimeout: () => void): void {
        if (!this.isCurrent(ws, generation)) return;
        clearConnectTimeout();
        const cause = parseDisconnectCause(code);
        if (cause === 'conflict') {
            this.revokeGeneration(ws, generation, cause, true, new SrpcConflictError());
            return;
        }
        this.revokeGeneration(ws, generation, cause);
    }

    private handleError(ws: WebSocket, generation: number, error: Error, clearConnectTimeout: () => void): void {
        if (!this.isCurrent(ws, generation)) return;
        clearConnectTimeout();
        if (!this.intentionalDisconnect) this.logger.warn('SRPC WebSocket error', error);
        this.revokeGeneration(ws, generation, 'disconnect');
        ws.terminate();
    }

    private revokeGeneration(
        ws: WebSocket,
        generation: number,
        cause: SrpcDisconnectCause,
        suppressReconnect = false,
        connectError: Error = new Error(`Connection failed: ${cause}`)
    ): boolean {
        if (!this.isCurrent(ws, generation)) return false;
        this.clearConnectTimeout?.();
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = undefined;

        this.connectReject?.(connectError);
        this.connectResolve = undefined;
        this.connectReject = undefined;

        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.awaitingActivation = undefined;
        this.ws = undefined;
        this.handlerPressureByGeneration?.delete(generation);
        this.revokeByteStreamGeneration(generation);
        this.rejectAllRequests(new SrpcIndeterminateDeliveryError(this.clientId ?? '', new Error('Disconnected')));
        if (wasConnected) {
            for (const handler of this.streamDisconnectionHandlers ?? []) {
                try {
                    handler(cause);
                } catch (error) {
                    this.logger.error('SRPC disconnect handler failed', error);
                }
            }
        }

        if (this.enableReconnect && !suppressReconnect && !this.intentionalDisconnect && !this.reconnectionTimeout) this.queueReconnect();
        return true;
    }

    private closeGenerationWithError(ws: WebSocket, generation: number, cause: SrpcDisconnectCause, message: string): void {
        if (!this.revokeGeneration(ws, generation, cause)) return;
        ws.close(closeCodeForCause(cause), message.slice(0, 123));
    }

    private queueReconnect(): void {
        if (!this.enableReconnect) return;
        this.reconnectionTimeout = setTimeout(() => {
            this.reconnectionTimeout = undefined;
            this.connect({ supersede: this.hasEstablishedGeneration }).catch(() => {});
        }, 1000);
        this.reconnectionTimeout.unref?.();
    }

    private doPingPong(): void {
        if (this.lastPongMs < Date.now() - 75_000) {
            const ws = this.ws;
            if (ws) this.closeGenerationWithError(ws, this.generation, 'timeout', 'Pong timeout');
            return;
        }
        this.writeMessage({ pingPong: {} } as TClientInput);
    }

    private async handleMessage(ws: WebSocket, generation: number, data: WebSocket.RawData): Promise<void> {
        if (!this.isCurrent(ws, generation)) return;
        const frameBytes = toBuffer(data).byteLength;
        if (frameBytes > this.maxMessageBytes) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'SRPC message too large');
            return;
        }
        const message = this.decodeMessage(data);
        if (!message) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'Invalid message format');
            return;
        }
        this.logTraffic('inbound', message);

        if (message.pingPong) {
            this.lastPongMs = Date.now();
            if (this.awaitingActivation?.ws === ws && this.awaitingActivation.generation === generation) this.completeConnection(ws, generation);
            return;
        }

        const activation = this.awaitingActivation;
        const isActivating = activation?.ws === ws && activation.generation === generation;
        if (!this.isConnected && !isActivating) return;

        if (message.byteStreamOperation) {
            if (!this.validRemoteByteStreamOperation(message.byteStreamOperation)) {
                this.closeGenerationWithError(ws, generation, 'badArg', 'Invalid byte stream ID');
                return;
            }
            this.handleByteStreamOperation(generation, message.byteStreamOperation);
            return;
        }

        if (!message.requestId) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'Invalid request ID');
            return;
        }

        if (message.reply) {
            this.handleReply(ws, generation, message.requestId, message);
            return;
        }

        const bytes = frameBytes;
        const pressure = this.handlerPressureByGeneration.get(generation) ?? { requests: 0, bytes: 0 };
        if (pressure.requests >= this.maxInFlightServerRequests || pressure.bytes + bytes > this.maxInFlightServerRequestBytes) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'Too many in-flight server requests');
            return;
        }
        pressure.requests++;
        pressure.bytes += bytes;
        this.handlerPressureByGeneration.set(generation, pressure);
        try {
            await this.handleServerRequest(generation, message.requestId, message);
        } finally {
            if (this.handlerPressureByGeneration.get(generation) === pressure) {
                pressure.requests = Math.max(0, pressure.requests - 1);
                pressure.bytes = Math.max(0, pressure.bytes - bytes);
                if (!pressure.requests) this.handlerPressureByGeneration.delete(generation);
            }
        }
    }

    private handleByteStreamOperation(generation: number, op: NonNullable<TServerOutput['byteStreamOperation']>): void {
        if (op.destroy != null && SrpcByteStream.consumeTerminalSender(this, op.streamId)) return;
        if (op.write != null) {
            const state = this.getByteStreamPressureState(generation);
            const wasBackpressured = state.backpressured.has(op.streamId);
            const accepted = SrpcByteStream.writeReceiver(this, op.streamId, op.write.chunk);
            this.updateByteStreamBufferedBytes(generation, op.streamId, SrpcByteStream.getReceiverBufferedBytes(this, op.streamId));
            if (!accepted && wasBackpressured) {
                SrpcByteStream.abortReceiver(this, op.streamId, new Error(`SRPC byte stream ${op.streamId} receiver is not draining`));
                this.clearByteStreamPressure(generation, op.streamId);
                return;
            }
            if (!accepted) {
                if (state.backpressured.size >= MaxBackpressuredByteStreams) {
                    SrpcByteStream.abortReceiver(this, op.streamId, new Error('Too many backpressured SRPC byte streams'));
                    this.clearByteStreamPressure(generation, op.streamId);
                    return;
                }
                state.backpressured.add(op.streamId);
            } else if (wasBackpressured) {
                state.backpressured.delete(op.streamId);
            }
            if (this.totalByteStreamBufferedBytes(state) > this.maxBufferedBytes) {
                SrpcByteStream.abortReceiver(this, op.streamId, new Error('Too many buffered SRPC byte stream bytes'));
                this.clearByteStreamPressure(generation, op.streamId);
            }
        } else if (op.finish != null) {
            this.getByteStreamPressureState(generation).backpressured.delete(op.streamId);
            SrpcByteStream.finishReceiver(this, op.streamId);
        } else if (op.destroy != null) {
            this.clearByteStreamPressure(generation, op.streamId);
            SrpcByteStream.destroySubstream(this, op.streamId, op.destroy.error);
        }
    }

    private handleReply(ws: WebSocket, generation: number, requestId: string, message: TServerOutput & BaseMessage): void {
        const queueItem = this.requestQueue.get(requestId);
        if (!queueItem) {
            if (this.isLateReply(requestId)) return;
            this.closeGenerationWithError(ws, generation, 'badArg', 'Unknown request ID');
            return;
        }
        this.requestQueue.delete(requestId);
        this.requestBytes.delete(requestId);
        if (message.error !== undefined) queueItem.reject(new SrpcError(message.error, message.userError));
        else queueItem.resolve(message);
    }

    private async handleServerRequest(generation: number, requestId: string, message: TServerOutput & BaseMessage): Promise<void> {
        for (const [key, handlerMeta] of this.streamMessageHandlers) {
            const requestData = (message as Record<string, unknown>)[key];
            if (requestData == null) continue;
            try {
                const result = await this.handlerRequestId.run({ requestId, generation }, () => handlerMeta.handler(requestData));
                this.writeMessage(
                    {
                        requestId,
                        reply: true,
                        [handlerMeta.resultType]: result
                    } as unknown as TClientInput,
                    generation
                );
            } catch (error) {
                this.writeMessage(
                    {
                        requestId,
                        reply: true,
                        ...serializeSrpcError(error)
                    } as TClientInput,
                    generation
                );
            }
            return;
        }
        this.writeMessage({ requestId, reply: true, error: 'Unhandled message type' } as TClientInput, generation);
    }

    private generateWsUrl(): string {
        const authv = 2;
        const appv = '0.0.0';
        const ts = Date.now();
        const cid = this.clientId;
        const secret = this.clientSecret ?? getCurrentApp().config.SRPC_AUTH_SECRET;
        if (!secret) throw new Error('SRPC_AUTH_SECRET is not configured.');
        const baseUri = this.uri.startsWith('ws://') || this.uri.startsWith('wss://') ? this.uri : `ws://${this.uri}`;
        const url = new URL(baseUri);
        const nonce = uuid7();
        const features = normalizeFeatures(this.senderAnnouncements ? ['sender-announcements'] : []);
        const metadata = normalizeMetadata(this.clientMeta);
        const supersede = this.supersede ? '1' : '0';
        const audience = this.clientOptions?.authAudience ?? url.pathname;
        const signable = canonicalAuthV2({
            path: url.pathname,
            audience,
            appv,
            ts: String(ts),
            nonce,
            id: this.streamId,
            cid,
            protocol: '2',
            supersede,
            features,
            metadata
        });
        const signature = createHmac('sha256', secret).update(signable).digest('hex');
        const params = new URLSearchParams({
            authv: String(authv),
            appv,
            ts: String(ts),
            id: this.streamId,
            cid,
            signature,
            _v: '2'
        });
        params.set('nonce', nonce);
        params.set('aud', audience);
        if (features) params.set('_f', features);

        if (this.supersede) {
            params.set('_supersede', '1');
            this.supersede = false;
        }

        for (const [key, value] of Object.entries(metadata)) params.set(`m--${key}`, value);
        url.search = params.toString();
        return url.toString();
    }

    private decodeMessage(data: WebSocket.RawData): (TServerOutput & BaseMessage) | null {
        try {
            return this.serverMessage.decode(toBuffer(data)) as TServerOutput & BaseMessage;
        } catch (error) {
            this.logger.error('Failed to decode SRPC message', error);
            return null;
        }
    }

    private writeMessage(message: TClientInput, generation = this.generation): boolean {
        let encoded: Buffer;
        try {
            encoded = encodeSrpcMessage(this.clientMessage, message);
        } catch (error) {
            this.logger.error('Failed to encode SRPC message', error);
            return false;
        }
        return this.writeEncodedMessage(message, encoded, generation);
    }

    private writeEncodedMessage(message: TClientInput, encoded: Buffer, generation = this.generation): boolean {
        const ws = this.ws;
        if (!ws || !this.isCurrent(ws, generation) || ws.readyState !== WebSocket.OPEN) return false;
        if (encoded.byteLength > this.maxMessageBytes || (ws.bufferedAmount ?? 0) + encoded.byteLength > this.maxBufferedBytes) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'sRPC stream outgoing buffer limit exceeded');
            return false;
        }
        try {
            ws.send(encoded);
            this.logTraffic('outbound', message);
            return true;
        } catch (error) {
            this.logger.warn('Failed to send SRPC message', error);
            this.closeGenerationWithError(ws, generation, 'badArg', 'Failed to send SRPC message');
            return false;
        }
    }

    private writeMessageAsync(message: TClientInput, generation = this.generation): Promise<void> {
        const ws = this.ws;
        if (!ws || !this.isCurrent(ws, generation) || ws.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error('Failed to send SRPC message: not connected'));
        const encoded = encodeSrpcMessage(this.clientMessage, message);
        if (encoded.byteLength > this.maxMessageBytes || (ws.bufferedAmount ?? 0) + encoded.byteLength > this.maxBufferedBytes) {
            this.closeGenerationWithError(ws, generation, 'badArg', 'sRPC stream outgoing buffer limit exceeded');
            return Promise.reject(new SrpcBackpressureError('sRPC stream outgoing buffer limit exceeded'));
        }
        return new Promise((resolve, reject) => {
            try {
                ws.send(encoded, error => {
                    if (error) {
                        this.closeGenerationWithError(ws, generation, 'badArg', 'Failed to send SRPC message');
                        reject(error);
                    } else if (!this.isCurrent(ws, generation)) reject(new Error('Failed to send SRPC message: generation revoked'));
                    else {
                        this.logTraffic('outbound', message);
                        resolve();
                    }
                });
            } catch (error) {
                this.closeGenerationWithError(ws, generation, 'badArg', 'Failed to send SRPC message');
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private currentByteStream: IByteStream = this.createByteStream(0);

    private logTraffic(direction: 'inbound' | 'outbound', message: BaseMessage): void {
        const options = this.clientOptions?.logTraffic;
        if (!options) return;
        const bodies = typeof options === 'object' && options.bodies === true;
        this.logger.info('SRPC traffic', {
            direction,
            clientId: this.clientId,
            messageTypes: srpcMessageTypes(message),
            ...(bodies ? { body: message } : {})
        });
    }

    get byteStream(): IByteStream {
        return this.resolveByteStream();
    }

    private createByteStream(generation: number): IByteStream {
        return {
            parentStreamId: '',
            remoteSenderIdParity: 0,
            receiverBufferChanged: (streamId, bufferedBytes) => this.updateByteStreamBufferedBytes(generation, streamId, bufferedBytes),
            write: (streamId, chunk) =>
                this.writeMessageAsync(
                    { byteStreamOperation: { streamId, write: { chunk: new Uint8Array(chunk as ArrayLike<number>) } } } as TClientInput,
                    generation
                ),
            finish: streamId => this.writeMessage({ byteStreamOperation: { streamId, finish: {} } } as TClientInput, generation),
            destroy: (streamId, error) =>
                this.writeMessage(
                    { byteStreamOperation: { streamId, destroy: { error: byteStreamDestroyReason(error) } } } as TClientInput,
                    generation
                ),
            announceSender: streamId => {
                const context = this.handlerRequestId.getStore();
                if (!this.senderAnnouncements || !context || context.generation !== generation) return;
                this.writeMessage(
                    { requestId: context.requestId, byteStreamOperation: { streamId, write: { chunk: new Uint8Array() } } } as TClientInput,
                    generation
                );
            },
            attachDisconnectHandler: handler => {
                let handlers = this.byteStreamDisconnectHandlersByGeneration.get(generation);
                if (!handlers) {
                    handlers = new Set();
                    this.byteStreamDisconnectHandlersByGeneration.set(generation, handlers);
                }
                handlers.add(handler);
            },
            detachDisconnectHandler: handler => this.byteStreamDisconnectHandlersByGeneration.get(generation)?.delete(handler),
            getBufferedAmount: () => (this.generation === generation ? (this.ws?.bufferedAmount ?? 0) : 0)
        };
    }

    resolveByteStream(): IByteStream {
        const context = this.handlerRequestId.getStore();
        const generation = context?.generation ?? this.generation;
        const activation = this.awaitingActivation;
        const isCurrentActivation = activation?.generation === generation && this.isCurrent(activation.ws, generation);
        if (generation !== this.generation || (!this.isConnected && !isCurrentActivation)) {
            throw new Error('Cannot create an SRPC byte stream from a stale handler generation');
        }
        const transport = this.byteStreamsByGeneration.get(generation);
        if (!transport) throw new Error('SRPC handler transport is unavailable');
        return transport;
    }

    private revokeByteStreamGeneration(generation: number): void {
        const handlers = this.byteStreamDisconnectHandlersByGeneration?.get(generation);
        this.byteStreamDisconnectHandlersByGeneration?.delete(generation);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler();
                } catch (error) {
                    this.logger.error('SRPC byte stream disconnect handler failed', error);
                }
            }
        }
        this.byteStreamsByGeneration?.delete(generation);
        this.byteStreamPressureByGeneration?.delete(generation);
    }

    registerConnectionHandler(handler: () => void): void {
        this.streamConnectionHandlers.add(handler);
    }

    registerMessageHandler<P extends InvokePrefixes<TServerOutput, TClientInput>>(
        prefix: P,
        handler: (data: HandlerRequestData<TServerOutput, P>) => Promise<ResponseData<TClientInput, P>> | ResponseData<TClientInput, P>
    ): void {
        const actionType = `${prefix}Request` as RequestKeys<TServerOutput>;
        this.streamMessageHandlers.set(actionType, {
            resultType: `${prefix}Response`,
            handler: handler as (data: unknown) => Promise<unknown> | unknown
        });
    }

    registerDisconnectHandler(handler: (cause: SrpcDisconnectCause) => void): void {
        this.streamDisconnectionHandlers.add(handler);
    }

    invoke<P extends InvokePrefixes<TClientInput, TServerOutput>>(
        prefix: P,
        data: RequestData<TClientInput, P>,
        timeoutMs = 30_000
    ): Promise<ResponseData<TServerOutput, P>> {
        assertTimeout(timeoutMs);
        const requestType = `${prefix}Request`;
        const resultType = `${prefix}Response`;
        const requestId = uuid7();
        const message = { requestId, [requestType]: data } as unknown as TClientInput;
        let encoded: Buffer;
        try {
            encoded = encodeSrpcMessage(this.clientMessage, message);
        } catch (error) {
            return Promise.reject(error);
        }
        const encodedBytes = encoded.byteLength;
        if (encodedBytes > this.maxMessageBytes) return Promise.reject(new SrpcBackpressureError('sRPC request exceeds message limit'));
        if (this.requestQueue.size >= this.maxPendingRequests || this.pendingRequestBytes + encodedBytes > this.maxPendingRequestBytes) {
            return Promise.reject(new SrpcBackpressureError('Too many pending SRPC requests'));
        }

        return new Promise<ResponseData<TServerOutput, P>>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.requestQueue.delete(requestId)) return;
                this.requestBytes.delete(requestId);
                this.addLateReplyTombstone(requestId);
                reject(new SrpcIndeterminateDeliveryError(this.clientId, new Error(`Request timeout after ${timeoutMs}ms`)));
            }, timeoutMs);

            this.requestQueue.set(requestId, {
                exp: Date.now() + timeoutMs,
                resolve: response => {
                    clearTimeout(timeout);
                    this.requestBytes.delete(requestId);
                    const result = (response as Record<string, unknown>)[resultType];
                    if (result == null) reject(new Error('Invalid response from server'));
                    else resolve(result as ResponseData<TServerOutput, P>);
                },
                reject: error => {
                    clearTimeout(timeout);
                    this.requestBytes.delete(requestId);
                    reject(error);
                }
            });
            this.requestBytes.set(requestId, encodedBytes);

            const sent = this.writeEncodedMessage(message, encoded, this.generation);
            if (!sent) {
                this.requestQueue.delete(requestId);
                this.requestBytes.delete(requestId);
                clearTimeout(timeout);
                reject(new Error('Failed to send request: not connected'));
            }
        });
    }

    private isCurrent(ws: WebSocket, generation: number): boolean {
        return this.ws === ws && this.generation === generation;
    }

    private rejectAllRequests(error: Error): void {
        for (const [requestId, queueItem] of this.requestQueue?.entries() ?? []) {
            this.addLateReplyTombstone(requestId);
            queueItem.reject(error);
        }
        this.requestQueue?.clear();
        this.requestBytes?.clear();
    }

    private validRemoteByteStreamOperation(op: NonNullable<TServerOutput['byteStreamOperation']>): boolean {
        const id = op.streamId;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > MaxByteStreamId) return false;
        const hasWrite = op.write != null;
        const hasFinish = op.finish != null;
        const hasDestroy = op.destroy != null;
        const operationCount = Number(hasWrite) + Number(hasFinish) + Number(hasDestroy);
        if (operationCount !== 1) return false;
        if (hasWrite && (!isPlainObject(op.write) || !(op.write.chunk instanceof Uint8Array))) return false;
        if (hasFinish && !isPlainObject(op.finish)) return false;
        if (hasDestroy && (!isPlainObject(op.destroy) || (op.destroy.error != null && typeof op.destroy.error !== 'string'))) return false;
        if (hasDestroy) return id % 2 === 0 || SrpcByteStream.hasSender(this, id) || SrpcByteStream.hasTerminalSender(this, id);
        return id % 2 === 0;
    }

    private getByteStreamPressureState(generation: number): ByteStreamPressureState {
        const existing = this.byteStreamPressureByGeneration.get(generation);
        if (existing) return existing;
        const state = { backpressured: new Set<number>(), bufferedBytes: new Map<number, number>() };
        this.byteStreamPressureByGeneration.set(generation, state);
        return state;
    }

    private updateByteStreamBufferedBytes(generation: number, streamId: number, bufferedBytes: number): void {
        if (generation !== this.generation) return;
        const state = this.getByteStreamPressureState(generation);
        const previous = state.bufferedBytes.get(streamId) ?? 0;
        if (bufferedBytes < previous) state.backpressured.delete(streamId);
        if (bufferedBytes > 0) state.bufferedBytes.set(streamId, bufferedBytes);
        else state.bufferedBytes.delete(streamId);
    }

    private clearByteStreamPressure(generation: number, streamId: number): void {
        const state = this.byteStreamPressureByGeneration.get(generation);
        state?.backpressured.delete(streamId);
        state?.bufferedBytes.delete(streamId);
    }

    private totalByteStreamBufferedBytes(state: ByteStreamPressureState): number {
        let total = 0;
        for (const bytes of state.bufferedBytes.values()) total += bytes;
        return total;
    }

    private addLateReplyTombstone(requestId: string): void {
        const now = Date.now();
        this.pruneLateReplyTombstones(now);
        this.lateReplyTombstones.set(requestId, now + this.lateReplyTombstoneTtlMs);
        while (this.lateReplyTombstones.size > MaxLateReplyTombstones) {
            const oldestRequestId = this.lateReplyTombstones.keys().next().value;
            if (oldestRequestId === undefined) break;
            this.lateReplyTombstones.delete(oldestRequestId);
        }
    }

    private isLateReply(requestId: string): boolean {
        const now = Date.now();
        this.pruneLateReplyTombstones(now);
        return (this.lateReplyTombstones.get(requestId) ?? 0) > now;
    }

    private pruneLateReplyTombstones(now: number): void {
        for (const [requestId, expiresAt] of this.lateReplyTombstones) {
            if (expiresAt <= now) this.lateReplyTombstones.delete(requestId);
        }
    }

    private get lateReplyTombstoneTtlMs(): number {
        return configuredPositiveInteger(this.clientOptions?.lateReplyTombstoneTtlMs, DefaultLateReplyTombstoneTtlMs);
    }

    private get pendingRequestBytes(): number {
        let total = 0;
        for (const bytes of this.requestBytes.values()) total += bytes;
        return total;
    }

    private get maxPendingRequests(): number {
        return configuredPositiveInteger(this.clientOptions?.maxPendingRequests, DefaultMaxRequests);
    }
    private get maxPendingRequestBytes(): number {
        return configuredPositiveInteger(this.clientOptions?.maxPendingRequestBytes, DefaultMaxBytes);
    }
    private get maxInFlightServerRequests(): number {
        return configuredPositiveInteger(this.clientOptions?.maxInFlightServerRequests, DefaultMaxRequests);
    }
    private get maxInFlightServerRequestBytes(): number {
        return configuredPositiveInteger(this.clientOptions?.maxInFlightServerRequestBytes, DefaultMaxBytes);
    }
    private get maxBufferedBytes(): number {
        return configuredPositiveInteger(this.clientOptions?.maxBufferedBytes, DefaultMaxBytes);
    }
    private get maxMessageBytes(): number {
        return configuredPositiveInteger(this.clientOptions?.maxMessageBytes, DefaultMaxMessageBytes);
    }
    private get connectTimeoutMs(): number {
        const value = this.clientOptions?.connectTimeoutMs;
        return value != null && Number.isSafeInteger(value) && value > 0 && value <= MAX_SAFE_TIMER_MS ? value : DefaultConnectTimeoutMs;
    }
}

function parseDisconnectCause(code: number): SrpcDisconnectCause {
    if (code === 4000) return 'badArg';
    if (code === 4001) return 'conflict';
    if (code === 4002) return 'supersede';
    if (code === 4003) return 'timeout';
    return 'disconnect';
}

function closeCodeForCause(cause: SrpcDisconnectCause): number {
    return { disconnect: 1000, badArg: 4000, conflict: 4001, supersede: 4002, timeout: 4003 }[cause];
}

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

function configuredPositiveInteger(value: number | undefined, fallback: number): number {
    return value != null && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validateClientResourceOptions(options: SrpcClientOptions | undefined): void {
    if (!options) return;
    for (const [name, value] of [
        ['maxPendingRequests', options.maxPendingRequests],
        ['maxPendingRequestBytes', options.maxPendingRequestBytes],
        ['maxInFlightServerRequests', options.maxInFlightServerRequests],
        ['maxInFlightServerRequestBytes', options.maxInFlightServerRequestBytes],
        ['maxBufferedBytes', options.maxBufferedBytes],
        ['maxMessageBytes', options.maxMessageBytes]
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
            throw new Error(`sRPC client ${name} must be a positive integer`);
        }
    }
    const timer = options.lateReplyTombstoneTtlMs;
    if (timer !== undefined && (!Number.isSafeInteger(timer) || timer < 1 || timer > MAX_SAFE_TIMER_MS)) {
        throw new Error(`sRPC client lateReplyTombstoneTtlMs must be a safe positive integer between 1 and ${MAX_SAFE_TIMER_MS}`);
    }
    const connectTimeout = options.connectTimeoutMs;
    if (connectTimeout !== undefined && (!Number.isSafeInteger(connectTimeout) || connectTimeout < 1 || connectTimeout > MAX_SAFE_TIMER_MS)) {
        throw new Error(`sRPC client connectTimeoutMs must be a safe positive integer between 1 and ${MAX_SAFE_TIMER_MS}`);
    }
}

function assertTimeout(value: number): void {
    assertSafeTimerMs(value, 'Request timeout');
}

function normalizeFeatures(features: string[]): string {
    return [...new Set(features)].sort().join(',');
}

function normalizeMetadata(meta: SrpcMeta | undefined): Record<string, string> {
    return Object.fromEntries(
        Object.entries(meta ?? {})
            .map(([key, value]) => [key, String(value)])
            .sort(([a], [b]) => compareCodeUnits(a, b))
    );
}

function canonicalAuthV2(fields: {
    path: string;
    audience: string;
    appv: string;
    ts: string;
    nonce: string;
    id: string;
    cid: string;
    protocol: string;
    supersede: string;
    features: string;
    metadata: Record<string, string>;
}): string {
    return JSON.stringify({ version: 2, ...fields });
}

function compareCodeUnits(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
