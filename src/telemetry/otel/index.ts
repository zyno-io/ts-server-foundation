import '../../timezone';

import { hostname } from 'node:os';
import type { IncomingMessage, RequestOptions } from 'node:http';

import { context, diag, DiagConsoleLogger, DiagLogLevel, metrics, propagation, trace, type AttributeValue } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { DnsInstrumentation } from '@opentelemetry/instrumentation-dns';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation, type UndiciRequest } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { isDevelopmentEnvironment } from '../../app/const';
import { getCurrentApp } from '../../app/current';
import { Env } from '../../env';
import { getPackageJson } from '../../helpers/io/package';
import { getHttpContextResolver, setHttpContextResolver } from '../../http/context';
import { OtelState, getTraceContext } from './helpers';
import { isOtelMetricsEndpointEnabled } from './metrics';

export * from './helpers';

export type HttpIncomingRequestAttributeHook = (request: IncomingMessage) => Record<string, AttributeValue>;

export interface TelemetryInitOptions {
    serviceName?: string;
    serviceVersion?: string;
    disabled?: boolean;
    instrumentations?: Instrumentation[];
    httpIncomingRequestAttributeHook?: HttpIncomingRequestAttributeHook;
    enableMetricsEndpoint?: boolean;
    spanProcessors?: SpanProcessor[];
    metricReaders?: MetricReader[];
}

export type IOtelOptions = TelemetryInitOptions;

export function init(options: TelemetryInitOptions = {}): void {
    if (options.disabled || readTelemetrySetting('OTEL_SDK_DISABLED') === 'true') return;
    const shouldInstallTraces = shouldInstallTraceProvider(options);
    const shouldInstallMetrics = shouldInstallMeterProvider(options);
    const hasInstalledProviders = !!(OtelState.tracerProvider || OtelState.meterProvider);
    if (OtelState.initialized && (hasInstalledProviders || (!shouldInstallTraces && !shouldInstallMetrics))) return;

    OtelState.initialized = true;
    if (options.enableMetricsEndpoint !== undefined) OtelState.metricsEndpointPreference = options.enableMetricsEndpoint;
    OtelState.metricsEndpointEnabled ||= shouldEnableMetricsEndpoint(options);

    if (readTelemetrySetting('OTEL_DEBUG')) {
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    }

    if (!shouldInstallTraces && !shouldInstallMetrics) return;

    const resource = buildResource(options);

    if (shouldInstallMetrics) {
        const { meterProvider, prometheusExporter } = createMeterProvider(resource, options);
        metrics.setGlobalMeterProvider(meterProvider);
        OtelState.meterProvider = meterProvider;
        OtelState.prometheusExporter = prometheusExporter;
    }

    if (shouldInstallTraces) {
        const tracerProvider = new NodeTracerProvider({
            resource,
            spanProcessors: options.spanProcessors?.length ? [...options.spanProcessors] : [createDefaultSpanProcessor()]
        });
        tracerProvider.register();
        OtelState.tracerProvider = tracerProvider;
        OtelState.tracer = tracerProvider.getTracer(options.serviceName ?? 'default');
        installHttpTraceContextResolver();
    }

    OtelState.unregisterInstrumentations = registerInstrumentations({
        instrumentations: createDefaultInstrumentations(options)
    });
}

export async function shutdownTelemetry(): Promise<void> {
    const tracerProvider = OtelState.tracerProvider;
    const meterProvider = OtelState.meterProvider;

    const results = await Promise.allSettled([
        Promise.resolve().then(() => tracerProvider?.shutdown()),
        Promise.resolve().then(() => meterProvider?.shutdown())
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    try {
        resetTelemetryForTests();
    } catch (error) {
        failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Telemetry shutdown failed');
}

export function resetTelemetryForTests(): void {
    const unregisterInstrumentations = OtelState.unregisterInstrumentations;
    OtelState.initialized = false;
    OtelState.tracer = undefined;
    OtelState.tracerProvider = undefined;
    OtelState.meterProvider = undefined;
    OtelState.prometheusExporter = undefined;
    OtelState.unregisterInstrumentations = undefined;
    OtelState.metricsEndpointEnabled = false;
    OtelState.metricsEndpointPreference = undefined;

    const failures: unknown[] = [];
    const runCleanup = (cleanup: () => void) => {
        try {
            cleanup();
        } catch (error) {
            failures.push(error);
        }
    };
    if (unregisterInstrumentations) runCleanup(unregisterInstrumentations);
    runCleanup(restoreHttpTraceContextResolver);
    runCleanup(() => trace.disable());
    runCleanup(() => metrics.disable());
    runCleanup(() => context.disable());
    runCleanup(() => propagation.disable());

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Telemetry reset failed');
}

function shouldInstallTraceProvider(options: TelemetryInitOptions): boolean {
    return !!(
        readTelemetrySetting('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ||
        readTelemetrySetting('OTEL_EXPORTER_OTLP_ENDPOINT') ||
        options.spanProcessors?.length
    );
}

function shouldInstallMeterProvider(options: TelemetryInitOptions): boolean {
    return shouldPushMetrics() || shouldEnableMetricsEndpoint(options) || !!options.metricReaders?.length;
}

function buildResource(options: TelemetryInitOptions) {
    const packageJson = getPackageJson();
    return resourceFromAttributes({
        'service.name': options.serviceName ?? packageJson?.name ?? 'unknown',
        'service.version': options.serviceVersion ?? packageJson?.version ?? 'unknown',
        'deployment.environment': readTelemetrySetting('APP_ENV'),
        'host.name': hostname(),
        'process.pid': process.pid
    });
}

function createDefaultSpanProcessor(): SpanProcessor {
    const exporter = new OTLPTraceExporter();
    return isDevelopmentEnvironment() ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter);
}

function createMeterProvider(resource: ReturnType<typeof buildResource>, options: TelemetryInitOptions) {
    const readers: MetricReader[] = [...(options.metricReaders ?? [])];
    let prometheusExporter: PrometheusExporter | undefined;

    if (shouldPushMetrics()) {
        readers.push(
            new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter(),
                exportIntervalMillis: 10_000
            })
        );
    }

    if (shouldEnableMetricsEndpoint(options)) {
        prometheusExporter = new PrometheusExporter({ preventServerStart: true });
        readers.push(prometheusExporter);
    }

    return {
        meterProvider: new MeterProvider({ resource, readers }),
        prometheusExporter
    };
}

function createDefaultInstrumentations(options: TelemetryInitOptions): Instrumentation[] {
    return [
        new HttpInstrumentation({
            startIncomingSpanHook: options.httpIncomingRequestAttributeHook,
            ignoreIncomingRequestHook: (request: IncomingMessage) => request.url === '/healthz' || request.url === '/metrics',
            ignoreOutgoingRequestHook: (request: RequestOptions) => !!String(request.host ?? request.hostname ?? '').match(/sentry\./)
        }),
        new UndiciInstrumentation({
            ignoreRequestHook: (request: UndiciRequest) => /(\/healthz|\/metrics|sentry\.)/.test(`${request.origin}${request.path}`)
        }),
        new DnsInstrumentation(),
        new IORedisInstrumentation(),
        new MySQL2Instrumentation(),
        new PgInstrumentation(),
        ...(options.instrumentations ?? [])
    ];
}

function shouldPushMetrics(): boolean {
    return !!(readTelemetrySetting('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT') || readTelemetrySetting('OTEL_EXPORTER_OTLP_ENDPOINT'));
}

function shouldEnableMetricsEndpoint(options: TelemetryInitOptions): boolean {
    if (options.enableMetricsEndpoint === false) return false;
    return options.enableMetricsEndpoint === true || isOtelMetricsEndpointEnabled();
}

function readTelemetrySetting(key: string): string | undefined {
    const envValue = Env[key];
    if (envValue !== undefined) return envValue;

    try {
        const configValue = (getCurrentApp().config as unknown as Record<string, unknown>)[key];
        if (configValue === undefined || configValue === null) return undefined;
        return String(configValue);
    } catch {
        return undefined;
    }
}

let httpContextResolverInstalled = false;
let previousHttpContextResolver: ReturnType<typeof getHttpContextResolver> | undefined;

function installHttpTraceContextResolver(): void {
    if (httpContextResolverInstalled) return;
    httpContextResolverInstalled = true;
    previousHttpContextResolver = getHttpContextResolver();
    setHttpContextResolver(request => {
        const context = previousHttpContextResolver?.(request) ?? {};
        const traceId = getTraceContext()?.traceId;
        return traceId ? { ...context, traceId } : context;
    });
}

function restoreHttpTraceContextResolver(): void {
    if (previousHttpContextResolver) setHttpContextResolver(previousHttpContextResolver);
    previousHttpContextResolver = undefined;
    httpContextResolverInstalled = false;
}
