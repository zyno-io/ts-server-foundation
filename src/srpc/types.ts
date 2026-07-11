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

export type SrpcMeta = object;

export interface BaseMessage {
    requestId?: string;
    reply?: boolean;
    error?: string;
    userError?: boolean;
    trace?: {
        traceId: string;
        spanId: string;
        traceFlags: number;
    };
    pingPong?: {};
    byteStreamOperation?: {
        streamId: number;
        write?: { chunk: Uint8Array };
        finish?: {};
        destroy?: { error?: string };
    };
}

export interface SrpcMessageFns<T> {
    encode(message: T, writer?: unknown): { finish(): Uint8Array } | Uint8Array;
    decode(input: Uint8Array, length?: number): T;
}

export type SrpcDisconnectCause = 'disconnect' | 'conflict' | 'supersede' | 'timeout' | 'badArg';

export interface IQueuedRequest {
    exp: number;
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

export interface ISrpcLogger {
    info(...messages: unknown[]): void;
    warn(...messages: unknown[]): void;
    error(...messages: unknown[]): void;
    debug(...messages: unknown[]): void;
}

export interface ISrpcServerOptions<TClientOutput extends BaseMessage, TServerOutput extends BaseMessage> {
    logger: ISrpcLogger;
    clientMessage: SrpcMessageFns<TClientOutput>;
    serverMessage: SrpcMessageFns<TServerOutput>;
    wsPath: string;
    debug?: boolean;
    logLevel?: 'info' | 'debug' | false;
    httpServer?: import('node:http').Server;
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
    readonly protocolVersion: number;
    readonly supersede: boolean;
    readonly meta: T;
    readonly connectedAt: number;
    isActivated: boolean;
    lastPingAt: number;
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
