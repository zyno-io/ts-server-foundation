export function sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function sleepSecs(seconds: number): Promise<void> {
    return sleepMs(seconds * 1000);
}

export function extractDate(date: Date | string | number): string {
    const value = date instanceof Date ? date : new Date(date);
    return value.toISOString().slice(0, 10);
}
