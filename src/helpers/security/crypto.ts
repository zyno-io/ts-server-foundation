import * as crypto from 'node:crypto';
import { promisify } from 'node:util';

import { getAppConfig } from '../../app';

const randomBytesAsync = promisify(crypto.randomBytes);

export function randomBytes(length: number, shouldReturnHex?: false): Promise<Buffer>;
export function randomBytes(length: number, shouldReturnHex: true): Promise<string>;
export async function randomBytes(length: number, shouldReturnHex?: boolean): Promise<Buffer | string> {
    const bytes = await randomBytesAsync(length);
    return shouldReturnHex ? bytes.toString('hex') : bytes;
}

export function randomBytesSync(length: number, shouldReturnHex?: false): Buffer;
export function randomBytesSync(length: number, shouldReturnHex: true): string;
export function randomBytesSync(length: number, shouldReturnHex?: boolean): Buffer | string {
    const bytes = crypto.randomBytes(length);
    return shouldReturnHex ? bytes.toString('hex') : bytes;
}

export const PrintableCharacters = Array.from({ length: 127 - 32 }, (_, index) => String.fromCharCode(index + 32)).join('');
export const AlphanumericCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const UpperCaseAlphanumericCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const NumericCharacters = '0123456789';

export async function randomString(length: number, source = AlphanumericCharacters): Promise<string> {
    return randomStringFromBytes(await randomBytes(length), source);
}

export function randomStringSync(length: number, source = AlphanumericCharacters): string {
    return randomStringFromBytes(randomBytesSync(length), source);
}

export interface CryptoOptions {
    secret?: string;
    ivLength?: number;
}

export class Crypto {
    private static instance?: Crypto;

    static encrypt(data: string): string;
    static encrypt(data: Buffer): Buffer;
    static encrypt(data: string | Buffer): string | Buffer {
        return this.getInstance().encrypt(data as never) as string | Buffer;
    }

    static decrypt(data: string): string;
    static decrypt(data: Buffer): Buffer;
    static decrypt(data: string | Buffer): string | Buffer {
        return this.getInstance().decrypt(data as never) as string | Buffer;
    }

    static reset(): void {
        this.instance = undefined;
    }

    private static getInstance(): Crypto {
        this.instance ??= new Crypto();
        return this.instance;
    }

    private readonly key: Buffer;
    private readonly ivLength: number;

    constructor(options: CryptoOptions = {}) {
        const config = options.secret === undefined ? getAppConfig() : undefined;
        this.key = parseSecret(options.secret ?? config?.CRYPTO_SECRET);
        this.ivLength = parseIvLength(options.ivLength ?? config?.CRYPTO_IV_LENGTH);
    }

    encrypt(data: string): string;
    encrypt(data: Buffer): Buffer;
    encrypt(data: string | Buffer): string | Buffer {
        const inputIsBuffer = Buffer.isBuffer(data);
        const input = inputIsBuffer ? data : Buffer.from(data);
        const iv = crypto.randomBytes(this.ivLength);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
        const output = Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
        return inputIsBuffer ? output : output.toString('base64');
    }

    decrypt(data: string): string;
    decrypt(data: Buffer): Buffer;
    decrypt(data: string | Buffer): string | Buffer {
        const inputIsBuffer = Buffer.isBuffer(data);
        const input = inputIsBuffer ? data : parseEncryptedString(data);
        if (input.length < this.ivLength + 16) throw new Error('Invalid encrypted payload');
        const iv = input.subarray(0, this.ivLength);
        const authTag = input.subarray(input.length - 16);
        const encrypted = input.subarray(this.ivLength, input.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAuthTag(authTag);
        const output = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return inputIsBuffer ? output : output.toString('utf8');
    }
}

function randomStringFromBytes(bytes: Buffer, source: string): string {
    if (!source.length) throw new Error('randomString source must not be empty');
    return Array.from({ length: bytes.length }, (_, index) => source[bytes[index] % source.length]).join('');
}

function parseSecret(secret: string | undefined): Buffer {
    if (!secret) throw new Error('CRYPTO_SECRET is not set in application configuration');
    if (secret.length === 64 && /^[0-9a-f]+$/i.test(secret)) return Buffer.from(secret, 'hex');
    const key = Buffer.from(secret);
    if (key.length !== 32) throw new Error('CRYPTO_SECRET must be 32 bytes or 64 hex characters');
    return key;
}

function parseIvLength(ivLength: number | undefined): number {
    ivLength ??= 12;
    if (!Number.isInteger(ivLength) || ivLength < 12) throw new Error('CRYPTO_IV_LENGTH must be an integer of at least 12 bytes for AES-GCM');
    return ivLength;
}

function parseEncryptedString(data: string): Buffer {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error('Invalid encrypted payload');
    return Buffer.from(data, 'base64');
}
