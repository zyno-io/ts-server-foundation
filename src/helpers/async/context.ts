import { AsyncLocalStorage } from 'node:async_hooks';

export type SimpleStore = { [name: string | symbol]: any };

const context = new AsyncLocalStorage<SimpleStore>();

export function getContext(): SimpleStore | undefined {
    return context.getStore();
}

export function getContextProp<T = any>(name: string | symbol): T | undefined {
    return getContext()?.[name];
}

export function setContextProp<T = any>(name: string | symbol, value: T): void {
    const store = getContext();
    if (store) store[name] = value;
}

export function removeContextProp(name: string | symbol): void {
    const store = getContext();
    if (store) delete store[name];
}

export async function withContext<T>(cb: () => Promise<T>): Promise<T> {
    if (getContext()) return cb();
    return context.run({}, cb);
}

export async function withContextData<T>(data: SimpleStore, cb: () => Promise<T>): Promise<T> {
    return withContext(async () => {
        const store = getContext()!;
        const dataKeys = [...Object.getOwnPropertyNames(data), ...Object.getOwnPropertySymbols(data)];
        const overwriteKeys = dataKeys.filter(key => key in store);
        const overwriteValues = overwriteKeys.map(key => store[key]);

        Object.assign(store, data);
        try {
            return await cb();
        } finally {
            for (const key of dataKeys) delete store[key];
            for (let i = 0; i < overwriteKeys.length; i++) store[overwriteKeys[i]] = overwriteValues[i];
        }
    });
}
