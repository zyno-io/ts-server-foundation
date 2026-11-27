import assert from 'node:assert/strict';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const directories: string[] = [];
const requireFromTest = createRequire(__filename);
const compilerCache = resolve(process.env.TTSC_CACHE_DIR ?? '.yarn/ttsc-cache');

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'tsf-packed-pnp-'));
    directories.push(directory);
    return directory;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): void {
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        // This fixture creates its lockfile during the test, so it must not inherit
        // Yarn's CI default of immutable installs from the repository job.
        env: { ...process.env, TTSC_CACHE_DIR: compilerCache, ...env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
        timeout: 180_000
    });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
}

describe('packed Yarn PnP consumer', () => {
    it('installs, reflects external types for HTTP and ReceiveType, and runs proto generation', { timeout: 240_000 }, () => {
        const root = process.cwd();
        const directory = temporaryDirectory();
        const externalDir = join(directory, 'external');
        const externalTarball = join(directory, 'pnp-receive-fixture-1.0.0.tgz');
        const consumer = join(directory, 'consumer');
        const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
            version: string;
            devDependencies: Record<string, string>;
        };
        const reflectionPackage = JSON.parse(readFileSync(join(root, 'packages', 'reflection', 'package.json'), 'utf8')) as { version: string };
        const foundationTarball = join(directory, `zyno-io-ts-server-foundation-${rootPackage.version}.tgz`);
        const reflectionTarball = join(directory, `zyno-io-ts-reflection-${reflectionPackage.version}.tgz`);
        const utilsPackage = JSON.parse(readFileSync(join(root, 'packages', 'utils', 'package.json'), 'utf8')) as { version: string };
        const utilsTarball = join(directory, `zyno-io-ts-utils-${utilsPackage.version}.tgz`);

        run('yarn', ['pack', '--out', foundationTarball], root);
        run('yarn', ['workspace', '@zyno-io/ts-reflection', 'pack', '--out', reflectionTarball], root);
        run('yarn', ['workspace', '@zyno-io/ts-utils', 'pack', '--out', utilsTarball], root);
        mkdirSync(externalDir, { recursive: true });
        writeFileSync(
            join(externalDir, 'package.json'),
            JSON.stringify({
                name: 'pnp-receive-fixture',
                version: '1.0.0',
                main: 'index.js',
                types: 'index.d.ts',
                files: ['index.js', 'index.d.ts', 'dist'],
                devDependencies: { typescript: rootPackage.devDependencies.typescript }
            })
        );
        mkdirSync(join(externalDir, 'node_modules'), { recursive: true });
        symlinkSync(dirname(requireFromTest.resolve('typescript/package.json')), join(externalDir, 'node_modules', 'typescript'), 'junction');
        writeFileSync(
            join(externalDir, 'rules.ts'),
            `export interface PackedRuleSet<T> { all?: T[] }
export interface PackedNameRule { type: 'name'; name: string }
export interface PackedCountRule { type: 'count'; count: number }
`
        );
        writeFileSync(
            join(externalDir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    outDir: 'dist',
                    declaration: true,
                    strict: true,
                    types: [],
                    plugins: [
                        {
                            transform: join(root, 'packages', 'reflection', 'src', 'type-compiler', 'index.cjs'),
                            emitMetadataRuntimeImport: false
                        }
                    ]
                },
                include: ['rules.ts'],
                reflection: true
            })
        );
        const ttscLauncher = join(dirname(requireFromTest.resolve('ttsc/package.json')), 'lib', 'launcher', 'ttsc.js');
        run(process.execPath, [ttscLauncher, '-p', 'tsconfig.json'], externalDir);
        writeFileSync(
            join(externalDir, 'index.js'),
            "exports.receive = value => value; exports.__tsfTypeAliases = require('./dist/rules').__tsfTypeAliases;\n"
        );
        writeFileSync(
            join(externalDir, 'index.d.ts'),
            `export type { PackedRuleSet, PackedNameRule, PackedCountRule } from './dist/rules';
export declare function receive<T>(value?: import('@zyno-io/ts-server-foundation').ReceiveType<T>): T;
`
        );
        run('npm', ['pack', '--pack-destination', directory], externalDir);

        mkdirSync(consumer, { recursive: true });
        writeFileSync(
            join(consumer, 'package.json'),
            JSON.stringify({
                private: true,
                dependencies: {
                    '@zyno-io/ts-server-foundation': `file:${foundationTarball}`,
                    '@zyno-io/ts-reflection': `file:${reflectionTarball}`,
                    '@zyno-io/ts-utils': `file:${utilsTarball}`,
                    'pnp-receive-fixture': `file:${externalTarball}`
                },
                resolutions: {
                    '@zyno-io/ts-server-foundation': `file:${foundationTarball}`,
                    '@zyno-io/ts-reflection': `file:${reflectionTarball}`,
                    '@zyno-io/ts-utils': `file:${utilsTarball}`
                },
                devDependencies: {
                    '@types/node': rootPackage.devDependencies['@types/node'],
                    ttsc: rootPackage.devDependencies.ttsc,
                    typescript: rootPackage.devDependencies.typescript
                },
                packageManager: 'yarn@4.18.1'
            })
        );
        // Exercise the packed packages with the same dependencies as the repository build.
        copyFileSync(join(root, 'yarn.lock'), join(consumer, 'yarn.lock'));
        cpSync(join(root, '.yarn', 'cache'), join(consumer, '.yarn', 'cache'), { recursive: true, mode: constants.COPYFILE_FICLONE });
        writeFileSync(join(consumer, '.yarnrc.yml'), 'nodeLinker: pnp\nenableGlobalCache: false\n');
        writeFileSync(
            join(consumer, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    experimentalDecorators: true,
                    esModuleInterop: true,
                    types: ['node'],
                    plugins: [{ transform: '@zyno-io/ts-reflection/type-compiler' }]
                },
                include: ['src/**/*.ts'],
                reflection: true
            })
        );
        mkdirSync(join(consumer, 'src'), { recursive: true });
        writeFileSync(
            join(consumer, 'src', 'index.ts'),
            `import assert from 'node:assert/strict';
import { createApp, http, HttpRequest, serializeOpenApiSchema, type HttpBody, typeOf } from '@zyno-io/ts-server-foundation';
import { receive, type PackedRuleSet, type PackedCountRule, type PackedNameRule } from 'pnp-receive-fixture';

assert.ok(receive<{ id: string }>());
assert.ok(typeOf<{ id: string }>());

interface ExportRequest {
    filters?: { activity?: PackedRuleSet<PackedNameRule | PackedCountRule> };
}

@http.controller('/export')
class ExportController {
    @http.POST()
    preview(_body: HttpBody<ExportRequest>) {
        return { ok: true };
    }
}

async function verify() {
    const app = createApp({ controllers: [ExportController], enableHealthcheck: false });
    const valid = await app.request(HttpRequest.POST('/export', { filters: { activity: { all: [{ type: 'count', count: 3 }] } } }));
    assert.equal(valid.statusCode, 200);
    const invalid = await app.request(HttpRequest.POST('/export', { filters: { activity: { all: [{ type: 'count' }] } } }));
    assert.equal(invalid.statusCode, 400);

    const doc = serializeOpenApiSchema(app);
    assert.deepEqual(doc.components?.schemas?.PackedRuleSet.properties?.all, {
        type: 'array',
        items: {
            oneOf: [
                { $ref: '#/components/schemas/PackedNameRule' },
                { $ref: '#/components/schemas/PackedCountRule' }
            ],
            discriminator: {
                propertyName: 'type',
                mapping: { name: '#/components/schemas/PackedNameRule', count: '#/components/schemas/PackedCountRule' }
            }
        }
    });
}

void verify().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
`
        );
        writeFileSync(join(consumer, 'schema.proto'), 'syntax = "proto3"; message Ping { string id = 1; }\n');

        run('yarn', ['install'], consumer, { YARN_ENABLE_NETWORK: 'false' });
        run('yarn', ['tsf-install', '--no-install'], consumer);
        const installedPackage = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8')) as {
            dependenciesMeta?: Record<string, { unplugged?: boolean }>;
        };
        assert.equal(installedPackage.dependenciesMeta?.ttsc?.unplugged, true);
        assert.equal(installedPackage.dependenciesMeta?.protoc?.unplugged, true);
        assert.equal(installedPackage.dependenciesMeta?.['ts-proto']?.unplugged, true);
        assert.equal(installedPackage.dependenciesMeta?.[`@ttsc/${process.platform}-${process.arch}`]?.unplugged, true);
        assert.doesNotMatch(readFileSync(join(consumer, '.yarnrc.yml'), 'utf8'), /@sentry\/node/);
        run('yarn', ['install'], consumer, { YARN_ENABLE_NETWORK: 'false' });
        run('yarn', ['ttsc', '-p', 'tsconfig.json'], consumer, { TSF_TYPE_COMPILER_PREBUILT: '0' });
        run('yarn', ['node', './dist/src/index.js'], consumer);
        run('yarn', ['tsf-gen-proto', 'schema.proto', 'generated'], consumer);
        assert.equal(existsSync(join(consumer, 'dist', 'src', 'index.js')), true);
        assert.equal(existsSync(join(consumer, 'generated', 'schema.ts')), true);
        assert.equal(existsSync(join(consumer, '.yarn', 'tsf-pnp', 'external-package-roots.json')), true);
    });
});
