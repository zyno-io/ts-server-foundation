import { BaseJob, ScopedLogger, WorkerJob } from '../../src';
import { TestAppFeatureService } from '../modules/TestAppFeatureModule';

@WorkerJob()
export class TestAppWorkerJob extends BaseJob<{ name: string }, { output: string }> {
    constructor(
        private readonly feature: TestAppFeatureService,
        private readonly logger: ScopedLogger
    ) {
        super();
    }

    async handle(data: { name: string }): Promise<{ output: string }> {
        this.logger.info('test-app worker job handled', { name: data.name });
        return { output: `${this.feature.name}:${data.name}` };
    }
}
