import { randomUUID } from 'node:crypto';

import type { HttpRequest } from './request';

export const DefaultHttpContextProvider: (request: HttpRequest) => Record<string, string> = () => ({
    reqId: randomUUID()
});

let httpContextProvider: (request: HttpRequest) => Record<string, string> = DefaultHttpContextProvider;

export function setHttpContextResolver(provider: (request: HttpRequest) => Record<string, string>): void {
    httpContextProvider = provider;
}

export function getHttpContextResolver(): (request: HttpRequest) => Record<string, string> {
    return httpContextProvider;
}

export function applyHttpContext(request: HttpRequest): Record<string, string> {
    request.context = {
        ...httpContextProvider(request),
        ...request.context
    };
    return request.context;
}
