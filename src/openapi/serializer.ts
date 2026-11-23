import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isReflectedType, ReflectionClass, ReflectionKind, Type, typeAnnotation } from '../reflection';
import { stringify } from 'yaml';

import { getPackageJson } from '../helpers';
import type { BaseAppConfig } from '../app/config';
import { Env } from '../env';
import { EmptyResponseResult, JsonResponseResult, RawResponseResult, RedirectResponseResult, WebResponseResult } from '../http';
import { isHttpSingleValueParameter, type HttpRouteParameterPlan, type HttpRoutePlan, type HttpSingleValueParameterPlan } from '../http';
import { getOpenApiOperationOptions, getOpenApiResponses, isOpenApiIgnored, type OpenApiOperationOptions } from './decorators';
import {
    allowsUndefined,
    applyOpenApiDocFields,
    createOpenApiSchemaContext,
    describeOpenApiDeprecation,
    type OpenApiDocFields,
    listOpenApiTypeProperties,
    typeHasOpenApiFileUpload,
    typeRequiresOpenApiFileUpload,
    typeToOpenApiSchema,
    unwrapOpenApiType
} from './schema';
import type {
    OpenApiContributor,
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
    /** Include TSF infrastructure routes (health, openapi, metrics, devconsole). */
    includeInternal?: boolean;
    /** Replaces the contributors registered on the app (`createApp({ openapi: { contributors } })`). */
    contributors?: readonly OpenApiContributor[];
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

    const operationIds = new Set<string>();
    const securitySchemes: Record<string, unknown> = {};
    const contributors = options.contributors ?? app.openapiContributors ?? [];
    const allRoutes = app.router.listRoutes();
    const controllerTags = new Map<string, string>();
    const addSecuritySchemes = (schemes: Record<string, unknown> | undefined) => {
        for (const [name, scheme] of Object.entries(schemes ?? {})) {
            if (Object.hasOwn(securitySchemes, name) && !isDeepStrictEqual(securitySchemes[name], scheme))
                throw new Error(`Conflicting OpenAPI security scheme ${name}`);
            securitySchemes[name] = scheme;
        }
    };
    const routes = allRoutes.filter(
        route =>
            (options.includeInternal || !isInternalOpenApiRoute(route.path)) &&
            !isOpenApiIgnored(route.controllerClass, route.propertyKey) &&
            toOpenApiMethod(route.method)
    );
    const handlerRoutes = new Map<HttpRoutePlan['controllerClass'], Map<string | symbol, Map<string, number>>>();
    for (const route of routes) {
        const methods = handlerRoutes.get(route.controllerClass) ?? new Map();
        handlerRoutes.set(route.controllerClass, methods);
        const verbs = methods.get(route.propertyKey) ?? new Map();
        methods.set(route.propertyKey, verbs);
        verbs.set(route.method, (verbs.get(route.method) ?? 0) + 1);
    }
    for (const route of routes) {
        const method = toOpenApiMethod(route.method);
        if (!method) continue;
        const path = toOpenApiPath(route.path);
        document.paths[path] ??= {};
        if (document.paths[path][method]) throw new Error(`Duplicate OpenAPI route ${method} ${path}`);
        const idSuffix =
            (handlerRoutes.get(route.controllerClass)?.get(route.propertyKey)?.get(route.method) ?? 0) > 1
                ? '_' + createHash('sha256').update(path).digest('hex').slice(0, 12)
                : '';
        const { operation, explicitOperationId, defaultOperationId } = buildOperation(
            route,
            schemaContext,
            contributors,
            addSecuritySchemes,
            idSuffix
        );
        for (const contributor of contributors) {
            contributor.validateOperation?.({ route, operation, explicitOperationId, defaultOperationId });
        }

        const derivedTag = getControllerTagName(route.controllerClass);
        if (operation.tags?.includes(derivedTag) && !controllerTags.has(derivedTag)) {
            controllerTags.set(derivedTag, getControllerDescription(route.controllerClass) ?? '');
        }
        if (operationIds.has(operation.operationId)) throw new Error(`Duplicate OpenAPI operationId ${operation.operationId}`);
        operationIds.add(operation.operationId);
        document.paths[path][method] = operation;
    }

    const tags = [...controllerTags].filter(([, description]) => description).map(([name, description]) => ({ name, description }));
    if (tags.length) document.tags = tags;

    if (Object.keys(schemaContext.schemas).length) {
        document.components ??= {};
        document.components.schemas = schemaContext.schemas;
    }

    const bearer = {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
    };
    if (Object.hasOwn(securitySchemes, 'bearerAuth') && !isDeepStrictEqual(securitySchemes.bearerAuth, bearer)) {
        throw new Error('Conflicting OpenAPI security scheme bearerAuth; this name is reserved for JWT bearer authentication');
    }
    if (usesBearerAuth(document)) securitySchemes.bearerAuth = bearer;
    if (Object.keys(securitySchemes).length) {
        document.components ??= {};
        document.components.securitySchemes = securitySchemes;
    }
    for (const path of Object.values(document.paths)) {
        for (const operation of Object.values(path)) {
            for (const requirement of operation?.security ?? []) {
                for (const name of Object.keys(requirement)) {
                    if (!Object.hasOwn(securitySchemes, name)) throw new Error(`Undefined OpenAPI security scheme ${name}`);
                }
            }
        }
    }

    for (const contributor of contributors) contributor.document?.(document, allRoutes);

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

interface BuiltOperation {
    operation: OpenApiOperation;
    explicitOperationId?: string;
    defaultOperationId: string;
}

/**
 * Builds one operation. Layers, later replacing earlier: inferred (types and JSDoc), contributors
 * in registration order, the controller's `openapi.operation()`, then the method's.
 * Contributor `appendDescription` paragraphs are appended to the final description.
 */
function buildOperation(
    route: HttpRoutePlan,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>,
    contributors: readonly OpenApiContributor[],
    addSecuritySchemes: (schemes: Record<string, unknown> | undefined) => void,
    idSuffix: string
): BuiltOperation {
    const parameters = buildParameters(route, schemaContext);
    const requestBody = buildRequestBody(route, schemaContext);
    const tagName = getControllerTagName(route.controllerClass);
    const baseOperationId = getOperationId(route, tagName);
    const defaultOperationId = baseOperationId + idSuffix;
    const operation: OpenApiOperation = {
        operationId: baseOperationId,
        tags: [tagName],
        responses: buildResponses(route, schemaContext)
    };

    const summary = getRouteDescription(route);
    if (summary) operation.summary = summary;
    const docs = route.docs;
    const description = describeOpenApiDeprecation(docs?.body, docs?.deprecated);
    if (description) operation.description = description;
    if (docs?.deprecated !== undefined) operation.deprecated = true;
    if (docs?.sunset) operation['x-sunset'] = docs.sunset;
    if (parameters.length) operation.parameters = parameters;
    // Group parameters (HttpBody, HttpQueries) take no docs; their type's members are documented.
    if (requestBody) operation.requestBody = requestBody;
    const requiresJwt = route.parameters.some(parameter => parameter.kind === 'jwt' && !parameter.optional);
    if (requiresJwt) operation.security = [{ bearerAuth: [] }];

    const applyLayer = (layer: OpenApiOperationOptions & { appendDescription?: string[] }) => {
        const { securitySchemes, extensions, appendDescription: _append, ...fields } = layer;
        for (const name of Object.keys(extensions ?? {})) {
            if (!name.startsWith('x-')) throw new Error('OpenAPI extensions must start with x-');
        }
        Object.assign(operation, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), extensions);
        addSecuritySchemes(securitySchemes);
    };

    const appended: string[] = [];
    if (contributors.length) {
        const inferredSnapshot = { ...operation, operationId: defaultOperationId };
        for (const contributor of contributors) {
            // Each contributor gets its own copy, so one cannot affect what the next sees.
            const inferred = structuredClone(inferredSnapshot);
            const result = contributor.operation?.({ route, inferred, defaultOperationId });
            if (!result) continue;
            if ('operationId' in result && (result as { operationId?: unknown }).operationId !== undefined) {
                throw new Error(`OpenAPI contributor ${contributor.name} cannot set operationId`);
            }
            applyLayer(result);
            appended.push(...(result.appendDescription ?? []).filter(paragraph => paragraph.trim()));
        }
    }

    let explicitOperationId: string | undefined;
    for (const metadata of getOpenApiOperationOptions(route.controllerClass, route.propertyKey)) {
        if (metadata.operationId) explicitOperationId = metadata.operationId;
        applyLayer(metadata);
    }
    if (appended.length) operation.description = [operation.description, ...appended].filter(Boolean).join('\n\n');
    operation.operationId += idSuffix;

    if (requiresJwt) {
        if (!operation.security?.length || operation.security.some(requirement => !Object.hasOwn(requirement, 'bearerAuth'))) {
            throw new Error('OpenAPI security metadata cannot remove required ParsedJwt authentication');
        }
    }

    return { operation, explicitOperationId, defaultOperationId };
}

function buildParameters(route: HttpRoutePlan, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): OpenApiParameter[] {
    const parameters: OpenApiParameter[] = [];
    const documentedPathParams = new Set<string>();

    for (const parameter of route.parameters) {
        if (isHttpSingleValueParameter(parameter)) {
            if (parameter.kind === 'path') documentedPathParams.add(parameter.name);
            // The single-value kinds are the OpenAPI parameter locations.
            parameters.push(buildOpenApiParameter(parameter.kind, parameter, schemaContext, parameterDocFields(route, parameter)));
        } else if (parameter.kind === 'queries') {
            parameters.push(...expandObjectParameters('query', parameter, schemaContext));
        }
    }

    for (const name of route.paramNames) {
        if (documentedPathParams.has(name)) continue;
        const description = taggedParameterDoc(route, undefined, name);
        parameters.push({
            name,
            in: 'path',
            required: true,
            ...(description ? { description } : {}),
            schema: { type: 'string' }
        });
    }

    return parameters;
}

function buildOpenApiParameter(
    location: 'path' | 'query' | 'header',
    parameter: Extract<HttpRouteParameterPlan, { type: Type; name: string }>,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>,
    docs: OpenApiDocFields = {}
): OpenApiParameter {
    const schema = typeToOpenApiSchema(parameter.type, schemaContext);
    const result: OpenApiParameter = {
        name: parameter.name,
        in: location,
        required: location === 'path' ? true : !parameter.optional && !allowsUndefined(parameter.type),
        schema: isEmptySchema(schema) ? { type: 'string' } : schema
    };
    return applyParameterDocs(result, docs);
}

/**
 * Description, deprecation and sunset for a single-value parameter: `@param` text wins over inline
 * JSDoc. Group parameters (HttpBody, HttpQueries) take no docs.
 */
function parameterDocFields(route: HttpRoutePlan, parameter: HttpSingleValueParameterPlan): OpenApiDocFields {
    const tagged = taggedParameterDoc(route, parameter.sourceName, parameter.name);
    return { description: tagged || parameter.docs?.description, deprecated: parameter.docs?.deprecated, sunset: parameter.docs?.sunset };
}

/**
 * Finds the `@param` text for a parameter. The TypeScript parameter name wins; the wire name is
 * only used when no parameter of the handler has that TypeScript name.
 */
export function taggedParameterDoc(route: HttpRoutePlan, sourceName: string | undefined, wireName: string | undefined): string | undefined {
    const params = route.docs?.params;
    if (!params) return undefined;
    if (sourceName !== undefined && Object.hasOwn(params, sourceName)) return params[sourceName];
    if (wireName === undefined || !Object.hasOwn(params, wireName)) return undefined;
    const claimedByAnotherParameter = route.parameters.some(item => item.sourceName === wireName);
    return claimedByAnotherParameter ? undefined : params[wireName];
}

function applyParameterDocs(parameter: OpenApiParameter, docs: OpenApiDocFields): OpenApiParameter {
    const description = describeOpenApiDeprecation(docs.description, docs.deprecated);
    if (description) parameter.description = description;
    if (docs.deprecated !== undefined) parameter.deprecated = true;
    if (docs.sunset) parameter['x-sunset'] = docs.sunset;
    return parameter;
}

/** Expands an object-typed group parameter into one parameter per member, documented by the member's JSDoc. */
function expandObjectParameters(
    location: 'query' | 'header',
    parameter: Extract<HttpRouteParameterPlan, { type: Type; name: string }>,
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>
): OpenApiParameter[] {
    const properties = listOpenApiTypeProperties(parameter.type);
    if (!properties.length) return [buildOpenApiParameter(location, parameter, schemaContext)];
    typeToOpenApiSchema(parameter.type, schemaContext);
    return properties.map(property =>
        applyParameterDocs(
            {
                name: property.name,
                in: location,
                required: !parameter.optional && property.required,
                schema: typeToOpenApiSchema(property.type, schemaContext)
            },
            property
        )
    );
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
        if (!bodyParamsRequireFiles) {
            content['application/json'] = { schema: schemaForJsonBodyWithoutFileUploads(bodyParams[0].type, schemaContext) };
        }
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

function schemaForJsonBodyWithoutFileUploads(type: Type, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'object', properties: {} };
    const required: string[] = [];

    for (const property of listOpenApiTypeProperties(type)) {
        if (typeHasOpenApiFileUpload(property.type)) continue;
        schema.properties![property.name] = applyOpenApiDocFields(typeToOpenApiSchema(property.type, schemaContext), property);
        if (property.required) required.push(property.name);
    }

    if (required.length) schema.required = required;
    return schema;
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
    const responses = buildInferredResponses(route, schemaContext);
    const returns = route.docs?.returns;
    if (returns) for (const response of Object.values(responses)) response.description = returns;
    for (const response of getOpenApiResponses(route.controllerClass, route.propertyKey)) {
        const typedResponse = buildTypedResponse(response.status, response.type, schemaContext, response.description);
        const result = typedResponse[String(response.status)]!;
        if ((response.mediaType || response.examples) && !result.content) {
            throw new Error('OpenAPI response mediaType/examples require a response body type');
        }
        if (response.mediaType && result.content?.['application/json']) {
            result.content = { [response.mediaType]: result.content['application/json'] };
        }
        if (response.examples) for (const media of Object.values(result.content ?? {})) media.examples = response.examples;
        if (response.headers) result.headers = response.headers;
        responses[String(response.status)] = result;
    }
    return responses;
}

function buildInferredResponses(route: HttpRoutePlan, schemaContext: ReturnType<typeof createOpenApiSchemaContext>): Record<string, OpenApiResponse> {
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

    if (isClassType(returnType, RawResponseResult) || isClassType(returnType, WebResponseResult)) {
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
    schemaContext: ReturnType<typeof createOpenApiSchemaContext>,
    description?: string
): Record<string, OpenApiResponse> {
    const returnType = unwrapOpenApiType(type);
    if (returnType.kind === ReflectionKind.void || returnType.kind === ReflectionKind.undefined) {
        return { [status]: { description: description ?? responseDescription(status) } };
    }

    return {
        [status]: {
            description: description ?? responseDescription(status),
            content: {
                'application/json': {
                    schema: typeToOpenApiSchema(type, schemaContext)
                }
            }
        }
    };
}

function responseDescription(status: number): string {
    return STATUS_CODES[status] ?? 'Response';
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

/** TSF infrastructure routes (health, OpenAPI, metrics, DevConsole), left out of the document by default. */
export function isInternalOpenApiRoute(path: string): boolean {
    return (
        path === '/openapi.json' ||
        path === '/openapi.yaml' ||
        path === '/healthz' ||
        path === '/readyz' ||
        path === '/livez' ||
        path === '/metrics' ||
        path.startsWith('/_devconsole')
    );
}

type RouteControllerClass = HttpRoutePlan['controllerClass'];

function getControllerTagName(controllerClass: { name: string }): string {
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

function getControllerDescription(controllerClass: RouteControllerClass): string | undefined {
    try {
        return ReflectionClass.from(controllerClass).getDescription() || undefined;
    } catch {
        return undefined;
    }
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

function isClassType(type: Type, classType: object): boolean {
    return type.kind === ReflectionKind.class && type.classType === classType;
}

function usesBearerAuth(document: OpenApiDocument): boolean {
    return Object.values(document.paths).some(path => Object.values(path).some(operation => operation?.security?.some(item => item.bearerAuth)));
}

function isEmptySchema(schema: unknown): boolean {
    return !!schema && typeof schema === 'object' && !('$ref' in schema) && Object.keys(schema).length === 0;
}
