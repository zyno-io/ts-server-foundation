import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { createRedis } from '../helpers/redis/redis';
import { LeaderService, LeaderServiceOptions } from './leader';
import { createLogger } from './logger';

// --- Types ---

export type MeshMessageMap = Record<string, { request: unknown; response: unknown }>;
export type MeshBroadcastMap = Record<string, unknown>;

export interface MeshBroadcastOptions {
    skipSelf?: boolean;
}

export interface MeshNode {
    instanceId: number;
    hostname: string;
    self: boolean;
}

export interface MeshServiceOptions {
    heartbeatIntervalMs?: number;
    nodeTtlMs?: number;
    requestTimeoutMs?: number;
    leaderOptions?: LeaderServiceOptions;
}

export class MeshRequestTimeoutError extends Error {
    constructor(instanceId: number, type: string) {
        super(`Mesh request to instance ${instanceId} timed out (type: ${type})`);
        this.name = 'MeshRequestTimeoutError';
    }
}

export class MeshHandlerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MeshHandlerError';
    }
}

export class MeshNoHandlerError extends Error {
    constructor(type: string) {
        super(`No handler registered for mesh message type: ${type}`);
        this.name = 'MeshNoHandlerError';
    }
}

// --- Constants ---

const NO_HANDLER_ERROR_PREFIX = 'MESH_NO_HANDLER:';

// --- Lua Scripts ---

const HEARTBEAT_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call("zadd", KEYS[1], now_ms, ARGV[1])
return 1
`;

const CLEANUP_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cutoff = now_ms - tonumber(ARGV[1])
local expired = redis.call("zrangebyscore", KEYS[1], "-inf", cutoff)
for i, id in ipairs(expired) do
    redis.call("zrem", KEYS[1], id)
    redis.call("hdel", KEYS[2], id)
end
return expired
`;

const DEREGISTER_SCRIPT = `
redis.call("zrem", KEYS[1], ARGV[1])
redis.call("hdel", KEYS[2], ARGV[1])
return 1
`;

// --- Redis Client ---

type MeshRedisClient = ReturnType<typeof createRedis>['client'] & {
    HEARTBEAT: (key: string, instanceId: string) => Promise<number>;
    CLEANUP: (heartbeatsKey: string, nodesKey: string, ttlMs: string) => Promise<string[]>;
    DEREGISTER: (heartbeatsKey: string, nodesKey: string, instanceId: string) => Promise<number>;
};

let meshRedis: { client: MeshRedisClient; prefix: string } | null = null;

function getMeshRedis(): { client: MeshRedisClient; prefix: string } {
    if (!meshRedis) {
        const { client, prefix } = createRedis('MESH');
        client.defineCommand('HEARTBEAT', { lua: HEARTBEAT_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('CLEANUP', { lua: CLEANUP_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('DEREGISTER', { lua: DEREGISTER_SCRIPT, numberOfKeys: 2 });
        meshRedis = { client: client as MeshRedisClient, prefix };
    }
    return meshRedis;
}

export function destroyMeshRedis(): void {
    if (meshRedis) {
        meshRedis.client.disconnect();
        meshRedis = null;
    }
}

// --- Channel Message Types ---

interface MeshRequest {
    requestId: string;
    senderInstanceId: number;
    type: string;
    data: unknown;
    timeoutMs?: number;
}

interface MeshResponse {
    requestId: string;
    reply: true;
    data?: unknown;
    error?: string;
}

interface MeshHeartbeat {
    requestId: string;
    heartbeat: true;
}

interface MeshBroadcast {
    broadcast: true;
    senderInstanceId: number;
    type: string;
    data: unknown;
}

// --- Pending Request ---

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    type: string;
    targetInstanceId: number;
    timeoutMs: number;
}

// --- MeshService ---

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class MeshService<T extends MeshMessageMap, B extends MeshBroadcastMap = {}> {
    private _instanceId: number = 0;
    private key: string;
    private prefix: string = '';
    private running = false;

    private heartbeatIntervalMs: number;
    private nodeTtlMs: number;
    private requestTimeoutMs: number;
    private leaderOptions?: LeaderServiceOptions;

    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private leaderService: LeaderService | null = null;
    private subscriberClient: ReturnType<typeof createRedis>['client'] | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handlers = new Map<string, (data: any) => any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private broadcastHandlers = new Map<string, (data: any, senderInstanceId: number) => void | Promise<void>>();
    private pendingRequests = new Map<string, PendingRequest>();
    private activeHandlerIntervals = new Set<ReturnType<typeof setInterval>>();
    private nodeCleanedUpCallback: ((instanceId: number) => void | Promise<void>) | null = null;

    private logger = createLogger(this);

    constructor(key: string, options?: MeshServiceOptions) {
        this.key = key;
        this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 5000;
        this.nodeTtlMs = options?.nodeTtlMs ?? 15000;
        this.requestTimeoutMs = options?.requestTimeoutMs ?? 10000;
        this.leaderOptions = options?.leaderOptions;
    }

    get instanceId(): number {
        return this._instanceId;
    }

    registerHandler<K extends keyof T & string>(type: K, handler: (data: T[K]['request']) => T[K]['response'] | Promise<T[K]['response']>): void {
        this.handlers.set(type, handler);
    }

    registerBroadcastHandler<K extends keyof B & string>(type: K, handler: (data: B[K], senderInstanceId: number) => void | Promise<void>): void {
        this.broadcastHandlers.set(type, handler);
    }

    setNodeCleanedUpCallback(cb: (instanceId: number) => void | Promise<void>): void {
        this.nodeCleanedUpCallback = cb;
    }

    async getNodes(): Promise<MeshNode[]> {
        if (!this.running) {
            throw new Error('MeshService is not running');
        }

        const { client } = getMeshRedis();
        const members = await client.zrange(this.heartbeatsKey(), 0, -1);
        if (members.length === 0) return [];

        const hostnames = await client.hmget(this.nodesKey(), ...members);
        return members.map((id, i) => ({
            instanceId: parseInt(id, 10),
            hostname: hostnames[i] ?? 'unknown',
            self: parseInt(id, 10) === this._instanceId
        }));
    }

    async invoke<K extends keyof T & string>(instanceId: number, type: K, data: T[K]['request'], timeoutMs?: number): Promise<T[K]['response']> {
        if (!this.running) {
            throw new Error('MeshService is not running');
        }

        const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;

        // Local invocation - call handler directly
        if (instanceId === this._instanceId) {
            const handler = this.handlers.get(type);
            if (!handler) throw new MeshNoHandlerError(type);
            return handler(data);
        }

        // Remote invocation via pub/sub
        const requestId = randomUUID();
        const channel = this.channelForInstance(instanceId);

        // Serialize before registering pending request to avoid leaked timers on stringify failure
        const message: MeshRequest = {
            requestId,
            senderInstanceId: this._instanceId,
            type,
            data,
            timeoutMs: effectiveTimeout
        };
        const payload = JSON.stringify(message);

        return new Promise<T[K]['response']>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new MeshRequestTimeoutError(instanceId, type));
            }, effectiveTimeout);

            this.pendingRequests.set(requestId, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
                type,
                targetInstanceId: instanceId,
                timeoutMs: effectiveTimeout
            });

            const { client } = getMeshRedis();
            client.publish(channel, payload).catch(err => {
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                reject(new Error(`Failed to publish mesh request: ${err instanceof Error ? err.message : String(err)}`));
            });
        });
    }

    async broadcast<K extends keyof B & string>(type: K, data: B[K], options?: MeshBroadcastOptions): Promise<void> {
        if (!this.running) {
            throw new Error('MeshService is not running');
        }

        const message: MeshBroadcast = {
            broadcast: true,
            senderInstanceId: this._instanceId,
            type,
            data
        };

        // Deliver locally unless skipSelf
        if (!options?.skipSelf) {
            this.handleBroadcastMessage(message);
        }

        const { client } = getMeshRedis();
        await client.publish(this.broadcastChannel(), JSON.stringify(message));
    }

    async start(): Promise<void> {
        if (this.running) {
            throw new Error('MeshService is already running');
        }

        const { client, prefix } = getMeshRedis();
        this.prefix = prefix;

        // Acquire unique instance ID
        this._instanceId = await client.incr(this.nextIdKey());

        // Create subscriber and subscribe to own channel
        const { client: subClient } = createRedis('MESH');
        this.subscriberClient = subClient;

        try {
            const instanceChannel = this.channelForInstance(this._instanceId);
            const broadcastCh = this.broadcastChannel();
            await subClient.subscribe(instanceChannel, broadcastCh);
            subClient.on('message', (channel: string, message: string) => {
                if (channel === broadcastCh) {
                    this.handleBroadcastIncoming(message);
                } else {
                    this.handleMessage(message);
                }
            });

            // Register heartbeat and node metadata
            await client.HEARTBEAT(this.heartbeatsKey(), String(this._instanceId));
            await client.hset(this.nodesKey(), String(this._instanceId), hostname());
        } catch (err) {
            // Clean up subscriber on partial init failure
            try {
                await subClient.unsubscribe();
                await subClient.quit();
            } catch {
                // ignore cleanup errors
            }
            this.subscriberClient = null;
            const failedInstanceId = this._instanceId;
            this._instanceId = 0;
            if (failedInstanceId !== 0) {
                try {
                    await client.DEREGISTER(this.heartbeatsKey(), this.nodesKey(), String(failedInstanceId));
                } catch {
                    // Preserve the startup failure; normal TTL/leader cleanup is the fallback.
                }
            }
            throw err;
        }

        this.running = true;

        // Start heartbeat interval
        this.heartbeatTimer = setInterval(() => this.doHeartbeat(), this.heartbeatIntervalMs);

        // Start leader service for cleanup duties
        this.leaderService = new LeaderService(`mesh:${this.key}`, this.leaderOptions);
        this.leaderService.start();

        this.logger.info('mesh node started', { instanceId: this._instanceId, key: this.key });
    }

    async stop(): Promise<void> {
        this.running = false;

        // Stop leader service
        if (this.leaderService) {
            await this.leaderService.stop();
            this.leaderService = null;
        }

        // Stop heartbeat
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Clear all active handler heartbeat intervals
        for (const interval of this.activeHandlerIntervals) {
            clearInterval(interval);
        }
        this.activeHandlerIntervals.clear();

        // Reject all pending requests
        for (const [requestId, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('MeshService stopped'));
            this.pendingRequests.delete(requestId);
        }

        // Unsubscribe and quit subscriber
        if (this.subscriberClient) {
            try {
                await this.subscriberClient.unsubscribe();
                await this.subscriberClient.quit();
            } catch {
                // ignore errors during cleanup
            }
            this.subscriberClient = null;
        }

        // Atomically remove self from heartbeats and nodes
        if (this._instanceId !== 0) {
            const stoppedInstanceId = this._instanceId;
            this._instanceId = 0;
            try {
                const { client } = getMeshRedis();
                await client.DEREGISTER(this.heartbeatsKey(), this.nodesKey(), String(stoppedInstanceId));
            } catch {
                // ignore errors during cleanup
            }
            this.logger.info('mesh node stopped', { instanceId: stoppedInstanceId, key: this.key });
        }
    }

    // --- Private ---

    private nextIdKey(): string {
        return `${this.prefix}:mesh:${this.key}:next_id`;
    }

    private heartbeatsKey(): string {
        return `${this.prefix}:mesh:${this.key}:heartbeats`;
    }

    private nodesKey(): string {
        return `${this.prefix}:mesh:${this.key}:nodes`;
    }

    private channelForInstance(instanceId: number): string {
        return `${this.prefix}:mesh:${this.key}:node:${instanceId}`;
    }

    private broadcastChannel(): string {
        return `${this.prefix}:mesh:${this.key}:broadcast`;
    }

    private async doHeartbeat(): Promise<void> {
        if (!this.running) return;

        try {
            const { client } = getMeshRedis();
            await client.HEARTBEAT(this.heartbeatsKey(), String(this._instanceId));
        } catch (err) {
            this.logger.warn('mesh heartbeat failed', { err });
        }

        // If leader, run cleanup
        if (this.leaderService?.isLeader) {
            await this.doCleanup();
        }
    }

    private async doCleanup(): Promise<void> {
        try {
            const { client } = getMeshRedis();
            const expired = await client.CLEANUP(this.heartbeatsKey(), this.nodesKey(), String(this.nodeTtlMs));

            if (expired.length > 0) {
                this.logger.info('cleaned up expired mesh nodes', { expired });

                for (const idStr of expired) {
                    const id = parseInt(idStr, 10);
                    try {
                        await this.nodeCleanedUpCallback?.(id);
                    } catch (err) {
                        this.logger.warn('node cleanup callback error', { err, instanceId: id });
                    }
                }
            }
        } catch (err) {
            this.logger.warn('mesh cleanup failed', { err });
        }
    }

    private handleBroadcastIncoming(raw: string): void {
        if (!this.running) return;

        let msg: unknown;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (typeof msg !== 'object' || msg === null) return;

        const obj = msg as MeshBroadcast;
        // Skip self-sent broadcasts (we already delivered locally in broadcast())
        if (obj.senderInstanceId === this._instanceId) return;

        this.handleBroadcastMessage(obj);
    }

    private handleBroadcastMessage(msg: MeshBroadcast): void {
        const handler = this.broadcastHandlers.get(msg.type);
        if (!handler) return;

        Promise.resolve()
            .then(() => handler(msg.data, msg.senderInstanceId))
            .catch(err => {
                this.logger.warn('broadcast handler error', { err, type: msg.type });
            });
    }

    private handleMessage(raw: string): void {
        if (!this.running) return;

        let msg: unknown;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            this.logger.warn('failed to parse mesh message', { err, raw });
            return;
        }

        if (typeof msg !== 'object' || msg === null) {
            this.logger.warn('invalid mesh message: not an object', { raw });
            return;
        }

        const obj = msg as Record<string, unknown>;

        if ('heartbeat' in obj && obj.heartbeat) {
            this.handleHeartbeatMessage(obj as unknown as MeshHeartbeat);
        } else if ('reply' in obj && obj.reply) {
            this.handleResponseMessage(obj as unknown as MeshResponse);
        } else {
            this.handleRequestMessage(obj as unknown as MeshRequest);
        }
    }

    private handleHeartbeatMessage(msg: MeshHeartbeat): void {
        const pending = this.pendingRequests.get(msg.requestId);
        if (!pending) return;

        // Reset timeout using the original per-request timeout
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
            this.pendingRequests.delete(msg.requestId);
            pending.reject(new MeshRequestTimeoutError(pending.targetInstanceId, pending.type));
        }, pending.timeoutMs);
    }

    private handleResponseMessage(msg: MeshResponse): void {
        const pending = this.pendingRequests.get(msg.requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.requestId);

        if (msg.error !== undefined) {
            if (typeof msg.error === 'string' && msg.error.startsWith(NO_HANDLER_ERROR_PREFIX)) {
                pending.reject(new MeshNoHandlerError(msg.error.slice(NO_HANDLER_ERROR_PREFIX.length)));
            } else {
                pending.reject(new MeshHandlerError(msg.error));
            }
        } else {
            pending.resolve(msg.data);
        }
    }

    private handleRequestMessage(msg: MeshRequest): void {
        if (!this.running) return;

        if (typeof msg.requestId !== 'string' || typeof msg.senderInstanceId !== 'number' || typeof msg.type !== 'string') {
            this.logger.warn('invalid mesh request: missing or malformed fields', { msg });
            return;
        }

        const handler = this.handlers.get(msg.type);
        const { client } = getMeshRedis();
        const senderChannel = this.channelForInstance(msg.senderInstanceId);

        if (!handler) {
            const response: MeshResponse = {
                requestId: msg.requestId,
                reply: true,
                error: `${NO_HANDLER_ERROR_PREFIX}${msg.type}`
            };
            client.publish(senderChannel, JSON.stringify(response)).catch(err => {
                this.logger.warn('failed to publish no-handler response', { err });
            });
            return;
        }

        // Use the caller's timeout for heartbeat interval (fall back to our own)
        const effectiveTimeoutMs = msg.timeoutMs ?? this.requestTimeoutMs;
        const heartbeatInterval = setInterval(() => {
            const heartbeat: MeshHeartbeat = {
                requestId: msg.requestId,
                heartbeat: true
            };
            client.publish(senderChannel, JSON.stringify(heartbeat)).catch(err => {
                this.logger.warn('failed to publish handler heartbeat', { err });
            });
        }, effectiveTimeoutMs * 0.75);
        this.activeHandlerIntervals.add(heartbeatInterval);

        // Execute handler
        Promise.resolve()
            .then(() => handler(msg.data))
            .then(result => {
                clearInterval(heartbeatInterval);
                this.activeHandlerIntervals.delete(heartbeatInterval);
                const response: MeshResponse = {
                    requestId: msg.requestId,
                    reply: true,
                    data: result
                };
                client.publish(senderChannel, JSON.stringify(response)).catch(err => {
                    this.logger.warn('failed to publish handler response', { err });
                });
            })
            .catch(err => {
                clearInterval(heartbeatInterval);
                this.activeHandlerIntervals.delete(heartbeatInterval);
                const response: MeshResponse = {
                    requestId: msg.requestId,
                    reply: true,
                    error: err instanceof Error ? err.message : String(err)
                };
                client.publish(senderChannel, JSON.stringify(response)).catch(publishErr => {
                    this.logger.warn('failed to publish handler error response', { err: publishErr });
                });
            });
    }
}
