import { SpanKind, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';

import {
    createQueryKeyMatcher,
    REDACTED_QUERY_VALUE,
    redactQuery,
    redactUrlQuery,
    type QueryKeyMatcher,
    type RedactQueryKeys
} from '../../http/query-redaction';

/** Incoming-request span attributes that carry the request URL or its query string. */
const URL_ATTRIBUTES = ['http.url', 'http.target', 'url.full'] as const;
const QUERY_ATTRIBUTE = 'url.query';

/**
 * Rewrites the query string in incoming HTTP server span attributes before any exporter sees the span, using the
 * same parameter rules as request logging. It must run ahead of exporting processors; TSF installs it first.
 */
export class IncomingHttpQueryRedactionSpanProcessor implements SpanProcessor {
    private readonly matches: QueryKeyMatcher;

    constructor(redactQueryKeys?: RedactQueryKeys) {
        this.matches = createQueryKeyMatcher(redactQueryKeys);
    }

    onStart(_span: Span, _parentContext: Context): void {}

    onEnd(span: ReadableSpan): void {
        if (span.kind !== SpanKind.SERVER) return;
        // ReadableSpan exposes the live attribute map; rewriting it here changes what later processors export.
        const attributes = span.attributes as Record<string, unknown>;
        for (const key of URL_ATTRIBUTES) {
            const value = attributes[key];
            if (typeof value === 'string') attributes[key] = this.redactUrl(value);
        }
        const query = attributes[QUERY_ATTRIBUTE];
        if (typeof query === 'string') attributes[QUERY_ATTRIBUTE] = redactQuery(query, this.matches);
    }

    private redactUrl(value: string): string {
        try {
            return redactUrlQuery(value, this.matches);
        } catch {
            const queryStart = value.indexOf('?');
            return queryStart === -1 ? value : `${value.slice(0, queryStart)}?${REDACTED_QUERY_VALUE}`;
        }
    }

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
