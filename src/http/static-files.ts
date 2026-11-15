import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import type { HttpRequest } from './request';
import type { HttpResponse } from './response';

export interface StaticFileHeaderContext {
    /** The decoded request path. */
    path: string;
    /** The absolute path of the file being served. */
    file: string;
    contentType: string;
    /** True when the SPA fallback is served because no concrete file matched. */
    fallback: boolean;
}

/** Extra response headers for static files: a fixed set, or a function of the file being served. */
export type StaticFileHeaders = Record<string, string> | ((context: StaticFileHeaderContext) => Record<string, string> | undefined);

export interface StaticFilesOptions {
    directory?: string;
    index?: string;
    spaFallback?: string | false;
    headers?: StaticFileHeaders;
}

export interface ResolvedStaticFilesOptions {
    directory: string;
    index: string;
    spaFallback?: string;
    serveIndex: boolean;
    headers?: StaticFileHeaders;
}

export function resolveStaticFilesOptions(
    options: boolean | StaticFilesOptions | undefined,
    fallbackControllerEnabled = false
): ResolvedStaticFilesOptions | undefined {
    if (!options) return undefined;
    const config = options === true ? {} : options;
    if (fallbackControllerEnabled && 'spaFallback' in config) {
        throw new Error('staticFiles.spaFallback cannot be used with fallbackController');
    }
    const index = config.index ?? 'index.html';
    const spaFallback = fallbackControllerEnabled || config.spaFallback === false ? undefined : (config.spaFallback ?? index);
    return {
        directory: config.directory ?? 'static',
        index,
        spaFallback,
        serveIndex: !fallbackControllerEnabled,
        headers: config.headers
    };
}

export async function serveStaticFile(
    request: HttpRequest,
    response: HttpResponse,
    options: ResolvedStaticFilesOptions
): Promise<HttpResponse | undefined> {
    const base = resolve(options.directory);
    let path = request.path;
    try {
        path = decodeURIComponent(path);
    } catch {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('Bad request');
        return response;
    }

    if (path === '/' && !options.serveIndex) return undefined;

    const relative = path === '/' ? options.index : path.replace(/^\/+/, '');
    let file = resolve(base, relative);
    let fallback = false;
    if (!isPathInside(base, file)) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('Bad request');
        return response;
    }

    try {
        const details = await stat(file);
        if (!details.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    } catch (error) {
        if (!isNotFoundError(error)) throw error;
        if (!options.spaFallback) return undefined;
        file = resolve(base, options.spaFallback);
        fallback = true;
        if (!isPathInside(base, file)) {
            response.writeHead(400, { 'content-type': 'text/plain' });
            response.end('Bad request');
            return response;
        }
    }

    let body: Buffer;
    try {
        body = await readFile(file);
    } catch (error) {
        if (isNotFoundError(error)) return undefined;
        throw error;
    }

    const contentType = getStaticContentType(file);
    const extraHeaders = typeof options.headers === 'function' ? options.headers({ path, file, contentType, fallback }) : options.headers;
    response.writeHead(200, {
        ...extraHeaders,
        'content-length': String(body.length),
        'content-type': contentType
    });
    response.end(body);
    return response;
}

function isPathInside(base: string, candidate: string): boolean {
    return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function isNotFoundError(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function getStaticContentType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case '.html':
            return 'text/html; charset=utf-8';
        case '.js':
        case '.mjs':
            return 'text/javascript; charset=utf-8';
        case '.css':
            return 'text/css; charset=utf-8';
        case '.json':
            return 'application/json; charset=utf-8';
        case '.svg':
            return 'image/svg+xml';
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.ico':
            return 'image/x-icon';
        case '.txt':
            return 'text/plain; charset=utf-8';
        case '.woff':
            return 'font/woff';
        case '.woff2':
            return 'font/woff2';
        default:
            return 'application/octet-stream';
    }
}
