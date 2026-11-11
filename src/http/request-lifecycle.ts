import type { HttpRequest } from './request';
import type { HttpResponse } from './response';

interface RequestLifecycle {
    controller: AbortController;
    completed: boolean;
    disconnectReason?: Error;
    deadline?: number;
    timer?: ReturnType<typeof setTimeout>;
    detach?: () => void;
}

const lifecycles = new WeakMap<HttpRequest, RequestLifecycle>();

function lifecycle(request: HttpRequest): RequestLifecycle {
    let state = lifecycles.get(request);
    if (!state) {
        state = { controller: new AbortController(), completed: false };
        lifecycles.set(request, state);
    }
    return state;
}

export function getRequestSignal(request: HttpRequest): AbortSignal {
    return lifecycle(request).controller.signal;
}

export function assertRequestActive(request: HttpRequest): void {
    const state = lifecycle(request);
    if (state.completed) throw new Error('HTTP request has completed');
    state.controller.signal.throwIfAborted();
}

/** Milliseconds from this call; later declarations may shorten, but never extend, the deadline. */
export function setRequestDeadline(request: HttpRequest, timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new Error('Request deadline must be a positive timer duration');
    }
    assertRequestActive(request);
    const state = lifecycle(request);
    const deadline = performance.now() + timeoutMs;
    if (state.deadline !== undefined && state.deadline <= deadline) return;
    clearTimeout(state.timer);
    state.deadline = deadline;
    state.timer = setTimeout(() => {
        state.controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError'));
    }, timeoutMs);
    state.timer.unref();
}

/** Bind cancellation before middleware/body parsing; consuming the request body is not a disconnect. */
export function startRequestLifecycle(request: HttpRequest, response: HttpResponse): void {
    let state = lifecycle(request);
    // Testing request builders may be dispatched again after the previous dispatch has completed.
    if (state.completed) {
        state = { controller: new AbortController(), completed: false };
        lifecycles.set(request, state);
    }
    if (state.detach) throw new Error('HTTP request is already being handled');
    const disconnect = (message: string) => {
        state.disconnectReason ??= new Error(message);
        state.controller.abort(state.disconnectReason);
    };
    const onClose = () => {
        if (!response.writableFinished) disconnect('Client disconnected');
    };
    const onError = () => disconnect('Client response failed');
    response.on('close', onClose);
    response.on('error', onError);
    state.detach = () => {
        response.off('close', onClose);
        response.off('error', onError);
    };
    if (response.destroyed && !response.writableFinished) onClose();
}

export function isRequestDisconnectError(request: HttpRequest, error: unknown): boolean {
    const state = lifecycle(request);
    const reason = state.disconnectReason;
    if (!reason || state.controller.signal.reason !== reason) return false;
    return error === reason || (error instanceof Error && error.name === 'AbortError' && error.cause === reason);
}

/** The router calls this after all handler/response work and before disposing owned files. */
export function finishRequestLifecycle(request: HttpRequest): void {
    const state = lifecycle(request);
    state.completed = true;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.detach?.();
    state.detach = undefined;
}
