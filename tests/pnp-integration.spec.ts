import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const directories: string[] = [];

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
        env: { ...process.env, ...env },
        timeout: 180_000
    });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
}

describe('packed Yarn PnP consumer', () => {
    it('installs, reflects an external ReceiveType function, and runs proto generation', { timeout: 240_000 }, () => {
        const root = process.cwd();
        const directory = temporaryDirectory();
        const externalDir = join(directory, 'external');
        const externalTarball = join(directory, 'pnp-receive-fixture-1.0.0.tgz');
        const consumer = join(directory, 'consumer');
        const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
            version: string;
            devDependencies: Record<string, string>;
        };
        const foundationTarball = join(directory, `zyno-io-ts-server-foundation-${rootPackage.version}.tgz`);

        run('npm', ['pack', '--pack-destination', directory], root);
        mkdirSync(externalDir, { recursive: true });
        run('yarn', ['init', '-2'], externalDir);
        writeFileSync(
            join(externalDir, 'package.json'),
            JSON.stringify({ name: 'pnp-receive-fixture', version: '1.0.0', main: 'index.js', types: 'index.d.ts' })
        );
        writeFileSync(join(externalDir, 'index.js'), 'exports.receive = value => value;\n');
        writeFileSync(
            join(externalDir, 'index.d.ts'),
            'export declare function receive<T>(value?: import("@zyno-io/ts-server-foundation").ReceiveType<T>): T;\n'
        );
        run('npm', ['pack', '--pack-destination', directory], externalDir);

        mkdirSync(consumer, { recursive: true });
        run('yarn', ['init', '-2'], consumer);
        writeFileSync(
            join(consumer, 'package.json'),
            JSON.stringify({
                private: true,
                dependencies: {
                    '@zyno-io/ts-server-foundation': `file:${foundationTarball}`,
                    'pnp-receive-fixture': `file:${externalTarball}`
                },
                resolutions: {
                    '@zyno-io/ts-server-foundation': `file:${foundationTarball}`
                },
                devDependencies: {
                    '@types/node': rootPackage.devDependencies['@types/node'],
                    ttsc: rootPackage.devDependencies.ttsc,
                    typescript: rootPackage.devDependencies.typescript
                },
                packageManager: 'yarn@4.17.1'
            })
        );
        writeFileSync(join(consumer, '.yarnrc.yml'), 'nodeLinker: pnp\n');
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
                    types: ['node'],
                    plugins: [{ transform: '@zyno-io/ts-server-foundation/type-compiler' }]
                },
                include: ['src/**/*.ts'],
                reflection: true
            })
        );
        mkdirSync(join(consumer, 'src'), { recursive: true });
        writeFileSync(
            join(consumer, 'src', 'index.ts'),
            'import { typeOf } from "@zyno-io/ts-server-foundation"; import { receive } from "pnp-receive-fixture"; export const value = receive<{ id: string }>(); export const metadata = typeOf<{ id: string }>();\n'
        );
        writeFileSync(join(consumer, 'schema.proto'), 'syntax = "proto3"; message Ping { string id = 1; }\n');

        run('yarn', ['install'], consumer);
        run('yarn', ['tsf-install', '--no-install'], consumer);
        const installedPackage = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8')) as {
            dependenciesMeta?: Record<string, { unplugged?: boolean }>;
        };
        assert.equal(installedPackage.dependenciesMeta?.ttsc?.unplugged, true);
        assert.equal(installedPackage.dependenciesMeta?.protoc?.unplugged, true);
        assert.equal(installedPackage.dependenciesMeta?.['ts-proto']?.unplugged, true);
        assert.equal(installedPackage.dependenciesMeta?.[`@ttsc/${process.platform}-${process.arch}`]?.unplugged, true);
        assert.match(readFileSync(join(consumer, '.yarnrc.yml'), 'utf8'), /["']@sentry\/node@\*["']:[\s\S]+["']@opentelemetry\/core["']:/);
        run('yarn', ['install'], consumer);
        run('yarn', ['ttsc', '-p', 'tsconfig.json'], consumer, { TSF_TYPE_COMPILER_PREBUILT: '0' });
        run(
            'yarn',
            [
                'node',
                '-e',
                "const result = require('./dist/src/index.js'); if (!result.value || !result.metadata) throw new Error('missing reflected metadata');"
            ],
            consumer
        );
        run('yarn', ['tsf-gen-proto', 'schema.proto', 'generated'], consumer);
        assert.equal(existsSync(join(consumer, 'dist', 'src', 'index.js')), true);
        assert.equal(existsSync(join(consumer, 'generated', 'schema.ts')), true);
        assert.equal(existsSync(join(consumer, '.yarn', 'tsf-pnp', 'external-package-roots.json')), true);
    });
});
