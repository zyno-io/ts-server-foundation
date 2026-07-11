import type { Serializable } from '../../types';

export function toJson(data: Serializable): string {
    return JSON.stringify(data);
}

export function fromJson<T>(serialized: string): T {
    return JSON.parse(serialized) as T;
}

export function safeJsonStringify(data: unknown): string {
    const ancestors: object[] = [];
    return JSON.stringify(data, function (_key, value) {
        if (typeof value !== 'object' || value === null) return value;
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(value)) return '[Circular]';
        ancestors.push(value);
        return value;
    });
}
