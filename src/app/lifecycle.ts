import { EventToken } from '../events';

export const onAppBootstrap = new EventToken('app.bootstrap');
export const onServerBootstrap = new EventToken('server.bootstrap');
export const onServerMainBootstrapDone = new EventToken('server.main-bootstrap-done');
export const onServerShutdownRequested = new EventToken('server.shutdown-requested');
export const onServerShutdown = new EventToken('server.shutdown');

const AutoConstructSymbol = Symbol('AutoConstruct');

export function AutoConstruct(): ClassDecorator {
    return target => {
        (target as any)[AutoConstructSymbol] = true;
    };
}

export function isAutoConstructProvider(value: unknown): boolean {
    return typeof value === 'function' && !!(value as any)[AutoConstructSymbol];
}
