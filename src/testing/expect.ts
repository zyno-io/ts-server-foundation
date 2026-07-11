import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const ASYMMETRIC_MATCHER = Symbol.for('asymmetricMatcher');

export interface AsymmetricMatcher {
    [ASYMMETRIC_MATCHER]: true;
    check(value: unknown): boolean;
    toString(): string;
}

function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcher {
    return typeof value === 'object' && value !== null && ASYMMETRIC_MATCHER in value;
}

function deepMatch(actual: unknown, expected: unknown): boolean {
    if (isAsymmetricMatcher(expected)) return expected.check(actual);
    if (expected === null || expected === undefined) return actual === expected;
    if (typeof expected !== 'object') return isDeepStrictEqual(actual, expected);
    if (Array.isArray(expected)) {
        return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => deepMatch(actual[index], item));
    }
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.keys(expected as Record<string, unknown>).every(key =>
        deepMatch((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key])
    );
}

const PrimitiveTypeMap = new Map<any, string>([
    [Number, 'number'],
    [String, 'string'],
    [Boolean, 'boolean'],
    [BigInt, 'bigint'],
    [Symbol, 'symbol']
]);

export function matchesObject(actual: unknown, expected: unknown): void {
    if (!deepMatch(actual, expected)) {
        assert.fail(
            `Expected object to match:\n` + `  Expected: ${JSON.stringify(expected, null, 2)}\n` + `  Actual:   ${JSON.stringify(actual, null, 2)}`
        );
    }
}

export function anyOf(Type: new (...args: any[]) => any): AsymmetricMatcher {
    const primitiveType = PrimitiveTypeMap.get(Type);
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            return primitiveType ? typeof value === primitiveType : value instanceof Type;
        },
        toString() {
            return `any(${Type.name})`;
        }
    };
}

export function arrayContaining(expected: unknown[]): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            return Array.isArray(value) && expected.every(item => value.some(actual => deepMatch(actual, item)));
        },
        toString() {
            return `arrayContaining(${JSON.stringify(expected)})`;
        }
    };
}

export function stringContaining(expected: string): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            return typeof value === 'string' && value.includes(expected);
        },
        toString() {
            return `stringContaining(${JSON.stringify(expected)})`;
        }
    };
}

export function objectContaining(expected: Record<string, unknown>): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            return typeof value === 'object' && value !== null && deepMatch(value, expected);
        },
        toString() {
            return `objectContaining(${JSON.stringify(expected)})`;
        }
    };
}

export function anything(): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check() {
            return true;
        },
        toString() {
            return 'anything()';
        }
    };
}

export function assertCalledWith(mockFn: { mock: { calls: { arguments: unknown[] }[] } }, ...expectedArgs: unknown[]): void {
    const calls = mockFn.mock.calls;
    const match = calls.some(
        call => call.arguments.length === expectedArgs.length && expectedArgs.every((arg, index) => deepMatch(call.arguments[index], arg))
    );
    if (!match) {
        assert.fail(
            `Expected mock to have been called with:\n` +
                `  Expected: ${JSON.stringify(expectedArgs, null, 2)}\n` +
                `  Actual calls: ${JSON.stringify(
                    calls.map(call => call.arguments),
                    null,
                    2
                )}`
        );
    }
}
