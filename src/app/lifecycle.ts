import { EventToken } from '../events';

export const onAppBootstrap = new EventToken('app.bootstrap');
export const onServerBootstrap = new EventToken('server.bootstrap');
export const onServerMainBootstrapDone = new EventToken('server.main-bootstrap-done');
export const onServerShutdownRequested = new EventToken('server.shutdown-requested');
export const onServerShutdown = new EventToken('server.shutdown');

const AutoConstructSymbol = Symbol('AutoConstruct');

export interface AutoConstructOptions {
    cli?: boolean;
}

interface AutoConstructMetadata {
    cli: boolean;
}

export function AutoConstruct(options: AutoConstructOptions = {}): ClassDecorator {
    return target => {
        (target as unknown as { [AutoConstructSymbol]?: AutoConstructMetadata })[AutoConstructSymbol] = {
            cli: options.cli === true
        };
    };
}

export function isAutoConstructProvider(value: unknown, options: AutoConstructOptions = {}): boolean {
    if (typeof value !== 'function') return false;
    const metadata = (value as unknown as { [AutoConstructSymbol]?: AutoConstructMetadata })[AutoConstructSymbol];
    return !!metadata && (options.cli !== true || metadata.cli);
}
