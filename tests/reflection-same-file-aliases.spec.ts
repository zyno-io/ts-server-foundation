import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validate } from '../src';

// No other file imports these aliases. Their own file's class must still read them as the resolved
// literal unions, not as an unresolved Exclude class or an unknown.
export type SameFileAccountStatus = 'active' | 'suspended' | 'deleted';
export type SameFileLiveStatus = Exclude<SameFileAccountStatus, 'deleted'>;
export const SAME_FILE_KINDS = ['monitor', 'probe'] as const;
export type SameFileKind = (typeof SAME_FILE_KINDS)[number];

// ALive references BLive, which sorts after it; both are filled in the same alias pass.
export type SameFileALive = SameFileBLive | null;
export type SameFileBLive = Exclude<SameFileAccountStatus, 'deleted'>;

// Exported through export lists rather than their own export keyword.
type SameFileListedLive = Exclude<SameFileAccountStatus, 'deleted'>;
type SameFileTypeListedLive = Exclude<SameFileAccountStatus, 'deleted'>;
export { SameFileListedLive };
export type { SameFileTypeListedLive };

class SameFileAccount {
    status!: SameFileLiveStatus;
    kind!: SameFileKind;
}

class SameFileOrderedAccount {
    alive!: SameFileALive;
    listed!: SameFileListedLive;
    typeListed!: SameFileTypeListedLive;
}

describe('same-file exported aliases', () => {
    it('validates an Exclude alias and a (typeof X)[number] alias used in their own file', () => {
        assert.deepStrictEqual(validate({ status: 'active', kind: 'monitor' }, SameFileAccount), []);
        assert.deepStrictEqual(validate({ status: 'suspended', kind: 'probe' }, SameFileAccount), []);
        const errors = validate({ status: 'deleted', kind: 'other' }, SameFileAccount).map(error => error.path);
        assert.deepStrictEqual(errors.sort(), ['kind', 'status']);
    });

    it('validates an alias that references a later same-file alias, and aliases exported through export lists', () => {
        assert.deepStrictEqual(validate({ alive: 'active', listed: 'suspended', typeListed: 'active' }, SameFileOrderedAccount), []);
        assert.deepStrictEqual(validate({ alive: null, listed: 'active', typeListed: 'suspended' }, SameFileOrderedAccount), []);
        const errors = validate({ alive: 'deleted', listed: 'deleted', typeListed: 'deleted' }, SameFileOrderedAccount).map(error => error.path);
        assert.deepStrictEqual(errors.sort(), ['alive', 'listed', 'typeListed']);
    });
});
