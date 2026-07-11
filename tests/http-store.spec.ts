import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearCachedValue, getCachedValue, getOrCacheValue, hasCachedValue, HttpRequest, setCachedValue } from '../src';

describe('request store helpers', () => {
    it('caches values on the request store', async () => {
        const request = HttpRequest.GET('/store');
        const key = Symbol('value');
        let calls = 0;

        const first = await getOrCacheValue(request, key, () => {
            calls++;
            return 'cached';
        });
        const second = await getOrCacheValue(request, key, () => {
            calls++;
            return 'uncached';
        });

        assert.equal(first, 'cached');
        assert.equal(second, 'cached');
        assert.equal(calls, 1);
        assert.equal(hasCachedValue(request, key), true);
        assert.equal(getCachedValue(request, key), 'cached');
    });

    it('sets and clears cached values', () => {
        const request = HttpRequest.GET('/store');
        const key = 'value';

        setCachedValue(request, key, 123);
        assert.equal(getCachedValue(request, key), 123);

        clearCachedValue(request, key);
        assert.equal(hasCachedValue(request, key), false);
        assert.equal(getCachedValue(request, key), undefined);
    });

    it('supports object cache keys without string-name collisions', () => {
        const request = HttpRequest.GET('/store');
        const firstKey = { name: 'same' };
        const secondKey = { name: 'same' };

        setCachedValue(request, firstKey, 'first');
        setCachedValue(request, secondKey, 'second');

        assert.equal(getCachedValue(request, firstKey), 'first');
        assert.equal(getCachedValue(request, secondKey), 'second');
        clearCachedValue(request, firstKey);
        assert.equal(hasCachedValue(request, firstKey), false);
        assert.equal(getCachedValue(request, secondKey), 'second');
    });
});
