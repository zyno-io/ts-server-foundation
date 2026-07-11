import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

import { getCurrentApp } from '../app';
import { uuid7 } from '../helpers';
import { SrpcByteStream } from './SrpcByteStream';
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
    SrpcMessageFns,
    SrpcMeta,
    encodeSrpcMessage
} from './types';

export class SrpcConflictError extends Error {
    constructor() {
        super('Client ID is already connected');
        this.name = 'SrpcConflictError';
    }
}

export interface SrpcClientOptions {
    enableReconnect?: boolean;
    protocolVersion?: number;
}

export class SrpcClient<TClientInput extends BaseMessage = BaseMessage, TServerOutput extends BaseMessage = BaseMessage> {
    private ws?: WebSocket;
    private readonly streamConnectionHandlers = new Set<() => void>();
    private readonly streamDisconnectionHandlers = new Set<(cause: SrpcDisconnectCause) => void>();
    private readonly streamMessageHandlers = new Map<
        RequestKeys<TServerOutput>,
        { resultType: string; handler: (data: unknown) => Promise<unknown> | unknown }
    >();
    private readonly requestQueue = new Map<string, IQueuedRequest>();
    private connectResolve?: () => void;
    private connectReject?: (err: Error) => void;
    private reconnectionTimeout?: ReturnType<typeof setTimeout>;
    private pingInterval?: ReturnType<typeof setInterval>;
    private lastPongMs = 0;
    private intentionalDisconnect = false;
    private supersede = false;
    private streamId = '';
    private enableReconnect: boolean;
    private protocolVersion: number;

    isConnected = false;

    constructor(
        private readonly logger: ISrpcLogger,
        private readonly uri: string,
        private readonly clientMessage: SrpcMessageFns<TClientInput>,
        private readonly serverMessage: SrpcMessageFns<TServerOutput>,
        private readonly clientId: string,
        private readonly clientMeta?: SrpcMeta,
        private readonly clientSecret?: string,
        clientOptions?: SrpcClientOptions
    ) {
        this.enableReconnect = clientOptions?.enableReconnect !== false;
        this.protocolVersion = clientOptions?.protocolVersion ?? 2;
    }

    connect(options?: { supersede?: boolean }): Promise<void> {
        if (this.reconnectionTimeout) {
            clearTimeout(this.reconnectionTimeout);
            this.reconnectionTimeout = undefined;
        }

        this.connectReject?.(new Error('Connection superseded by new connect() call'));
        this.connectResolve = undefined;
        this.connectReject = undefined;

        if (this.ws) {
            this.intentionalDisconnect = true;
            this.ws.close();
            this.ws = undefined;
        }

        this.intentionalDisconnect = false;
        this.supersede = options?.supersede ?? false;
        this.streamId = uuid7();
        this.byteStream.parentStreamId = this.streamId;
        SrpcByteStream.init(this, { startId: 1, step: 2 });

        const ws = new WebSocket(this.generateWsUrl());
        ws.binaryType = 'nodebuffer';
        this.ws = ws;

        const connectTimeout = setTimeout(() => {
            this.connectReject?.(new Error('Connection failed: timeout'));
            this.connectResolve = undefined;
            this.connectReject = undefined;
            ws.close();
            this.queueReconnect();
        }, 10_000);

        const clearConnectTimeout = () => clearTimeout(connectTimeout);
        ws.once('message', data => this.handleInitialHandshake(ws, data, clearConnectTimeout));
        ws.on('close', (code, reason) => this.handleClose(ws, code, reason, clearConnectTimeout));
        ws.on('error', error => this.handleError(ws, error, clearConnectTimeout));

        const promise = new Promise<void>((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
        });
        promise.catch(() => {});
        return promise;
    }

    disconnect(): void {
        this.enableReconnect = false;
        this.intentionalDisconnect = true;
        if (this.reconnectionTimeout) clearTimeout(this.reconnectionTimeout);
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.ws?.close(1000, 'Client disconnect');
    }

    triggerConnectionCheck(): void {
        if (!this.isConnected) return;
        this.lastPongMs = Date.now() - 20_000;
        this.writeMessage({ pingPong: {} } as TClientInput);
    }

    private handleInitialHandshake(ws: WebSocket, data: WebSocket.RawData, clearConnectTimeout: () => void): void {
        if (this.ws !== ws) return;
        clearConnectTimeout();

        const message = this.decodeMessage(data);
        if (!message?.pingPong) {
            ws.close(4000, 'Expected handshake ping');
            return;
        }

        this.lastPongMs = Date.now();
        this.writeMessage({ pingPong: {} } as TClientInput);
        this.isConnected = true;
        this.pingInterval = setInterval(() => this.doPingPong(), 55_000);
        this.pingInterval.unref?.();
        this.connectResolve?.();
        this.connectResolve = undefined;
        this.connectReject = undefined;
        for (const handler of this.streamConnectionHandlers) handler();

        ws.on('message', msgData => this.handleMessage(msgData));
    }

    private handleClose(ws: WebSocket, code: number, _reason: Buffer, clearConnectTimeout: () => void): void {
        if (ws !== this.ws) return;
        clearConnectTimeout();
        const cause = parseDisconnectCause(code);
        if (cause === 'conflict') {
            this.connectReject?.(new SrpcConflictError());
            this.connectResolve = undefined;
            this.connectReject = undefined;
            this.handleDisconnect(cause, true);
            return;
        }
        this.handleDisconnect(cause);
    }

    private handleError(ws: WebSocket, error: Error, clearConnectTimeout: () => void): void {
        if (ws !== this.ws) return;
        clearConnectTimeout();
        if (!this.intentionalDisconnect) this.logger.warn('SRPC WebSocket error', error);
        ws.terminate();
        this.handleDisconnect('disconnect');
    }

    private handleDisconnect(cause: SrpcDisconnectCause = 'disconnect', suppressReconnect = false): void {
        if (this.reconnectionTimeout) return;
        if (this.enableReconnect && !suppressReconnect && !this.intentionalDisconnect) this.queueReconnect();
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = undefined;

        this.connectReject?.(new Error(`Connection failed: ${cause}`));
        this.connectResolve = undefined;
        this.connectReject = undefined;

        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.ws = undefined;
        if (wasConnected) {
            for (const handler of this.streamDisconnectionHandlers) handler(cause);
        }

        for (const queueItem of this.requestQueue.values()) queueItem.reject(new Error('Disconnected'));
        this.requestQueue.clear();
    }

    private queueReconnect(): void {
        if (!this.enableReconnect) return;
        this.reconnectionTimeout = setTimeout(() => {
            this.reconnectionTimeout = undefined;
            this.connect().catch(() => {});
        }, 1000);
        this.reconnectionTimeout.unref?.();
    }

    private doPingPong(): void {
        if (this.lastPongMs < Date.now() - 75_000) {
            this.ws?.close(4003, 'Pong timeout');
            return;
        }
        this.writeMessage({ pingPong: {} } as TClientInput);
    }

    private async handleMessage(data: WebSocket.RawData): Promise<void> {
        const message = this.decodeMessage(data);
        if (!message) return;

        if (message.pingPong) {
            this.lastPongMs = Date.now();
            return;
        }

        if (message.byteStreamOperation) {
            this.handleByteStreamOperation(message.byteStreamOperation);
            return;
        }

        if (!message.requestId) {
            this.ws?.close(4000, 'Invalid request ID');
            return;
        }

        if (message.reply) {
            this.handleReply(message.requestId, message);
            return;
        }

        await this.handleServerRequest(message.requestId, message);
    }

    private handleByteStreamOperation(op: NonNullable<TServerOutput['byteStreamOperation']>): void {
        if (op.write) SrpcByteStream.writeReceiver(this, op.streamId, op.write.chunk);
        else if (op.finish) SrpcByteStream.finishReceiver(this, op.streamId);
        else if (op.destroy) SrpcByteStream.destroySubstream(this, op.streamId, op.destroy.error);
    }

    private handleReply(requestId: string, message: TServerOutput & BaseMessage): void {
        const queueItem = this.requestQueue.get(requestId);
        if (!queueItem) {
            this.ws?.close(4000, 'Unknown request ID');
            return;
        }
        this.requestQueue.delete(requestId);
        if (message.error) queueItem.reject(new Error(message.error));
        else queueItem.resolve(message);
    }

    private async handleServerRequest(requestId: string, message: TServerOutput & BaseMessage): Promise<void> {
        for (const [key, handlerMeta] of this.streamMessageHandlers) {
            const requestData = (message as Record<string, unknown>)[key];
            if (requestData == null) continue;
            try {
                const result = await handlerMeta.handler(requestData);
                this.writeMessage({
                    requestId,
                    reply: true,
                    [handlerMeta.resultType]: result
                } as unknown as TClientInput);
            } catch (error) {
                this.writeMessage({ requestId, reply: true, error: String(error) } as TClientInput);
            }
            return;
        }
        this.writeMessage({ requestId, reply: true, error: 'Unhandled message type' } as TClientInput);
    }

    private generateWsUrl(): string {
        const authv = 1;
        const appv = '0.0.0';
        const ts = Date.now();
        const cid = this.clientId;
        const signable = `${authv}\n${appv}\n${ts}\n${this.streamId}\n${cid}\n`;
        const secret = this.clientSecret ?? getCurrentApp().config.SRPC_AUTH_SECRET;
        if (!secret) throw new Error('SRPC_AUTH_SECRET is not configured.');
        const signature = createHmac('sha256', secret).update(signable).digest('hex');
        const params = new URLSearchParams({
            authv: String(authv),
            appv,
            ts: String(ts),
            id: this.streamId,
            cid,
            signature,
            _v: String(this.protocolVersion)
        });

        if (this.supersede) {
            params.set('_supersede', '1');
            this.supersede = false;
        }

        for (const [key, value] of Object.entries(this.clientMeta ?? {})) {
            params.set(`m--${key}`, String(value));
        }

        const baseUri = this.uri.startsWith('ws://') || this.uri.startsWith('wss://') ? this.uri : `ws://${this.uri}`;
        const url = new URL(baseUri);
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

    private writeMessage(message: TClientInput): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(encodeSrpcMessage(this.clientMessage, message));
        return true;
    }

    private writeMessageAsync(message: TClientInput): Promise<void> {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Failed to send SRPC message: not connected'));
        const encoded = encodeSrpcMessage(this.clientMessage, message);
        return new Promise((resolve, reject) => {
            ws.send(encoded, error => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    byteStream = {
        parentStreamId: '',
        write: (streamId: number, chunk: unknown) =>
            this.writeMessageAsync({
                byteStreamOperation: { streamId, write: { chunk: chunk as Uint8Array } }
            } as TClientInput),
        finish: (streamId: number) => {
            this.writeMessage({ byteStreamOperation: { streamId, finish: {} } } as TClientInput);
        },
        destroy: (streamId: number, error?: unknown) => {
            this.writeMessage({
                byteStreamOperation: { streamId, destroy: { error: error ? String(error) : undefined } }
            } as TClientInput);
        },
        attachDisconnectHandler: (handler: () => void) => {
            this.ws?.on('close', handler);
        },
        detachDisconnectHandler: (handler: () => void) => {
            this.ws?.off('close', handler);
        },
        getBufferedAmount: () => this.ws?.bufferedAmount ?? 0
    };

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
        const requestType = `${prefix}Request`;
        const resultType = `${prefix}Response`;
        const requestId = uuid7();

        return new Promise<ResponseData<TServerOutput, P>>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.requestQueue.delete(requestId);
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            this.requestQueue.set(requestId, {
                exp: Date.now() + timeoutMs,
                resolve: response => {
                    clearTimeout(timeout);
                    const result = (response as Record<string, unknown>)[resultType];
                    if (result == null) reject(new Error('Invalid response from server'));
                    else resolve(result as ResponseData<TServerOutput, P>);
                },
                reject: error => {
                    clearTimeout(timeout);
                    reject(error);
                }
            });

            const sent = this.writeMessage({ requestId, [requestType]: data } as unknown as TClientInput);
            if (!sent) {
                this.requestQueue.delete(requestId);
                clearTimeout(timeout);
                reject(new Error('Failed to send request: not connected'));
            }
        });
    }
}

function parseDisconnectCause(code: number): SrpcDisconnectCause {
    if (code === 4000) return 'badArg';
    if (code === 4001) return 'conflict';
    if (code === 4002) return 'supersede';
    if (code === 4003) return 'timeout';
    return 'disconnect';
}

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}
