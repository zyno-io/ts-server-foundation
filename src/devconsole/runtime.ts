import type { Server } from 'node:http';

import type { App } from '../app';
import { publishDevConsoleEndpoint } from '../cli/dev-state';
import type { ScopedLogger } from '../services';
import { installDevConsoleObservers } from './observers';
import { DevConsoleSrpcServer } from './server';
import { DevConsoleStore } from './store';

export class DevConsoleRuntime {
    readonly store = new DevConsoleStore();
    private cleanupObservers?: () => void;
    private cleanupProcessDiscovery?: () => void;
    private srpc?: DevConsoleSrpcServer;

    constructor(
        private readonly app: App<any>,
        private readonly logger: ScopedLogger
    ) {
        this.installObservers();
    }

    start(server: Server): void {
        this.installObservers();
        if (this.srpc) return;
        this.srpc = new DevConsoleSrpcServer(this.app, this.store, this.logger.scoped('devconsole'), server);
        this.store.onEvent = (type, data) => this.srpc?.broadcast(type, data);
        try {
            this.cleanupProcessDiscovery = publishDevConsoleEndpoint(server);
        } catch (error) {
            this.logger.warn('Failed to publish tsf-dev process discovery state', error);
        }
    }

    close(): void {
        this.store.onEvent = undefined;
        try {
            this.cleanupProcessDiscovery?.();
        } catch (error) {
            this.logger.warn('Failed to clear tsf-dev process discovery state', error);
        }
        this.cleanupProcessDiscovery = undefined;
        this.srpc?.close();
        this.srpc = undefined;
        this.cleanupObservers?.();
        this.cleanupObservers = undefined;
    }

    private installObservers(): void {
        this.cleanupObservers ??= installDevConsoleObservers(this.app, this.store);
    }
}
