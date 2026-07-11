import { ref } from 'vue';

import { DevConsoleClientMessage, DevConsoleServerMessage } from '../../src/devconsole/generated/devconsole';
import { SrpcBrowserClient } from './srpc-client';

function getWsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/_devconsole/ws`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandler = (data: any) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

const client = new SrpcBrowserClient<DevConsoleClientMessage, DevConsoleServerMessage>(
    getWsUrl(),
    DevConsoleClientMessage,
    DevConsoleServerMessage,
    'devconsole-browser'
);

// Handle server-pushed events via the SRPC dEvent request
client.registerMessageHandler('dEvent', (data: { type: string; jsonData: string }) => {
    const handlers = eventHandlers.get(data.type);
    if (handlers) {
        const parsed = JSON.parse(data.jsonData);
        for (const handler of handlers) {
            handler(parsed);
        }
    }
    return {};
});

export const connected = ref(false);

// Promise that resolves once the sRPC connection is established.
// Re-created on each reconnect so callers always wait for a live connection.
let readyResolve: (() => void) | null = null;
let readyPromise = new Promise<void>(resolve => {
    readyResolve = resolve;
});

client.onConnect(() => {
    connected.value = true;
    readyResolve?.();
});
client.onDisconnect(() => {
    connected.value = false;
    readyPromise = new Promise<void>(resolve => {
        readyResolve = resolve;
    });
});

function on(type: string, handler: EventHandler) {
    let set = eventHandlers.get(type);
    if (!set) {
        set = new Set();
        eventHandlers.set(type, set);
    }
    set.add(handler);
}

function off(type: string, handler: EventHandler) {
    const set = eventHandlers.get(type);
    if (set) {
        set.delete(handler);
        if (set.size === 0) eventHandlers.delete(type);
    }
}

async function invoke(prefix: string, data: Record<string, unknown>) {
    await readyPromise;
    return client.invoke(prefix, data);
}

export const ws = {
    connect: () => client.connect(),
    on,
    off,
    invoke,
    connected
};
