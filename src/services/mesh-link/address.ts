import type { Server } from 'node:http';
import { networkInterfaces } from 'node:os';

import { getCurrentApp } from '../../app';

export interface MeshLinkAddressOptions {
    advertiseUrl?: string;
    path: string;
    httpServer?: Server;
}

export function resolveMeshLinkAdvertiseUrl(options: MeshLinkAddressOptions): string {
    if (options.advertiseUrl) return normalizeWebSocketUrl(options.advertiseUrl, options.path);

    const configuredPodIp = process.env.POD_IP?.trim();
    const host = configuredPodIp || detectMeshIpAddress();
    const port = resolveListeningPort(options.httpServer);
    const bracketedHost = host.includes(':') ? `[${host}]` : host;
    return `ws://${bracketedHost}:${port}${normalizePath(options.path)}`;
}

export function detectMeshIpAddress(): string {
    const candidates = Object.values(networkInterfaces())
        .flatMap(entries => entries ?? [])
        .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 'IPv6'));
    const ipv4 = candidates.find(entry => entry.family === 'IPv4');
    const selected = ipv4 ?? candidates[0];
    if (!selected) throw new Error('Unable to detect a non-loopback IP address for the sRPC mesh link');
    return selected.address;
}

function resolveListeningPort(httpServer?: Server): number {
    const address = httpServer?.address() ?? getOptionalAppAddress();
    if (address && typeof address === 'object') return address.port;
    if (typeof address === 'string') throw new Error('sRPC mesh links require a TCP HTTP listener');

    try {
        return getCurrentApp().http.getPort();
    } catch {
        throw new Error('Unable to determine the sRPC mesh link port; provide meshLink.advertiseUrl');
    }
}

function getOptionalAppAddress(): ReturnType<Server['address']> {
    try {
        return getCurrentApp().http.getAddress();
    } catch {
        return null;
    }
}

function normalizeWebSocketUrl(value: string, defaultPath: string): string {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('sRPC mesh advertised URL must use ws: or wss:');
    }
    if (!url.pathname || url.pathname === '/') url.pathname = normalizePath(defaultPath);
    url.search = '';
    url.hash = '';
    return url.toString();
}

function normalizePath(path: string): string {
    if (!path.startsWith('/')) return `/${path}`;
    return path;
}
