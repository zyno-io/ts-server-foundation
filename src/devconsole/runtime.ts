import type { Server } from 'node:http';

import type { App } from '../app';
import type { ScopedLogger } from '../services';
import { installDevConsoleObservers } from './observers';
import { DevConsoleSrpcServer } from './server';
import { DevConsoleStore } from './store';

export class DevConsoleRuntime {
    readonly store = new DevConsoleStore();
    private cleanupObservers?: () => void;
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
    }

    close(): void {
        this.store.onEvent = undefined;
        this.srpc?.close();
        this.srpc = undefined;
        this.cleanupObservers?.();
        this.cleanupObservers = undefined;
    }

    private installObservers(): void {
        this.cleanupObservers ??= installDevConsoleObservers(this.app, this.store);
    }
}
