import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { BaseAppConfig, BaseJob, createApp, resetLogSink, setLogSink, WorkerQueueRegistry, WorkerRunnerService } from '../src';
import { bullMqTerminalKeepJobs } from '../src/services/worker/queue';

const originalEnv = { ...process.env };

afterEach(() => {
    process.env = { ...originalEnv };
    resetLogSink();
});

function config(overrides: Partial<BaseAppConfig> = {}): BaseAppConfig {
    return Object.assign(new BaseAppConfig(), overrides);
}

describe('BullMQ terminal retention backstop', () => {
    it('defaults to 24 hours and 10k jobs per terminal status', () => {
        assert.deepEqual(bullMqTerminalKeepJobs(config()), {
            removeOnComplete: { age: 86_400, count: 10_000 },
            removeOnFail: { age: 86_400, count: 10_000 }
        });
    });

    it('supports disabling either dimension or explicitly retaining all jobs', () => {
        for (const [age, count, keep] of [
            [0, 50, { count: 50 }],
            [60, 0, { age: 60 }],
            [0, 0, false]
        ] as const) {
            assert.deepEqual(bullMqTerminalKeepJobs(config({ BULL_TERMINAL_KEEP_AGE_SEC: age, BULL_TERMINAL_KEEP_COUNT: count })), {
                removeOnComplete: keep,
                removeOnFail: keep
            });
        }
    });

    it('rejects fractional and invalid settings instead of dropping unrecorded jobs or silently disabling limits', () => {
        for (const setting of ['BULL_TERMINAL_KEEP_AGE_SEC', 'BULL_TERMINAL_KEEP_COUNT'] as const) {
            for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
                assert.throws(() => bullMqTerminalKeepJobs(config({ [setting]: value })), new RegExp(setting));
            }
        }
    });

    it('rejects invalid settings before a producer opens a Redis queue', async () => {
        const registry = new WorkerQueueRegistry(config({ APP_ENV: 'development', BULL_TERMINAL_KEEP_COUNT: 0.5 }));
        registry.getBullQueue = () => assert.fail('configuration must be checked before creating a queue');
        class ExampleJob extends BaseJob {
            handle(): void {}
        }
        await assert.rejects(registry.enqueue(ExampleJob, undefined), /BULL_TERMINAL_KEEP_COUNT/);
    });

    it('validates settings before worker startup performs Redis or database work', async () => {
        process.env.APP_ENV = 'development';
        setLogSink(() => {});
        const app = createApp({ enableWorker: true, defaultConfig: { BULL_TERMINAL_KEEP_AGE_SEC: 0.5 } });
        const runner = app.get(WorkerRunnerService);
        runner.removeStaleBullMqCronJobs = () => assert.fail('configuration must be checked before startup I/O');
        try {
            await assert.rejects(runner.start(), /BULL_TERMINAL_KEEP_AGE_SEC/);
        } finally {
            await app.stop();
        }
    });
});
