import { createModule } from '../../src';

export class TestAppFeatureService {
    readonly name = 'global-feature-export';
}

export const TestAppFeatureModule = createModule({
    providers: [TestAppFeatureService],
    exports: [TestAppFeatureService]
});
