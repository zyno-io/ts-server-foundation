import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import type { HttpRequest } from './request';
import type { HttpResponse } from './response';

export interface StaticFilesOptions {
    directory?: string;
    index?: string;
    spaFallback?: string;
}

export interface ResolvedStaticFilesOptions {
    directory: string;
    index: string;
    spaFallback: string;
}

export function resolveStaticFilesOptions(options: boolean | StaticFilesOptions | undefined): ResolvedStaticFilesOptions | undefined {
    if (!options) return undefined;
    const config = options === true ? {} : options;
    const index = config.index ?? 'index.html';
    const spaFallback = config.spaFallback ?? index;
    return {
        directory: config.directory ?? 'static',
        index,
        spaFallback
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

    const relative = path === '/' ? options.index : path.replace(/^\/+/, '');
    let file = resolve(base, relative);
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
        file = resolve(base, options.spaFallback);
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

    response.writeHead(200, {
        'content-length': String(body.length),
        'content-type': getStaticContentType(file)
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
