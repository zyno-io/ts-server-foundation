export interface Semaphore {
    readonly promise: Promise<void>;
    release(): void;
}

export function createSemaphore(): Semaphore {
    let released = false;
    let resolvePromise!: () => void;
    const promise = new Promise<void>(resolve => {
        resolvePromise = resolve;
    });

    return {
        promise,
        release() {
            if (released) throw new Error('Semaphore already released');
            released = true;
            queueMicrotask(resolvePromise);
        }
    };
}

export function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve_, reject_) => {
        resolve = resolve_;
        reject = reject_;
    });
    return { promise, resolve, reject };
}
