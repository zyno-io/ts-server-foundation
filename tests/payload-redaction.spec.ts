import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
    HttpRequest,
    HttpResponse,
    ScopedLogger,
    REDACTED,
    redactPayload,
    redactRequestBodyForLog,
    RedactedPayloadLogMiddleware,
    type PayloadRedactionPolicy
} from '../src';

const policy: PayloadRedactionPolicy = {
    classifyKey(key) {
        if (key === 'secret' || key.startsWith('private')) return [];
        if (key === 'details') return ['status'];
        return undefined;
    },
    classifyObject(value) {
        return value.kind === 'restricted' ? ['kind', 'id'] : undefined;
    }
};

describe('payload redaction', () => {
    it('applies caller rules to nested values and arrays without mutating the input', () => {
        const input = {
            Secret: 's',
            private_value: 7,
            details: { status: 'ok', value: 's' },
            items: [{ kind: 'restricted', id: 1, value: 's' }],
            public: 'visible'
        };
        const output = redactPayload(input, policy);
        assert.deepEqual(output, {
            Secret: REDACTED,
            private_value: REDACTED,
            details: { status: 'ok', value: REDACTED },
            items: [{ kind: 'restricted', id: 1, value: REDACTED }],
            public: 'visible'
        });
        assert.equal(input.Secret, 's');
    });

    it('keeps empty values and __proto__ keys', () => {
        const input = JSON.parse('{"__proto__":{"secret":"s"},"secret":"","details":null}');
        assert.equal(JSON.stringify(redactPayload(input, policy)), '{"__proto__":{"secret":"REDACTED"},"secret":"","details":null}');
    });

    it('redacts JSON, labelled or not, and bracketed form keys', () => {
        const raw = Buffer.from('{"secret":"s","public":1}');
        for (const contentType of ['application/json', 'text/plain', '']) {
            assert.deepEqual(JSON.parse(redactRequestBodyForLog(contentType, raw, policy).body), { secret: REDACTED, public: 1 });
        }
        const form = Buffer.from('items%5Bsecret%5D=s&public=1');
        const result = redactRequestBodyForLog('application/x-www-form-urlencoded', form, policy);
        assert.deepEqual(
            [...new URLSearchParams(result.body)],
            [
                ['items[secret]', REDACTED],
                ['public', '1']
            ]
        );
    });

    it('fails closed when policy is missing, parsing fails, or a policy throws', () => {
        const raw = Buffer.from('{"public":"s"}');
        assert.deepEqual(redactRequestBodyForLog('application/json', raw), { body: REDACTED, bodyBytes: raw.length });
        const broken: PayloadRedactionPolicy = {
            classifyKey() {
                throw new Error('failure');
            }
        };
        assert.deepEqual(redactRequestBodyForLog('application/json', raw, broken), { body: REDACTED, bodyBytes: raw.length });
        for (const [contentType, text] of [
            ['application/json', '"secret"'],
            ['application/json', '{'],
            ['application/x-www-form-urlencoded', 'Secret data=value'],
            ['text/plain', 'secret']
        ]) {
            const body = Buffer.from(text);
            assert.deepEqual(redactRequestBodyForLog(contentType, body, policy), { body: REDACTED, bodyBytes: body.length });
        }
        assert.deepEqual(redactRequestBodyForLog('application/json', Buffer.alloc(0)), { body: '' });
    });

    it('logs a policy-redacted body and pathname without consuming the controller body', async () => {
        const calls: unknown[][] = [];
        const logger = { info: (...args: unknown[]) => calls.push(args) } as unknown as ScopedLogger;
        const middleware = new RedactedPayloadLogMiddleware(logger, policy);
        const raw = '{"secret":"s","public":1}';
        const request = HttpRequest.POST('/hook?token=secret', raw, { 'content-type': 'application/json' });
        await middleware.handle(request, {} as HttpResponse);
        assert.deepEqual(calls[0][1], { method: 'POST', url: '/hook', contentType: 'application/json', body: '{"secret":"REDACTED","public":1}' });
        const reread = await request.readBodyText();
        assert.equal(reread, raw);
    });

    it('redacts the complete body without a policy and handles an unavailable stream', async () => {
        const calls: unknown[][] = [];
        const logger = { info: (...args: unknown[]) => calls.push(args) } as unknown as ScopedLogger;
        const middleware = new RedactedPayloadLogMiddleware(logger);
        const request = HttpRequest.POST('/hook', '{"public":"secret"}', { 'content-type': 'application/json' });
        await middleware.handle(request, {} as HttpResponse);
        assert.equal((calls[0][1] as Record<string, unknown>).body, REDACTED);
        const streamRequest = new HttpRequest('POST', '/hook', { 'content-type': 'multipart/form-data' }, undefined, Readable.from(['secret']));
        void streamRequest.stream;
        await middleware.handle(streamRequest, {} as HttpResponse);
        assert.deepEqual(calls[1][1], { method: 'POST', url: '/hook', contentType: 'multipart/form-data', body: REDACTED, bodyUnavailable: true });
    });
});
