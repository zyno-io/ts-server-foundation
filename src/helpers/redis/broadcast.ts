import type { ReceiveType } from '../../reflection';
import { hostname } from 'node:os';

import { r, registerAppCleanup } from '../../app/resolver';
import { Logger } from '../../services/logger';
import { registerRedisStateReset } from './lifecycle';
import { createRedis } from './redis';

interface BroadcastLogger {
    error(...messages: unknown[]): void;
}

const RECONNECT_DELAY_MS = 1_000;

let sharedBroadcastChannel: ReturnType<typeof createSharedBroadcastChannel> | undefined;

function getSharedBroadcastChannel(): ReturnType<typeof createSharedBroadcastChannel> {
    sharedBroadcastChannel ??= createSharedBroadcastChannel();
    return sharedBroadcastChannel;
}

function createSharedBroadcastChannel() {
    const logger = r(Logger).scoped('Broadcast');
    const localInstanceKey = `${hostname()}/${process.pid}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners = new Map<string, Set<(message: any) => void>>();
    let activeRuntime:
        | { publishClient: ReturnType<typeof createRedis>['client']; subscribeClient: ReturnType<typeof createRedis>['client']; channel: string }
        | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let disposed = false;
    let unregisterDispose = () => {};

    const onMessage = (_channel: string, message: string) => {
        try {
            const { instanceKey, eventName, data } = JSON.parse(message);
            if (instanceKey === localInstanceKey) return;
            const listenersForEvent = listeners.get(eventName);
            if (!listenersForEvent) return;
            for (const listener of listenersForEvent) {
                try {
                    listener(data);
                } catch (err) {
                    logger.error(`Failed to handle broadcast message`, err, { eventName });
                }
            }
        } catch (err) {
            logger.error('Failed to parse broadcast message', err, message);
        }
    };

    const scheduleReconnect = () => {
        if (disposed || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (disposed || activeRuntime) return;
            try {
                connect();
            } catch (err) {
                logger.error('Failed to reconnect broadcast channel', err);
                scheduleReconnect();
            }
        }, RECONNECT_DELAY_MS);
        reconnectTimer.unref();
    };

    const connect = () => {
        if (disposed) throw new Error('Broadcast channel is closed');
        if (activeRuntime) return activeRuntime;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
        }

        const { prefix, client: publishClient } = createRedis('BROADCAST');
        const { client: subscribeClient } = createRedis('BROADCAST');
        const channel = `${prefix}:broadcast`;
        const runtime = { publishClient, subscribeClient, channel };
        activeRuntime = runtime;

        void subscribeClient.subscribe(channel).catch(err => {
            if (subscribeClient.status !== 'end') logger.error('Failed to subscribe to broadcast channel', err, { channel });
        });
        subscribeClient.on('message', onMessage);

        registerRedisStateReset([publishClient, subscribeClient], () => {
            if (activeRuntime !== runtime) return;
            activeRuntime = undefined;
            subscribeClient.off('message', onMessage);
            if (publishClient.status !== 'end') publishClient.disconnect();
            if (subscribeClient.status !== 'end') subscribeClient.disconnect();
            scheduleReconnect();
        });

        // Register after the clients so this runs before their cleanup on app shutdown.
        unregisterDispose();
        unregisterDispose = registerAppCleanup(() => {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            activeRuntime = undefined;
            listeners.clear();
            if (sharedBroadcastChannel === state) sharedBroadcastChannel = undefined;
        });

        return runtime;
    };

    const state = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscribe: (eventName: string, fn: (data: any) => void) => {
            const listenersForEvent = listeners.get(eventName) ?? new Set();
            listenersForEvent.add(fn);
            listeners.set(eventName, listenersForEvent);
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        publish: async (eventName: string, data: any): Promise<void> => {
            const { publishClient, channel } = connect();
            await publishClient.publish(channel, JSON.stringify({ instanceKey: localInstanceKey, eventName, data }));
        }
    };

    connect();
    return state;
}

export function createBroadcastChannel<T>(eventName: string, _type?: ReceiveType<T>) {
    const channel = getSharedBroadcastChannel();

    return {
        subscribe: (fn: (data: T) => void) => {
            channel.subscribe(eventName, data => {
                // todo: figure out type validation
                // assert<T>(data, undefined, type);
                fn(data);
            });
        },

        publish: (data: T): Promise<void> => channel.publish(eventName, data)
    };
}

interface IDistributedMethodOptions {
    name: string;
    logger?: () => BroadcastLogger;
}
export function createDistributedMethod<T>(options: IDistributedMethodOptions, fn: (data: T) => Promise<void>, type?: ReceiveType<T>) {
    const getLogger = options.logger ?? (() => r(Logger).scoped(`Distributed:${options.name}`));
    const channel = createBroadcastChannel(options.name, type);

    const wrappedFn = async (data: T) => {
        try {
            await fn(data);
        } catch (err) {
            getLogger().error(`Error executing ${options.name} distributed method`, err);
        }
    };

    // invoke locally when remotely requested
    channel.subscribe(wrappedFn);

    // Publish to peers while invoking locally. Local failures are returned to
    // the caller so durable consumers can decide whether to retry; peer
    // handler failures remain isolated and logged by wrappedFn.
    return async (data: T): Promise<void> => {
        const [publishResult, localResult] = await Promise.allSettled([channel.publish(data), fn(data)]);
        if (localResult.status === 'rejected') throw localResult.reason;
        if (publishResult.status === 'rejected') throw publishResult.reason;
    };
}
