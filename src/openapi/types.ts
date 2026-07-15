import type { HttpRouter } from '../http';
import type { BaseAppConfig } from '../app';
import type { TypeAnnotation } from '../reflection';

export type ApiName<T extends string> = TypeAnnotation<'openapi:name', T>;
export type ApiType<Name extends string, T> = T & ApiName<Name>;
export type ApiResponse<T, Status extends number = 200> = Promise<T>;

export interface OpenApiSerializableApp {
    readonly router: HttpRouter;
    readonly config: BaseAppConfig;
}

export interface OpenApiDocument {
    openapi: '3.1.0';
    jsonSchemaDialect?: string;
    info: {
        title: string;
        version: string;
    };
    paths: Record<string, OpenApiPathItem>;
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
    parameters?: OpenApiParameter[];
    requestBody?: OpenApiRequestBody;
    responses: Record<string, OpenApiResponse>;
    security?: Array<Record<string, string[]>>;
}

export interface OpenApiParameter {
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    description?: string;
    schema: OpenApiSchemaObject | OpenApiReferenceObject;
}

export interface OpenApiRequestBody {
    required?: boolean;
    content: Record<string, OpenApiMediaType>;
}

export interface OpenApiMediaType {
    schema: OpenApiSchemaObject | OpenApiReferenceObject;
    encoding?: Record<string, { contentType?: string }>;
}

export interface OpenApiResponse {
    description: string;
    headers?: Record<string, { schema: OpenApiSchemaObject | OpenApiReferenceObject }>;
    content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiReferenceObject {
    $ref: string;
}

export interface OpenApiSchemaObject {
    type?: string | string[];
    format?: string;
    enum?: unknown[];
    const?: unknown;
    description?: string;
    properties?: Record<string, OpenApiSchemaObject | OpenApiReferenceObject>;
    required?: string[];
    items?: OpenApiSchemaObject | OpenApiReferenceObject;
    additionalProperties?: boolean | OpenApiSchemaObject | OpenApiReferenceObject;
    oneOf?: Array<OpenApiSchemaObject | OpenApiReferenceObject>;
    anyOf?: Array<OpenApiSchemaObject | OpenApiReferenceObject>;
    allOf?: Array<OpenApiSchemaObject | OpenApiReferenceObject>;
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
