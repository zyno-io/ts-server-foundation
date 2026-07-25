import type { ClassType, ReceiveType, Type } from '../reflection';

export interface OpenApiResponseOptions {
    status: number;
    description?: string;
}

export interface OpenApiResponseMetadata extends OpenApiResponseOptions {
    type: Type;
}

interface OpenApiMetadata {
    ignored: boolean;
    responses: Map<number, OpenApiResponseMetadata>;
}

const controllerMetadata = new WeakMap<ClassType, OpenApiMetadata>();
const methodMetadata = new WeakMap<object, Map<string | symbol, OpenApiMetadata>>();

type OpenApiDecorator = ClassDecorator & MethodDecorator;

class OpenApiDecorators {
    /** Excludes a controller or route from generated OpenAPI documents. */
    static ignore(): OpenApiDecorator {
        return (target: Function | object, propertyKey?: string | symbol) => {
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

        return (target: Function | object, propertyKey?: string | symbol) => {
            const metadata = getMetadata(target, propertyKey);
            for (const status of uniqueStatuses) addResponse(metadata, { status }, type);
        };
    }
}

/** OpenAPI-only controller and route decorators. */
export const openapi = OpenApiDecorators;

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
    return (target: Function | object, propertyKey?: string | symbol) => {
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

function getMetadata(target: Function | object, propertyKey: string | symbol | undefined): OpenApiMetadata {
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
