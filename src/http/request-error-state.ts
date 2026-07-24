import type { HttpRequest } from './request';

export interface HttpRequestErrorState {
    error: unknown;
    matchedRoute: boolean;
}

const HttpRequestErrorStateSymbol = Symbol('HttpRequestErrorState');

export function clearHttpRequestErrorState(request: HttpRequest): void {
    delete request.store[HttpRequestErrorStateSymbol];
}

export function getHttpRequestErrorState(request: HttpRequest): HttpRequestErrorState | undefined {
    return request.store[HttpRequestErrorStateSymbol] as HttpRequestErrorState | undefined;
}

export function setHttpRequestErrorState(request: HttpRequest, error: unknown, matchedRoute: boolean): void {
    request.store[HttpRequestErrorStateSymbol] = { error, matchedRoute };
}
