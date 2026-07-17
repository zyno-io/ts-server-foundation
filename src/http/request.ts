import type { Socket } from 'node:net';
import { PassThrough, Readable, Transform, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { HttpBadRequestError, HttpPayloadTooLargeError, HttpUnsupportedMediaTypeError } from './errors';
import { defaultFormBodyLimits, type FormBodyLimits } from './form-body';
import type { UploadedFiles } from './uploads';

export type KnownHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
export type HttpMethod = KnownHttpMethod | (string & {});
export type HttpHeaderInput = Record<string, string | string[] | number | boolean | undefined>;
export type HttpRequestHeaders = Record<string, string> & ((headers: HttpHeaderInput) => HttpRequest);

export interface MultipartRequestPart {
    name: string;
    value?: string | number | boolean;
    file?: Buffer | string;
    fileName?: string;
    contentType?: string;
}

export interface HttpRequestBodyLimits extends FormBodyLimits {
    maxBodyBytes: number;
    maxCompressedBodyBytes: number;
}

export const defaultHttpRequestBodyLimits: HttpRequestBodyLimits = {
    maxBodyBytes: 100 * 1024 * 1024,
    maxCompressedBodyBytes: 25 * 1024 * 1024,
    ...defaultFormBodyLimits
};

export class HttpRequest extends Readable {
    readonly store: Record<string | symbol, unknown> = {};
    context: Record<string, string> = {};
    readonly query: Record<string, string | string[]> = {};
    readonly path: string;
    readonly headers: HttpRequestHeaders;
    body?: Buffer;
    parsedBody?: unknown;
    uploadedFiles: UploadedFiles = Object.create(null);
    pathParams: Record<string, string> = {};
    remoteAddress = '127.0.0.1';
    socket: Pick<Socket, 'remoteAddress'> = { remoteAddress: this.remoteAddress };
    trustProxyHeaders = false;
    bodyLimits: HttpRequestBodyLimits = { ...defaultHttpRequestBodyLimits };
    private bodyRead?: Promise<Buffer>;
    private streamAttached = false;
    private streamEnded = false;
    private cachedBodyPushed = false;
    private bodyGuardBypass = false;
    private attachedStream?: Readable;
    private cachedBodyDecoded = false;

    constructor(
        readonly method: HttpMethod,
        readonly url: string,
        headers: HttpHeaderInput = {},
        body?: Buffer | string | object,
        private readonly bodyStream?: Readable
    ) {
        super();
        this.headers = createHeaderStore(headers, this);
        const parsed = new URL(url, 'http://localhost');
        this.path = parsed.pathname;
        for (const [key, value] of parsed.searchParams.entries()) {
            const current = this.query[key];
            if (current === undefined) {
                this.query[key] = value;
            } else if (Array.isArray(current)) {
                current.push(value);
            } else {
                this.query[key] = [current, value];
            }
        }

        if (Buffer.isBuffer(body)) this.body = body;
        else if (typeof body === 'string') this.body = Buffer.from(body);
        else if (body !== undefined) {
            this.parsedBody = body;
            this.body = Buffer.from(JSON.stringify(body));
            this.headers['content-type'] ??= 'application/json';
        }
    }

    static GET(url: string, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('GET', url, headers);
    }

    static POST(url: string, body?: Buffer | string | object, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('POST', url, headers, body);
    }

    static PUT(url: string, body?: Buffer | string | object, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('PUT', url, headers, body);
    }

    static PATCH(url: string, body?: Buffer | string | object, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('PATCH', url, headers, body);
    }

    static DELETE(url: string, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('DELETE', url, headers);
    }

    static OPTIONS(url: string, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('OPTIONS', url, headers);
    }

    static HEAD(url: string, headers?: HttpHeaderInput): HttpRequest {
        return new HttpRequest('HEAD', url, headers);
    }

    build(): this {
        return this;
    }

    header(name: string, value: string | number | boolean): this {
        this.headers[name.toLowerCase()] = String(value);
        return this;
    }

    json(body: object): this {
        this.parsedBody = body;
        this.body = Buffer.from(JSON.stringify(body));
        this.headers['content-type'] = 'application/json';
        return this;
    }

    multiPart(parts: MultipartRequestPart[]): this {
        const boundary = `----tsf-${Math.random().toString(16).slice(2)}`;
        const chunks: Buffer[] = [];
        for (const part of parts) {
            chunks.push(Buffer.from(`--${boundary}\r\n`));
            if (part.file !== undefined) {
                chunks.push(
                    Buffer.from(
                        `Content-Disposition: form-data; name="${escapeMultipartName(part.name)}"; filename="${escapeMultipartName(part.fileName ?? 'upload')}"\r\n` +
                            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`
                    )
                );
                chunks.push(Buffer.isBuffer(part.file) ? part.file : Buffer.from(part.file));
                chunks.push(Buffer.from('\r\n'));
                continue;
            }

            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(part.name)}"\r\n\r\n${part.value ?? ''}\r\n`));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        this.body = Buffer.concat(chunks);
        this.parsedBody = undefined;
        this.headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
        return this;
    }

    getRemoteAddress(): string {
        if (!this.trustProxyHeaders) return this.remoteAddress;
        const realIp = getHeader(this.headers, 'x-real-ip');
        if (typeof realIp === 'string') return realIp;
        const forwarded = getHeader(this.headers, 'x-forwarded-for');
        if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || this.remoteAddress;
        return this.remoteAddress;
    }

    async readBodyText(): Promise<string> {
        return (await this.readBodyBuffer()).toString();
    }

    async readBody(): Promise<Buffer> {
        return this.readBodyBuffer();
    }

    async readBodyBuffer(): Promise<Buffer> {
        if (this.body) {
            if (this.bodyGuardBypass || this.cachedBodyDecoded) return this.body;
            if (this.bodyRead) return this.bodyRead;
            this.bodyRead = readStreamBody(createGuardedRequestBodyStream(Readable.from([this.body]), this.headers, this.bodyLimits)).then(body => {
                this.body = body;
                this.cachedBodyDecoded = true;
                return body;
            });
            return this.bodyRead;
        }
        if (!this.bodyStream) return Buffer.alloc(0);
        if (this.bodyRead) return this.bodyRead;
        if (this.streamAttached) throw new Error('Request body stream is already being consumed');
        this.bodyRead = readStreamBody(this.createBodyReadStream()).then(body => {
            this.body = body;
            this.cachedBodyDecoded = true;
            return body;
        });
        return this.bodyRead;
    }

    get stream(): Readable {
        if (this.body && !this.bodyGuardBypass && !this.cachedBodyDecoded)
            return createGuardedRequestBodyStream(Readable.from([this.body]), this.headers, this.bodyLimits);
        if (this.bodyStream && !this.body) return this.createBodyReadStream();
        return Readable.from(this.body ? [this.body] : []);
    }

    setBodyLimits(limits: Partial<HttpRequestBodyLimits>): void {
        this.bodyLimits = { ...this.bodyLimits, ...limits };
    }

    enableBodyGuardBypass(): void {
        this.bodyGuardBypass = true;
    }

    override _read(): void {
        if (this.streamEnded) return;
        if (this.body !== undefined && !this.bodyGuardBypass && !this.cachedBodyDecoded) {
            this.attachReadable(createGuardedRequestBodyStream(Readable.from([this.body]), this.headers, this.bodyLimits));
            return;
        }
        if (this.body !== undefined) {
            if (!this.cachedBodyPushed) {
                this.cachedBodyPushed = true;
                if (this.body.length) this.push(this.body);
                this.streamEnded = true;
                this.push(null);
            }
            return;
        }

        if (!this.bodyStream) {
            this.streamEnded = true;
            this.push(null);
            return;
        }

        if (this.attachedStream) {
            this.attachedStream.resume();
            return;
        }

        this.attachReadable(this.createBodyReadStream());
    }

    private attachReadable(stream: Readable): void {
        if (this.attachedStream) {
            this.attachedStream.resume();
            return;
        }
        this.attachedStream = stream;
        stream.on('data', chunk => {
            if (!this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
                stream.pause();
            }
        });
        stream.once('end', () => {
            this.streamEnded = true;
            this.push(null);
        });
        stream.once('error', error => this.destroy(error));
        stream.resume();
    }

    private createBodyReadStream(): Readable {
        if (this.streamAttached) throw new Error('Request body stream is already being consumed');
        this.streamAttached = true;
        if (!this.bodyStream) return Readable.from([]);
        if (this.bodyGuardBypass) return this.bodyStream;
        return createGuardedRequestBodyStream(this.bodyStream, this.headers, this.bodyLimits);
    }
}

export class HttpRequestStream extends HttpRequest {}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
    return headers[name] ?? headers[name.toLowerCase()];
}

function createHeaderStore(headers: HttpHeaderInput, request: HttpRequest): HttpRequestHeaders {
    const store = ((nextHeaders: HttpHeaderInput) => {
        Object.assign(store, normalizeHeaders(nextHeaders));
        return request;
    }) as HttpRequestHeaders;
    Object.assign(store, normalizeHeaders(headers));
    return store;
}

function normalizeHeaders(headers: HttpHeaderInput): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        normalized[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : String(value);
    }
    return normalized;
}

function createGuardedRequestBodyStream(stream: Readable, headers: Record<string, string>, limits: HttpRequestBodyLimits): Readable {
    const encoding = getContentEncoding(headers);
    if (encoding === 'identity') {
        throwIfContentLengthExceeds(headers, limits.maxBodyBytes, 'Request body is too large');
        return pipelineToReadable([stream, new ByteLimitTransform(limits.maxBodyBytes, 'Request body is too large')], encoding);
    }

    if (encoding === 'gzip' || encoding === 'x-gzip') {
        throwIfContentLengthExceeds(headers, limits.maxCompressedBodyBytes, 'Compressed request body is too large');
        return pipelineToReadable(
            [
                stream,
                new ByteLimitTransform(limits.maxCompressedBodyBytes, 'Compressed request body is too large'),
                createGunzip(),
                new ByteLimitTransform(limits.maxBodyBytes, 'Request body is too large')
            ],
            encoding
        );
    }

    throw new HttpUnsupportedMediaTypeError(`Unsupported request content encoding: ${encoding}`);
}

function pipelineToReadable(streams: Readable[], encoding: string): Readable {
    const output = new PassThrough();
    const fail = (error: Error) => {
        if (!output.destroyed) output.destroy(normalizeBodyStreamError(error, encoding));
    };
    // Register before pipeline() so the normalized HTTP error reaches readers
    // before pipeline propagates the lower-level zlib/stream error to output.
    for (const stream of streams) stream.once('error', fail);
    (pipeline as (...args: unknown[]) => void)(...streams, output, (error?: Error | null) => {
        if (error) fail(error);
    });
    return output;
}

function normalizeBodyStreamError(error: Error, encoding: string): Error {
    if (error instanceof HttpPayloadTooLargeError || error instanceof HttpUnsupportedMediaTypeError || error instanceof HttpBadRequestError)
        return error;
    if (encoding !== 'identity') return new HttpBadRequestError('Failed to decode request body');
    return error;
}

function getContentEncoding(headers: Record<string, string>): string {
    const value = headers['content-encoding'] ?? headers['Content-Encoding'];
    const encoding = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
    return encoding || 'identity';
}

function throwIfContentLengthExceeds(headers: Record<string, string>, maxBytes: number, message: string): void {
    const value = headers['content-length'] ?? headers['Content-Length'];
    if (value === undefined) return;
    const size = Number.parseInt(Array.isArray(value) ? (value[0] ?? '') : value, 10);
    if (Number.isFinite(size) && size > maxBytes) throw new HttpPayloadTooLargeError(message);
}

class ByteLimitTransform extends Transform {
    private size = 0;

    constructor(
        private readonly maxBytes: number,
        private readonly message: string
    ) {
        super();
    }

    override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        this.size += buffer.length;
        if (this.size > this.maxBytes) {
            callback(new HttpPayloadTooLargeError(this.message));
            return;
        }
        callback(null, buffer);
    }
}

function escapeMultipartName(value: string): string {
    return value.replace(/["\r\n]/g, '_');
}

function readStreamBody(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}
