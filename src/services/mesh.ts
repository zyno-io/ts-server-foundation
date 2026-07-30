import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';

import { MAX_SAFE_TIMER_MS } from '../helpers';
import { registerRedisStateReset } from '../helpers/redis/lifecycle';
import { createRedis } from '../helpers/redis/redis';
import { LeaderService, LeaderServiceOptions } from './leader';
import { createLogger } from './logger';

// --- Types ---

export type MeshBroadcastMap = Record<string, unknown>;

export interface MeshBroadcastOptions {
    skipSelf?: boolean;
}

/** Generation-pinned execution context for mesh broadcast handlers. */
export interface MeshHandlerContext {
    /**
     * Aborted synchronously when the owning MeshService generation is stopped
     * or fenced. Existing handlers may ignore this signal.
     */
    signal: AbortSignal;
}

export interface MeshNode {
    instanceId: number;
    hostname: string;
    self: boolean;
    processId?: string;
    linkEndpointId?: string;
    /** v2 mesh-link Ed25519 public key (SPKI DER, base64) pinned by peers. */
    linkEndpointPublicKey?: string;
    linkUrl?: string;
    startedAt?: number;
}

export interface MeshServiceOptions {
    heartbeatIntervalMs?: number;
    nodeTtlMs?: number;
    leaderOptions?: LeaderServiceOptions;
    nodeMetadata?: Omit<MeshNode, 'instanceId' | 'hostname' | 'self'>;
    maxMessageBytes?: number;
    /** Maximum concurrently processed incoming broadcasts. */
    maxActiveHandlers?: number;
    /** Maximum bytes retained by concurrently processed incoming broadcasts. */
    maxActiveHandlerBytes?: number;
    /** Maximum Redis list/set members touched by one mesh cleanup Lua call. */
    cleanupBatchSize?: number;
}

export class MeshBroadcastIndeterminateDeliveryError extends Error {
    constructor(type: string, cause?: unknown) {
        super(`Mesh broadcast delivery is indeterminate (type: ${type})`, cause === undefined ? undefined : { cause });
        this.name = 'MeshBroadcastIndeterminateDeliveryError';
    }
}

// --- Lua Scripts ---

const HEARTBEAT_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if ARGV[2] == "create" then
    redis.call("zadd", KEYS[1], "NX", now_ms, ARGV[1])
else
    local score = redis.call("zscore", KEYS[1], ARGV[1])
    if not score or tonumber(score) <= now_ms - tonumber(ARGV[3]) then
        return 0
    end
    redis.call("zadd", KEYS[1], now_ms, ARGV[1])
end
return now_ms
`;

const CLEANUP_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cutoff = now_ms - tonumber(ARGV[1])
local expired = redis.call("zrangebyscore", KEYS[1], "-inf", cutoff, "LIMIT", 0, tonumber(ARGV[2]))
for i, id in ipairs(expired) do
    redis.call("zrem", KEYS[1], id)
    redis.call("hdel", KEYS[2], id)
    redis.call("lpush", KEYS[3], id)
end
return expired
`;

const DEREGISTER_SCRIPT = `
redis.call("zrem", KEYS[1], ARGV[1])
redis.call("hdel", KEYS[2], ARGV[1])
return 1
`;

// Metadata must never recreate a node which has already been deregistered or
// expired.  Keep the liveness check and HSET in one Redis-time transaction so
// it is serialized with CLEANUP/DEREGISTER.
const UPDATE_METADATA_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local score = redis.call("zscore", KEYS[1], ARGV[1])
if not score or tonumber(score) <= now_ms - tonumber(ARGV[3]) then return 0 end
redis.call("hset", KEYS[2], ARGV[1], ARGV[2])
return 1
`;

const ACTIVE_MEMBERS_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
return redis.call("zrangebyscore", KEYS[1], now_ms - tonumber(ARGV[1]), "+inf")
`;

const ACTIVE_SCORE_SCRIPT = `
local time = redis.call("time")
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local score = redis.call("zscore", KEYS[1], ARGV[1])
if not score or tonumber(score) <= now_ms - tonumber(ARGV[2]) then return nil end
return score
`;

const RECOVER_CLEANUP_SCRIPT = `
local recovered = 0
while recovered < tonumber(ARGV[1]) do
    local id = redis.call("rpop", KEYS[2])
    if not id then break end
    local separator = string.find(id, "|")
    redis.call("lpush", KEYS[1], separator and string.sub(id, 1, separator - 1) or id)
    recovered = recovered + 1
end
return recovered
`;

const CLAIM_CLEANUP_SCRIPT = `
local id = redis.call("rpop", KEYS[1])
if not id then return "" end
local claim = id .. "|" .. ARGV[1]
redis.call("lpush", KEYS[2], claim)
return claim
`;

const ACK_CLEANUP_SCRIPT = `
return redis.call("lrem", KEYS[1], 1, ARGV[1])
`;

const NACK_CLEANUP_SCRIPT = `
if redis.call("lrem", KEYS[2], 1, ARGV[1]) == 1 then
    -- Consumers pop from the right. Requeue a failed obligation on the left so
    -- it cannot indefinitely starve healthy work already waiting in the list.
    local separator = string.find(ARGV[1], "|")
    local id = separator and string.sub(ARGV[1], 1, separator - 1) or ARGV[1]
    redis.call("lpush", KEYS[1], id)
    return 1
end
return 0
`;

// --- Redis Client ---

type MeshRedisClient = ReturnType<typeof createRedis>['client'] & {
    HEARTBEAT: (key: string, instanceId: string, mode: 'create' | 'renew', ttlMs: string) => Promise<number>;
    CLEANUP: (heartbeatsKey: string, nodesKey: string, cleanupKey: string, ttlMs: string, batchSize: string) => Promise<string[]>;
    DEREGISTER: (heartbeatsKey: string, nodesKey: string, instanceId: string) => Promise<number>;
    UPDATE_METADATA: (heartbeatsKey: string, nodesKey: string, instanceId: string, metadata: string, ttlMs: string) => Promise<number>;
    ACTIVE_MEMBERS: (heartbeatsKey: string, ttlMs: string) => Promise<string[]>;
    ACTIVE_SCORE: (heartbeatsKey: string, instanceId: string, ttlMs: string) => Promise<string | null>;
    RECOVER_CLEANUP: (cleanupKey: string, processingKey: string, batchSize: string) => Promise<number>;
    CLAIM_CLEANUP: (cleanupKey: string, processingKey: string, token: string) => Promise<string>;
    ACK_CLEANUP: (processingKey: string, claim: string) => Promise<number>;
    NACK_CLEANUP: (cleanupKey: string, processingKey: string, instanceId: string) => Promise<number>;
};

let meshRedis: { client: MeshRedisClient; prefix: string } | null = null;

function getMeshRedis(): { client: MeshRedisClient; prefix: string } {
    if (!meshRedis) {
        const { client, prefix } = createRedis('MESH');
        client.defineCommand('HEARTBEAT', { lua: HEARTBEAT_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('CLEANUP', { lua: CLEANUP_SCRIPT, numberOfKeys: 3 });
        client.defineCommand('DEREGISTER', { lua: DEREGISTER_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('UPDATE_METADATA', { lua: UPDATE_METADATA_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('ACTIVE_MEMBERS', { lua: ACTIVE_MEMBERS_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('ACTIVE_SCORE', { lua: ACTIVE_SCORE_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('RECOVER_CLEANUP', { lua: RECOVER_CLEANUP_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('CLAIM_CLEANUP', { lua: CLAIM_CLEANUP_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('ACK_CLEANUP', { lua: ACK_CLEANUP_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('NACK_CLEANUP', { lua: NACK_CLEANUP_SCRIPT, numberOfKeys: 2 });
        const nextClient = client as MeshRedisClient;
        registerRedisStateReset(nextClient, () => {
            if (meshRedis?.client === nextClient) meshRedis = null;
        });
        meshRedis = { client: nextClient, prefix };
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

interface MeshBroadcast {
    protocolVersion: 2;
    broadcast: true;
    senderInstanceId: number;
    type: string;
    data: unknown;
}

interface MeshBroadcastGeneration {
    generation: number;
    abortController: AbortController;
    activeHandlerCount: number;
    activeHandlerBytes: number;
}

// --- MeshService ---

export class MeshService<B extends MeshBroadcastMap = {}> {
    private _instanceId: number = 0;
    private key: string;
    private prefix: string = '';
    private running = false;

    private heartbeatIntervalMs: number;
    private nodeTtlMs: number;
    private maxMessageBytes: number;
    private maxActiveHandlers: number;
    private maxActiveHandlerBytes: number;
    private cleanupBatchSize: number;
    private leaderOptions?: LeaderServiceOptions;
    private nodeMetadata: Omit<MeshNode, 'instanceId' | 'hostname' | 'self'>;

    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private leaderService: LeaderService | null = null;
    /** Changes on every acquire/loss, including reacquisition by one object. */
    private leaderEpoch = 0;
    private subscriberClient: ReturnType<typeof createRedis>['client'] | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private broadcastHandlers = new Map<string, (data: any, senderInstanceId: number, context: MeshHandlerContext) => void | Promise<void>>();
    private broadcastGeneration = createBroadcastGeneration(0);
    private activeIncomingMessages = 0;
    private activeIncomingBytes = 0;
    private nodeCleanedUpCallback: ((instanceId: number) => void | Promise<void>) | null = null;
    private leaseLostCallback: ((reason?: Error) => void | Promise<void>) | null = null;
    private leaseLost = false;
    private heartbeatGeneration: number | null = null;
    private readonly cleanupDrains = new Map<string, Promise<void>>();
    private leaseSafeUntil = 0;
    private leaseSafetyTimer: ReturnType<typeof setTimeout> | null = null;
    private lifecycle: Promise<void> = Promise.resolve();
    private generation = 0;
    private leaseFencePromise?: Promise<void>;
    /** @internal Overridable by focused lifecycle tests. */
    private leaseLossCallbackTimeoutMs = 2_000;

    private logger = createLogger(this);

    constructor(key: string, options?: MeshServiceOptions) {
        validateMeshOptions(options);
        this.key = key;
        this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 5000;
        this.nodeTtlMs = options?.nodeTtlMs ?? 15000;
        this.maxMessageBytes = options?.maxMessageBytes ?? 1024 * 1024;
        this.maxActiveHandlers = options?.maxActiveHandlers ?? 4096;
        this.maxActiveHandlerBytes = options?.maxActiveHandlerBytes ?? 64 * 1024 * 1024;
        this.cleanupBatchSize = options?.cleanupBatchSize ?? 100;
        this.leaderOptions = options?.leaderOptions;
        this.nodeMetadata = options?.nodeMetadata ?? {};
    }

    get instanceId(): number {
        return this._instanceId;
    }

    registerBroadcastHandler<K extends keyof B & string>(
        type: K,
        handler: (data: B[K], senderInstanceId: number, context: MeshHandlerContext) => void | Promise<void>
    ): void {
        this.broadcastHandlers.set(type, handler);
    }

    setNodeCleanedUpCallback(cb: (instanceId: number) => void | Promise<void>): void {
        this.nodeCleanedUpCallback = cb;
    }

    /** Fires once after renewal proves this instance is no longer a member. */
    setLeaseLostCallback(cb: (reason?: Error) => void | Promise<void>): void {
        this.leaseLostCallback = cb;
    }

    /**
     * Synchronously fences work once the last conservatively-known membership
     * lease can no longer be valid.
     */
    assertLeaseSafe(): void {
        const reason = new Error('Mesh membership lease is no longer safe');
        if (!this.running || this.leaseLost) throw reason;
        if (performance.now() < this.leaseSafeUntil) return;
        this.fenceLeaseLoss(reason);
        throw reason;
    }

    /**
     * @internal Synchronously revokes this generation's membership authority
     * and handler state. Physical Redis/subscriber shutdown continues
     * asynchronously and the returned promise settles after lease-loss
     * callbacks finish.
     */
    fence(reason: Error): Promise<void> {
        return this.fenceLeaseLoss(reason);
    }

    async getNodes(): Promise<MeshNode[]> {
        this.assertLeaseSafe();

        const { client } = getMeshRedis();
        const members = await client.ACTIVE_MEMBERS(this.heartbeatsKey(), String(this.nodeTtlMs));
        this.assertLeaseSafe();
        if (members.length === 0) return [];

        const records = await client.hmget(this.nodesKey(), ...members);
        this.assertLeaseSafe();
        return members.map((id, i) => this.parseNode(id, records[i]));
    }

    async getNode(instanceId: number): Promise<MeshNode | undefined> {
        this.assertLeaseSafe();
        const { client } = getMeshRedis();
        const alive = await client.ACTIVE_SCORE(this.heartbeatsKey(), String(instanceId), String(this.nodeTtlMs));
        this.assertLeaseSafe();
        if (alive === null) return undefined;
        const raw = await client.hget(this.nodesKey(), String(instanceId));
        this.assertLeaseSafe();
        return this.parseNode(String(instanceId), raw);
    }

    async updateNodeMetadata(metadata: Omit<MeshNode, 'instanceId' | 'hostname' | 'self'>): Promise<void> {
        this.nodeMetadata = { ...this.nodeMetadata, ...metadata };
        if (!this.running) return;
        const { client } = getMeshRedis();
        this.assertLeaseSafe();
        const updated = await client.UPDATE_METADATA(
            this.heartbeatsKey(),
            this.nodesKey(),
            String(this._instanceId),
            this.serializeNode(),
            String(this.nodeTtlMs)
        );
        if (updated !== 1) {
            this.fenceLeaseLoss(new Error('Mesh membership disappeared while updating node metadata'));
            throw new Error('Mesh membership disappeared while updating node metadata');
        }
        this.assertLeaseSafe();
    }

    async broadcast<K extends keyof B & string>(type: K, data: B[K], options?: MeshBroadcastOptions): Promise<void> {
        this.assertLeaseSafe();

        const message: MeshBroadcast = {
            protocolVersion: 2,
            broadcast: true,
            senderInstanceId: this._instanceId,
            type,
            data
        };
        const payload = this.encodeEnvelope(message);
        this.assertLeaseSafe();
        const publisher = this.getPublisher();
        const publish = publisher.publish;
        if (typeof publish !== 'function') {
            throw new TypeError('Redis publisher does not expose a callable publish method');
        }

        // Recheck immediately before the first delivery side effect. No
        // asynchronous or fallible operation separates local delivery from
        // invoking Redis publish after this point.
        this.assertLeaseSafe();
        if (!options?.skipSelf) {
            // Match local delivery to the exact JSON representation sent to
            // peers (including Date and non-finite number normalization).
            this.handleBroadcastMessage(JSON.parse(payload) as MeshBroadcast);
        }

        try {
            // Local delivery and Redis delivery are now both possible. Any
            // failure after entering the call is therefore ambiguous, even
            // when the publisher throws synchronously.
            await publish.call(publisher, this.broadcastChannel(), payload);
            this.assertLeaseSafe();
        } catch (error) {
            throw new MeshBroadcastIndeterminateDeliveryError(type, error);
        }
    }

    start(): Promise<void> {
        return this.runLifecycle(() => this.startImpl());
    }

    private async startImpl(): Promise<void> {
        if (this.running) {
            throw new Error('MeshService is already running');
        }

        const { client, prefix } = getMeshRedis();
        this.prefix = prefix;
        const generation = ++this.generation;
        this.broadcastGeneration = createBroadcastGeneration(generation);

        // Acquire unique instance ID
        this._instanceId = await client.incr(this.nextIdKey());

        // Redis pub/sub is retained solely for optional fan-out broadcasts.
        const { client: subClient } = createRedis('MESH');
        this.subscriberClient = subClient;

        try {
            const broadcastCh = this.broadcastChannel();
            await subClient.subscribe(broadcastCh);
            subClient.on('message', (channel: string, message: string) => {
                if (generation !== this.generation || channel !== broadcastCh) return;
                this.scheduleIncomingMessage(message, generation);
            });

            // Register heartbeat and node metadata
            const heartbeatStartedAt = performance.now();
            await client.HEARTBEAT(this.heartbeatsKey(), String(this._instanceId), 'create', String(this.nodeTtlMs));
            const metadataWritten = await client.UPDATE_METADATA(
                this.heartbeatsKey(),
                this.nodesKey(),
                String(this._instanceId),
                this.serializeNode(),
                String(this.nodeTtlMs)
            );
            if (metadataWritten !== 1) throw new Error('Mesh membership disappeared during startup metadata registration');
            this.leaseSafeUntil = heartbeatStartedAt + this.nodeTtlMs;
            if (performance.now() >= this.leaseSafeUntil) {
                throw new Error('Mesh membership lease expired during startup');
            }
        } catch (err) {
            if (this.broadcastGeneration.generation === generation) {
                this.broadcastGeneration.abortController.abort(err);
                this.broadcastGeneration = createBroadcastGeneration(this.generation);
            }
            // Clean up subscriber on partial init failure
            try {
                subClient.removeAllListeners('message');
                subClient.disconnect();
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

        this.leaseLost = false;
        this.leaseFencePromise = undefined;
        this.running = true;
        this.armLeaseSafetyTimer(generation);

        // Start heartbeat interval
        this.heartbeatTimer = setInterval(() => this.doHeartbeat(), this.heartbeatIntervalMs);

        // Start leader service for cleanup duties
        this.leaderService = new LeaderService(`mesh:${this.key}`, this.leaderOptions);
        this.leaderService.setBecameLeaderCallback(() => {
            this.leaderEpoch++;
            if (this.running) this.startCleanup();
        });
        this.leaderService.setLostLeaderCallback(() => {
            this.leaderEpoch++;
        });
        this.leaderService.start();

        this.logger.info('mesh node started', { instanceId: this._instanceId, key: this.key });
    }

    stop(): Promise<void> {
        this.running = false;
        this.discardBroadcastGeneration(new Error('MeshService generation stopped'), this.generation);
        return this.runLifecycle(() => this.stopImpl());
    }

    private async stopImpl(): Promise<void> {
        this.running = false;
        this.generation++;
        this.leaderEpoch++;
        this.discardBroadcastGeneration(new Error('MeshService generation stopped'), this.generation);

        // A callback may be arbitrary user code and cannot be forcibly
        // cancelled.  Fence it first, then wait only a bounded period; its
        // processing-list entry is deliberately left for RECOVER_CLEANUP.
        if (this.cleanupDrains.size) await settleMeshCleanup(Promise.allSettled(this.cleanupDrains.values()), 2_000);

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
        this.clearLeaseSafetyTimer();

        // Unsubscribe and quit subscriber
        if (this.subscriberClient) {
            const subscriber = this.subscriberClient;
            this.subscriberClient = null;
            try {
                subscriber.removeAllListeners('message');
                subscriber.disconnect();
            } catch {
                // ignore errors during cleanup
            }
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

    private runLifecycle(operation: () => Promise<void>): Promise<void> {
        const next = this.lifecycle.then(operation, operation);
        this.lifecycle = next.catch(() => {});
        return next;
    }

    private discardBroadcastGeneration(reason: Error, nextGeneration: number): void {
        const state = this.broadcastGeneration;
        this.broadcastGeneration = createBroadcastGeneration(nextGeneration);
        if (!state.abortController.signal.aborted) state.abortController.abort(reason);
        state.activeHandlerCount = 0;
        state.activeHandlerBytes = 0;
    }

    private scheduleIncomingMessage(raw: string, generation: number): void {
        const bytes = Buffer.byteLength(raw);
        if (
            bytes > this.maxMessageBytes ||
            this.activeIncomingMessages >= this.maxActiveHandlers ||
            this.activeIncomingBytes + bytes > this.maxActiveHandlerBytes
        ) {
            this.logger.warn('mesh inbound envelope capacity exceeded');
            return;
        }
        this.activeIncomingMessages++;
        this.activeIncomingBytes += bytes;
        const task = this.handleBroadcastIncoming(raw, generation);
        void task
            .catch(err => this.logger.warn('mesh inbound envelope processing failed', { err }))
            .finally(() => {
                this.activeIncomingMessages = Math.max(0, this.activeIncomingMessages - 1);
                this.activeIncomingBytes = Math.max(0, this.activeIncomingBytes - bytes);
            });
    }

    private encodeEnvelope<TEnvelope extends object>(message: TEnvelope): string {
        const envelope: Record<string, unknown> = {
            ...(message as Record<string, unknown>),
            protocolVersion: 2
        };
        const payload = JSON.stringify(envelope);
        if (Buffer.byteLength(payload) > this.maxMessageBytes) throw new Error('Mesh message exceeds the configured message limit');
        return payload;
    }

    /** @internal Overridable by focused broadcast-delivery tests. */
    private getPublisher(): Pick<MeshRedisClient, 'publish'> {
        return getMeshRedis().client;
    }

    private async validateIncomingSender(envelope: Record<string, unknown>): Promise<boolean> {
        if (!isInstanceId(envelope.senderInstanceId)) return false;
        if (envelope.protocolVersion !== 2) return false;
        try {
            const { client } = getMeshRedis();
            this.assertLeaseSafe();
            const active = (await client.ACTIVE_SCORE(this.heartbeatsKey(), String(envelope.senderInstanceId), String(this.nodeTtlMs))) !== null;
            this.assertLeaseSafe();
            return active;
        } catch (err) {
            this.logger.warn('failed to validate mesh sender lease', { err });
            return false;
        }
    }

    private nextIdKey(): string {
        return `${this.prefix}:mesh:${this.key}:next_id`;
    }

    private serializeNode(): string {
        return JSON.stringify({
            hostname: hostname(),
            ...this.nodeMetadata
        });
    }

    private parseNode(id: string, raw: string | null): MeshNode {
        let metadata: Record<string, unknown> = {};
        if (raw) {
            try {
                const parsed = JSON.parse(raw) as unknown;
                metadata = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { hostname: raw };
            } catch {
                metadata = { hostname: raw };
            }
        }
        return {
            instanceId: parseInt(id, 10),
            hostname: typeof metadata.hostname === 'string' ? metadata.hostname : 'unknown',
            self: parseInt(id, 10) === this._instanceId,
            processId: typeof metadata.processId === 'string' ? metadata.processId : undefined,
            linkEndpointId: typeof metadata.linkEndpointId === 'string' ? metadata.linkEndpointId : undefined,
            linkEndpointPublicKey: typeof metadata.linkEndpointPublicKey === 'string' ? metadata.linkEndpointPublicKey : undefined,
            linkUrl: typeof metadata.linkUrl === 'string' ? metadata.linkUrl : undefined,
            startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : undefined
        };
    }

    private heartbeatsKey(): string {
        return `${this.prefix}:mesh:${this.key}:heartbeats`;
    }

    private nodesKey(): string {
        return `${this.prefix}:mesh:${this.key}:nodes`;
    }

    private cleanupKey(): string {
        return `${this.prefix}:mesh:${this.key}:cleanup`;
    }

    private cleanupProcessingKey(): string {
        return `${this.prefix}:mesh:${this.key}:cleanup:processing`;
    }

    private broadcastChannel(): string {
        return `${this.prefix}:mesh:${this.key}:broadcast`;
    }

    private async doHeartbeat(): Promise<void> {
        const generation = this.generation;
        if (!this.running || this.heartbeatGeneration === generation) return;
        this.heartbeatGeneration = generation;
        let runCleanup = false;

        try {
            try {
                const { client } = getMeshRedis();
                const heartbeatStartedAt = performance.now();
                const renewed = await client.HEARTBEAT(this.heartbeatsKey(), String(this._instanceId), 'renew', String(this.nodeTtlMs));
                if (renewed === 0) {
                    if (generation !== this.generation) return;
                    this.fenceLeaseLoss(new Error('Mesh membership lease was removed or expired'));
                    return;
                }
                if (generation !== this.generation || !this.running) return;
                this.leaseSafeUntil = heartbeatStartedAt + this.nodeTtlMs;
                this.armLeaseSafetyTimer(generation);
            } catch (err) {
                this.logger.warn('mesh heartbeat failed', { err });
                if (generation === this.generation && this.running && performance.now() >= this.leaseSafeUntil) {
                    this.fenceLeaseLoss(new Error('Mesh membership lease can no longer be safely renewed before expiry'));
                    return;
                }
            }

            runCleanup = generation === this.generation && this.running && this.leaderService?.isLeader === true;
        } finally {
            if (this.heartbeatGeneration === generation) this.heartbeatGeneration = null;
        }
        if (runCleanup) this.startCleanup();
    }

    private startCleanup(): void {
        const epochKey = `${this.generation}:${this.leaderEpoch}`;
        if (this.cleanupDrains.has(epochKey)) return;
        // Arbitrary callbacks cannot be killed. Bound retained stale drains,
        // but never let one old epoch monopolize the current leader epoch.
        if (this.cleanupDrains.size >= 8) {
            const leader = this.leaderService;
            this.leaderService = null;
            this.leaderEpoch++;
            void leader?.stop().catch(err => this.logger.warn('failed to relinquish saturated cleanup leadership', { err }));
            this.fenceLeaseLoss(new Error('Mesh cleanup stale-drain limit was exhausted'));
            return;
        }
        const cleanup = this.doCleanup();
        this.cleanupDrains.set(epochKey, cleanup);
        void cleanup.finally(() => {
            if (this.cleanupDrains.get(epochKey) === cleanup) this.cleanupDrains.delete(epochKey);
        });
    }

    private async doCleanup(): Promise<void> {
        const generation = this.generation;
        const leader = this.leaderService;
        const leaderEpoch = this.leaderEpoch;
        // Keep the private/manual maintenance hook usable for focused Redis
        // repair tests; production leader work always captures a live epoch.
        const enforceFence = this.running || leader !== null || this.leaseLost;
        const canContinue = () =>
            !enforceFence ||
            (this.running &&
                generation === this.generation &&
                leader === this.leaderService &&
                leaderEpoch === this.leaderEpoch &&
                leader?.isLeader === true &&
                !this.leaseLost &&
                performance.now() < this.leaseSafeUntil);
        let continueCleanup = false;
        try {
            if (!canContinue()) return;
            const { client } = getMeshRedis();
            const recovered = await client.RECOVER_CLEANUP(this.cleanupKey(), this.cleanupProcessingKey(), String(this.cleanupBatchSize));
            if (!canContinue()) return;
            const expired = await client.CLEANUP(
                this.heartbeatsKey(),
                this.nodesKey(),
                this.cleanupKey(),
                String(this.nodeTtlMs),
                String(this.cleanupBatchSize)
            );
            if (!canContinue()) return;
            continueCleanup = recovered === this.cleanupBatchSize || expired.length === this.cleanupBatchSize;

            if (expired.length > 0) {
                this.logger.info('cleaned up expired mesh nodes', { expired });
            }
            // Keep obligations in Redis until the callback succeeds. A new leader
            // can resume this list after the current process dies.
            for (let count = 0; count < this.cleanupBatchSize; count++) {
                if (!canContinue()) return;
                const claim = await client.CLAIM_CLEANUP(this.cleanupKey(), this.cleanupProcessingKey(), randomUUID());
                if (!canContinue()) return;
                if (!claim) break;
                const idStr = claim.split('|', 1)[0];
                const id = parseInt(idStr, 10);
                try {
                    if (!canContinue()) return;
                    await this.nodeCleanedUpCallback?.(id);
                    // User callbacks cannot be forcibly cancelled without an
                    // API break.  A fenced callback may finish, but it cannot
                    // acknowledge, nack, or cause further framework work.
                    if (!canContinue()) return;
                    await client.ACK_CLEANUP(this.cleanupProcessingKey(), claim);
                    if (!canContinue()) return;
                } catch (err) {
                    if (!canContinue()) return;
                    await client.NACK_CLEANUP(this.cleanupKey(), this.cleanupProcessingKey(), claim);
                    if (!canContinue()) return;
                    this.logger.warn('node cleanup callback error; retained for retry', { err, instanceId: id });
                    break;
                }
                if (count + 1 === this.cleanupBatchSize) continueCleanup = true;
            }
        } catch (err) {
            this.logger.warn('mesh cleanup failed', { err });
        }
        // Each Lua run and each callback drain is bounded. Continue promptly
        // without turning one leader heartbeat into an unbounded Redis script.
        if (continueCleanup && canContinue()) this.scheduleCleanupContinuation();
    }

    private scheduleCleanupContinuation(): void {
        if (!this.running || this.leaderService?.isLeader !== true) return;
        // Defer one turn so the tracked cleanup promise has settled and a new
        // generation cannot be coalesced into the previous fenced pass.
        const timer = setTimeout(() => {
            if (this.running && this.leaderService?.isLeader === true) this.startCleanup();
        }, 0);
        timer.unref?.();
    }

    private fenceLeaseLoss(reason: Error): Promise<void> {
        if (this.leaseLost) return this.leaseFencePromise ?? Promise.resolve();
        this.leaseLost = true;
        // Fence synchronously before invoking user code: renewal is intentionally
        // unable to recreate the sorted-set member after this point.
        this.running = false;
        this.discardBroadcastGeneration(reason, this.generation);
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.clearLeaseSafetyTimer();
        const callback = this.leaseLostCallback;
        let callbackPromise: Promise<void>;
        try {
            // Invoke before joining the serialized lifecycle. Async callbacks run
            // synchronously through their first await, so physical stream fences
            // begin before Redis shutdown or any queued lifecycle operation.
            callbackPromise = Promise.resolve(callback?.(reason));
        } catch (err) {
            callbackPromise = Promise.reject(err);
        }
        const observedCallback = callbackPromise.catch(err => {
            this.logger.warn('mesh lease loss callback error', { err });
        });
        const fence = this.runLifecycle(async () => {
            await this.stopImpl();
            // User cleanup is advisory after the synchronous authority fence.
            // Never let a hung callback poison this or later lifecycle work.
            await settleMeshCleanup(observedCallback, this.leaseLossCallbackTimeoutMs);
        });
        this.leaseFencePromise = fence;
        void fence.catch(err => this.logger.warn('mesh lease fence shutdown failed', { err }));
        return fence;
    }

    private armLeaseSafetyTimer(generation: number): void {
        this.clearLeaseSafetyTimer();
        const delay = Math.max(1, Math.ceil(this.leaseSafeUntil - performance.now()));
        this.leaseSafetyTimer = setTimeout(() => {
            this.leaseSafetyTimer = null;
            if (!this.running || this.generation !== generation) return;
            if (performance.now() < this.leaseSafeUntil) {
                this.armLeaseSafetyTimer(generation);
                return;
            }
            this.fenceLeaseLoss(new Error('Mesh membership lease expired before renewal completed'));
        }, delay);
        this.leaseSafetyTimer.unref?.();
    }

    private clearLeaseSafetyTimer(): void {
        if (!this.leaseSafetyTimer) return;
        clearTimeout(this.leaseSafetyTimer);
        this.leaseSafetyTimer = null;
    }

    private async handleBroadcastIncoming(raw: string, generation = this.generation): Promise<void> {
        if (!this.running || generation !== this.generation) return;
        try {
            this.assertLeaseSafe();
        } catch {
            return;
        }
        if (Buffer.byteLength(raw) > this.maxMessageBytes) return;

        let msg: unknown;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (typeof msg !== 'object' || msg === null) return;

        const envelope = msg as Record<string, unknown>;
        const obj = envelope as unknown as MeshBroadcast;
        // Skip self-sent broadcasts (we already delivered locally in broadcast())
        if (obj.senderInstanceId === this._instanceId) return;

        if (obj.broadcast !== true || !isMessageType(obj.type)) return;
        try {
            this.assertLeaseSafe();
            if (!(await this.validateIncomingSender(envelope))) return;
            this.assertLeaseSafe();
        } catch {
            return;
        }
        if (!this.running || generation !== this.generation) return;
        this.handleBroadcastMessage(obj);
    }

    private handleBroadcastMessage(msg: MeshBroadcast): void {
        const handler = this.broadcastHandlers.get(msg.type);
        if (!handler) return;
        const state = this.broadcastGeneration;
        const messageBytes = jsonByteLength(msg);
        if (state.activeHandlerCount >= this.maxActiveHandlers || state.activeHandlerBytes + messageBytes > this.maxActiveHandlerBytes) {
            this.logger.warn('mesh broadcast handler capacity exceeded', { type: msg.type });
            return;
        }
        state.activeHandlerCount++;
        state.activeHandlerBytes += messageBytes;

        Promise.resolve()
            .then(() => {
                if (state !== this.broadcastGeneration || state.abortController.signal.aborted) return;
                this.assertLeaseSafe();
                return handler(msg.data, msg.senderInstanceId, { signal: state.abortController.signal });
            })
            .catch(err => {
                this.logger.warn('broadcast handler error', { err, type: msg.type });
            })
            .finally(() => {
                state.activeHandlerCount = Math.max(0, state.activeHandlerCount - 1);
                state.activeHandlerBytes = Math.max(0, state.activeHandlerBytes - messageBytes);
            });
    }
}

function createBroadcastGeneration(generation: number): MeshBroadcastGeneration {
    return {
        generation,
        abortController: new AbortController(),
        activeHandlerCount: 0,
        activeHandlerBytes: 0
    };
}

function validateMeshOptions(options?: MeshServiceOptions): void {
    const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 5_000;
    const nodeTtlMs = options?.nodeTtlMs ?? 15_000;
    const maxMessageBytes = options?.maxMessageBytes ?? 1024 * 1024;
    const maxActiveHandlers = options?.maxActiveHandlers ?? 4096;
    const maxActiveHandlerBytes = options?.maxActiveHandlerBytes ?? 64 * 1024 * 1024;
    const cleanupBatchSize = options?.cleanupBatchSize ?? 100;
    for (const [name, value] of [
        ['heartbeatIntervalMs', heartbeatIntervalMs],
        ['nodeTtlMs', nodeTtlMs],
        ['maxMessageBytes', maxMessageBytes],
        ['maxActiveHandlers', maxActiveHandlers],
        ['maxActiveHandlerBytes', maxActiveHandlerBytes],
        ['cleanupBatchSize', cleanupBatchSize]
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`MeshService ${name} must be a positive integer`);
    }
    if (heartbeatIntervalMs > nodeTtlMs) {
        throw new Error('MeshService heartbeat interval must not exceed the node TTL');
    }
    if (heartbeatIntervalMs > MAX_SAFE_TIMER_MS || nodeTtlMs > MAX_SAFE_TIMER_MS) {
        throw new Error('MeshService timer configuration exceeds the platform timer limit');
    }
    if (maxMessageBytes < 1_024) throw new Error('MeshService maxMessageBytes must be at least 1024');
}

function isInstanceId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isMessageType(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

async function settleMeshCleanup(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    await Promise.race([
        promise.then(
            () => undefined,
            () => undefined
        ),
        new Promise<void>(resolve => {
            const timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        })
    ]);
}

function jsonByteLength(value: unknown): number {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : Buffer.byteLength(encoded);
}
