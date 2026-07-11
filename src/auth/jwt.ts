import { createPrivateKey, createPublicKey } from 'node:crypto';

import { createDecoder, createSigner, createVerifier, TokenError } from 'fast-jwt';
import type { Algorithm } from 'fast-jwt';

import { BaseAppConfig, getAppConfig } from '../app';
import type { HttpRequest } from '../http/request';
import type { HttpResponse } from '../http/response';

type JwtExtras = object;
type FastJwtPayload = Record<string, unknown>;
type FastJwtSigner = (payload: FastJwtPayload) => string;
type FastJwtVerifier = (token: string | Buffer) => FastJwtPayload;
type FastJwtDecoder = (token: string | Buffer) => FastJwtPayload;
type FastJwtCompleteDecoder = (token: string | Buffer) => {
    header: Record<string, unknown>;
    payload: FastJwtPayload;
    signature: string;
    input: string;
};

const JWT_ALGORITHMS = new Set<string>([
    'none',
    'HS256',
    'HS384',
    'HS512',
    'ES256',
    'ES384',
    'ES512',
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'EdDSA'
]);

const REQUIRED_JWT_CLAIMS = ['iss', 'sub', 'exp', 'iat'];

const TokenErrorClasses = {
    decode: new Set<string>([TokenError.codes.invalidPayload, TokenError.codes.malformed, TokenError.codes.invalidType]),
    verify: new Set<string>([
        TokenError.codes.verifyError,
        TokenError.codes.invalidSignature,
        TokenError.codes.invalidKey,
        TokenError.codes.missingKey,
        TokenError.codes.keyFetchingError,
        TokenError.codes.missingSignature
    ]),
    payload: new Set<string>([
        TokenError.codes.invalidAlgorithm,
        TokenError.codes.invalidClaimType,
        TokenError.codes.invalidClaimValue,
        TokenError.codes.missingRequiredClaim,
        TokenError.codes.invalidCritHeader
    ]),
    expiry: new Set<string>([TokenError.codes.expired, TokenError.codes.inactive])
};

const decoder = createDecoder() as FastJwtDecoder;
const completeDecoder = createDecoder({ complete: true }) as FastJwtCompleteDecoder;

export interface JwtCookieOptions {
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    domain?: string;
}

export interface JwtGenerationOptions<T extends JwtExtras = JwtExtras> {
    id?: string;
    issuer?: string;
    audience?: string | string[];
    subject: string;
    expiresAt?: Date | number;
    expiryMins?: number;
    payload?: T;
}

export interface JwtVerifierOptions {
    issuer?: string;
    audience?: string | string[];
    key: string | Buffer;
    algorithm?: Algorithm | string;
}

export class ParsedJwt<T extends JwtExtras = JwtExtras> {
    readonly isValid = true;
    id?: string;
    issuer!: string;
    audience?: string | string[];
    subject!: string;
    issuedAtMs!: number;
    expiresAtMs!: number;
    payload!: T;
    rawPayload!: Record<string, unknown>;

    get issuedAt(): Date {
        return new Date(this.issuedAtMs);
    }

    get expiresAt(): Date {
        return new Date(this.expiresAtMs);
    }
}

export interface InvalidJwtValidationResult {
    isValid: false;
    isDecodable: boolean;
    isSignatureValid?: boolean;
    isPayloadValid?: boolean;
    isNotExpired?: boolean;
}

export type JwtValidationResult<T extends JwtExtras = JwtExtras> = ParsedJwt<T> | InvalidJwtValidationResult;

export class JWT {
    static async generate<T extends JwtExtras = JwtExtras>(options: JwtGenerationOptions<T>): Promise<string> {
        const config = getAppConfig();
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            ...options.payload,
            ...(options.id ? { jti: options.id } : {}),
            iss: options.issuer ?? config.AUTH_JWT_ISSUER ?? 'app',
            aud: options.audience,
            sub: options.subject,
            iat: now,
            exp: getExpirationTs(options, config, now)
        };

        return signJwt(payload, config);
    }

    static async generateCookie<T extends JwtExtras = JwtExtras>(
        options: JwtGenerationOptions<T>,
        response: HttpResponse,
        cookieOptions?: JwtCookieOptions
    ): Promise<void> {
        const token = await this.generate(options);
        appendSetCookie(response, `${getCookieName()}=${token}; ${buildCookieAttributes(cookieOptions)}`);
    }

    static async clearCookie(response: HttpResponse, cookieOptions?: JwtCookieOptions): Promise<void> {
        appendSetCookie(response, `${getCookieName()}=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${buildCookieAttributes(cookieOptions)}`);
    }

    static createVerifier<T extends JwtExtras = JwtExtras>(options: JwtVerifierOptions): (token: string) => Promise<JwtValidationResult<T>> {
        const algorithm = resolveExplicitJwtAlgorithm(options.algorithm);
        if (options.algorithm !== undefined && algorithm === undefined) {
            return async () => ({ isValid: false, isDecodable: false });
        }

        let verifier: FastJwtVerifier;
        try {
            verifier = createJwtVerifier(options.key, {
                issuer: options.issuer,
                audience: options.audience,
                algorithm
            });
        } catch (err) {
            return async () => formatJwtError(err);
        }

        return token =>
            verifyWithFastJwt<T>(token, verifier, {
                issuer: options.issuer,
                audience: options.audience
            });
    }

    static async verify<T extends JwtExtras = JwtExtras>(
        token: string,
        key?: string | Buffer,
        options: {
            issuer?: string;
            audience?: string | string[];
            algorithm?: Algorithm | string;
        } = {}
    ): Promise<JwtValidationResult<T>> {
        const algorithm = resolveExplicitJwtAlgorithm(options.algorithm);
        if (options.algorithm !== undefined && algorithm === undefined) {
            return { isValid: false, isDecodable: false };
        }

        const config = getAppConfig();
        const issuer = options.issuer ?? config.AUTH_JWT_ISSUER;
        try {
            const verifier = createJwtVerifier(key ?? getJwtVerificationKey(config), {
                issuer,
                audience: options.audience,
                algorithm
            });
            return verifyWithFastJwt<T>(token, verifier, { issuer, audience: options.audience });
        } catch (err) {
            return formatJwtError(err);
        }
    }

    static async decode<T extends JwtExtras = JwtExtras>(token: string): Promise<JwtValidationResult<T>> {
        try {
            return formatPayload<T>(decoder(token));
        } catch (err) {
            return formatJwtError(err);
        }
    }

    static async process<T extends JwtExtras = JwtExtras>(token: string): Promise<JwtValidationResult<T>> {
        return getAppConfig().AUTH_JWT_ENABLE_VERIFY ? this.verify<T>(token) : this.decode<T>(token);
    }

    static async processWithRequest<T extends JwtExtras = JwtExtras>(request: HttpRequest): Promise<JwtValidationResult<T> | null> {
        const authorization = getHeader(request, 'authorization');
        if (typeof authorization === 'string') {
            const match = /^bearer\s+(\S+)$/i.exec(authorization.trim());
            if (match) return this.process<T>(match[1]);
        }

        const cookie = getHeader(request, 'cookie');
        if (typeof cookie === 'string') {
            const token = readCookie(cookie, getCookieName());
            if (token) return this.process<T>(token);
        }

        return null;
    }
}

function signJwt(payload: FastJwtPayload, config: BaseAppConfig): string {
    const algorithm = resolveSigningJwtAlgorithm(config);
    const signer = createSigner({
        algorithm,
        key: getJwtSigningKey(config, algorithm)
    }) as FastJwtSigner;
    return signer(payload);
}

async function verifyWithFastJwt<T extends JwtExtras>(
    token: string,
    verifier: FastJwtVerifier,
    options: { issuer?: string; audience?: string | string[] }
): Promise<JwtValidationResult<T>> {
    try {
        const decoded = completeDecoder(token);
        if (!isSupportedType(decoded.header)) {
            return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
        }
        return validatePayload<T>(verifier(token), options);
    } catch (err) {
        return formatJwtError(err);
    }
}

function createJwtVerifier(key: string | Buffer, options: { issuer?: string; audience?: string | string[]; algorithm?: Algorithm }): FastJwtVerifier {
    return createVerifier({
        cache: true,
        allowedIss: options.issuer,
        allowedAud: options.audience,
        algorithms: options.algorithm === undefined ? undefined : [options.algorithm],
        key: normalizeVerificationKey(key, options.algorithm),
        requiredClaims: REQUIRED_JWT_CLAIMS
    }) as FastJwtVerifier;
}

function isSupportedType(header: Record<string, unknown>): boolean {
    return header.typ === undefined || header.typ === 'JWT';
}

function validatePayload<T extends JwtExtras>(
    payload: FastJwtPayload,
    options: { issuer?: string; audience?: string | string[] }
): JwtValidationResult<T> {
    if (typeof payload.iss !== 'string' || typeof payload.sub !== 'string' || payload.sub.length === 0) {
        return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
    }
    if (options.issuer !== undefined && payload.iss !== options.issuer) {
        return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
    }
    if (!isAudienceClaim(payload.aud)) {
        return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
    }
    if (options.audience !== undefined && !isAudienceAccepted(payload.aud, options.audience)) {
        return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
    }
    const exp = payload.exp;
    const iat = payload.iat;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || typeof iat !== 'number' || !Number.isFinite(iat)) {
        return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
    }
    if (exp <= Math.floor(Date.now() / 1000)) {
        return {
            isValid: false,
            isDecodable: true,
            isSignatureValid: true,
            isPayloadValid: true,
            isNotExpired: false
        };
    }
    return formatPayload<T>(payload);
}

function formatPayload<T extends JwtExtras>(payload: FastJwtPayload): ParsedJwt<T> {
    const { jti, sub, iss, aud, iat, exp, ...extras } = payload;
    const parsed = new ParsedJwt<T>();
    parsed.id = typeof jti === 'string' ? jti : undefined;
    parsed.subject = String(sub ?? '');
    parsed.issuer = String(iss ?? '');
    parsed.audience = Array.isArray(aud) ? aud.map(String) : aud === undefined ? undefined : String(aud);
    parsed.issuedAtMs = (typeof iat === 'number' ? iat : Number(iat ?? 0)) * 1000;
    parsed.expiresAtMs = (typeof exp === 'number' ? exp : Number(exp ?? 0)) * 1000;
    parsed.payload = extras as T;
    parsed.rawPayload = payload;
    return parsed;
}

function formatJwtError(err: unknown): InvalidJwtValidationResult {
    if (err instanceof TokenError) {
        if (TokenErrorClasses.decode.has(err.code)) {
            return { isValid: false, isDecodable: false };
        }
        if (TokenErrorClasses.verify.has(err.code)) {
            return { isValid: false, isDecodable: true, isSignatureValid: false };
        }
        if (TokenErrorClasses.payload.has(err.code)) {
            return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: false };
        }
        if (TokenErrorClasses.expiry.has(err.code)) {
            return { isValid: false, isDecodable: true, isSignatureValid: true, isPayloadValid: true, isNotExpired: false };
        }
    }
    throw err;
}

function resolveSigningJwtAlgorithm(config: BaseAppConfig): Algorithm {
    validateJwtSecretConfig(config);
    return config.AUTH_JWT_ED_SECRET ? 'EdDSA' : 'HS256';
}

function resolveExplicitJwtAlgorithm(explicit: string | undefined): Algorithm | undefined {
    if (explicit === undefined) return undefined;
    return JWT_ALGORITHMS.has(explicit) ? (explicit as Algorithm) : undefined;
}

function validateJwtSecretConfig(config: BaseAppConfig): void {
    if (config.AUTH_JWT_SECRET && config.AUTH_JWT_SECRET_B64) throw new Error('AUTH_JWT_SECRET and AUTH_JWT_SECRET_B64 cannot both be configured');
    if ((config.AUTH_JWT_SECRET || config.AUTH_JWT_SECRET_B64) && config.AUTH_JWT_ED_SECRET) {
        throw new Error('AUTH_JWT_SECRET/AUTH_JWT_SECRET_B64 and AUTH_JWT_ED_SECRET cannot both be configured');
    }
}

function getJwtSigningKey(config: BaseAppConfig, algorithm: Algorithm): string | Buffer {
    return algorithm === 'EdDSA' ? getJwtPrivateKey(config) : getJwtHmacSecret(config);
}

function getJwtHmacSecret(config: BaseAppConfig): string | Buffer {
    validateJwtSecretConfig(config);
    if (config.AUTH_JWT_SECRET_B64) {
        if (!isBase64(config.AUTH_JWT_SECRET_B64)) throw new Error('AUTH_JWT_SECRET_B64 must be valid base64');
        const secret = Buffer.from(config.AUTH_JWT_SECRET_B64, 'base64');
        if (!secret.length) throw new Error('AUTH_JWT_SECRET_B64 must decode to at least one byte');
        return secret;
    }
    if (config.AUTH_JWT_SECRET) return config.AUTH_JWT_SECRET;
    throw new Error('AUTH_JWT_SECRET/AUTH_JWT_SECRET_B64/AUTH_JWT_ED_SECRET is not configured');
}

function getJwtPrivateKey(config: BaseAppConfig): string | Buffer {
    validateJwtSecretConfig(config);
    if (!config.AUTH_JWT_ED_SECRET) throw new Error('AUTH_JWT_SECRET/AUTH_JWT_SECRET_B64/AUTH_JWT_ED_SECRET is not configured');
    return normalizeEdPrivateKey(config.AUTH_JWT_ED_SECRET);
}

function getJwtVerificationKey(config: BaseAppConfig): string | Buffer {
    return config.AUTH_JWT_ED_SECRET ? deriveEdPublicKey(getJwtPrivateKey(config)) : getJwtHmacSecret(config);
}

function normalizeVerificationKey(key: string | Buffer, algorithm?: Algorithm): string | Buffer {
    return algorithm === 'EdDSA' ? normalizeEdPublicKey(key) : key;
}

function getExpirationTs(options: JwtGenerationOptions, config: BaseAppConfig, now: number): number {
    if (options.expiresAt instanceof Date) return Math.floor(options.expiresAt.getTime() / 1000);
    if (typeof options.expiresAt === 'number') return Math.floor(options.expiresAt / 1000);
    return now + (options.expiryMins ?? config.AUTH_JWT_EXPIRATION_MINS ?? 60) * 60;
}

function getCookieName(): string {
    return getAppConfig().AUTH_JWT_COOKIE_NAME ?? 'jwt';
}

function appendSetCookie(response: HttpResponse, cookie: string): void {
    const existing = response.getHeader('set-cookie');
    if (existing === undefined) {
        response.setHeader('set-cookie', cookie);
    } else if (Array.isArray(existing)) {
        response.setHeader('set-cookie', [...existing, cookie]);
    } else {
        response.setHeader('set-cookie', [String(existing), cookie]);
    }
}

function buildCookieAttributes(options?: JwtCookieOptions): string {
    const parts = ['Path=/', 'HttpOnly'];
    if (options?.secure !== false) parts.push('Secure');
    parts.push(`SameSite=${options?.sameSite ?? 'Lax'}`);
    if (options?.domain) parts.push(`Domain=${options.domain}`);
    return parts.join('; ');
}

function deriveEdPublicKey(privateKey: string | Buffer): string {
    const privateKeyObject = createPrivateKey(privateKey);
    const privateKeyPem = privateKeyObject.export({ type: 'pkcs8', format: 'pem' });
    return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

function normalizeEdPrivateKey(key: string | Buffer): string | Buffer {
    if (Buffer.isBuffer(key)) return key;
    if (key.includes('-----BEGIN')) return key;
    return `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
}

function normalizeEdPublicKey(key: string | Buffer): string | Buffer {
    if (Buffer.isBuffer(key)) return key;
    if (key.includes('-----BEGIN')) return key;
    return `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
}

function isBase64(value: string): boolean {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 !== 1;
}

function isAudienceClaim(value: unknown): value is string | string[] | undefined {
    return value === undefined || typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function isAudienceAccepted(claim: string | string[] | undefined, expected: string | string[]): boolean {
    if (claim === undefined) return false;
    const claimValues = Array.isArray(claim) ? claim : [claim];
    const expectedValues = Array.isArray(expected) ? expected : [expected];
    return expectedValues.some(value => claimValues.includes(value));
}

function getHeader(request: HttpRequest, name: string): string | string[] | undefined {
    return request.headers[name] ?? request.headers[name.toLowerCase()];
}

function readCookie(cookieHeader: string, name: string): string | undefined {
    for (const part of cookieHeader.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
}
