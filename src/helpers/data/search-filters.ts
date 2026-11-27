import { parseSearchFilters } from '@zyno-io/ts-utils';

import { HttpUserError } from '../../http/errors';
import type { ReceiveType } from '../../reflection';
import { ValidationError } from '../../reflection';
import { assert } from '../../types';

/**
 * Parses `key:value` filters out of a search string and validates them against `T` at runtime.
 * Invalid values throw an `HttpUserError`.
 */
export function extractSearchFilters<T extends Record<string, string>>(
    input?: string,
    filtersType?: ReceiveType<T>
): { text?: string; filters?: Partial<T> } {
    if (!input) return {};

    const { filters, text } = parseSearchFilters(input);
    const result = filters as Partial<T>;

    try {
        assert<T>(result, undefined, filtersType);
    } catch (e) {
        if (e instanceof ValidationError) {
            const firstError = e.errors[0];
            throw new HttpUserError(`"${result[firstError.path as keyof T]}" is not valid for "${firstError.path}"`);
        }
        throw e;
    }

    return {
        text: text || undefined,
        filters: Object.keys(result).length ? result : undefined
    };
}
