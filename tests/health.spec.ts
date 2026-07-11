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

    async connect(): Promise<void> {
        this.connects++;
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

    it('registers /healthz by default and can disable it', async () => {
        process.env.APP_ENV = 'test';
        const app = createApp({});
        const disabled = createApp({ enableHealthcheck: false });

        try {
            const response = await app.request(HttpRequest.GET('/healthz'));
            const missing = await disabled.request(HttpRequest.GET('/healthz'));

            assert.equal(response.statusCode, 200);
            assert.equal(typeof response.json.version, 'string');
            assert.equal(missing.statusCode, 404);
        } finally {
            await Promise.all([app.stop(), disabled.stop()]);
        }
    });

    it('registers configured database as provider and health check', async () => {
        const driver = new FakeDriver();

        class AppDB extends BaseDatabase {
            constructor() {
                super(driver);
            }
        }

        process.env.APP_ENV = 'test';
        const app = createApp({ db: AppDB });

        try {
            const response = await app.request(HttpRequest.GET('/healthz'));

            assert.equal(response.statusCode, 200);
            assert.ok(app.get(AppDB) instanceof AppDB);
            assert.equal(driver.connects, 1);
        } finally {
            await app.stop();
        }
    });
});
