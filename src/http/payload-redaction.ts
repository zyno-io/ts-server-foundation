/**
 * Redaction for known sensitive fields in carrier/vendor webhook payloads.
 *
 * Webhook payloads carry useful diagnostics (event types,
 * ids, statuses, error codes), so instead of dropping them we keep every key and replace only the values of
 * protected fields with {@link REDACTED}. Key matching is case-insensitive and ignores `_`/`-`, so
 * `phone_number`, `phoneNumber` and `PhoneNumber` are the same key.
 */
export const REDACTED = 'REDACTED';

/** Normalized key names (lowercase, no `_`/`-`) whose values are always redacted, at any depth. */
const PROTECTED_KEYS = new Set([
    // message content
    'text',
    'body',
    'message',
    'content',
    'subject',
    // media
    'media',
    'originalmediaurl',
    'previewurl',
    // phone numbers and parties
    'from',
    'to',
    'cc',
    'phonenumber',
    'phone',
    'name',
    'firstname',
    'lastname',
    'email',
    'address',
    'street',
    'shipping',
    'billing',
    'recipient',
    'callername',
    'number',
    'ani',
    'dnis',
    'remote',
    // LaML (Twilio/SignalWire) sub-state location of the parties
    'fromcity',
    'fromzip',
    'tocity',
    'tozip',
    // OIT (disabled carrier) party numbers
    'fromnum',
    'dialed',
    // Twilio Add-on results (JSON string) — tenant-enabled add-ons can return caller identity/lookup data
    'addons'
]);

/**
 * Any key starting with one of these (normalized) is redacted: `media_url`, `mediaUrl`, `MediaUrl0`..`MediaUrlN`,
 * `caller_id`, `callerIdName`, `caller_id_number`, ...
 */
const PROTECTED_KEY_PREFIXES = ['mediaurl', 'callerid'];

/**
 * Inside a protected subtree (a party object under `from`/`to`, a `media` value, ...) every leaf is redacted
 * except these non-identifying descriptors, so delivery status and media type survive. `id`/`type` are kept only
 * for media elements: JSON:API-style party references can carry the phone number itself as the resource id.
 */
const PARTY_SAFE_KEYS = new Set(['status', 'carrier', 'linetype', 'contenttype', 'mimetype', 'size', 'filesize']);
const MEDIA_SAFE_KEYS = new Set([...PARTY_SAFE_KEYS, 'id', 'type']);

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, '');
}

function isProtectedKey(normalizedKey: string): boolean {
    return PROTECTED_KEYS.has(normalizedKey) || PROTECTED_KEY_PREFIXES.some(prefix => normalizedKey.startsWith(prefix));
}

/** Form keys may use bracket paths (`message[text]`, `media[0][url]`); any protected segment protects the value. */
function isProtectedFormKey(key: string): boolean {
    return key
        .split(/[[\]]+/)
        .filter(Boolean)
        .some(segment => isProtectedKey(normalizeKey(segment)));
}

/** Defines an own key, so a `__proto__` key is kept as an ordinary key instead of hitting the prototype setter. */
function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A media element in a JSON:API-style list (Flowroute `included[]`): `{ type: 'media', attributes: { url } }`. */
function isMediaElement(value: unknown): value is Record<string, unknown> {
    return isPlainObject(value) && typeof value.type === 'string' && value.type.toLowerCase() === 'media';
}

/** Absent and empty values carry no PHI and are kept as-is so "no text"/"no caller id" stays visible. */
function isEmptyLeaf(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

/** Redacts every leaf of a protected value, keeping object/array structure and safe descriptors. */
function redactSubtree(value: unknown, safeKeys: Set<string>): unknown {
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

function safeKeysFor(normalizedKey: string): Set<string> {
    return normalizedKey.startsWith('media') ? MEDIA_SAFE_KEYS : PARTY_SAFE_KEYS;
}

/**
 * Returns a deep copy of `value` with protected field values replaced by {@link REDACTED}. Keys are never
 * removed and non-protected values are returned unchanged.
 */
export function redactPayload<T>(value: T): T {
    return redactNode(value) as T;
}

function redactNode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => (isMediaElement(item) ? redactSubtree(item, MEDIA_SAFE_KEYS) : redactNode(item)));
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            const normalizedKey = normalizeKey(key);
            setKey(out, key, isProtectedKey(normalizedKey) ? redactSubtree(child, safeKeysFor(normalizedKey)) : redactNode(child));
        }
        return out;
    }
    return value;
}

export interface IRedactedRequestBodyLog {
    body: string;
    /** Present only when the body could not be parsed and was therefore redacted wholesale. */
    bodyBytes?: number;
}

/** A decoded form key must look like a parameter name (`MediaUrl0`, `message[text]`), never free text. */
const FORM_KEY_PATTERN = /^[A-Za-z0-9_.\-[\]]{1,128}$/;

function mimeType(contentType: string): string {
    return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Produces the loggable form of a raw request body. JSON and `application/x-www-form-urlencoded` bodies are
 * parsed, redacted and re-serialized in their original format (same key order). Anything else, including a
 * body that fails to parse or a bare JSON scalar, is never logged raw: it becomes `REDACTED` plus its byte length.
 */
export function redactRequestBodyForLog(contentType: string, rawBody: Buffer): IRedactedRequestBodyLog {
    if (rawBody.length === 0) return { body: '' };
    const unparseable = { body: REDACTED, bodyBytes: rawBody.length };
    try {
        return redactParsedBody(contentType, rawBody) ?? unparseable;
    } catch {
        // Pathological input (e.g. nesting deep enough to overflow the recursion) must fail safe, not fail the webhook.
        return unparseable;
    }
}

/** Returns the redacted body, or undefined when the body cannot be safely parsed. */
function redactParsedBody(contentType: string, rawBody: Buffer): IRedactedRequestBodyLog | undefined {
    const mime = mimeType(contentType);
    const text = rawBody.toString('utf8');

    // TSF parses unlabelled/text bodies as JSON, so mislabelled vendor JSON is redacted rather than fully hidden.
    const looksLikeJson = (mime === '' || mime === 'text/plain') && /^\s*[[{]/.test(text);
    if (mime === 'application/json' || mime.endsWith('+json') || looksLikeJson) {
        const parsed: unknown = JSON.parse(text);
        // Bare values (top-level or directly inside a top-level array) have no key to judge them by.
        if (isPlainObject(parsed) || (Array.isArray(parsed) && parsed.every(isPlainObject))) {
            return { body: JSON.stringify(redactPayload(parsed)) };
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
            redacted.append(key, isProtectedFormKey(key) && !isEmptyLeaf(value) ? REDACTED : value);
        }
        return { body: redacted.toString() };
    }

    return undefined;
}
