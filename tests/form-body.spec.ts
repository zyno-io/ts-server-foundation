import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpBadRequestError, HttpPayloadTooLargeError } from '../src/http/errors';
import { defaultFormBodyLimits, FormBodyBuilder, parseFormUrlEncodedBody, type FormBodyLimits } from '../src/http/form-body';

const limits: FormBodyLimits = { ...defaultFormBodyLimits };

describe('form body parsing', () => {
    it('expands object properties, append arrays, indexed arrays, and repeated leaves', () => {
        const body = parseFormUrlEncodedBody(
            [
                'user[firstName]=Ada',
                'user[lastName]=Lovelace',
                'tags[]=math',
                'tags[]=programming',
                'participants[1][name]=Grace',
                'participants[0][name]=Ada',
                'participants[0][role]=author',
                'filters.status=active',
                'user[nickname]=Enchantress',
                'user[nickname]=Countess'
            ].join('&'),
            limits
        );

        assert.deepStrictEqual(toPlain(body), {
            user: {
                firstName: 'Ada',
                lastName: 'Lovelace',
                nickname: ['Enchantress', 'Countess']
            },
            tags: ['math', 'programming'],
            participants: [{ name: 'Ada', role: 'author' }, { name: 'Grace' }],
            'filters.status': 'active'
        });
        assert.equal(Object.getPrototypeOf(body), null);
        assert.equal(Object.getPrototypeOf(body.user), null);
        assert.equal(Object.getPrototypeOf((body.participants as unknown[])[0]), null);
    });

    it('preserves encoded brackets and plus decoding through URLSearchParams', () => {
        const body = parseFormUrlEncodedBody('contact%5BdisplayName%5D=Ada+Lovelace&query=a%2Bb', limits);
        assert.deepStrictEqual(toPlain(body), {
            contact: { displayName: 'Ada Lovelace' },
            query: 'a+b'
        });
    });

    it('allows repeated values at an explicit indexed leaf', () => {
        const body = parseFormUrlEncodedBody('items[0]=one&items[0]=two', limits);
        assert.deepStrictEqual(toPlain(body), { items: [['one', 'two']] });
    });

    it('merges disjoint JSON payload properties with bracket fields', () => {
        const builder = new FormBodyBuilder(limits);
        builder.add('contact[lastName]', 'Lovelace');
        builder.add('participants[0][role]', 'author');
        builder.mergeObject({
            contact: { firstName: 'Ada' },
            participants: [{ name: 'Ada' }]
        });

        assert.deepStrictEqual(toPlain(builder.build()), {
            contact: { firstName: 'Ada', lastName: 'Lovelace' },
            participants: [{ name: 'Ada', role: 'author' }]
        });
    });

    it('merges top-level files without allowing text collisions or nested file names', () => {
        const fields = new FormBodyBuilder(limits);
        const files = new FormBodyBuilder(limits);
        const first = { path: '/first' };
        const second = { path: '/second' };
        fields.add('description', 'avatars');
        files.addTopLevelFile('file', first);
        files.addTopLevelFile('file', second);
        fields.merge(files);

        const body = fields.build();
        assert.equal(body.description, 'avatars');
        assert.deepStrictEqual(body.file, [first, second]);
        assert.throws(() => files.addTopLevelFile('nested[file]', first), HttpBadRequestError);

        const collision = new FormBodyBuilder(limits);
        collision.add('file', 'text');
        assert.throws(() => collision.merge(files), /Conflicting form field values/);
    });

    it('rejects unsafe, malformed, ambiguous, and conflicting paths', () => {
        const invalid = [
            '=value',
            '__proto__[polluted]=yes',
            'value[constructor]=yes',
            'value[prototype]=yes',
            'value[child=value',
            'value[child]tail=x',
            'items[][name]=Ada',
            'items[01]=Ada',
            'items[-1]=Ada',
            'items[1.5]=Ada',
            'value=text&value[name]=Ada',
            'value[name]=Ada&value=text',
            'items[]=Ada&items[0]=Grace',
            'items[0]=Ada&items[]=Grace',
            'items[name]=Ada&items[0]=Grace',
            'items[0]=Ada&items[name]=Grace',
            'items[1]=Grace'
        ];

        for (const text of invalid) {
            assert.throws(
                () => parseFormUrlEncodedBody(text, limits),
                error => error instanceof HttpBadRequestError,
                text
            );
        }
    });

    it('rejects unsafe and colliding JSON payload properties', () => {
        const unsafe = JSON.parse('{"safe":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
        const builder = new FormBodyBuilder(limits);
        assert.throws(() => builder.mergeObject(unsafe), /Unsafe form field property/);

        const collision = new FormBodyBuilder(limits);
        collision.add('contact[firstName]', 'Ada');
        assert.throws(() => collision.mergeObject({ contact: { firstName: 'Grace' } }), /Conflicting form field values/);
    });

    it('enforces field count, name length, nesting depth, and array index limits', () => {
        assert.throws(
            () => parseFormUrlEncodedBody('one=1&two=2', { ...limits, maxFormFields: 1 }),
            error => error instanceof HttpPayloadTooLargeError && error.message === 'Form contains too many fields'
        );
        assert.throws(
            () => parseFormUrlEncodedBody('long=value', { ...limits, maxFormFieldNameLength: 3 }),
            error => error instanceof HttpPayloadTooLargeError && error.message === 'Form field name is too long'
        );
        assert.throws(
            () => parseFormUrlEncodedBody('one[two][three]=value', { ...limits, maxFormDepth: 2 }),
            error => error instanceof HttpPayloadTooLargeError && error.message === 'Form field nesting is too deep'
        );
        assert.throws(
            () => parseFormUrlEncodedBody('items[2]=value', { ...limits, maxFormArrayIndex: 1 }),
            error => error instanceof HttpPayloadTooLargeError && /Array index is too large/.test(error.message)
        );
        assert.throws(
            () => new FormBodyBuilder({ ...limits, maxFormFields: 1 }).mergeObject({ one: 1, two: 2 }),
            error => error instanceof HttpPayloadTooLargeError && error.message === 'Form contains too many fields'
        );
    });
});

function toPlain(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value));
}
