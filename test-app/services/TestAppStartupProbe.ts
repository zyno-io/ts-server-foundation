import { AutoConstruct, ScopedLogger } from '../../src';
import { TestAppFeatureService } from '../modules/TestAppFeatureModule';

@AutoConstruct()
export class TestAppStartupProbe {
    readonly startedAt = new Date();

    constructor(
        readonly feature: TestAppFeatureService,
        readonly logger: ScopedLogger
    ) {
        this.logger.info('test-app startup probe initialized', { feature: feature.name });
    }
}
