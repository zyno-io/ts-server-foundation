import { r } from '../app/resolver';
import { App } from '../app/base';
import { onServerShutdown } from '../app/lifecycle';

export abstract class CliServiceCommand {
    protected shouldRun = true;
    public stop: () => void = () => {};

    async execute(): Promise<void> {
        const app = r(App);
        const hasRunService = this.runService !== CliServiceCommand.prototype.runService;
        let serviceStarted = false;
        let serviceFinished: Promise<void> | undefined;
        let finishService: (() => void) | undefined;
        let requestShutdown!: () => void;
        const shutdownRequested = new Promise<void>(resolve => {
            requestShutdown = resolve;
        });
        const removeShutdownListener = app.on(onServerShutdown, async () => {
            this.shouldRun = false;
            requestShutdown();
            await serviceFinished;
        });

        this.stop = () => {
            this.shouldRun = false;
            void app.stop();
        };

        try {
            app.configureForCliService();
            await app.http.listen();
            if (!this.shouldRun) return;
            serviceFinished = new Promise<void>(resolve => {
                finishService = resolve;
            });
            await this.startService();
            serviceStarted = true;

            if (hasRunService) await this.runService();
            else await shutdownRequested;
        } finally {
            this.shouldRun = false;
            try {
                if (serviceStarted) await this.shutdownService();
            } finally {
                // Release the shutdown listener before joining stop(), or each would await the other.
                finishService?.();
                removeShutdownListener();
                await app.stop();
            }
        }
    }

    protected async startService(): Promise<void> {}
    protected async runService(): Promise<void> {}
    protected async shutdownService(): Promise<void> {}
}
