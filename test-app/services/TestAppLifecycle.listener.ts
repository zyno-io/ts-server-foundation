import {
    eventDispatcher,
    onAppBootstrap,
    onServerBootstrap,
    onServerMainBootstrapDone,
    onServerShutdown,
    onServerShutdownRequested
} from '../../src';

export class TestAppLifecycleEvents {
    readonly events: string[] = [];
}

export class TestAppLifecycleListener {
    constructor(private readonly lifecycle: TestAppLifecycleEvents) {}

    @eventDispatcher.listen(onAppBootstrap)
    onBootstrap() {
        this.lifecycle.events.push('listener-bootstrap');
    }

    @eventDispatcher.listen(onServerBootstrap)
    onServerBootstrap() {
        this.lifecycle.events.push('listener-server-bootstrap');
    }

    @eventDispatcher.listen(onServerMainBootstrapDone)
    onServerMainBootstrapDone() {
        this.lifecycle.events.push('listener-server-main-bootstrap-done');
    }

    @eventDispatcher.listen(onServerShutdownRequested)
    onShutdownRequested() {
        this.lifecycle.events.push('listener-shutdown-requested');
    }

    @eventDispatcher.listen(onServerShutdown)
    onShutdown() {
        this.lifecycle.events.push('listener-shutdown');
    }
}
