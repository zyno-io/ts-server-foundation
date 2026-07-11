# Authentication

TSF includes JWT helpers, request authentication utilities, entity auth middleware, HTTP Basic auth middleware, password hashing, and reset tokens.

## JWT Configuration

Generated JWTs use HS256 when an HMAC secret is configured and EdDSA when `AUTH_JWT_ED_SECRET` is configured. Exactly one secret source may be configured: `AUTH_JWT_SECRET`, `AUTH_JWT_SECRET_B64`, or `AUTH_JWT_ED_SECRET`. Conflicts are rejected when JWT signing or configured-key verification first resolves the key.

| Config key                 | Description                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_JWT_SECRET`          | Plain string HMAC secret. Mutually exclusive with the base64 and Ed25519 secrets.                                              |
| `AUTH_JWT_SECRET_B64`      | Base64-encoded HMAC secret. Mutually exclusive with the plain and Ed25519 secrets.                                             |
| `AUTH_JWT_ED_SECRET`       | Base64 DER or PEM PKCS#8 Ed25519 private key. Mutually exclusive with both HMAC secrets.                                       |
| `AUTH_JWT_ISSUER`          | Default issuer.                                                                                                                |
| `AUTH_JWT_EXPIRATION_MINS` | Default token lifetime. Defaults to 60 minutes.                                                                                |
| `AUTH_JWT_COOKIE_NAME`     | Cookie name. Defaults to `jwt`.                                                                                                |
| `AUTH_JWT_ENABLE_VERIFY`   | When false, request processing only decodes tokens; signatures, required claims, and expiry are not checked. Defaults to true. |

::: danger Verification must stay enabled at trust boundaries
Setting `AUTH_JWT_ENABLE_VERIFY=false` makes `JWT.process()`, request helpers, and `ParsedJwt` injection trust any decodable token, including one with a forged signature, missing claims, or an expired `exp`. `JWT.decode()` has the same validation bypass regardless of configuration. Use either only for explicitly untrusted inspection or tightly controlled compatibility work, never to authorize a request.
:::

## Generating JWTs

```ts
import { JWT } from '@zyno-io/ts-server-foundation';

const token = await JWT.generate({
    subject: String(user.id),
    payload: { role: user.role }
});

await JWT.generateCookie({ subject: String(user.id) }, response, {
    sameSite: 'Lax',
    secure: true
});

await JWT.clearCookie(response);
```

JWT cookies default to the configured `AUTH_JWT_COOKIE_NAME` or `jwt`, with `Path=/`, `HttpOnly`, `Secure`, and `SameSite=Lax`. Pass `secure: false` only when the transport is intentionally not HTTPS. `clearCookie()` uses the same attributes and an expiration in 1970, so pass matching `domain`, `sameSite`, and `secure` options when clearing a customized cookie.

Generation options:

| Option       | Description                                |
| ------------ | ------------------------------------------ |
| `id`         | Optional JWT ID stored as `jti`.           |
| `issuer`     | Overrides `AUTH_JWT_ISSUER`.               |
| `audience`   | String or string array audience.           |
| `subject`    | Required subject.                          |
| `expiresAt`  | Expiration as `Date` or Unix milliseconds. |
| `expiryMins` | Relative expiration in minutes.            |
| `payload`    | Extra application claims.                  |

## Verifying And Decoding

```ts
const result = await JWT.verify<{ role: string }>(token);

if (result.isValid) {
    result.subject;
    result.payload.role;
    result.expiresAt;
} else {
    result.isDecodable;
    result.isSignatureValid;
    result.isPayloadValid;
    result.isNotExpired;
}
```

Helpers:

| Helper                              | Description                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `JWT.verify(token, key?, options?)` | Verifies signatures and standard claims with an explicit or configured key. |
| `JWT.decode(token)`                 | Decodes without validating signatures, required claims, or expiry.          |
| `JWT.process(token)`                | Fully verifies or only decodes according to `AUTH_JWT_ENABLE_VERIFY`.       |
| `JWT.processWithRequest(request)`   | Reads Bearer token or JWT cookie from a request.                            |
| `JWT.createVerifier(options)`       | Returns a reusable async verifier.                                          |

`processWithRequest()` checks `Authorization: Bearer <token>` first, then the configured JWT cookie.

Verification requires `iss`, non-empty `sub`, numeric `iat`, and numeric `exp`; expiration and any requested issuer/audience are enforced. `aud` is optional unless a verifier specifies an audience. Generated tokens always include `iss`, `sub`, `iat`, and `exp`.

`JWT.generate()` pins signing to HS256 or EdDSA from configuration. `JWT.verify()` and `JWT.createVerifier()` restrict verification to one algorithm only when their `algorithm` option is supplied. With no explicit algorithm, `fast-jwt` validates the token using the supplied/configured key and its compatible algorithms. An unknown explicit algorithm returns an invalid result instead of falling back. For an EdDSA verifier created with an explicit public key, pass `algorithm: 'EdDSA'` so TSF normalizes a bare base64 SPKI key correctly.

Bearer precedence applies once the header matches `Bearer <non-whitespace-token>`. If that selected token is invalid, TSF returns the invalid result and does not fall back to a valid cookie. A missing or malformed/non-Bearer authorization header still allows cookie lookup.

`JWT.decode()` produces a `ParsedJwt` from decodable payload fields but does not prove their type, presence, signature, or freshness. Its `isValid: true` means decoding succeeded, not that the token is trustworthy.

## Controller Injection

Controllers can request `ParsedJwt<T>` directly. The parameter is required unless it is optional.

```ts
import { http, ParsedJwt } from '@zyno-io/ts-server-foundation';

interface SessionClaims {
    role: string;
}

@http.controller('/session')
class SessionController {
    @http.GET('/me')
    async me(jwt: ParsedJwt<SessionClaims>) {
        return { subject: jwt.subject, role: jwt.payload.role };
    }
}
```

With verification enabled, invalid or expired JWTs produce `HttpUnauthorizedError`; a missing required JWT always does. An optional `ParsedJwt` accepts absence, but a token that is present and invalid still produces `401`. When `AUTH_JWT_ENABLE_VERIFY=false`, any decodable token bypasses signature, claim, and expiry checks.

## Request Helpers

```ts
import { resolveEntityFromRequestJwt, getSubjectFromRequestJwt, getJwtFromRequest } from '@zyno-io/ts-server-foundation';

const jwt = await getJwtFromRequest(request);
const userId = await getSubjectFromRequestJwt(request);
const user = await resolveEntityFromRequestJwt(request, User);
```

JWT processing is cached per request.

## Entity Auth Middleware

`createAuthMiddleware(Entity)` creates a middleware class that requires a JWT subject and can optionally validate the resolved entity.

```ts
import {
    createApp,
    createAuthMiddleware,
    resolveEntityFromRequestJwt,
    http,
    HttpRequest,
    HttpUnauthorizedError
} from '@zyno-io/ts-server-foundation';

class UserAuthMiddleware extends createAuthMiddleware(User) {
    async validateEntity(_request: HttpRequest, user: User) {
        if (user.disabled || user.deletedAt) throw new HttpUnauthorizedError('Account is not active');
    }
}

@http.controller('/account')
class AccountController {
    @(http.GET('/me').use(UserAuthMiddleware))
    async me(request: HttpRequest) {
        return await resolveEntityFromRequestJwt(request, User);
    }
}

const app = createApp({
    providers: [UserAuthMiddleware],
    controllers: [AccountController]
});
```

`handle()` always resolves and caches the subject for the request. If the generated middleware class does not define `validateEntity()`, it does not query the database; this is an authentication-presence/subject check only. When a hook is present, the middleware loads the entity with `getEntityOrUndefined()`, rejects a missing entity, caches the loaded entity for that request, and invokes the hook. Repeated middleware execution on the same request reuses the cached subject and entity, although the validation hook runs each time.

## Custom Entity Resolvers

`resolveEntityFromRequestJwt(contextOrRequest, Entity)` can be used as a custom parameter resolver helper. It throws unauthorized for missing non-optional route parameters.

`createCachingParameterResolver(key, resolver)` wraps a route parameter resolver and caches its value per request.

## HTTP Basic Auth

```ts
import { createBasicAuthMiddleware, http } from '@zyno-io/ts-server-foundation';

const AdminBasicAuth = createBasicAuthMiddleware('admin');

@http.controller('/admin')
class AdminController {
    @(http.GET('/stats').use(AdminBasicAuth))
    async stats() {
        return { ok: true };
    }
}
```

The password must match `AUTH_BASIC_SECRET`. When an expected username is provided, the username must match too.

## Password Hashing

```ts
import { Auth } from '@zyno-io/ts-server-foundation';

const hash = await Auth.hashPassword('secret');
const valid = await Auth.verifyHash('secret', hash);
```

New passwords are hashed with `scrypt` and a random salt. Encoded hashes use the format `scrypt$<salt>$<hash>`. `verifyHash()` also accepts existing bcrypt hashes (including the common `$2y$` variant), which supports migrations from bcrypt-backed applications without rehashing every password at once.

## Reset Tokens

```ts
const reset = await Auth.generateResetToken({ userId: user.id });
const decoded = await Auth.decodeResetToken<{ userId: number }>(reset.token);
```

Reset tokens use three base64url-safe parts: a base36 Unix timestamp in seconds, 16 random bytes, and the JSON payload. `generationTime` is returned in Unix milliseconds at whole-second precision. The payload is encoded, not encrypted or signed; use the random-byte `verifier` for server-side validation and enforce expiration in application code. `decodeResetToken()` validates the token structure and payload but does not check a stored verifier or an expiry policy.

The returned `ResetToken<T>` contains:

| Field            | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `token`          | Encoded token string.                                 |
| `data`           | JSON-serializable payload.                            |
| `generationTime` | Unix timestamp in milliseconds.                       |
| `verifier`       | SHA-256 verifier derived from the random token bytes. |
