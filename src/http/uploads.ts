import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { uuid7 } from '../helpers';
import { HttpBadRequestError, HttpError, HttpPayloadTooLargeError, HttpUnsupportedMediaTypeError } from './errors';
import type { HttpRequest } from './request';

export type FileUploadAllowedTypes = readonly string[] | string;

export interface FileUploadOptions {
    maxSize?: number | `${number}${'B' | 'KB' | 'MB' | 'GB' | 'KiB' | 'MiB' | 'GiB'}`;
    allowedTypes?: FileUploadAllowedTypes;
}

export interface FileUploadPolicy {
    maxSizeBytes?: number;
    allowedTypes?: string[];
}

export interface MultipartRequestPolicy {
    files?: Record<string, FileUploadPolicy>;
    rejectUndeclaredFiles?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class FileUpload<Options extends FileUploadOptions = {}> {
    path!: string;
    size!: number;
    type!: string;
    declaredType!: string;
    detectedType?: string;
    detectedExtension?: string;
    originalName!: string;

    get name(): string {
        return this.originalName;
    }
}

export type UploadedFiles = Record<string, FileUpload | FileUpload[]>;

export interface ParsedMultipartBody {
    body: Record<string, unknown>;
    uploadedFiles: UploadedFiles;
}

const multipartJsonKey = '_payload';
const UploadTempDirsSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-upload-temp-dirs');

export function isMultipartRequest(request: HttpRequest): boolean {
    const contentType = getContentType(request);
    return /^multipart\/form-data\b/i.test(contentType);
}

type FileTypeResult = { ext: string; mime: string };
type FileTypeModule = typeof import('file-type');

let fileTypeModulePromise: Promise<FileTypeModule> | undefined;

export async function parseMultipartRequest(request: HttpRequest, policy: MultipartRequestPolicy = {}): Promise<ParsedMultipartBody> {
    const contentType = getContentType(request);
    if (!isMultipartRequest(request)) {
        throw new HttpBadRequestError('Request is not multipart/form-data');
    }

    let parser: ReturnType<typeof busboy>;
    try {
        parser = busboy({
            headers: { 'content-type': contentType }
        });
    } catch {
        throw new HttpBadRequestError('Failed to parse multipart body');
    }

    const fields: Record<string, unknown> = {};
    const uploadedFiles: UploadedFiles = {};
    const fileWrites: Array<Promise<{ name: string; upload: FileUpload }>> = [];
    const uploadDir = await mkdtemp(join(tmpdir(), 'tsf-upload-'));
    getUploadTempDirs(request).push(uploadDir);
    const fileWriteErrors = new Set<unknown>();
    let multipartError: HttpError | undefined;

    parser.on('field', (name, value) => {
        if (name === multipartJsonKey) {
            try {
                const parsed = value ? JSON.parse(value) : {};
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Multipart JSON payload must be an object');
                }
                Object.assign(fields, parsed);
            } catch {
                multipartError ??= new HttpBadRequestError('Failed to parse multipart JSON payload');
            }
            return;
        }

        assignMultiValue(fields, name, value);
    });

    parser.on('file', (name, file, info) => {
        const filePolicy = policy.files?.[name];
        if (!filePolicy && policy.rejectUndeclaredFiles) {
            multipartError ??= new HttpBadRequestError(`Unexpected file field "${name}"`);
            file.resume();
            return;
        }

        const write = writeMultipartFile(uploadDir, name, file, info, filePolicy).then(upload => ({ name, upload }));
        write.catch(error => {
            fileWriteErrors.add(error);
        });
        fileWrites.push(write);
    });

    let completedFiles: Array<{ name: string; upload: FileUpload }>;
    try {
        await pipeline(request.stream, parser);
        if (multipartError) throw multipartError;
        completedFiles = await Promise.all(fileWrites);
    } catch (error) {
        await Promise.allSettled(fileWrites);
        if (error instanceof HttpError || fileWriteErrors.has(error)) throw error;
        throw new HttpBadRequestError('Failed to parse multipart body');
    }
    // Promise.all preserves the parser's file-event order even when a later,
    // smaller upload finishes writing first.
    for (const { name, upload } of completedFiles) {
        assignMultiValue(uploadedFiles, name, upload);
        assignMultiValue(fields, name, upload);
    }

    return { body: fields, uploadedFiles };
}

export function parseByteSize(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    if (typeof value !== 'string') return undefined;

    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/i.exec(value.trim());
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const unit = (match[2] ?? 'b').toLowerCase();
    const multiplier =
        unit === 'gb' || unit === 'gib' ? 1024 ** 3 : unit === 'mb' || unit === 'mib' ? 1024 ** 2 : unit === 'kb' || unit === 'kib' ? 1024 : 1;
    return Math.floor(amount * multiplier);
}

export function normalizeAllowedTypes(value: unknown): string[] | undefined {
    if (typeof value === 'string') {
        const pattern = normalizeMimePattern(value);
        return pattern ? [pattern] : undefined;
    }
    if (!Array.isArray(value)) return undefined;
    return value.map(item => (typeof item === 'string' ? normalizeMimePattern(item) : '')).filter(Boolean);
}

export function mimeMatchesAllowedTypes(mimeType: string, allowedTypes: readonly string[] | undefined): boolean {
    if (!allowedTypes?.length) return true;
    const normalized = normalizeMimeType(mimeType);
    return allowedTypes.some(pattern => mimeMatchesPattern(normalized, pattern));
}

async function writeMultipartFile(
    uploadDir: string,
    name: string,
    file: NodeJS.ReadableStream,
    info: { filename?: string; mimeType?: string },
    policy?: FileUploadPolicy
): Promise<FileUpload> {
    const declaredType = normalizeMimeType(info.mimeType || 'application/octet-stream');
    if (!mimeMatchesAllowedTypes(declaredType, policy?.allowedTypes)) {
        file.resume();
        throw new HttpUnsupportedMediaTypeError(`File field "${name}" has unsupported content type`);
    }

    const upload = new FileUpload();
    upload.path = join(uploadDir, `${uuid7()}-${sanitizeFilename(info.filename || 'upload')}`);
    upload.size = 0;
    upload.type = declaredType;
    upload.declaredType = declaredType;
    upload.originalName = info.filename || 'upload';

    const fileType = policy?.allowedTypes?.length ? await loadFileTypeModule() : undefined;
    const validator = new FileUploadValidationTransform({
        name,
        upload,
        policy,
        sampleSize: (fileType as (FileTypeModule & { reasonableDetectionSizeInBytes?: number }) | undefined)?.reasonableDetectionSizeInBytes ?? 4100,
        detect: fileType ? buffer => fileType.fileTypeFromBuffer(buffer) as Promise<FileTypeResult | undefined> : undefined
    });

    await pipeline(file, validator, createWriteStream(upload.path));
    return upload;
}

class FileUploadValidationTransform extends Transform {
    private buffered: Buffer[] = [];
    private sample: Buffer[] = [];
    private sampleBytes = 0;
    private validated = false;

    constructor(
        private readonly options: {
            name: string;
            upload: FileUpload;
            policy?: FileUploadPolicy;
            sampleSize: number;
            detect?: (buffer: Buffer) => Promise<FileTypeResult | undefined>;
        }
    ) {
        super();
    }

    override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        this.options.upload.size += buffer.length;
        if (this.options.policy?.maxSizeBytes !== undefined && this.options.upload.size > this.options.policy.maxSizeBytes) {
            callback(new HttpPayloadTooLargeError(`File field "${this.options.name}" is too large`));
            return;
        }

        if (!this.options.detect || this.validated) {
            callback(null, buffer);
            return;
        }

        this.buffered.push(buffer);
        this.appendSample(buffer);
        if (this.sampleBytes < this.options.sampleSize) {
            callback();
            return;
        }

        this.validateAndRelease(callback);
    }

    override _flush(callback: (error?: Error | null) => void): void {
        if (!this.options.detect || this.validated) {
            callback();
            return;
        }
        this.validateAndRelease(callback);
    }

    private appendSample(buffer: Buffer): void {
        if (this.sampleBytes >= this.options.sampleSize) return;
        const remaining = this.options.sampleSize - this.sampleBytes;
        const sample = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
        this.sample.push(sample);
        this.sampleBytes += sample.length;
    }

    private validateAndRelease(callback: (error?: Error | null, data?: Buffer) => void): void {
        this.validateDetectedType()
            .then(() => {
                for (const chunk of this.buffered) this.push(chunk);
                this.buffered = [];
                callback();
            })
            .catch(callback);
    }

    private async validateDetectedType(): Promise<void> {
        if (this.validated) return;
        this.validated = true;
        const sample = Buffer.concat(this.sample, this.sampleBytes);
        const detected = sample.length ? await this.options.detect?.(sample) : undefined;
        if (!detected?.mime) {
            throw new HttpUnsupportedMediaTypeError(`File field "${this.options.name}" has unsupported content type`);
        }
        const detectedType = normalizeMimeType(detected.mime);
        if (!mimeMatchesAllowedTypes(detectedType, this.options.policy?.allowedTypes)) {
            throw new HttpUnsupportedMediaTypeError(`File field "${this.options.name}" has unsupported content type`);
        }
        this.options.upload.detectedType = detectedType;
        this.options.upload.detectedExtension = detected.ext;
    }
}

function loadFileTypeModule(): Promise<FileTypeModule> {
    fileTypeModulePromise ??= (new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<FileTypeModule>)('file-type');
    return fileTypeModulePromise;
}

export async function cleanupUploadedFiles(request: HttpRequest): Promise<void> {
    const uploadDirs = getUploadTempDirs(request);
    if (!uploadDirs.length) return;

    request.store[UploadTempDirsSymbol] = [];
    request.uploadedFiles = {};
    await Promise.all(uploadDirs.map(dir => rm(dir, { recursive: true, force: true })));
}

function getContentType(request: HttpRequest): string {
    const value = request.headers['content-type'] ?? request.headers['Content-Type'];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function assignMultiValue<T>(target: Record<string, T | T[]>, name: string, value: T): void {
    const current = target[name];
    if (current === undefined) {
        target[name] = value;
    } else if (Array.isArray(current)) {
        current.push(value);
    } else {
        target[name] = [current, value];
    }
}

function normalizeMimeType(value: string): string {
    return value.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

function normalizeMimePattern(value: string): string {
    const normalized = normalizeMimeType(value);
    return isMimePattern(normalized) ? normalized : '';
}

function mimeMatchesPattern(mimeType: string, pattern: string): boolean {
    if (pattern === '*/*') return true;
    const [patternType, patternSubtype] = pattern.split('/');
    const [mimeTypeName, mimeSubtype] = mimeType.split('/');
    if (!patternType || !patternSubtype || !mimeTypeName || !mimeSubtype) return false;
    if (patternSubtype === '*') return patternType === mimeTypeName;
    return patternType === mimeTypeName && patternSubtype === mimeSubtype;
}

function isMimePattern(value: string): boolean {
    return /^(?:\*|[a-z0-9!#$&^_.+-]+)\/(?:\*|[a-z0-9!#$&^_.+-]+)$/i.test(value);
}

function sanitizeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'upload';
}

function getUploadTempDirs(request: HttpRequest): string[] {
    const existing = request.store[UploadTempDirsSymbol];
    if (Array.isArray(existing)) return existing as string[];
    const dirs: string[] = [];
    request.store[UploadTempDirsSymbol] = dirs;
    return dirs;
}
