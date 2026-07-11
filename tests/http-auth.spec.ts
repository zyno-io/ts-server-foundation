import { entity, PrimaryKey } from '../src';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
    BaseEntity,
    BaseDatabase,
    createApp,
    createAuthMiddleware,
    createCachingParameterResolver,
    DatabaseDriver,
    DriverConnection,
    ExecuteResult,
    getJwtFromRequest,
    http,
    HttpRequest,
    HttpUnauthorizedError,
    ParsedJwt,
    QueryResult,
    resolveEntityFromRequestJwt,
    setHttpContextResolver,
    JWT
} from '../src';
import type { RenderedSql } from '../src';

afterEach(() => {
    setHttpContextResolver(() => ({ reqId: 'test-req' }));
});

class FakeConnection implements DriverConnection {
    constructor(private driver: FakeDriver) {}
    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        this.driver.queries.push(query);
        return { rows: this.driver.rows as T[] };
    }
    async execute(query: RenderedSql): Promise<ExecuteResult> {
        this.driver.executes.push(query);
        return { affectedRows: 1 };
    }
    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {}
}

class FakeDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    rows: Record<string, unknown>[] = [];
    queries: RenderedSql[] = [];
    executes: RenderedSql[] = [];
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        return new FakeConnection(this);
    }
}

@entity.name('auth_users')
class AuthUser extends BaseEntity {
    id!: string & PrimaryKey;
    name!: string;
}

class AuthDatabase extends BaseDatabase {
    static driver = new FakeDriver();

    constructor() {
        super(AuthDatabase.driver, [AuthUser]);
    }
}

describe('http auth helpers', () => {
    it('resolves valid JWTs from requests and caches them', async () => {
        process.env.APP_ENV = 'test';
        createApp({ defaultConfig: { AUTH_JWT_SECRET: 'secret', AUTH_JWT_ISSUER: 'issuer' } });
        const token = await JWT.generate({ subject: 'user-1', payload: { role: 'admin' } });
        const request = HttpRequest.GET('/auth', { authorization: `Bearer ${token}` });

        const first = await getJwtFromRequest<{ role: string }>(request);
        const second = await getJwtFromRequest<{ role: string }>(request);

        assert.strictEqual(first, second);
        assert.equal(first?.subject, 'user-1');
        assert.equal(first?.payload.role, 'admin');
    });

    it('injects ParsedJwt route parameters and applies request context', async () => {
        @http.controller('/jwt')
        class JwtController {
            @http.GET()
            get(jwt: ParsedJwt) {
                return { subject: jwt.subject };
            }

            @http.GET('/optional')
            optional(jwt?: ParsedJwt) {
                return { subject: jwt?.subject ?? null };
            }
        }

        process.env.APP_ENV = 'test';
        setHttpContextResolver(() => ({ reqId: 'req-42' }));
        const app = createApp({
            controllers: [JwtController],
            defaultConfig: { AUTH_JWT_SECRET: 'secret', AUTH_JWT_ISSUER: 'issuer' }
        });
        const token = await JWT.generate({ subject: 'user-2' });
        const authedRequest = HttpRequest.GET('/jwt', { authorization: `Bearer ${token}` });
        const authed = await app.request(authedRequest);
        const missingOptional = await app.request(HttpRequest.GET('/jwt/optional'));
        const missingRequired = await app.request(HttpRequest.GET('/jwt'));
        const invalid = await app.request(HttpRequest.GET('/jwt', { authorization: 'Bearer not-a-jwt' }));
        const expiredToken = await JWT.generate({ subject: 'user-2', expiresAt: Date.now() - 1000 });
        const expired = await app.request(HttpRequest.GET('/jwt', { authorization: `Bearer ${expiredToken}` }));

        assert.equal(authedRequest.context.reqId, 'req-42');
        assert.deepStrictEqual(authed.json, { subject: 'user-2' });
        assert.deepStrictEqual(missingOptional.json, { subject: null });
        assert.equal(missingRequired.statusCode, 401);
        assert.equal(invalid.statusCode, 401);
        assert.equal(expired.statusCode, 401);
    });

    it('creates entity auth middleware using the JWT subject', async () => {
        AuthDatabase.driver.rows = [{ id: 'user-3', name: 'Alice' }];
        AuthDatabase.driver.queries = [];
        const UserAuthMiddleware = createAuthMiddleware(AuthUser);

        @(http.controller('/me').middleware(UserAuthMiddleware))
        class MeController {
            @http.GET()
            get() {
                return { ok: true };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            db: AuthDatabase,
            controllers: [MeController],
            providers: [UserAuthMiddleware],
            defaultConfig: { AUTH_JWT_SECRET: 'secret', AUTH_JWT_ISSUER: 'issuer' }
        });
        const token = await JWT.generate({ subject: 'user-3' });
        const valid = await app.request(HttpRequest.GET('/me', { authorization: `Bearer ${token}` }));
        const invalid = await app.request(HttpRequest.GET('/me'));

        assert.equal(valid.statusCode, 200);
        assert.equal(invalid.statusCode, 401);
        assert.equal(AuthDatabase.driver.queries.length, 0);
    });

    it('caches entity loads for validating auth middleware and propagates validation rejection', async () => {
        AuthDatabase.driver.rows = [{ id: 'user-validated', name: 'Alice' }];
        AuthDatabase.driver.queries = [];
        let validationCalls = 0;
        const BaseValidatingAuthMiddleware = createAuthMiddleware(AuthUser);

        class ValidatingAuthMiddleware extends BaseValidatingAuthMiddleware {
            validateEntity(_request: HttpRequest, entity: AuthUser) {
                validationCalls++;
                if (entity.name === 'Blocked') throw new HttpUnauthorizedError('Account is disabled');
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            db: AuthDatabase,
            providers: [ValidatingAuthMiddleware],
            defaultConfig: { AUTH_JWT_SECRET: 'secret', AUTH_JWT_ISSUER: 'issuer' }
        });
        app.get(AuthDatabase);
        const middleware = app.get(ValidatingAuthMiddleware);
        const token = await JWT.generate({ subject: 'user-validated' });
        const request = HttpRequest.GET('/me', { authorization: `Bearer ${token}` });

        await middleware.handle(request);
        await middleware.handle(request);

        assert.equal(AuthDatabase.driver.queries.length, 1);
        assert.equal(validationCalls, 2);

        AuthDatabase.driver.rows = [{ id: 'user-blocked', name: 'Blocked' }];
        const blockedToken = await JWT.generate({ subject: 'user-blocked' });
        await assert.rejects(() => middleware.handle(HttpRequest.GET('/me', { authorization: `Bearer ${blockedToken}` })), HttpUnauthorizedError);
    });

    it('resolves entities from JWT subjects for request-only helper usage', async () => {
        AuthDatabase.driver.rows = [{ id: 'user-3b', name: 'Casey' }];
        AuthDatabase.driver.queries = [];

        process.env.APP_ENV = 'test';
        const app = createApp({
            db: AuthDatabase,
            defaultConfig: { AUTH_JWT_SECRET: 'secret', AUTH_JWT_ISSUER: 'issuer' }
        });
        app.get(AuthDatabase);
        const token = await JWT.generate({ subject: 'user-3b' });

        const resolved = await resolveEntityFromRequestJwt(HttpRequest.GET('/me', { authorization: `Bearer ${token}` }), AuthUser);
        const missing = await resolveEntityFromRequestJwt(HttpRequest.GET('/me'), AuthUser);

        assert.equal(resolved?.id, 'user-3b');
        assert.equal(resolved?.name, 'Casey');
        assert.equal(missing, undefined);
    });

    it('rejects missing required custom entity parameters resolved from JWTs', async () => {
        AuthDatabase.driver.rows = [{ id: 'user-4', name: 'Riley' }];
        AuthDatabase.driver.queries = [];
        const contexts: Array<{
            name: string;
            optional: boolean;
            tokenIsAuthUser: boolean;
            pathUserId: unknown;
            hasResponse: boolean;
        }> = [];
        const AuthUserResolver = createCachingParameterResolver(AuthUser, async context => {
            contexts.push({
                name: context.name,
                optional: context.type.isOptional(),
                tokenIsAuthUser: context.token === AuthUser,
                pathUserId: context.parameters.userId,
                hasResponse: !!context.response
            });
            return resolveEntityFromRequestJwt(context, AuthUser);
        });

        function ApiController(path: string): ClassDecorator {
            return target => {
                http.controller(path)(target);
                http.resolveParameter(AuthUser, AuthUserResolver)(target);
            };
        }

        @ApiController('/resolved-users/:userId')
        class ResolvedUserController {
            @http.GET('/me')
            get(user: AuthUser) {
                return { id: user.id, name: user.name };
            }

            @http.GET('/optional')
            optional(user?: AuthUser) {
                return { id: user?.id ?? null };
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({
            db: AuthDatabase,
            controllers: [ResolvedUserController],
            defaultConfig: { AUTH_JWT_SECRET: 'secret', AUTH_JWT_ISSUER: 'issuer' }
        });
        app.get(AuthDatabase);
        const token = await JWT.generate({ subject: 'user-4' });

        const missingRequired = await app.request(HttpRequest.GET('/resolved-users/path-1/me'));
        const missingOptional = await app.request(HttpRequest.GET('/resolved-users/path-2/optional'));
        const valid = await app.request(HttpRequest.GET('/resolved-users/path-3/me', { authorization: `Bearer ${token}` }));

        assert.equal(missingRequired.statusCode, 401);
        assert.deepStrictEqual(missingRequired.json, { error: 'Unauthorized' });
        assert.deepStrictEqual(missingOptional.json, { id: null });
        assert.deepStrictEqual(valid.json, { id: 'user-4', name: 'Riley' });
        assert.deepStrictEqual(contexts, [
            {
                name: 'user',
                optional: false,
                tokenIsAuthUser: true,
                pathUserId: 'path-1',
                hasResponse: true
            },
            {
                name: 'user',
                optional: true,
                tokenIsAuthUser: true,
                pathUserId: 'path-2',
                hasResponse: true
            },
            {
                name: 'user',
                optional: false,
                tokenIsAuthUser: true,
                pathUserId: 'path-3',
                hasResponse: true
            }
        ]);
    });
});
