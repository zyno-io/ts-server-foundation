import { validateHeaderName, validateHeaderValue, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';

import { guardNodeResponseErrors, isClosedClientError, writeToNodeResponse } from './node-response-write';

export type HttpHeaderOutput = Record<string, string | number | readonly string[]>;
export type HttpWriteHeadHeaders = HttpHeaderOutput | [string, string | number | readonly string[]][];

export class HttpResponse extends Writable {
    protected statusCodeValue = 200;
    protected chunks: Buffer[] = [];
    protected headerMap = new Map<string, string | string[]>();

    get statusCode(): number {
        return this.statusCodeValue;
    }

    set statusCode(value: number) {
        this.statusCodeValue = value;
    }

    setHeader(name: string, value: string | number | readonly string[]): this {
        this.headerMap.set(name.toLowerCase(), Array.isArray(value) ? value.map(String) : String(value));
        return this;
    }

    getHeader(name: string): string | string[] | undefined {
        return this.headerMap.get(name.toLowerCase());
    }

    get headers(): Record<string, string> {
        return Object.fromEntries([...this.headerMap.entries()].map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]));
    }

    get rawHeaders(): Record<string, string | string[]> {
        return Object.fromEntries(this.headerMap.entries());
    }

    get headersSent(): boolean {
        return false;
    }

    get socket(): Socket | undefined {
        return undefined;
    }

    writeHead(statusCode: number, headers?: HttpWriteHeadHeaders): this;
    writeHead(statusCode: number, statusMessage?: string, headers?: HttpWriteHeadHeaders): this;
    writeHead(statusCode: number, statusMessageOrHeaders?: string | HttpWriteHeadHeaders, headers?: HttpWriteHeadHeaders): this {
        this.statusCode = statusCode;
        for (const [name, value] of normalizeWriteHeadHeaders(typeof statusMessageOrHeaders === 'string' ? headers : statusMessageOrHeaders)) {
            this.setHeader(name, value);
        }
        return this;
    }

    flushHeaders(): void {}

    redirect(url: string, statusCode = 302): void {
        this.statusCode = statusCode;
        this.setHeader('location', url);
        this.end();
    }

    get body(): Buffer {
        return Buffer.concat(this.chunks);
    }

    get status(): number {
        return this.statusCode;
    }

    get text(): string {
        return this.body.toString();
    }

    get bodyString(): string {
        return this.text;
    }

    get json(): any {
        return JSON.parse(this.text);
    }

    /** @internal Keep in-memory observations consistent with Node's HEAD response semantics. */
    discardBody(): void {
        this.chunks = [];
    }

    override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
    }
}

export class MemoryHttpResponse extends HttpResponse {}

export class NodeHttpResponse extends HttpResponse {
    private committed = false;
    private streaming = false;

    constructor(readonly outgoing: ServerResponse) {
        super();
        this.statusCode = outgoing.statusCode || 200;
        guardNodeResponseErrors(outgoing, error => {
            if (isClosedClientError(error)) return;
            // Buffered responses can finish and destroy the wrapper before the native write fails.
            if (!this.destroyed) this.destroy(error);
            else if (this.errored !== error) this.emit('error', error);
        });
        outgoing.once('finish', () => this.emit('finish'));
        outgoing.once('close', () => {
            // A client disconnect destroys the native response without ending this wrapper.
            // Destroy it as well so piped sources are unpiped before they can write again.
            this.destroy();
        });
    }

    override get headersSent(): boolean {
        return this.committed || this.outgoing.headersSent;
    }

    override get socket(): Socket | undefined {
        return this.outgoing.socket ?? undefined;
    }

    override setHeader(name: string, value: string | number | readonly string[]): this {
        if (this.headersSent) return this;
        return super.setHeader(name, value);
    }

    override writeHead(statusCode: number, headers?: HttpWriteHeadHeaders): this;
    override writeHead(statusCode: number, statusMessage?: string, headers?: HttpWriteHeadHeaders): this;
    override writeHead(statusCode: number, statusMessageOrHeaders?: string | HttpWriteHeadHeaders, headers?: HttpWriteHeadHeaders): this {
        if (this.headersSent) return this;
        super.writeHead(statusCode, statusMessageOrHeaders as string, headers);

        // writeHead() is the controller's explicit hand-off to Node's response. Commit it now so
        // the router does not interpret an otherwise void result as an empty response and end it.
        const written = writeToNodeResponse(this.outgoing, () => {
            this.outgoing.statusCode = this.statusCode;
            for (const [name, value] of Object.entries(this.rawHeaders)) this.outgoing.setHeader(name, value);
            if (typeof statusMessageOrHeaders === 'string') this.outgoing.writeHead(statusCode, statusMessageOrHeaders);
            else this.outgoing.writeHead(statusCode);
        });
        if (!written) {
            this.destroy();
            return this;
        }
        this.committed = true;
        this.streaming = true;
        return this;
    }

    override write(chunk: any, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
        this.streaming = true;
        if (this.chunks.length) {
            for (const buffered of this.chunks.splice(0)) {
                const written = writeToNodeResponse(this.outgoing, () => {
                    this.commitHeaders();
                    this.outgoing.write(buffered);
                });
                if (!written) break;
            }
        }
        return super.write(chunk, encoding as BufferEncoding, callback);
    }

    override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this.streaming) {
            this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
            callback();
            return;
        }
        if (this.outgoing.destroyed || this.outgoing.writableEnded) {
            this.destroy();
            callback();
            return;
        }
        const written = writeToNodeResponse(this.outgoing, () => {
            this.commitHeaders();
            this.outgoing.write(chunk, encoding, error => this.completeWrite(callback, error));
        });
        if (!written) {
            this.destroy();
            callback();
        }
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (!this.streaming) {
            callback();
            return;
        }
        if (this.outgoing.destroyed || this.outgoing.writableEnded) {
            callback();
            return;
        }
        const written = writeToNodeResponse(this.outgoing, () => {
            this.commitHeaders();
            this.outgoing.end((error?: Error | null) => this.completeWrite(callback, error));
        });
        if (!written) callback();
    }

    override destroy(error?: Error): this {
        if (error && !this.outgoing.destroyed) this.outgoing.destroy(error);
        return super.destroy(error);
    }

    override redirect(url: string, statusCode = 302): void {
        this.statusCode = statusCode;
        this.setHeader('location', url);
        this.end();
    }

    flush(): void {
        if (this.headersSent) return;
        writeToNodeResponse(this.outgoing, () => {
            this.commitHeaders();
            this.outgoing.end(this.body);
        });
    }

    override flushHeaders(): void {
        if (this.headersSent) return;
        this.streaming = true;
        writeToNodeResponse(this.outgoing, () => {
            this.commitHeaders();
            this.outgoing.flushHeaders();
        });
    }

    private completeWrite(callback: (error?: Error | null) => void, error?: Error | null): void {
        if (isClosedClientError(error)) {
            this.outgoing.destroy();
            this.destroy();
            callback();
            return;
        }
        if (error && this.destroyed && this.errored !== error) this.emit('error', error);
        callback(error);
    }

    private commitHeaders(): void {
        if (this.headersSent) return;
        this.outgoing.statusCode = this.statusCode;
        for (const [name, value] of Object.entries(this.rawHeaders)) this.outgoing.setHeader(name, value);
        this.committed = true;
    }
}

function normalizeWriteHeadHeaders(headers?: HttpWriteHeadHeaders): [string, string | number | readonly string[]][] {
    if (!headers) return [];
    return Array.isArray(headers) ? headers : Object.entries(headers);
}

export interface HttpResponseResult {
    writeTo(response: HttpResponse): void | Promise<void>;
}

export class JsonResponseResult implements HttpResponseResult {
    constructor(
        readonly value: unknown,
        readonly statusCode = 200
    ) {}

    writeTo(response: HttpResponse): void {
        response.statusCode = this.statusCode;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(this.value));
    }
}

export class RedirectResponseResult implements HttpResponseResult {
    constructor(
        readonly url: string,
        readonly statusCode = 302
    ) {}

    writeTo(response: HttpResponse): void {
        response.redirect(this.url, this.statusCode);
    }
}

export class EmptyResponseResult implements HttpResponseResult {
    constructor(readonly statusCode = 204) {}

    writeTo(response: HttpResponse): void {
        response.statusCode = this.statusCode;
        response.end();
    }
}

export class RawResponseResult implements HttpResponseResult {
    constructor(
        readonly body: string | Buffer,
        readonly options: {
            statusCode?: number;
            contentType?: string;
            headers?: Record<string, string | number | string[]>;
        } = {}
    ) {}

    writeTo(response: HttpResponse): void {
        response.statusCode = this.options.statusCode ?? response.statusCode;
        if (this.options.contentType) response.setHeader('content-type', this.options.contentType);
        for (const [name, value] of Object.entries(this.options.headers ?? {})) response.setHeader(name, value);
        response.end(this.body);
    }
}

/**
 * Writes a WHATWG `Response` (e.g. from a fetch-style handler) to the HTTP response: status, headers
 * (including repeated `set-cookie`), and the body, streamed chunk by chunk. The router awaits the
 * body, so request cleanup runs after it finishes. Status and headers are applied with the first
 * body chunk, so a body that fails before then becomes an ordinary 500; event streams commit their
 * headers immediately. A failure after the first chunk aborts the connection and is logged as a 500.
 * A client disconnect cancels the source.
 */
export class WebResponseResult implements HttpResponseResult {
    constructor(readonly response: Response) {}

    async writeTo(target: HttpResponse): Promise<void> {
        const source = this.response;
        const headers = collectWebResponseHeaders(source.headers);
        let started = false;
        const start = () => {
            if (started) return;
            started = true;
            target.statusCode = source.status;
            for (const [name, value] of headers) target.setHeader(name, value);
        };

        if (!source.body) {
            start();
            target.end();
            return;
        }
        if (target.destroyed) {
            await source.body.cancel().catch(() => undefined);
            return;
        }

        const reader = source.body.getReader();
        const cancel = () => void reader.cancel().catch(() => undefined);
        target.once('close', cancel);
        try {
            if (/^text\/event-stream(?:\s*;|$)/i.test(source.headers.get('content-type') ?? '')) {
                start();
                target.flushHeaders();
            }
            for (;;) {
                const { done, value } = await reader.read();
                // A client disconnect destroys the response; 'close' may not have fired yet, so cancel here too.
                if (target.destroyed) {
                    cancel();
                    return;
                }
                if (done) break;
                start();
                if (!target.write(value)) await drainOrClose(target);
            }
            start();
            target.end();
        } catch (error) {
            if (target.destroyed) return;
            if (started) {
                // Headers may already be on the wire: abort so the client sees a truncated body, and
                // report a 500 so the failure is logged.
                target.statusCode = 500;
                // The error is rethrown to the router; the emitted 'error' event must not go unhandled.
                target.on('error', () => undefined);
                target.destroy(error instanceof Error ? error : new Error(String(error)));
            }
            throw error;
        } finally {
            target.off('close', cancel);
        }
    }
}

function collectWebResponseHeaders(source: Headers): [string, string | string[]][] {
    const headers: [string, string | string[]][] = [];
    for (const [name, value] of source) {
        if (name === 'set-cookie') continue;
        validateHeaderName(name);
        validateHeaderValue(name, value);
        headers.push([name, value]);
    }
    const cookies = source.getSetCookie();
    for (const cookie of cookies) validateHeaderValue('set-cookie', cookie);
    if (cookies.length) headers.push(['set-cookie', cookies]);
    return headers;
}

function drainOrClose(target: HttpResponse): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            target.off('drain', done);
            target.off('close', done);
            resolve();
        };
        target.once('drain', done);
        target.once('close', done);
    });
}

export function jsonResponse(value: unknown, statusCode = 200): JsonResponseResult {
    return new JsonResponseResult(value, statusCode);
}

export function redirectResponse(url: string, statusCode = 302): RedirectResponseResult {
    return new RedirectResponseResult(url, statusCode);
}

export class Redirect {
    static toUrl(url: string, statusCode = 302): RedirectResponseResult {
        return redirectResponse(url, statusCode);
    }
}

export function emptyResponse(statusCode = 204): EmptyResponseResult {
    return new EmptyResponseResult(statusCode);
}

export function rawResponse(
    body: string | Buffer,
    options: {
        statusCode?: number;
        contentType?: string;
        headers?: Record<string, string | number | string[]>;
    } = {}
): RawResponseResult {
    return new RawResponseResult(body, options);
}

export function webResponse(response: Response): WebResponseResult {
    return new WebResponseResult(response);
}

export function isHttpResponseResult(value: unknown): value is HttpResponseResult {
    return !!value && typeof value === 'object' && typeof (value as HttpResponseResult).writeTo === 'function';
}
