/** A fresh `key:value` / `key:"quoted value"` matcher. Never shared: a `/g` regex keeps `lastIndex` state between callers. */
function filterPattern(): RegExp {
    // Group 1: key (never contains a colon, quote or whitespace). Group 2: quoted value body. Group 3: bare value.
    // The lookbehind lets a key start only where a run of key characters starts. Without it, a long word with no
    // colon is retried from every position, which is quadratic (a 16k-character word took about a second).
    return /(?<![^\s:"])([^\s:"]+):(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
}

export type SearchFilterValues = Record<string, string | null | undefined>;

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function unescapeQuoted(value: string): string {
    return value.replace(/\\(["\\])/g, '$1');
}

function quoteIfNeeded(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value;
}

/**
 * Splits a search string into `key:value` filters and the remaining free text.
 *
 * A value is either a double-quoted string (may contain spaces, colons and `\"` / `\\` escapes) or a run of
 * non-whitespace. Duplicate keys: the last one wins. Each filter is replaced by a space in `text`, so the words
 * on either side stay separate (`smith after:x jones` -> `smith jones`). `text` is `undefined` when empty.
 */
export function parseSearchFilters(input?: string): { filters: Record<string, string>; text: string | undefined } {
    const filters: Record<string, string> = {};
    if (!input) return { filters, text: undefined };
    for (const [, key, quoted, bare] of input.matchAll(filterPattern())) {
        // defineProperty keeps a `__proto__` key as plain data instead of invoking the prototype setter.
        Object.defineProperty(filters, key, {
            // A bare value loses a stray leading or trailing quote (an unterminated `after:"2026-03-10`), as the
            // previous parsers did. Compose always quotes a value containing `"`, so round-trips are unaffected.
            value: quoted !== undefined ? unescapeQuoted(quoted) : bare.replace(/^"|"$/g, ''),
            enumerable: true,
            writable: true,
            configurable: true
        });
    }
    return { filters, text: collapse(input.replace(filterPattern(), ' ')) || undefined };
}

/** The free text of `input` with every `key:value` filter removed, or `''`. */
export function removeSearchFilters(input: string): string {
    return parseSearchFilters(input).text ?? '';
}

/** Builds `key:value` tokens (insertion order), skipping null, undefined and empty values and quoting where needed. */
export function composeSearchFilters(values: SearchFilterValues): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined || value === '') continue;
        parts.push(`${key}:${quoteIfNeeded(value)}`);
    }
    return parts.join(' ');
}

/** Replaces all filters in `input` with `values`, keeping the free text first and appending the new filters. */
export function replaceSearchFilters(input: string, values: SearchFilterValues): string {
    return `${removeSearchFilters(input)} ${composeSearchFilters(values)}`.trim();
}
