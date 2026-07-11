export function toArray<T>(value: T | T[]): T[] {
    return Array.isArray(value) ? value : [value];
}

export async function asyncMap<T, R>(items: readonly T[], callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const result: R[] = [];
    for (let i = 0; i < items.length; i++) result.push(await callback(items[i], i));
    return result;
}

export function unique<T>(items: readonly T[]): T[] {
    return [...new Set(items)];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
    if (size <= 0) throw new Error('chunk size must be greater than zero');
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
    return result;
}
