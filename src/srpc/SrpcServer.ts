import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';

import { getCurrentApp } from '../app';
import { uuid7 } from '../helpers';
import { SrpcByteStream } from './SrpcByteStream';
import { notifySrpcObservers } from './observer';
import {
    BaseMessage,
    HandlerRequestData,
    InvokePrefixes,
    IQueuedRequest,
    ISrpcLogger,
    ISrpcMessageHandler,
    ISrpcServerOptions,
    RequestData,
    RequestKeys,
    ResponseData,
    SrpcDisconnectCause,
    SrpcError,
    SrpcMeta,
    SrpcStream,
    TSrpcMessageHandlerFnOrClass,
    encodeSrpcMessage,
    isSrpcMessageHandlerClass
} from './types';
import { createWebSocketUpgradeHandler, installWebSocketUpgradeHandler, removeWebSocketUpgradeHandler } from '../http';

const StreamInfoSymbol = Symbol('srpc-info');

interface StreamInfo {
    clientStreamId: string;
    clientId: string;
    appVersion: string;
    configureTs: number;
    protocolVersion: number;
    supersede: boolean;
    address: string;
    meta: Record<string, unknown>;
}

const noopLogger: ISrpcLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {}
};

export class SrpcServer<
    TMeta extends SrpcMeta = SrpcMeta,
    TClientOutput extends BaseMessage = BaseMessage,
    TServerOutput extends BaseMessage = BaseMessage
> {
    private readonly logger: ISrpcLogger;
    private readonly wsServer = new WebSocket.Server({ noServer: true });
    private readonly streamConnectionHandlers = new Set<(stream: SrpcStream<TMeta>) => void | Promise<void>>();
    private readonly streamDisconnectionHandlers = new Set<(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause) => void>();
    private readonly streamMessageHandlers = new Map<
        RequestKeys<TClientOutput>,
        {
            resultType: string;
            handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, unknown, unknown>;
        }
    >();
    private readonly blockedClientRequests = new WeakSet<SrpcStream<TMeta>>();
    private readonly pendingClientRequests = new WeakMap<SrpcStream<TMeta>, TClientOutput[]>();
    private readonly cleanupUpgradeHandler?: () => void;
    private readonly inactivityCheckInterval: ReturnType<typeof setInterval>;
    private clientAuthorizer?: (metadata: any, req: IncomingMessage) => Promise<boolean | Partial<TMeta>> | boolean | Partial<TMeta>;
    private clientKeyFetcher?: (clientId: string) => Promise<false | string> | false | string;

    readonly streamsById = new Map<string, SrpcStream<TMeta>>();
    readonly streamsByClientId = new Map<string, SrpcStream<TMeta>>();
    protected readonly pendingStreamsByClientId = new Map<string, SrpcStream<TMeta>>();

    constructor(private readonly options: ISrpcServerOptions<TClientOutput, TServerOutput>) {
        this.logger = createLogger(options.logger, options.logLevel);
        this.wsServer.on('connection', (ws, request) => this.attachConnection(ws, request));

        if (options.httpServer) {
            const handler = installWebSocketUpgradeHandler({
                httpServer: options.httpServer,
                wsPath: options.wsPath,
                wsServer: this.wsServer,
                verifyClient: this.verifyClient
            });
            this.cleanupUpgradeHandler = () => removeWebSocketUpgradeHandler(options.httpServer!, options.wsPath, handler);
        } else {
            const app = getCurrentApp();
            const handler = createWebSocketUpgradeHandler({
                wsPath: options.wsPath,
                wsServer: this.wsServer,
                verifyClient: this.verifyClient
            });
            this.cleanupUpgradeHandler = app.http.registerUpgradeHandler(handler);
        }

        this.inactivityCheckInterval = setInterval(() => this.terminateInactiveStreams(), 15_000);
        this.inactivityCheckInterval.unref?.();
        this.logger.info('WebSocket server listening', { path: options.wsPath });
    }

    private readonly verifyClient = (
        info: { origin: string; secure: boolean; req: IncomingMessage },
        cb: (res: boolean, code?: number, message?: string) => void
    ) => {
        const url = new URL(info.req.url ?? '', 'http://localhost');
        const query = Object.fromEntries(url.searchParams.entries());
        const { id: clientStreamId, cid: clientId, appv: appVersion } = query;
        const address = this.getRemoteAddress(info.req);

        if (!clientStreamId || !clientId || !appVersion) {
            cb(false, 400, 'Missing required query parameters');
            return;
        }

        this.validateClientAuth(query, info.req).then(
            result => {
                if (!result) {
                    cb(false, 403, 'Failed authentication');
                    return;
                }

                const queryMeta = Object.fromEntries(
                    Object.entries(query)
                        .filter(([key]) => key.startsWith('m--'))
                        .map(([key, value]) => [key.slice(3), value])
                );
                const authMeta = result === true ? {} : result;
                (info.req as IncomingMessage & { [StreamInfoSymbol]?: StreamInfo })[StreamInfoSymbol] = {
                    clientStreamId,
                    clientId,
                    appVersion,
                    configureTs: Number(query.ts ?? 0),
                    protocolVersion: Number(query._v ?? 1),
                    supersede: query._supersede === '1',
                    address,
                    meta: { ...queryMeta, ...authMeta }
                };
                cb(true);
            },
            error => {
                this.logger.warn('Error validating SRPC client auth', error);
                cb(false, 403, 'Failed authentication');
            }
        );
    };

    private attachConnection(ws: WebSocket, request: IncomingMessage): void {
        const info = (request as IncomingMessage & { [StreamInfoSymbol]?: StreamInfo })[StreamInfoSymbol];
        if (!info) {
            ws.close(4000, 'Missing stream info');
            return;
        }

        const stream = this.createStream(ws, info);
        ws.on('error', error => this.handleStreamError(stream, error));
        ws.on('close', code => this.handleStreamDisconnected(stream, code));

        this.handleStreamEstablished(stream);
    }

    private createStream(ws: WebSocket, info: StreamInfo): SrpcStream<TMeta> {
        const streamId = uuid7();
        const stream: SrpcStream<TMeta> = {
            $ws: ws,
            $queue: new Map<string, IQueuedRequest>(),
            id: streamId,
            clientStreamId: info.clientStreamId,
            address: info.address,
            clientId: info.clientId,
            appVersion: info.appVersion,
            configureTs: info.configureTs,
            protocolVersion: info.protocolVersion,
            supersede: info.supersede,
            meta: info.meta as TMeta,
            connectedAt: Date.now(),
            isActivated: false,
            lastPingAt: Date.now(),
            byteStream: {
                parentStreamId: streamId,
                write: (substreamId, chunk) =>
                    this.writeToStreamAsync(stream, {
                        byteStreamOperation: { streamId: substreamId, write: { chunk: chunk as Uint8Array } }
                    } as TServerOutput),
                finish: substreamId =>
                    this.writeToStream(stream, {
                        byteStreamOperation: { streamId: substreamId, finish: {} }
                    } as TServerOutput),
                destroy: (substreamId, error) =>
                    this.writeToStream(stream, {
                        byteStreamOperation: {
                            streamId: substreamId,
                            destroy: { error: error ? String(error) : undefined }
                        }
                    } as TServerOutput),
                attachDisconnectHandler: handler => ws.on('close', handler),
                detachDisconnectHandler: handler => ws.off('close', handler),
                getBufferedAmount: () => ws.bufferedAmount
            }
        };
        SrpcByteStream.init(stream, { startId: 2, step: 2 });
        return stream;
    }

    private handleStreamEstablished(stream: SrpcStream<TMeta>): void {
        const conflictingStream = this.getCurrentStreamByClientId(stream.clientId);
        if (conflictingStream) {
            if (stream.protocolVersion >= 2 && !stream.supersede) {
                stream.lastPingAt = -1;
                this.closeStreamWithError(stream, 'conflict', 'Client ID already connected');
                return;
            }
            this.cleanupStream(conflictingStream, 'supersede');
        }

        this.streamsById.set(stream.id, stream);
        this.pendingStreamsByClientId.set(stream.clientId, stream);
        this.blockedClientRequests.add(stream);
        this.postEstablishCheck(stream)
            .then(async rejected => {
                if (rejected || stream.lastPingAt < 0 || !this.isCurrentStream(stream)) return;
                stream.$ws.on('message', data => this.handleWsMessage(stream, data));
                this.writeToStream(stream, { pingPong: {} } as TServerOutput);
                await this.onStreamConnected(stream);
                if (stream.lastPingAt < 0) return;
                this.activateStream(stream);
                if (!stream.isActivated) return;
                await this.onStreamActivated(stream);
                if (stream.lastPingAt >= 0 && stream.isActivated) this.openClientRequests(stream);
            })
            .catch(error => {
                this.logger.error('SRPC connection handler failed', error);
                this.cleanupStream(stream, 'disconnect');
            });
    }

    protected postEstablishCheck(_stream: SrpcStream<TMeta>): Promise<boolean> {
        return Promise.resolve(false);
    }

    protected getCurrentStreamByClientId(clientId: string): SrpcStream<TMeta> | undefined {
        return this.pendingStreamsByClientId.get(clientId) ?? this.streamsByClientId.get(clientId);
    }

    protected isCurrentStream(stream: SrpcStream<TMeta>): boolean {
        return this.getCurrentStreamByClientId(stream.clientId) === stream;
    }

    private activateStream(stream: SrpcStream<TMeta>): void {
        if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) return;
        this.pendingStreamsByClientId.delete(stream.clientId);
        stream.isActivated = true;
        this.streamsByClientId.set(stream.clientId, stream);
        notifySrpcObservers({ type: 'connection', stream, at: Date.now() });
    }

    private handleWsMessage(stream: SrpcStream<TMeta>, data: WebSocket.RawData): void {
        try {
            const decoded = this.options.clientMessage.decode(toBuffer(data));
            this.handleStreamDataReceived(stream, decoded);
        } catch (error) {
            this.logger.warn('Failed to decode SRPC message', error);
            this.closeStreamWithError(stream, 'badArg', 'Invalid message format');
        }
    }

    private handleStreamDataReceived(stream: SrpcStream<TMeta>, data: TClientOutput): void {
        notifySrpcObservers({ type: 'message', stream, direction: 'inbound', data, at: Date.now() });
        if (data.pingPong) {
            stream.lastPingAt = Date.now();
            this.writeToStream(stream, { pingPong: {} } as TServerOutput);
            return;
        }

        if (data.byteStreamOperation) {
            this.handleByteSubstreamOperation(stream, data.byteStreamOperation);
            return;
        }

        if (!data.requestId) {
            this.closeStreamWithError(stream, 'badArg', 'Invalid request ID');
            return;
        }

        if (data.reply) {
            const queueItem = stream.$queue.get(data.requestId);
            if (!queueItem) {
                this.closeStreamWithError(stream, 'badArg', 'Unknown request ID');
                return;
            }
            stream.$queue.delete(data.requestId);
            if (data.error) queueItem.reject(new SrpcError(data.error, data.userError));
            else queueItem.resolve(data);
            return;
        }

        if (!stream.isActivated || this.blockedClientRequests.has(stream)) {
            const pending = this.pendingClientRequests.get(stream) ?? [];
            pending.push(data);
            this.pendingClientRequests.set(stream, pending);
            return;
        }

        this.handleClientRequest(stream, data.requestId, data)
            .then(response =>
                this.writeToStream(stream, {
                    requestId: data.requestId,
                    reply: true,
                    ...response
                } as TServerOutput)
            )
            .catch(error => {
                const isUserError = error instanceof SrpcError && error.isUserError;
                this.writeToStream(stream, {
                    requestId: data.requestId,
                    reply: true,
                    error: isUserError ? error.message : String(error),
                    userError: isUserError
                } as TServerOutput);
            });
    }

    private openClientRequests(stream: SrpcStream<TMeta>): void {
        this.blockedClientRequests.delete(stream);
        const pending = this.pendingClientRequests.get(stream);
        if (!pending?.length) return;

        this.pendingClientRequests.delete(stream);
        for (const message of pending) this.handleStreamDataReceived(stream, message);
    }

    private handleByteSubstreamOperation(stream: SrpcStream<TMeta>, op: NonNullable<TClientOutput['byteStreamOperation']>): void {
        if (op.write) SrpcByteStream.writeReceiver(stream, op.streamId, op.write.chunk);
        else if (op.finish) SrpcByteStream.finishReceiver(stream, op.streamId);
        else if (op.destroy) SrpcByteStream.destroySubstream(stream, op.streamId, op.destroy.error);
    }

    private async handleClientRequest(stream: SrpcStream<TMeta>, _requestId: string, message: TClientOutput): Promise<Partial<TServerOutput>> {
        for (const [key, handlerMeta] of this.streamMessageHandlers) {
            const requestData = (message as Record<string, unknown>)[key];
            if (requestData == null) continue;
            const result = await this.runMessageHandler(handlerMeta.handler, stream, requestData);
            return { [handlerMeta.resultType]: result } as Partial<TServerOutput>;
        }
        throw new Error('Unhandled message type');
    }

    protected async runMessageHandler(
        handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, unknown, unknown>,
        stream: SrpcStream<TMeta>,
        data: unknown
    ): Promise<unknown> {
        if (isSrpcMessageHandlerClass(handler)) {
            const instance = new handler() as ISrpcMessageHandler<SrpcStream<TMeta>, unknown, unknown>;
            return instance.handle(stream, data);
        }
        return handler(stream, data);
    }

    protected async onStreamConnected(stream: SrpcStream<TMeta>): Promise<void> {
        for (const handler of this.streamConnectionHandlers) await handler(stream);
    }

    protected onStreamActivated(_stream: SrpcStream<TMeta>): void | Promise<void> {}

    protected onStreamDisconnected(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause): void {
        for (const handler of this.streamDisconnectionHandlers) handler(stream, cause);
    }

    protected cleanupStream(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause = 'disconnect'): void {
        if (stream.lastPingAt < 0) return;
        stream.lastPingAt = -1;
        for (const queueItem of stream.$queue.values()) queueItem.reject(new Error('Stream disconnected'));
        stream.$queue.clear();
        this.blockedClientRequests.delete(stream);
        this.pendingClientRequests.delete(stream);
        this.streamsById.delete(stream.id);
        if (this.pendingStreamsByClientId.get(stream.clientId) === stream) this.pendingStreamsByClientId.delete(stream.clientId);
        if (this.streamsByClientId.get(stream.clientId) === stream) this.streamsByClientId.delete(stream.clientId);
        this.onStreamDisconnected(stream, cause);
        notifySrpcObservers({ type: 'disconnection', stream, cause, at: Date.now() });
        if (stream.$ws.readyState === WebSocket.OPEN || stream.$ws.readyState === WebSocket.CONNECTING) {
            stream.$ws.close(closeCodeForCause(cause), `Stream terminated with cause: ${cause}`);
        }
    }

    private handleStreamDisconnected(stream: SrpcStream<TMeta>, code?: number): void {
        this.cleanupStream(stream, causeForCloseCode(code));
    }

    private handleStreamError(stream: SrpcStream<TMeta>, error: Error): void {
        this.logger.warn('SRPC stream error', error);
        this.cleanupStream(stream);
    }

    private terminateInactiveStreams(): void {
        const deadline = Date.now() - 75_000;
        for (const stream of this.streamsById.values()) {
            if (stream.lastPingAt >= 0 && stream.lastPingAt < deadline) this.cleanupStream(stream, 'timeout');
        }
    }

    private async validateClientAuth(meta: Record<string, unknown>, request: IncomingMessage): Promise<boolean | Partial<TMeta>> {
        if (this.clientAuthorizer) return this.clientAuthorizer(meta, request);

        const authv = String(meta.authv ?? '');
        const appv = String(meta.appv ?? '');
        const ts = String(meta.ts ?? '');
        const id = String(meta.id ?? '');
        const cid = String(meta.cid ?? '');
        const signature = String(meta.signature ?? '');
        if (!authv || !appv || !ts || !id || !cid || !signature) return false;

        const tsInt = Number(ts);
        if (!Number.isFinite(tsInt)) return false;

        const config = getOptionalAppConfig();
        const driftMs = config?.SRPC_AUTH_CLOCK_DRIFT_MS ?? 30_000;
        if (Math.abs(Date.now() - tsInt) > driftMs) return false;

        const clientKey = await this.fetchClientKey(cid);
        if (clientKey === false) return false;

        const computedSignature = createHmac('sha256', clientKey).update(`${authv}\n${appv}\n${ts}\n${id}\n${cid}\n`).digest('hex');
        const signatureBuffer = Buffer.from(signature);
        const computedBuffer = Buffer.from(computedSignature);
        return signatureBuffer.length === computedBuffer.length && timingSafeEqual(signatureBuffer, computedBuffer);
    }

    private async fetchClientKey(clientId: string): Promise<false | string> {
        if (this.clientKeyFetcher) return this.clientKeyFetcher(clientId);
        const key = getCurrentApp().config.SRPC_AUTH_SECRET;
        if (!key) throw new Error('SRPC_AUTH_SECRET is not configured.');
        return key;
    }

    private getRemoteAddress(request: IncomingMessage): string {
        const config = getOptionalAppConfig();
        const realIp = request.headers['x-real-ip'];
        if (config?.USE_REAL_IP_HEADER && typeof realIp === 'string') return realIp;
        return request.socket.remoteAddress ?? '127.0.0.1';
    }

    private writeToStream(stream: SrpcStream<TMeta>, data: TServerOutput): boolean {
        if (stream.$ws.readyState !== WebSocket.OPEN) return false;
        stream.$ws.send(encodeSrpcMessage(this.options.serverMessage, data));
        notifySrpcObservers({ type: 'message', stream, direction: 'outbound', data, at: Date.now() });
        return true;
    }

    private writeToStreamAsync(stream: SrpcStream<TMeta>, data: TServerOutput): Promise<void> {
        if (stream.$ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Failed to send SRPC message: not connected'));
        const encoded = encodeSrpcMessage(this.options.serverMessage, data);
        return new Promise((resolve, reject) => {
            stream.$ws.send(encoded, error => {
                if (error) reject(error);
                else {
                    notifySrpcObservers({
                        type: 'message',
                        stream,
                        direction: 'outbound',
                        data,
                        at: Date.now()
                    });
                    resolve();
                }
            });
        });
    }

    private closeStreamWithError(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause, message: string): void {
        stream.$ws.close(closeCodeForCause(cause), message.slice(0, 123));
    }

    setClientAuthorizer(authorizer: (metadata: any, req: IncomingMessage) => Promise<boolean | Partial<TMeta>> | boolean | Partial<TMeta>): void {
        this.clientAuthorizer = authorizer;
    }

    setClientKeyFetcher(fetcher: (clientId: string) => Promise<false | string> | false | string): void {
        this.clientKeyFetcher = fetcher;
    }

    registerConnectionHandler(handler: (stream: SrpcStream<TMeta>) => void | Promise<void>): void {
        this.streamConnectionHandlers.add(handler);
    }

    registerMessageHandler<P extends InvokePrefixes<TClientOutput, TServerOutput>>(
        prefix: P,
        handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, HandlerRequestData<TClientOutput, P>, ResponseData<TServerOutput, P>>
    ): void {
        const actionType = `${prefix}Request` as RequestKeys<TClientOutput>;
        this.streamMessageHandlers.set(actionType, {
            resultType: `${prefix}Response`,
            handler: handler as TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, unknown, unknown>
        });
    }

    registerDisconnectHandler(handler: (stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause) => void): void {
        this.streamDisconnectionHandlers.add(handler);
    }

    invoke<P extends InvokePrefixes<TServerOutput, TClientOutput>>(
        stream: SrpcStream<TMeta>,
        prefix: P,
        data: RequestData<TServerOutput, P>,
        timeoutMs = 30_000
    ): Promise<ResponseData<TClientOutput, P>> {
        const requestType = `${prefix}Request`;
        const resultType = `${prefix}Response`;
        const requestId = uuid7();

        return new Promise<ResponseData<TClientOutput, P>>((resolve, reject) => {
            const timeout = setTimeout(() => {
                stream.$queue.delete(requestId);
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            stream.$queue.set(requestId, {
                exp: Date.now() + timeoutMs,
                resolve: response => {
                    clearTimeout(timeout);
                    const result = (response as Record<string, unknown>)[resultType];
                    if (result == null) reject(new Error('Invalid response from client'));
                    else resolve(result as ResponseData<TClientOutput, P>);
                },
                reject: error => {
                    clearTimeout(timeout);
                    reject(error);
                }
            });

            const sent = this.writeToStream(stream, {
                requestId,
                [requestType]: data
            } as unknown as TServerOutput);
            if (!sent) {
                stream.$queue.delete(requestId);
                clearTimeout(timeout);
                reject(new Error('Failed to send request: not connected'));
            }
        });
    }

    close(): void {
        clearInterval(this.inactivityCheckInterval);
        this.cleanupUpgradeHandler?.();
        for (const stream of [...this.streamsById.values()]) this.cleanupStream(stream);
        this.wsServer.close();
    }

    static createInvoke<TM extends SrpcMeta, TCO extends BaseMessage, TSO extends BaseMessage>(
        instanceFn: () => SrpcServer<TM, TCO, TSO>
    ): SrpcServer<TM, TCO, TSO>['invoke'] {
        return ((...args: Parameters<SrpcServer<TM, TCO, TSO>['invoke']>) => instanceFn().invoke(...args)) as SrpcServer<TM, TCO, TSO>['invoke'];
    }
}

function createLogger(logger: ISrpcLogger, logLevel: 'info' | 'debug' | false | undefined): ISrpcLogger {
    if (logLevel === false) return noopLogger;
    if (logLevel === 'debug') {
        return {
            info: logger.debug.bind(logger),
            warn: logger.warn.bind(logger),
            error: logger.error.bind(logger),
            debug: logger.debug.bind(logger)
        };
    }
    return logger;
}

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

function closeCodeForCause(cause: SrpcDisconnectCause): number {
    return { disconnect: 1000, badArg: 4000, conflict: 4001, supersede: 4002, timeout: 4003 }[cause];
}

function causeForCloseCode(code?: number): SrpcDisconnectCause {
    if (code === 4000) return 'badArg';
    if (code === 4001) return 'conflict';
    if (code === 4002) return 'supersede';
    if (code === 4003) return 'timeout';
    return 'disconnect';
}

function getOptionalAppConfig() {
    try {
        return getCurrentApp().config;
    } catch {
        return undefined;
    }
}
