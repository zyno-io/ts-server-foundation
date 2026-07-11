import type { App } from './base';
import type { BaseAppConfig } from './config';

let currentApp: App<BaseAppConfig> | undefined;

export function setCurrentApp<C extends BaseAppConfig>(app: App<C>): void {
    currentApp = app as unknown as App<BaseAppConfig>;
}

export function getCurrentApp(): App {
    if (!currentApp) throw new Error('No app initialized');
    return currentApp;
}
