# Telemetry

TSF provides OpenTelemetry setup helpers and Sentry error reporting helpers.

## OpenTelemetry Bootstrap

Import the OpenTelemetry bootstrap from the dedicated subpath before importing modules you want instrumented.

```ts
import { init } from '@zyno-io/ts-server-foundation/otel';

init();

const { createApp } = await import('@zyno-io/ts-server-foundation');
```

`init()` is idempotent.

## `init(options?)`

```ts
init({
    serviceName: 'api',
    serviceVersion: '1.2.3',
    enableMetricsEndpoint: true,
    httpIncomingRequestAttributeHook: request => ({
        'http.request.host': request.headers.host ?? ''
    })
});
```

Options:

| Option                             | Description                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| `serviceName`                      | Overrides package name for telemetry resource attributes.    |
| `serviceVersion`                   | Overrides package version for telemetry resource attributes. |
| `disabled`                         | Skips initialization when true.                              |
| `instrumentations`                 | Additional OpenTelemetry instrumentations.                   |
| `httpIncomingRequestAttributeHook` | Adds attributes to incoming HTTP spans.                      |
| `enableMetricsEndpoint`            | Enables the Prometheus `/metrics` endpoint.                  |
| `spanProcessors`                   | Custom trace span processors.                                |
| `metricReaders`                    | Custom metric readers.                                       |

## Environment

| Key                                   | Description                               |
| ------------------------------------- | ----------------------------------------- |
| `OTEL_SDK_DISABLED`                   | Set to `true` to disable telemetry setup. |
| `OTEL_DEBUG`                          | Enables OpenTelemetry diagnostic logging. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | OTLP endpoint for traces and metrics.     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | OTLP endpoint for traces.                 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | OTLP endpoint for metric push.            |
| `OTEL_METRICS_ENDPOINT_ENABLED`       | Enables or disables `/metrics`.           |

Trace providers are installed when an OTLP trace endpoint or custom span processors are configured. Metric providers are installed when metric push, `/metrics`, or custom metric readers are configured.

## Resources And Export

TSF adds these resource attributes to installed trace and metric providers:

| Attribute | Source |
| --- | --- |
| `service.name` | `serviceName`, then the working package name, then `unknown`. |
| `service.version` | `serviceVersion`, then the working package version, then `unknown`. |
| `deployment.environment` | `APP_ENV`. |
| `host.name` | Operating-system hostname. |
| `process.pid` | Current process ID. |

The default OTLP trace exporter uses a `SimpleSpanProcessor` in development and a `BatchSpanProcessor` otherwise. OTLP metrics use a periodic reader with a 10-second export interval. Passing custom `spanProcessors` or `metricReaders` replaces the corresponding default processor/reader choice while retaining any separately enabled Prometheus endpoint.

## Built-In Instrumentations

Default instrumentation includes:

- HTTP
- Undici
- DNS
- ioredis
- mysql2
- pg

HTTP context is connected to TSF request handling so request logs and Sentry events can include trace context.

## Metrics Endpoint

When enabled, `createApp()` registers:

```http
GET /metrics
```

The endpoint serves Prometheus text output from the OpenTelemetry Prometheus exporter. It authorizes the transport socket's peer address against private/local IP ranges and deliberately ignores `x-real-ip` and `x-forwarded-for`, even when normal request handling trusts proxy headers.

| Status | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| `200`  | Metrics collected successfully.                                      |
| `403`  | Caller is not from an allowed private/local address.                 |
| `503`  | Metrics endpoint is enabled but no Prometheus exporter is available. |
| `500`  | The exporter failed while collecting or rendering metrics.           |

## Span Helpers

Span helpers are exported from the package root.

```ts
import {
    disableActiveTrace,
    getActiveSpan,
    getTraceContext,
    getTracer,
    isTelemetryInitialized,
    isTracingInstalled,
    setSpanAttributes,
    withLinkedRootSpan,
    withRemoteSpan,
    withRootSpan,
    withSpan
} from '@zyno-io/ts-server-foundation';

await withSpan('work', { itemId: '123' }, async () => {
    setSpanAttributes({ result: 'ok' });
});

await withRootSpan('job', async () => runJob());

await withRemoteSpan('rpc', { traceparent }, undefined, async () => handleRpc());
```

Helpers are no-ops when tracing is not installed.

`withSpan()` creates a child of the active span, `withRootSpan()` starts without a parent, `withLinkedRootSpan()` starts a root span with explicit links, and `withRemoteSpan()` continues a valid remote context. Helper callbacks may be synchronous or asynchronous. Thrown errors are recorded on the span, set its status to error, end it, and are rethrown unchanged. `setSpanAttributes()` and `disableActiveTrace()` affect only the active span/context.

`SpanInfo`, accepted by `withRemoteSpan()`, is either `{ traceId, spanId, traceFlags? }`, `{ traceparent }`, or `undefined`. Invalid `traceparent` input falls back to a normal child span rather than throwing. `SpanLinkRef`, accepted by `withLinkedRootSpan()`, adds optional link attributes as well as trace/span identifiers.

`isTelemetryInitialized()` reports whether initialization was attempted. `isTracingInstalled()` reports whether a tracer provider is actually active; initialization can be complete without tracing when no trace exporter or custom processor was configured.

## Shutdown And Tests

```ts
import { resetTelemetryForTests, shutdownTelemetry } from '@zyno-io/ts-server-foundation/otel';

await shutdownTelemetry();
resetTelemetryForTests();
```

`shutdownTelemetry()` attempts to shut down every installed provider and clears global state even when shutdown fails. It then rethrows the single provider failure or an `AggregateError` containing multiple failures.

`disabled: true` and `OTEL_SDK_DISABLED=true` return before initialization. Custom `spanProcessors`, `metricReaders`, and `instrumentations` are installed alongside the appropriate provider; registered instrumentations are disabled again during shutdown/reset. Passing `enableMetricsEndpoint: false` overrides the endpoint environment flag but does not disable OTLP push metrics or custom metric readers.

## Sentry

Sentry helpers are exported from the package root.

```ts
import { flushSentry, installSentry, isSentryInstalled } from '@zyno-io/ts-server-foundation';

installSentry({ dsn: 'https://example@sentry.io/1' });

if (isSentryInstalled()) {
    await flushSentry();
}
```

`createApp()` installs Sentry automatically when `SENTRY_DSN` is configured. Sentry events include the active OpenTelemetry trace context when tracing is already installed at the time Sentry is initialized, so initialize OTel before creating the app or calling `installSentry()`.

Relevant environment keys:

| Key                        | Description                                   |
| -------------------------- | --------------------------------------------- |
| `SENTRY_DSN`               | Sentry project DSN.                           |
| `APP_ENV`                  | Sentry environment.                           |
| `ALERTS_SLACK_WEBHOOK_URL` | Optional Slack webhook used by alert logging. |
