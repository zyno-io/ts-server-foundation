import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, normalize } from 'node:path';

import { http, rawResponse, type HttpPath, type RawResponseResult } from '../http';
import type { App } from '../app';
import { DevConsoleLocalhostMiddleware } from './security';

@http.controller('/_devconsole')
@http.middleware(DevConsoleLocalhostMiddleware)
export class DevConsoleController {
    constructor(private readonly app: App<any>) {}

    @http.GET()
    index(): RawResponseResult {
        return this.serveFile('index.html');
    }

    @http.GET('/assets/:path')
    asset(path: HttpPath<string>): RawResponseResult {
        return this.serveFile(join('assets', basename(path)));
    }

    private serveFile(relativePath: string): RawResponseResult {
        const root = getDevConsoleAssetsRoot();
        const normalized = normalize(relativePath);
        const file = join(root, normalized);
        if (!file.startsWith(root) || !existsSync(file))
            return rawResponse('Not Found', {
                statusCode: 404,
                contentType: 'text/plain; charset=utf-8'
            });
        return rawResponse(readFileSync(file), { contentType: getContentType(file) });
    }
}

export function getDevConsoleAssetsRoot(): string {
    return join(__dirname, '..', '..', 'devconsole');
}

function getContentType(file: string): string {
    switch (extname(file)) {
        case '.html':
            return 'text/html; charset=utf-8';
        case '.js':
            return 'text/javascript; charset=utf-8';
        case '.css':
            return 'text/css; charset=utf-8';
        case '.json':
            return 'application/json; charset=utf-8';
        case '.svg':
            return 'image/svg+xml';
        case '.png':
            return 'image/png';
        case '.ico':
            return 'image/x-icon';
        default:
            return 'application/octet-stream';
    }
}
