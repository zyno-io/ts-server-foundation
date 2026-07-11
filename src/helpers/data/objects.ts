import { isDeepStrictEqual } from 'node:util';
import type { StringKeyOf } from '../../types';

export function objectKeys<T extends object>(object: T): StringKeyOf<T>[] {
    return Object.keys(object) as StringKeyOf<T>[];
}

export function objectAssign<T extends object>(object: T, ...values: Partial<T>[]): T {
    return Object.assign(object, ...values);
}

type Entries<T> = {
    [K in keyof T]: [K, T[K]];
}[keyof T][];

export function objectEntries<T extends object>(object: T): Entries<T> {
    return Object.entries(object) as Entries<T>;
}

export function extractValues<T extends object, K extends readonly (keyof T)[]>(state: T, fields: K): Pick<T, K[number]> {
    const result = {} as Pick<T, K[number]>;
    for (const key of fields) {
        if (state[key] !== undefined) result[key] = state[key];
    }
    return result;
}

export function extractUpdates<T extends object>(
    state: T,
    updates: Partial<T>,
    fields: Array<keyof T> = objectKeys(updates),
    method: 'equals' | 'matches' = 'equals'
): Partial<T> {
    const result: Partial<T> = {};
    for (const key of fields) {
        const update = updates[key];
        if (update !== undefined && !doesMatch(state[key], update, method)) result[key] = update;
    }
    return result;
}

export function patchObject<T extends object>(state: T, updates: Partial<T>, fields?: Array<keyof T>, method?: 'equals' | 'matches'): T {
    return objectAssign(state, extractUpdates(state, updates, fields, method));
}

export function extractKV<T, K extends keyof T, V extends keyof T>(items: T[], keyColumn: K, valueColumn: V): Record<string, T[V]> {
    return items.reduce(
        (acc, item) => {
            acc[String(item[keyColumn])] = item[valueColumn];
            return acc;
        },
        {} as Record<string, T[V]>
    );
}

function doesMatch(original: unknown, update: unknown, method: 'equals' | 'matches'): boolean {
    if (method === 'matches' && isPlainObject(original) && isPlainObject(update)) {
        return objectEntries(update).every(([key, value]) => doesMatch((original as Record<string, unknown>)[String(key)], value, 'matches'));
    }
    return isDeepStrictEqual(original, update);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
