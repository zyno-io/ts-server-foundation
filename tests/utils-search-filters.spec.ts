import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composeSearchFilters, parseSearchFilters, removeSearchFilters, replaceSearchFilters } from '@zyno-io/ts-utils';

describe('parseSearchFilters basics', () => {
    it('handles empty and undefined input', () => {
        assert.deepEqual(parseSearchFilters(), { filters: {}, text: undefined });
        assert.deepEqual(parseSearchFilters(''), { filters: {}, text: undefined });
        assert.deepEqual(parseSearchFilters('   '), { filters: {}, text: undefined });
    });

    it('handles filters only and text only', () => {
        assert.deepEqual(parseSearchFilters('a:1 b:2'), { filters: { a: '1', b: '2' }, text: undefined });
        assert.deepEqual(parseSearchFilters('  hello   world '), { filters: {}, text: 'hello world' });
    });

    it('handles filters at the start, middle and end', () => {
        assert.deepEqual(parseSearchFilters('a:1 smith jones'), { filters: { a: '1' }, text: 'smith jones' });
        assert.deepEqual(parseSearchFilters('smith a:1 jones'), { filters: { a: '1' }, text: 'smith jones' });
        assert.deepEqual(parseSearchFilters('smith jones a:1'), { filters: { a: '1' }, text: 'smith jones' });
    });

    it('treats tabs, newlines and repeated spaces as separators', () => {
        assert.deepEqual(parseSearchFilters('a:1\t\tb:2\n\nsmith   c:3\r\njones'), {
            filters: { a: '1', b: '2', c: '3' },
            text: 'smith jones'
        });
    });

    it('does not share regex state between calls', () => {
        for (let i = 0; i < 3; i++) assert.deepEqual(parseSearchFilters('a:1 b:2').filters, { a: '1', b: '2' });
    });
});

describe('parseSearchFilters quoting', () => {
    it('allows spaces and colons in quoted values', () => {
        assert.deepEqual(parseSearchFilters('after:"2026-03-10 14:00" x').filters, { after: '2026-03-10 14:00' });
        assert.deepEqual(parseSearchFilters('k:"a: b c:d"').filters, { k: 'a: b c:d' });
    });

    it('unescapes \\" and \\\\', () => {
        assert.equal(parseSearchFilters('k:"say \\"hi\\""').filters.k, 'say "hi"');
        assert.equal(parseSearchFilters('k:"a\\\\b"').filters.k, 'a\\b');
        assert.equal(parseSearchFilters('k:"trailing\\\\"').filters.k, 'trailing\\');
        // Other backslash sequences are left alone.
        assert.equal(parseSearchFilters('k:"a\\nb"').filters.k, 'a\\nb');
    });

    it('pins an empty quoted value as an empty-string filter', () => {
        assert.deepEqual(parseSearchFilters('after:"" smith'), { filters: { after: '' }, text: 'smith' });
    });

    it('strips a stray quote from an unterminated bare value', () => {
        assert.deepEqual(parseSearchFilters('k:"abc def'), { filters: { k: 'abc' }, text: 'def' });
        assert.deepEqual(parseSearchFilters('after:"2026-03-10'), { filters: { after: '2026-03-10' }, text: undefined });
        assert.deepEqual(parseSearchFilters('direction:incoming"'), { filters: { direction: 'incoming' }, text: undefined });
        assert.deepEqual(parseSearchFilters('say "hello'), { filters: {}, text: 'say "hello' });
        assert.deepEqual(parseSearchFilters('a"b:c'), { filters: { b: 'c' }, text: 'a"' });
    });

    it('does not treat a token that starts with : or " as a filter key', () => {
        assert.deepEqual(parseSearchFilters(':foo'), { filters: {}, text: ':foo' });
        assert.deepEqual(parseSearchFilters('"quoted text" more'), { filters: {}, text: '"quoted text" more' });
        // The key stops at the quote, so a quoted token that contains a colon still yields a filter after the opening quote.
        assert.deepEqual(parseSearchFilters('"a:b"'), { filters: { a: 'b' }, text: '"' });
    });

    it('stays linear on long and quote-heavy input', () => {
        for (const input of ['a'.repeat(100_000), `${'a '.repeat(50_000)}k:v`, '"'.repeat(100_000), `k:"${'x'.repeat(100_000)}`]) {
            const started = Date.now();
            parseSearchFilters(input);
            replaceSearchFilters(input, { after: '2026-03-10 14:00' });
            // Linear parsing takes a few milliseconds; the previous quadratic pattern took tens of seconds at this size.
            assert.ok(Date.now() - started < 2000, `${input.slice(0, 12)}… took ${Date.now() - started}ms`);
        }
    });

    it('splits text glued to the end of a quoted value', () => {
        assert.deepEqual(parseSearchFilters('k:"a b"jones'), { filters: { k: 'a b' }, text: 'jones' });
    });

    it('pins a double colon as a bare value starting with a colon', () => {
        assert.deepEqual(parseSearchFilters('a::b'), { filters: { a: ':b' }, text: undefined });
    });
});

describe('parseSearchFilters keys and values', () => {
    it('keeps colons in unquoted values', () => {
        assert.deepEqual(parseSearchFilters('after:2026-03-10T14:00:30').filters, { after: '2026-03-10T14:00:30' });
    });

    it('lets the last duplicate key win', () => {
        assert.deepEqual(parseSearchFilters('a:1 b:x a:2 a:3').filters, { a: '3', b: 'x' });
    });

    it('accepts keys with dashes, underscores and digits', () => {
        assert.deepEqual(parseSearchFilters('my-key:1 my_key:2 k2:3 2k:4').filters, { 'my-key': '1', my_key: '2', k2: '3', '2k': '4' });
    });

    it('keeps __proto__ as plain data', () => {
        const { filters } = parseSearchFilters('__proto__:x');
        assert.equal(Object.getPrototypeOf(filters), Object.prototype);
        assert.deepEqual(Object.keys(filters), ['__proto__']);
        assert.equal(Object.getOwnPropertyDescriptor(filters, '__proto__')?.value, 'x');
    });
});

describe('parseSearchFilters free text that looks like filters', () => {
    it('pins URLs as a filter with key http', () => {
        assert.deepEqual(parseSearchFilters('see http://x.com/a now'), { filters: { http: '//x.com/a' }, text: 'see now' });
    });

    it('pins a time in free text as key 10', () => {
        assert.deepEqual(parseSearchFilters('call at 10:30'), { filters: { '10': '30' }, text: 'call at' });
    });

    it('handles unicode text and values', () => {
        assert.deepEqual(parseSearchFilters('Zoë café nom:Müller 日本:語'), { filters: { nom: 'Müller', 日本: '語' }, text: 'Zoë café' });
    });

    it('leaves a key with no value in the text', () => {
        assert.deepEqual(parseSearchFilters('after:'), { filters: {}, text: 'after:' });
        assert.deepEqual(parseSearchFilters('smith after: jones'), { filters: {}, text: 'smith after: jones' });
    });
});

describe('composeSearchFilters', () => {
    it('skips null, undefined and empty values', () => {
        assert.equal(composeSearchFilters({ a: '1', b: null, c: undefined, d: '', e: '2' }), 'a:1 e:2');
        assert.equal(composeSearchFilters({}), '');
    });

    it('quotes values with whitespace or quotes and escapes backslashes and quotes', () => {
        assert.equal(composeSearchFilters({ a: 'x y' }), 'a:"x y"');
        assert.equal(composeSearchFilters({ a: 'say "hi"' }), 'a:"say \\"hi\\""');
        assert.equal(composeSearchFilters({ a: 'p\\q r' }), 'a:"p\\\\q r"');
        assert.equal(composeSearchFilters({ a: 'tab\tsep' }), 'a:"tab\tsep"');
        assert.equal(composeSearchFilters({ a: 'p\\q' }), 'a:p\\q');
        assert.equal(composeSearchFilters({ a: '10:30' }), 'a:10:30');
    });

    it('keeps insertion order', () => {
        assert.equal(composeSearchFilters({ z: '1', a: '2', m: '3' }), 'z:1 a:2 m:3');
    });
});

describe('replaceSearchFilters and removeSearchFilters', () => {
    it('removes filters and returns the free text, or an empty string', () => {
        assert.equal(removeSearchFilters('smith a:1 jones b:"x y"'), 'smith jones');
        assert.equal(removeSearchFilters('a:1 b:2'), '');
        assert.equal(removeSearchFilters(''), '');
        assert.equal(removeSearchFilters('  just   text '), 'just text');
    });

    it('keeps the text order and appends the new filters', () => {
        assert.equal(replaceSearchFilters('smith a:1 jones', { b: '2', c: 'x y' }), 'smith jones b:2 c:"x y"');
        assert.equal(replaceSearchFilters('a:1 b:2', { c: '3' }), 'c:3');
        assert.equal(replaceSearchFilters('smith', {}), 'smith');
        assert.equal(replaceSearchFilters('', {}), '');
    });

    it('removes all filters when every value is empty', () => {
        assert.equal(replaceSearchFilters('smith a:1 b:2', { a: null, b: '' }), 'smith');
    });

    it('is idempotent when applied twice with the same values', () => {
        const values = { direction: 'incoming', after: '2026-03-10 14:00', note: 'say "hi"' };
        const once = replaceSearchFilters('smith a:1 jones', values);
        assert.equal(replaceSearchFilters(once, values), once);
    });
});

describe('search filter round trips', () => {
    const values = [
        'plain',
        'with space',
        'two  spaces',
        ' leading and trailing ',
        'a:b',
        'a: b',
        '2026-03-10T14:00:30',
        '2026-03-10 14:00',
        'say "hi"',
        '"',
        '""',
        '"quoted"',
        '\\',
        '\\\\',
        'back\\slash',
        'ends with backslash\\',
        'ends\\ "mix" \\"',
        'tab\there',
        'new\nline',
        'crlf\r\nline',
        'nbsp here',
        'unicode 日本語 café',
        'emoji 😀',
        'a:"b c":d',
        '#hash & (parens) [brackets]',
        '10:30',
        'http://x.com/a b'
    ];

    for (const value of values) {
        it(`round-trips ${JSON.stringify(value)}`, () => {
            const composed = composeSearchFilters({ k: value });
            const parsed = parseSearchFilters(composed);
            assert.equal(parsed.filters.k, value);
            assert.equal(parsed.text, undefined);
            // Surrounding text is unaffected.
            assert.deepEqual(parseSearchFilters(`before ${composed} after`), { filters: { k: value }, text: 'before after' });
        });
    }

    it('round-trips multiple values together', () => {
        const input = { a: 'x y', b: 'say "hi"', c: 'plain', d: 'p\\q' };
        assert.deepEqual(parseSearchFilters(composeSearchFilters(input)).filters, input);
    });
});
