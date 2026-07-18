import { AsyncLocalStorage } from 'node:async_hooks';

// oxlint-disable-next-line typescript/no-explicit-any -- context values are intentionally heterogeneous; typed access is provided by getContextProp
export type SimpleStore = { [name: string | symbol]: any };

const context = new AsyncLocalStorage<SimpleStore>();
const ContextLifetimeKey = Symbol('context-lifetime');

interface ContextLifetime {
    active: boolean;
}

export function getContext(): SimpleStore | undefined {
    const store = context.getStore();
    const lifetime = store?.[ContextLifetimeKey] as ContextLifetime | undefined;
    return lifetime?.active === false ? undefined : store;
}

// oxlint-disable-next-line typescript/no-explicit-any -- preserves the existing permissive default for callers that do not supply T
export function getContextProp<T = any>(name: string | symbol): T | undefined {
    return getContext()?.[name];
}

// oxlint-disable-next-line typescript/no-explicit-any -- preserves the existing permissive default for callers that do not supply T
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
    return withContextData({}, cb);
}

export async function withContextData<T>(data: SimpleStore, cb: () => Promise<T>): Promise<T> {
    const lifetime: ContextLifetime = { active: true };
    const store = { ...getContext(), ...data, [ContextLifetimeKey]: lifetime };
    return context.run(store, async () => {
        try {
            return await cb();
        } finally {
            lifetime.active = false;
        }
    });
}
