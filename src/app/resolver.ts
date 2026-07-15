import type { Token } from '../di';
import type { AppCleanup } from './base';
import { BaseAppConfig } from './config';
import { getCurrentApp } from './base';

export function resolve<T>(token: Token<T>): T {
    return getCurrentApp().get(token);
}

export const r = resolve;

/**
 * Registers cleanup for a resource owned by the current application instance.
 *
 * Registered callbacks run exactly once during `App.stop()`, in reverse registration order, after the normal
 * server shutdown lifecycle has completed. They also run when `stop()` follows a partial or failed startup,
 * allowing resources acquired before the app became fully started to be released safely. Shutdown attempts
 * every registered cleanup and reports any failures after all callbacks have been given a chance to run.
 *
 * The returned function unregisters the callback when the resource is released earlier. Callers should use
 * that function to prevent the app from retaining the callback and to avoid repeating an already-completed
 * cleanup during shutdown.
 */
export function registerAppCleanup(cleanup: AppCleanup): () => void {
    return getCurrentApp().registerCleanup(cleanup);
}

export function getAppConfig<T extends BaseAppConfig = BaseAppConfig>(token: Token<T> = BaseAppConfig as Token<T>): T {
    return resolve(token);
}
