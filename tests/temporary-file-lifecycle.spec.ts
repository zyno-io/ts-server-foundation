import assert from 'node:assert/strict';
import { it } from 'node:test';

import { BaseAppConfig, createApp, isAutoConstructProvider, temporaryFiles, TemporaryFileCleanupService } from '../src';

it('provides local cleanup automatically in HTTP/CLI apps and closes its cursor at shutdown', async t => {
    assert.equal(isAutoConstructProvider(TemporaryFileCleanupService), true);
    assert.equal(isAutoConstructProvider(TemporaryFileCleanupService, { cli: true }), true);
    const app = createApp({ config: BaseAppConfig });
    const cleanup = app.container.get(TemporaryFileCleanupService);
    const sweep = t.mock.method(temporaryFiles, 'sweep', async () => ({ scanned: 0, removed: 0, retained: 0, failed: 0 }));
    const close = t.mock.method(temporaryFiles, 'close', async () => {});
    try {
        await Promise.all([cleanup.start(), cleanup.start()]);
        assert.equal(sweep.mock.callCount(), 1);
    } finally {
        await cleanup.stop();
        await app.stop();
    }
    assert.ok(close.mock.callCount() >= 1);
});
