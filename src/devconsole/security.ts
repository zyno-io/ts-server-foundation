import type { IncomingMessage } from 'node:http';

import { HttpUnauthorizedError, type HttpMiddleware, type HttpRequest, type HttpResponse } from '../http';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];

export class DevConsoleLocalhostMiddleware implements HttpMiddleware {
    handle(request: HttpRequest, _response: HttpResponse): void {
        if (!isLocalhostHttpRequest(request)) throw new HttpUnauthorizedError('DevConsole is only available from direct localhost requests');
    }
}

export function isLocalhostHttpRequest(request: HttpRequest): boolean {
    if (FORWARDED_HEADERS.some(header => request.headers[header] !== undefined)) return false;
    return isLocalAddress(request.remoteAddress);
}

export function isLocalhostIncomingMessage(request: IncomingMessage): boolean {
    if (FORWARDED_HEADERS.some(header => request.headers[header] !== undefined)) return false;
    return isLocalAddress(request.socket.remoteAddress ?? '');
}

function isLocalAddress(address: string): boolean {
    return LOCAL_ADDRESSES.has(address) || address.endsWith(':127.0.0.1');
}
