import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';

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
        outgoing.once('finish', () => this.emit('finish'));
        outgoing.once('close', () => {
            this.emit('close');
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
        return super.writeHead(statusCode, statusMessageOrHeaders as string, headers);
    }

    override write(chunk: any, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
        this.streaming = true;
        if (this.chunks.length) {
            this.commitHeaders();
            for (const buffered of this.chunks.splice(0)) this.outgoing.write(buffered);
        }
        return super.write(chunk, encoding as BufferEncoding, callback);
    }

    override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this.streaming) {
            this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
            callback();
            return;
        }
        this.commitHeaders();
        this.outgoing.write(chunk, encoding, callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (!this.streaming) {
            callback();
            return;
        }
        if (this.outgoing.writableEnded) {
            callback();
            return;
        }
        this.commitHeaders();
        this.outgoing.end(callback);
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
        this.commitHeaders();
        this.outgoing.end(this.body);
    }

    override flushHeaders(): void {
        if (this.headersSent) return;
        this.streaming = true;
        this.commitHeaders();
        this.outgoing.flushHeaders();
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
    writeTo(response: HttpResponse): void;
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

export function isHttpResponseResult(value: unknown): value is HttpResponseResult {
    return !!value && typeof value === 'object' && typeof (value as HttpResponseResult).writeTo === 'function';
}
