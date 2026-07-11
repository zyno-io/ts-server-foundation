import { Env } from '../../env';
import { OtelState } from './helpers';

export function isOtelMetricsEndpointEnabled(): boolean {
    if (OtelState.metricsEndpointPreference !== undefined) return OtelState.metricsEndpointPreference;
    const value = Env.OTEL_METRICS_ENDPOINT_ENABLED;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return OtelState.metricsEndpointEnabled;
}
