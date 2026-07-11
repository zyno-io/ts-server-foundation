import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    cleanPhone,
    deserialize,
    EMAIL_REGEX,
    formatPhoneFriendly,
    getClassName,
    isClass,
    uuid,
    validate,
    type NonEmptyTrimmedString,
    type PhoneNumber,
    type PhoneNumberNANP,
    type TrimmedString
} from '../src';

describe('foundation type helpers', () => {
    it('normalizes and validates phone aliases through deserializer decorators', () => {
        interface Input {
            intl: PhoneNumber;
            nanp: PhoneNumberNANP;
        }

        assert.equal(cleanPhone('(404) 900-5600'), '+14049005600');
        assert.equal(cleanPhone('not a phone'), null);
        assert.equal(formatPhoneFriendly('+14049005600', 'US'), '(404) 900-5600');
        assert.equal(formatPhoneFriendly('not a phone', 'US'), null);
        assert.deepStrictEqual(deserialize<Input>({ intl: '(404) 900-5600', nanp: '(404) 900-5600' }), {
            intl: '+14049005600',
            nanp: '4049005600'
        });
        assert.equal(deserialize<Input>({ intl: 'not a phone', nanp: '(404) 900-5600' }).intl, '¡InvalidPhone¡');
    });

    it('trims annotated strings and keeps non-empty validation attached', () => {
        interface Input {
            value: TrimmedString;
            required: NonEmptyTrimmedString;
        }

        assert.deepStrictEqual(deserialize<Input>({ value: '  ok  ', required: ' required ' }), { value: 'ok', required: 'required' });
        assert.deepStrictEqual(
            validate<Input>({ value: 'ok', required: '' }).map(error => error.code),
            ['minLength']
        );
    });

    it('exposes runtime helper behavior without requiring reflection metadata', () => {
        class Named {}

        assert.equal(EMAIL_REGEX.test('UPPER+tag@example.com'), true);
        assert.equal(EMAIL_REGEX.test('bad@example'), false);
        assert.equal(getClassName(Named), 'Named');
        assert.equal(getClassName(new Named()), 'Named');
        assert.equal(isClass(Named), true);
        assert.equal(
            isClass(() => undefined),
            false
        );
        assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
});
