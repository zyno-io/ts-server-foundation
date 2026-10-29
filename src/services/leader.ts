import { randomUUID } from 'node:crypto';

import { registerRedisStateReset } from '../helpers/redis/lifecycle';
import { getRedisPrefix } from '../helpers/redis/prefix';
import { createRedis } from '../helpers/redis/redis';
import { createLogger } from './logger';

const ACQUIRE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 1 then
    return 0
end
redis.call("set", KEYS[1], ARGV[1], "px", ARGV[2])
return 1
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call("pexpire", KEYS[1], ARGV[2])
return 1
`;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call("del", KEYS[1])
return 1
`;

type LeaderRedisClient = ReturnType<typeof createRedis>['client'] & {
    ACQUIRE: (key: string, value: string, ttl: number) => Promise<number>;
    RENEW: (key: string, value: string, ttl: number) => Promise<number>;
    RELEASE: (key: string, value: string) => Promise<number>;
};

const redisClients = new Map<string, LeaderRedisClient>();

function getRedisClient(configPrefix: string): LeaderRedisClient {
    const existing = redisClients.get(configPrefix);
    if (!existing) {
        const { client } = createRedis(configPrefix);
        client.defineCommand('ACQUIRE', { lua: ACQUIRE_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('RENEW', { lua: RENEW_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('RELEASE', { lua: RELEASE_SCRIPT, numberOfKeys: 1 });
        const nextClient = client as LeaderRedisClient;
        registerRedisStateReset(nextClient, () => {
            if (redisClients.get(configPrefix) === nextClient) redisClients.delete(configPrefix);
        });
        redisClients.set(configPrefix, nextClient);
    }
    return redisClients.get(configPrefix)!;
}

type LeaderCallback = () => void | Promise<void>;

export interface LeaderServiceOptions {
    ttlMs?: number;
    renewalIntervalMs?: number;
    retryDelayMs?: number;
    /** Redis configuration namespace, such as `BULL`; defaults to `MUTEX`. */
    redisConfigPrefix?: string;
    /** Relinquish the lease and retry election if the became-leader callback fails. */
    retryOnCallbackError?: boolean;
}

export class LeaderService {
    private lockId = randomUUID();
    private key: string;
    private _isLeader = false;
    private running = false;
    private renewTimer: ReturnType<typeof setInterval> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    private becameLeaderCallback: LeaderCallback | null = null;
    private lostLeaderCallback: LeaderCallback | null = null;

    private ttlMs: number;
    private renewalIntervalMs: number;
    private retryDelayMs: number;
    private readonly redisConfigPrefix: string;
    private readonly retryOnCallbackError: boolean;

    private logger = createLogger(this);

    constructor(key: string, options?: LeaderServiceOptions) {
        this.redisConfigPrefix = options?.redisConfigPrefix ?? 'MUTEX';
        this.retryOnCallbackError = options?.retryOnCallbackError ?? false;
        const prefix = getRedisPrefix(this.redisConfigPrefix);
        this.key = `${prefix}:leader:${key}`;
        this.ttlMs = options?.ttlMs ?? 30000;
        this.renewalIntervalMs = options?.renewalIntervalMs ?? 10000;
        this.retryDelayMs = options?.retryDelayMs ?? 5000;
    }

    private getRedisClient(): LeaderRedisClient {
        return getRedisClient(this.redisConfigPrefix);
    }

    get isLeader(): boolean {
        return this._isLeader;
    }

    setBecameLeaderCallback(callback: LeaderCallback): void {
        this.becameLeaderCallback = callback;
    }

    setLostLeaderCallback(callback: LeaderCallback): void {
        this.lostLeaderCallback = callback;
    }

    start(): void {
        if (this.running) {
            throw new Error('LeaderService is already running');
        }

        this.running = true;
        this.logger.info('starting leader election', { key: this.key });
        this.tryAcquire();
    }

    async stop(): Promise<void> {
        this.running = false;
        const lockId = this.lockId;
        const wasLeader = this._isLeader;
        this._isLeader = false;
        this.lockId = randomUUID();

        if (this.renewTimer) {
            clearInterval(this.renewTimer);
            this.renewTimer = null;
        }

        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        if (wasLeader) {
            try {
                await this.getRedisClient().RELEASE(this.key, lockId);
            } catch (err) {
                this.logger.warn('failed to release leader lock during stop', { err });
            }
        }
    }

    private async tryAcquire(): Promise<void> {
        if (!this.running) return;
        const lockId = this.lockId;

        try {
            const result = await this.getRedisClient().ACQUIRE(this.key, lockId, this.ttlMs);

            if (result === 1) {
                // A stopped/restarted election cannot adopt an older in-flight acquisition.
                if (!this.running || this.lockId !== lockId) {
                    try {
                        await this.getRedisClient().RELEASE(this.key, lockId);
                    } catch {
                        // ignore - lock will expire via TTL
                    }
                    return;
                }

                this._isLeader = true;
                this.logger.info('became leader', { key: this.key });
                this.startRenewal();
                const acquiredLockId = lockId;
                try {
                    await this.becameLeaderCallback?.();
                } catch (err) {
                    this.logger.warn('becameLeader callback error', { err, key: this.key });
                    // Failed startup must not leave a renewed lease with no service behind it.
                    // A callback can outlive its lease; only abandon the acquisition it belongs to.
                    if (this.retryOnCallbackError && this._isLeader && this.lockId === acquiredLockId) {
                        this.handleLostLeadership();
                        try {
                            await this.getRedisClient().RELEASE(this.key, acquiredLockId);
                        } catch (releaseError) {
                            this.logger.warn('failed to release leader lock after callback error', { err: releaseError, key: this.key });
                        }
                    }
                }
                return;
            }
        } catch (err) {
            if (this.lockId !== lockId) return;
            this.logger.warn('error during leader acquisition', { err });
        }

        if (this.running && this.lockId === lockId) {
            this.retryTimer = setTimeout(() => this.tryAcquire(), this.retryDelayMs);
        }
    }

    private startRenewal(): void {
        const lockId = this.lockId;
        this.renewTimer = setInterval(async () => {
            if (!this.running || !this._isLeader || this.lockId !== lockId) return;

            try {
                const result = await this.getRedisClient().RENEW(this.key, lockId, this.ttlMs);
                if (result === 0 && this.lockId === lockId) {
                    this.handleLostLeadership();
                }
            } catch (err) {
                if (this.lockId !== lockId) return;
                this.logger.warn('error during leader renewal', { err });
                this.handleLostLeadership();
            }
        }, this.renewalIntervalMs);
    }

    private handleLostLeadership(): void {
        if (!this._isLeader) return;

        this._isLeader = false;
        this.logger.info('lost leadership', { key: this.key });

        if (this.renewTimer) {
            clearInterval(this.renewTimer);
            this.renewTimer = null;
        }

        Promise.resolve()
            .then(() => this.lostLeaderCallback?.())
            .catch(err => {
                this.logger.warn('lostLeader callback error', { err });
            });

        this.lockId = randomUUID();

        if (this.running) {
            this.retryTimer = setTimeout(() => this.tryAcquire(), this.retryDelayMs);
        }
    }
}
