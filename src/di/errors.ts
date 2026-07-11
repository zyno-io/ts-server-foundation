import { getClassName } from '../types';
import type { Token } from './provider';

export class ProviderNotFoundError extends Error {
    constructor(token: Token, chain: Token[] = []) {
        const dependencyChain = [...chain, token].map(formatToken).join(' -> ');
        super(`No provider found for ${formatToken(token)}${dependencyChain ? ` (dependency chain: ${dependencyChain})` : ''}`);
        this.name = 'ProviderNotFoundError';
    }
}

export class DuplicateProviderError extends Error {
    constructor(token: Token, scope: string) {
        super(`Duplicate provider for ${formatToken(token)} in ${scope}`);
        this.name = 'DuplicateProviderError';
    }
}

export class CyclicDependencyError extends Error {
    constructor(chain: Token[]) {
        super(`Cyclic dependency detected: ${chain.map(formatToken).join(' -> ')}`);
        this.name = 'CyclicDependencyError';
    }
}

export class RequestScopeError extends Error {
    constructor(token: Token) {
        super(`Cannot resolve request-scoped provider ${formatToken(token)} without a request context`);
        this.name = 'RequestScopeError';
    }
}

export class ScopeMismatchError extends Error {
    constructor(token: Token, chain: Token[]) {
        super(`Cannot inject request-scoped provider ${formatToken(token)} into singleton dependency chain: ${chain.map(formatToken).join(' -> ')}`);
        this.name = 'ScopeMismatchError';
    }
}

export function formatToken(token: Token): string {
    if (typeof token === 'symbol') return token.toString();
    if (typeof token === 'function') return getClassName(token);
    if (typeof token === 'bigint') return token.toString();
    return JSON.stringify(token);
}
