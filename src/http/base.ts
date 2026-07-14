import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { BaseAppConfig } from '../app/config';
import { getContext, getPackageName, withContextData } from '../helpers';
import type { ScopedLogger } from '../services';
import {
    applyCorsResponseHeaders,
    handleCorsPreflight,
    prepareCorsResponseHeaders,
    resolveCorsOptions,
    type HttpCorsConfig,
    type HttpCorsOptions
} from './cors';
import { applyHttpContext } from './context';
import { HttpRequest, type HttpMethod } from './request';
import { MemoryHttpResponse, NodeHttpResponse, type HttpResponse } from './response';
import { HttpRouter } from './router';
import { HttpRequestLogger, type HttpRequestLoggingOptions } from './request-logging';
import { logDevConsoleAvailable, logServerListening, logStartupDetails } from './startup-logging';
import { resolveStaticFilesOptions, serveStaticFile, type ResolvedStaticFilesOptions, type StaticFilesOptions } from './static-files';
import { installUpgradeClaimHandling, type HttpUpgradeHandler } from './upgrade';

export interface HttpServerRuntimeOptions<C extends BaseAppConfig = BaseAppConfig> {
    config: C;
    router: HttpRouter;
    logger: ScopedLogger;
    frameworkConfig?: Record<string, unknown>;
    serverConfig?: Record<string, unknown>;
    cors?: HttpCorsConfig<C>;
    staticFiles?: boolean | StaticFilesOptions;
    requestLogging?: HttpRequestLoggingOptions;
    packageName?: string;
    devConsoleEnabled?: boolean;
    listenHooks?: HttpServerListenHooks | (() => HttpServerListenHooks);
}

export interface HttpServerListenHooks {
    start?: () => Promise<void>;
    afterListen?: (server: Server) => Promise<void>;
    onListenError?: (error: unknown) => Promise<void>;
}

export interface HttpRequestObservation {
    request: HttpRequest;
    response: HttpResponse;
    startedAt: number;
    durationMs: number;
    error?: unknown;
}

export type HttpRequestObserver = (entry: HttpRequestObservation) => void;

export class HttpServerRuntime<C extends BaseAppConfig = BaseAppConfig> {
    private readonly corsOptions: HttpCorsOptions[];
    private readonly staticFiles?: ResolvedStaticFilesOptions;
    private readonly appLogger: ScopedLogger;
    private readonly requestLogger: HttpRequestLogger;
    private readonly upgradeHandlers = new Set<HttpUpgradeHandler>();
    private readonly observers = new Set<HttpRequestObserver>();
    private server?: Server;

    constructor(private readonly options: HttpServerRuntimeOptions<C>) {
        this.corsOptions = resolveCorsOptions(options.config, options.cors);
        this.staticFiles = resolveStaticFilesOptions(options.staticFiles);
        this.appLogger = options.logger.scoped('app');
        this.requestLogger = new HttpRequestLogger(options.config, options.logger.scoped('http'), options.requestLogging);
    }

    async request(request: HttpRequest, response: HttpResponse = new MemoryHttpResponse()): Promise<HttpResponse> {
        request.trustProxyHeaders = this.options.config.USE_REAL_IP_HEADER === true;
        request.setBodyLimits({
            maxBodyBytes: this.options.config.HTTP_MAX_REQUEST_BODY_BYTES,
            maxCompressedBodyBytes: this.options.config.HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES
        });
        const activeHttpContext = getActiveHttpContext();
        const hasActiveRequestContext = activeHttpContext === request.context;
        const context = hasActiveRequestContext ? (activeHttpContext as Record<string, string>) : applyHttpContext(request);
        const startedAt = Date.now();
        let observedResponse = response;
        let observedError: unknown;
        const runRequest = async () => {
            if (handleCorsPreflight(request, response, this.corsOptions)) return response;
            prepareCorsResponseHeaders(request, response, this.corsOptions);
            applyCorsResponseHeaders(request, response, this.corsOptions);
            if (this.staticFiles && request.method === 'GET' && !this.options.router.hasRoute(request)) {
                const staticResponse = await serveStaticFile(request, response, this.staticFiles);
                if (staticResponse) {
                    applyCorsResponseHeaders(request, staticResponse, this.corsOptions);
                    return staticResponse;
                }
            }
            const routed = await this.options.router.handle(request, response);
            applyCorsResponseHeaders(request, routed, this.corsOptions);
            return routed;
        };

        try {
            observedResponse = hasActiveRequestContext ? await runRequest() : await withContextData({ http: context }, runRequest);
            if (request.method === 'HEAD') observedResponse.discardBody();
            return observedResponse;
        } catch (error) {
            observedError = error;
            throw error;
        } finally {
            const error = observedError ?? request.store['$ControllerError'];
            if (error && !(observedResponse instanceof NodeHttpResponse))
                this.requestLogger.errorForRequest(request, observedResponse, startedAt, error);
            this.notifyObservers({
                request,
                response: observedResponse,
                startedAt,
                durationMs: Date.now() - startedAt,
                error
            });
        }
    }

    async listen(port?: number, host?: string, hooks: HttpServerListenHooks = {}): Promise<Server> {
        const listenHooks = composeListenHooks(resolveListenHooks(this.options.listenHooks), hooks);
        await listenHooks.start?.();
        if (this.server) return this.server;

        const server = createServer((request, response) => {
            this.handleNodeRequest(request, response).catch(error => {
                writeUnhandledNodeError(response, error);
            });
        });
        this.server = server;
        installUpgradeClaimHandling(server);
        for (const handler of this.upgradeHandlers) server.prependListener('upgrade', handler);

        const shouldLogStartup = this.shouldLogStartupDetails();
        if (shouldLogStartup) {
            logStartupDetails(this.appLogger, this.options.packageName ?? getPackageName() ?? 'app', this.options.router.listRoutes());
        }

        try {
            const listenPort = this.getPort(port);
            await listenServer(server, listenPort, host);
            await listenHooks.afterListen?.(server);
            if (shouldLogStartup) {
                logServerListening(this.appLogger, server, listenPort, host);
                this.appLogger.info('Server started');
                if (this.options.devConsoleEnabled) logDevConsoleAvailable(this.appLogger, server, listenPort);
            }
            return server;
        } catch (error) {
            const cleanupErrors: unknown[] = [];
            try {
                // Keep the server reachable while app-level rollback runs so
                // app.stop() can close a socket that already bound successfully.
                await listenHooks.onListenError?.(error);
            } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
            if (this.server === server) this.server = undefined;
            try {
                await closeServer(server);
            } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
            if (cleanupErrors.length) {
                const rollbackError =
                    cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'HTTP listen rollback failed');
                if (error instanceof Error && error.cause === undefined) error.cause = rollbackError;
                else throw new AggregateError([error, rollbackError], 'HTTP listen and rollback failed');
            }
            throw error;
        }
    }

    registerUpgradeHandler(handler: HttpUpgradeHandler): () => void {
        this.upgradeHandlers.add(handler);
        if (this.server) {
            installUpgradeClaimHandling(this.server);
            this.server.prependListener('upgrade', handler);
        }
        return () => {
            this.upgradeHandlers.delete(handler);
            this.server?.off('upgrade', handler);
        };
    }

    registerObserver(observer: HttpRequestObserver): () => void {
        this.observers.add(observer);
        return () => this.observers.delete(observer);
    }

    async close(): Promise<void> {
        if (!this.server) return;
        const server = this.server;
        this.server = undefined;
        await closeServer(server);
    }

    private notifyObservers(entry: HttpRequestObservation): void {
        for (const observer of this.observers) {
            try {
                observer(entry);
            } catch {
                // Observers must never affect request handling.
            }
        }
    }

    getPort(explicitPort?: number): number {
        if (explicitPort !== undefined) return explicitPort;
        if (this.options.config.APP_ENV === 'test') {
            const configured = this.options.frameworkConfig?.port ?? this.options.serverConfig?.port;
            return configured === undefined ? 3000 : typeof configured === 'number' ? configured : Number(configured);
        }
        const configured = this.options.frameworkConfig?.port ?? this.options.serverConfig?.port ?? this.options.config.PORT ?? 3000;
        return typeof configured === 'number' ? configured : Number(configured);
    }

    private shouldLogStartupDetails(): boolean {
        return this.options.config.APP_ENV !== 'test';
    }

    private async handleNodeRequest(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
        const headers = normalizeIncomingHeaders(incoming.headers);
        const method = normalizeMethod(incoming.method);
        const request = new HttpRequest(method, incoming.url ?? '/', headers, undefined, incoming);
        request.remoteAddress = incoming.socket.remoteAddress ?? '127.0.0.1';
        request.socket = incoming.socket;
        request.trustProxyHeaders = this.options.config.USE_REAL_IP_HEADER === true;
        const context = applyHttpContext(request);
        const logging = this.requestLogger.createState(request, outgoing);

        await withContextData({ http: context }, async () => {
            this.requestLogger.start(logging);
            const response = new NodeHttpResponse(outgoing);
            try {
                await this.request(request, response);
                response.flush();
                this.requestLogger.error(logging, request.store['$ControllerError'], response);
                this.requestLogger.finish(logging, response);
            } catch (error) {
                writeUnhandledNodeError(outgoing, error);
                this.requestLogger.error(logging, error, outgoing);
                this.requestLogger.finish(logging, outgoing);
            } finally {
                this.requestLogger.dispose(logging, outgoing);
            }
        });
    }
}

function resolveListenHooks(hooks: HttpServerRuntimeOptions['listenHooks']): HttpServerListenHooks {
    return typeof hooks === 'function' ? hooks() : (hooks ?? {});
}

function composeListenHooks(first: HttpServerListenHooks, second: HttpServerListenHooks): HttpServerListenHooks {
    return {
        start:
            first.start || second.start
                ? async () => {
                      await first.start?.();
                      await second.start?.();
                  }
                : undefined,
        afterListen:
            first.afterListen || second.afterListen
                ? async server => {
                      await first.afterListen?.(server);
                      await second.afterListen?.(server);
                  }
                : undefined,
        onListenError:
            first.onListenError || second.onListenError
                ? async error => {
                      const failures: unknown[] = [];
                      for (const hook of [first.onListenError, second.onListenError]) {
                          try {
                              await hook?.(error);
                          } catch (hookError) {
                              failures.push(hookError);
                          }
                      }
                      if (failures.length === 1) throw failures[0];
                      if (failures.length > 1) throw new AggregateError(failures, 'HTTP listen rollback hooks failed');
                  }
                : undefined
    };
}

function getActiveHttpContext(): unknown {
    const context = getContext();
    return isRecord(context?.http) ? context.http : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

export function writeNodeResponse(outgoing: ServerResponse, response: MemoryHttpResponse): void {
    outgoing.statusCode = response.statusCode;
    for (const [name, value] of Object.entries(response.headers)) outgoing.setHeader(name, value);
    outgoing.end(response.body);
}

export function writeUnhandledNodeError(outgoing: ServerResponse, error: unknown): void {
    void error;
    if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
        if (!outgoing.writableEnded) outgoing.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
    }
    if (!outgoing.writableEnded) outgoing.end();
}

function normalizeMethod(method: string | undefined): HttpMethod {
    return (method ?? 'GET').toUpperCase() as HttpMethod;
}

function normalizeIncomingHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) result[name] = value;
    }
    return result;
}

function listenServer(server: Server, port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };

        server.once('error', onError);
        try {
            server.listen(port, host, onListening);
        } catch (error) {
            server.off('error', onError);
            reject(error);
        }
    });
}

function closeServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) reject(error);
            else resolve();
        });
    });
}
