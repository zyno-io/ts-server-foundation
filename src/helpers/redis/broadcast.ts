import type { ReceiveType } from '../../reflection';
import { hostname } from 'node:os';

import { r } from '../../app/resolver';
import { Logger } from '../../services/logger';
import { registerRedisStateReset } from './lifecycle';
import { createRedis } from './redis';

interface BroadcastLogger {
    error(...messages: unknown[]): void;
}

let sharedBroadcastChannel: ReturnType<typeof createSharedBroadcastChannel> | undefined;

function getSharedBroadcastChannel(): ReturnType<typeof createSharedBroadcastChannel> {
    sharedBroadcastChannel ??= createSharedBroadcastChannel();
    return sharedBroadcastChannel;
}

function createSharedBroadcastChannel() {
    const logger = r(Logger).scoped('Broadcast');
    const { prefix, client: publishClient } = createRedis('BROADCAST');
    const { client: subscribeClient } = createRedis('BROADCAST');

    const channel = `${prefix}:broadcast`;
    const localInstanceKey = `${hostname()}/${process.pid}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners = new Map<string, Set<(message: any) => void>>();

    subscribeClient.subscribe(channel);
    subscribeClient.on('message', (_, message) => {
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
    });

    const runtime = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscribe: (eventName: string, fn: (data: any) => void) => {
            const listenersForEvent = listeners.get(eventName) ?? new Set();
            listenersForEvent.add(fn);
            listeners.set(eventName, listenersForEvent);
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        publish: (eventName: string, data: any) => {
            publishClient.publish(channel, JSON.stringify({ instanceKey: localInstanceKey, eventName, data }));
        }
    };

    registerRedisStateReset([publishClient, subscribeClient], () => {
        if (sharedBroadcastChannel === runtime) sharedBroadcastChannel = undefined;
    });

    return runtime;
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

        publish: (data: T) => {
            channel.publish(eventName, data);
        }
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

    // publish & invoke locally when locally executed
    return (data: T) => {
        channel.publish(data);
        return wrappedFn(data);
    };
}
