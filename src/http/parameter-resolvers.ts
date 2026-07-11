import type { RouteParameterResolverFunction } from './decorators';
import { getOrCacheValue } from './store';

export function createCachingParameterResolver<T>(
    key: object | string | symbol,
    resolver: RouteParameterResolverFunction<T>
): RouteParameterResolverFunction<T> {
    return context => getOrCacheValue(context.request, key, () => resolver(context));
}
