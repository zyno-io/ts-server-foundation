import { type RedisEndEmitter, registerRedisStateReset } from './lifecycle';
import { createRedis, type RedisConnection } from './redis';

export interface CacheRedisClient {
    get(key: string): Promise<string | null> | string | null;
    set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown> | unknown;
}

export type CacheRedisProvider = () => RedisConnection<CacheRedisClient>;

let defaultRedisConnection: RedisConnection<CacheRedisClient> | undefined;

function getDefaultRedisConnection(): RedisConnection<CacheRedisClient> {
    if (!defaultRedisConnection) {
        const connection = createRedis('CACHE') as RedisConnection<CacheRedisClient & RedisEndEmitter>;
        registerRedisStateReset(connection.client, () => {
            if (defaultRedisConnection === connection) defaultRedisConnection = undefined;
        });
        defaultRedisConnection = connection;
    }
    return defaultRedisConnection;
}

export function resetCacheRedisConnection(): void {
    defaultRedisConnection = undefined;
}

export class Cache {
    constructor(private readonly getRedis: CacheRedisProvider = getDefaultRedisConnection) {}

    async get(key: string): Promise<string | null> {
        const { client, prefix } = this.getRedis();
        return client.get(cacheKey(prefix, key));
    }

    async set(key: string, value: string, ttl = 60): Promise<void> {
        const { client, prefix } = this.getRedis();
        await client.set(cacheKey(prefix, key), value, 'EX', ttl);
    }

    async getObj<T>(key: string): Promise<T | null> {
        const value = await this.get(key);
        return value ? (JSON.parse(value) as T) : null;
    }

    async setObj<T>(key: string, value: T, ttl = 60): Promise<void> {
        await this.set(key, JSON.stringify(value), ttl);
    }

    static get(key: string): Promise<string | null> {
        return defaultCache.get(key);
    }

    static set(key: string, value: string, ttl = 60): Promise<void> {
        return defaultCache.set(key, value, ttl);
    }

    static getObj<T>(key: string): Promise<T | null> {
        return defaultCache.getObj<T>(key);
    }

    static setObj<T>(key: string, value: T, ttl = 60): Promise<void> {
        return defaultCache.setObj(key, value, ttl);
    }
}

function cacheKey(prefix: string, key: string): string {
    return `${prefix}:cache:${key}`;
}

const defaultCache = new Cache(getDefaultRedisConnection);
