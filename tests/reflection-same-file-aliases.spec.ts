import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validate } from '../src';

// No other file imports these aliases. Their own file's class must still read them as the resolved
// literal unions, not as an unresolved Exclude class or an unknown.
export type SameFileAccountStatus = 'active' | 'suspended' | 'deleted';
export type SameFileLiveStatus = Exclude<SameFileAccountStatus, 'deleted'>;
export const SAME_FILE_KINDS = ['monitor', 'probe'] as const;
export type SameFileKind = (typeof SAME_FILE_KINDS)[number];

class SameFileAccount {
    status!: SameFileLiveStatus;
    kind!: SameFileKind;
}

describe('same-file exported aliases', () => {
    it('validates an Exclude alias and a (typeof X)[number] alias used in their own file', () => {
        assert.deepStrictEqual(validate({ status: 'active', kind: 'monitor' }, SameFileAccount), []);
        assert.deepStrictEqual(validate({ status: 'suspended', kind: 'probe' }, SameFileAccount), []);
        const errors = validate({ status: 'deleted', kind: 'other' }, SameFileAccount).map(error => error.path);
        assert.deepStrictEqual(errors.sort(), ['kind', 'status']);
    });
});
