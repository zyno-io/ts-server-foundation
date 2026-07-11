import { BaseAppConfig, createApp } from '../src';
import { TestAppController, ValidatingTestAppUserAuthMiddleware } from './controllers/TestApp.controller';
import { TestAppDatabase } from './database/TestAppDatabase';
import { TestAppFeatureModule } from './modules/TestAppFeatureModule';
import { TestAppLifecycleEvents, TestAppLifecycleListener } from './services/TestAppLifecycle.listener';
import { TestAppStartupProbe } from './services/TestAppStartupProbe';
import { TestAppUserService } from './services/TestAppUser.service';
import { TestAppWorkerJob } from './services/TestAppWorker.job';

export class TestAppConfig extends BaseAppConfig {
    APP_ENV = 'test';
    AUTH_JWT_SECRET = 'test-app-secret';
    AUTH_JWT_ISSUER = 'test-app';
    AUTH_JWT_EXPIRATION_MINS = 5;
    USE_REAL_IP_HEADER = true;
}

export function buildTestApp() {
    TestAppDatabase.driver.reset();

    return createApp({
        config: TestAppConfig,
        db: TestAppDatabase,
        imports: [TestAppFeatureModule],
        controllers: [TestAppController],
        providers: [TestAppUserService, TestAppStartupProbe, TestAppWorkerJob, TestAppLifecycleEvents, ValidatingTestAppUserAuthMiddleware],
        listeners: [TestAppLifecycleListener],
        enableWorker: true,
        enableHealthcheck: false,
        frameworkConfig: { port: 0 }
    });
}
