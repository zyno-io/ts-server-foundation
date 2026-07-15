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
        const removeShutdownListener = app.on(onServerShutdown, () => {
            this.shouldRun = false;
        });

        this.stop = () => {
            this.shouldRun = false;
            void app.stop();
        };

        try {
            app.configureForCliService();
            await app.http.listen();
            await this.startService();
            serviceStarted = true;

            if (hasRunService) await this.runService();
            else await new Promise<void>(resolve => app.on(onServerShutdown, () => resolve()));
        } finally {
            this.shouldRun = false;
            removeShutdownListener();
            if (serviceStarted) await this.shutdownService();
            await app.stop();
        }
    }

    protected async startService(): Promise<void> {}
    protected async runService(): Promise<void> {}
    protected async shutdownService(): Promise<void> {}
}
