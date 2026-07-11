import type { Token } from '../di';
import { BaseAppConfig } from './config';
import { getCurrentApp } from './base';

export function resolve<T>(token: Token<T>): T {
    return getCurrentApp().get(token);
}

export const r = resolve;

export function getAppConfig<T extends BaseAppConfig = BaseAppConfig>(token: Token<T> = BaseAppConfig as Token<T>): T {
    return resolve(token);
}
