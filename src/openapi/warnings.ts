import { ReflectionKind, type Type } from '../reflection';

import type { BaseAppConfig } from '../app/config';
import { Env } from '../env';
import { isHttpGroupParameter, type HttpRoutePlan } from '../http';
import { getOpenApiResponses, isOpenApiIgnored } from './decorators';
import { isInternalOpenApiRoute, taggedParameterDoc } from './serializer';
import type { OpenApiSerializableApp } from './types';

const GROUP_PARAMETER_NOTE = 'group parameters (HttpBody, HttpQueries)';

/**
 * Lists documentation problems in the app's routes, one message per problem:
 * - a handler without a declared return type (missing, `any` or `unknown`) and no `openapi.response()`;
 * - a `@param` tag or inline JSDoc on a group parameter (`HttpBody`, `HttpQueries`), which is ignored;
 * - a `@param` tag that names no parameter of the handler.
 *
 * TSF infrastructure routes and `openapi.ignore()`d routes are skipped. Logged in development at
 * startup and printed by `openapi:generate`.
 */
export function collectOpenApiRouteWarnings(app: Pick<OpenApiSerializableApp, 'router'>): string[] {
    const warnings: string[] = [];
    for (const route of app.router.listRoutes()) {
        if (isInternalOpenApiRoute(route.path) || isOpenApiIgnored(route.controllerClass, route.propertyKey)) continue;
        const location = `${route.method} ${route.path} (${route.controllerClass.name} -> ${route.methodName})`;

        if (!hasDeclaredReturnType(route.returnType) && !getOpenApiResponses(route.controllerClass, route.propertyKey).length) {
            warnings.push(`No return type declared for ${location}`);
        }

        for (const parameter of route.parameters) {
            if (!isHttpGroupParameter(parameter)) continue;
            const name = parameter.sourceName ?? parameter.name;
            if (taggedParameterDoc(route, parameter.sourceName, parameter.name) !== undefined) {
                warnings.push(
                    `@param ${name} on ${location} is ignored: ${GROUP_PARAMETER_NOTE} take no description; document the type's members instead`
                );
            }
            if (parameter.docs) {
                warnings.push(
                    `JSDoc on parameter ${name} on ${location} is ignored: ${GROUP_PARAMETER_NOTE} take no docs; document the type's members instead`
                );
            }
        }

        for (const name of Object.keys(route.docs?.params ?? {})) {
            if (!matchesParameter(route, name)) warnings.push(`@param ${name} on ${location} matches no parameter`);
        }
    }
    return warnings;
}

/** Route warnings are logged at startup in development, outside the test runner. */
export function shouldLogOpenApiRouteWarnings(config: Pick<BaseAppConfig, 'APP_ENV'>): boolean {
    return config.APP_ENV === 'development' && Env.NODE_TEST_CONTEXT === undefined;
}

/** A handler without a return type annotation reflects as `unknown`. */
function hasDeclaredReturnType(type: Type | undefined): boolean {
    if (!type) return false;
    const inner = type.kind === ReflectionKind.promise ? type.type : type;
    // A named alias such as AnyResponse or `type Json = unknown` is a deliberate declaration.
    if (hasTypeName(type) || hasTypeName(inner)) return true;
    return inner.kind !== ReflectionKind.any && inner.kind !== ReflectionKind.unknown;
}

function hasTypeName(type: Type): boolean {
    return !!(type as Type & { typeName?: string }).typeName;
}

function matchesParameter(route: HttpRoutePlan, name: string): boolean {
    if (route.paramNames.includes(name)) return true;
    return route.parameters.some(parameter => parameter.sourceName === name || ('name' in parameter && parameter.name === name));
}
