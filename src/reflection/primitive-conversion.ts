export function coerceBooleanValue(value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'bigint') return value !== 0n;
    if (typeof value === 'string') {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
    }
    return value;
}
