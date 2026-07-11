import { EventEmitter } from 'node:events';
import { Socket, createConnection, createServer } from 'node:net';

import { UniqueConstraintError, isUniqueConstraintError } from '../errors';

export interface RpcRequest {
    id: number;
    method: string;
    params?: unknown;
}

export interface RpcResponse {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: RpcErrorPayload;
}

interface RpcErrorPayload {
    message: string;
    name?: string;
    code?: unknown;
    errno?: unknown;
}

export type RpcHandler = (method: string, params: unknown, peer: RpcPeer) => Promise<unknown> | unknown;

export class RpcPeer extends EventEmitter {
    private nextId = 1;
    private buffer = '';
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    constructor(
        private readonly socket: Socket,
        private readonly handler?: RpcHandler
    ) {
        super();
        socket.setEncoding('utf8');
        socket.on('data', chunk => this.receive(String(chunk)));
        socket.on('close', () => {
            for (const pending of this.pending.values()) pending.reject(new Error('RPC socket closed'));
            this.pending.clear();
            this.emit('close');
        });
        socket.on('error', error => this.emit('error', error));
    }

    call<T = unknown>(method: string, params?: unknown): Promise<T> {
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: value => resolve(value as T), reject });
        });
    }

    close(): void {
        this.socket.end();
    }

    private receive(chunk: string): void {
        this.buffer += chunk;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline === -1) return;
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (!line.trim()) continue;
            void this.dispatch(decodeRpcValue(JSON.parse(line)) as RpcRequest | RpcResponse);
        }
    }

    private async dispatch(message: RpcRequest | RpcResponse): Promise<void> {
        if ('method' in message) {
            if (!this.handler) {
                this.write({ id: message.id, ok: false, error: { message: 'No RPC handler installed' } });
                return;
            }
            try {
                const result = await this.handler(message.method, message.params, this);
                this.write({ id: message.id, ok: true, result });
            } catch (error) {
                this.write({
                    id: message.id,
                    ok: false,
                    error: encodeRpcError(error)
                });
            }
            return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(decodeRpcError(message.error));
    }

    private write(message: RpcRequest | RpcResponse): void {
        this.socket.write(`${JSON.stringify(encodeRpcValue(message))}\n`);
    }
}

function encodeRpcError(error: unknown): RpcErrorPayload {
    if (!error || typeof error !== 'object') return { message: String(error) };
    const candidate = error as { message?: unknown; name?: unknown; code?: unknown; errno?: unknown };
    return {
        message: typeof candidate.message === 'string' && candidate.message ? candidate.message : String(error),
        name: typeof candidate.name === 'string' ? candidate.name : undefined,
        code: candidate.code,
        errno: candidate.errno
    };
}

function decodeRpcError(payload: RpcErrorPayload | undefined): Error {
    if (!payload) return new Error('RPC request failed');
    if (payload.name === 'UniqueConstraintError' || isUniqueConstraintError(payload)) {
        return new UniqueConstraintError(payload.message, payload);
    }
    const error = new Error(payload.message);
    if (payload.name) error.name = payload.name;
    Object.assign(error, { code: payload.code, errno: payload.errno });
    return error;
}

export function listenRpc(port: number, handler: RpcHandler): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer(socket => {
        const peer = new RpcPeer(socket, handler);
        peer.on('error', () => {});
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Unexpected RPC listen address'));
                return;
            }
            resolve({
                port: address.port,
                close: () =>
                    new Promise<void>((closeResolve, closeReject) => {
                        server.close(error => (error ? closeReject(error) : closeResolve()));
                    })
            });
        });
    });
}

export function connectRpc(port: number): Promise<RpcPeer> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('error', reject);
        socket.once('connect', () => {
            socket.off('error', reject);
            resolve(new RpcPeer(socket));
        });
    });
}

function encodeRpcValue(value: unknown): unknown {
    if (value instanceof Date) return { __tsfRpcType: 'Date', value: value.toISOString() };
    if (Buffer.isBuffer(value)) return { __tsfRpcType: 'Buffer', value: value.toString('base64') };
    if (typeof value === 'bigint') return { __tsfRpcType: 'BigInt', value: value.toString() };
    if (Array.isArray(value)) return value.map(encodeRpcValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeRpcValue(entry)]));
}

function decodeRpcValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decodeRpcValue);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.__tsfRpcType === 'Date' && typeof record.value === 'string') return new Date(record.value);
    if (record.__tsfRpcType === 'Buffer' && typeof record.value === 'string') return Buffer.from(record.value, 'base64');
    if (record.__tsfRpcType === 'BigInt' && typeof record.value === 'string') return BigInt(record.value);
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeRpcValue(entry)]));
}
