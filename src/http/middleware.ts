import type { HttpRequest } from './request';
import type { HttpResponse, HttpResponseResult } from './response';
import type { ScopedLogger } from '../services/logger';

export abstract class HttpMiddleware {
    abstract handle(request: HttpRequest, response: HttpResponse): void | HttpResponseResult | Promise<void | HttpResponseResult>;
}

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
