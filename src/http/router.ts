import {
    ReflectionClass,
    ReflectionKind,
    Type,
    ValidatorError,
    isReflectedType,
    typeAnnotation,
    validatedDeserialize,
    type ReflectionParameter
} from '../reflection';

import { ParsedJwt } from '../auth/jwt';
import { ProviderNotFoundError, type Container, type RequestContext } from '../di';
import type { EventBus } from '../events';
import type { ClassType } from '../types';
import { getJwtFromRequest } from './auth';
import {
    getControllerMetadata,
    getRouteMetadata,
    getRouteParameterResolverMetadata,
    type RouteParameterResolverContext,
    type RouteParameterResolverFunction,
    type RouteParameterResolverInput,
    type RouteParameterResolverRegistry,
    type RouteParameterResolverObject
} from './decorators';
import { HttpBadRequestError, HttpError, HttpNotFoundError, HttpUnauthorizedError } from './errors';
import type { HttpMiddleware } from './middleware';
import { HttpRequest, HttpRequestStream } from './request';
import type { HttpMethod } from './request';
import { HttpResponse, isHttpResponseResult, MemoryHttpResponse } from './response';
import { clearCachedValue, getCachedValue, setCachedValue } from './store';
import {
    cleanupUploadedFiles,
    FileUpload,
    type FileUploadPolicy,
    type MultipartRequestPolicy,
    isMultipartRequest,
    normalizeAllowedTypes,
    parseByteSize,
    parseMultipartRequest
} from './uploads';
import { createHttpWorkflowEvent, httpWorkflow, type HttpWorkflowToken } from './workflow';

export interface HttpRoutePlan {
    method: HttpMethod;
    path: string;
    regex: RegExp;
    paramNames: string[];
    controllerClass: ClassType;
    moduleId?: number;
    propertyKey: string | symbol;
    methodName: string;
    description?: string;
    returnType: Type;
    parameters: HttpRouteParameterPlan[];
    middlewares: ClassType<HttpMiddleware>[];
    bodyMode: 'guarded' | 'stream';
    uploadPolicy: MultipartRequestPolicy;
}

export type HttpRouteParameterPlan =
    | { kind: 'request' }
    | { kind: 'requestStream' }
    | { kind: 'response' }
    | { kind: 'jwt'; optional: boolean }
    | { kind: 'body'; name: string; type: Type; optional: boolean }
    | { kind: 'file'; name: string; type: Type; optional: boolean }
    | { kind: 'queries'; name: string; type: Type; optional: boolean }
    | { kind: 'query'; name: string; type: Type; optional: boolean }
    | { kind: 'path'; name: string; type: Type; optional: boolean }
    | { kind: 'header'; name: string; type: Type; optional: boolean }
    | {
          kind: 'custom';
          resolver: RouteParameterResolverInput;
          type: Type;
          reflectionParameter: ReflectionParameter;
          name: string;
          optional: boolean;
      };

const BodyParsePromiseKey = Symbol.for('@zyno-io/ts-server-foundation:http-body-parse-promise');

interface CompiledRouteParameterResolver {
    type: ClassType | string;
    resolver: RouteParameterResolverInput;
}

export class HttpRouter {
    private routes: HttpRoutePlan[] = [];
    private readonly httpResolvers: CompiledRouteParameterResolver[];

    constructor(
        private container: Container,
        private events?: EventBus,
        httpResolvers?: RouteParameterResolverRegistry
    ) {
        this.httpResolvers = normalizeGlobalRouteParameterResolvers(httpResolvers);
    }

    registerController(controllerClass: ClassType, moduleId?: number): void {
        const controller = getControllerMetadata(controllerClass);
        if (!controller) return;

        for (const route of getRouteMetadata(controllerClass)) {
            const path = joinPaths(controller.path, route.path);
            const { regex, paramNames } = compilePath(path);
            const method = ReflectionClass.from(controllerClass).getMethod(route.propertyKey);
            const parameters = this.compileParameters(controllerClass, route.propertyKey, route.method, paramNames);
            if (parameters.filter(parameter => parameter.kind === 'body').length > 1) {
                throw new Error(`Cannot declare multiple HttpBody parameters on ${controllerClass.name}.${String(route.propertyKey)}`);
            }
            const bodyMode = parameters.some(parameter => parameter.kind === 'requestStream') ? 'stream' : 'guarded';
            if (bodyMode === 'stream' && parameters.some(parameter => parameter.kind === 'body' || parameter.kind === 'file')) {
                throw new Error(`Cannot combine HttpRequestStream with parsed body or file parameters on ${String(route.propertyKey)}`);
            }
            this.routes.push({
                method: route.method,
                path,
                regex,
                paramNames,
                controllerClass,
                moduleId,
                propertyKey: route.propertyKey,
                methodName: String(route.propertyKey),
                description: method.getDescription() || undefined,
                returnType: method.getReturnType(),
                parameters,
                middlewares: [...controller.middlewares, ...route.middlewares] as ClassType<HttpMiddleware>[],
                bodyMode,
                uploadPolicy: compileMultipartRequestPolicy(parameters)
            });
        }
    }

    listRoutes(): readonly HttpRoutePlan[] {
        return this.routes;
    }

    hasRoute(request: HttpRequest): boolean {
        return this.routes.some(route => route.method === request.method && !!matchRoutePath(route, request.path));
    }

    async handle(request: HttpRequest, response: HttpResponse = new MemoryHttpResponse()): Promise<HttpResponse> {
        try {
            const route = this.match(request);
            if (!route) {
                await this.dispatchWorkflow(httpWorkflow.onRouteNotFound, request, response);
                if (response.writableEnded) return response;
                throw new HttpNotFoundError();
            }

            const context = this.container.createRequestContext();
            context.instances.set(HttpRequest, request);
            context.instances.set(HttpRequestStream, request);
            context.instances.set(HttpResponse, response);
            await this.dispatchWorkflow(httpWorkflow.onRoute, request, response, route);
            if (response.writableEnded) return response;
            if (route.bodyMode === 'stream') request.enableBodyGuardBypass();
            else await this.guardRequestBody(route, request);
            await this.runMiddlewares(route, context, request, response);
            if (response.writableEnded) return response;
            await this.dispatchWorkflow(httpWorkflow.onController, request, response, route);
            if (response.writableEnded) return response;

            const controller =
                route.moduleId === undefined
                    ? this.container.get(route.controllerClass, context)
                    : this.container.resolve(route.controllerClass, route.moduleId, context);
            const args = [];
            const resolvedParameters: Record<string, unknown> = { ...request.pathParams };
            for (const parameter of route.parameters) {
                const value = await this.resolveParameter(parameter, request, response, route, context, resolvedParameters);
                args.push(value);
                const name = getParameterPlanName(parameter);
                if (name) resolvedParameters[name] = value;
            }
            const result = await (controller as any)[route.propertyKey](...args);

            if (!response.writableEnded && !response.headersSent) this.writeResult(response, result, route);
        } catch (error) {
            request.store['$ControllerError'] = error;
            this.writeError(response, error);
        } finally {
            try {
                await this.dispatchWorkflow(httpWorkflow.onResponse, request, response);
            } finally {
                await cleanupUploadedFiles(request);
            }
        }

        return response;
    }

    private match(request: HttpRequest): HttpRoutePlan | undefined {
        for (const route of this.routes) {
            if (route.method !== request.method) continue;
            const match = matchRoutePath(route, request.path);
            if (!match) continue;

            request.pathParams = {};
            route.paramNames.forEach((name, index) => {
                try {
                    request.pathParams[name] = decodeURIComponent(match[index + 1] ?? '');
                } catch (error) {
                    if (error instanceof URIError) throw new HttpBadRequestError(`Invalid URL encoding for path parameter "${name}"`);
                    throw error;
                }
            });
            return route;
        }
    }

    private async runMiddlewares(route: HttpRoutePlan, context: RequestContext, request: HttpRequest, response: HttpResponse): Promise<void> {
        for (const Middleware of route.middlewares) {
            const middleware = this.resolveMiddleware(Middleware, context, route.moduleId);
            const result = await middleware.handle(request, response);
            if (isHttpResponseResult(result)) result.writeTo(response);
            if (response.writableEnded) return;
        }
    }

    private resolveMiddleware(Middleware: ClassType<HttpMiddleware>, context: RequestContext, moduleId?: number): HttpMiddleware {
        if (!this.container.has(Middleware, moduleId)) {
            if (Middleware.length === 0) return new Middleware();
            throw new ProviderNotFoundError(Middleware);
        }
        return moduleId === undefined ? this.container.get(Middleware, context) : this.container.resolve(Middleware, moduleId, context);
    }

    private async dispatchWorkflow(
        token: HttpWorkflowToken<any>,
        request: HttpRequest,
        response: HttpResponse,
        route?: HttpRoutePlan
    ): Promise<void> {
        if (!this.events) return;
        await this.events.dispatch(token, createHttpWorkflowEvent(request, response, { route }) as any);
    }

    private compileParameters(
        controllerClass: ClassType,
        propertyKey: string | symbol,
        methodName: HttpMethod,
        pathParams: string[]
    ): HttpRouteParameterPlan[] {
        const method = ReflectionClass.from(controllerClass).getMethod(propertyKey);
        const customResolvers = getRouteParameterResolverMetadata(controllerClass);
        return method.getParameters().map(parameter => {
            const type = parameter.getType();
            if (isReflectedClass(type, HttpRequestStream)) return { kind: 'requestStream' };
            if (isReflectedClass(type, HttpRequest)) return { kind: 'request' };
            if (isReflectedClass(type, HttpResponse)) return { kind: 'response' };
            if (type.kind === ReflectionKind.class && type.classType === ParsedJwt) {
                return { kind: 'jwt', optional: parameter.isOptional() };
            }
            if (type.kind === ReflectionKind.class && type.classType === FileUpload) {
                return { kind: 'file', name: cleanParameterName(parameter.getName()), type, optional: parameter.isOptional() };
            }
            if (type.kind === ReflectionKind.class) {
                const custom = customResolvers.find(item => item.type === type.classType) ?? this.findGlobalResolver(type.classType, type.typeName);
                if (custom) {
                    return {
                        kind: 'custom',
                        resolver: custom.resolver,
                        type,
                        reflectionParameter: parameter,
                        name: parameter.getName(),
                        optional: parameter.isOptional()
                    };
                }
            }
            if (hasHttpMarker(type, 'httpBody', 'HttpBody')) {
                return {
                    kind: 'body',
                    name: cleanParameterName(parameter.getName()),
                    type: getAnnotationValueType(type, 'httpBody') ?? type,
                    optional: parameter.isOptional()
                };
            }
            if (hasHttpMarker(type, 'httpQueries', 'HttpQueries')) {
                return {
                    kind: 'queries',
                    name: cleanParameterName(parameter.getName()),
                    type: getAnnotationValueType(type, 'httpQueries') ?? type,
                    optional: parameter.isOptional()
                };
            }
            if (hasHttpMarker(type, 'httpPath', 'HttpPath')) {
                return {
                    kind: 'path',
                    name: getPathAnnotationName(type, parameter.getName(), pathParams),
                    type: getAnnotationValueType(type, 'httpPath') ?? type,
                    optional: parameter.isOptional()
                };
            }
            if (hasHttpMarker(type, 'httpQuery', 'HttpQuery')) {
                return {
                    kind: 'query',
                    name: getHttpQueryAnnotationName(type, parameter.getName()),
                    type: getHttpQueryAnnotationValueType(type) ?? type,
                    optional: parameter.isOptional()
                };
            }
            if (hasHttpMarker(type, 'httpHeader', 'HttpHeader')) {
                return {
                    kind: 'header',
                    name: getAnnotationName(type, 'httpHeader', cleanParameterName(parameter.getName())),
                    type: getAnnotationValueType(type, 'httpHeader') ?? type,
                    optional: parameter.isOptional()
                };
            }
            const inferredPathName = inferPathParameterName(parameter.getName(), pathParams);
            if (inferredPathName) return { kind: 'path', name: inferredPathName, type, optional: parameter.isOptional() };
            throw new Error(
                `Cannot infer HTTP parameter ${String(propertyKey)}.${parameter.getName()} for ${methodName}; use HttpBody<T>, HttpQuery<T>, HttpQueries<T>, HttpPath<T>, HttpRequest, or HttpResponse`
            );
        });
    }

    private findGlobalResolver(type: ClassType, typeName?: string): CompiledRouteParameterResolver | undefined {
        return this.httpResolvers.find(item => item.type === type || item.type === type.name || (typeName !== undefined && item.type === typeName));
    }

    private async resolveParameter(
        parameter: HttpRouteParameterPlan,
        request: HttpRequest,
        response: HttpResponse,
        route: HttpRoutePlan,
        context: RequestContext,
        resolvedParameters: Record<string, unknown>
    ): Promise<unknown> {
        if (parameter.kind === 'request') return request;
        if (parameter.kind === 'requestStream') {
            request.enableBodyGuardBypass();
            return request;
        }
        if (parameter.kind === 'response') return response;
        if (parameter.kind === 'jwt') {
            const jwt = await getJwtFromRequest(request);
            if (!jwt && !parameter.optional) throw new HttpUnauthorizedError('Request does not contain required JWT');
            return jwt;
        }
        if (parameter.kind === 'queries') {
            if (Object.keys(request.query).length === 0 && parameter.optional) return undefined;
            return deserializeHttpValue(request.query, parameter.type, 'query');
        }
        if (parameter.kind === 'file') {
            const file = await this.readUploadedFile(request, route, parameter.name);
            if (!file && !parameter.optional) throw new HttpBadRequestError(`File field "${parameter.name}" is required`);
            return file;
        }
        if (parameter.kind === 'query') {
            const value = singleValue(request.query[parameter.name]);
            if (value === undefined && parameter.optional) return undefined;
            return deserializeHttpValue(value, parameter.type, httpParameterPath('query', parameter.name));
        }
        if (parameter.kind === 'path')
            return deserializeHttpValue(getPathParam(request, parameter.name), parameter.type, httpParameterPath('path', parameter.name));
        if (parameter.kind === 'header') {
            const value = singleValue(getHeader(request, parameter.name));
            if (value === undefined && parameter.optional) return undefined;
            return deserializeHttpValue(value, parameter.type, httpParameterPath('header', parameter.name));
        }
        if (parameter.kind === 'custom') return this.resolveCustomParameter(parameter, request, response, route, context, resolvedParameters);
        const body = await this.readBody(request, route);
        if (body === undefined && parameter.optional) return undefined;
        return deserializeHttpValue(defaultEmptyBody(body, parameter.type), parameter.type, 'body');
    }

    private async resolveCustomParameter(
        parameter: Extract<HttpRouteParameterPlan, { kind: 'custom' }>,
        request: HttpRequest,
        response: HttpResponse,
        route: HttpRoutePlan,
        context: RequestContext,
        resolvedParameters: Record<string, unknown>
    ): Promise<unknown> {
        const resolverContext: RouteParameterResolverContext = {
            token: parameter.type.kind === ReflectionKind.class ? parameter.type.classType : undefined,
            route,
            request,
            response,
            name: parameter.name,
            value: resolvedParameters[parameter.name],
            query: request.query,
            parameters: resolvedParameters,
            type: parameter.reflectionParameter
        };
        return this.invokeRouteParameterResolver(parameter.resolver, resolverContext, context);
    }

    private async invokeRouteParameterResolver(
        resolver: RouteParameterResolverInput,
        resolverContext: RouteParameterResolverContext,
        context: RequestContext
    ): Promise<unknown> {
        if (typeof resolver === 'function') {
            if (typeof resolver.prototype?.resolve === 'function') {
                const ResolverClass = resolver as ClassType<RouteParameterResolverObject>;
                const instance = this.container.listProviders().includes(ResolverClass)
                    ? this.container.get(ResolverClass, context)
                    : new ResolverClass();
                return instance.resolve(resolverContext);
            }
            return (resolver as RouteParameterResolverFunction)(resolverContext);
        }

        return resolver.resolve(resolverContext);
    }

    private async guardRequestBody(route: HttpRoutePlan, request: HttpRequest): Promise<void> {
        if (isMultipartRequest(request)) await this.readBody(request, route);
    }

    private async readBody(request: HttpRequest, route: HttpRoutePlan): Promise<unknown> {
        if (request.parsedBody !== undefined) return request.parsedBody;
        const cached = getCachedValue<Promise<unknown>>(request, BodyParsePromiseKey);
        if (cached) return cached;

        const promise = this.parseBody(request, route).catch(error => {
            clearCachedValue(request, BodyParsePromiseKey);
            throw error;
        });
        setCachedValue(request, BodyParsePromiseKey, promise);
        return promise;
    }

    private async parseBody(request: HttpRequest, route: HttpRoutePlan): Promise<unknown> {
        if (isMultipartRequest(request)) {
            const parsed = await parseMultipartRequest(request, route.uploadPolicy);
            request.parsedBody = parsed.body;
            request.uploadedFiles = parsed.uploadedFiles;
            return request.parsedBody;
        }

        const text = await request.readBodyText();
        if (!text) return undefined;
        try {
            request.parsedBody = JSON.parse(text);
            return request.parsedBody;
        } catch {
            throw new HttpBadRequestError('Failed to parse JSON');
        }
    }

    private async readUploadedFile(request: HttpRequest, route: HttpRoutePlan, name: string): Promise<FileUpload | undefined> {
        await this.readBody(request, route);
        const named = request.uploadedFiles[name];
        if (Array.isArray(named)) return named[0];
        if (named) return named;

        const allFiles = Object.values(request.uploadedFiles).flat();
        return allFiles.length === 1 ? allFiles[0] : undefined;
    }

    private writeResult(response: HttpResponse, result: unknown, route: HttpRoutePlan): void {
        if (isHttpResponseResult(result)) {
            result.writeTo(response);
            return;
        }

        const apiResponseStatus = getApiResponseStatus(route.returnType);
        if (result === undefined) {
            if (apiResponseStatus !== undefined) response.statusCode = apiResponseStatus;
            else if (isEmptyResponseReturnType(route.returnType)) response.statusCode = 204;
            response.end();
            return;
        }

        if (apiResponseStatus !== undefined) response.statusCode = apiResponseStatus;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
    }

    private writeError(response: HttpResponse, error: unknown): void {
        if (response.writableEnded) return;
        if (response.headersSent) {
            response.end();
            return;
        }
        const httpError = error instanceof HttpError ? error : new HttpError(500, 'Internal Server Error');
        response.writeHead(httpError.httpCode, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: httpError.message }));
    }
}

function matchRoutePath(route: HttpRoutePlan, path: string): RegExpExecArray | null {
    return route.regex.exec(path) ?? (path.length > 1 && path.endsWith('/') ? route.regex.exec(path.slice(0, -1)) : null);
}

function getParameterPlanName(parameter: HttpRouteParameterPlan): string | undefined {
    return 'name' in parameter ? parameter.name : undefined;
}

function normalizeGlobalRouteParameterResolvers(registry?: RouteParameterResolverRegistry): CompiledRouteParameterResolver[] {
    if (!registry) return [];
    return Object.entries(registry).map(([type, resolver]) => ({ type, resolver }));
}

function compileMultipartRequestPolicy(parameters: HttpRouteParameterPlan[]): MultipartRequestPolicy {
    const files: Record<string, FileUploadPolicy> = {};
    for (const parameter of parameters) {
        if (parameter.kind === 'file') {
            addFileUploadPolicy(files, parameter.name, fileUploadPolicyFromType(parameter.type));
            continue;
        }
        if (parameter.kind === 'body') {
            collectFileUploadPolicies(parameter.type, files);
        }
    }
    return { files, rejectUndeclaredFiles: true };
}

function collectFileUploadPolicies(type: Type, files: Record<string, FileUploadPolicy>, fieldName?: string, seen = new Set<Type>()): void {
    if (seen.has(type)) return;
    seen.add(type);

    if (isReflectedClass(type, FileUpload)) {
        if (fieldName) addFileUploadPolicy(files, fieldName, fileUploadPolicyFromType(type));
        return;
    }

    if (type.kind === ReflectionKind.union || type.kind === ReflectionKind.intersection) {
        const merged = mergedIntersectionStructuredType(type);
        if (merged) {
            collectFileUploadPolicies(merged, files, fieldName, seen);
            return;
        }
        for (const item of type.types) collectFileUploadPolicies(item, files, fieldName, seen);
        return;
    }

    if (type.kind === ReflectionKind.objectLiteral) {
        for (const property of getStructuredTypeProperties(type)) {
            collectFileUploadPolicies(property.type, files, String(property.name), seen);
        }
        return;
    }

    if (type.kind === ReflectionKind.class && typeof type.classType === 'function' && type.classType.prototype) {
        if (type.classType === Date || type.classType === Buffer || type.classType === Uint8Array) return;
        let reflection: ReflectionClass;
        try {
            reflection = ReflectionClass.from(type.classType);
        } catch {
            return;
        }
        for (const property of reflection.getProperties()) {
            collectFileUploadPolicies(property.getType(), files, String(property.name), seen);
        }
    }
}

function addFileUploadPolicy(files: Record<string, FileUploadPolicy>, name: string, policy: FileUploadPolicy): void {
    const existing = files[name];
    if (!existing) {
        files[name] = policy;
        return;
    }

    const maxSizeBytes =
        existing.maxSizeBytes === undefined
            ? policy.maxSizeBytes
            : policy.maxSizeBytes === undefined
              ? existing.maxSizeBytes
              : Math.min(existing.maxSizeBytes, policy.maxSizeBytes);
    const allowedTypes = mergeAllowedTypes(existing.allowedTypes, policy.allowedTypes, name);
    files[name] = { maxSizeBytes, allowedTypes };
}

function mergeAllowedTypes(left: string[] | undefined, right: string[] | undefined, name: string): string[] | undefined {
    if (!left?.length) return right;
    if (!right?.length) return left;
    const leftKey = [...left].sort().join('\n');
    const rightKey = [...right].sort().join('\n');
    if (leftKey !== rightKey) throw new Error(`Conflicting allowedTypes for file field "${name}"`);
    return left;
}

function fileUploadPolicyFromType(type: Type): FileUploadPolicy {
    const options = getTypeArgument(type, 0);
    if (!options) return {};
    const value = typeToPlainValue(options);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    const record = value as Record<string, unknown>;
    const policy: FileUploadPolicy = {};
    if (record.maxSize !== undefined) {
        const maxSizeBytes = parseByteSize(record.maxSize);
        if (maxSizeBytes === undefined) throw new Error(`Invalid FileUpload maxSize: ${String(record.maxSize)}`);
        policy.maxSizeBytes = maxSizeBytes;
    }
    if (record.allowedTypes !== undefined) {
        const allowedTypes = normalizeAllowedTypes(record.allowedTypes);
        if (!allowedTypes?.length) throw new Error('Invalid FileUpload allowedTypes');
        policy.allowedTypes = allowedTypes;
    }
    return policy;
}

function typeToPlainValue(type: Type): unknown {
    if (type.kind === ReflectionKind.literal) return type.literal;
    if (type.kind === ReflectionKind.tuple) return type.types.map(item => typeToPlainValue(item.type));
    if (type.kind === ReflectionKind.union) {
        const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
        return concrete.length === 1 ? typeToPlainValue(concrete[0]) : undefined;
    }
    if (type.kind === ReflectionKind.objectLiteral) {
        const output: Record<string, unknown> = {};
        for (const property of getStructuredTypeProperties(type)) output[String(property.name)] = typeToPlainValue(property.type);
        return output;
    }
}

function joinPaths(base: string, child: string): string {
    const joined = `/${base}/${child}`.replace(/\/+/g, '/');
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const pattern = path
        .split('/')
        .map(segment => {
            if (segment.startsWith(':')) {
                paramNames.push(segment.slice(1));
                return '([^/]+)';
            }
            return escapeRegex(segment);
        })
        .join('/');

    return { regex: new RegExp(`^${pattern}$`), paramNames };
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAnnotation(type: Type, annotation: string): boolean {
    if (typeAnnotation.getType(type, annotation)) return true;
    if (type.typeName === annotationTypeName(annotation)) return true;
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        return type.types.some(item => hasAnnotation(item, annotation));
    }
    return false;
}

function hasHttpMarker(type: Type, annotation: string, alias: string): boolean {
    if (hasAnnotation(type, annotation)) return true;
    if ((type as Type & { typeName?: string }).typeName === alias) return true;
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        return type.types.some(item => hasHttpMarker(item, annotation, alias));
    }
    return false;
}

function getAnnotationName(type: Type, annotation: string, fallback: string): string {
    const options = getAnnotationOptions(type, annotation);
    const name = getAnnotationOption(options, 'name');
    if (typeof name === 'string') return name;
    return options && typeof options === 'object' && typeof options.name === 'string' ? options.name : fallback;
}

function getPathAnnotationName(type: Type, fallback: string, pathParams: string[]): string {
    const annotated = getAnnotationName(type, 'httpPath', '');
    if (annotated) return annotated;
    const inferred = inferPathParameterName(fallback, pathParams);
    if (inferred) return inferred;
    return pathParams.length === 1 ? pathParams[0] : fallback;
}

function inferPathParameterName(parameterName: string, pathParams: readonly string[]): string | undefined {
    if (pathParams.includes(parameterName)) return parameterName;
    const cleanName = parameterName.replace(/^_+/, '');
    if (cleanName !== parameterName && pathParams.includes(cleanName)) return cleanName;
}

function getHttpQueryAnnotationName(type: Type, fallback: string): string {
    const annotated = getAnnotationName(type, 'httpQuery', '');
    if (annotated) return annotated;
    return getHttpQueryNameLiteral(type) ?? cleanParameterName(fallback);
}

function getHttpQueryAnnotationValueType(type: Type): Type | undefined {
    const valueType = getAnnotationValueType(type, 'httpQuery');
    return getHttpQueryNameLiteral(type) ? ({ kind: ReflectionKind.string } as Type) : valueType;
}

function getHttpQueryNameLiteral(type: Type): string | undefined {
    if (type.kind === ReflectionKind.literal && type.typeName === 'HttpQuery' && typeof type.literal === 'string') return type.literal;
    const options = getAnnotationOptions(type, 'httpQuery');
    if (isReflectedType(options) && options.kind === ReflectionKind.literal && typeof options.literal === 'string') return options.literal;
    if (getAnnotationOption(options, 'name') !== undefined) return undefined;
    const value = getAnnotationOption(options, 'type');
    if (typeof value === 'string') return value;
    return isReflectedType(value) && value.kind === ReflectionKind.literal && typeof value.literal === 'string' ? value.literal : undefined;
}

function cleanParameterName(name: string): string {
    return name.replace(/^_+/, '') || name;
}

function getAnnotationOptions(type: Type, annotation: string): any {
    const options = typeAnnotation.getType(type, annotation) ?? typeAnnotation.getOption(type, annotation);
    if (options !== undefined) return options;
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        for (const item of type.types) {
            const nested = getAnnotationOptions(item, annotation);
            if (nested !== undefined) return nested;
        }
    }
}

function getAnnotationValueType(type: Type, annotation: string): Type | undefined {
    const options = getAnnotationOptions(type, annotation);
    const value = getAnnotationOption(options, 'type');
    return isReflectedType(value) ? value : undefined;
}

function getApiResponseStatus(type: Type): number | undefined {
    const options = getAnnotationOptions(type, 'openapi:response');
    const annotatedStatus = getAnnotationOptionNumber(options, 'status');
    if (annotatedStatus !== undefined) return annotatedStatus;
    if (options !== undefined) return 200;

    if ((type as Type & { typeName?: string }).typeName === 'ApiResponse') return literalNumber(getTypeArgument(type, 1)) ?? 200;

    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        for (const item of type.types) {
            const nested = getApiResponseStatus(item);
            if (nested !== undefined) return nested;
        }
    }
}

function getAnnotationOptionNumber(options: unknown, name: string): number | undefined {
    const value = getAnnotationOption(options, name);
    return typeof value === 'number' ? value : undefined;
}

function getAnnotationOption(options: unknown, name: string): unknown {
    if (!options || typeof options !== 'object') return undefined;
    if (name in options && !(options as Type).kind) return (options as Record<string, unknown>)[name];
    if ((options as Type).kind === ReflectionKind.objectLiteral) {
        const property = (options as Extract<Type, { kind: ReflectionKind.objectLiteral }>).types.find(
            item => item.kind === ReflectionKind.propertySignature && String(item.name) === name
        );
        if (property?.kind !== ReflectionKind.propertySignature) return undefined;
        if (property.type.kind === ReflectionKind.literal) return property.type.literal;
        return property.type;
    }
}

function getTypeArgument(type: Type, index: number): Type | undefined {
    return (
        (type as Type & { typeArguments?: Type[]; arguments?: Type[] }).typeArguments?.[index] ??
        (type as Type & { arguments?: Type[] }).arguments?.[index]
    );
}

function literalNumber(type: Type | undefined): number | undefined {
    return type?.kind === ReflectionKind.literal && typeof type.literal === 'number' ? type.literal : undefined;
}

function getHeader(request: HttpRequest, name: string): string | string[] | undefined {
    const kebab = name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`).replace(/^-/, '');
    return request.headers[name] ?? request.headers[name.toLowerCase()] ?? request.headers[kebab] ?? request.headers[`x-${kebab}`];
}

function getPathParam(request: HttpRequest, name: string): string | undefined {
    if (request.pathParams[name] !== undefined) return request.pathParams[name];
    const values = Object.values(request.pathParams);
    return values.length === 1 ? values[0] : undefined;
}

function singleValue(value: string | string[] | undefined): string | undefined {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value[value.length - 1] : value;
}

function deserializeHttpValue(value: unknown, type: Type, path = 'value'): unknown {
    try {
        const normalizedInput = normalizeRawHttpValue(value, type);
        let deserialized = validatedDeserialize(normalizedInput, undefined, undefined, undefined, type as any);
        deserialized = normalizeHttpValue(deserialized, type, normalizedInput);
        if (deserialized === undefined && normalizedInput !== undefined) throw new Error('value is invalid');
        assertHttpValueMatchesType(deserialized, type, path, normalizedInput);
        return deserialized;
    } catch (error) {
        throw new HttpBadRequestError(formatHttpValueError(error, path));
    }
}

function httpParameterPath(kind: 'header' | 'path' | 'query', name: string): string {
    return `${kind} parameter "${name}"`;
}

function formatHttpValueError(error: unknown, path: string): string {
    if (error instanceof ValidatorError) {
        const errorPath = error.path ? `${path}.${error.path}` : path;
        if (error.message === 'The value is required.') return `${errorPath} is required`;
        if (error.message === 'The value cannot be null.') return `${errorPath} must not be null`;
        return `${errorPath}: ${error.message}`;
    }
    if (error instanceof Error) return error.message === 'The value is required.' ? `${path} is required` : error.message;
    return 'Invalid request value';
}

function defaultEmptyBody(value: unknown, type: Type): unknown {
    return value === undefined && isStructuredBodyType(type) ? {} : value;
}

function isStructuredBodyType(type: Type): boolean {
    if (isDateType(type)) return false;
    if (knownPrimitiveKind(type)) return false;
    if (isMetadataOnlyType(type)) return false;
    if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) return true;
    return type.kind === ReflectionKind.union && type.types.some(isStructuredBodyType);
}

function normalizeRawHttpValue(value: unknown, type: Type): unknown {
    if (value === undefined || value === null) return value;
    if (isDateType(type)) return normalizeDateValue(value);
    if (isTrimmedStringType(type) && typeof value === 'string') return value.trim();

    if (type.kind === ReflectionKind.union) {
        const selected = selectUnionTypeForValue(type.types, value);
        return selected ? normalizeRawHttpValue(value, selected) : value;
    }

    if (type.kind === ReflectionKind.intersection) {
        const mergedObject = mergedIntersectionStructuredType(type);
        if (mergedObject && value && typeof value === 'object' && !Array.isArray(value)) {
            return normalizeRawHttpValue(value, mergedObject);
        }

        let normalized: unknown = value;
        for (const item of type.types) normalized = normalizeRawHttpValue(normalized, item);
        return normalized;
    }

    if (type.kind === ReflectionKind.array) {
        if (!Array.isArray(value)) return value;
        return value.map(item => normalizeRawHttpValue(item, type.type));
    }

    if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = { ...(value as Record<string, unknown>) };
        for (const property of getStructuredTypeProperties(type)) {
            const name = String(property.name);
            if (Object.hasOwn(record, name)) record[name] = normalizeRawHttpValue(record[name], property.type);
        }
        return record;
    }

    return value;
}

function normalizeHttpValue(value: unknown, type: Type, rawValue?: unknown): unknown {
    if (value === undefined || value === null) return value;
    if (isDateType(type)) return normalizeDateValue(value);
    if (isTrimmedStringType(type) && typeof value === 'string') return value.trim();

    if (type.kind === ReflectionKind.union) {
        const selected = selectUnionTypeForValue(type.types, value);
        return selected ? normalizeHttpValue(value, selected, rawValue) : value;
    }

    if (type.kind === ReflectionKind.intersection) {
        const mergedObject = mergedIntersectionStructuredType(type);
        if (mergedObject && value && typeof value === 'object' && !Array.isArray(value)) {
            return normalizeHttpValue(value, mergedObject, rawValue);
        }

        let normalized: unknown = value;
        for (const item of type.types) normalized = normalizeHttpValue(normalized, item, rawValue);
        return normalized;
    }

    if (type.kind === ReflectionKind.array) {
        if (!Array.isArray(value)) return value;
        const rawItems = Array.isArray(rawValue) ? rawValue : [];
        return value.map((item, index) => normalizeHttpValue(item, type.type, rawItems[index]));
    }

    if (type.kind === ReflectionKind.class) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const rawRecord = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? (rawValue as Record<string, unknown>) : undefined;
        const record = value as Record<string, unknown>;
        for (const property of getStructuredTypeProperties(type)) {
            const name = String(property.name);
            const rawHasProperty = rawRecord ? Object.hasOwn(rawRecord, name) : false;
            if (Object.hasOwn(record, name)) record[name] = normalizeHttpValue(record[name], property.type, rawRecord?.[name]);
            else if (rawHasProperty && rawRecord?.[name] !== undefined)
                record[name] = normalizeHttpValue(rawRecord[name], property.type, rawRecord[name]);
            if (record[name] === undefined && property.optional) delete record[name];
        }
        return value;
    }

    if (type.kind === ReflectionKind.objectLiteral) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = { ...(value as Record<string, unknown>) };
        const rawRecord = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? (rawValue as Record<string, unknown>) : undefined;
        for (const property of getStructuredTypeProperties(type)) {
            const name = String(property.name);
            const rawHasProperty = rawRecord ? Object.hasOwn(rawRecord, name) : false;
            if (Object.hasOwn(record, name)) record[name] = normalizeHttpValue(record[name], property.type, rawRecord?.[name]);
            else if (rawHasProperty && rawRecord?.[name] !== undefined)
                record[name] = normalizeHttpValue(rawRecord[name], property.type, rawRecord[name]);
            if (record[name] === undefined && property.optional) delete record[name];
        }
        return record;
    }

    return value;
}

function selectUnionTypeForValue(types: Type[], value: unknown): Type | undefined {
    const concrete = types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
    if (value === undefined) return types.find(item => item.kind === ReflectionKind.undefined);
    if (value === null) return types.find(item => item.kind === ReflectionKind.null);
    if (Array.isArray(value)) return concrete.find(item => unwrapValueType(item).kind === ReflectionKind.array);
    if (value instanceof Date) return concrete.find(item => isDateType(unwrapValueType(item))) ?? concrete[0];
    if (typeof value === 'object') return concrete.find(item => isStructuredBodyType(unwrapValueType(item))) ?? concrete[0];
    const exactPrimitive = concrete.find(item => {
        const unwrapped = unwrapValueType(item);
        return (
            (typeof value === 'string' && unwrapped.kind === ReflectionKind.string) ||
            (typeof value === 'number' && unwrapped.kind === ReflectionKind.number) ||
            (typeof value === 'boolean' && unwrapped.kind === ReflectionKind.boolean)
        );
    });
    if (exactPrimitive) return exactPrimitive;
    if (typeof value === 'string' || typeof value === 'number') return concrete.find(item => isDateType(unwrapValueType(item)));
}

function assertHttpValueMatchesType(value: unknown, type: Type, path = 'value', rawValue?: unknown): void {
    if (value === undefined) {
        if (allowsKind(type, ReflectionKind.undefined)) return;
        throw new Error(`${path} is required`);
    }
    if (value === null) {
        if (allowsKind(type, ReflectionKind.null)) return;
        throw new Error(`${path} must not be null`);
    }

    if (isMetadataOnlyType(type)) return;

    const knownPrimitive = knownPrimitiveKind(type);
    if (knownPrimitive === ReflectionKind.string) {
        if (typeof value !== 'string') throw new Error(`${path} must be a string`);
        return;
    }
    if (knownPrimitive === ReflectionKind.number) {
        if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${path} must be a number`);
        return;
    }
    if (knownPrimitive === ReflectionKind.boolean) {
        if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
        return;
    }

    if (type.kind === ReflectionKind.undefined) throw new Error(`${path} must be undefined`);
    if (type.kind === ReflectionKind.null) throw new Error(`${path} must be null`);

    if (type.kind === ReflectionKind.union) {
        for (const item of type.types) {
            try {
                assertHttpValueMatchesType(value, item, path, rawValue);
                return;
            } catch {
                // Try the next union member.
            }
        }
        throw new Error(`${path} does not match any allowed type`);
    }

    if (type.kind === ReflectionKind.intersection) {
        const mergedObject = mergedIntersectionStructuredType(type);
        if (mergedObject && value && typeof value === 'object') {
            assertHttpValueMatchesType(value, mergedObject, path, rawValue);
            return;
        }

        const valueTypes = type.types.filter(item => !isMetadataOnlyType(item));
        for (const item of valueTypes) assertHttpValueMatchesType(value, item, path, rawValue);
        return;
    }

    if (type.kind === ReflectionKind.literal) {
        if (Object.is(value, type.literal)) return;
        throw new Error(`${path} must be ${String(type.literal)}`);
    }

    if (isDateType(type)) {
        if (value instanceof Date && !Number.isNaN(value.getTime())) return;
        throw new Error(`${path} must be a valid date`);
    }

    if (type.kind === ReflectionKind.string && typeof value !== 'string') throw new Error(`${path} must be a string`);
    if (type.kind === ReflectionKind.number && (typeof value !== 'number' || Number.isNaN(value))) throw new Error(`${path} must be a number`);
    if (type.kind === ReflectionKind.boolean && typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);

    if (type.kind === ReflectionKind.array) {
        if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
        const rawItems = Array.isArray(rawValue) ? rawValue : [];
        value.forEach((item, index) => assertHttpValueMatchesType(item, type.type, `${path}[${index}]`, rawItems[index]));
        return;
    }

    if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) {
        if (!value || typeof value !== 'object') throw new Error(`${path} must be an object`);
        const rawRecord = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : undefined;
        for (const property of getStructuredTypeProperties(type)) {
            const name = String(property.name);
            const propertyValue = (value as Record<string, unknown>)[name];
            const rawPropertyValue = rawRecord?.[name];
            if (propertyValue === undefined && property.optional) {
                if (rawRecord && Object.hasOwn(rawRecord, name) && rawPropertyValue !== undefined) throw new Error(`${path}.${name} is invalid`);
                continue;
            }
            assertHttpValueMatchesType(propertyValue, property.type, `${path}.${name}`, rawPropertyValue);
        }
    }
}

function getStructuredTypeProperties(type: Type): Array<{ name: string | number | symbol; type: Type; optional?: true }> {
    return ((type as Type & { types?: Type[] }).types ?? []).filter(
        (item): item is Type & { name: string | number | symbol; type: Type; optional?: true } =>
            (item.kind === ReflectionKind.property || item.kind === ReflectionKind.propertySignature) && 'name' in item && 'type' in item
    );
}

function mergedIntersectionStructuredType(type: Type): Type | undefined {
    if (type.kind !== ReflectionKind.intersection) return undefined;

    const order: string[] = [];
    const byName = new Map<string, { name: string | number | symbol; type: Type; optional?: true }>();

    const addProperty = (property: { name: string | number | symbol; type: Type; optional?: true }) => {
        const key = String(property.name);
        if (!byName.has(key)) order.push(key);
        byName.set(key, {
            name: property.name,
            type: property.type,
            optional: property.optional ? true : undefined
        });
    };

    const collect = (item: Type) => {
        if (item.kind === ReflectionKind.intersection) {
            for (const child of item.types) collect(child);
            return;
        }
        for (const property of getStructuredTypeProperties(item)) addProperty(property);
    };

    collect(type);
    const properties = order.map(key => byName.get(key)!).map(property => ({ kind: ReflectionKind.propertySignature, ...property }));
    return properties.length ? ({ kind: ReflectionKind.objectLiteral, typeName: type.typeName, types: properties } as Type) : undefined;
}

function allowsKind(type: Type, kind: ReflectionKind.null | ReflectionKind.undefined): boolean {
    if (type.kind === kind) return true;
    return type.kind === ReflectionKind.union && type.types.some(item => allowsKind(item, kind));
}

function isDateType(type: Type): boolean {
    if (type.kind === ReflectionKind.class && (type.classType === Date || type.classType?.name === 'Date' || type.typeName === 'Date')) return true;
    if (type.kind === ReflectionKind.intersection) return type.types.some(isDateType);
    if (type.kind === ReflectionKind.union) {
        const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
        return concrete.length > 0 && concrete.every(isDateType);
    }
    return false;
}

function isTrimmedStringType(type: Type): boolean {
    return type.typeName === 'TrimmedString' || type.typeName === 'NonEmptyTrimmedString' || typeAnnotation.getType(type, 'tsf:trim') !== undefined;
}

function isMetadataOnlyType(type: Type): boolean {
    const typeName = type.typeName;
    return (
        typeName === 'AutoIncrement' ||
        typeName === 'DatabaseField' ||
        typeName === 'HasDefault' ||
        typeName === 'Index' ||
        typeName === 'Maximum' ||
        typeName === 'MaxLength' ||
        typeName === 'Minimum' ||
        typeName === 'MinLength' ||
        typeName === 'MySQL' ||
        typeName === 'OnUpdate' ||
        typeName === 'Pattern' ||
        typeName === 'PrimaryKey' ||
        typeName === 'Reference' ||
        typeName === 'TypeAnnotation' ||
        typeName === 'Unique' ||
        typeName === 'Validate'
    );
}

function isReflectedClass(type: Type, classType: ClassType): boolean {
    return (
        type.kind === ReflectionKind.class &&
        (type.classType === classType || type.classType?.name === classType.name || type.typeName === classType.name)
    );
}

function normalizeDateValue(value: unknown): unknown {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date;
    }
    return value;
}

function unwrapValueType(type: Type): Type {
    if (type.kind === ReflectionKind.union) {
        const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
        return concrete.length === 1 ? unwrapValueType(concrete[0]) : type;
    }
    if (type.kind === ReflectionKind.intersection) {
        return unwrapValueType(
            type.types.find(
                item =>
                    !typeAnnotation.getType(item, 'httpPath') &&
                    !typeAnnotation.getType(item, 'httpQuery') &&
                    !typeAnnotation.getType(item, 'httpHeader')
            ) ??
                type.types[0] ??
                type
        );
    }
    return type;
}

function knownPrimitiveKind(type: Type): ReflectionKind.string | ReflectionKind.number | ReflectionKind.boolean | undefined {
    const foundationType = typeAnnotation.getType(type, 'tsf:type');
    if (foundationType?.kind === ReflectionKind.literal) {
        if (foundationType.literal === 'integer') return ReflectionKind.number;
        if (typeof foundationType.literal === 'string') return ReflectionKind.string;
    }
}

function isEmptyResponseReturnType(type: Type): boolean {
    const typeName = (type as Type & { typeName?: string }).typeName;
    if (typeName === 'EmptyResponse') return true;
    if (type.kind === ReflectionKind.promise) return isEmptyResponseReturnType(type.type);
    return false;
}

function annotationTypeName(annotation: string): string {
    if (annotation === 'httpBody') return 'HttpBody';
    if (annotation === 'httpQueries') return 'HttpQueries';
    if (annotation === 'httpPath') return 'HttpPath';
    if (annotation === 'httpQuery') return 'HttpQuery';
    if (annotation === 'httpHeader') return 'HttpHeader';
    return annotation;
}
