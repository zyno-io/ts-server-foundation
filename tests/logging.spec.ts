import createDebug from 'debug';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
    Env,
    ExtendedLogger,
    LoggerLevel,
    type LogEntry,
    resetLogSink,
    setGlobalErrorReporter,
    setLogSink,
    withContextData,
    withLoggerContext
} from '../src';

afterEach(() => {
    resetLogSink();
    setGlobalErrorReporter(() => {});
    createDebug.disable();
    delete Env.ALERTS_SLACK_WEBHOOK_URL;
    mock.restoreAll();
});

describe('logging contracts', () => {
    it('whitelists shared context, applies logger-context precedence, and restores nested context', async () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        const logger = new ExtendedLogger('ContextScope', { source: 'scope', scopeOnly: true });

        await withContextData(
            {
                http: { requestId: 'req-1' },
                job: { jobId: 'job-1' },
                hidden: 'not-logged'
            },
            async () => {
                logger.info('shared', { source: 'message' });
                await withLoggerContext({ source: 'outer-context', extra: 'outer' }, async () => {
                    logger.info('outer');
                    await withLoggerContext({ source: 'inner-context', extra: 'inner' }, async () => logger.info('inner'));
                    logger.info('restored');
                });
            }
        );
        logger.info('outside');

        assert.deepStrictEqual(entries[0].data, {
            source: 'scope',
            scopeOnly: true,
            http: { requestId: 'req-1' },
            job: { jobId: 'job-1' }
        });
        assert.equal((entries[0].data as Record<string, unknown> | undefined)?.hidden, undefined);
        assert.deepStrictEqual(entries[1].data, {
            source: 'outer-context',
            scopeOnly: true,
            http: { requestId: 'req-1' },
            job: { jobId: 'job-1' },
            extra: 'outer'
        });
        assert.equal(entries[2].data?.source, 'inner-context');
        assert.equal(entries[2].data?.extra, 'inner');
        assert.equal(entries[3].data?.source, 'outer-context');
        assert.equal(entries[3].data?.extra, 'outer');
        assert.deepStrictEqual(entries[4].data, { source: 'scope', scopeOnly: true });
    });

    it('uses DEBUG namespaces for debug and the mutable level for other custom levels', () => {
        const entries: LogEntry[] = [];
        setLogSink(entry => entries.push(entry));
        const logger = new ExtendedLogger('DebugScope');
        logger.level = LoggerLevel.none;

        logger.debug('disabled');
        logger.debug2('filtered');
        createDebug.enable('DebugScope');
        logger.debug('enabled despite the numeric level');
        logger.debug2('still filtered');

        logger.level = LoggerLevel.debug2;
        logger.alert('alert');
        logger.error('error');
        logger.warning('warning');
        logger.log('notice');
        logger.info('info');
        logger.debug2('verbose');
        logger.data({ persistent: true }).info('with data');

        assert.equal(logger.is(LoggerLevel.debug2), true);
        assert.deepStrictEqual(
            entries.map(entry => [entry.level, entry.levelName, entry.message]),
            [
                [LoggerLevel.debug, 'debug', 'enabled despite the numeric level'],
                [LoggerLevel.alert, 'alert', 'alert'],
                [LoggerLevel.error, 'error', 'error'],
                [LoggerLevel.warning, 'warning', 'warning'],
                [LoggerLevel.log, 'log', 'notice'],
                [LoggerLevel.info, 'info', 'info'],
                [LoggerLevel.debug2, 'debug2', 'verbose'],
                [LoggerLevel.info, 'info', 'with data']
            ]
        );
        assert.deepStrictEqual(entries.at(-1)?.data, { persistent: true });
    });

    it('does not send Slack notifications for alert-level reports in test environments', async () => {
        const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
        Env.ALERTS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/logging-contract';
        const logger = new ExtendedLogger('AlertScope');

        logger.warning('warning with error', new Error('warning cause'));
        logger.error('ordinary error');
        logger.alert('page operator');
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(fetchMock.mock.callCount(), 0);
    });
});
