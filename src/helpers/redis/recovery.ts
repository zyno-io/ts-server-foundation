import Redis, { type RedisOptions } from 'ioredis';

const recoveringClients = new WeakSet<object>();

/** Whether an end event is transient rather than an explicit client shutdown. */
export function isRedisClientRecovering(client: object): boolean {
    return recoveringClients.has(client);
}

export function createRecoveringRedisClient(options: RedisOptions): Redis {
    return manageRedisClient(new Redis(options));
}

function manageRedisClient(client: Redis): Redis {
    const connect = client.connect.bind(client);
    const disconnect = client.disconnect.bind(client);
    const sendCommand = client.sendCommand.bind(client);
    const duplicate = client.duplicate.bind(client);
    let timer: NodeJS.Timeout | undefined;
    let failures = 0;
    recoveringClients.add(client);

    const clearRetry = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
    };
    const stop = () => {
        recoveringClients.delete(client);
        clearRetry();
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
        timer = setTimeout(reconnect, Math.min(1_000 * 2 ** Math.min(failures++, 5), 30_000));
        timer.unref();
    };

    client.connect = callback => {
        // BullMQ deliberately disconnects and reconnects blocking clients when
        // abandoning a stuck read. An explicit connect starts a new lifetime.
        recoveringClients.add(client);
        return connect(callback);
    };
    client.disconnect = (reconnect = false) => {
        if (!reconnect) stop();
        disconnect(reconnect);
    };
    client.sendCommand = (command, stream) => {
        if (command.name === 'quit') stop();
        else reconnect();
        return sendCommand(command, stream);
    };
    client.duplicate = ((...args: Parameters<Redis['duplicate']>) => manageRedisClient(duplicate(...args))) as Redis['duplicate'];
    client.on('ready', () => {
        failures = 0;
        clearRetry();
    });
    client.on('end', () => {
        if (client.status !== 'end') return;
        // Also release Sentinel's separate failover subscription and retry timer.
        disconnect(isRedisClientRecovering(client));
        scheduleRetry();
    });
    return client;
}

export function isRedisConnectionClosedError(error: unknown): boolean {
    return error instanceof Error && error.message === 'Connection is closed.';
}
