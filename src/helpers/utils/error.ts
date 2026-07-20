import { isNativeError } from 'node:util/types';

import { captureException } from '@sentry/node';

import { isTestEnvironment } from '../../app/const';
import { Env } from '../../env';
import { getTraceContext } from '../../telemetry/otel/helpers';
import { isSentryInstalled } from '../../telemetry/sentry';

export interface DecoratedError extends Error {
    cause?: unknown;
    context?: Record<string, unknown>;
}

export const SentryLiftKeysToTagsFromLoggerContext: string[] = [];

export interface IErrorContext {
    scope?: string;
    scopeData?: Record<string, unknown>;
    loggerContext?: Record<string, unknown>;
    data?: Record<string, unknown>;
    [key: string]: unknown;
}

const errorHandlerState: {
    reporter?: (level: number, err: Error, context: IErrorContext) => void;
} = {};
type SentryTagValue = string | number | boolean | bigint | symbol | null | undefined;

export function isError(value: unknown): value is Error {
    return value instanceof Error || isNativeError(value);
}

export function getErrorMessage(value: unknown): string {
    return isError(value) ? value.message : String(value);
}

export function toError(value: unknown, cause?: unknown): Error {
    const error = isError(value) ? value : new Error(String(value));
    if (cause !== undefined) (error as DecoratedError).cause = toError(cause);
    return error;
}

export function tryOrErrorSync<T>(fn: () => T): T | Error {
    try {
        return fn();
    } catch (error) {
        return toError(error);
    }
}

export async function tryOrError<T>(fn: () => T | Promise<T>): Promise<T | Error> {
    try {
        return await fn();
    } catch (error) {
        return toError(error);
    }
}

export function setGlobalErrorReporter(reporter: (level: number, err: Error, context: IErrorContext) => void): void {
    errorHandlerState.reporter = reporter;
}

export function reportError(level: number, err: Error, context: IErrorContext): void {
    try {
        errorHandlerState.reporter?.(level, err, context);
    } catch (reporterError) {
        console.error('Global error reporter failed', reporterError);
    }
    if (isSentryInstalled()) {
        const loggerContext = context.loggerContext ?? {};
        const tags = pickTagKeys(loggerContext, SentryLiftKeysToTagsFromLoggerContext);
        const Details = {
            ...context,
            loggerContext: omitKeys(loggerContext, SentryLiftKeysToTagsFromLoggerContext)
        };
        captureException(err, {
            tags,
            extra: { Details },
            level: level === 1 ? 'fatal' : level === 3 ? 'warning' : 'error'
        });
    }
    if (level === 1 && !isTestEnvironment()) {
        sendSlackAlertNotification(err as DecoratedError, context);
    }
}

async function sendSlackAlertNotification(err: DecoratedError, context: IErrorContext): Promise<void> {
    try {
        const traceContext = getTraceContext();
        const url = getSlackWebhookUrl();
        if (!url) return;

        await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: compact([`:rotating_light: *${err.message}*`, getCauseMessage(err.cause) && `cause: ${getCauseMessage(err.cause)}`]).join('\n'),
                attachments: [
                    {
                        color: 'danger',
                        fields: compact([
                            context.scope && {
                                title: 'Scope',
                                value: context.scope,
                                short: true
                            },
                            traceContext && {
                                title: 'Trace ID',
                                value: traceContext.traceId,
                                short: true
                            },
                            context.data && {
                                title: 'Alert Data',
                                value: JSON.stringify(context.data, null, 2),
                                short: false
                            },
                            err.context && {
                                title: 'Error Context',
                                value: JSON.stringify(err.context, null, 2),
                                short: false
                            },
                            context.scopeData && {
                                title: 'Scope Data',
                                value: JSON.stringify(context.scopeData, null, 2),
                                short: false
                            },
                            context.loggerContext && {
                                title: 'Logger Context',
                                value: JSON.stringify(context.loggerContext, null, 2),
                                short: false
                            }
                        ])
                    }
                ]
            })
        });
    } catch (error) {
        console.error('Failed to send slack alert notification', error);
    }
}

function getSlackWebhookUrl(): string | undefined {
    try {
        // Lazy require avoids a load-time cycle through app -> services -> logger -> error.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getCurrentApp } = require('../../app/base') as {
            getCurrentApp: () => { config?: { ALERTS_SLACK_WEBHOOK_URL?: string } };
        };
        return getCurrentApp().config?.ALERTS_SLACK_WEBHOOK_URL ?? Env.ALERTS_SLACK_WEBHOOK_URL;
    } catch {
        return Env.ALERTS_SLACK_WEBHOOK_URL;
    }
}

function getCauseMessage(cause: unknown): string | undefined {
    if (!cause) return undefined;
    if (isError(cause)) return cause.message;
    if (typeof cause === 'object' && 'message' in cause) return String((cause as { message?: unknown }).message);
    return String(cause);
}

function compact<T>(values: (T | undefined | null | false | '')[]): T[] {
    return values.filter(Boolean) as T[];
}

function pickTagKeys(source: Record<string, unknown>, keys: string[]): Record<string, SentryTagValue> {
    return Object.fromEntries(keys.filter(key => isPrimitive(source[key])).map(key => [key, source[key] as SentryTagValue]));
}

function omitKeys(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const blocked = new Set(keys);
    return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key)));
}

function isPrimitive(value: unknown): value is SentryTagValue {
    return value === undefined || value === null || ['string', 'number', 'boolean', 'bigint', 'symbol'].includes(typeof value);
}
