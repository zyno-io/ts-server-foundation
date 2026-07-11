import type { HttpRequest } from './request';

export type RequestStoreKey<T = unknown> = string | symbol | object;

const ObjectStoreSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-request-object-store');

export function getCachedValue<T>(request: HttpRequest, key: RequestStoreKey<T>): T | undefined {
    if (typeof key === 'object') return getObjectStore(request).get(key) as T | undefined;
    return request.store[key] as T | undefined;
}

export function setCachedValue<T>(request: HttpRequest, key: RequestStoreKey<T>, value: T): T {
    if (typeof key === 'object') {
        getObjectStore(request).set(key, value);
        return value;
    }
    request.store[key] = value;
    return value;
}

export function hasCachedValue(request: HttpRequest, key: RequestStoreKey): boolean {
    if (typeof key === 'object') return getObjectStore(request).has(key);
    return Object.hasOwn(request.store, key);
}

export function clearCachedValue(request: HttpRequest, key: RequestStoreKey): void {
    if (typeof key === 'object') {
        getObjectStore(request).delete(key);
        return;
    }
    delete request.store[key];
}

export async function getOrCacheValue<T>(request: HttpRequest, key: RequestStoreKey<T>, factory: () => T | Promise<T>): Promise<T> {
    if (hasCachedValue(request, key)) return getCachedValue<T>(request, key) as T;
    return setCachedValue(request, key, await factory());
}

function getObjectStore(request: HttpRequest): Map<object, unknown> {
    const existing = request.store[ObjectStoreSymbol];
    if (existing instanceof Map) return existing;
    const store = new Map<object, unknown>();
    request.store[ObjectStoreSymbol] = store;
    return store;
}
