import assert from 'node:assert/strict';
import { test } from 'node:test';

import { app } from '../src/app';

test('creates the application', () => {
    assert.equal(app.config.APP_ENV, 'test');
});
