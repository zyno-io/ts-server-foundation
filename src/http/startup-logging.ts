import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ScopedLogger } from '../services';
import type { ClassType } from '../types';
import type { HttpRoutePlan } from './router';

export function logStartupDetails(logger: ScopedLogger, packageName: string, routes: readonly HttpRoutePlan[]): void {
    logger.info(`Starting ${packageName}`, { packageName });
    logger.info('HTTP routes registered', { routeCount: routes.length });
    for (const group of groupRoutesByController(routes)) {
        logger.info('HTTP controller registered', {
            controller: group.controllerClass.name || '(anonymous)',
            routeCount: group.routes.length,
            routes: group.routes.map(route => ({ method: route.method, path: route.path }))
        });
    }
}

export function logServerListening(logger: ScopedLogger, server: Server, fallbackPort: number, host?: string): void {
    logger.info('HTTP listening', { url: formatServerAddress(server, fallbackPort, host) });
}

export function logDevConsoleAvailable(logger: ScopedLogger, server: Server, fallbackPort: number): void {
    const url = `http://localhost:${getServerPort(server, fallbackPort)}/_devconsole`;
    logger.info(`DevConsole available at ${url}`);
}

export function formatServerAddress(server: Server, fallbackPort: number, host?: string): string {
    const address = server.address();
    if (typeof address === 'string') return address;
    if (address) return `http://${formatListenHost(address, host)}:${address.port}`;
    return `http://${host ?? 'localhost'}:${fallbackPort}`;
}

function getServerPort(server: Server, fallbackPort: number): number {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : fallbackPort;
}

function formatListenHost(address: AddressInfo, host?: string): string {
    const hostname = host ?? address.address;
    if (hostname.includes(':') && !hostname.startsWith('[')) return `[${hostname}]`;
    return hostname;
}

function groupRoutesByController(routes: readonly HttpRoutePlan[]): Array<{ controllerClass: ClassType; routes: HttpRoutePlan[] }> {
    const groups: Array<{ controllerClass: ClassType; routes: HttpRoutePlan[] }> = [];
    for (const route of routes) {
        let group = groups.find(item => item.controllerClass === route.controllerClass);
        if (!group) {
            group = { controllerClass: route.controllerClass, routes: [] };
            groups.push(group);
        }
        group.routes.push(route);
    }
    return groups;
}
