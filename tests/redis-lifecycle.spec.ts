import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it, mock } from 'node:test';

import { createApp } from '../src';
import { registerRedisStateReset } from '../src/helpers/redis/lifecycle';

describe('Redis state lifecycle', () => {
    it('resets state once when any Redis client ends', async () => {
        const app = createApp({ enableHealthcheck: false });
        const first = new EventEmitter();
        const second = new EventEmitter();
        const reset = mock.fn();
        registerRedisStateReset([first, second], reset);

        first.emit('end');
        second.emit('end');
        await app.stop();

        assert.equal(reset.mock.callCount(), 1);
    });

    it('resets state once during app cleanup when clients remain connected', async () => {
        const app = createApp({ enableHealthcheck: false });
        const client = new EventEmitter();
        const reset = mock.fn();
        registerRedisStateReset(client, reset);

        await app.stop();
        client.emit('end');

        assert.equal(reset.mock.callCount(), 1);
    });
});
