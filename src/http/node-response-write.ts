import type { ServerResponse } from 'node:http';

const guardedResponses = new WeakSet<ServerResponse>();

/** @internal Only transport errors caused by a disconnected HTTP client are benign. */
export function isClosedClientError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    return error.code === 'EPIPE' || error.code === 'ECONNRESET';
}

/** @internal Cover asynchronous errors as well as synchronous write failures. */
export function guardNodeResponseErrors(outgoing: ServerResponse): void {
    if (guardedResponses.has(outgoing)) return;
    guardedResponses.add(outgoing);
    outgoing.on('error', error => {
        if (isClosedClientError(error)) {
            outgoing.destroy();
            return;
        }
        // Preserve EventEmitter's unhandled-error behavior, or let an existing owner handle it.
        if (outgoing.listenerCount('error') === 1) throw error;
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
