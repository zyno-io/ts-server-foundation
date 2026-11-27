import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractSearchFilters, HttpUserError } from '../src';

type CallFilters = { direction?: 'incoming' | 'outgoing'; after?: string };

describe('extractSearchFilters', () => {
    it('returns {} for empty or undefined input', () => {
        assert.deepEqual(extractSearchFilters<CallFilters>(), {});
        assert.deepEqual(extractSearchFilters<CallFilters>(''), {});
    });

    it('returns text and filters', () => {
        assert.deepEqual(extractSearchFilters<CallFilters>('smith direction:incoming after:"2026-03-10 14:00" jones'), {
            text: 'smith jones',
            filters: { direction: 'incoming', after: '2026-03-10 14:00' }
        });
    });

    it('returns text: undefined for filters-only input and filters: undefined for text-only input', () => {
        assert.deepEqual(extractSearchFilters<CallFilters>('direction:outgoing'), { text: undefined, filters: { direction: 'outgoing' } });
        assert.deepEqual(extractSearchFilters<CallFilters>('just text'), { text: 'just text', filters: undefined });
    });

    it('validates a literal union against the reflected type', () => {
        assert.deepEqual(extractSearchFilters<CallFilters>('direction:incoming').filters, { direction: 'incoming' });
        assert.throws(
            () => extractSearchFilters<CallFilters>('direction:sideways'),
            (error: unknown) => {
                assert.ok(error instanceof HttpUserError);
                assert.equal(error.message, '"sideways" is not valid for "direction"');
                return true;
            }
        );
    });

    it('accepts an optional string field', () => {
        assert.deepEqual(extractSearchFilters<CallFilters>('after:2026-03-10T14:00:30').filters, { after: '2026-03-10T14:00:30' });
        assert.equal(extractSearchFilters<CallFilters>('direction:incoming').filters?.after, undefined);
    });

    it('pins the unknown-key behaviour', () => {
        // Keys that are not in T are not rejected: they pass through as plain strings. Pinned, not endorsed.
        assert.deepEqual(extractSearchFilters<CallFilters>('foo:bar'), { text: undefined, filters: { foo: 'bar' } });
    });
});
