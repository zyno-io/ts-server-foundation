import Redis, { type RedisOptions } from 'ioredis';

import type { App } from '../../app/base';
import { getCurrentApp } from '../../app/current';

const recoveringClients = new WeakSet<object>();
const allClients = new Set<Redis>();
const REDIS_SHUTDOWN_GRACE_MS = 1_000;

/** Whether an end event is transient rather than an explicit client shutdown. */
export function isRedisClientRecovering(client: object): boolean {
    return recoveringClients.has(client);
}

/** Own the client through the current app when present; standalone callers close it explicitly. */
export function createRecoveringRedisClient(options: RedisOptions): Redis {
    let owner: App | undefined;
    try {
        owner = getCurrentApp();
    } catch {
        // Standalone clients, including worker threads, have no application owner.
    }
    return manageRedisClient(new Redis(options), owner);
}

function manageRedisClient(client: Redis, owner: App | undefined): Redis {
    const connect = client.connect.bind(client);
    const disconnect = client.disconnect.bind(client);
    const sendCommand = client.sendCommand.bind(client);
    const duplicate = client.duplicate.bind(client);
    let timer: NodeJS.Timeout | undefined;
    let failures = 0;
    let unregisterCleanup: (() => void) | undefined;

    const track = () => {
        recoveringClients.add(client);
        if (unregisterCleanup) return;
        allClients.add(client);
        const unregisterAppCleanup = owner?.registerCleanup(() => closeRedisClient(client));
        unregisterCleanup = () => {
            allClients.delete(client);
            unregisterAppCleanup?.();
        };
    };
    track();

    const clearRetry = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
    };
    const pauseRecovery = () => {
        recoveringClients.delete(client);
        clearRetry();
    };
    const stop = () => {
        pauseRecovery();
        unregisterCleanup?.();
        unregisterCleanup = undefined;
    };
    const reconnect = () => {
        if (!isRedisClientRecovering(client) || client.status !== 'end') return;
        clearRetry();
        // connect() changes status synchronously, so simultaneous commands share
        // one attempt and enter ioredis's normal offline queue. Never replay a
        // command whose execution on Redis may already have happened.
        void client.connect().catch(scheduleRetry);
    };
    const scheduleRetry = () => {
        if (!isRedisClientRecovering(client) || client.status !== 'end' || timer) return;
        timer = setTimeout(
            () => {
                timer = undefined;
                reconnect();
            },
            Math.min(1_000 * 2 ** Math.min(failures++, 5), 30_000)
        );
        timer.unref();
    };

    client.connect = callback => {
        // BullMQ deliberately disconnects and reconnects blocking clients when
        // abandoning a stuck read. An explicit connect starts a new lifetime.
        track();
        clearRetry();
        return connect(callback);
    };
    client.disconnect = (reconnect = false) => {
        if (!reconnect) stop();
        disconnect(reconnect);
    };
    client.sendCommand = (command, stream) => {
        if (command.name === 'quit') {
            // A rejected or blocked QUIT has not released the connection yet.
            pauseRecovery();
            if (client.status === 'end') stop();
        } else reconnect();
        return sendCommand(command, stream);
    };
    // Duplicates belong to the original owner even if another app is now current.
    client.duplicate = ((...args: Parameters<Redis['duplicate']>) => manageRedisClient(duplicate(...args), owner)) as Redis['duplicate'];
    client.on('ready', () => {
        failures = 0;
        clearRetry();
    });
    client.on('end', () => {
        if (client.status !== 'end') return;
        const recovering = isRedisClientRecovering(client);
        if (!recovering) stop();
        // Also release Sentinel's separate failover subscription and retry timer.
        disconnect(recovering);
        scheduleRetry();
    });
    return client;
}

export async function disconnectAllRedis(): Promise<void> {
    const clients = [...allClients];
    allClients.clear();
    await Promise.all(clients.map(closeRedisClient));
}

/** Close a client and stop recovery, including non-ready connections and failed QUITs. */
export async function closeRedisClient(client: Pick<Redis, 'status' | 'quit' | 'disconnect'>): Promise<void> {
    if (client.status !== 'ready') {
        client.disconnect();
        return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            client.quit(),
            new Promise<void>(resolve => {
                // QUIT may be queued behind an indefinite blocking command.
                timer = setTimeout(resolve, REDIS_SHUTDOWN_GRACE_MS);
                timer.unref();
            })
        ]);
    } catch {
        // A disconnected server cannot acknowledge QUIT.
    } finally {
        if (timer) clearTimeout(timer);
        client.disconnect();
    }
}

export function isRedisConnectionClosedError(error: unknown): boolean {
    return error instanceof Error && error.message === 'Connection is closed.';
}
