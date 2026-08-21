declare module '*.json' {
    const value: unknown;
    export default value;
}

declare module 'opentelemetry-node-metrics' {
    import type { MeterProvider } from '@opentelemetry/sdk-metrics';

    function installNodeMetrics(meterProvider: MeterProvider): void;

    export default installNodeMetrics;
}
