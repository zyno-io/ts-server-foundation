import { addEventProcessor, flush, init, type NodeOptions } from '@sentry/node';

import { Env } from '../env';
import { getPackageJson } from '../helpers/io/package';
import { getTraceContext, isTracingInstalled } from './otel/helpers';

const SentryState = {
    installed: false
};

export interface ISentryOptions extends NodeOptions {
    dsn: string;
}

export function isSentryInstalled(): boolean {
    return SentryState.installed;
}

export function installSentry(options: ISentryOptions): void {
    const { dsn, ...sentryOptions } = options;
    const packageJson = getPackageJson();
    const release = packageJson?.name && packageJson?.version ? `${packageJson.name.replace(/^@.+?\//, '')}@${packageJson.version}` : undefined;

    init({
        dsn,
        environment: Env.APP_ENV,
        maxBreadcrumbs: 0,
        release,
        skipOpenTelemetrySetup: true,
        integrations: integrations => integrations.filter(integration => !['Http', 'NodeFetch'].includes(integration.name)),
        ...sentryOptions
    });

    if (isTracingInstalled()) {
        addEventProcessor(event => {
            const spanContext = getTraceContext();
            if (spanContext) {
                event.contexts = {
                    ...event.contexts,
                    trace: {
                        trace_id: spanContext.traceId,
                        span_id: spanContext.spanId
                    }
                };
            }
            return event;
        });
    }

    SentryState.installed = true;
}

export async function flushSentry(): Promise<void> {
    if (isSentryInstalled()) await flush(5);
}

export function resetSentryForTests(): void {
    SentryState.installed = false;
}
