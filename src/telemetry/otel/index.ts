import '../../timezone';

import { hostname } from 'node:os';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { createRequire } from 'node:module';

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
import installNodeMetrics from 'opentelemetry-node-metrics';

import { isDevelopmentEnvironment } from '../../app/const';
import { getCurrentApp } from '../../app/current';
import { Env } from '../../env';
import { getPackageJson } from '../../helpers/io/package';
import { getHttpContextResolver, setHttpContextResolver } from '../../http/context';
import { OtelState, getTraceContext } from './helpers';
import { isOtelMetricsEndpointEnabled } from './metrics';

export * from './helpers';

const requireFromTelemetry = createRequire(__filename);

export type HttpIncomingRequestAttributeHook = (request: IncomingMessage) => Record<string, AttributeValue>;

export interface PyroscopeOptions {
    /**
     * Start Pyroscope only after TSF has installed an OpenTelemetry trace provider.
     * `true` uses the Pyroscope SDK's environment-based configuration.
     */
    enabled?: boolean;
    appName?: string;
    serverAddress?: string;
    tags?: Record<string, string | number>;
    basicAuthUser?: string;
    basicAuthPassword?: string;
    tenantID?: string;
    authToken?: string;
    flushIntervalMs?: number;
    wall?: {
        samplingDurationMs?: number;
        samplingIntervalMicros?: number;
        collectCpuTime?: boolean;
    };
    heap?: {
        samplingIntervalBytes?: number;
        stackDepth?: number;
    };
}

interface PyroscopeClient {
    init(options: PyroscopeClientOptions): void;
    start(): void;
    stop(): Promise<void>;
}

type PyroscopeClientOptions = Omit<PyroscopeOptions, 'enabled'>;

export interface TelemetryInitOptions {
    serviceName?: string;
    serviceVersion?: string;
    disabled?: boolean;
    instrumentations?: Instrumentation[];
    httpIncomingRequestAttributeHook?: HttpIncomingRequestAttributeHook;
    enableRedisInstrumentation?: boolean;
    enableMetricsEndpoint?: boolean;
    spanProcessors?: SpanProcessor[];
    metricReaders?: MetricReader[];
    pyroscope?: boolean | PyroscopeOptions;
}

export type IOtelOptions = TelemetryInitOptions;

export function init(options: TelemetryInitOptions = {}): void {
    if (options.disabled || readTelemetrySetting('OTEL_SDK_DISABLED') === 'true') return;
    const shouldInstallTraces = shouldInstallTraceProvider(options);
    const shouldInstallMetrics = shouldInstallMeterProvider(options);
    const hasInstalledProviders = !!(OtelState.tracerProvider || OtelState.meterProvider);
    if (OtelState.initialized && (hasInstalledProviders || (!shouldInstallTraces && !shouldInstallMetrics))) {
        startPyroscopeIfRequested(options);
        return;
    }

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
        installNodeMetrics(meterProvider);
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
        startPyroscopeIfRequested(options);
    }

    OtelState.unregisterInstrumentations = registerInstrumentations({
        instrumentations: createDefaultInstrumentations(options)
    });
}

export async function shutdownTelemetry(): Promise<void> {
    const tracerProvider = OtelState.tracerProvider;
    const meterProvider = OtelState.meterProvider;
    const pyroscope = OtelState.pyroscope;

    const results = await Promise.allSettled([
        Promise.resolve().then(() => tracerProvider?.shutdown()),
        Promise.resolve().then(() => meterProvider?.shutdown()),
        Promise.resolve().then(() => pyroscope?.stop())
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
    OtelState.pyroscope = undefined;
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
            ignoreIncomingRequestHook: (request: IncomingMessage) =>
                request.url === '/healthz' || request.url === '/readyz' || request.url === '/livez' || request.url === '/metrics',
            ignoreOutgoingRequestHook: (request: RequestOptions) => !!String(request.host ?? request.hostname ?? '').match(/sentry\./)
        }),
        new UndiciInstrumentation({
            ignoreRequestHook: (request: UndiciRequest) => /(\/healthz|\/readyz|\/livez|\/metrics|sentry\.)/.test(`${request.origin}${request.path}`)
        }),
        new DnsInstrumentation(),
        ...(options.enableRedisInstrumentation === true ? [new IORedisInstrumentation()] : []),
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

function startPyroscopeIfRequested(options: TelemetryInitOptions): void {
    const requestedPyroscope = options.pyroscope;
    if (!OtelState.tracerProvider || OtelState.pyroscope || !isPyroscopeEnabled(requestedPyroscope)) return;

    const pyroscope = loadPyroscope();
    const pyroscopeOptions: PyroscopeOptions = requestedPyroscope === true ? {} : requestedPyroscope;
    pyroscope.init(createPyroscopeConfig(options, pyroscopeOptions));
    pyroscope.start();
    OtelState.pyroscope = pyroscope;
}

function isPyroscopeEnabled(options: TelemetryInitOptions['pyroscope']): options is true | PyroscopeOptions {
    return options === true || (typeof options === 'object' && options !== null && options.enabled !== false);
}

function createPyroscopeConfig(options: TelemetryInitOptions, pyroscopeOptions: PyroscopeOptions): PyroscopeClientOptions {
    const packageJson = getPackageJson();
    const appName = pyroscopeOptions.appName ?? options.serviceName ?? packageJson?.name;
    const serviceVersion = options.serviceVersion ?? packageJson?.version;
    const deploymentEnvironment = readTelemetrySetting('APP_ENV');
    const tags: Record<string, string | number> = { 'host.name': hostname() };
    if (serviceVersion) tags['service.version'] = serviceVersion;
    if (deploymentEnvironment) tags['deployment.environment'] = deploymentEnvironment;
    if (pyroscopeOptions.tags) Object.assign(tags, pyroscopeOptions.tags);
    const { enabled: _enabled, ...pyroscopeConfig } = pyroscopeOptions;

    return {
        ...pyroscopeConfig,
        ...(appName ? { appName } : {}),
        tags
    };
}

function loadPyroscope(): PyroscopeClient {
    try {
        return requireFromTelemetry('@pyroscope/nodejs') as PyroscopeClient;
    } catch (error) {
        throw new Error('Pyroscope is enabled but the required @pyroscope/nodejs package could not be loaded.', {
            cause: error
        });
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
