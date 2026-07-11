import type { BaseAppConfig } from '../app/config';
import type { HttpRequest } from './request';
import type { HttpResponse } from './response';

export const CorsHeaders = Symbol('CorsHeaders');

export class HttpCorsOptions {
    hosts!: (string | RegExp)[];
    paths?: (string | RegExp)[];
    methods?: string[];
    credentials?: boolean;
    allowHeaders?: string[];
    exposeHeaders?: string[];
}

export class HttpCorsOptionsMulti {
    constructor(readonly options: HttpCorsOptions[]) {}
}

export type HttpCorsConfig<C extends BaseAppConfig = BaseAppConfig> =
    | HttpCorsOptions
    | HttpCorsOptions[]
    | ((config: C) => HttpCorsOptions | HttpCorsOptions[]);

export class HttpCors {
    static getResponseHeaders(response: HttpResponse): Record<string, string> | undefined {
        return (response as HttpResponse & { [CorsHeaders]?: Record<string, string> })[CorsHeaders];
    }
}

export function resolveCorsOptions<C extends BaseAppConfig>(config: C, cors?: HttpCorsConfig<C>): HttpCorsOptions[] {
    if (!cors) return [];
    const options = typeof cors === 'function' ? cors(config) : cors;
    return Array.isArray(options) ? options : [options];
}

export function handleCorsPreflight(request: HttpRequest, response: HttpResponse, options: readonly HttpCorsOptions[]): boolean {
    if (request.method !== 'OPTIONS') return false;
    const descriptor = findMatchingCors(request, options);
    if (!descriptor) return false;

    response.writeHead(204, getCorsPreflightHeaders(request, descriptor));
    response.end();
    return true;
}

export function prepareCorsResponseHeaders(
    request: HttpRequest,
    response: HttpResponse,
    options: readonly HttpCorsOptions[]
): Record<string, string> | undefined {
    const descriptor = findMatchingCors(request, options);
    if (!descriptor) return undefined;
    const headers = getCorsResponseHeaders(request, descriptor);
    (response as HttpResponse & { [CorsHeaders]?: Record<string, string> })[CorsHeaders] = headers;
    return headers;
}

export function applyCorsResponseHeaders(request: HttpRequest, response: HttpResponse, options: readonly HttpCorsOptions[]): void {
    const headers = HttpCors.getResponseHeaders(response) ?? prepareCorsResponseHeaders(request, response, options);
    if (!headers) return;
    for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
    }
}

function findMatchingCors(request: HttpRequest, options: readonly HttpCorsOptions[]): HttpCorsOptions | undefined {
    const origin = getHeader(request, 'origin');
    if (typeof origin !== 'string') return undefined;

    return options.find(option => {
        const hostMatches = option.hosts.some(host => {
            if (host === '*') return true;
            if (host instanceof RegExp) return host.test(origin);
            return host === origin;
        });
        if (!hostMatches) return false;

        return (
            !option.paths ||
            option.paths.some(path => {
                if (path instanceof RegExp) return path.test(request.path);
                return request.path.startsWith(path);
            })
        );
    });
}

function getCorsPreflightHeaders(request: HttpRequest, options: HttpCorsOptions): Record<string, string> {
    const headers: Record<string, string> = {
        ...getCorsResponseHeaders(request, options),
        'Access-Control-Allow-Methods': options.methods?.join(',') ?? 'GET,HEAD,PUT,PATCH,POST,DELETE',
        'Content-Length': '0'
    };

    const requestedHeaders = getHeader(request, 'access-control-request-headers');
    if (options.allowHeaders) headers['Access-Control-Allow-Headers'] = options.allowHeaders.join(', ');
    else if (typeof requestedHeaders === 'string') headers['Access-Control-Allow-Headers'] = requestedHeaders;

    return headers;
}

function getCorsResponseHeaders(request: HttpRequest, options: HttpCorsOptions): Record<string, string> {
    const origin = getHeader(request, 'origin');
    const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': typeof origin === 'string' ? origin : '*'
    };

    if (options.credentials) headers['Access-Control-Allow-Credentials'] = 'true';
    if (options.exposeHeaders) headers['Access-Control-Expose-Headers'] = options.exposeHeaders.join(', ');
    return headers;
}

function getHeader(request: HttpRequest, name: string): string | string[] | undefined {
    return request.headers[name] ?? request.headers[name.toLowerCase()];
}
