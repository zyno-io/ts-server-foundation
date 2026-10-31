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
    'password'
];

export type QueryKeyMatcher = (key: string) => boolean;

function normalizeQueryKey(key: string): string {
    return key.toLowerCase().replace(/[_.-]/g, '');
}

/** Builds a matcher for the given parameter names (defaults to {@link DEFAULT_REDACTED_QUERY_KEYS}). */
export function createQueryKeyMatcher(keys: readonly string[] = DEFAULT_REDACTED_QUERY_KEYS): QueryKeyMatcher {
    const normalized = new Set(keys.map(normalizeQueryKey));
    return key =>
        normalized.size > 0 &&
        key
            .split(/[[\]]+/)
            .filter(Boolean)
            .some(segment => normalized.has(normalizeQueryKey(segment)));
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
 * Returns `url` (absolute or origin-relative) with matched query values replaced. If the query cannot be parsed
 * it fails closed to the path followed by `?REDACTED`.
 */
export function redactUrlQuery(url: string, matches: QueryKeyMatcher): string {
    const queryStart = url.indexOf('?');
    if (queryStart === -1) return url;
    const hashStart = url.indexOf('#', queryStart);
    const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
    const suffix = hashStart === -1 ? '' : url.slice(hashStart);
    const base = url.slice(0, queryStart);
    try {
        return `${base}?${redactQueryString(query, matches)}${suffix}`;
    } catch {
        return `${base}?${REDACTED_QUERY_VALUE}`;
    }
}

/** Redacts a bare query string (no leading `?`), failing closed to `REDACTED`. */
export function redactQuery(query: string, matches: QueryKeyMatcher): string {
    try {
        return redactQueryString(query, matches);
    } catch {
        return REDACTED_QUERY_VALUE;
    }
}
