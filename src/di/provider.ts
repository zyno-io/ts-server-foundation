import type { AbstractClassType, ClassType } from '../types';

export type Token<T = unknown> = string | symbol | number | bigint | boolean | ClassType<T> | AbstractClassType<T> | Function;
export type ProviderScope = 'singleton' | 'transient' | 'request' | 'http';

export type ClassProvider<T = unknown> = {
    provide: Token<T>;
    useClass: ClassType<T>;
    scope?: ProviderScope;
};

export type ValueProvider<T = unknown> = {
    provide: Token<T>;
    useValue: T;
};

export type ExistingProvider<T = unknown> = {
    provide: Token<T>;
    useExisting: Token<T>;
};

export type FactoryProvider<T = unknown> = {
    provide: Token<T>;
    useFactory: (...args: any[]) => T | Promise<T>;
    deps?: Token[];
    scope?: ProviderScope;
};

export type TargetFactoryProvider<T = unknown> = {
    provide: Token<T>;
    useTargetFactory: (target: ClassType | undefined, ...args: any[]) => T | Promise<T>;
    deps?: Token[];
    scope?: ProviderScope;
};

export type StructuredProvider<T = unknown> =
    | ClassProvider<T>
    | ValueProvider<T>
    | ExistingProvider<T>
    | FactoryProvider<T>
    | TargetFactoryProvider<T>;
export type Provider<T = unknown> = ClassType<T> | Function | StructuredProvider<T>;

export function isStructuredProvider(provider: Provider): provider is StructuredProvider {
    return typeof provider === 'object' && provider !== null && 'provide' in provider;
}

export function getProviderToken(provider: Provider): Token {
    return isStructuredProvider(provider) ? provider.provide : provider;
}

export function getProviderScope(provider: Provider): ProviderScope {
    if (!isStructuredProvider(provider)) return 'singleton';
    if ('useValue' in provider) return 'singleton';
    if ('useExisting' in provider) return 'transient';
    const scope = 'useTargetFactory' in provider ? (provider.scope ?? 'transient') : (provider.scope ?? 'singleton');
    return scope === 'http' ? 'request' : scope;
}
