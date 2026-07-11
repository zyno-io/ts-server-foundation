import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it, mock } from 'node:test';

import type { Instrumentation } from '@opentelemetry/instrumentation';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import {
    getTraceContext,
    Env,
    http,
    HttpRequest,
    isTelemetryInitialized,
    isTracingInstalled,
    setSpanAttributes,
    TestingHelpers,
    withLinkedRootSpan,
    withRemoteSpan,
    withRootSpan,
    withSpan
} from '../src';
import { init, resetTelemetryForTests } from '../src/telemetry/otel';
import * as otel from '../src/telemetry/otel';
import { installSentry, resetSentryForTests } from '../src/telemetry/sentry';

const requireFromTest = createRequire(__filename);
const Sentry = requireFromTest('@sentry/node') as typeof import('@sentry/node');

afterEach(() => {
    resetTelemetryForTests();
    resetSentryForTests();
    delete Env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete Env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete Env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete Env.OTEL_METRICS_ENDPOINT_ENABLED;
    delete Env.OTEL_SDK_DISABLED;
    mock.restoreAll();
});

describe('telemetry', () => {
    it('keeps init idempotent without exporters configured', () => {
        assert.equal(isTelemetryInitialized(), false);

        init({ serviceName: 'test' });
        init({ serviceName: 'test' });

        assert.equal(isTelemetryInitialized(), true);
        assert.equal(otel.isTelemetryInitialized(), true);
        assert.equal(isTracingInstalled(), false);
    });

    it('can be disabled explicitly', () => {
        init({ disabled: true });

        assert.equal(isTelemetryInitialized(), false);
    });

    it('honors OTEL_SDK_DISABLED before installing custom providers', () => {
        Env.OTEL_SDK_DISABLED = 'true';
        const exporter = new InMemorySpanExporter();

        init({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

        assert.equal(isTelemetryInitialized(), false);
        assert.equal(isTracingInstalled(), false);
    });

    it('installs tracing with custom span processors and records helper spans', async () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'test-service', spanProcessors: [new SimpleSpanProcessor(exporter)] });

        assert.equal(isTelemetryInitialized(), true);
        assert.equal(isTracingInstalled(), true);

        const result = await withSpan('work', { alpha: 'beta' }, async () => {
            setSpanAttributes({ runtime: 42 });
            return getTraceContext()?.traceId;
        });

        assert.equal(typeof result, 'string');
        const spans = exporter.getFinishedSpans();
        assert.equal(spans.length, 1);
        assert.equal(spans[0].name, 'work');
        assert.equal(spans[0].attributes.alpha, 'beta');
        assert.equal(spans[0].attributes.runtime, 42);
        assert.equal(spans[0].spanContext().traceId, result);
    });

    it('records helper errors, root spans, and linked root spans', async () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'helper-errors', spanProcessors: [new SimpleSpanProcessor(exporter)] });

        await assert.rejects(
            withSpan('failed-work', async () => {
                throw new Error('span failed');
            }),
            /span failed/
        );
        await withRootSpan('root-work', async () => undefined);
        await withLinkedRootSpan(
            'linked-work',
            [
                {
                    traceId: '0123456789abcdef0123456789abcdef',
                    spanId: '1111111111111111',
                    attributes: { source: 'test' }
                }
            ],
            { linked: true },
            async () => undefined
        );

        const spans = exporter.getFinishedSpans();
        const failed = spans.find(span => span.name === 'failed-work');
        const linked = spans.find(span => span.name === 'linked-work');
        assert.equal(failed?.status.code, 2);
        assert.equal(failed?.status.message, 'span failed');
        assert.equal(
            failed?.events.some(event => event.name === 'exception'),
            true
        );
        assert.equal(spans.find(span => span.name === 'root-work')?.parentSpanContext, undefined);
        assert.equal(linked?.links[0].context.traceId, '0123456789abcdef0123456789abcdef');
        assert.equal(linked?.links[0].attributes?.source, 'test');
    });

    it('installs custom metric readers and instrumentations and unregisters them on reset', async () => {
        const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const metricReader = new PeriodicExportingMetricReader({
            exporter: metricExporter,
            exportIntervalMillis: 60_000
        });
        const instrumentation = {
            instrumentationName: 'test-instrumentation',
            instrumentationVersion: '1.0.0',
            disable: mock.fn(),
            enable: mock.fn(),
            setTracerProvider: mock.fn(),
            setMeterProvider: mock.fn(),
            getConfig: () => ({ enabled: true }),
            setConfig: mock.fn()
        } satisfies Instrumentation;
        const exporter = new InMemorySpanExporter();

        init({
            spanProcessors: [new SimpleSpanProcessor(exporter)],
            metricReaders: [metricReader],
            instrumentations: [instrumentation]
        });

        assert.ok(otel.OtelState.meterProvider);
        assert.ok(otel.OtelState.tracerProvider);
        assert.equal(instrumentation.setTracerProvider.mock.callCount() > 0, true);
        assert.equal(instrumentation.setMeterProvider.mock.callCount() > 0, true);

        await otel.shutdownTelemetry();
        assert.equal(instrumentation.disable.mock.callCount() > 0, true);
    });

    it('reads telemetry settings from loaded app config when env is unavailable', async () => {
        Env.APP_ENV = 'production';
        Env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';

        try {
            TestingHelpers.createTestingFacade({});

            delete Env.APP_ENV;
            delete Env.OTEL_EXPORTER_OTLP_ENDPOINT;
            assert.equal(Env.APP_ENV, undefined);
            assert.equal(Env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);

            init({ serviceName: 'config-endpoint' });
            assert.equal(isTracingInstalled(), true);
            resetTelemetryForTests();

            const exporter = new InMemorySpanExporter();
            init({ serviceName: 'config-resource', spanProcessors: [new SimpleSpanProcessor(exporter)] });
            await withSpan('config-resource-check', async () => undefined);

            assert.equal(exporter.getFinishedSpans()[0].resource.attributes['deployment.environment'], 'production');
        } finally {
            resetTelemetryForTests();
            delete Env.APP_ENV;
            delete Env.OTEL_EXPORTER_OTLP_ENDPOINT;
            TestingHelpers.createTestingFacade({});
        }
    });

    it('continues remote span context from traceparent', async () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'test-service', spanProcessors: [new SimpleSpanProcessor(exporter)] });

        await withRemoteSpan(
            'remote-work',
            {
                traceparent: '00-0123456789abcdef0123456789abcdef-1111111111111111-01'
            },
            undefined,
            async () => undefined
        );

        const span = exporter.getFinishedSpans()[0];
        assert.equal(span.spanContext().traceId, '0123456789abcdef0123456789abcdef');
        assert.equal(span.parentSpanContext?.spanId, '1111111111111111');
    });

    it('installs a Prometheus exporter and serves metrics when metrics endpoint mode is enabled', async () => {
        Env.OTEL_METRICS_ENDPOINT_ENABLED = 'true';

        init({ serviceName: 'metrics-test' });

        assert.equal(isTelemetryInitialized(), true);
        assert.equal(otel.OtelState.prometheusExporter !== undefined, true);
        assert.equal(otel.OtelState.meterProvider !== undefined, true);

        const tf = TestingHelpers.createTestingFacade({});
        await tf.start();
        try {
            const response = await tf.request(new HttpRequest('GET', '/metrics'));
            assert.equal(response.statusCode, 200);
            assert.match(response.text, /target_info|otelcol_/);
        } finally {
            await tf.stop();
        }
    });

    it('turns synchronous Prometheus collection failures into HTTP errors', async () => {
        Env.OTEL_METRICS_ENDPOINT_ENABLED = 'true';
        otel.OtelState.metricsEndpointEnabled = true;
        otel.OtelState.prometheusExporter = {
            getMetricsRequestHandler() {
                throw new Error('metrics collection failed');
            }
        } as unknown as typeof otel.OtelState.prometheusExporter;

        const tf = TestingHelpers.createTestingFacade({});
        await tf.start();
        try {
            const response = await tf.request(new HttpRequest('GET', '/metrics'));
            assert.equal(response.statusCode, 500);
        } finally {
            await tf.stop();
        }
    });

    it('keeps OTLP push metrics separate from the Prometheus endpoint when disabled', async () => {
        Env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:4318/v1/metrics';

        init({ serviceName: 'push-only-metrics', enableMetricsEndpoint: false });

        assert.equal(isTelemetryInitialized(), true);
        assert.equal(otel.OtelState.meterProvider !== undefined, true);
        assert.equal(otel.OtelState.prometheusExporter, undefined);

        const tf = TestingHelpers.createTestingFacade({});
        await tf.start();
        try {
            const response = await tf.request(new HttpRequest('GET', '/metrics'));
            assert.equal(response.statusCode, 404);
        } finally {
            resetTelemetryForTests();
            await tf.stop();
        }
    });

    it('shuts down installed telemetry when the app stops', async () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'app-shutdown-test', spanProcessors: [new SimpleSpanProcessor(exporter)] });

        const tf = TestingHelpers.createTestingFacade({});
        await tf.start();

        assert.equal(otel.OtelState.tracerProvider !== undefined, true);

        await tf.stop();

        assert.equal(isTelemetryInitialized(), false);
        assert.equal(otel.OtelState.tracerProvider, undefined);
    });

    it('adds active trace ids to HTTP request context', async () => {
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'test-service', spanProcessors: [new SimpleSpanProcessor(exporter)] });
        Env.APP_ENV = 'test';

        @http.controller('/trace')
        class TraceController {
            @http.GET()
            get(request: HttpRequest) {
                return { traceId: request.context.traceId };
            }
        }

        const tf = TestingHelpers.createTestingFacade({
            controllers: [TraceController]
        });

        await tf.start();
        try {
            const response = await withSpan('http-parent', async () => tf.request(new HttpRequest('GET', '/trace')));
            assert.equal(typeof response.json.traceId, 'string');
            assert.equal(response.json.traceId, exporter.getFinishedSpans()[0].spanContext().traceId);
        } finally {
            await tf.stop();
        }
    });

    it('installs Sentry trace enrichment only when tracing is already active', async () => {
        type EventProcessor = Parameters<typeof Sentry.addEventProcessor>[0];
        let processor: EventProcessor | undefined;
        const addEventProcessor = mock.method(Sentry, 'addEventProcessor', (value: EventProcessor) => {
            processor = value;
        });
        mock.method(Sentry, 'init', () => undefined);

        installSentry({ dsn: 'https://example@sentry.invalid/1' });
        assert.equal(addEventProcessor.mock.callCount(), 0);

        resetSentryForTests();
        const exporter = new InMemorySpanExporter();
        init({ serviceName: 'sentry-order', spanProcessors: [new SimpleSpanProcessor(exporter)] });
        installSentry({ dsn: 'https://example@sentry.invalid/1' });
        assert.equal(addEventProcessor.mock.callCount(), 1);
        assert.ok(processor);

        await withSpan('sentry-context', async () => {
            const event = await processor!({} as Parameters<EventProcessor>[0], {} as Parameters<EventProcessor>[1]);
            const trace = event?.contexts?.trace as { trace_id?: string; span_id?: string } | undefined;
            const active = getTraceContext();
            assert.equal(trace?.trace_id, active?.traceId);
            assert.equal(trace?.span_id, active?.spanId);
        });
    });
});
