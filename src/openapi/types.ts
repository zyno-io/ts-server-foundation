import type { HttpRouter, HttpRoutePlan } from '../http';
import type { BaseAppConfig } from '../app';
import type { TypeAnnotation } from '../reflection';
import type { OpenApiOperationOptions } from './decorators';

export type ApiName<T extends string> = TypeAnnotation<'openapi:name', T>;
export type ApiType<Name extends string, T> = T & ApiName<Name>;
export type ApiResponse<T, Status extends number = 200> = Promise<T>;

export interface OpenApiSerializableApp {
    readonly router: HttpRouter;
    readonly config: BaseAppConfig;
    /** Contributors registered with `createApp({ openapi: { contributors } })`. */
    readonly openapiContributors?: readonly OpenApiContributor[];
}

/**
 * Lets a library or application add operation metadata and validate the generated document
 * without decorating every controller. Register with `createApp({ openapi: { contributors } })`
 * or override per call with `SerializeOpenApiOptions.contributors`.
 */
export interface OpenApiContributor {
    readonly name: string;
    /**
     * Runs after inference (including JSDoc) and before `openapi.operation()` decorators.
     * Fields replace earlier values; `extensions` merge; `securitySchemes` merge with the usual conflict check.
     * `appendDescription` paragraphs are appended to the final description, joined by blank lines.
     */
    operation?(ctx: {
        route: HttpRoutePlan;
        inferred: Readonly<OpenApiOperation>;
        defaultOperationId: string;
    }): (Omit<OpenApiOperationOptions, 'operationId'> & { appendDescription?: string[] }) | undefined;
    /** Called on the final operation; throw to fail generation. */
    validateOperation?(ctx: {
        route: HttpRoutePlan;
        operation: Readonly<OpenApiOperation>;
        /** The operationId set through `openapi.operation()`, if any. */
        explicitOperationId?: string;
        /** The automatically generated operationId. */
        defaultOperationId: string;
    }): void;
    /**
     * Called once with the finished document and every registered route, including
     * `openapi.ignore()`d and TSF-internal routes. Throw to fail generation.
     */
    document?(document: OpenApiDocument, routes: readonly HttpRoutePlan[]): void;
}

export interface OpenApiDocument {
    openapi: '3.1.0';
    jsonSchemaDialect?: string;
    info: {
        title: string;
        version: string;
    };
    paths: Record<string, OpenApiPathItem>;
    /** Controller tags with their JSDoc descriptions. */
    tags?: Array<{ name: string; description?: string }>;
    components?: {
        schemas?: Record<string, OpenApiSchemaObject>;
        securitySchemes?: Record<string, unknown>;
    };
}

export type OpenApiPathItem = Partial<Record<OpenApiHttpMethod, OpenApiOperation>>;
export type OpenApiHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';

export interface OpenApiOperation {
    operationId: string;
    tags?: string[];
    summary?: string;
    description?: string;
    deprecated?: boolean;
    parameters?: OpenApiParameter[];
    requestBody?: OpenApiRequestBody;
    responses: Record<string, OpenApiResponse>;
    security?: Array<Record<string, string[]>>;
    [extension: `x-${string}`]: unknown;
}

export interface OpenApiParameter {
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    description?: string;
    deprecated?: boolean;
    schema: OpenApiSchemaObject | OpenApiReferenceObject;
    [extension: `x-${string}`]: unknown;
}

export interface OpenApiRequestBody {
    description?: string;
    required?: boolean;
    content: Record<string, OpenApiMediaType>;
}

export interface OpenApiMediaType {
    schema: OpenApiSchemaObject | OpenApiReferenceObject;
    examples?: Record<string, { summary?: string; value: unknown }>;
    encoding?: Record<string, { contentType?: string }>;
}

export interface OpenApiResponse {
    description: string;
    headers?: Record<string, { schema: OpenApiSchemaObject | OpenApiReferenceObject }>;
    content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiReferenceObject {
    $ref: string;
    /** Siblings of `$ref` are allowed by OpenAPI 3.1. */
    description?: string;
    deprecated?: boolean;
    [extension: `x-${string}`]: unknown;
}

export interface OpenApiDiscriminatorObject {
    propertyName: string;
    mapping?: Record<string, string>;
}

export interface OpenApiSchemaObject {
    type?: string | string[];
    format?: string;
    enum?: unknown[];
    const?: unknown;
    description?: string;
    deprecated?: boolean;
    properties?: Record<string, OpenApiSchemaObject | OpenApiReferenceObject>;
    required?: string[];
    items?: OpenApiSchemaObject | OpenApiReferenceObject;
    additionalProperties?: boolean | OpenApiSchemaObject | OpenApiReferenceObject;
    oneOf?: Array<OpenApiSchemaObject | OpenApiReferenceObject>;
    anyOf?: Array<OpenApiSchemaObject | OpenApiReferenceObject>;
    allOf?: Array<OpenApiSchemaObject | OpenApiReferenceObject>;
    discriminator?: OpenApiDiscriminatorObject;
    not?: OpenApiSchemaObject | OpenApiReferenceObject;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
    exclusiveMaximum?: number;
    [extension: `x-${string}`]: unknown;
}
