import type WebSocket from 'ws';

import type { ClassType } from '../types';
import type { IByteStreamable } from './SrpcByteStream';

export type RequestKeys<T> = keyof T & `${string}Request`;
export type ResponseKeys<T> = keyof T & `${string}Response`;
export type RequestPrefix<K> = K extends `${infer P}Request` ? P : never;
export type ResponsePrefix<K> = K extends `${infer P}Response` ? P : never;
type ExtractPrefix<K, TRes> = K extends `${infer P}Request` ? (`${P}Response` extends keyof TRes ? P : never) : never;

export type InvokePrefixes<TReq, TRes> = ExtractPrefix<keyof TReq, TRes>;
export type RequestData<TReq, P extends string> = `${P}Request` extends keyof TReq ? NonNullable<TReq[`${P}Request`]> : never;
export type ResponseData<TRes, P extends string> = `${P}Response` extends keyof TRes ? NonNullable<TRes[`${P}Response`]> : never;
export type HandlerRequestData<TReq, P extends string> = `${P}Request` extends keyof TReq ? NonNullable<TReq[`${P}Request`]> : never;
export type NotificationKeys<T> = keyof T & `${string}Notification`;
export type NotificationPrefixes<T> = NotificationKeys<T> extends infer K ? (K extends `${infer P}Notification` ? P : never) : never;
export type NotificationData<T, P extends string> = `${P}Notification` extends keyof T ? NonNullable<T[`${P}Notification`]> : never;

export type SrpcMeta = object;

/** Numeric wire values shared with the protobuf PingPongType enum. */
export enum SrpcPingPongType {
    UNSPECIFIED = 0,
    HELLO = 1,
    HELLO_ACK = 2,
    ACTIVATED = 3,
    PING = 4,
    PONG = 5
}

export interface BaseMessage {
    requestId?: string;
    reply?: boolean;
    error?: string;
    userError?: boolean;
    /** Protocol-v4 receipt acknowledgment; requestId identifies the call, and reply remains false. */
    requestAck?: boolean;
    trace?: {
        traceId: string;
        spanId: string;
        traceFlags: number;
    };
    /** Optional numeric enum; empty legacy PingPong codecs remain compatible. */
    pingPong?: { type?: number };
    byteStreamOperation?: {
        streamId: number;
        write?: { chunk: Uint8Array };
        finish?: object;
        destroy?: { error?: string };
    };
}

const SrpcTraceIdPattern = /^[0-9a-f]{32}$/i;
const SrpcSpanIdPattern = /^[0-9a-f]{16}$/i;

/** Ensures untrusted envelope tracing data is safe to pass to OpenTelemetry. */
export function isValidSrpcTrace(trace: BaseMessage['trace']): trace is NonNullable<BaseMessage['trace']> {
    return (
        trace != null &&
        typeof trace.traceId === 'string' &&
        SrpcTraceIdPattern.test(trace.traceId) &&
        !/^0{32}$/i.test(trace.traceId) &&
        typeof trace.spanId === 'string' &&
        SrpcSpanIdPattern.test(trace.spanId) &&
        !/^0{16}$/i.test(trace.spanId) &&
        Number.isInteger(trace.traceFlags) &&
        trace.traceFlags >= 0 &&
        trace.traceFlags <= 0xff
    );
}

export interface SrpcMessageFns<T> {
    encode(message: T, writer?: unknown): { finish(): Uint8Array } | Uint8Array;
    decode(input: Uint8Array, length?: number): T;
}

export type SrpcDisconnectCause = 'disconnect' | 'conflict' | 'supersede' | 'timeout' | 'badArg';

export interface IQueuedRequest {
    exp: number;
    acknowledge?: () => void;
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
}

export class SrpcError extends Error {
    constructor(
        message: string,
        public isUserError?: boolean
    ) {
        super(message);
        this.name = 'SrpcError';
    }
}

/** Preserve the explicit sRPC error contract without promoting ordinary errors. */
export function serializeSrpcError(error: unknown): { error: string; userError?: boolean } {
    const isSrpcError = error instanceof SrpcError;
    const message = isSrpcError ? error.message : String(error);
    const userError = isSrpcError && typeof error.isUserError === 'boolean' ? error.isUserError : undefined;
    return {
        error: message,
        ...(userError === undefined ? {} : { userError })
    };
}

export interface ISrpcLogger {
    info(...messages: unknown[]): void;
    warn(...messages: unknown[]): void;
    error(...messages: unknown[]): void;
    debug(...messages: unknown[]): void;
}

/**
 * Controls per-message sRPC traffic logs. `true` logs envelope/message types
 * except pingPong-only heartbeats; set `bodies` to include the decoded body.
 */
export interface SrpcTrafficLoggingOptions {
    bodies?: boolean;
    /** Include pingPong-only heartbeat envelopes. Defaults to false. */
    pingPong?: boolean;
}

export type SrpcTrafficLogging = boolean | SrpcTrafficLoggingOptions;

const SrpcEnvelopeFields = new Set(['requestId', 'reply', 'error', 'userError', 'requestAck', 'trace', 'pingPong', 'byteStreamOperation']);

/** A receipt cannot carry a result, error, or application payload. */
export function isSrpcRequestAcknowledgment(message: BaseMessage): boolean {
    return (
        message.requestAck === true &&
        typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        !message.reply &&
        message.error === undefined &&
        !message.userError &&
        !message.pingPong &&
        !message.byteStreamOperation &&
        Object.entries(message).every(([key, value]) => SrpcEnvelopeFields.has(key) || value === undefined)
    );
}

/** Refuse v4 negotiation when a consumer's codec silently drops the receipt field. */
export function supportsSrpcRequestAcknowledgments<T extends BaseMessage>(codec: SrpcMessageFns<T>): boolean {
    try {
        const encoded = encodeSrpcMessage(codec, { requestId: 'srpc-ack-probe', requestAck: true } as T);
        const decoded = codec.decode(encoded);
        return isSrpcRequestAcknowledgment(decoded);
    } catch {
        return false;
    }
}

/** Identifies heartbeat-only pings and pongs without hiding mixed payloads or errors. */
export function isSrpcPingPongOnly(message: BaseMessage): boolean {
    return (
        !!message.pingPong &&
        !message.requestAck &&
        message.byteStreamOperation === undefined &&
        message.error === undefined &&
        message.userError === undefined &&
        Object.entries(message).every(([key, value]) => SrpcEnvelopeFields.has(key) || value === undefined)
    );
}

/** Returns the application-level message fields carried by an sRPC envelope. */
export function srpcMessageTypes(message: BaseMessage): string[] {
    if (message.requestAck) return ['requestAck'];
    if (message.pingPong) return ['pingPong'];
    if (message.byteStreamOperation) return ['byteStreamOperation'];
    if (message.error !== undefined) return ['error'];

    const types = Object.entries(message)
        .filter(([key, value]) => !SrpcEnvelopeFields.has(key) && value !== undefined)
        .map(([key]) => key);
    return types.length ? types : [message.reply ? 'reply' : 'unknown'];
}

/** One-way application envelopes contain exactly one notification payload and no reply fields. */
export function isSrpcNotification(message: BaseMessage): boolean {
    if (
        message.requestId ||
        message.reply ||
        message.error !== undefined ||
        message.userError !== undefined ||
        message.requestAck ||
        message.pingPong ||
        message.byteStreamOperation
    )
        return false;
    const types = srpcMessageTypes(message);
    return types.length === 1 && types[0].endsWith('Notification') && (message as Record<string, unknown>)[types[0]] != null;
}

export interface ISrpcServerOptions<TClientOutput extends BaseMessage, TServerOutput extends BaseMessage> {
    logger: ISrpcLogger;
    clientMessage: SrpcMessageFns<TClientOutput>;
    serverMessage: SrpcMessageFns<TServerOutput>;
    wsPath: string;
    /**
     * Protocol version assigned to a handshake that omits `pv` (or legacy `_v`). Leave unset to
     * require an explicit transport version. Use `1` only where legacy
     * same-client replacement semantics are intentional.
     */
    defaultUnspecifiedProtocolVersion?: 1 | 2 | 3;
    logTraffic?: SrpcTrafficLogging;
    httpServer?: import('node:http').Server;
    /** How long replies for locally abandoned requests are ignored. Defaults to 60 seconds. */
    lateReplyTombstoneTtlMs?: number;
    /** Revoke an unacknowledged protocol-v4 client stream at RPC expiry. Defaults to true; v1-v3 are unaffected. */
    disconnectOnRequestTimeout?: boolean;
    /** Maximum client requests buffered before a stream is activated. */
    maxPendingClientRequests?: number;
    /** Maximum decoded client-request bytes buffered before a stream is activated. */
    maxPendingClientRequestBytes?: number;
    /** Maximum concurrent client request handlers for one stream. */
    maxInFlightClientRequests?: number;
    /** Maximum decoded client-request bytes executing concurrently for one stream. */
    maxInFlightClientRequestBytes?: number;
    /** Maximum queued WebSocket bytes per stream before the stream is closed. */
    maxBufferedBytes?: number;
    /** Maximum encoded size of one incoming client WebSocket message. */
    maxMessageBytes?: number;
    /** Maximum pending server-to-client RPCs per stream. */
    maxPendingServerRequests?: number;
    /** Maximum encoded pending server-to-client RPC bytes per stream. */
    maxPendingServerRequestBytes?: number;
    /** Maximum WebSocket authentication handshakes awaiting authorization. */
    maxPendingHandshakes?: number;
    /** Maximum live streams, including streams still activating. */
    maxActiveStreams?: number;
    /** Maximum UTF-8 byte length of a client ID. */
    maxClientIdBytes?: number;
    /** Maximum JSON-encoded byte length of merged query/authorization metadata. */
    maxClientMetadataBytes?: number;
    /** Maximum principals retained by the bounded local authentication replay cache. */
    maxAuthReplayPrincipals?: number;
    /** Optional audience expected in v2 credentials. Defaults to `wsPath`. */
    authAudience?: string;
}

export interface SrpcStream<T = SrpcMeta> extends IByteStreamable {
    $ws: WebSocket;
    $queue: Map<string, IQueuedRequest>;
    readonly id: string;
    readonly clientStreamId: string;
    readonly address: string;
    readonly clientId: string;
    readonly appVersion: string;
    readonly configureTs: number;
    readonly protocolVersion: 1 | 2 | 3 | 4;
    /** Optional client capabilities negotiated during the WebSocket upgrade. */
    readonly capabilities?: ReadonlySet<string>;
    readonly supersede: boolean;
    readonly meta: T;
    readonly connectedAt: number;
    isActivated: boolean;
    lastPingAt: number;
    readonly connected: boolean;
    close(reason?: string): Promise<void>;
}

/**
 * Transport-neutral handle for an sRPC client connection.
 *
 * A handle is pinned to one connection generation (`id`). Implementations
 * must not silently retarget it after the same client reconnects.
 */
export interface SrpcConnection<T = SrpcMeta> extends IByteStreamable {
    readonly id: string;
    readonly clientId: string;
    readonly meta: T;
    readonly connectedAt: number;
    readonly connected: boolean;
    close(reason?: string): Promise<void>;
}

export class SrpcClientNotFoundError extends Error {
    constructor(clientId: string) {
        super(`sRPC client not found: ${clientId}`);
        this.name = 'SrpcClientNotFoundError';
    }
}

export class SrpcStaleConnectionError extends Error {
    constructor(clientId: string) {
        super(`sRPC client connection is stale: ${clientId}`);
        this.name = 'SrpcStaleConnectionError';
    }
}

export class SrpcOwnerUnavailableError extends Error {
    constructor(clientId: string, cause?: unknown) {
        super(`sRPC client owner is unavailable: ${clientId}`, { cause });
        this.name = 'SrpcOwnerUnavailableError';
    }
}

export class SrpcIndeterminateDeliveryError extends Error {
    constructor(clientId: string, cause?: unknown) {
        super(`sRPC invocation delivery is indeterminate: ${clientId}`, { cause });
        this.name = 'SrpcIndeterminateDeliveryError';
    }
}

export class SrpcMeshProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SrpcMeshProtocolError';
    }
}

export class SrpcMeshAuthenticationError extends Error {
    constructor(message = 'sRPC mesh peer authentication failed') {
        super(message);
        this.name = 'SrpcMeshAuthenticationError';
    }
}

export class SrpcBackpressureError extends Error {
    constructor(message = 'sRPC mesh backpressure limit exceeded') {
        super(message);
        this.name = 'SrpcBackpressureError';
    }
}

export class SrpcStreamClosedError extends Error {
    constructor(message = 'sRPC byte stream is closed') {
        super(message);
        this.name = 'SrpcStreamClosedError';
    }
}

export type SrpcMessageHandlerFn<C, I, O> = (wrappedStream: C, data: I) => Promise<O> | O;

export interface ISrpcMessageHandler<C, I, O> {
    handle: SrpcMessageHandlerFn<C, I, O>;
}

export type TSrpcMessageHandlerClass<C, I, O> = ClassType<ISrpcMessageHandler<C, I, O>>;
export type TSrpcMessageHandlerFnOrClass<C, I, O> = SrpcMessageHandlerFn<C, I, O> | TSrpcMessageHandlerClass<C, I, O>;

export function isSrpcMessageHandlerClass<C, I, O>(handler: TSrpcMessageHandlerFnOrClass<C, I, O>): handler is TSrpcMessageHandlerClass<C, I, O> {
    return typeof handler === 'function' && typeof (handler as { prototype?: { handle?: unknown } }).prototype?.handle === 'function';
}

export function encodeSrpcMessage<T>(codec: SrpcMessageFns<T>, message: T): Buffer {
    const encoded = codec.encode(message);
    const bytes = 'finish' in encoded ? encoded.finish() : encoded;
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}
