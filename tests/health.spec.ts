import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BaseDatabase,
    createApp,
    DatabaseDriver,
    DriverConnection,
    ExecuteResult,
    HealthcheckService,
    HttpRequest,
    QueryResult,
    RenderedSql
} from '../src';

class FakeConnection implements DriverConnection {
    async query<T = Record<string, unknown>>(_query: RenderedSql): Promise<QueryResult<T>> {
        return { rows: [] };
    }

    async execute(_query: RenderedSql): Promise<ExecuteResult> {
        return { affectedRows: 0 };
    }

    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {}
}

class FakeDriver implements DatabaseDriver {
    readonly dialect = 'postgres' as const;
    connects = 0;
    failuresRemaining = 0;

    async connect(): Promise<void> {
        this.connects++;
        if (this.failuresRemaining > 0) {
            this.failuresRemaining--;
            throw new Error('database unavailable');
        }
    }

    async close(): Promise<void> {}

    async acquire(): Promise<DriverConnection> {
        return new FakeConnection();
    }
}

describe('health checks', () => {
    it('runs registered checks and reports individual results', async () => {
        const service = new HealthcheckService();
        let checked = false;

        service.register('ok', () => {
            checked = true;
        });
        service.register('failed', () => {
            throw new Error('down');
        });

        await assert.rejects(() => service.check(), /down/);
        assert.equal(checked, true);
        assert.deepStrictEqual(await service.checkIndividual(), [
            { name: 'ok', status: 'ok' },
            { name: 'failed', status: 'error', error: 'down' }
        ]);
    });

    it('runs readiness and liveness checks independently', async () => {
        const service = new HealthcheckService();
        let readyChecks = 0;
        let livenessChecks = 0;

        service.registerReadyCheck('database', () => {
            readyChecks++;
        });
        service.registerLivenessCheck('event-loop', () => {
            livenessChecks++;
        });

        await service.checkReady();
        assert.equal(readyChecks, 1);
        assert.equal(livenessChecks, 0);

        await service.checkLiveness();
        assert.equal(readyChecks, 1);
        assert.equal(livenessChecks, 1);
    });

    it('runs probe checks from their matching endpoints', async () => {
        const app = createApp({});
        const service = app.get(HealthcheckService);
        let readyChecks = 0;
        let livenessChecks = 0;

        service.registerReadyCheck('database', () => {
            readyChecks++;
        });
        service.registerLivenessCheck('event-loop', () => {
            livenessChecks++;
        });

        try {
            const ready = await app.request(HttpRequest.GET('/readyz'));
            assert.equal(ready.statusCode, 200);
            assert.equal(readyChecks, 1);
            assert.equal(livenessChecks, 0);

            const live = await app.request(HttpRequest.GET('/livez'));
            assert.equal(live.statusCode, 200);
            assert.equal(readyChecks, 1);
            assert.equal(livenessChecks, 1);
        } finally {
            await app.stop();
        }
    });

    it('registers health, readiness, and liveness endpoints by default and can disable them', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({});
        const disabled = createApp({ enableHealthcheck: false });

        try {
            const health = await app.request(HttpRequest.GET('/healthz'));
            const ready = await app.request(HttpRequest.GET('/readyz'));
            const live = await app.request(HttpRequest.GET('/livez'));
            const missing = await Promise.all([
                disabled.request(HttpRequest.GET('/healthz')),
                disabled.request(HttpRequest.GET('/readyz')),
                disabled.request(HttpRequest.GET('/livez'))
            ]);

            assert.equal(health.statusCode, 200);
            assert.equal(typeof health.json.version, 'string');
            assert.equal(ready.statusCode, 200);
            assert.deepStrictEqual(ready.json, { ok: true });
            assert.equal(live.statusCode, 200);
            assert.deepStrictEqual(live.json, { ok: true });
            assert.deepStrictEqual(
                missing.map(response => response.statusCode),
                [404, 404, 404]
            );
        } finally {
            await Promise.all([app.stop(), disabled.stop()]);
        }
    });

    it('caches a successful database health check for 30 seconds', async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
        const driver = new FakeDriver();

        class AppDB extends BaseDatabase {
            constructor() {
                super(driver);
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ db: AppDB });

        try {
            const first = await app.request(HttpRequest.GET('/healthz'));
            const cached = await app.request(HttpRequest.GET('/healthz'));

            t.mock.timers.tick(29_999);
            const stillCached = await app.request(HttpRequest.GET('/healthz'));

            t.mock.timers.tick(1);
            const refreshed = await app.request(HttpRequest.GET('/healthz'));

            assert.equal(first.statusCode, 200);
            assert.equal(cached.statusCode, 200);
            assert.equal(stillCached.statusCode, 200);
            assert.equal(refreshed.statusCode, 200);
            assert.ok(app.get(AppDB) instanceof AppDB);
            assert.equal(driver.connects, 2);
        } finally {
            await app.stop();
        }
    });

    it('retries a database health check immediately after failure', async () => {
        const driver = new FakeDriver();
        driver.failuresRemaining = 1;

        class AppDB extends BaseDatabase {
            constructor() {
                super(driver);
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ db: AppDB });
        const healthcheck = app.get(HealthcheckService);

        try {
            await assert.rejects(() => healthcheck.check(), /database unavailable/);
            await healthcheck.check();
            assert.equal(driver.connects, 2);
        } finally {
            await app.stop();
        }
    });
});
