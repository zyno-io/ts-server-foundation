import { uuid7 } from '../helpers/utils/uuid';
import type { ClassType } from '../reflection';

export function getClassName(value: unknown): string {
    if (typeof value === 'function') return value.name || 'anonymous class';
    if (value && typeof value === 'object') return value.constructor?.name || 'anonymous class';
    return String(value);
}

export function isClass(value: unknown): value is ClassType {
    return Boolean(typeof value === 'function' && value.prototype && value.prototype.constructor === value);
}

export function uuid(): string {
    return uuid7();
}
