export const MAX_SAFE_TIMER_MS = 0x7fffffff;

export function assertSafeTimerMs(value: number, label = 'Timeout'): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_TIMER_MS) {
        throw new Error(`${label} must be a safe positive integer between 1 and ${MAX_SAFE_TIMER_MS}`);
    }
    return value;
}
