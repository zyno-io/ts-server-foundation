import { registerAppCleanup } from '../../app/resolver';
import { isRedisClientRecovering } from './recovery';

export interface RedisEndEmitter {
    once(event: 'end', listener: () => void): unknown;
}

/**
 * Invalidates module-level state that retains Redis clients across application lifetimes.
 *
 * The recovering client factory owns closing each client during app shutdown, but helpers such as Cache, Mutex, and Mesh
 * also cache those clients in module-level variables. Those references must be cleared synchronously before
 * the next app can reuse the helper; waiting only for ioredis's asynchronous `end` event can briefly expose a
 * closed client to the new app. Managed clients can recover after an unexpected
 * `end`; only their explicit shutdown invalidates cached state.
 *
 * This registers `reset` as an app cleanup and also attaches it to each supplied client's `end` event. The
 * first trigger wins: `reset` runs exactly once, and an early client disconnect unregisters the now-unneeded
 * app cleanup. Supplying multiple clients supports state, such as the broadcast runtime, that becomes invalid
 * as soon as any one of its clients ends.
 *
 * This helper only invalidates the caller's cached state. The client factory registers shutdown separately.
 */
export function registerRedisStateReset(clients: RedisEndEmitter | readonly RedisEndEmitter[], reset: () => void): void {
    const redisClients = Array.isArray(clients) ? clients : [clients as RedisEndEmitter];
    let resetPending = true;
    let unregisterReset = () => {};
    const resetOnce = () => {
        if (!resetPending) return;
        resetPending = false;
        try {
            reset();
        } finally {
            unregisterReset();
        }
    };

    unregisterReset = registerAppCleanup(resetOnce);
    for (const client of redisClients) {
        const handleEnd = () => {
            if (isRedisClientRecovering(client)) client.once('end', handleEnd);
            else resetOnce();
        };
        client.once('end', handleEnd);
    }
}
