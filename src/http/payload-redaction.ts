/** Replacement used for redacted values. */
export const REDACTED = 'REDACTED';

/**
 * Return safe leaf keys for a protected subtree, or undefined when the field is not protected.
 * Keys passed to `classifyKey` and returned as safe keys are normalized to lowercase with `_` and `-` removed.
 * An empty array protects all leaves. The optional object rule supports schema-specific array elements.
 */
export interface PayloadRedactionPolicy {
    classifyKey(key: string): readonly string[] | undefined;
    classifyObject?(value: Record<string, unknown>): readonly string[] | undefined;
}

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, '');
}

/** Any protected segment of a bracketed form key protects its value. */
function isProtectedFormKey(key: string, policy: PayloadRedactionPolicy): boolean {
    return key
        .split(/[[\]]+/)
        .filter(Boolean)
        .some(segment => policy.classifyKey(normalizeKey(segment)) !== undefined);
}

/** Defines an own key, so a `__proto__` key is kept as an ordinary key instead of hitting the prototype setter. */
function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent and empty values are kept as-is. */
function isEmptyLeaf(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

/** Redacts every leaf of a protected value, keeping object/array structure and safe descriptors. */
function redactSubtree(value: unknown, safeKeys: ReadonlySet<string>): unknown {
    if (isEmptyLeaf(value)) return value;
    if (Array.isArray(value)) return value.map(item => redactSubtree(item, safeKeys));
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            const keepAsIs = safeKeys.has(normalizeKey(key)) && !isPlainObject(child) && !Array.isArray(child);
            setKey(out, key, keepAsIs ? child : redactSubtree(child, safeKeys));
        }
        return out;
    }
    return REDACTED;
}

/** Returns a deep copy with values selected by the policy redacted. */
export function redactPayload<T>(value: T, policy: PayloadRedactionPolicy): T {
    return redactNode(value, policy) as T;
}

function redactNode(value: unknown, policy: PayloadRedactionPolicy): unknown {
    if (Array.isArray(value))
        return value.map(item => {
            const safe = isPlainObject(item) ? policy.classifyObject?.(item) : undefined;
            return safe === undefined ? redactNode(item, policy) : redactSubtree(item, new Set(safe.map(normalizeKey)));
        });
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            const safe = policy.classifyKey(normalizeKey(key));
            setKey(out, key, safe === undefined ? redactNode(child, policy) : redactSubtree(child, new Set(safe.map(normalizeKey))));
        }
        return out;
    }
    return value;
}

export interface IRedactedRequestBodyLog {
    body: string;
    /** Present when the body was redacted wholesale. */
    bodyBytes?: number;
}

/** A decoded form key must look like a parameter name (`itemId`, `data[secret]`), never free text. */
const FORM_KEY_PATTERN = /^[A-Za-z0-9_.\-[\]]{1,128}$/;

function mimeType(contentType: string): string {
    return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Produces the loggable form of a raw request body. JSON and `application/x-www-form-urlencoded` bodies are
 * parsed, redacted and re-serialized in their original format (same key order). Anything else, including a
 * body that fails to parse or a bare JSON scalar, is never logged raw: it becomes `REDACTED` plus its byte length.
 */
export function redactRequestBodyForLog(contentType: string, rawBody: Buffer, policy?: PayloadRedactionPolicy): IRedactedRequestBodyLog {
    if (rawBody.length === 0) return { body: '' };
    const unparseable = { body: REDACTED, bodyBytes: rawBody.length };
    if (!policy) return unparseable;
    try {
        return redactParsedBody(contentType, rawBody, policy) ?? unparseable;
    } catch {
        // Pathological input (e.g. nesting deep enough to overflow the recursion) must fail safe, not fail the request.
        return unparseable;
    }
}

/** Returns the redacted body, or undefined when the body cannot be safely parsed. */
function redactParsedBody(contentType: string, rawBody: Buffer, policy: PayloadRedactionPolicy): IRedactedRequestBodyLog | undefined {
    const mime = mimeType(contentType);
    const text = rawBody.toString('utf8');

    // TSF parses unlabelled/text bodies as JSON, so mislabelled JSON is redacted rather than fully hidden.
    const looksLikeJson = (mime === '' || mime === 'text/plain') && /^\s*[[{]/.test(text);
    if (mime === 'application/json' || mime.endsWith('+json') || looksLikeJson) {
        const parsed: unknown = JSON.parse(text);
        // Bare values (top-level or directly inside a top-level array) have no key to judge them by.
        if (isPlainObject(parsed) || (Array.isArray(parsed) && parsed.every(isPlainObject))) {
            return { body: JSON.stringify(redactPayload(parsed, policy)) };
        }
        return undefined;
    }

    if (mime === 'application/x-www-form-urlencoded') {
        // Free text posted with a form content type would otherwise survive in key position, so only bodies
        // whose every pair is `identifier=value` (and that carry at least one value) are treated as a form.
        if (text.split('&').some(pair => pair !== '' && !pair.includes('='))) return undefined;
        const pairs = [...new URLSearchParams(text)];
        if (!pairs.every(([key]) => FORM_KEY_PATTERN.test(key)) || !pairs.some(([, value]) => value !== '')) return undefined;
        const redacted = new URLSearchParams();
        for (const [key, value] of pairs) {
            redacted.append(key, isProtectedFormKey(key, policy) && !isEmptyLeaf(value) ? REDACTED : value);
        }
        return { body: redacted.toString() };
    }

    return undefined;
}
