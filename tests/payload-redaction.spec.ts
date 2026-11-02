import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { HttpRequest, HttpResponse, ScopedLogger, REDACTED, redactPayload, redactRequestBodyForLog, RedactedPayloadLogMiddleware } from '../src';

const PATIENT = '+15555550123';
const DID = '+15555550199';

/** Asserts both values have identical object/array structure and key order (values may differ). */
function assertSameKeys(actual: unknown, expected: unknown, path = '$'): void {
    if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), `${path} should be an array`);
        assert.equal(actual.length, expected.length, `${path} length`);
        expected.forEach((item, i) => assertSameKeys(actual[i], item, `${path}[${i}]`));
        return;
    }
    if (typeof expected === 'object' && expected !== null) {
        assert.ok(typeof actual === 'object' && actual !== null && !Array.isArray(actual), `${path} should be an object`);
        assert.deepEqual(Object.keys(actual as object), Object.keys(expected), `${path} keys`);
        for (const [key, value] of Object.entries(expected)) assertSameKeys((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
}

/** Asserts the serialized output contains no trace of any of the given sensitive strings. */
function assertNoLeak(output: unknown, secrets: string[]): void {
    const serialized = typeof output === 'string' ? output : JSON.stringify(output);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), `output leaked ${secret}`);
}

function formBody(fields: [string, string][]): string {
    return new URLSearchParams(fields).toString();
}

describe('payloadRedaction.helper', () => {
    it('redacts a Telnyx message.received payload, keeping keys and diagnostics', () => {
        const payload = {
            data: {
                event_type: 'message.received',
                id: 'evt-1',
                occurred_at: '2026-10-31T12:00:00.000Z',
                record_type: 'event',
                payload: {
                    id: 'msg-1',
                    record_type: 'message',
                    direction: 'inbound',
                    messaging_profile_id: 'mp-1',
                    organization_id: 'org-1',
                    cost: { amount: '0.0079', currency: 'USD' },
                    received_at: '2026-10-31T12:00:00.000Z',
                    from: { phone_number: PATIENT, carrier: 'T-Mobile USA', line_type: 'Wireless' },
                    to: [{ phone_number: DID, status: 'webhook_delivered', carrier: 'Telnyx', line_type: 'VoIP' }],
                    cc: ['+15555550142'],
                    media: [{ url: 'https://media.example/secret.jpg', content_type: 'image/jpeg', sha256: 'abc123', size: 1024 }],
                    text: 'My test results came back positive',
                    subject: 'Lab results',
                    type: 'MMS',
                    encoding: 'GSM-7',
                    parts: 1,
                    errors: []
                }
            },
            meta: { attempt: 1, delivered_to: 'https://api.example/public/sms/inbound/telnyx' }
        };

        const out = redactPayload(payload);
        assertSameKeys(out, payload);
        const p = out.data.payload;
        assert.equal(p.text, REDACTED);
        assert.equal(p.subject, REDACTED);
        assert.deepEqual(p.from, { phone_number: REDACTED, carrier: 'T-Mobile USA', line_type: 'Wireless' });
        assert.deepEqual(p.to, [{ phone_number: REDACTED, status: 'webhook_delivered', carrier: 'Telnyx', line_type: 'VoIP' }]);
        assert.deepEqual(p.cc, [REDACTED]);
        assert.deepEqual(p.media, [{ url: REDACTED, content_type: 'image/jpeg', sha256: REDACTED, size: 1024 }]);
        // Non-protected fields are unchanged.
        assert.deepEqual(out.data.event_type, 'message.received');
        assert.equal(p.id, 'msg-1');
        assert.equal(p.direction, 'inbound');
        assert.equal(p.messaging_profile_id, 'mp-1');
        assert.deepEqual(p.cost, payload.data.payload.cost);
        assert.equal(p.received_at, payload.data.payload.received_at);
        assert.equal(p.type, 'MMS');
        assert.equal(p.encoding, 'GSM-7');
        assert.equal(p.parts, 1);
        assert.deepEqual(out.meta, payload.meta);
        assertNoLeak(out, [PATIENT, DID, '+15555550142', 'positive', 'Lab results', 'secret.jpg']);
        // The input is not mutated.
        assert.equal(payload.data.payload.text, 'My test results came back positive');
    });

    it('redacts a Telnyx message.finalized delivery receipt, keeping statuses and error codes', () => {
        const payload = {
            data: {
                event_type: 'message.finalized',
                id: 'evt-2',
                occurred_at: '2026-10-31T12:00:05.000Z',
                payload: {
                    id: 'msg-2',
                    direction: 'outbound',
                    completed_at: '2026-10-31T12:00:05.000Z',
                    cost: { amount: '0.0040', currency: 'USD' },
                    errors: [{ code: '40300', title: 'Blocked as spam', detail: null }],
                    from: { phone_number: DID, carrier: 'Telnyx', line_type: 'VoIP' },
                    to: [
                        { phone_number: PATIENT, carrier: 'Verizon', line_type: 'Wireless', status: 'delivery_failed' },
                        { phone_number: '+15555550143', carrier: 'AT&T', line_type: 'Wireless', status: 'delivered' }
                    ],
                    text: 'Your appointment is tomorrow at 9am',
                    media: [{ url: 'https://media.example/outbound.png', content_type: 'image/png', size: 2048 }],
                    parts: 2,
                    encoding: 'UCS-2'
                }
            }
        };

        const out = redactPayload(payload);
        assertSameKeys(out, payload);
        const p = out.data.payload;
        assert.equal(p.text, REDACTED);
        assert.deepEqual(p.from, { phone_number: REDACTED, carrier: 'Telnyx', line_type: 'VoIP' });
        assert.deepEqual(
            p.to.map(t => [t.phone_number, t.status, t.carrier]),
            [
                [REDACTED, 'delivery_failed', 'Verizon'],
                [REDACTED, 'delivered', 'AT&T']
            ]
        );
        assert.deepEqual(p.media, [{ url: REDACTED, content_type: 'image/png', size: 2048 }]);
        assert.deepEqual(p.errors, payload.data.payload.errors);
        assert.equal(p.parts, 2);
        assert.equal(p.completed_at, payload.data.payload.completed_at);
        assertNoLeak(out, [PATIENT, DID, '+15555550143', 'appointment', 'outbound.png']);
    });

    it('redacts a Twilio inbound form-urlencoded body, keeping key order and non-PHI params', () => {
        const fields: [string, string][] = [
            ['ToCountry', 'US'],
            ['ToState', 'NY'],
            ['SmsMessageSid', 'SM123'],
            ['NumMedia', '1'],
            ['ToCity', 'BROOKLYN'],
            ['FromZip', '10001'],
            ['SmsSid', 'SM123'],
            ['FromState', 'NY'],
            ['SmsStatus', 'received'],
            ['FromCity', 'NEW YORK'],
            ['Body', 'Please refill my prescription'],
            ['FromCountry', 'US'],
            ['To', DID],
            ['MessagingServiceSid', 'MG123'],
            ['ToZip', '11201'],
            ['NumSegments', '1'],
            ['MessageSid', 'SM123'],
            ['AccountSid', 'AC123'],
            ['From', PATIENT],
            ['MediaUrl0', 'https://api.twilio.example/Media/ME1'],
            ['MediaContentType0', 'image/jpeg'],
            ['ApiVersion', '2010-04-01']
        ];
        const { body, bodyBytes } = redactRequestBodyForLog('application/x-www-form-urlencoded', Buffer.from(formBody(fields)));
        assert.equal(bodyBytes, undefined);

        const parsed = [...new URLSearchParams(body)];
        assert.deepEqual(
            parsed.map(([k]) => k),
            fields.map(([k]) => k)
        );
        const protectedKeys = new Set(['Body', 'To', 'From', 'MediaUrl0', 'FromCity', 'FromZip', 'ToCity', 'ToZip']);
        for (const [i, [key, value]] of parsed.entries()) {
            assert.equal(value, protectedKeys.has(key) ? REDACTED : fields[i][1], key);
        }
        assertNoLeak(body, [PATIENT, DID, 'prescription', 'Media/ME1', 'BROOKLYN', '10001', '11201']);
    });

    it('redacts a SignalWire DLR form body and multiple MediaUrlN keys', () => {
        const fields: [string, string][] = [
            ['MessageSid', 'SW1'],
            ['MessageStatus', 'undelivered'],
            ['ErrorCode', '30003'],
            ['To', PATIENT],
            ['From', DID],
            ['Body', 'Reminder'],
            ['NumMedia', '2'],
            ['MediaUrl0', 'https://sw.example/m0'],
            ['MediaUrl1', 'https://sw.example/m1'],
            ['MediaContentType1', 'image/png'],
            ['AccountSid', 'proj-1']
        ];
        const { body } = redactRequestBodyForLog('application/x-www-form-urlencoded; charset=utf-8', Buffer.from(formBody(fields)));
        const out = Object.fromEntries(new URLSearchParams(body));
        assert.deepEqual(out, {
            MessageSid: 'SW1',
            MessageStatus: 'undelivered',
            ErrorCode: '30003',
            To: REDACTED,
            From: REDACTED,
            Body: REDACTED,
            NumMedia: '2',
            MediaUrl0: REDACTED,
            MediaUrl1: REDACTED,
            MediaContentType1: 'image/png',
            AccountSid: 'proj-1'
        });
    });

    it('redacts a Flowroute inbound JSON:API payload including media in included[]', () => {
        const payload = {
            data: {
                attributes: {
                    amount_display: '$0.0095',
                    amount_nanodollars: 9_500_000,
                    body: 'Photo of my rash',
                    direction: 'inbound',
                    from: '15555550123',
                    is_mms: true,
                    message_encoding: 0,
                    message_type: 'longcode',
                    status: '',
                    timestamp: '2026-10-31T12:00:00.000Z',
                    to: '15555550199'
                },
                id: 'mdr2-1',
                type: 'message'
            },
            included: [
                {
                    attributes: { file_name: 'rash.jpg', file_size: 4096, mime_type: 'image/jpeg', url: 'https://flowroute.example/media/1' },
                    id: 'mdr2-1-media-1',
                    links: { self: '/v2.2/media/mdr2-1-media-1' },
                    type: 'media'
                }
            ]
        };

        const out = redactPayload(payload);
        assertSameKeys(out, payload);
        const a = out.data.attributes;
        assert.equal(a.body, REDACTED);
        assert.equal(a.from, REDACTED);
        assert.equal(a.to, REDACTED);
        assert.equal(a.is_mms, true);
        assert.equal(a.message_encoding, 0);
        assert.equal(a.status, '');
        assert.equal(a.timestamp, payload.data.attributes.timestamp);
        assert.equal(out.data.id, 'mdr2-1');
        assert.deepEqual(out.included, [
            {
                attributes: { file_name: REDACTED, file_size: 4096, mime_type: 'image/jpeg', url: REDACTED },
                id: 'mdr2-1-media-1',
                links: { self: REDACTED },
                type: 'media'
            }
        ]);
        assertNoLeak(out, ['15555550123', '15555550199', 'rash']);
    });

    it('redacts order shipping and billing details', () => {
        const payload = {
            order: { orderNumber: 42, shipping: { name: 'Jane', address: '123 Main', status: 'shipped' }, billing: { email: 'jane@example.com' } }
        };
        assert.deepEqual(redactPayload(payload), {
            order: { orderNumber: 42, shipping: { name: REDACTED, address: REDACTED, status: 'shipped' }, billing: { email: REDACTED } }
        });
    });

    it('redacts an OIT inbound payload (keyed record of messages)', () => {
        const payload = {
            '0': {
                status: '',
                id: 'oit-1',
                session_id: 'sess-1',
                type: 'sms',
                dialed: '15555550199',
                from_num: '15555550123',
                text: 'Cancel my visit'
            }
        };
        const out = redactPayload(payload);
        assertSameKeys(out, payload);
        assert.deepEqual(out['0'], {
            status: '',
            id: 'oit-1',
            session_id: 'sess-1',
            type: 'sms',
            dialed: REDACTED,
            from_num: REDACTED,
            text: REDACTED
        });
    });

    it('redacts a Telnyx fax.received payload', () => {
        const payload = {
            data: {
                event_type: 'fax.received',
                id: 'evt-3',
                occurred_at: '2026-10-31T12:00:00.000Z',
                payload: {
                    fax_id: 'fax-1',
                    connection_id: 'conn-1',
                    direction: 'inbound',
                    status: 'delivered',
                    from: PATIENT,
                    caller_id: 'DR SMITH CLINIC',
                    to: DID,
                    media_url: 'https://s3.example/fax.pdf?X-Amz-Signature=abc',
                    original_media_url: 'https://s3.example/orig.pdf',
                    preview_url: 'https://s3.example/preview.png',
                    page_count: 3
                }
            }
        };
        const out = redactPayload(payload);
        assertSameKeys(out, payload);
        assert.deepEqual(out.data.payload, {
            fax_id: 'fax-1',
            connection_id: 'conn-1',
            direction: 'inbound',
            status: 'delivered',
            from: REDACTED,
            caller_id: REDACTED,
            to: REDACTED,
            media_url: REDACTED,
            original_media_url: REDACTED,
            preview_url: REDACTED,
            page_count: 3
        });
        assert.equal(out.data.event_type, 'fax.received');
    });

    it('keeps null/empty protected values and matches keys case-insensitively in camelCase forms', () => {
        const out = redactPayload({
            callerIdName: 'Jane Doe',
            CALLER_ID: '',
            mediaUrl: null,
            phoneNumber: 5555550123,
            remote: 'x',
            ani: 'y',
            dnis: 'z'
        });
        assert.deepEqual(out, {
            callerIdName: REDACTED,
            CALLER_ID: '',
            mediaUrl: null,
            phoneNumber: REDACTED,
            remote: REDACTED,
            ani: REDACTED,
            dnis: REDACTED
        });
    });

    it('redacts caller_id* variants and phone numbers carried as JSON:API party ids', () => {
        const out = redactPayload({
            caller_id_number: PATIENT,
            callerIdNumber: PATIENT,
            relationships: { from: { data: { type: 'number', id: '15555550123' } } }
        });
        assert.deepEqual(out, {
            caller_id_number: REDACTED,
            callerIdNumber: REDACTED,
            relationships: { from: { data: { type: REDACTED, id: REDACTED } } }
        });
    });

    it('keeps a __proto__ key as an ordinary key', () => {
        const out = redactPayload(JSON.parse('{"__proto__":{"text":"secret","id":"x"},"id":1}'));
        assert.deepEqual(Object.keys(out), ['__proto__', 'id']);
        assert.equal(JSON.stringify(out), '{"__proto__":{"text":"REDACTED","id":"x"},"id":1}');
    });

    it('redacts bracket-path form keys by any protected segment', () => {
        const raw = Buffer.from(
            formBody([
                ['message[from]', PATIENT],
                ['message[text]', 'My HIV results'],
                ['media[0][url]', 'https://m.example/x'],
                ['data[id]', 'm-1']
            ])
        );
        const out = [...new URLSearchParams(redactRequestBodyForLog('application/x-www-form-urlencoded', raw).body)];
        assert.deepEqual(out, [
            ['message[from]', REDACTED],
            ['message[text]', REDACTED],
            ['media[0][url]', REDACTED],
            ['data[id]', 'm-1']
        ]);
    });

    it('redacts Twilio AddOns results in a form body', () => {
        const addOns = JSON.stringify({
            status: 'successful',
            results: { nextcaller: { result: { records: [{ first_name: 'Jane', phone: PATIENT }] } } }
        });
        const raw = Buffer.from(
            formBody([
                ['MessageSid', 'SM9'],
                ['From', PATIENT],
                ['AddOns', addOns],
                ['NumMedia', '0']
            ])
        );
        const out = [...new URLSearchParams(redactRequestBodyForLog('application/x-www-form-urlencoded', raw).body)];
        assert.deepEqual(out, [
            ['MessageSid', 'SM9'],
            ['From', REDACTED],
            ['AddOns', REDACTED],
            ['NumMedia', '0']
        ]);
        assertNoLeak(out, [PATIENT, 'Jane']);
    });

    it('never treats free text in key position as a form body', () => {
        for (const text of ['Patient Jane Doe SECRET A1C=7.2', '{"text":"a=SECRET"}', 'SECRET=', 'Body%20=SECRET']) {
            const raw = Buffer.from(text);
            const out = redactRequestBodyForLog('application/x-www-form-urlencoded', raw);
            assert.deepEqual(out, { body: REDACTED, bodyBytes: raw.length }, text);
        }
    });

    it('redacts JSON that arrives as text/plain or without a content type', () => {
        const raw = Buffer.from(JSON.stringify({ data: { event_type: 'message.received', payload: { text: 'secret', id: 'm1' } } }));
        for (const contentType of ['text/plain; charset=utf-8', '']) {
            const { body, bodyBytes } = redactRequestBodyForLog(contentType, raw);
            assert.equal(bodyBytes, undefined, contentType);
            assert.deepEqual(JSON.parse(body), { data: { event_type: 'message.received', payload: { text: REDACTED, id: 'm1' } } });
        }
        const notJson = Buffer.from('{ call me back');
        assert.deepEqual(redactRequestBodyForLog('text/plain', notJson), { body: REDACTED, bodyBytes: notJson.length });
    });

    it('never logs a body it cannot parse', () => {
        const raw = Buffer.from('From=+15555550123 free text with PHI');
        assert.deepEqual(redactRequestBodyForLog('text/plain', raw), { body: REDACTED, bodyBytes: raw.length });
        assert.deepEqual(redactRequestBodyForLog('', raw), { body: REDACTED, bodyBytes: raw.length });
        assert.deepEqual(redactRequestBodyForLog('multipart/form-data; boundary=x', raw), { body: REDACTED, bodyBytes: raw.length });
        const badJson = Buffer.from('{"text": "Hi", ');
        assert.deepEqual(redactRequestBodyForLog('application/json', badJson), { body: REDACTED, bodyBytes: badJson.length });
        const scalarJson = Buffer.from('"call me at +15555550123"');
        assert.deepEqual(redactRequestBodyForLog('application/json', scalarJson), { body: REDACTED, bodyBytes: scalarJson.length });
        const arrayOfScalars = Buffer.from('["+15555550123", "call me"]');
        assert.deepEqual(redactRequestBodyForLog('application/json', arrayOfScalars), { body: REDACTED, bodyBytes: arrayOfScalars.length });
        const freeTextForm = Buffer.from('Patient Jane Doe DOB 1/2/1980');
        assert.deepEqual(redactRequestBodyForLog('application/x-www-form-urlencoded', freeTextForm), {
            body: REDACTED,
            bodyBytes: freeTextForm.length
        });
        const deep = Buffer.from('{"a":'.repeat(20_000) + '1' + '}'.repeat(20_000));
        assert.deepEqual(redactRequestBodyForLog('application/json', deep), { body: REDACTED, bodyBytes: deep.length });
        assert.deepEqual(redactRequestBodyForLog('application/json', Buffer.alloc(0)), { body: '' });
    });

    it('re-serializes a JSON body with protected values redacted', () => {
        const { body, bodyBytes } = redactRequestBodyForLog(
            'application/json; charset=utf-8',
            Buffer.from(JSON.stringify({ data: { event_type: 'message.received', payload: { text: 'secret', id: 'm1' } } }))
        );
        assert.equal(bodyBytes, undefined);
        assert.deepEqual(JSON.parse(body), { data: { event_type: 'message.received', payload: { text: REDACTED, id: 'm1' } } });
    });
});

describe('RedactedPayloadLogMiddleware', () => {
    function capture() {
        const calls: unknown[][] = [];
        const logger = { info: (...args: unknown[]) => calls.push(args) } as unknown as ScopedLogger;
        return { calls, middleware: new RedactedPayloadLogMiddleware(logger) };
    }

    it('logs method, url, content type and the redacted body, leaving the body readable for the controller', async () => {
        const { calls, middleware } = capture();
        const raw = JSON.stringify({ data: { event_type: 'fax.received', payload: { fax_id: 'f1', from: PATIENT } } });
        const request = HttpRequest.POST('/public/faxes/webhook?token=secret', raw, { 'content-type': 'application/json' });

        await middleware.handle(request, {} as HttpResponse);

        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 'Logging request');
        const data = calls[0][1] as Record<string, unknown>;
        assert.equal(data.method, 'POST');
        assert.equal(data.url, '/public/faxes/webhook');
        assert.equal(data.contentType, 'application/json');
        assert.deepEqual(JSON.parse(data.body as string), { data: { event_type: 'fax.received', payload: { fax_id: 'f1', from: REDACTED } } });
        assertNoLeak(data, [PATIENT]);
        const rereadBody = await request.readBodyText();
        assert.equal(rereadBody, raw);
    });

    it('logs bodyUnavailable and lets the request proceed when the body stream is already being consumed', async () => {
        const { calls, middleware } = capture();
        const request = new HttpRequest(
            'POST',
            '/public/sms/inbound/telnyx',
            { 'content-type': 'multipart/form-data; boundary=x' },
            undefined,
            Readable.from([Buffer.from(`--x\r\nContent-Disposition: form-data; name="text"\r\n\r\n${PATIENT}\r\n--x--\r\n`)])
        );
        // TSF attaches the stream for multipart before route middleware runs.
        void request.stream;

        await middleware.handle(request, {} as HttpResponse);

        assert.deepEqual(calls[0][1], {
            method: 'POST',
            url: '/public/sms/inbound/telnyx',
            contentType: 'multipart/form-data; boundary=x',
            body: REDACTED,
            bodyUnavailable: true
        });
    });

    it('logs REDACTED plus byte length for an unparseable body', async () => {
        const { calls, middleware } = capture();
        const raw = `hello ${PATIENT}`;
        const request = HttpRequest.POST('/public/sms/inbound/telnyx', raw, { 'content-type': 'text/plain' });

        await middleware.handle(request, {} as HttpResponse);

        assert.deepEqual(calls[0][1], {
            method: 'POST',
            url: '/public/sms/inbound/telnyx',
            contentType: 'text/plain',
            body: REDACTED,
            bodyBytes: Buffer.byteLength(raw)
        });
    });
});
