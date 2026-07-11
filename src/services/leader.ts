import { randomUUID } from 'node:crypto';

import { getAppConfig } from '../app/resolver';
import { getPackageName } from '../helpers/io/package';
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

let redisClient: LeaderRedisClient | undefined;

function getRedisClient(): LeaderRedisClient {
    if (!redisClient) {
        const { client } = createRedis('MUTEX');
        client.defineCommand('ACQUIRE', { lua: ACQUIRE_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('RENEW', { lua: RENEW_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('RELEASE', { lua: RELEASE_SCRIPT, numberOfKeys: 1 });
        redisClient = client as LeaderRedisClient;
    }
    return redisClient;
}

type LeaderCallback = () => void | Promise<void>;

export interface LeaderServiceOptions {
    ttlMs?: number;
    renewalIntervalMs?: number;
    retryDelayMs?: number;
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

    private logger = createLogger(this);

    constructor(key: string, options?: LeaderServiceOptions) {
        const config = getAppConfig();
        const prefix = config.MUTEX_REDIS_PREFIX ?? config.REDIS_PREFIX ?? getPackageName() ?? 'app';
        this.key = `${prefix}:leader:${key}`;
        this.ttlMs = options?.ttlMs ?? 30000;
        this.renewalIntervalMs = options?.renewalIntervalMs ?? 10000;
        this.retryDelayMs = options?.retryDelayMs ?? 5000;
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

        if (this.renewTimer) {
            clearInterval(this.renewTimer);
            this.renewTimer = null;
        }

        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        if (this._isLeader) {
            try {
                await getRedisClient().RELEASE(this.key, this.lockId);
            } catch (err) {
                this.logger.warn('failed to release leader lock during stop', { err });
            }
            this._isLeader = false;
        }
    }

    private async tryAcquire(): Promise<void> {
        if (!this.running) return;

        try {
            const result = await getRedisClient().ACQUIRE(this.key, this.lockId, this.ttlMs);

            if (result === 1) {
                // If stop() was called while ACQUIRE was in-flight, release immediately
                if (!this.running) {
                    try {
                        await getRedisClient().RELEASE(this.key, this.lockId);
                    } catch {
                        // ignore - lock will expire via TTL
                    }
                    return;
                }

                this._isLeader = true;
                this.logger.info('became leader', { key: this.key });
                this.startRenewal();
                try {
                    await this.becameLeaderCallback?.();
                } catch (err) {
                    this.logger.warn('becameLeader callback error', { err });
                }
                return;
            }
        } catch (err) {
            this.logger.warn('error during leader acquisition', { err });
        }

        if (this.running) {
            this.retryTimer = setTimeout(() => this.tryAcquire(), this.retryDelayMs);
        }
    }

    private startRenewal(): void {
        this.renewTimer = setInterval(async () => {
            if (!this.running) return;

            try {
                const result = await getRedisClient().RENEW(this.key, this.lockId, this.ttlMs);
                if (result === 0) {
                    this.handleLostLeadership();
                }
            } catch (err) {
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
