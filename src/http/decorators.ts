import type { ReflectionParameter } from '../reflection';

import type { ClassType } from '../types';
import type { HttpResponse } from './response';
import type { HttpRequest } from './request';
import type { HttpMethod } from './request';
import type { HttpMiddlewareInput } from './middleware';

export interface ControllerMetadata {
    path: string;
    middlewares: HttpMiddlewareInput[];
}

export interface RouteMetadata {
    method: HttpMethod;
    path: string;
    propertyKey: string | symbol;
    middlewares: HttpMiddlewareInput[];
}

export interface RouteParameterResolverContext {
    token?: ClassType | string | symbol | unknown;
    route?: unknown;
    request: HttpRequest;
    response: HttpResponse;
    name: string;
    value: unknown;
    query: HttpRequest['query'];
    parameters: Record<string, unknown>;
    type: ReflectionParameter;
}

export type RouteParameterResolverFunction<T = unknown> = (context: RouteParameterResolverContext) => T | Promise<T>;

export interface RouteParameterResolver<T = unknown> {
    resolve(context: RouteParameterResolverContext): T | Promise<T>;
}

export type RouteParameterResolverObject<T = unknown> = RouteParameterResolver<T>;

export type RouteParameterResolverInput<T = unknown> =
    | RouteParameterResolverFunction<T>
    | RouteParameterResolver<T>
    | ClassType<RouteParameterResolver<T>>;

export interface RouteParameterResolverMetadata {
    type: ClassType;
    resolver: RouteParameterResolverInput;
}

export type RouteParameterResolverRegistry = Record<string, RouteParameterResolverInput>;

const controllerMetadata = new WeakMap<ClassType, ControllerMetadata>();
const routeMetadata = new WeakMap<object, RouteMetadata[]>();
const controllerMiddlewareMetadata = new WeakMap<ClassType, HttpMiddlewareInput[]>();
const routeMiddlewareMetadata = new WeakMap<object, Map<string | symbol, HttpMiddlewareInput[]>>();
const routeParameterResolverMetadata = new WeakMap<ClassType, RouteParameterResolverMetadata[]>();

type ControllerDecorator = ClassDecorator & {
    middleware: (..._middlewares: HttpMiddlewareInput[]) => ClassDecorator;
};

type RouteDecorator = MethodDecorator & {
    use: (..._middlewares: HttpMiddlewareInput[]) => MethodDecorator;
    middleware: (..._middlewares: HttpMiddlewareInput[]) => MethodDecorator;
};

function controller(path = ''): ControllerDecorator {
    const middlewares: HttpMiddlewareInput[] = [];
    const decorator = ((target: Function) => {
        const Controller = target as ClassType;
        controllerMetadata.set(Controller, {
            path,
            middlewares: [...(controllerMiddlewareMetadata.get(Controller) ?? []), ...middlewares]
        });
    }) as ControllerDecorator;

    decorator.middleware = (...items: HttpMiddlewareInput[]) => {
        middlewares.push(...items);
        return decorator;
    };
    return decorator;
}

function route(method: HttpMethod, path = ''): RouteDecorator {
    const middlewares: HttpMiddlewareInput[] = [];
    const decorator = ((_target: object, propertyKey: string | symbol) => {
        const routes = routeMetadata.get(_target) ?? [];
        routes.push({
            method,
            path,
            propertyKey,
            middlewares: [...getRouteMiddlewares(_target, propertyKey), ...middlewares]
        });
        routeMetadata.set(_target, routes);
    }) as unknown as RouteDecorator;

    decorator.use = (...items: HttpMiddlewareInput[]) => {
        middlewares.push(...items);
        return decorator;
    };
    decorator.middleware = decorator.use;
    return decorator;
}

function middleware(...items: HttpMiddlewareInput[]): ClassDecorator & MethodDecorator {
    return ((target: Function | object, propertyKey?: string | symbol) => {
        if (propertyKey === undefined) {
            const Controller = target as ClassType;
            const existing = controllerMiddlewareMetadata.get(Controller) ?? [];
            controllerMiddlewareMetadata.set(Controller, [...existing, ...items]);
            const metadata = controllerMetadata.get(Controller);
            if (metadata) metadata.middlewares.push(...items);
            return;
        }

        const existing = getRouteMiddlewares(target, propertyKey);
        setRouteMiddlewares(target, propertyKey, [...existing, ...items]);
        for (const route of routeMetadata.get(target) ?? []) {
            if (route.propertyKey === propertyKey) route.middlewares.push(...items);
        }
    }) as ClassDecorator & MethodDecorator;
}

function resolveParameter(type: ClassType, resolver: RouteParameterResolverInput): ClassDecorator {
    return target => {
        const Controller = target as unknown as ClassType;
        const existing = routeParameterResolverMetadata.get(Controller) ?? [];
        routeParameterResolverMetadata.set(Controller, [...existing, { type, resolver }]);
    };
}

export const http = {
    controller,
    middleware,
    resolveParameter,
    GET: (path?: string) => route('GET', path),
    POST: (path?: string) => route('POST', path),
    PUT: (path?: string) => route('PUT', path),
    PATCH: (path?: string) => route('PATCH', path),
    DELETE: (path?: string) => route('DELETE', path),
    OPTIONS: (path?: string) => route('OPTIONS', path),
    HEAD: (path?: string) => route('HEAD', path)
};

export function getControllerMetadata(controllerClass: ClassType): ControllerMetadata | undefined {
    return controllerMetadata.get(controllerClass);
}

export function getRouteMetadata(controllerClass: ClassType): RouteMetadata[] {
    return routeMetadata.get(controllerClass.prototype) ?? [];
}

export function getRouteParameterResolverMetadata(controllerClass: ClassType): RouteParameterResolverMetadata[] {
    return routeParameterResolverMetadata.get(controllerClass) ?? [];
}

function getRouteMiddlewares(target: object, propertyKey: string | symbol): HttpMiddlewareInput[] {
    return routeMiddlewareMetadata.get(target)?.get(propertyKey) ?? [];
}

function setRouteMiddlewares(target: object, propertyKey: string | symbol, middlewares: HttpMiddlewareInput[]): void {
    const map = routeMiddlewareMetadata.get(target) ?? new Map<string | symbol, HttpMiddlewareInput[]>();
    map.set(propertyKey, middlewares);
    routeMiddlewareMetadata.set(target, map);
}
