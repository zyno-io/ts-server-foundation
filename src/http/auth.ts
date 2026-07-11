import { ParsedJwt, JWT } from '../auth/jwt';
import { getEntityOrUndefined } from '../database';
import type { BaseEntity } from '../database';
import type { EntityClass } from '../database/metadata';
import { HttpUnauthorizedError } from './errors';
import type { HttpMiddleware } from './middleware';
import { HttpRequest } from './request';
import { getOrCacheValue } from './store';
import type { RouteParameterResolverContext } from './decorators';

const ParsedJwtSymbol = Symbol('ParsedJwt');

export async function getJwtFromRequest<T extends object = Record<string, unknown>>(request: HttpRequest): Promise<ParsedJwt<T> | undefined> {
    return getOrCacheValue(request, ParsedJwtSymbol, async () => {
        const jwt = await JWT.processWithRequest<T>(request);
        if (!jwt) return undefined;
        if (!jwt.isValid) {
            if (!jwt.isSignatureValid) throw new HttpUnauthorizedError('Invalid JWT signature');
            if (!jwt.isNotExpired) throw new HttpUnauthorizedError('Expired JWT');
            throw new HttpUnauthorizedError('Invalid JWT');
        }
        return jwt;
    });
}

export async function getSubjectFromRequestJwt(request: HttpRequest): Promise<string | undefined> {
    const jwt = await getJwtFromRequest(request);
    return jwt?.subject;
}

export async function resolveEntityFromRequestJwt<T extends BaseEntity>(
    contextOrRequest: RouteParameterResolverContext | HttpRequest,
    EntityClass: EntityClass<T>
): Promise<T | undefined> {
    const requestOnly = contextOrRequest instanceof HttpRequest;
    const request = requestOnly ? contextOrRequest : contextOrRequest.request;
    const entityId = await getSubjectFromRequestJwt(request);
    const entity = entityId === undefined ? undefined : await getEntityOrUndefined(EntityClass, entityId);
    if (!entity && !requestOnly && contextOrRequest.type?.isOptional?.() !== true) throw new HttpUnauthorizedError();
    return entity;
}

export interface EntityValidator<T extends BaseEntity> {
    getEntityIdFromRequest(request: HttpRequest): Promise<unknown>;
    validateEntity?(request: HttpRequest, entity: T): Promise<void> | void;
}

export function createAuthMiddleware<T extends BaseEntity>(EntityClass: EntityClass<T>) {
    const entityIdCacheKey = { kind: 'auth-entity-id', EntityClass };
    const entityCacheKey = { kind: 'auth-entity', EntityClass };

    return class AuthMiddleware implements HttpMiddleware, EntityValidator<T> {
        async handle(request: HttpRequest): Promise<void> {
            const entityId = await getOrCacheValue(request, entityIdCacheKey, () => this.getEntityIdFromRequest(request));
            await this.loadAndValidateEntity(request, entityId);
        }

        async getEntityIdFromRequest(request: HttpRequest): Promise<unknown> {
            const id = await getSubjectFromRequestJwt(request);
            if (!id) throw new HttpUnauthorizedError();
            return id;
        }

        async loadAndValidateEntity(request: HttpRequest, id: unknown): Promise<void> {
            const validate = (this as EntityValidator<T>).validateEntity;
            if (!validate) return;
            const entity = await getOrCacheValue(request, entityCacheKey, () => getEntityOrUndefined(EntityClass, id as string | number));
            if (!entity) throw new HttpUnauthorizedError();
            await validate.call(this, request, entity);
        }
    };
}
