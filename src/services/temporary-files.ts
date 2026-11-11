import { AutoConstruct, onServerBootstrap, onServerShutdownRequested } from '../app/lifecycle';
import { eventDispatcher } from '../events';
import { temporaryFiles } from '../helpers/io/temporary-files';
import { createLogger } from './logger';

/** Local temporary disk cannot be reclaimed by an elected/distributed worker. */
@AutoConstruct({ cli: true })
export class TemporaryFileCleanupService {
    private readonly logger = createLogger(this);
    private timer?: ReturnType<typeof setInterval>;

    @eventDispatcher.listen(onServerBootstrap)
    async start(): Promise<void> {
        if (this.timer) return;
        this.timer = setInterval(() => void this.sweep(), 60_000);
        this.timer.unref();
        await this.sweep();
    }

    @eventDispatcher.listen(onServerShutdownRequested)
    async stop(): Promise<void> {
        clearInterval(this.timer);
        this.timer = undefined;
        await temporaryFiles.close();
    }

    private async sweep(): Promise<void> {
        try {
            const result = await temporaryFiles.sweep();
            if (result.removed || result.retained || result.failed) this.logger.info('Temporary workspace cleanup finished', result);
        } catch {
            this.logger.warn('Temporary workspace cleanup scan failed');
        }
    }
}
