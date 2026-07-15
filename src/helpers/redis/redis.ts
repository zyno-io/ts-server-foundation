import Redis, { type RedisOptions } from 'ioredis';

import { getAppConfig, registerAppCleanup } from '../../app/resolver';
import { getPackageName } from '../io/package';

export interface RedisConnection<TClient = Redis> {
    client: TClient;
    prefix: string;
}

export function createRedisOptions(configPrefix?: string): {
    options: RedisOptions;
    prefix: string;
} {
    const config = { ...getAppConfig() } as Record<string, unknown>;

    if (configPrefix) {
        for (const key of Object.keys(config)) {
            if (key.startsWith(`${configPrefix}_REDIS_`)) {
                if (config[key] === undefined) continue;
                config[key.substring(configPrefix.length + 1)] = config[key];
            }
        }
    }

    const prefix = String(config.REDIS_PREFIX ?? getPackageName() ?? 'app');

    if (config.REDIS_SENTINEL_HOST) {
        return {
            prefix,
            options: {
                sentinels: [
                    {
                        host: String(config.REDIS_SENTINEL_HOST),
                        port: Number(config.REDIS_SENTINEL_PORT ?? 26379)
                    }
                ],
                name: config.REDIS_SENTINEL_NAME ? String(config.REDIS_SENTINEL_NAME) : undefined,
                failoverDetector: true,
                sentinelMaxConnections: 1,
                reconnectOnError: error => (error.message.startsWith('READONLY') ? 2 : false)
            }
        };
    }

    if (config.REDIS_HOST) {
        return {
            prefix,
            options: {
                host: String(config.REDIS_HOST),
                port: Number(config.REDIS_PORT ?? 6379)
            }
        };
    }

    throw new Error('REDIS_HOST or REDIS_SENTINEL_HOST must be configured');
}

const allClients = new Set<Redis>();

export function createRedis(configPrefix?: string): RedisConnection {
    const { options, prefix } = createRedisOptions(configPrefix);
    const client = new Redis(options);
    allClients.add(client);
    const unregisterCleanup = registerAppCleanup(() => closeRedisClient(client));
    client.on('end', () => {
        allClients.delete(client);
        unregisterCleanup();
    });
    return { client, prefix };
}

export async function disconnectAllRedis(): Promise<void> {
    const clients = [...allClients];
    allClients.clear();
    await Promise.all(clients.map(closeRedisClient));
}

async function closeRedisClient(client: Redis): Promise<void> {
    if (client.status === 'end') return;
    try {
        await client.quit();
    } catch {
        client.disconnect();
    }
}
