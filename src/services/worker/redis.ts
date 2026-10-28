import { createRedisBackend, type BackendFactory, type RedisQueueBackend } from 'bullmq';
import { type RedisOptions } from 'ioredis';

import { createRecoveringRedisClient } from '../../helpers/redis/recovery';

/** Scope resilient clients to TSF queues, including BullMQ's blocking duplicates. */
export const createWorkerRedisBackend: BackendFactory<RedisQueueBackend> = (name, options, extra) => {
    const client = createRecoveringRedisClient(options.connection as RedisOptions);
    const backend = createRedisBackend(name, { ...options, connection: client }, extra);
    const close = backend.close.bind(backend);
    // BullMQ treats a supplied client as shared. This factory owns that client.
    backend.close = async force => {
        try {
            await close(force);
        } finally {
            client.disconnect();
        }
    };
    return backend;
};
