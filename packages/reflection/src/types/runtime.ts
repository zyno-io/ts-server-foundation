export function getClassName(value: unknown): string {
    if (typeof value === 'function') return value.name || 'anonymous class';
    if (value && typeof value === 'object') return value.constructor?.name || 'anonymous class';
    return String(value);
}
