import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const requireFromTest = createRequire(__filename);

describe('package exports', () => {
    it('exports only the root API, type compiler, and OTel bootstrap', () => {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
            exports: Record<string, string | { types: string; import: string; require: string }>;
        };

        assert.deepStrictEqual(Object.keys(pkg.exports), ['.', './type-compiler', './otel']);
        assert.equal(pkg.exports['./type-compiler'], './dist/src/type-compiler/index.cjs');
        assert.deepStrictEqual(pkg.exports['./otel'], {
            types: './dist/src/telemetry/otel/index.d.ts',
            import: './dist/src/telemetry/otel/index.js',
            require: './dist/src/telemetry/otel/index.js'
        });
    });

    it('loads the package root as the public application API', () => {
        const root = requireFromTest('@zyno-io/ts-server-foundation');

        assert.equal(typeof root.createApp, 'function');
        assert.equal(typeof root.Env, 'object');
        assert.equal(typeof root.HttpRequest, 'function');
        assert.equal(typeof root.HttpCorsOptions, 'function');
        assert.equal(typeof root.createAvailabilityMonitor, 'function');
        assert.equal(typeof root.monitorRedisAvailability, 'function');
        assert.equal(typeof root.BaseDatabase, 'function');
        assert.equal(typeof root.sql, 'function');
        assert.equal(typeof root.MigrationRunner, 'function');
        assert.equal(typeof root.createMigrationPlan, 'function');
        assert.equal(typeof root.TestingHelpers.createTestingFacade, 'function');
        assert.equal(typeof root.WorkerService, 'function');
        assert.equal(typeof root.LeaderService, 'function');
        assert.equal(typeof root.MailService, 'function');
        assert.equal(typeof root.MeshService, 'function');
        assert.equal(typeof root.MeshClientService, 'function');
        assert.equal(typeof root.SrpcClient, 'function');
        assert.equal(typeof root.serializeOpenApiSchema, 'function');
        assert.equal(typeof root.deserializer.addDecorator, 'function');
        assert.equal(root.serializer, undefined);
        assert.equal(typeof root.installSentry, 'function');
        assert.equal(typeof root.withSpan, 'function');
        assert.equal(typeof root.DevConsoleController, 'function');
        assert.equal(root.init, undefined);
    });

    it('loads the type compiler subpath as a plugin descriptor', () => {
        const typeCompiler = requireFromTest('@zyno-io/ts-server-foundation/type-compiler');
        assert.equal(typeof typeCompiler, 'function');
    });

    it('loads the OTel bootstrap subpath outside the root export', () => {
        const otel = requireFromTest('@zyno-io/ts-server-foundation/otel');
        assert.equal(typeof otel.init, 'function');
    });

    it('type-checks representative imports from the root and OTel entrypoints', () => {
        const directory = mkdtempSync(join(process.cwd(), '.tmp-public-api-'));
        const fixture = join(directory, 'imports.ts');
        writeFileSync(
            fixture,
            `
                import {
                    AlphanumericCharacters,
                    App,
                    BaseAppConfig,
                    BaseDatabase,
                    BaseEntity,
                    Cache,
                    Container,
                    Crypto,
                    DevConsoleStore,
                    EventBus,
                    FileUpload,
                    HealthcheckService,
                    HttpRequest,
                    JWT,
                    LeaderService,
                    MailService,
                    MeshService,
                    MigrationRunner,
                    ReflectionClass,
                    ReflectionKind,
                    SrpcClient,
                    TestingHelpers,
                    WorkerService,
                    createAvailabilityMonitor,
                    createLogger,
                    deserialize,
                    http,
                    installSentry,
                    monitorRedisAvailability,
                    serializeOpenApiSchema,
                    sql,
                    typeOf,
                    validate,
                    withResourceCleanup,
                    withSpan,
                    type DateString,
                    type AvailabilityMonitor,
                    type HttpBody,
                    type Type
                } from '@zyno-io/ts-server-foundation';
                import {
                    init,
                    shutdownTelemetry,
                    type TelemetryInitOptions
                } from '@zyno-io/ts-server-foundation/otel';

                type Input = HttpBody<{ birthday: DateString }>;
                const reflected: Type = typeOf<Input>();
                const telemetry: TelemetryInitOptions = { disabled: true };
                const availability: AvailabilityMonitor | undefined = undefined;
                void [
                    AlphanumericCharacters,
                    App,
                    BaseAppConfig,
                    BaseDatabase,
                    BaseEntity,
                    Cache,
                    Container,
                    Crypto,
                    DevConsoleStore,
                    EventBus,
                    FileUpload,
                    HealthcheckService,
                    HttpRequest,
                    JWT,
                    LeaderService,
                    MailService,
                    MeshService,
                    MigrationRunner,
                    ReflectionClass,
                    ReflectionKind,
                    SrpcClient,
                    TestingHelpers,
                    WorkerService,
                    availability,
                    createAvailabilityMonitor,
                    createLogger,
                    deserialize,
                    http,
                    init,
                    installSentry,
                    monitorRedisAvailability,
                    reflected,
                    serializeOpenApiSchema,
                    shutdownTelemetry,
                    sql,
                    telemetry,
                    validate,
                    withResourceCleanup,
                    withSpan
                ];
            `,
            'utf8'
        );

        try {
            const typescript = requireFromTest.resolve('typescript');
            execFileSync(
                process.execPath,
                [
                    join(dirname(typescript), 'tsc.js'),
                    '--ignoreConfig',
                    '--noEmit',
                    '--strict',
                    '--skipLibCheck',
                    '--target',
                    'ES2022',
                    '--module',
                    'Node16',
                    '--moduleResolution',
                    'Node16',
                    fixture
                ],
                { cwd: process.cwd(), stdio: 'pipe' }
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not preload instrumented libraries when importing the OTel bootstrap', () => {
        const output = execFileSync(
            process.execPath,
            [
                '-e',
                `
                    require('@zyno-io/ts-server-foundation/otel');
                    const instrumentedPackages = ['ioredis', 'mysql2', 'pg', 'undici'];
                    const cachedModules = Object.keys(require.cache).map(filename => filename.replaceAll('\\\\', '/'));
                    const loadedPackages = instrumentedPackages.filter(packageName =>
                        cachedModules.some(filename => filename.includes('/node_modules/' + packageName + '/'))
                    );
                    process.stdout.write(JSON.stringify(loadedPackages));
                `
            ],
            { cwd: process.cwd(), encoding: 'utf8' }
        );

        assert.deepStrictEqual(JSON.parse(output), []);
    });

    it('does not expose internal implementation subpaths', () => {
        const privateSubpaths = [
            '@zyno-io/ts-server-foundation/package.json',
            '@zyno-io/ts-server-foundation/env',
            '@zyno-io/ts-server-foundation/http',
            '@zyno-io/ts-server-foundation/http/cors.js',
            '@zyno-io/ts-server-foundation/database/sql',
            '@zyno-io/ts-server-foundation/services/logger',
            '@zyno-io/ts-server-foundation/services/worker/runner',
            '@zyno-io/ts-server-foundation/srpc/SrpcClient',
            '@zyno-io/ts-server-foundation/testing',
            '@zyno-io/ts-server-foundation/testing/index.js',
            '@zyno-io/ts-server-foundation/openapi/schema',
            '@zyno-io/ts-server-foundation/telemetry/sentry',
            '@zyno-io/ts-server-foundation/otel/index',
            '@zyno-io/ts-server-foundation/otel/index.js',
            '@zyno-io/ts-server-foundation/telemetry/otel',
            '@zyno-io/ts-server-foundation/telemetry/otel/index',
            '@zyno-io/ts-server-foundation/telemetry/otel/index.js'
        ];

        for (const subpath of privateSubpaths) {
            assert.throws(() => requireFromTest(subpath), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, subpath);
        }
    });
});
