import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { Env, JWT, onAppBootstrap, onServerShutdown, onServerShutdownRequested } from '../src';
import { buildTestApp } from './app';
import { TestAppDatabase } from './database/TestAppDatabase';
import { TestAppLifecycleEvents } from './services/TestAppLifecycle.listener';
import { TestAppStartupProbe } from './services/TestAppStartupProbe';

interface CreateUserResponse {
    user: {
        id: number;
        name: string;
        role: string | null;
    };
    count: number;
    names: string[];
    rawTag: string;
    rawUserName: string;
    initialRole: string | null;
    mutationAffectedRows: number;
    workerResult: string;
    recordedJob: {
        name: string;
        status: string;
        result: unknown;
    };
    hooks: string[];
    loggerScope: string;
    featureName: string;
    requestedBy: string;
    remoteAddress: string;
}

async function main(): Promise<void> {
    Env.APP_ENV = 'test';

    const app = buildTestApp();
    const lifecycleEvents: string[] = [];
    let stopAttempted = false;
    const stopApp = async () => {
        if (stopAttempted) return;
        stopAttempted = true;
        await app.stop();
    };

    app.on(onAppBootstrap, () => {
        lifecycleEvents.push('bootstrap');
    });
    app.on(onServerShutdownRequested, () => {
        lifecycleEvents.push('shutdown-requested');
    });
    app.on(onServerShutdown, () => {
        lifecycleEvents.push('shutdown');
    });

    try {
        const server = await app.http.listen(0, '127.0.0.1');
        const port = getServerPort(server.address());
        const baseUrl = `http://127.0.0.1:${port}`;

        assert.deepEqual(lifecycleEvents, ['bootstrap']);
        const startupProbe = app.get(TestAppStartupProbe);
        assert.equal(startupProbe.feature.name, 'global-feature-export');
        assert.equal(startupProbe.logger.scope, 'TestAppStartupProbe');
        assert.deepEqual(app.get(TestAppLifecycleEvents).events, [
            'listener-bootstrap',
            'listener-server-bootstrap',
            'listener-server-main-bootstrap-done'
        ]);

        const adminToken = await JWT.generate({
            subject: 'operator-1',
            payload: { role: 'admin' }
        });

        const created = await postJson<CreateUserResponse>(`${baseUrl}/test-app/users`, { name: 'Alpha' }, adminToken);
        assert.equal(created.user.id, 1);
        assert.equal(created.user.name, 'Alpha-saved');
        assert.equal(created.user.role, 'member');
        assert.equal(created.count, 1);
        assert.deepEqual(created.names, ['Alpha-saved']);
        assert.equal(created.rawTag, 'bound-ok');
        assert.equal(created.rawUserName, 'Alpha-saved');
        assert.equal(created.initialRole, 'admin');
        assert.equal(created.mutationAffectedRows, 1);
        assert.equal(created.workerResult, 'global-feature-export:Alpha-saved');
        assert.deepEqual(created.recordedJob, {
            name: 'TestAppWorkerJob',
            status: 'completed',
            result: { output: 'global-feature-export:Alpha-saved' }
        });
        assert.deepEqual(created.hooks, ['pre', 'post']);
        assert.equal(created.loggerScope, 'TestAppUserService');
        assert.equal(created.featureName, 'global-feature-export');
        assert.equal(created.requestedBy, 'operator-1');
        assert.equal(created.remoteAddress, '127.0.0.1');

        const fetched = await getJson<{ id: number; name: string; role: string | null }>(`${baseUrl}/test-app/users/${created.user.id}`);
        assert.deepEqual(fetched, created.user);

        const userToken = await JWT.generate({
            subject: String(created.user.id),
            payload: { role: 'member' }
        });
        const me = await getJson<{ jwtSubject: string; user: CreateUserResponse['user'] }>(`${baseUrl}/test-app/me`, userToken);
        assert.deepEqual(me, {
            jwtSubject: String(created.user.id),
            user: created.user
        });

        const unauthorized = await fetch(`${baseUrl}/test-app/me`);
        assert.equal(unauthorized.status, 401);

        const missingUserToken = await JWT.generate({
            subject: '999',
            payload: { role: 'member' }
        });
        const missingUser = await fetch(`${baseUrl}/test-app/me`, {
            headers: { authorization: `Bearer ${missingUserToken}` }
        });
        assert.equal(missingUser.status, 401);

        const status = await getJson<{
            ok: true;
            source: string;
            featureName: string;
            serviceLoggerScope: string;
            controllerLoggerScope: string;
            remoteAddress: string;
        }>(`${baseUrl}/test-app/status?source=bootstrap`, undefined, {
            'x-forwarded-for': '203.0.113.10, 10.0.0.2'
        });
        assert.deepEqual(status, {
            ok: true,
            source: 'bootstrap',
            featureName: 'global-feature-export',
            serviceLoggerScope: 'TestAppUserService',
            controllerLoggerScope: 'TestAppController',
            remoteAddress: '203.0.113.10'
        });

        const uploadForm = new FormData();
        uploadForm.set('_payload', JSON.stringify({ description: 'test-app upload' }));
        uploadForm.set('file', new Blob(['test-app-file'], { type: 'text/plain' }), 'test-app.txt');
        const upload = await postForm<{
            description: string;
            file: {
                originalName: string;
                type: string;
                size: number;
                contents: string;
            };
        }>(`${baseUrl}/test-app/upload`, uploadForm);
        assert.deepEqual(upload, {
            description: 'test-app upload',
            file: {
                originalName: 'test-app.txt',
                type: 'text/plain',
                size: 'test-app-file'.length,
                contents: 'test-app-file'
            }
        });

        assert.deepEqual(TestAppDatabase.driver.commands.slice(0, 4), ['begin', 'savepoint:after-create', 'commit', 'release']);
        assert.equal(TestAppDatabase.driver.commands.includes('rollback'), false);
        assert.equal(TestAppDatabase.driver.activeConnections, 0);
        assert.ok(
            TestAppDatabase.driver.statements.some(
                statement =>
                    statement.mode === 'query' &&
                    statement.sql.startsWith('INSERT INTO "test_app_users"') &&
                    statement.sql.endsWith(' RETURNING "id"')
            )
        );
        assert.ok(TestAppDatabase.driver.statements.some(statement => statement.sql === 'SELECT $1 AS tag' && statement.bindings[0] === 'bound-ok'));
        assert.ok(
            TestAppDatabase.driver.statements.some(
                statement => statement.sql === 'SELECT pg_advisory_xact_lock($1, $2)' && statement.bindings.length === 2
            )
        );

        await stopApp();
        assert.deepEqual(lifecycleEvents, ['bootstrap', 'shutdown-requested', 'shutdown']);
        assert.deepEqual(app.get(TestAppLifecycleEvents).events, [
            'listener-bootstrap',
            'listener-server-bootstrap',
            'listener-server-main-bootstrap-done',
            'listener-shutdown-requested',
            'listener-shutdown'
        ]);

        console.log('test-app passed');
    } finally {
        await stopApp();
    }
}

async function postJson<T>(url: string, body: unknown, bearerToken: string): Promise<T> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${bearerToken}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    await assertStatus(response, 201);
    return parseJson<T>(response);
}

async function getJson<T>(url: string, bearerToken?: string, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(url, {
        headers: {
            ...headers,
            ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {})
        }
    });
    await assertStatus(response, 200);
    return parseJson<T>(response);
}

async function postForm<T>(url: string, body: FormData): Promise<T> {
    const response = await fetch(url, {
        method: 'POST',
        body
    });
    await assertStatus(response, 200);
    return parseJson<T>(response);
}

async function assertStatus(response: Response, status: number): Promise<void> {
    if (response.status === status) return;
    assert.equal(response.status, status, await response.text());
}

async function parseJson<T>(response: { text(): Promise<string> }): Promise<T> {
    return JSON.parse(await response.text()) as T;
}

function getServerPort(address: string | AddressInfo | null): number {
    assert.ok(address && typeof address === 'object');
    return address.port;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
