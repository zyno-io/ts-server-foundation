/**
 * Request header access.
 *
 * Header names are normalized to lowercase and their values collapsed to a
 * single string when the header store is built (see `normalizeHeaders` in
 * `./request`), so every lookup here resolves the canonical lowercase name and
 * never has to deal with a multi-value header.
 */

export interface HttpHeaderCarrier {
    readonly headers: Record<string, string>;
}

export function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
    return headers[name.toLowerCase()];
}

export function getRequestHeader(request: HttpHeaderCarrier, name: string): string | undefined {
    return getHeaderValue(request.headers, name);
}

/**
 * Resolves a header for a route parameter, whose declared name may be
 * camelCase: `userAgent` matches `useragent`, then `user-agent`, then
 * `x-user-agent`.
 */
export function getRequestHeaderForParameter(request: HttpHeaderCarrier, name: string): string | undefined {
    const kebab = name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`).replace(/^-/, '');
    return request.headers[name.toLowerCase()] ?? request.headers[kebab] ?? request.headers[`x-${kebab}`];
}
