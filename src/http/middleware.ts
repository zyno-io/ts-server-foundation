import type { HttpRequest } from './request';
import type { HttpResponse, HttpResponseResult } from './response';
import type { ScopedLogger } from '../services/logger';
import type { ClassType } from '../types';
import { REDACTED, redactRequestBodyForLog, type IRedactedRequestBodyLog } from './payload-redaction';

export type HttpMiddlewareResult = void | HttpResponseResult | Promise<void | HttpResponseResult>;

export type HttpMiddlewareFunction = (request: HttpRequest, response: HttpResponse) => HttpMiddlewareResult;

export abstract class HttpMiddleware {
    abstract handle(request: HttpRequest, response: HttpResponse): HttpMiddlewareResult;
}

export type HttpMiddlewareInput = ClassType<HttpMiddleware> | HttpMiddlewareFunction;

export class HttpLogPayloadMiddleware extends HttpMiddleware {
    constructor(private readonly logger: ScopedLogger) {
        super();
    }

    async handle(request: HttpRequest, _response: HttpResponse): Promise<void> {
        this.logger.info('Logging request', {
            method: request.method,
            url: request.url,
            contentType: request.headers['content-type'] ?? '',
            body: await request.readBodyText()
        });
    }
}

/** Logs known webhook fields with their values redacted. Query strings are omitted from this log. */
export class RedactedPayloadLogMiddleware extends HttpMiddleware {
    constructor(private readonly logger: ScopedLogger) {
        super();
    }

    async handle(request: HttpRequest, _response: HttpResponse): Promise<void> {
        const contentType = request.headers['content-type'] ?? '';
        let body: IRedactedRequestBodyLog | { body: string; bodyUnavailable: true };
        try {
            const rawBody = await request.readBodyBuffer();
            body = redactRequestBodyForLog(contentType, rawBody);
        } catch {
            body = { body: REDACTED, bodyUnavailable: true };
        }
        this.logger.info('Logging request', { method: request.method, url: request.path, contentType, ...body });
    }
}
