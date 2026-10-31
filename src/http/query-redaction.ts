/**
 * Query-string redaction for request URLs written to logs and traces.
 *
 * Query parameters routinely carry search terms, phone numbers, names and one-time codes. The request logger and
 * the incoming-request span processor pass URLs through {@link redactUrlQuery} so matched parameter values are
 * replaced by {@link REDACTED_QUERY_VALUE}. Keys are kept and unmatched parameters are left byte-for-byte as sent.
 */
export const REDACTED_QUERY_VALUE = 'REDACTED';

/**
 * Default parameter names whose values are redacted. Matching ignores case and `_`, `-` and `.` separators, and
 * applies to each segment of a bracketed key (`filter[phoneNumbers][]`).
 */
export const DEFAULT_REDACTED_QUERY_KEYS: readonly string[] = [
    'q',
    'query',
    'search',
    'text',
    'phone',
    'phones',
    'phoneNumber',
    'phoneNumbers',
    'email',
    'name',
    'token',
    'code',
    'state',
    'password',
    'jwt',
    'accessToken',
    'idToken',
    'refreshToken',
    'apiKey',
    'secret',
    'signature',
    'sig'
];

export type QueryKeyMatcher = ((key: string) => boolean) & {
    /** True when the key list is empty: URLs are then returned unchanged, without decoding or failing closed. */
    readonly disabled: boolean;
};

function normalizeQueryKey(key: string): string {
    return key.toLowerCase().replace(/[_.-]/g, '');
}

/** Builds a matcher for the given parameter names (defaults to {@link DEFAULT_REDACTED_QUERY_KEYS}). */
export function createQueryKeyMatcher(keys: readonly string[] = DEFAULT_REDACTED_QUERY_KEYS): QueryKeyMatcher {
    const normalized = new Set(keys.map(normalizeQueryKey));
    const matches = (key: string) =>
        key
            .split(/[[\]]+/)
            .filter(Boolean)
            .some(segment => normalized.has(normalizeQueryKey(segment)));
    return Object.assign(matches, { disabled: normalized.size === 0 });
}

function decodeQueryComponent(value: string): string {
    return decodeURIComponent(value.replace(/\+/g, ' '));
}

/**
 * Redacts matched values in a raw query string (without the leading `?`). Throws if a key cannot be decoded;
 * callers fail closed.
 */
function redactQueryString(query: string, matches: QueryKeyMatcher): string {
    return query
        .split('&')
        .map(pair => {
            if (pair === '') return pair;
            const separator = pair.indexOf('=');
            const rawKey = separator === -1 ? pair : pair.slice(0, separator);
            if (!matches(decodeQueryComponent(rawKey))) return pair;
            return separator === -1 ? pair : `${rawKey}=${REDACTED_QUERY_VALUE}`;
        })
        .join('&');
}

/**
 * Returns `url` (absolute or origin-relative) with matched query values replaced and any fragment replaced by
 * `#REDACTED` (fragments are never sent by browsers, so one in a request target is unusual and may carry
 * credentials). If the query cannot be parsed it fails closed to the path followed by `?REDACTED`. A disabled
 * matcher (empty key list) returns `url` unchanged.
 */
export function redactUrlQuery(url: string, matches: QueryKeyMatcher): string {
    if (matches.disabled) return url;
    const hashStart = url.indexOf('#');
    const withoutFragment = hashStart === -1 ? url : url.slice(0, hashStart);
    const fragment = hashStart === -1 ? '' : `#${REDACTED_QUERY_VALUE}`;
    const queryStart = withoutFragment.indexOf('?');
    if (queryStart === -1) return `${withoutFragment}${fragment}`;
    const base = withoutFragment.slice(0, queryStart);
    try {
        return `${base}?${redactQueryString(withoutFragment.slice(queryStart + 1), matches)}${fragment}`;
    } catch {
        return `${base}?${REDACTED_QUERY_VALUE}`;
    }
}

/** Redacts a bare query string (no leading `?`), failing closed to `REDACTED`; unchanged when disabled. */
export function redactQuery(query: string, matches: QueryKeyMatcher): string {
    if (matches.disabled) return query;
    try {
        return redactQueryString(query, matches);
    } catch {
        return REDACTED_QUERY_VALUE;
    }
}
