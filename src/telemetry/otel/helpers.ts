import { isNativeError } from 'node:util/types';

import {
    ROOT_CONTEXT,
    SpanKind,
    SpanStatusCode,
    trace,
    type Attributes,
    type Link,
    type Span,
    type SpanContext,
    type Tracer
} from '@opentelemetry/api';
import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import type { registerInstrumentations } from '@opentelemetry/instrumentation';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

type MaybePromise<T> = T | Promise<T>;

export const OtelState = {
    initialized: false,
    tracer: undefined as Tracer | undefined,
    tracerProvider: undefined as NodeTracerProvider | undefined,
    meterProvider: undefined as MeterProvider | undefined,
    prometheusExporter: undefined as PrometheusExporter | undefined,
    unregisterInstrumentations: undefined as ReturnType<typeof registerInstrumentations> | undefined,
    metricsEndpointEnabled: false,
    metricsEndpointPreference: undefined as boolean | undefined,

    get installed(): boolean {
        return OtelState.tracer !== undefined;
    }
};

export function isTelemetryInitialized(): boolean {
    return OtelState.initialized;
}

export function isTracingInstalled(): boolean {
    return OtelState.installed;
}

export function getTracer(): Tracer | undefined {
    return OtelState.tracer;
}

export function getActiveSpan(): Span | undefined {
    return trace.getActiveSpan();
}

export function getTraceContext(): SpanContext | undefined {
    return getActiveSpan()?.spanContext();
}

export function disableActiveTrace(): void {
    const ctx = getTraceContext();
    if (ctx) ctx.traceFlags = 0;
}

function isError(error: unknown): error is Error {
    return error instanceof Error || isNativeError(error);
}

async function runInSpan<T>(span: Span, fn: () => MaybePromise<T>): Promise<T> {
    try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
    } catch (error) {
        span.recordException(isError(error) ? error : String(error));
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: isError(error) ? error.message : String(error)
        });
        throw error;
    } finally {
        span.end();
    }
}

export type SpanInfo =
    | {
          traceId: string;
          spanId: string;
          traceFlags?: number;
      }
    | { traceparent: string }
    | undefined;

export function withRemoteSpan<T>(name: string, spanInfo: SpanInfo, attrs: Attributes | undefined, fn: () => MaybePromise<T>): Promise<T> {
    if (!OtelState.tracer) return Promise.resolve(fn());
    if (!spanInfo) return withSpan(name, attrs, fn);

    const context = parseSpanInfo(spanInfo);
    if (!context) return withSpan(name, attrs, fn);

    const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
        ...context,
        traceFlags: context.traceFlags ?? 1,
        isRemote: true
    });
    return OtelState.tracer.startActiveSpan(name, { attributes: attrs, kind: SpanKind.SERVER }, parentContext, span => runInSpan(span, fn));
}

export function withSpan<T>(name: string, fn: () => MaybePromise<T>): Promise<T>;
export function withSpan<T>(name: string, attrs: Attributes | undefined, fn: () => MaybePromise<T>): Promise<T>;
export function withSpan<T>(name: string, attrsOrFn: Attributes | (() => MaybePromise<T>) | undefined, fn?: () => MaybePromise<T>): Promise<T> {
    const resolvedAttrs = typeof attrsOrFn === 'object' ? attrsOrFn : undefined;
    const resolvedFn = fn ?? (attrsOrFn as () => MaybePromise<T>);

    if (!OtelState.tracer) return Promise.resolve(resolvedFn());
    return OtelState.tracer.startActiveSpan(name, { attributes: resolvedAttrs }, span => runInSpan(span, resolvedFn));
}

export function withRootSpan<T>(name: string, fn: () => MaybePromise<T>): Promise<T>;
export function withRootSpan<T>(name: string, attrs: Attributes | undefined, fn: () => MaybePromise<T>): Promise<T>;
export function withRootSpan<T>(name: string, attrsOrFn: Attributes | (() => MaybePromise<T>) | undefined, fn?: () => MaybePromise<T>): Promise<T> {
    const resolvedAttrs = typeof attrsOrFn === 'object' ? attrsOrFn : undefined;
    const resolvedFn = fn ?? (attrsOrFn as () => MaybePromise<T>);

    if (!OtelState.tracer) return Promise.resolve(resolvedFn());
    return OtelState.tracer.startActiveSpan(name, { attributes: resolvedAttrs }, ROOT_CONTEXT, span => runInSpan(span, resolvedFn));
}

export type SpanLinkRef = {
    traceId: string;
    spanId: string;
    traceFlags?: number;
    attributes?: Attributes;
};

export function withLinkedRootSpan<T>(name: string, links: SpanLinkRef[], attrs: Attributes | undefined, fn: () => MaybePromise<T>): Promise<T> {
    if (!OtelState.tracer) return Promise.resolve(fn());
    const otelLinks: Link[] = links.map(link => ({
        context: {
            traceId: link.traceId,
            spanId: link.spanId,
            traceFlags: link.traceFlags ?? 1,
            isRemote: true
        },
        attributes: link.attributes
    }));
    return OtelState.tracer.startActiveSpan(name, { attributes: attrs, links: otelLinks }, ROOT_CONTEXT, span => runInSpan(span, fn));
}

export function setSpanAttributes(attributes: Attributes): void {
    if (!OtelState.installed) return;
    getActiveSpan()?.setAttributes(attributes);
}

function parseSpanInfo(spanInfo: SpanInfo): { traceId: string; spanId: string; traceFlags?: number } | undefined {
    if (!spanInfo) return undefined;
    if ('traceparent' in spanInfo) {
        const parts = spanInfo.traceparent.split('-');
        if (parts.length < 4 || parts[0] !== '00') return undefined;
        return {
            traceId: parts[1],
            spanId: parts[2],
            traceFlags: Number.parseInt(parts[3], 16)
        };
    }
    return spanInfo;
}
