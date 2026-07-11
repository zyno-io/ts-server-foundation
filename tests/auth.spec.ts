import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createSigner } from 'fast-jwt';

import { Auth, createApp, createBasicAuthMiddleware, http, HttpRequest, JWT, MemoryHttpResponse } from '../src';

describe('auth', () => {
    it('generates, verifies, decodes, and reads JWTs from requests', async () => {
        process.env.APP_ENV = 'test';
        createApp({
            defaultConfig: {
                AUTH_JWT_SECRET: 'test-secret',
                AUTH_JWT_ISSUER: 'issuer',
                AUTH_JWT_COOKIE_NAME: 'session'
            }
        });

        const token = await JWT.generate({
            id: 'token-id',
            subject: 'user-1',
            audience: 'web',
            payload: { role: 'admin' }
        });

        const verified = await JWT.verify<{ role: string }>(token, 'test-secret', {
            issuer: 'issuer',
            audience: 'web'
        });
        const decoded = await JWT.decode<{ role: string }>(token);
        const fromAuthorization = await JWT.processWithRequest<{ role: string }>(HttpRequest.GET('/auth', { authorization: `Bearer ${token}` }));
        const fromLowercaseAuthorization = await JWT.processWithRequest<{ role: string }>(
            HttpRequest.GET('/auth', { authorization: `bearer ${token}` })
        );
        const fromCookie = await JWT.processWithRequest<{ role: string }>(HttpRequest.GET('/auth', { cookie: `session=${token}` }));

        assert.equal(verified.isValid, true);
        assert.equal(verified.subject, 'user-1');
        assert.equal(verified.id, 'token-id');
        assert.equal(verified.payload.role, 'admin');
        assert.equal(verified.issuedAt.getTime(), verified.issuedAtMs);
        assert.equal(verified.expiresAt.getTime(), verified.expiresAtMs);
        assert.equal(decoded.isValid, true);
        assert.equal(decoded.subject, 'user-1');
        assert.equal(fromAuthorization?.isValid, true);
        assert.equal(fromLowercaseAuthorization?.isValid, true);
        assert.equal(fromCookie?.isValid, true);
    });

    it('validates JWT headers, required claims, and audience arrays', async () => {
        process.env.APP_ENV = 'test';
        createApp({ defaultConfig: { AUTH_JWT_SECRET: 'test-secret', AUTH_JWT_ISSUER: 'issuer' } });
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: 'issuer',
            aud: ['web', 'mobile'],
            sub: 'user-1',
            iat: now,
            exp: now + 60
        };
        const token = signJwt(payload);
        const missingSubject = signJwt({ iss: 'issuer', aud: 'web', iat: now, exp: now + 60 });
        const unsupportedHeader = signJwt(payload, { alg: 'none', typ: 'JWT' });

        const valid = await JWT.verify(token, 'test-secret', { issuer: 'issuer', audience: 'mobile' });
        const validExpectedList = await JWT.verify(token, 'test-secret', {
            issuer: 'issuer',
            audience: ['api', 'web']
        });

        assert.equal(valid.isValid, true);
        assert.equal(validExpectedList.isValid, true);
        assert.deepStrictEqual(await JWT.verify(token, 'test-secret', { issuer: 'issuer', audience: 'api' }), {
            isValid: false,
            isDecodable: true,
            isSignatureValid: true,
            isPayloadValid: false
        });
        assert.deepStrictEqual(await JWT.verify(missingSubject, 'test-secret', { issuer: 'issuer', audience: 'web' }), {
            isValid: false,
            isDecodable: true,
            isSignatureValid: true,
            isPayloadValid: false
        });
        assert.deepStrictEqual(await JWT.verify(unsupportedHeader, 'test-secret', { issuer: 'issuer', audience: 'mobile' }), {
            isValid: false,
            isDecodable: true,
            isSignatureValid: true,
            isPayloadValid: false
        });
    });

    it('rejects tampered and expired JWTs', async () => {
        process.env.APP_ENV = 'test';
        createApp({ defaultConfig: { AUTH_JWT_SECRET: 'test-secret', AUTH_JWT_ISSUER: 'issuer' } });

        const expiredToken = await JWT.generate({
            subject: 'user-1',
            expiresAt: Date.now() - 1000
        });
        const tamperedToken = tamperJwtSignature(expiredToken);

        assert.deepStrictEqual(await JWT.verify(tamperedToken), {
            isValid: false,
            isDecodable: true,
            isSignatureValid: false
        });
        assert.deepStrictEqual(await JWT.verify(expiredToken), {
            isValid: false,
            isDecodable: true,
            isSignatureValid: true,
            isPayloadValid: true,
            isNotExpired: false
        });
    });

    it('rejects invalid base64 JWT secrets', async () => {
        process.env.APP_ENV = 'test';
        const previousSecret = process.env.AUTH_JWT_SECRET_B64;
        delete process.env.AUTH_JWT_SECRET_B64;
        (() => {
            try {
                createApp({ defaultConfig: { AUTH_JWT_SECRET_B64: '!!!!' } });
            } finally {
                if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET_B64;
                else process.env.AUTH_JWT_SECRET_B64 = previousSecret;
            }
        })();

        await assert.rejects(() => JWT.generate({ subject: 'user-1' }), /AUTH_JWT_SECRET_B64 must be valid base64/);
    });

    it('rejects mutually exclusive configured JWT secrets when the configured key is used', async () => {
        process.env.APP_ENV = 'test';
        createApp({
            defaultConfig: {
                AUTH_JWT_SECRET: 'plain-secret',
                AUTH_JWT_SECRET_B64: Buffer.from('encoded-secret').toString('base64')
            }
        });
        await assert.rejects(() => JWT.generate({ subject: 'user-1' }), /AUTH_JWT_SECRET and AUTH_JWT_SECRET_B64 cannot both be configured/);

        createApp({
            defaultConfig: {
                AUTH_JWT_SECRET: 'plain-secret',
                AUTH_JWT_ED_SECRET: Buffer.from('ed-secret').toString('base64')
            }
        });
        await assert.rejects(
            () => JWT.generate({ subject: 'user-1' }),
            /AUTH_JWT_SECRET\/AUTH_JWT_SECRET_B64 and AUTH_JWT_ED_SECRET cannot both be configured/
        );

        createApp({
            defaultConfig: {
                AUTH_JWT_SECRET_B64: Buffer.from('encoded-secret').toString('base64'),
                AUTH_JWT_ED_SECRET: Buffer.from('ed-secret').toString('base64')
            }
        });
        await assert.rejects(
            () => JWT.generate({ subject: 'user-1' }),
            /AUTH_JWT_SECRET\/AUTH_JWT_SECRET_B64 and AUTH_JWT_ED_SECRET cannot both be configured/
        );
    });

    it('decodes without signature, claim, or expiry checks when verification is disabled', async () => {
        process.env.APP_ENV = 'test';
        createApp({ defaultConfig: { AUTH_JWT_SECRET: 'signing-secret', AUTH_JWT_ISSUER: 'issuer' } });
        const expired = await JWT.generate({ subject: 'user-1', expiresAt: Date.now() - 60_000 });
        const tamperedExpired = tamperJwtSignature(expired);

        createApp({
            defaultConfig: {
                AUTH_JWT_SECRET: 'different-secret',
                AUTH_JWT_ENABLE_VERIFY: false
            }
        });
        const processed = await JWT.process(tamperedExpired);
        const decodedMissingClaims = await JWT.process<{ role: string }>(signJwt({ role: 'admin' }));

        assert.equal(processed.isValid, true);
        assert.equal(processed.subject, 'user-1');
        assert.equal(processed.expiresAt.getTime() <= Date.now(), true);
        assert.equal(decodedMissingClaims.isValid, true);
        assert.equal(decodedMissingClaims.subject, '');
        assert.equal(decodedMissingClaims.payload.role, 'admin');
    });

    it('prefers a syntactically valid Bearer header over the configured JWT cookie', async () => {
        process.env.APP_ENV = 'test';
        createApp({
            defaultConfig: {
                AUTH_JWT_SECRET: 'test-secret',
                AUTH_JWT_ISSUER: 'issuer',
                AUTH_JWT_COOKIE_NAME: 'session'
            }
        });
        const bearer = await JWT.generate({ subject: 'bearer-user' });
        const cookie = await JWT.generate({ subject: 'cookie-user' });

        const selected = await JWT.processWithRequest(
            HttpRequest.GET('/auth', {
                authorization: `Bearer ${bearer}`,
                cookie: `session=${cookie}`
            })
        );
        const invalidBearer = await JWT.processWithRequest(
            HttpRequest.GET('/auth', {
                authorization: `Bearer ${tamperJwtSignature(bearer)}`,
                cookie: `session=${cookie}`
            })
        );

        assert.ok(selected?.isValid);
        assert.equal(selected.subject, 'bearer-user');
        assert.ok(invalidBearer && !invalidBearer.isValid);
        assert.equal(invalidBearer.isSignatureValid, false);
    });

    it('supports EdDSA JWT secrets and public-key verifiers', async () => {
        process.env.APP_ENV = 'test';
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const privateKeyB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        createApp({
            defaultConfig: {
                AUTH_JWT_ED_SECRET: privateKeyB64,
                AUTH_JWT_ISSUER: 'ed-issuer'
            }
        });

        const token = await JWT.generate({
            id: 'ed-token',
            subject: 'user-1',
            audience: 'web',
            payload: { role: 'admin' }
        });
        const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
        const verified = await JWT.verify<{ role: string }>(token, undefined, { audience: 'web' });
        const externalVerifier = JWT.createVerifier<{ role: string }>({
            algorithm: 'EdDSA',
            key: publicKeyPem,
            issuer: 'ed-issuer',
            audience: 'web'
        });
        const externallyVerified = await externalVerifier(token);
        assert.equal(header.alg, 'EdDSA');
        assert.equal(verified.isValid, true);
        assert.equal(verified.payload.role, 'admin');
        assert.equal(externallyVerified.isValid, true);
        assert.deepStrictEqual(await JWT.verify(tamperJwtSignature(token)), {
            isValid: false,
            isDecodable: true,
            isSignatureValid: false
        });
    });

    it('supports RS256 JWT verifiers', async () => {
        process.env.APP_ENV = 'test';
        createApp({ defaultConfig: { AUTH_JWT_SECRET: 'test-secret', AUTH_JWT_ISSUER: 'issuer' } });
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const now = Math.floor(Date.now() / 1000);
        const signer = createSigner({
            algorithm: 'RS256',
            key: privateKeyPem
        });
        const token = signer({
            iss: 'issuer',
            aud: ['api', 'web'],
            sub: 'rsa-user',
            iat: now,
            exp: now + 60,
            role: 'service'
        });

        const verified = await JWT.verify<{ role: string }>(token, publicKeyPem, {
            algorithm: 'RS256',
            audience: 'api'
        });
        const reusableVerifier = JWT.createVerifier<{ role: string }>({
            algorithm: 'RS256',
            key: publicKeyPem,
            issuer: 'issuer',
            audience: 'web'
        });
        const reusableVerified = await reusableVerifier(token);

        assert.equal(verified.isValid, true);
        assert.equal(verified.subject, 'rsa-user');
        assert.equal(verified.payload.role, 'service');
        assert.equal(reusableVerified.isValid, true);
        assert.equal(reusableVerified.subject, 'rsa-user');
    });

    it('sets and clears JWT cookies', async () => {
        process.env.APP_ENV = 'test';
        createApp({
            defaultConfig: { AUTH_JWT_SECRET: 'test-secret', AUTH_JWT_COOKIE_NAME: 'session' }
        });

        const response = new MemoryHttpResponse();
        response.setHeader('set-cookie', 'existing=1; Path=/');
        await JWT.generateCookie({ subject: 'user-1' }, response, {
            secure: false,
            sameSite: 'Strict',
            domain: 'example.com'
        });

        const generatedCookies = response.getHeader('set-cookie');
        assert.ok(Array.isArray(generatedCookies));
        assert.equal(generatedCookies[0], 'existing=1; Path=/');
        assert.match(generatedCookies[1], /^session=.+; Path=\/; HttpOnly; SameSite=Strict; Domain=example.com$/);

        const clearResponse = new MemoryHttpResponse();
        await JWT.clearCookie(clearResponse, { secure: false });
        assert.match(String(clearResponse.getHeader('set-cookie')), /^session=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT;/);

        const defaultResponse = new MemoryHttpResponse();
        await JWT.generateCookie({ subject: 'user-1' }, defaultResponse);
        assert.match(String(defaultResponse.getHeader('set-cookie')), /^session=.+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);

        const defaultClearResponse = new MemoryHttpResponse();
        await JWT.clearCookie(defaultClearResponse);
        assert.equal(
            defaultClearResponse.getHeader('set-cookie'),
            'session=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax'
        );
    });

    it('hashes passwords and round-trips reset tokens', async () => {
        const hash = await Auth.hashPassword('password');
        const token = await Auth.generateResetToken({ userId: 7 });
        const decoded = await Auth.decodeResetToken<{ userId: number }>(token.token);
        const parts = token.token.split('.');
        const random = Buffer.from(parts[1], 'base64url');

        assert.equal(await Auth.verifyHash('password', hash), true);
        assert.equal(await Auth.verifyHash('wrong', hash), false);
        assert.equal(parts.length, 3);
        assert.match(token.token, /^[0-9a-z]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        assert.equal(random.length, 16);
        assert.equal(parseInt(parts[0], 36) * 1000, token.generationTime);
        assert.deepStrictEqual(decoded.data, { userId: 7 });
        assert.equal(decoded.generationTime, token.generationTime);
        assert.equal(token.verifier, createHash('sha256').update(random).digest('base64url'));
        assert.equal(decoded.verifier, token.verifier);
    });

    it('verifies legacy bcrypt password hashes', async () => {
        const hash = '$2b$10$jjxV2sqpbbXGu.PvFQPkZec3Lc2n6EMDrpvycyeY8oQzWzH0ytIRe';
        const variantHash = `$2y$${hash.slice(4)}`;

        assert.equal(await Auth.verifyHash('password', hash), true);
        assert.equal(await Auth.verifyHash('wrong', hash), false);
        assert.equal(await Auth.verifyHash('password', variantHash), true);
    });

    it('rejects malformed reset tokens', async () => {
        const timestamp = Math.floor(Date.now() / 1000).toString(36);
        const random = Buffer.alloc(16, 1).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ userId: 7 }), 'utf8').toString('base64url');
        const legacyRawToken = Buffer.concat([
            Buffer.from(timestamp),
            Buffer.from('.'),
            Buffer.from([1, 2, 46, 4, 5, 6, 7, 8, 46, 10, 11, 12, 13, 14, 15, 16]),
            Buffer.from('.'),
            Buffer.from(JSON.stringify({ userId: 7 }))
        ]).toString('base64url');

        await assert.rejects(() => Auth.decodeResetToken('not-a-token'), /Invalid reset token/);
        await assert.rejects(() => Auth.decodeResetToken(`${timestamp}.${random}.${payload}.extra`), /Invalid reset token/);
        await assert.rejects(() => Auth.decodeResetToken(`not_base36.${random}.${payload}`), /Invalid reset token/);
        await assert.rejects(() => Auth.decodeResetToken(`${'z'.repeat(20)}.${random}.${payload}`), /Invalid reset token/);
        await assert.rejects(
            () => Auth.decodeResetToken(`${timestamp}.${Buffer.alloc(15, 1).toString('base64url')}.${payload}`),
            /Invalid reset token/
        );
        await assert.rejects(
            () => Auth.decodeResetToken(`${timestamp}.${random}.${Buffer.from('not-json', 'utf8').toString('base64url')}`),
            /Invalid reset token/
        );
        await assert.rejects(() => Auth.decodeResetToken(legacyRawToken), /Invalid reset token/);
    });

    it('supports basic-auth middleware', async () => {
        const BasicAuthMiddleware = createBasicAuthMiddleware('admin');

        @(http.controller('/basic').middleware(BasicAuthMiddleware))
        class BasicController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            controllers: [BasicController],
            providers: [BasicAuthMiddleware],
            defaultConfig: { AUTH_BASIC_SECRET: 'sec:ret' }
        });

        const credentials = Buffer.from('admin:sec:ret').toString('base64');
        const valid = await app.request(HttpRequest.GET('/basic', { authorization: `Basic ${credentials}` }));
        const invalid = await app.request(HttpRequest.GET('/basic', { authorization: 'Basic bad' }));

        assert.equal(valid.statusCode, 200);
        assert.deepStrictEqual(valid.json, { ok: true });
        assert.equal(invalid.statusCode, 401);
    });

    it('fails basic-auth closed when no secret is configured', async () => {
        const BasicAuthMiddleware = createBasicAuthMiddleware('admin');

        @(http.controller('/basic-no-secret').middleware(BasicAuthMiddleware))
        class BasicNoSecretController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const previousSecret = process.env.AUTH_BASIC_SECRET;
        delete process.env.AUTH_BASIC_SECRET;
        const app = (() => {
            try {
                return createApp({
                    controllers: [BasicNoSecretController],
                    providers: [BasicAuthMiddleware]
                });
            } finally {
                if (previousSecret === undefined) delete process.env.AUTH_BASIC_SECRET;
                else process.env.AUTH_BASIC_SECRET = previousSecret;
            }
        })();

        const credentials = Buffer.from('admin:').toString('base64');
        const response = await app.request(HttpRequest.GET('/basic-no-secret', { authorization: `Basic ${credentials}` }));

        assert.equal(response.statusCode, 401);
    });
});

function tamperJwtSignature(token: string): string {
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    const signature = Buffer.from(parts[2], 'base64url');
    assert.notEqual(signature.length, 0);
    signature[0] ^= 1;
    return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;
}

function signJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
    const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const signature = createHmac('sha256', 'test-secret').update(unsigned).digest('base64url');
    return `${unsigned}.${signature}`;
}
