import type { TemporaryWorkspace, TemporaryWorkspaceOptions } from '../helpers/io/temporary-files';
import type { HttpRequest } from './request';
import type { HttpResponse } from './response';

import { getRequestTemporaryWorkspace } from './uploads';

export interface RequestTemporaryWorkspaceOptions extends TemporaryWorkspaceOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** The router releases this workspace. The callback must await its streams and abortable processes. */
export async function withRequestTemporaryWorkspace<T>(
    request: HttpRequest,
    response: HttpResponse,
    fn: (workspace: TemporaryWorkspace, signal: AbortSignal) => Promise<T>,
    options: RequestTemporaryWorkspaceOptions = {}
): Promise<T | undefined> {
    if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
    ) {
        throw new Error('Request workspace timeout must be a positive timer duration');
    }
    const disconnected = new AbortController();
    const onClose = () => {
        if (!response.writableFinished) disconnected.abort(new Error('Client disconnected'));
    };
    const onError = () => disconnected.abort(new Error('Client response failed'));
    response.on('close', onClose);
    response.on('error', onError);
    const signals = [disconnected.signal];
    if (options.signal) signals.push(options.signal);
    if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
    const signal = AbortSignal.any(signals);
    try {
        if (response.destroyed && !response.writableFinished) onClose();
        signal.throwIfAborted();
        const workspace = await getRequestTemporaryWorkspace(request);
        if (options.replayable) await workspace.setReplayable();
        signal.throwIfAborted();
        return await fn(workspace, signal);
    } catch (error) {
        // An intentional disconnect has no response left to report; independent failures still propagate.
        if (
            disconnected.signal.aborted &&
            signal.reason === disconnected.signal.reason &&
            (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
        )
            return;
        throw error;
    } finally {
        response.off('close', onClose);
        response.off('error', onError);
    }
}
