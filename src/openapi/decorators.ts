import type { ClassType, ReceiveType, Type } from '../reflection';
import type { OpenApiOperation, OpenApiResponse } from './types';

/**
 * Options for `openapi.operation()`. Every field is optional and documentation-only.
 *
 * Inherited fields:
 * - `operationId`: stable operation name. Allowed on methods only, and must be unique in the document.
 * - `tags`: replaces the tag derived from the controller class name.
 * - `summary`: short title. Replaces the first paragraph of the method's JSDoc.
 * - `description`: longer text. Never derived from JSDoc.
 * - `deprecated`: marks the operation as deprecated.
 * - `security`: security requirements; each array entry is one accepted alternative. Replaces
 *   the default `[{ bearerAuth: [] }]` that a route with a required `ParsedJwt` parameter gets.
 *   On such a route every alternative must still include `bearerAuth` (extra schemes may be
 *   added alongside it), so `[]` or an alternative without `bearerAuth` fails serialization.
 *   On any other route, `[]` documents that the operation needs no authentication.
 *
 * A field set on a method replaces the same field set on its controller as a whole;
 * arrays such as `tags` and `security` are not merged.
 */
export interface OpenApiOperationOptions extends Partial<
    Pick<OpenApiOperation, 'operationId' | 'tags' | 'summary' | 'description' | 'deprecated' | 'security'>
> {
    /**
     * Security scheme definitions added to `components.securitySchemes`, keyed by the name
     * used in `security`. Declaring the same name twice with different definitions fails
     * serialization. Every name used in `security` must be defined somewhere in the document.
     */
    securitySchemes?: Record<string, unknown>;
    /**
     * Vendor extension fields copied onto the operation. Every key must start with `x-`.
     * Controller and method extensions are combined; the method wins for the same key.
     */
    extensions?: Record<`x-${string}`, unknown>;
}

/** Options for `openapi.response<T>()`. All of them only affect the generated document. */
export interface OpenApiResponseOptions {
    /** HTTP status this response is documented under. An integer from 100 to 599. */
    status: number;
    /** Response description. Defaults to the standard reason phrase for the status. */
    description?: string;
    /**
     * Content type the body is documented under, for example `text/csv`.
     * Defaults to `application/json`. Requires a body type: setting it when `T` is `void` or
     * `undefined` fails serialization.
     */
    mediaType?: string;
    /** Response headers to document, keyed by header name. */
    headers?: OpenApiResponse['headers'];
    /**
     * Named example bodies, keyed by example name. Requires a body type: setting it when `T`
     * is `void` or `undefined` fails serialization, because such a response has no documented body.
     */
    examples?: Record<string, { summary?: string; value: unknown }>;
}

export interface OpenApiResponseMetadata extends OpenApiResponseOptions {
    type: Type;
}

interface OpenApiMetadata {
    ignored: boolean;
    responses: Map<number, OpenApiResponseMetadata>;
    operation?: OpenApiOperationOptions;
}

const controllerMetadata = new WeakMap<ClassType, OpenApiMetadata>();
const methodMetadata = new WeakMap<object, Map<string | symbol, OpenApiMetadata>>();

type OpenApiDecorator = ClassDecorator & MethodDecorator;

class OpenApiDecorators {
    /**
     * Sets operation details in the generated document: a stable `operationId`, tags, summary,
     * description, deprecation, security requirements, security scheme definitions and `x-` extensions.
     *
     * On a controller it sets defaults for every route; on a method it overrides them field by field.
     * `operationId` is method-only. Each controller or method accepts one `operation()` decorator.
     *
     * Documentation-only: it does not authenticate or authorize requests at runtime.
     */
    static operation(options: OpenApiOperationOptions): OpenApiDecorator {
        if (options.operationId !== undefined && !options.operationId.trim()) throw new Error('OpenAPI operationId must not be empty');
        for (const name of Object.keys(options.extensions ?? {})) {
            if (!name.startsWith('x-')) throw new Error('OpenAPI extensions must start with x-');
        }
        const saved = structuredClone(
            Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
        ) as OpenApiOperationOptions;
        return (target: object, propertyKey?: string | symbol) => {
            if (propertyKey === undefined && saved.operationId) throw new Error('Declare operationId on a method, not a controller');
            const metadata = getMetadata(target, propertyKey);
            if (metadata.operation) throw new Error('OpenAPI operation metadata is already declared on this target');
            metadata.operation = saved;
        };
    }
    /** Excludes a controller or route from generated OpenAPI documents. */
    static ignore(): OpenApiDecorator {
        return (target: object, propertyKey?: string | symbol) => {
            getMetadata(target, propertyKey).ignored = true;
        };
    }

    /** Documents a typed response without changing the route's runtime response behavior. */
    static response<T>(options: OpenApiResponseOptions, type?: ReceiveType<T>): OpenApiDecorator {
        return createResponseDecorator(options, type);
    }

    /** Documents one typed error response for each supplied HTTP status. */
    static errors<T>(statuses: number | readonly number[], type?: ReceiveType<T>): OpenApiDecorator {
        const uniqueStatuses = [...new Set(typeof statuses === 'number' ? [statuses] : statuses)];
        if (!uniqueStatuses.length) throw new Error('OpenAPI errors() requires at least one HTTP status');
        for (const status of uniqueStatuses) assertStatus(status);
        if (uniqueStatuses.length !== (typeof statuses === 'number' ? 1 : statuses.length)) {
            throw new Error('OpenAPI errors() cannot declare the same HTTP status more than once');
        }

        return (target: object, propertyKey?: string | symbol) => {
            const metadata = getMetadata(target, propertyKey);
            for (const status of uniqueStatuses) addResponse(metadata, { status }, type);
        };
    }
}

/** OpenAPI-only controller and route decorators. */
export const openapi = OpenApiDecorators;

export function getOpenApiOperationOptions(controllerClass: ClassType, propertyKey: string | symbol): OpenApiOperationOptions[] {
    return [controllerMetadata.get(controllerClass)?.operation, methodMetadata.get(controllerClass.prototype)?.get(propertyKey)?.operation].filter(
        (value): value is OpenApiOperationOptions => value !== undefined
    );
}

export function isOpenApiIgnored(controllerClass: ClassType, propertyKey: string | symbol): boolean {
    return (
        controllerMetadata.get(controllerClass)?.ignored === true || methodMetadata.get(controllerClass.prototype)?.get(propertyKey)?.ignored === true
    );
}

/**
 * Returns controller responses followed by method responses. A method declaration
 * deliberately replaces a controller response with the same status.
 */
export function getOpenApiResponses(controllerClass: ClassType, propertyKey: string | symbol): OpenApiResponseMetadata[] {
    const responses = new Map<number, OpenApiResponseMetadata>();
    for (const response of controllerMetadata.get(controllerClass)?.responses.values() ?? []) responses.set(response.status, response);
    for (const response of methodMetadata.get(controllerClass.prototype)?.get(propertyKey)?.responses.values() ?? []) {
        responses.set(response.status, response);
    }
    return [...responses.values()];
}

function createResponseDecorator<T>(options: OpenApiResponseOptions, type?: ReceiveType<T>): OpenApiDecorator {
    assertStatus(options.status);
    return (target: object, propertyKey?: string | symbol) => {
        addResponse(getMetadata(target, propertyKey), options, type);
    };
}

function addResponse<T>(metadata: OpenApiMetadata, options: OpenApiResponseOptions, type?: ReceiveType<T>): void {
    if (!type) throw new Error('OpenAPI response type metadata is missing. Ensure the tsf metadata compiler is enabled.');
    if (metadata.responses.has(options.status)) {
        throw new Error(`OpenAPI response status ${options.status} is already declared for this target`);
    }
    metadata.responses.set(options.status, { ...options, type });
}

function assertStatus(status: number): void {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error(`OpenAPI response status must be an integer from 100 to 599; received ${status}`);
    }
}

function getMetadata(target: object, propertyKey: string | symbol | undefined): OpenApiMetadata {
    if (propertyKey === undefined) {
        const controllerClass = target as ClassType;
        let metadata = controllerMetadata.get(controllerClass);
        if (!metadata) {
            metadata = createMetadata();
            controllerMetadata.set(controllerClass, metadata);
        }
        return metadata;
    }

    let properties = methodMetadata.get(target);
    if (!properties) {
        properties = new Map();
        methodMetadata.set(target, properties);
    }
    let metadata = properties.get(propertyKey);
    if (!metadata) {
        metadata = createMetadata();
        properties.set(propertyKey, metadata);
    }
    return metadata;
}

function createMetadata(): OpenApiMetadata {
    return { ignored: false, responses: new Map() };
}
