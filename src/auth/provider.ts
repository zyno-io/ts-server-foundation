import { createHash, randomBytes as nodeRandomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import bcrypt from 'bcrypt';

import { BaseAppConfig, getAppConfig } from '../app';
import { randomBytes } from '../helpers';
import { HttpUnauthorizedError } from '../http/errors';
import type { HttpMiddleware } from '../http/middleware';
import type { HttpRequest } from '../http/request';

const scrypt = promisify(nodeScrypt);
const ResetTokenRandomBytes = 16;

export interface ResetToken<T = unknown> {
    token: string;
    data: T;
    generationTime: number;
    verifier: string;
}

export class Auth {
    static async hashPassword(password: string): Promise<string> {
        const salt = nodeRandomBytes(16).toString('base64url');
        const hash = (await scrypt(password, salt, 32)) as Buffer;
        return `scrypt$${salt}$${hash.toString('base64url')}`;
    }

    static async verifyHash(password: string, encodedHash: string): Promise<boolean> {
        if (isBcryptHash(encodedHash)) return verifyBcryptHash(password, encodedHash);
        return verifyScryptHash(password, encodedHash);
    }

    static async generateResetToken<T>(data: T): Promise<ResetToken<T>> {
        const generationTime = Math.floor(Date.now() / 1000) * 1000;
        const random = await randomBytes(ResetTokenRandomBytes);
        const payload = Buffer.from(JSON.stringify(data), 'utf8');
        const token = [Math.floor(generationTime / 1000).toString(36), random.toString('base64url'), payload.toString('base64url')].join('.');

        return {
            token,
            data,
            generationTime,
            verifier: createHash('sha256').update(random).digest('base64url')
        };
    }

    static async decodeResetToken<T>(token: string): Promise<ResetToken<T>> {
        return decodeResetTokenParts<T>(token);
    }
}

async function verifyScryptHash(password: string, encodedHash: string): Promise<boolean> {
    const parts = encodedHash.split('$');
    if (parts.length !== 3) return false;

    const [algorithm, salt, expectedHash] = parts;
    if (algorithm !== 'scrypt' || !isBase64Url(salt) || !isBase64Url(expectedHash)) return false;

    const actual = (await scrypt(password, salt, 32)) as Buffer;
    const expected = Buffer.from(expectedHash, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function verifyBcryptHash(password: string, hash: string): Promise<boolean> {
    try {
        const normalizedHash = hash.startsWith('$2y$') ? `$2b$${hash.slice(4)}` : hash;
        return await bcrypt.compare(password, normalizedHash);
    } catch {
        return false;
    }
}

function isBcryptHash(value: string): boolean {
    return /^\$2[abxy]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(value);
}

export function createBasicAuthMiddleware(expectedUsername?: string) {
    return class BasicAuthMiddleware implements HttpMiddleware {
        readonly config: BaseAppConfig = getAppConfig();

        async handle(request: HttpRequest): Promise<void> {
            const authHeader = getHeader(request, 'authorization');
            if (typeof authHeader !== 'string') throw new HttpUnauthorizedError();

            const match = /^basic\s+(\S+)$/i.exec(authHeader.trim());
            if (!match) throw new HttpUnauthorizedError('Invalid authorization scheme');

            const credentials = decodeBasicCredentials(match[1]);
            if (!credentials) throw new HttpUnauthorizedError('Invalid credentials');

            const expectedSecret = this.config.AUTH_BASIC_SECRET;
            const usernameInvalid = expectedUsername !== undefined && !timingSafeStringEqual(credentials.username, expectedUsername);
            const passwordInvalid = !expectedSecret || !timingSafeStringEqual(credentials.password, expectedSecret);

            if (usernameInvalid || passwordInvalid) throw new HttpUnauthorizedError('Invalid credentials');
        }
    };
}

function decodeResetTokenParts<T>(token: string): ResetToken<T> {
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[0] || !isBase64Url(parts[1]) || !isBase64Url(parts[2])) throw new Error('Invalid reset token');

        const generationTime = parseGenerationTime(parts[0]);
        const random = Buffer.from(parts[1], 'base64url');
        if (random.length !== ResetTokenRandomBytes) throw new Error('Invalid reset token');

        const data = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8')) as T;
        return formatResetToken(token, data, generationTime, random);
    } catch (error) {
        if (error instanceof Error && error.message === 'Invalid reset token') throw error;
        throw new Error('Invalid reset token');
    }
}

function formatResetToken<T>(token: string, data: T, generationTime: number, random: Buffer): ResetToken<T> {
    return {
        token,
        data,
        generationTime,
        verifier: createHash('sha256').update(random).digest('base64url')
    };
}

function parseGenerationTime(value: string): number {
    if (!/^[0-9a-z]+$/i.test(value)) throw new Error('Invalid reset token');
    const generationTime = parseInt(value, 36) * 1000;
    if (!Number.isSafeInteger(generationTime) || generationTime < 0) throw new Error('Invalid reset token');
    return generationTime;
}

function decodeBasicCredentials(value: string): { username: string; password: string } | undefined {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined;

    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return undefined;
    return {
        username: decoded.slice(0, separator),
        password: decoded.slice(separator + 1)
    };
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
    const actualHash = createHash('sha256').update(actual, 'utf8').digest();
    const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
    return timingSafeEqual(actualHash, expectedHash);
}

function isBase64Url(value: string): boolean {
    return /^[A-Za-z0-9_-]+={0,2}$/.test(value) && value.length % 4 !== 1;
}

function getHeader(request: HttpRequest, name: string): string | string[] | undefined {
    return request.headers[name] ?? request.headers[name.toLowerCase()];
}
