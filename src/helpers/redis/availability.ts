import {
    createAvailabilityMonitor,
    DEFAULT_AVAILABILITY_ALERT_AFTER_MS,
    type AvailabilityLogger,
    type AvailabilityMonitor,
    type AvailabilityMonitorOptions
} from '../availability';

export const DEFAULT_REDIS_UNAVAILABLE_ALERT_AFTER_MS = DEFAULT_AVAILABILITY_ALERT_AFTER_MS;
export type RedisAvailabilityMonitor = AvailabilityMonitor;
export type RedisAvailabilityMonitorOptions = AvailabilityMonitorOptions;

export interface RedisAvailabilityClient {
    on(event: 'error', listener: (error: unknown) => void): unknown;
    on(event: 'ready' | 'reconnecting', listener: () => void): unknown;
    removeListener(event: 'error', listener: (error: unknown) => void): unknown;
    removeListener(event: 'ready' | 'reconnecting', listener: () => void): unknown;
}

export function monitorRedisAvailability(
    client: RedisAvailabilityClient,
    logger: AvailabilityLogger,
    options: RedisAvailabilityMonitorOptions = {}
): RedisAvailabilityMonitor {
    const monitor = createAvailabilityMonitor(logger, { ...options, name: options.name ?? 'Redis' });
    const onError = (error: unknown) => monitor.unavailable(error);
    const onReconnecting = () => monitor.unavailable();
    const onReady = () => monitor.available();

    client.on('error', onError);
    client.on('reconnecting', onReconnecting);
    client.on('ready', onReady);

    return {
        unavailable: monitor.unavailable,
        available: monitor.available,
        stop() {
            client.removeListener('error', onError);
            client.removeListener('reconnecting', onReconnecting);
            client.removeListener('ready', onReady);
            monitor.stop();
        }
    };
}
