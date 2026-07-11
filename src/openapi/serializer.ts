import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isReflectedType, ReflectionKind, Type, typeAnnotation } from '../reflection';
import { stringify } from 'yaml';

import { getPackageJson } from '../helpers';
import type { BaseAppConfig } from '../app/config';
import { Env } from '../env';
import { EmptyResponseResult, JsonResponseResult, RawResponseResult, RedirectResponseResult } from '../http';
import type { HttpRouteParameterPlan, HttpRoutePlan } from '../http';
import {
    allowsUndefined,
    createOpenApiSchemaContext,
    listOpenApiTypeProperties,
    typeHasOpenApiFileUpload,
    typeRequiresOpenApiFileUpload,
    typeToOpenApiSchema,
    unwrapOpenApiType
} from './schema';
import type {
    OpenApiDocument,
    OpenApiHttpMethod,
    OpenApiOperation,
    OpenApiParameter,
    OpenApiRequestBody,
    OpenApiResponse,
    OpenApiSchemaObject,
    OpenApiSerializableApp
} from './types';

export interface SerializeOpenApiOptions {
    title?: string;
    version?: string;
    includeInternal?: boolean;
}

export interface DumpOpenApiOptions extends SerializeOpenApiOptions {
    path?: string;
}

interface ApiResponseMetadata {
    status: number;
    type: Type;
}

export function serializeOpenApiSchema(app: OpenApiSerializableApp, options: SerializeOpenApiOptions = {}): OpenApiDocument {
    const packageJson = getPackageJson();
    const schemaContext = createOpenApiSchemaContext();
    const document: OpenApiDocument = {
        openapi: '3.1.0',
        jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
        info: {
            title: options.title ?? packageJson?.name ?? 'API',
            version: options.version ?? packageJson?.version ?? '0.0.0'
        },
        paths: {}
    };

    for (const route of app.router.listRoutes()) {
        if (!options.includeInternal && isInternalRoute(route.path)) continue;
        const method = toOpenApiMethod(route.method);
        if (!method) continue;
        const path = toOpenApiPath(route.path);
        document.paths[path] ??= {};
        document.paths[path][method] = buildOperation(route, schemaContext);
    }

    if (Object.keys(schemaContext.schemas).length) {
        document.components ??= {};
        document.components.schemas = schemaContext.schemas;
    }

    if (usesBearerAuth(document)) {
        document.components ??= {};
        document.components.securitySchemes = {
            ...document.components.securitySchemes,
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT'
            }
        };
    }

    return document;
}

export async function dumpOpenApiSchema(app: OpenApiSerializableApp, options: DumpOpenApiOptions = {}): Promise<string> {
    const outputPath = options.path ?? join(process.cwd(), 'openapi.yaml');
    await writeFile(outputPath, serializeOpenApiYaml(app, options));
    return outputPath;
}

export function serializeOpenApiYaml(app: OpenApiSerializableApp, options: SerializeOpenApiOptions = {}): string {
    return stringify(serializeOpenApiSchema(app, options), {
        aliasDuplicateObjects: false
    });
}

export function shouldExposeOpenApi(config: Pick<BaseAppConfig, 'APP_ENV' | 'ENABLE_OPENAPI_SCHEMA' | 'ENABLE_OPENAPI_ROUTE'>): boolean {
    const route = config.ENABLE_OPENAPI_ROUTE as boolean | string | undefined;
    if (isTruthyConfigValue(route)) return true;
    if (isFalseyConfigValue(route)) return false;
    const legacy = config.ENABLE_OPENAPI_SCHEMA as boolean | string | undefined;
    if (isTruthyConfigValue(legacy)) return true;
    if (isFalseyConfigValue(legacy)) return false;
    return config.APP_ENV === 'test' || config.APP_ENV === 'development';
}

export function shouldDumpOpenApiSchema(config: Pick<BaseAppConfig, 'APP_ENV' | 'ENABLE_OPENAPI_SCHEMA'>): boolean {
    const legacy = config.ENABLE_OPENAPI_SCHEMA as boolean | string | undefined;
    if (isTruthyConfigValue(legacy)) return true;
    if (isFalseyConfigValue(legacy)) return false;
    return config.APP_ENV === 'development' && Env.NODE_TEST_CONTEXT === undefined;
}

function isTruthyConfigValue(value: boolean | string | undefined): boolean {
    return value === true || value === 'true' || value === '1';
}

function isFalseyConfigValue(value: boolean | string | undefined): boolean {
    return value === false || value === 'false' || value === '0';
}

function buildOperation(route: HttpRoutePlan, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): OpenApiOperation {
    const parameters = buildParameters(route, schemaContext);
    const requestBody = buildRequestBody(route, schemaContext);
    const tagName = getControllerTagName(route.controllerClass);
    const operation: OpenApiOperation = {
        operationId: getOperationId(route, tagName),
        tags: [tagName],
        responses: buildResponses(route, schemaContext)
    };

    const description = getRouteDescription(route);
    if (description) operation.summary = description;
    if (parameters.length) operation.parameters = parameters;
    if (requestBody) operation.requestBody = requestBody;
    if (route.parameters.some(parameter => parameter.kind === 'jwt' && !parameter.optional)) {
        operation.security = [{ bearerAuth: [] }];
    }

    return operation;
}

function buildParameters(route: HttpRoutePlan, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): OpenApiParameter[] {
    const parameters: OpenApiParameter[] = [];
    const documentedPathParams = new Set<string>();

    for (const parameter of route.parameters) {
        if (parameter.kind === 'path') {
            documentedPathParams.add(parameter.name);
            parameters.push(buildOpenApiParameter('path', parameter, schemaContext));
        } else if (parameter.kind === 'query') {
            parameters.push(buildOpenApiParameter('query', parameter, schemaContext));
        } else if (parameter.kind === 'header') {
            parameters.push(buildOpenApiParameter('header', parameter, schemaContext));
        } else if (parameter.kind === 'queries') {
            parameters.push(...expandObjectParameters('query', parameter, schemaContext));
        }
    }

    for (const name of route.paramNames) {
        if (documentedPathParams.has(name)) continue;
        parameters.push({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' }
        });
    }

    return parameters;
}

function buildOpenApiParameter(
    location: 'path' | 'query' | 'header',
    parameter: Extract<HttpRouteParameterPlan, { type: Type; name: string }>,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>
): OpenApiParameter {
    const schema = typeToOpenApiSchema(parameter.type, schemaContext);
    return {
        name: parameter.name,
        in: location,
        required: location === 'path' ? true : !parameter.optional && !allowsUndefined(parameter.type),
        schema: isEmptySchema(schema) ? { type: 'string' } : schema
    };
}

function expandObjectParameters(
    location: 'query' | 'header',
    parameter: Extract<HttpRouteParameterPlan, { type: Type; name: string }>,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>
): OpenApiParameter[] {
    const properties = listOpenApiTypeProperties(parameter.type);
    if (!properties.length) return [buildOpenApiParameter(location, parameter, schemaContext)];
    typeToOpenApiSchema(parameter.type, schemaContext);
    return properties.map(property => ({
        name: property.name,
        in: location,
        required: !parameter.optional && property.required,
        description: property.description,
        schema: typeToOpenApiSchema(property.type, schemaContext)
    }));
}

function buildRequestBody(route: HttpRoutePlan, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): OpenApiRequestBody | undefined {
    const bodyParams = route.parameters.filter(
        (parameter): parameter is Extract<HttpRouteParameterPlan, { kind: 'body' }> => parameter.kind === 'body'
    );
    const fileParams = route.parameters.filter(
        (parameter): parameter is Extract<HttpRouteParameterPlan, { kind: 'file' }> => parameter.kind === 'file'
    );
    const bodyParamsContainFiles = bodyParams.some(parameter => typeHasOpenApiFileUpload(parameter.type));
    const bodyParamsRequireFiles = bodyParams.some(parameter => typeRequiresOpenApiFileUpload(parameter.type));
    if (!bodyParams.length && !fileParams.length) return undefined;

    if (!fileParams.length && bodyParams.length === 1 && bodyParamsContainFiles) {
        const encoding = uploadEncodingForRoute(route);
        const schema = typeToOpenApiSchema(bodyParams[0].type, schemaContext);
        const content: OpenApiRequestBody['content'] = {
            'multipart/form-data': {
                schema,
                encoding: Object.keys(encoding).length ? encoding : undefined
            }
        };
        if (!bodyParamsRequireFiles) content['application/json'] = { schema };
        return {
            required: !bodyParams[0].optional,
            content
        };
    }

    if (fileParams.length) {
        const schema: OpenApiSchemaObject = { type: 'object', properties: {} };
        const required: string[] = [];
        const encoding: Record<string, { contentType?: string }> = {};

        for (const file of fileParams) {
            schema.properties![file.name] = openApiFileSchema(route.uploadPolicy.files?.[file.name]);
            const contentType = uploadPolicyContentType(route.uploadPolicy.files?.[file.name]);
            if (contentType) encoding[file.name] = { contentType };
            if (!file.optional) required.push(file.name);
        }

        if (bodyParams.length) {
            const bodySchema =
                bodyParams.length === 1 ? typeToOpenApiSchema(bodyParams[0].type, schemaContext) : schemaForMultipleBodies(bodyParams, schemaContext);
            schema.properties!._payload = bodySchema;
            encoding._payload = { contentType: 'application/json' };
            if (bodyParams.some(parameter => !parameter.optional)) required.push('_payload');
        }

        if (required.length) schema.required = required;
        return {
            required: required.length > 0,
            content: {
                'multipart/form-data': {
                    schema,
                    encoding: Object.keys(encoding).length ? encoding : undefined
                }
            }
        };
    }

    return {
        required: bodyParams.some(parameter => !parameter.optional),
        content: {
            'application/json': {
                schema:
                    bodyParams.length === 1
                        ? typeToOpenApiSchema(bodyParams[0].type, schemaContext)
                        : schemaForMultipleBodies(bodyParams, schemaContext)
            }
        }
    };
}

function uploadEncodingForRoute(route: HttpRoutePlan): Record<string, { contentType?: string }> {
    const encoding: Record<string, { contentType?: string }> = {};
    for (const [name, policy] of Object.entries(route.uploadPolicy.files ?? {})) {
        const contentType = uploadPolicyContentType(policy);
        if (contentType) encoding[name] = { contentType };
    }
    return encoding;
}

function openApiFileSchema(policy: { maxSizeBytes?: number; allowedTypes?: string[] } | undefined): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'string', format: 'binary' };
    if (policy?.maxSizeBytes !== undefined) schema['x-maxSizeBytes'] = policy.maxSizeBytes;
    if (policy?.allowedTypes?.length) schema['x-allowedTypes'] = policy.allowedTypes;
    return schema;
}

function uploadPolicyContentType(policy: { allowedTypes?: string[] } | undefined): string | undefined {
    return policy?.allowedTypes?.length ? policy.allowedTypes.join(', ') : undefined;
}

function schemaForMultipleBodies(
    bodyParams: Array<Extract<HttpRouteParameterPlan, { kind: 'body' }>>,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>
): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'object', properties: {} };
    const required: string[] = [];
    for (const body of bodyParams) {
        schema.properties![body.name] = typeToOpenApiSchema(body.type, schemaContext);
        if (!body.optional) required.push(body.name);
    }
    if (required.length) schema.required = required;
    return schema;
}

function buildResponses(route: HttpRoutePlan, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): Record<string, OpenApiResponse> {
    const apiResponse = getApiResponseMetadata(route.returnType);
    if (apiResponse) return buildTypedResponse(apiResponse.status, apiResponse.type, schemaContext);

    const returnType = unwrapOpenApiType(route.returnType);
    const typeName = getHttpResponseAliasName(route.returnType) ?? getTypeName(route.returnType) ?? getTypeName(returnType);

    if (typeName === 'RedirectResponse') {
        return {
            '302': {
                description: 'Redirect',
                headers: {
                    location: { schema: { type: 'string' } }
                }
            }
        };
    }

    if (isClassType(returnType, RedirectResponseResult)) {
        return {
            default: {
                description: 'Redirect',
                headers: {
                    location: { schema: { type: 'string' } }
                }
            }
        };
    }

    if (typeName === 'EmptyResponse') {
        return { '204': { description: 'No Content' } };
    }

    if (isClassType(returnType, EmptyResponseResult)) {
        return { default: { description: 'No Content' } };
    }

    if (returnType.kind === ReflectionKind.void || returnType.kind === ReflectionKind.undefined) {
        return { '200': { description: 'OK' } };
    }

    if (typeName === 'AnyResponse') {
        return {
            '200': {
                description: 'OK',
                content: {
                    'application/json': {
                        schema: {}
                    }
                }
            }
        };
    }

    if (typeName === 'OkResponse') {
        return {
            '200': {
                description: 'OK',
                content: {
                    'application/json': {
                        schema: {}
                    }
                }
            }
        };
    }

    if (isClassType(returnType, JsonResponseResult)) {
        return {
            default: {
                description: 'OK',
                content: {
                    'application/json': {
                        schema: {}
                    }
                }
            }
        };
    }

    if (isClassType(returnType, RawResponseResult)) {
        return {
            default: {
                description: 'OK'
            }
        };
    }

    return {
        '200': {
            description: 'OK',
            content: {
                'application/json': {
                    schema: typeToOpenApiSchema(route.returnType, schemaContext)
                }
            }
        }
    };
}

function buildTypedResponse(
    status: number,
    type: Type,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>
): Record<string, OpenApiResponse> {
    const returnType = unwrapOpenApiType(type);
    if (returnType.kind === ReflectionKind.void || returnType.kind === ReflectionKind.undefined) {
        return { [status]: { description: responseDescription(status) } };
    }

    return {
        [status]: {
            description: responseDescription(status),
            content: {
                'application/json': {
                    schema: typeToOpenApiSchema(type, schemaContext)
                }
            }
        }
    };
}

function responseDescription(status: number): string {
    if (status === 201) return 'Created';
    if (status === 202) return 'Accepted';
    if (status === 204) return 'No Content';
    return 'OK';
}

function getApiResponseMetadata(type: Type): ApiResponseMetadata | undefined {
    const options = getAnnotationOptions(type, 'openapi:response');
    const bodyType = getAnnotationOptionType(options, 'type') ?? getTypeArgument(type, 0) ?? getPromiseAliasType(type);
    if (bodyType) {
        return {
            status: getAnnotationOptionNumber(options, 'status') ?? literalNumber(getTypeArgument(type, 1)) ?? 200,
            type: bodyType
        };
    }

    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        for (const item of type.types) {
            const nested = getApiResponseMetadata(item);
            if (nested) return nested;
        }
    }
}

function getPromiseAliasType(type: Type): Type | undefined {
    return getTypeName(type) === 'ApiResponse' && type.kind === ReflectionKind.promise ? type.type : undefined;
}

function getTypeArgument(type: Type, index: number): Type | undefined {
    return (
        (type as Type & { typeArguments?: Type[]; arguments?: Type[] }).typeArguments?.[index] ??
        (type as Type & { arguments?: Type[] }).arguments?.[index]
    );
}

function getAnnotationOptions(type: Type, annotation: string): unknown {
    const options = typeAnnotation.getType(type, annotation) ?? typeAnnotation.getOption(type, annotation);
    if (options !== undefined) return options;
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        for (const item of type.types) {
            const nested = getAnnotationOptions(item, annotation);
            if (nested !== undefined) return nested;
        }
    }
}

function getAnnotationOptionType(options: unknown, name: string): Type | undefined {
    const value = getAnnotationOption(options, name);
    return isReflectedType(value) ? value : undefined;
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

function literalNumber(type: Type | undefined): number | undefined {
    return type?.kind === ReflectionKind.literal && typeof type.literal === 'number' ? type.literal : undefined;
}

function toOpenApiMethod(method: string): OpenApiHttpMethod | undefined {
    const lower = method.toLowerCase();
    return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(lower) ? (lower as OpenApiHttpMethod) : undefined;
}

function toOpenApiPath(path: string): string {
    return path.replace(/:([^/]+)/g, '{$1}');
}

function isInternalRoute(path: string): boolean {
    return path === '/openapi.json' || path === '/openapi.yaml' || path === '/healthz' || path === '/metrics' || path.startsWith('/_devconsole');
}

function getControllerTagName(controllerClass: Function): string {
    return camelCaseIdentifier(controllerClass.name.replace(/Controller$/, '') || controllerClass.name || 'controller');
}

function getOperationId(route: HttpRoutePlan, tagName: string): string {
    return camelCaseIdentifier([route.method.toLowerCase(), tagName, route.methodName]);
}

function camelCaseIdentifier(parts: string | string[]): string {
    const words = (Array.isArray(parts) ? parts.join(' ') : parts)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean);

    if (!words.length) return '';
    return words
        .map((word, index) => {
            const normalized = word.toLowerCase();
            return index === 0 ? normalized : normalized.charAt(0).toUpperCase() + normalized.slice(1);
        })
        .join('');
}

function isRequiredParameterType(type: Type): boolean {
    const unwrapped = unwrapOpenApiType(type);
    return !(unwrapped.kind === ReflectionKind.union && unwrapped.types.some(item => item.kind === ReflectionKind.undefined));
}

function getRouteDescription(route: HttpRoutePlan): string | undefined {
    return route.description;
}

function getTypeName(type: Type): string | undefined {
    return (type as Type & { typeName?: string }).typeName;
}

function getHttpResponseAliasName(type: Type): string | undefined {
    const typeName = getTypeName(type);
    if (isHttpResponseAliasName(typeName)) return typeName;
    if (type.kind === ReflectionKind.promise) return getHttpResponseAliasName(type.type);
    if (type.kind === ReflectionKind.intersection || type.kind === ReflectionKind.union) {
        for (const item of type.types) {
            const nested = getHttpResponseAliasName(item);
            if (nested) return nested;
        }
    }
}

function isHttpResponseAliasName(typeName: string | undefined): boolean {
    return typeName === 'AnyResponse' || typeName === 'OkResponse' || typeName === 'RedirectResponse' || typeName === 'EmptyResponse';
}

function isClassType(type: Type, classType: Function): boolean {
    return type.kind === ReflectionKind.class && type.classType === classType;
}

function usesBearerAuth(document: OpenApiDocument): boolean {
    return Object.values(document.paths).some(path => Object.values(path).some(operation => operation?.security?.some(item => item.bearerAuth)));
}

function isEmptySchema(schema: unknown): boolean {
    return !!schema && typeof schema === 'object' && !('$ref' in schema) && Object.keys(schema).length === 0;
}
