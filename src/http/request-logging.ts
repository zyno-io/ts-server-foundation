import type { ServerResponse } from 'node:http';

import type { BaseAppConfig } from '../app/config';
import { isTestEnvironment } from '../app/const';
import type { ScopedLogger } from '../services';
import { HttpError } from './errors';
import { getHttpRequestErrorState } from './request-error-state';
import type { HttpRequest } from './request';

type RequestLoggingMode = BaseAppConfig['HTTP_REQUEST_LOGGING_MODE'];

export interface HttpRequestLoggingOptions {
    excludePaths?: (string | RegExp)[];
}

interface RequestLoggingState {
    request: HttpRequest;
    logger: ScopedLogger;
    mode: RequestLoggingMode;
    startedAt: number;
    skipped: boolean;
    aborted: boolean;
    finished: boolean;
    hooked: boolean;
    onClose?: () => void;
    onFinish?: () => void;
}

interface ResponseLoggingTarget {
    statusCode: number;
    writableEnded: boolean;
}

export class HttpRequestLogger {
    constructor(
        private readonly config: BaseAppConfig,
        private readonly logger: ScopedLogger,
        private readonly options: HttpRequestLoggingOptions = {}
    ) {}

    createState(request: HttpRequest, outgoing: ServerResponse): RequestLoggingState {
        const state: RequestLoggingState = {
            request,
            // Native response events run after the request async context has closed. Keep the
            // mutable request context on this logger so terminal records retain request fields.
            logger: this.logger.data({ http: request.context }),
            mode: this.config.HTTP_REQUEST_LOGGING_MODE ?? getDefaultRequestLoggingMode(),
            startedAt: Date.now(),
            skipped: this.shouldSkip(request),
            aborted: false,
            finished: false,
            hooked: false
        };
        const onClose = () => {
            if (state.finished || state.aborted || outgoing.writableFinished) return;
            state.aborted = true;
            if (this.shouldLogAbort(state)) {
                state.logger.warn('Request aborted during processing', {
                    method: request.method,
                    url: request.url,
                    duration: Date.now() - state.startedAt
                });
            }
            this.dispose(state, outgoing);
        };
        const onFinish = () => {
            this.finish(state, outgoing);
            this.dispose(state, outgoing);
        };
        state.onClose = onClose;
        state.onFinish = onFinish;
        outgoing.on('close', onClose);
        outgoing.on('finish', onFinish);
        return state;
    }

    start(state: RequestLoggingState): void {
        state.request.store['$RequestTime'] = state.startedAt;
        if (state.mode !== 'e2e' || state.skipped) return;
        state.logger.info('Request', {
            method: state.request.method,
            url: state.request.url,
            remoteAddress: state.request.getRemoteAddress(),
            contentLength: state.request.headers['content-length']
        });
    }

    finish(state: RequestLoggingState, response: ResponseLoggingTarget): void {
        if (state.finished || state.aborted) return;
        state.finished = true;
        if (!this.shouldLogFinish(state, response.statusCode)) return;
        state.logger.info('Response', {
            method: state.request.method,
            url: state.request.url,
            statusCode: response.statusCode,
            duration: Date.now() - state.startedAt
        });
    }

    hook(state: RequestLoggingState, response: ResponseLoggingTarget): void {
        if (state.finished || state.aborted || state.hooked || response.writableEnded) return;
        state.hooked = true;
        if (!this.shouldLogFinish(state, response.statusCode)) return;
        state.logger.info('Response stream hooked by controller', {
            method: state.request.method,
            url: state.request.url,
            statusCode: response.statusCode,
            duration: Date.now() - state.startedAt
        });
    }

    error(state: RequestLoggingState, error: unknown, response: ResponseLoggingTarget): void {
        if (!error || state.skipped || state.mode === 'none') return;
        if (error instanceof HttpError) {
            const requestError = getHttpRequestErrorState(state.request);
            if (requestError?.error === error && requestError.matchedRoute) {
                this.logger.warn('Request processing error', { 'error.message': error.message });
            }
            return;
        }
        if (response.statusCode < 500) return;
        state.logger.error('Request processing error', error, {
            method: state.request.method,
            url: state.request.url,
            statusCode: response.statusCode,
            duration: Date.now() - state.startedAt
        });
    }

    errorForRequest(request: HttpRequest, response: ResponseLoggingTarget, startedAt: number, error: unknown): void {
        this.error(
            {
                request,
                logger: this.logger.data({ http: request.context }),
                mode: this.config.HTTP_REQUEST_LOGGING_MODE ?? getDefaultRequestLoggingMode(),
                startedAt,
                skipped: this.shouldSkip(request),
                aborted: false,
                finished: false,
                hooked: false
            },
            error,
            response
        );
    }

    dispose(state: RequestLoggingState, outgoing: ServerResponse): void {
        if (state.onClose) outgoing.off('close', state.onClose);
        if (state.onFinish) outgoing.off('finish', state.onFinish);
    }

    shouldSkip(request: HttpRequest): boolean {
        if (request.path === '/metrics') return true;
        if (request.path === '/healthz' && this.config.HEALTHZ_ENABLE_REQUEST_LOGGING !== true) return true;
        return this.options.excludePaths?.some(path => matchesPath(request.path, path)) ?? false;
    }

    shouldLogFinish(state: Pick<RequestLoggingState, 'mode' | 'skipped'>, _statusCode: number): boolean {
        if (state.skipped) return false;
        if (state.mode === 'none') return false;
        if (state.mode === 'errors') return false;
        return true;
    }

    shouldLogAbort(state: Pick<RequestLoggingState, 'mode' | 'skipped'>): boolean {
        if (state.skipped) return false;
        return state.mode === 'e2e' || state.mode === 'errors';
    }
}

function matchesPath(requestPath: string, excludedPath: string | RegExp): boolean {
    if (typeof excludedPath === 'string') return requestPath === excludedPath;
    const pattern = excludedPath.global || excludedPath.sticky ? new RegExp(excludedPath.source, excludedPath.flags) : excludedPath;
    return pattern.test(requestPath);
}

function getDefaultRequestLoggingMode(): RequestLoggingMode {
    return isTestEnvironment() ? 'errors' : 'e2e';
}
