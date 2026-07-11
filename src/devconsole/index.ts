import type { BaseAppConfig } from '../app/config';
import { DevConsoleController } from './controller';
import { DevConsoleRuntime } from './runtime';

export { DevConsoleController } from './controller';
export { DevConsoleLocalhostMiddleware, isLocalhostHttpRequest, isLocalhostIncomingMessage } from './security';
export { DevConsoleSrpcServer, collectProperties } from './server';
export { DevConsoleRuntime } from './runtime';
export * from './store';

export function shouldEnableDevConsole(config: Pick<BaseAppConfig, 'APP_ENV' | 'DEVCONSOLE_ENABLED'>): boolean {
    if (config.DEVCONSOLE_ENABLED !== undefined) return config.DEVCONSOLE_ENABLED === true;
    return config.APP_ENV === 'development';
}

export const DefaultDevConsoleController = DevConsoleController;
