import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';

import { getCurrentApp } from '../app';
import { assertSafeTimerMs, MAX_SAFE_TIMER_MS, uuid7 } from '../helpers';
import { HttpError } from '../http';
import { withLoggerContext } from '../services';
import { getTraceContext, withRemoteSpan, withSpan } from '../telemetry';
import { byteStreamDestroyReason, SrpcByteStream } from './SrpcByteStream';
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
    SrpcConnection,
    SrpcBackpressureError,
    SrpcError,
    SrpcIndeterminateDeliveryError,
    SrpcMeta,
    SrpcStream,
    TSrpcMessageHandlerFnOrClass,
    encodeSrpcMessage,
    isSrpcMessageHandlerClass,
    isValidSrpcTrace,
    serializeSrpcError,
    srpcMessageTypes
} from './types';
import { createWebSocketUpgradeHandler, installWebSocketUpgradeHandler, removeWebSocketUpgradeHandler } from '../http';

const StreamInfoSymbol = Symbol('srpc-info');
const DefaultLateReplyTombstoneTtlMs = 60_000;
const MaxLateReplyTombstonesPerStream = 256;
const DefaultMaxPendingClientRequests = 128;
const DefaultMaxInFlightClientRequests = 64;
const DefaultMaxPendingClientRequestBytes = 8 * 1024 * 1024;
const DefaultMaxInFlightClientRequestBytes = 8 * 1024 * 1024;
const DefaultMaxBufferedBytes = 8 * 1024 * 1024;
const DefaultMaxMessageBytes = 8 * 1024 * 1024;
const DefaultMaxPendingServerRequests = 128;
const DefaultMaxPendingServerRequestBytes = 8 * 1024 * 1024;
const DefaultMaxPendingHandshakes = 128;
const DefaultMaxActiveStreams = 10_000;
const DefaultMaxClientIdBytes = 1_024;
const DefaultMaxClientMetadataBytes = 64 * 1024;
const DefaultMaxAuthReplayPrincipals = 256;
const MaxBackpressuredByteStreamsPerStream = 1_024;
const MaxBackpressuredByteStreamBytesPerStream = DefaultMaxBufferedBytes;
const MaxByteStreamId = 0x7fffffff;
const MaxAuthReplayNoncesPerPrincipal = 256;

interface StreamInfo {
    clientStreamId: string;
    clientId: string;
    appVersion: string;
    configureTs: number;
    protocolVersion: 1 | 2;
    features: ReadonlySet<string>;
    supersede: boolean;
    address: string;
    meta: Record<string, unknown>;
}

class AuthenticationFailure {
    constructor(readonly reason: string) {}
}

export class SrpcServer<
    TMeta extends SrpcMeta = SrpcMeta,
    TClientOutput extends BaseMessage = BaseMessage,
    TServerOutput extends BaseMessage = BaseMessage,
    TResolvedMeta = TMeta
> {
    private readonly logger: ISrpcLogger;
    private readonly wsServer: WebSocket.Server;
    private readonly streamConnectionHandlers = new Set<(stream: SrpcStream<TMeta>) => void | Promise<void>>();
    private readonly streamDisconnectionHandlers = new Set<(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause) => void>();
    private readonly streamMessageHandlers = new Map<
        RequestKeys<TClientOutput>,
        {
            resultType: string;
            handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, unknown, unknown>;
        }
    >();
    private readonly broadcastHandlers = new Map<string, Set<(data: unknown, senderInstanceId: number) => void | Promise<void>>>();
    private readonly blockedClientRequests = new WeakSet<SrpcStream<TMeta>>();
    private readonly pendingClientRequests = new WeakMap<SrpcStream<TMeta>, Array<{ data: TClientOutput; retainedBytes: number }>>();
    private readonly pendingClientRequestBytes = new WeakMap<SrpcStream<TMeta>, number>();
    private readonly inFlightClientRequests = new WeakMap<SrpcStream<TMeta>, number>();
    private readonly inFlightClientRequestBytes = new WeakMap<SrpcStream<TMeta>, number>();
    private readonly pendingServerRequestBytes = new WeakMap<SrpcStream<TMeta>, number>();
    private readonly lateReplyTombstonesByStream = new WeakMap<SrpcStream<TMeta>, Map<string, number>>();
    private readonly backpressuredByteStreams = new WeakMap<SrpcStream<TMeta>, Set<number>>();
    private readonly backpressuredByteStreamBytes = new WeakMap<SrpcStream<TMeta>, Map<number, number>>();
    private readonly publishedStreams = new WeakSet<SrpcStream<TMeta>>();
    private readonly authReplayNoncesByPrincipal = new Map<string, Map<string, number>>();
    private authNonceConsumer?: (principal: string, nonce: string, expiresAt: number) => boolean | Promise<boolean>;
    private readonly cleanupUpgradeHandler?: () => void;
    private readonly inactivityCheckInterval: ReturnType<typeof setInterval>;
    private pendingHandshakeCount = 0;
    private clientAuthorizer?: (
        metadata: Record<string, unknown>,
        req: IncomingMessage
    ) => Promise<boolean | Partial<TMeta>> | boolean | Partial<TMeta>;
    private clientKeyFetcher?: (clientId: string) => Promise<false | string> | false | string;

    readonly streamsById = new Map<string, SrpcStream<TMeta>>();
    readonly streamsByClientId = new Map<string, SrpcStream<TMeta>>();
    protected readonly pendingStreamsByClientId = new Map<string, SrpcStream<TMeta>>();

    constructor(protected readonly options: ISrpcServerOptions<TClientOutput, TServerOutput>) {
        validateServerResourceOptions(options);
        this.logger = options.logger;
        this.wsServer = new WebSocket.Server({ noServer: true, maxPayload: this.maxMessageBytes });
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

        const protocolVersion = query._v === undefined ? this.options.defaultUnspecifiedProtocolVersion : Number(query._v);
        const handshakeLogData = {
            address: logSafeText(address),
            clientId: logSafeText(clientId),
            clientStreamId: logSafeText(clientStreamId),
            protocolVersion: Number.isSafeInteger(protocolVersion) ? protocolVersion : undefined
        };
        const rejectHandshake = (event: string, code: number, message: string, extra?: Record<string, unknown>) => {
            this.logger.warn(event, { srpc: { ...handshakeLogData, ...extra } });
            cb(false, code, safeHandshakeMessage(message));
        };
        if (!clientStreamId || !clientId || !appVersion || (protocolVersion !== 1 && protocolVersion !== 2)) {
            rejectHandshake('SRPC client missing required handshake parameters', 400, 'Missing required query parameters');
            return;
        }
        if (Buffer.byteLength(clientId) > this.maxClientIdBytes) {
            rejectHandshake('SRPC client ID exceeds the configured limit', 400, 'Client ID exceeds the configured limit');
            return;
        }
        if (this.pendingHandshakeCount >= this.maxPendingHandshakes) {
            rejectHandshake('SRPC handshake capacity exceeded', 503, 'Too many pending client handshakes', {
                pendingHandshakes: this.pendingHandshakeCount
            });
            return;
        }
        if (this.streamsById.size >= this.maxActiveStreams) {
            rejectHandshake('SRPC active-stream capacity exceeded', 503, 'Too many active client streams', { activeStreams: this.streamsById.size });
            return;
        }

        this.pendingHandshakeCount++;
        this.validateClientAuth(query, info.req)
            .then(
                result => {
                    if (!result || result instanceof AuthenticationFailure) {
                        rejectHandshake('SRPC client authentication failed', 403, 'Failed authentication', {
                            reason: result instanceof AuthenticationFailure ? result.reason : 'custom authorizer rejected'
                        });
                        return;
                    }

                    const queryMeta = Object.fromEntries(
                        Object.entries(query)
                            .filter(([key]) => key.startsWith('m--'))
                            .map(([key, value]) => [key.slice(3), value])
                    );
                    const authMeta = result === true ? {} : result;
                    const mergedMeta = { ...queryMeta, ...authMeta };
                    let metadataBytes: number;
                    try {
                        metadataBytes = encodedJsonBytes(mergedMeta);
                    } catch {
                        rejectHandshake('SRPC client metadata is not JSON-serializable', 400, 'Client metadata must be JSON-serializable');
                        return;
                    }
                    if (metadataBytes > this.maxClientMetadataBytes) {
                        rejectHandshake('SRPC client metadata exceeds the configured limit', 400, 'Client metadata exceeds the configured limit', {
                            metadataBytes
                        });
                        return;
                    }
                    (info.req as IncomingMessage & { [StreamInfoSymbol]?: StreamInfo })[StreamInfoSymbol] = {
                        clientStreamId,
                        clientId,
                        appVersion,
                        configureTs: Number(query.ts ?? 0),
                        protocolVersion,
                        features: new Set(
                            normalizeFeatures((query._f ?? '').split(',').filter(feature => feature.length > 0))
                                .split(',')
                                .filter(Boolean)
                        ),
                        supersede: query._supersede === '1',
                        address,
                        meta: mergedMeta
                    };
                    cb(true);
                },
                error => {
                    if (error instanceof HttpError) {
                        rejectHandshake('SRPC client authorization rejected the handshake', error.httpCode, error.message, {
                            statusCode: error.httpCode,
                            message: logSafeText(error.message)
                        });
                        return;
                    }
                    this.logger.error('Error validating SRPC client auth', error, { srpc: handshakeLogData });
                    cb(false, 500, 'Error during authentication');
                }
            )
            .finally(() => {
                this.pendingHandshakeCount = Math.max(0, this.pendingHandshakeCount - 1);
            });
    };

    private attachConnection(ws: WebSocket, request: IncomingMessage): void {
        const info = (request as IncomingMessage & { [StreamInfoSymbol]?: StreamInfo })[StreamInfoSymbol];
        if (!info) {
            this.logger.warn('SRPC WebSocket connection is missing verified stream information');
            ws.close(4000, 'Missing stream info');
            return;
        }
        if (this.streamsById.size >= this.maxActiveStreams) {
            this.logger.warn('SRPC active-stream capacity exceeded after handshake', {
                srpc: {
                    address: logSafeText(info.address),
                    clientId: logSafeText(info.clientId),
                    clientStreamId: logSafeText(info.clientStreamId),
                    activeStreams: this.streamsById.size
                }
            });
            ws.close(1013, 'Too many active client streams');
            return;
        }

        const stream = this.createStream(ws, info);
        this.logger.info('SRPC WebSocket connection accepted', {
            srpc: streamLogData(stream)
        });
        ws.on('error', error => this.handleStreamError(stream, error));
        ws.on('close', (code, reason) => this.handleStreamDisconnected(stream, code, reason));

        this.handleStreamEstablished(stream);
    }

    private createStream(ws: WebSocket, info: StreamInfo): SrpcStream<TMeta> {
        const streamId = uuid7();
        const thisServer = this;
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
            features: info.features,
            supersede: info.supersede,
            meta: info.meta as TMeta,
            connectedAt: Date.now(),
            isActivated: false,
            lastPingAt: Date.now(),
            get connected() {
                return stream.lastPingAt >= 0 && thisServer.isCurrentStream(stream) && ws.readyState === WebSocket.OPEN;
            },
            close: async reason => this.closeStreamGracefully(stream, reason),
            byteStream: {
                parentStreamId: streamId,
                remoteSenderIdParity: 1,
                write: (substreamId, chunk) =>
                    this.writeToStreamAsync(stream, {
                        byteStreamOperation: {
                            streamId: substreamId,
                            write: { chunk: new Uint8Array(chunk as ArrayLike<number>) }
                        }
                    } as TServerOutput),
                finish: substreamId =>
                    this.writeToStream(stream, {
                        byteStreamOperation: { streamId: substreamId, finish: {} }
                    } as TServerOutput),
                destroy: (substreamId, error) =>
                    this.writeToStream(stream, {
                        byteStreamOperation: {
                            streamId: substreamId,
                            destroy: { error: byteStreamDestroyReason(error) }
                        }
                    } as TServerOutput),
                receiverBufferChanged: (substreamId, bufferedBytes) => {
                    this.updateByteStreamBufferedBytes(stream, substreamId, bufferedBytes);
                },
                logDebug: (message, data) => this.logger?.debug(message, { srpc: { ...streamLogData(stream), ...data } }),
                attachDisconnectHandler: handler => ws.on('close', handler),
                detachDisconnectHandler: handler => ws.off('close', handler),
                getBufferedAmount: () => ws.bufferedAmount
            },
            resolveByteStream: () => {
                if (!this.isStreamDispatchAvailable(stream)) throw new Error('SRPC stream generation is revoked');
                return stream.byteStream;
            }
        };
        SrpcByteStream.init(stream, { startId: 2, step: 2 });
        return stream;
    }

    private handleStreamEstablished(stream: SrpcStream<TMeta>): void {
        const conflictingStream = this.getCurrentStreamByClientId(stream.clientId);
        if (conflictingStream) {
            if (stream.protocolVersion >= 2 && !stream.supersede) {
                this.logger.warn('SRPC client connection rejected because its client ID is already active', {
                    srpc: {
                        ...streamLogData(stream),
                        existingStreamId: logSafeText(conflictingStream.id),
                        protocolVersion: stream.protocolVersion
                    }
                });
                this.closeStreamWithError(stream, 'conflict', 'Client ID already connected');
                return;
            }
            this.logger.warn('SRPC stream superseding an existing client connection', {
                srpc: { ...streamLogData(stream), supersededStreamId: logSafeText(conflictingStream.id) }
            });
            this.cleanupStream(conflictingStream, 'supersede');
        }

        this.streamsById.set(stream.id, stream);
        this.pendingStreamsByClientId.set(stream.clientId, stream);
        this.blockedClientRequests.add(stream);
        this.postEstablishCheck(stream)
            .then(async rejected => {
                if (rejected || stream.lastPingAt < 0 || !this.isCurrentStream(stream)) return;
                // The protocol listener is installed before user callbacks. A
                // throwing callback therefore cannot leave a live socket without
                // a message consumer.
                stream.$ws.on('message', data => this.handleWsMessage(stream, data));
                if (!this.writeToStream(stream, { pingPong: {} } as TServerOutput)) {
                    this.cleanupStream(stream, 'disconnect');
                    return;
                }
                await this.onStreamWillActivate(stream);
                if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) return;
                await this.onStreamConnected(stream);
                if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) return;
                this.activateStream(stream);
                if (!stream.isActivated) return;
                if (!this.writeToStream(stream, { pingPong: {} } as TServerOutput)) {
                    this.cleanupStream(stream, 'disconnect');
                    return;
                }
                await this.onStreamActivated(stream);
                if (stream.lastPingAt >= 0 && stream.isActivated) {
                    this.logger.info('SRPC stream activated', { srpc: streamLogData(stream) });
                    this.openClientRequests(stream);
                }
            })
            .catch(error => {
                this.logger.error('SRPC connection handler failed', error, { srpc: streamLogData(stream) });
                this.cleanupStream(stream, 'disconnect');
            });
    }

    protected postEstablishCheck(_stream: SrpcStream<TMeta>): Promise<boolean> {
        return Promise.resolve(false);
    }

    /**
     * Hook for private/cluster CAS work after the initial protocol frame is
     * queued but before user connection handlers and public local publication.
     */
    protected onStreamWillActivate(_stream: SrpcStream<TMeta>): void | Promise<void> {}

    /**
     * Allows a transport extension to recognize a locally-owned sender whose
     * state is maintained outside the core SrpcByteStream sender map.
     * Core remains strict by default.
     */
    protected hasExternalByteStreamSender(_stream: SrpcStream<TMeta>, _streamId: number): boolean {
        return false;
    }

    protected getCurrentStreamByClientId(clientId: string): SrpcStream<TMeta> | undefined {
        return this.pendingStreamsByClientId.get(clientId) ?? this.streamsByClientId.get(clientId);
    }

    protected isCurrentStream(stream: SrpcStream<TMeta>): boolean {
        // Lightweight embedders and focused unit tests may invoke the protocol
        // methods without the registry layer; normal servers always have both.
        if (!this.pendingStreamsByClientId || !this.streamsByClientId) return true;
        return this.getCurrentStreamByClientId(stream.clientId) === stream;
    }

    private activateStream(stream: SrpcStream<TMeta>): void {
        if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) return;
        this.pendingStreamsByClientId.delete(stream.clientId);
        stream.isActivated = true;
        this.streamsByClientId.set(stream.clientId, stream);
        this.publishedStreams.add(stream);
        notifySrpcObservers({ type: 'connection', stream, at: Date.now() });
    }

    private handleWsMessage(stream: SrpcStream<TMeta>, data: WebSocket.RawData): void {
        if (!this.isStreamDispatchAvailable(stream)) return;
        try {
            const encoded = toBuffer(data);
            const decoded = this.options.clientMessage.decode(encoded);
            this.handleStreamDataReceived(stream, decoded, encoded.length);
        } catch (error) {
            this.logger.warn('Failed to decode SRPC message', error, { srpc: streamLogData(stream) });
            this.closeStreamWithError(stream, 'badArg', 'Invalid message format');
        }
    }

    private handleStreamDataReceived(stream: SrpcStream<TMeta>, data: TClientOutput, retainedBytes = estimateMessageBytes(data)): void {
        if (!this.isStreamDispatchAvailable(stream)) return;
        notifySrpcObservers({ type: 'message', stream, direction: 'inbound', data, at: Date.now() });
        this.logTraffic(stream, 'inbound', data);
        if (data.pingPong) {
            stream.lastPingAt = Date.now();
            // The initial ping establishes frame ordering before activation.
            // Modern clients reserve the next server ping as their activation
            // acknowledgement, so an early client pong is not echoed.
            if (stream.isActivated) this.writeToStream(stream, { pingPong: {} } as TServerOutput);
            return;
        }

        if (data.byteStreamOperation) {
            if (!this.validRemoteByteStreamOperation(stream, data.byteStreamOperation)) {
                this.closeStreamWithError(stream, 'badArg', 'Invalid byte stream ID');
                return;
            }
            this.handleByteSubstreamOperation(stream, data.byteStreamOperation, data.requestId);
            return;
        }

        if (!data.requestId) {
            this.closeStreamWithError(stream, 'badArg', 'Invalid request ID');
            return;
        }

        if (data.reply) {
            const queueItem = stream.$queue.get(data.requestId);
            if (!queueItem) {
                if (this.isLateReply(stream, data.requestId)) {
                    this.logger.debug('Ignoring reply for an expired request', { requestId: logSafeText(data.requestId) });
                    return;
                }
                this.closeStreamWithError(stream, 'badArg', 'Unknown request ID');
                return;
            }
            stream.$queue.delete(data.requestId);
            if (data.error !== undefined) queueItem.reject(new SrpcError(data.error, data.userError));
            else queueItem.resolve(data);
            return;
        }

        if (!stream.isActivated || this.blockedClientRequests.has(stream)) {
            const pending = this.pendingClientRequests.get(stream) ?? [];
            if (pending.length >= this.maxPendingClientRequests) {
                this.closeStreamWithError(stream, 'badArg', 'Too many pending client requests');
                return;
            }
            if ((this.pendingClientRequestBytes.get(stream) ?? 0) + retainedBytes > this.maxPendingClientRequestBytes) {
                this.closeStreamWithError(stream, 'badArg', 'Too many pending client request bytes');
                return;
            }
            pending.push({ data, retainedBytes });
            this.pendingClientRequests.set(stream, pending);
            this.pendingClientRequestBytes.set(stream, (this.pendingClientRequestBytes.get(stream) ?? 0) + retainedBytes);
            this.logger?.debug('Queueing SRPC client request before stream activation', {
                srpc: { ...streamLogData(stream), requestId: logSafeText(data.requestId), queuedRequests: pending.length }
            });
            return;
        }

        const inFlight = this.inFlightClientRequests.get(stream) ?? 0;
        if (inFlight >= this.maxInFlightClientRequests) {
            this.closeStreamWithError(stream, 'badArg', 'Too many in-flight client requests');
            return;
        }
        if ((this.inFlightClientRequestBytes.get(stream) ?? 0) + retainedBytes > this.maxInFlightClientRequestBytes) {
            this.closeStreamWithError(stream, 'badArg', 'Too many in-flight client request bytes');
            return;
        }
        this.inFlightClientRequests.set(stream, inFlight + 1);
        this.inFlightClientRequestBytes.set(stream, (this.inFlightClientRequestBytes.get(stream) ?? 0) + retainedBytes);
        this.handleClientRequest(stream, data.requestId, data)
            .then(response =>
                this.writeToStream(stream, {
                    requestId: data.requestId,
                    reply: true,
                    ...response
                } as TServerOutput)
            )
            .catch(error => {
                this.writeToStream(stream, {
                    requestId: data.requestId,
                    reply: true,
                    ...serializeSrpcError(error)
                } as TServerOutput);
            })
            .finally(() => {
                const remaining = (this.inFlightClientRequests.get(stream) ?? 1) - 1;
                if (remaining > 0) this.inFlightClientRequests.set(stream, remaining);
                else this.inFlightClientRequests.delete(stream);
                const remainingBytes = Math.max(0, (this.inFlightClientRequestBytes.get(stream) ?? retainedBytes) - retainedBytes);
                if (remainingBytes) this.inFlightClientRequestBytes.set(stream, remainingBytes);
                else this.inFlightClientRequestBytes.delete(stream);
            });
    }

    private openClientRequests(stream: SrpcStream<TMeta>): void {
        this.blockedClientRequests.delete(stream);
        const pending = this.pendingClientRequests.get(stream);
        if (!pending?.length) return;

        this.pendingClientRequests.delete(stream);
        // The pending accounting is deliberately cleared only after removing the
        // retained queue; activated request accounting starts from each message's
        // decoded size and cannot inherit stale pre-activation totals.
        this.pendingClientRequestBytes.delete(stream);
        for (const message of pending) this.handleStreamDataReceived(stream, message.data, message.retainedBytes);
    }

    protected handleByteSubstreamOperation(
        stream: SrpcStream<TMeta>,
        op: NonNullable<TClientOutput['byteStreamOperation']>,
        requestId?: string
    ): void {
        if (op.destroy != null && SrpcByteStream.consumeTerminalSender(stream, op.streamId)) return;
        if (op.write != null) {
            const backpressured = this.backpressuredByteStreams.get(stream);
            const wasBackpressured = backpressured?.has(op.streamId) ?? false;
            const accepted = SrpcByteStream.writeReceiver(stream, op.streamId, op.write.chunk);
            this.updateByteStreamBufferedBytes(stream, op.streamId, SrpcByteStream.getReceiverBufferedBytes(stream, op.streamId));
            if (!accepted) {
                if (wasBackpressured) {
                    this.logger?.warn('SRPC byte-stream receiver is not draining', { srpc: { ...streamLogData(stream), byteStreamId: op.streamId } });
                    SrpcByteStream.abortReceiver(stream, op.streamId, new Error(`SRPC byte stream ${op.streamId} receiver is not draining`));
                    this.clearByteStreamState(stream, op.streamId);
                    return;
                }
                const ids = backpressured ?? new Set<number>();
                if (ids.size >= MaxBackpressuredByteStreamsPerStream) {
                    this.logger?.warn('SRPC stream has too many backpressured byte streams', {
                        srpc: { ...streamLogData(stream), byteStreamId: op.streamId, backpressuredStreams: ids.size }
                    });
                    SrpcByteStream.abortReceiver(stream, op.streamId, new Error('Too many backpressured SRPC byte streams'));
                    this.clearByteStreamState(stream, op.streamId);
                    return;
                }
                ids.add(op.streamId);
                this.backpressuredByteStreams.set(stream, ids);
            } else if (wasBackpressured) {
                this.clearByteStreamBackpressureFlag(stream, op.streamId);
            }
            if (this.totalBackpressuredByteStreamBytes(stream) > MaxBackpressuredByteStreamBytesPerStream) {
                this.logger?.warn('SRPC stream byte-stream buffer limit exceeded', {
                    srpc: { ...streamLogData(stream), byteStreamId: op.streamId, bufferedBytes: this.totalBackpressuredByteStreamBytes(stream) }
                });
                SrpcByteStream.abortReceiver(stream, op.streamId, new Error('Too many buffered SRPC byte stream bytes'));
                this.clearByteStreamState(stream, op.streamId);
            }
        } else if (op.finish != null) {
            this.clearByteStreamBackpressureFlag(stream, op.streamId);
            SrpcByteStream.finishReceiver(stream, op.streamId);
        } else if (op.destroy != null) {
            this.clearByteStreamState(stream, op.streamId);
            SrpcByteStream.destroySubstream(stream, op.streamId, op.destroy.error);
        }
    }

    private clearByteStreamBackpressureFlag(stream: SrpcStream<TMeta>, streamId: number): void {
        const ids = this.backpressuredByteStreams.get(stream);
        if (!ids) return;
        ids.delete(streamId);
        if (!ids.size) this.backpressuredByteStreams.delete(stream);
    }

    private clearByteStreamState(stream: SrpcStream<TMeta>, streamId: number): void {
        this.clearByteStreamBackpressureFlag(stream, streamId);
        this.updateByteStreamBufferedBytes(stream, streamId, 0);
    }

    private updateByteStreamBufferedBytes(stream: SrpcStream<TMeta>, streamId: number, bufferedBytes: number): void {
        const bytes = this.backpressuredByteStreamBytes.get(stream);
        const previousBytes = bytes?.get(streamId) ?? 0;
        if (bufferedBytes < previousBytes) this.clearByteStreamBackpressureFlag(stream, streamId);
        if (bufferedBytes <= 0) {
            if (!bytes) return;
            bytes.delete(streamId);
            if (!bytes.size) this.backpressuredByteStreamBytes.delete(stream);
            return;
        }
        const next = bytes ?? new Map<number, number>();
        next.set(streamId, bufferedBytes);
        this.backpressuredByteStreamBytes.set(stream, next);
    }

    private totalBackpressuredByteStreamBytes(stream: SrpcStream<TMeta>): number {
        let total = 0;
        for (const bytes of this.backpressuredByteStreamBytes.get(stream)?.values() ?? []) total += bytes;
        return total;
    }

    private async handleClientRequest(stream: SrpcStream<TMeta>, _requestId: string, message: TClientOutput): Promise<Partial<TServerOutput>> {
        for (const [key, handlerMeta] of this.streamMessageHandlers) {
            const requestData = (message as Record<string, unknown>)[key];
            if (requestData == null) continue;
            const trace = isValidSrpcTrace(message.trace) ? message.trace : undefined;
            const logMeta = { ...streamLogData(stream), requestId: logSafeText(_requestId), requestType: key, traceId: trace?.traceId };
            return withRemoteSpan('srpc:handleClientRequest', trace, logMeta, () =>
                withLoggerContext({ srpc: logMeta }, async () => {
                    try {
                        this.logger?.info('SRPC client request received');
                        const result = await this.runMessageHandler(handlerMeta.handler, stream, requestData);
                        this.logger?.info('SRPC client request processed');
                        return { [handlerMeta.resultType]: result } as Partial<TServerOutput>;
                    } catch (error) {
                        if (error instanceof SrpcError && error.isUserError) {
                            this.logger?.info('SRPC client request returned a user error', {
                                srpc: { ...logMeta, error: logSafeText(error.message) }
                            });
                        } else {
                            this.logger?.warn('SRPC client request failed', error);
                        }
                        throw error;
                    }
                })
            );
        }
        this.logger?.warn('Unhandled SRPC client message type', { srpc: { ...streamLogData(stream), requestId: logSafeText(_requestId) } });
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
        if (!this.publishedStreams?.has(stream)) return;
        for (const handler of this.streamDisconnectionHandlers) {
            try {
                handler(stream, cause);
            } catch (error) {
                this.logger.error('SRPC disconnect handler failed', error, { srpc: { ...streamLogData(stream), cause } });
            }
        }
    }

    private revokeStream(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause, remoteClose?: { code?: number; reason?: string }): boolean {
        if (stream.lastPingAt < 0) return false;
        stream.lastPingAt = -1;
        for (const queueItem of stream.$queue?.values() ?? []) {
            queueItem.reject(new SrpcIndeterminateDeliveryError(stream.clientId, new Error('Stream disconnected')));
        }
        stream.$queue?.clear();
        this.blockedClientRequests?.delete(stream);
        this.pendingClientRequests?.delete(stream);
        this.pendingClientRequestBytes?.delete(stream);
        this.inFlightClientRequests?.delete(stream);
        this.inFlightClientRequestBytes?.delete(stream);
        this.pendingServerRequestBytes?.delete(stream);
        this.backpressuredByteStreams?.delete(stream);
        this.backpressuredByteStreamBytes?.delete(stream);
        this.streamsById?.delete(stream.id);
        if (this.pendingStreamsByClientId?.get(stream.clientId) === stream) this.pendingStreamsByClientId.delete(stream.clientId);
        if (this.streamsByClientId?.get(stream.clientId) === stream) this.streamsByClientId.delete(stream.clientId);
        const wasPublished = this.publishedStreams?.has(stream) ?? false;
        const disconnectLogData = { ...streamLogData(stream), cause, ...remoteClose };
        this.logger?.info('SRPC stream disconnected', { srpc: disconnectLogData });
        try {
            this.onStreamDisconnected(stream, cause);
        } catch (error) {
            this.logger.error('SRPC disconnect callback failed', error, { srpc: disconnectLogData });
        }
        if (wasPublished) {
            try {
                notifySrpcObservers({ type: 'disconnection', stream, cause, at: Date.now() });
            } catch (error) {
                this.logger.error('SRPC observer failed', error, { srpc: disconnectLogData });
            }
            this.publishedStreams.delete(stream);
        }
        return true;
    }

    protected cleanupStream(
        stream: SrpcStream<TMeta>,
        cause: SrpcDisconnectCause = 'disconnect',
        remoteClose?: { code?: number; reason?: string }
    ): void {
        if (!this.revokeStream(stream, cause, remoteClose)) return;
        if (stream.$ws.readyState === WebSocket.OPEN || stream.$ws.readyState === WebSocket.CONNECTING) {
            stream.$ws.close(closeCodeForCause(cause), `Stream terminated with cause: ${cause}`);
        }
    }

    private closeStreamGracefully(stream: SrpcStream<TMeta>, reason?: string): void {
        const closeReason = reason
            ? logSafeText(reason, 123) || 'Stream terminated with cause: disconnect'
            : 'Stream terminated with cause: disconnect';
        if (!this.revokeStream(stream, 'disconnect', { code: 1000, reason: closeReason })) return;
        if (stream.$ws.readyState === WebSocket.OPEN || stream.$ws.readyState === WebSocket.CONNECTING) {
            stream.$ws.close(1000, closeReason);
        }
    }

    private handleStreamDisconnected(stream: SrpcStream<TMeta>, code?: number, reason?: Buffer): void {
        this.cleanupStream(stream, causeForCloseCode(code), {
            code,
            reason: reason ? logSafeText(reason.toString('utf8'), 123) : undefined
        });
    }

    private handleStreamError(stream: SrpcStream<TMeta>, error: Error): void {
        this.logger.warn('SRPC stream error', error, { srpc: streamLogData(stream) });
        this.cleanupStream(stream);
    }

    private terminateInactiveStreams(): void {
        const deadline = Date.now() - 75_000;
        for (const stream of this.streamsById.values()) {
            if (stream.lastPingAt >= 0 && stream.lastPingAt < deadline) {
                this.logger.warn('Terminating inactive SRPC stream', { srpc: streamLogData(stream) });
                this.cleanupStream(stream, 'timeout');
            }
        }
    }

    private async validateClientAuth(
        meta: Record<string, unknown>,
        request: IncomingMessage
    ): Promise<true | Partial<TMeta> | AuthenticationFailure> {
        if (this.clientAuthorizer) {
            const result = await this.clientAuthorizer(meta, request);
            return result === false ? new AuthenticationFailure('custom authorizer rejected') : result;
        }

        const authv = String(meta.authv ?? '');
        const appv = String(meta.appv ?? '');
        const ts = String(meta.ts ?? '');
        const id = String(meta.id ?? '');
        const cid = String(meta.cid ?? '');
        const signature = String(meta.signature ?? '');
        if (!authv || !appv || !ts || !id || !cid || !signature) return new AuthenticationFailure('missing required credentials');

        const tsInt = Number(ts);
        if (!Number.isFinite(tsInt)) return new AuthenticationFailure('invalid timestamp');

        const config = getOptionalAppConfig();
        const driftMs = config?.SRPC_AUTH_CLOCK_DRIFT_MS ?? 30_000;
        if (!Number.isSafeInteger(driftMs) || driftMs <= 0 || driftMs > MAX_SAFE_TIMER_MS)
            return new AuthenticationFailure('invalid server clock-drift configuration');
        if (Math.abs(Date.now() - tsInt) > driftMs) return new AuthenticationFailure('expired timestamp');

        if (authv !== '2') return new AuthenticationFailure('unsupported auth version');
        if (!isAuthToken(meta.nonce) || !meta.aud || !Number.isSafeInteger(Number(meta._v)) || Number(meta._v) !== 2)
            return new AuthenticationFailure('invalid protocol credentials');

        const clientKey = await this.fetchClientKey(cid);
        if (clientKey === false) return new AuthenticationFailure('unknown client key');

        const url = new URL(request.url ?? '', 'http://localhost');
        const metadata = normalizeMetadata(
            Object.fromEntries(
                Object.entries(meta)
                    .filter(([key]) => key.startsWith('m--'))
                    .map(([key, value]) => [key.slice(3), String(value)])
            )
        );
        const features = normalizeFeatures(
            String(meta._f ?? '')
                .split(',')
                .filter(Boolean)
        );
        const supersede = meta._supersede === '1' ? '1' : '0';
        const computedSignature = createHmac('sha256', clientKey)
            .update(
                canonicalAuthV2({
                    path: url.pathname,
                    audience: String(meta.aud),
                    appv,
                    ts,
                    nonce: String(meta.nonce),
                    id,
                    cid,
                    protocol: String(meta._v),
                    supersede,
                    features,
                    metadata
                })
            )
            .digest('hex');
        const signatureBuffer = Buffer.from(signature);
        const computedBuffer = Buffer.from(computedSignature);
        if (signatureBuffer.length !== computedBuffer.length || !timingSafeEqual(signatureBuffer, computedBuffer))
            return new AuthenticationFailure('invalid signature');
        if (String(meta.aud) !== (this.options.authAudience ?? url.pathname)) return new AuthenticationFailure('invalid audience');
        const nonce = String(meta.nonce);
        const expiresAt = tsInt + driftMs;
        if (this.isLocalAuthNonceReplay(cid, nonce)) return new AuthenticationFailure('replayed nonce');
        if (this.authNonceConsumer) {
            if (!(await this.authNonceConsumer(cid, nonce, expiresAt))) return new AuthenticationFailure('replayed nonce');
            // The shared consumer is authoritative under saturation. Keep the
            // local duplicate fast path bounded by evicting its least-recent
            // principal/nonce entries instead of imposing a service-wide CID cap.
            if (!this.consumeLocalAuthNonce(cid, nonce, expiresAt, true)) return new AuthenticationFailure('replayed nonce');
        } else if (!this.consumeLocalAuthNonce(cid, nonce, expiresAt, false)) {
            return new AuthenticationFailure('replay cache capacity exceeded');
        }
        return true;
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

    protected writeToStream(stream: SrpcStream<TMeta>, data: TServerOutput): boolean {
        if (!this.isStreamDispatchAvailable(stream) || stream.$ws.readyState !== WebSocket.OPEN) return false;
        const encoded = encodeSrpcMessage(this.options.serverMessage, data);
        return this.writeEncodedToStream(stream, data, encoded);
    }

    private writeEncodedToStream(stream: SrpcStream<TMeta>, data: TServerOutput, encoded: Buffer): boolean {
        if (!this.isStreamDispatchAvailable(stream) || stream.$ws.readyState !== WebSocket.OPEN) return false;
        if (!this.canWriteToStream(stream, encoded.byteLength)) return false;
        try {
            stream.$ws.send(encoded);
        } catch (error) {
            this.logger.warn('Failed to send SRPC response', error, { srpc: streamLogData(stream) });
            this.closeStreamWithError(stream, 'badArg', 'Failed to send response');
            return false;
        }
        notifySrpcObservers({ type: 'message', stream, direction: 'outbound', data, at: Date.now() });
        this.logTraffic(stream, 'outbound', data);
        return true;
    }

    protected writeToStreamAsync(stream: SrpcStream<TMeta>, data: TServerOutput): Promise<void> {
        if (!this.isStreamDispatchAvailable(stream) || stream.$ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Failed to send SRPC message: not connected'));
        }
        const encoded = encodeSrpcMessage(this.options.serverMessage, data);
        if (!this.canWriteToStream(stream, encoded.byteLength))
            return Promise.reject(new SrpcBackpressureError('sRPC stream outgoing buffer limit exceeded'));
        return new Promise((resolve, reject) => {
            try {
                stream.$ws.send(encoded, error => {
                    if (error) {
                        this.logger.warn('Failed to send SRPC response', error, { srpc: streamLogData(stream) });
                        this.closeStreamWithError(stream, 'badArg', 'Failed to send response');
                        reject(error);
                    } else if (!this.isStreamDispatchAvailable(stream)) reject(new Error('Failed to send SRPC message: stream revoked'));
                    else {
                        notifySrpcObservers({
                            type: 'message',
                            stream,
                            direction: 'outbound',
                            data,
                            at: Date.now()
                        });
                        this.logTraffic(stream, 'outbound', data);
                        resolve();
                    }
                });
            } catch (error) {
                this.logger.warn('Failed to send SRPC response', error, { srpc: streamLogData(stream) });
                this.closeStreamWithError(stream, 'badArg', 'Failed to send response');
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private logTraffic(stream: SrpcStream<TMeta>, direction: 'inbound' | 'outbound', message: BaseMessage): void {
        const options = this.options.logTraffic;
        if (!options) return;
        const bodies = typeof options === 'object' && options.bodies === true;
        this.logger.info('SRPC traffic', {
            direction,
            streamId: logSafeText(stream.id),
            clientId: logSafeText(stream.clientId),
            messageTypes: srpcMessageTypes(message),
            ...(bodies ? { body: message } : {})
        });
    }

    private canWriteToStream(stream: SrpcStream<TMeta>, bytes: number): boolean {
        if (!this.isStreamDispatchAvailable(stream)) return false;
        if (bytes > this.maxMessageBytes) {
            this.closeStreamWithError(stream, 'badArg', 'sRPC stream outgoing message limit exceeded');
            return false;
        }
        if ((stream.$ws.bufferedAmount ?? 0) + bytes <= this.maxBufferedBytes) return true;
        this.closeStreamWithError(stream, 'badArg', 'sRPC stream outgoing buffer limit exceeded');
        return false;
    }

    private closeStreamWithError(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause, message: string): void {
        this.logger?.warn('Closing SRPC stream due to a protocol or transport error', { srpc: { ...streamLogData(stream), cause, message } });
        if (!this.revokeStream(stream, cause)) return;
        stream.$ws.close(closeCodeForCause(cause), message.slice(0, 123));
    }

    private isStreamDispatchAvailable(stream: SrpcStream<TMeta>): boolean {
        return !(stream.lastPingAt < 0) && this.isCurrentStream(stream);
    }

    setClientAuthorizer(
        authorizer: (metadata: Record<string, unknown>, req: IncomingMessage) => Promise<boolean | Partial<TMeta>> | boolean | Partial<TMeta>
    ): void {
        this.clientAuthorizer = authorizer;
    }

    setClientKeyFetcher(fetcher: (clientId: string) => Promise<false | string> | false | string): void {
        this.clientKeyFetcher = fetcher;
    }

    /**
     * Installs an atomic service-wide auth-v2 nonce consumer. It must return
     * true only for the first `(principal, nonce)` consumption through
     * `expiresAt`; false rejects a replay. Core retains its fair local guard.
     */
    setAuthNonceConsumer(consumer: (principal: string, nonce: string, expiresAt: number) => boolean | Promise<boolean>): void {
        this.authNonceConsumer = consumer;
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerBroadcastHandler(type: string, handler: (data: any, senderInstanceId: number) => void | Promise<void>): void {
        const handlers = this.broadcastHandlers.get(type) ?? new Set();
        handlers.add(handler as (data: unknown, senderInstanceId: number) => void | Promise<void>);
        this.broadcastHandlers.set(type, handlers);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async broadcast(type: string, data: any, options?: { skipSelf?: boolean }): Promise<void> {
        if (options?.skipSelf) return;
        const handlers = this.broadcastHandlers.get(type);
        if (!handlers) return;
        await Promise.all([...handlers].map(handler => handler(data, 0)));
    }

    async resolveClient(clientId: string): Promise<SrpcConnection<TMeta | TResolvedMeta> | undefined> {
        return this.streamsByClientId.get(clientId);
    }

    async listClients(): Promise<SrpcConnection<TMeta | TResolvedMeta>[]> {
        return [...this.streamsByClientId.values()];
    }

    async disconnectClient(streamOrClientId: SrpcStream<TMeta> | string, reason?: string): Promise<boolean> {
        const stream = typeof streamOrClientId === 'string' ? this.streamsByClientId.get(streamOrClientId) : streamOrClientId;
        if (!stream || this.streamsById.get(stream.id) !== stream) return false;
        await stream.close(reason);
        return true;
    }

    async updateClientMetadata(streamOrClientId: SrpcStream<TMeta> | string, metadata: Partial<TMeta>): Promise<boolean> {
        const stream = typeof streamOrClientId === 'string' ? this.streamsByClientId.get(streamOrClientId) : streamOrClientId;
        if (!stream || this.streamsById.get(stream.id) !== stream) return false;
        Object.assign(stream.meta, metadata);
        return true;
    }

    invoke<P extends InvokePrefixes<TServerOutput, TClientOutput>>(
        stream: SrpcStream<TMeta>,
        prefix: P,
        data: RequestData<TServerOutput, P>,
        timeoutMs = 30_000
    ): Promise<ResponseData<TClientOutput, P>> {
        return this.invokeWithRequestId(stream, prefix, data, timeoutMs, uuid7());
    }

    protected invokeWithRequestId<P extends InvokePrefixes<TServerOutput, TClientOutput>>(
        stream: SrpcStream<TMeta>,
        prefix: P,
        data: RequestData<TServerOutput, P>,
        timeoutMs: number,
        requestId: string
    ): Promise<ResponseData<TClientOutput, P>> {
        assertTimeout(timeoutMs);
        const requestType = `${prefix}Request`;
        const resultType = `${prefix}Response`;
        if (stream.$queue.has(requestId)) return Promise.reject(new Error(`Duplicate SRPC request ID ${requestId}`));
        const spanMeta = { ...streamLogData(stream), requestId, requestType };
        return withSpan('srpc:invokeClient', spanMeta, () => {
            const trace = toWireTrace(getTraceContext());
            const logMeta = { ...spanMeta, traceId: trace?.traceId };
            return withLoggerContext({ srpc: logMeta }, async () => {
                try {
                    this.logger?.info('Requesting SRPC client invocation');
                    const message = { requestId, trace, [requestType]: data } as unknown as TServerOutput;
                    const encoded = encodeSrpcMessage(this.options.serverMessage, message);
                    if (stream.$queue.size >= this.maxPendingServerRequests) {
                        throw new SrpcBackpressureError('Too many pending server SRPC requests');
                    }
                    if ((this.pendingServerRequestBytes.get(stream) ?? 0) + encoded.byteLength > this.maxPendingServerRequestBytes) {
                        throw new SrpcBackpressureError('Too many pending server SRPC request bytes');
                    }
                    this.pendingServerRequestBytes.set(stream, (this.pendingServerRequestBytes.get(stream) ?? 0) + encoded.byteLength);
                    let retained = true;
                    const releaseRetainedBytes = () => {
                        if (!retained) return;
                        retained = false;
                        const remaining = Math.max(0, (this.pendingServerRequestBytes.get(stream) ?? encoded.byteLength) - encoded.byteLength);
                        if (remaining) this.pendingServerRequestBytes.set(stream, remaining);
                        else this.pendingServerRequestBytes.delete(stream);
                    };

                    const response = await new Promise<unknown>((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            if (!stream.$queue.has(requestId)) return;
                            stream.$queue.delete(requestId);
                            this.addLateReplyTombstone(stream, requestId);
                            releaseRetainedBytes();
                            reject(new SrpcIndeterminateDeliveryError(stream.clientId, new Error(`Request timeout after ${timeoutMs}ms`)));
                        }, timeoutMs);

                        const queueItem: IQueuedRequest = {
                            exp: Date.now() + timeoutMs,
                            resolve: response => {
                                clearTimeout(timeout);
                                releaseRetainedBytes();
                                resolve(response);
                            },
                            reject: error => {
                                clearTimeout(timeout);
                                releaseRetainedBytes();
                                reject(error);
                            }
                        };
                        stream.$queue.set(requestId, queueItem);

                        let sent: boolean;
                        try {
                            sent = this.writeEncodedToStream(stream, message, encoded);
                        } catch (error) {
                            if (stream.$queue.get(requestId) === queueItem) stream.$queue.delete(requestId);
                            clearTimeout(timeout);
                            releaseRetainedBytes();
                            reject(error);
                            return;
                        }
                        if (!sent) {
                            stream.$queue.delete(requestId);
                            clearTimeout(timeout);
                            releaseRetainedBytes();
                            reject(new Error('Failed to send request: not connected'));
                        }
                    });
                    const result = (response as Record<string, unknown>)[resultType];
                    if (result == null) throw new Error('Invalid response from client');
                    this.logger?.info('SRPC client invocation completed');
                    return result as ResponseData<TClientOutput, P>;
                } catch (error) {
                    if (error instanceof SrpcError) {
                        this.logger?.[error.isUserError ? 'info' : 'warn']('SRPC client invocation returned a remote error', {
                            srpc: { ...logMeta, error: logSafeText(error.message), userError: error.isUserError === true }
                        });
                    } else {
                        this.logger?.warn('SRPC client invocation failed', error);
                    }
                    throw error;
                }
            });
        });
    }

    protected encodeMeshInvokeRequest(prefix: string, data: unknown): Uint8Array {
        return encodeSrpcMessage(this.options.serverMessage, { [`${prefix}Request`]: data } as unknown as TServerOutput);
    }

    protected decodeMeshInvokeRequest(prefix: string, data: Uint8Array): unknown {
        return (this.options.serverMessage.decode(data) as Record<string, unknown>)[`${prefix}Request`];
    }

    protected encodeMeshInvokeResponse(prefix: string, data: unknown): Uint8Array {
        return encodeSrpcMessage(this.options.clientMessage, { [`${prefix}Response`]: data } as unknown as TClientOutput);
    }

    protected decodeMeshInvokeResponse(prefix: string, data: Uint8Array): unknown {
        return (this.options.clientMessage.decode(data) as Record<string, unknown>)[`${prefix}Response`];
    }

    protected reserveByteStreamSenderIds(stream: SrpcStream<TMeta>, count: number): number[] {
        return SrpcByteStream.reserveSenderIds(stream, count);
    }

    protected writeByteStreamOperation(stream: SrpcStream<TMeta>, operation: NonNullable<TServerOutput['byteStreamOperation']>): Promise<void> {
        return this.writeToStreamAsync(stream, { byteStreamOperation: operation } as TServerOutput);
    }

    private addLateReplyTombstone(stream: SrpcStream<TMeta>, requestId: string): void {
        const now = Date.now();
        const tombstones = this.lateReplyTombstonesByStream.get(stream) ?? new Map<string, number>();
        this.pruneLateReplyTombstones(tombstones, now);
        tombstones.set(requestId, now + this.lateReplyTombstoneTtlMs);
        while (tombstones.size > MaxLateReplyTombstonesPerStream) {
            const oldestRequestId = tombstones.keys().next().value;
            if (oldestRequestId === undefined) break;
            tombstones.delete(oldestRequestId);
        }
        this.lateReplyTombstonesByStream.set(stream, tombstones);
    }

    private isLateReply(stream: SrpcStream<TMeta>, requestId: string): boolean {
        const tombstonesByStream = this.lateReplyTombstonesByStream;
        if (!tombstonesByStream) return false;
        const tombstones = tombstonesByStream.get(stream);
        if (!tombstones) return false;
        const now = Date.now();
        this.pruneLateReplyTombstones(tombstones, now);
        if (!tombstones.size) tombstonesByStream.delete(stream);
        return (tombstones.get(requestId) ?? 0) > now;
    }

    private pruneLateReplyTombstones(tombstones: Map<string, number>, now: number): void {
        for (const [requestId, expiresAt] of tombstones) {
            if (expiresAt <= now) tombstones.delete(requestId);
        }
    }

    private get lateReplyTombstoneTtlMs(): number {
        return configuredPositiveInteger(this.options.lateReplyTombstoneTtlMs, DefaultLateReplyTombstoneTtlMs);
    }

    private get maxPendingClientRequests(): number {
        return configuredPositiveInteger(this.options.maxPendingClientRequests, DefaultMaxPendingClientRequests);
    }

    private get maxPendingClientRequestBytes(): number {
        return configuredPositiveInteger(this.options.maxPendingClientRequestBytes, DefaultMaxPendingClientRequestBytes);
    }

    private get maxInFlightClientRequests(): number {
        return configuredPositiveInteger(this.options.maxInFlightClientRequests, DefaultMaxInFlightClientRequests);
    }

    private get maxInFlightClientRequestBytes(): number {
        return configuredPositiveInteger(this.options.maxInFlightClientRequestBytes, DefaultMaxInFlightClientRequestBytes);
    }

    private get maxBufferedBytes(): number {
        return configuredPositiveInteger(this.options.maxBufferedBytes, DefaultMaxBufferedBytes);
    }

    private get maxMessageBytes(): number {
        return configuredPositiveInteger(this.options.maxMessageBytes, DefaultMaxMessageBytes);
    }

    private get maxPendingServerRequests(): number {
        return configuredPositiveInteger(this.options.maxPendingServerRequests, DefaultMaxPendingServerRequests);
    }

    private get maxPendingServerRequestBytes(): number {
        return configuredPositiveInteger(this.options.maxPendingServerRequestBytes, DefaultMaxPendingServerRequestBytes);
    }

    private get maxPendingHandshakes(): number {
        return configuredPositiveInteger(this.options.maxPendingHandshakes, DefaultMaxPendingHandshakes);
    }

    private get maxActiveStreams(): number {
        return configuredPositiveInteger(this.options.maxActiveStreams, DefaultMaxActiveStreams);
    }

    private get maxClientIdBytes(): number {
        return configuredPositiveInteger(this.options.maxClientIdBytes, DefaultMaxClientIdBytes);
    }

    private get maxClientMetadataBytes(): number {
        return configuredPositiveInteger(this.options.maxClientMetadataBytes, DefaultMaxClientMetadataBytes);
    }

    private get maxAuthReplayPrincipals(): number {
        return configuredPositiveInteger(this.options.maxAuthReplayPrincipals, DefaultMaxAuthReplayPrincipals);
    }

    private validRemoteByteStreamOperation(stream: SrpcStream<TMeta>, op: NonNullable<TClientOutput['byteStreamOperation']>): boolean {
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
        if (hasDestroy) {
            return (
                id % 2 === 1 ||
                SrpcByteStream.hasSender(stream, id) ||
                SrpcByteStream.hasTerminalSender(stream, id) ||
                this.hasExternalByteStreamSender(stream, id)
            );
        }
        return id % 2 === 1;
    }

    private isLocalAuthNonceReplay(principal: string, nonce: string): boolean {
        const now = Date.now();
        const nonces = this.authReplayNoncesByPrincipal.get(principal);
        if (!nonces) return false;
        pruneExpiredEntries(nonces, now);
        if (!nonces.size) {
            this.authReplayNoncesByPrincipal.delete(principal);
            return false;
        }
        return (nonces.get(nonce) ?? 0) > now;
    }

    private consumeLocalAuthNonce(principal: string, nonce: string, expiresAt: number, allowEviction: boolean): boolean {
        const now = Date.now();
        if (expiresAt <= now) return false;
        let nonces = this.authReplayNoncesByPrincipal.get(principal);
        if (!nonces) {
            if (this.authReplayNoncesByPrincipal.size >= this.maxAuthReplayPrincipals) {
                for (const [candidate, candidateNonces] of this.authReplayNoncesByPrincipal) {
                    pruneExpiredEntries(candidateNonces, now);
                    if (!candidateNonces.size) this.authReplayNoncesByPrincipal.delete(candidate);
                }
            }
            if (this.authReplayNoncesByPrincipal.size >= this.maxAuthReplayPrincipals) {
                if (!allowEviction) return false;
                const oldestPrincipal = this.authReplayNoncesByPrincipal.keys().next().value;
                if (oldestPrincipal != null) this.authReplayNoncesByPrincipal.delete(oldestPrincipal);
            }
            nonces = new Map();
            this.authReplayNoncesByPrincipal.set(principal, nonces);
        }
        pruneExpiredEntries(nonces, now);
        if ((nonces.get(nonce) ?? 0) > now) return false;
        if (nonces.size >= MaxAuthReplayNoncesPerPrincipal) {
            if (!allowEviction) return false;
            const oldestNonce = nonces.keys().next().value;
            if (oldestNonce != null) nonces.delete(oldestNonce);
        }
        nonces.set(nonce, expiresAt);
        // Refresh principal insertion order so the bounded shared-authority mode
        // evicts the least recently consumed principal.
        this.authReplayNoncesByPrincipal.delete(principal);
        this.authReplayNoncesByPrincipal.set(principal, nonces);
        return true;
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

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

function configuredPositiveInteger(value: number | undefined, defaultValue: number): number {
    return value != null && Number.isSafeInteger(value) && value > 0 ? value : defaultValue;
}

function streamLogData(stream: Pick<SrpcStream, 'id' | 'clientId' | 'clientStreamId' | 'address' | 'protocolVersion'>) {
    return {
        streamId: logSafeText(stream.id),
        clientId: logSafeText(stream.clientId),
        clientStreamId: logSafeText(stream.clientStreamId),
        address: logSafeText(stream.address),
        protocolVersion: stream.protocolVersion
    };
}

function logSafeText(value: unknown, maxBytes = 256): string | undefined {
    if (typeof value !== 'string') return undefined;
    const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
    if (Buffer.byteLength(printable) <= maxBytes) return printable;
    const suffix = '…';
    const prefixBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix));
    let truncated = Buffer.from(printable).subarray(0, prefixBytes).toString('utf8');
    while (Buffer.byteLength(truncated) > prefixBytes) truncated = truncated.slice(0, -1);
    return `${truncated}${suffix}`;
}

function safeHandshakeMessage(value: string): string {
    return logSafeText(value, 123) || 'Handshake rejected';
}

function toWireTrace(traceContext: ReturnType<typeof getTraceContext>): BaseMessage['trace'] {
    if (!traceContext) return undefined;
    return {
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        traceFlags: traceContext.traceFlags
    };
}

function assertTimeout(value: number): void {
    assertSafeTimerMs(value, 'Request timeout');
}

function encodedJsonBytes(value: unknown): number {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Value must be JSON-serializable');
    return Buffer.byteLength(encoded);
}

function validateServerResourceOptions(options: ISrpcServerOptions<BaseMessage, BaseMessage>): void {
    if (
        options.defaultUnspecifiedProtocolVersion !== undefined &&
        options.defaultUnspecifiedProtocolVersion !== 1 &&
        options.defaultUnspecifiedProtocolVersion !== 2
    ) {
        throw new Error('sRPC server defaultUnspecifiedProtocolVersion must be 1 or 2');
    }
    for (const [name, value] of [
        ['maxPendingClientRequests', options.maxPendingClientRequests],
        ['maxPendingClientRequestBytes', options.maxPendingClientRequestBytes],
        ['maxInFlightClientRequests', options.maxInFlightClientRequests],
        ['maxInFlightClientRequestBytes', options.maxInFlightClientRequestBytes],
        ['maxBufferedBytes', options.maxBufferedBytes],
        ['maxMessageBytes', options.maxMessageBytes],
        ['maxPendingServerRequests', options.maxPendingServerRequests],
        ['maxPendingServerRequestBytes', options.maxPendingServerRequestBytes],
        ['maxPendingHandshakes', options.maxPendingHandshakes],
        ['maxActiveStreams', options.maxActiveStreams],
        ['maxClientIdBytes', options.maxClientIdBytes],
        ['maxClientMetadataBytes', options.maxClientMetadataBytes],
        ['maxAuthReplayPrincipals', options.maxAuthReplayPrincipals]
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
            throw new Error(`sRPC server ${name} must be a positive integer`);
        }
    }
    validateTimerOption('sRPC server lateReplyTombstoneTtlMs', options.lateReplyTombstoneTtlMs);
}

function validateTimerOption(name: string, value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_TIMER_MS)) {
        throw new Error(`${name} must be a safe positive integer between 1 and ${MAX_SAFE_TIMER_MS}`);
    }
}

function normalizeFeatures(features: string[]): string {
    return [...new Set(features)].sort().join(',');
}

function normalizeMetadata(meta: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(meta).sort(([a], [b]) => compareCodeUnits(a, b)));
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

function isAuthToken(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 16 && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value);
}

function compareCodeUnits(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pruneExpiredEntries(entries: Map<string, number>, now: number): void {
    for (const [key, expiresAt] of entries) if (expiresAt <= now) entries.delete(key);
}

function estimateMessageBytes(message: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(message));
    } catch {
        return DefaultMaxMessageBytes;
    }
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
