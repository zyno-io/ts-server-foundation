import type { ServerResponse } from 'node:http';

interface ResponseErrorGuard {
    onUnhandledError?: (error: Error) => void;
}

const guardedResponses = new WeakMap<ServerResponse, ResponseErrorGuard>();

/** @internal Only transport errors caused by a disconnected HTTP client are benign. */
export function isClosedClientError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    return error.code === 'EPIPE' || error.code === 'ECONNRESET';
}

/** @internal Cover asynchronous errors as well as synchronous write failures. */
export function guardNodeResponseErrors(outgoing: ServerResponse, onUnhandledError?: (error: Error) => void): void {
    const existing = guardedResponses.get(outgoing);
    if (existing) {
        if (onUnhandledError) existing.onUnhandledError = onUnhandledError;
        return;
    }
    const guard: ResponseErrorGuard = { onUnhandledError };
    guardedResponses.set(outgoing, guard);
    outgoing.prependListener('error', error => {
        if (isClosedClientError(error)) {
            outgoing.destroy();
            return;
        }
        // Preserve EventEmitter's unhandled-error behavior, or let an existing owner handle it.
        if (outgoing.listenerCount('error') === 1) {
            if (guard.onUnhandledError) guard.onUnhandledError(error);
            else throw error;
        }
    });
}

/** @internal Returns false when the response can no longer be written. */
export function writeToNodeResponse(outgoing: ServerResponse, write: () => void): boolean {
    guardNodeResponseErrors(outgoing);
    if (outgoing.destroyed || outgoing.writableEnded) return false;
    try {
        write();
        return true;
    } catch (error) {
        if (!isClosedClientError(error)) throw error;
        outgoing.destroy();
        return false;
    }
}
