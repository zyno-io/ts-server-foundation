export const DEFAULT_AVAILABILITY_ALERT_AFTER_MS = 60_000;

export interface AvailabilityLogger {
    info(...messages: unknown[]): void;
    warning(...messages: unknown[]): void;
    error(...messages: unknown[]): void;
}

export interface AvailabilityMonitorOptions {
    alertAfterMs?: number;
    name?: string;
}

export interface AvailabilityMonitor {
    unavailable(error?: unknown): void;
    available(): void;
    stop(): void;
}

export function createAvailabilityMonitor(logger: AvailabilityLogger, options: AvailabilityMonitorOptions = {}): AvailabilityMonitor {
    const alertAfterMs = Number(options.alertAfterMs ?? DEFAULT_AVAILABILITY_ALERT_AFTER_MS);
    if (!Number.isFinite(alertAfterMs) || alertAfterMs < 0) {
        throw new Error('Availability alert delay must be a non-negative number');
    }

    const name = options.name ?? 'Dependency';
    let unavailableAt: number | undefined;
    let lastError: unknown;
    let alertTimer: NodeJS.Timeout | undefined;
    let alerted = false;
    let stopped = false;

    const clearAlertTimer = () => {
        if (alertTimer) clearTimeout(alertTimer);
        alertTimer = undefined;
    };

    const reportUnavailable = () => {
        alertTimer = undefined;
        if (stopped || unavailableAt === undefined || alerted) return;
        alerted = true;
        const unavailableForMs = Date.now() - unavailableAt;
        if (lastError === undefined) {
            logger.error(`${name} remains unavailable`, { unavailableForMs });
        } else {
            logger.error(`${name} remains unavailable`, lastError, { unavailableForMs });
        }
    };

    const unavailable = (error?: unknown) => {
        if (stopped) return;
        if (error !== undefined) lastError = error;
        if (unavailableAt !== undefined) return;

        unavailableAt = Date.now();
        logger.warning(`${name} is temporarily unavailable`, {
            alertAfterMs,
            errorMessage: getErrorMessage(error)
        });

        if (alertAfterMs === 0) {
            reportUnavailable();
            return;
        }
        alertTimer = setTimeout(reportUnavailable, alertAfterMs);
        alertTimer.unref?.();
    };

    const available = () => {
        if (stopped || unavailableAt === undefined) return;
        const unavailableForMs = Date.now() - unavailableAt;
        const reported = alerted;
        clearAlertTimer();
        unavailableAt = undefined;
        lastError = undefined;
        alerted = false;
        logger.info(`${name} recovered`, { unavailableForMs, alerted: reported });
    };

    return {
        unavailable,
        available,
        stop() {
            if (stopped) return;
            stopped = true;
            clearAlertTimer();
        }
    };
}

function getErrorMessage(error: unknown): string | undefined {
    if (error === undefined) return undefined;
    return error instanceof Error ? error.message : String(error);
}
