import assert from 'node:assert/strict';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it, mock } from 'node:test';

import { BaseAppConfig } from '../src/app';
import { genProto } from '../src/cli/tsf-gen-proto';
import { resolveTestWorkerConcurrency } from '../src/cli/tsf-test';
import { resetLogSink, setLogSink, type LogEntry } from '../src/services/logger';
import { waitForTestDatabaseReady } from '../src/testing/database-readiness';

// oxlint-disable-next-line typescript/no-require-imports
const childProcess = require('node:child_process') as typeof import('node:child_process');
const { spawn, spawnSync } = childProcess;
// Fixture-local node_modules directories are deleted after each test, so reuse the repository's content-addressed plugin cache.
const sharedTtscCacheDir = resolve(process.env.TTSC_CACHE_DIR ?? join(process.cwd(), 'node_modules', '.cache', 'ttsc'));
const foundationPackageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string;
    devDependencies: Record<string, string>;
};
const expectedFoundationVersion = foundationPackageJson.version;
const expectedTtscVersion = foundationPackageJson.devDependencies.ttsc;
const expectedTypescriptVersion = foundationPackageJson.devDependencies.typescript;
const tempDirs: string[] = [];

afterEach(() => {
    mock.restoreAll();
    resetLogSink();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tsf-cli-'));
    tempDirs.push(dir);
    return dir;
}

function repoTempDir(): string {
    const dir = mkdtempSync(join(process.cwd(), '.tmp-tsf-cli-'));
    tempDirs.push(dir);
    return dir;
}

function runCli(script: string, args: string[], cwd = process.cwd(), envPatch: NodeJS.ProcessEnv = {}) {
    const {
        NODE_TEST_CONTEXT: _nodeTestContext,
        npm_package_json: _npmPackageJson,
        TSF_INSTALL_PACKAGE_MANAGER_RERUN: _packageManagerRerun,
        ...env
    } = process.env;
    env.TTSC_CACHE_DIR = sharedTtscCacheDir;
    for (const [key, value] of Object.entries(envPatch)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    return spawnSync(process.execPath, [join(process.cwd(), 'dist', 'src', 'cli', script), ...args], {
        cwd,
        encoding: 'utf8',
        env
    });
}

function countOccurrences(value: string, needle: string): number {
    return value.split(needle).length - 1;
}

function linkLocalTemplateDependencies(projectDir: string): void {
    const packageRoot = process.cwd();
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    assert.ok(pkg.dependencies?.['@zyno-io/ts-server-foundation']);
    assert.ok(pkg.dependencies?.tslib);
    assert.ok(pkg.devDependencies?.['@types/node']);
    assert.equal(pkg.devDependencies?.ttsc, expectedTtscVersion);
    assert.equal(pkg.devDependencies?.typescript, expectedTypescriptVersion);

    installLocalFoundationPackage(projectDir, packageRoot);
    const foundationPkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(foundationPkg.dependencies ?? {})) {
        linkDependency(projectDir, dependency, join(packageRoot, 'node_modules', ...dependency.split('/')));
    }
    for (const dependency of Object.keys(foundationPkg.devDependencies ?? {})) {
        linkDependency(projectDir, dependency, join(packageRoot, 'node_modules', ...dependency.split('/')));
    }
}

function linkDependency(projectDir: string, packageName: string, source: string): void {
    assert.equal(existsSync(source), true, `missing local dependency: ${source}`);
    const target = join(projectDir, 'node_modules', ...packageName.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    symlinkSync(source, target, 'junction');
}

function installLocalFoundationPackage(projectDir: string, packageRoot: string): void {
    const target = join(projectDir, 'node_modules', '@zyno-io', 'ts-server-foundation');
    mkdirSync(target, { recursive: true });
    cpSync(join(packageRoot, 'package.json'), join(target, 'package.json'));
    cpSync(join(packageRoot, 'dist'), join(target, 'dist'), { recursive: true });
    cpSync(join(packageRoot, 'template-app'), join(target, 'template-app'), { recursive: true });
}

describe('CLI', () => {
    it('scaffolds a template app with tsf-create-app', () => {
        const dir = tempDir();
        const target = join(dir, 'api');
        const result = runCli('tsf-create-app.js', ['@acme/example-api', target]);

        assert.equal(result.status, 0, result.stderr);
        const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
            name: string;
            dependencies: Record<string, string>;
            scripts: Record<string, string>;
        };
        assert.equal(pkg.name, '@acme/example-api');
        assert.equal(pkg.dependencies['@zyno-io/ts-server-foundation'], '*');
        assert.equal(pkg.dependencies.tslib, '^2.8.1');
        assert.equal(pkg.scripts.dev, 'tsf-dev run -- server:start');
        assert.equal(pkg.scripts.migrate, 'tsf-dev migrate');
        assert.equal(pkg.scripts['migrate:create'], 'tsf-dev migrate:create');
        assert.equal(existsSync(join(target, 'tsconfig.test.json')), true);
        assert.equal(existsSync(join(target, 'tests', 'app.spec.ts')), true);
        assert.equal(existsSync(join(target, '.gitignore')), true);
        assert.equal(existsSync(join(target, 'gitignore')), false);
        assert.equal(existsSync(join(target, '.yarn', 'patches')), false);
        assert.equal(existsSync(join(target, 'src', 'controllers', 'Example.controller.ts')), true);
        assert.match(readFileSync(join(target, '.env.development'), 'utf8'), /MYSQL_DATABASE=example_api/);
        const tsconfig = JSON.parse(readFileSync(join(target, 'tsconfig.json'), 'utf8')) as {
            compilerOptions?: { plugins?: Array<{ transform?: string }> };
        };
        assert.equal(tsconfig.compilerOptions?.plugins?.[0]?.transform, '@zyno-io/ts-server-foundation/type-compiler');
    });

    it('installs baseline compiler setup for Yarn projects', () => {
        const dir = tempDir();
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify(
                {
                    name: 'fixture',
                    packageManager: 'yarn@4.17.1',
                    dependencies: {
                        ttsc: '^0.1',
                        typescript: '~5.9'
                    },
                    devDependencies: {
                        '@zyno-io/ts-server-foundation': '*'
                    }
                },
                null,
                4
            )
        );
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify(
                {
                    compilerOptions: {
                        target: 'ES2022',
                        plugins: []
                    }
                },
                null,
                4
            )
        );

        const result = runCli('tsf-install.js', ['--no-install'], dir);

        assert.equal(result.status, 0, result.stderr);
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        assert.equal(pkg.scripts?.postinstall, 'tsf-install');
        assert.equal(pkg.dependencies?.ttsc, undefined);
        assert.equal(pkg.dependencies?.typescript, undefined);
        assert.equal(pkg.devDependencies?.ttsc, expectedTtscVersion);
        assert.equal(pkg.devDependencies?.typescript, expectedTypescriptVersion);
        assert.equal(existsSync(join(dir, '.yarn', 'patches')), false);
        const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')) as {
            reflection?: boolean;
            compilerOptions?: { plugins?: Array<{ transform?: string }> };
        };
        assert.equal(tsconfig.reflection, true);
        assert.equal(tsconfig.compilerOptions?.plugins?.[0]?.transform, '@zyno-io/ts-server-foundation/type-compiler');
    });

    it('preserves an existing postinstall script and installs itself only once', () => {
        const dir = tempDir();
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify(
                {
                    name: 'fixture',
                    scripts: {
                        postinstall: 'node scripts/setup.js'
                    },
                    devDependencies: {
                        '@zyno-io/ts-server-foundation': '*',
                        ttsc: expectedTtscVersion,
                        typescript: expectedTypescriptVersion
                    }
                },
                null,
                4
            )
        );

        const first = runCli('tsf-install.js', ['--no-install'], dir);
        assert.equal(first.status, 0, first.stderr);
        assert.match(first.stdout, /tsf-install: updated postinstall script/);

        const packageJsonPath = join(dir, 'package.json');
        const firstContents = readFileSync(packageJsonPath, 'utf8');
        const pkg = JSON.parse(firstContents) as { scripts?: Record<string, string> };
        assert.equal(pkg.scripts?.postinstall, 'node scripts/setup.js && tsf-install');

        const second = runCli('tsf-install.js', ['--no-install'], dir);
        assert.equal(second.status, 0, second.stderr);
        assert.doesNotMatch(second.stdout, /updated postinstall script/);
        assert.equal(readFileSync(packageJsonPath, 'utf8'), firstContents);
    });

    it('uses the workspace root package manager when installing from a workspace package', () => {
        const root = tempDir();
        const workspace = join(root, 'packages', 'api');
        const siblingWorkspace = join(root, 'packages', 'shared');
        const binDir = join(root, 'bin');
        const installCwdPath = join(root, 'install-cwd.txt');
        const installGuardPath = join(root, 'install-guard.txt');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(siblingWorkspace, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
            join(root, 'package.json'),
            JSON.stringify(
                {
                    private: true,
                    packageManager: 'yarn@4.17.1',
                    workspaces: ['packages/*'],
                    tsf: { compiler: false },
                    devDependencies: { '@zyno-io/ts-server-foundation': '*' }
                },
                null,
                4
            )
        );
        writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
        writeFileSync(
            join(workspace, 'package.json'),
            JSON.stringify(
                {
                    name: '@fixture/api',
                    packageManager: 'yarn@4.9.1',
                    devDependencies: {
                        '@zyno-io/ts-server-foundation': '*',
                        ttsc: '^0.1',
                        typescript: '~5.9'
                    }
                },
                null,
                4
            )
        );
        writeFileSync(
            join(siblingWorkspace, 'package.json'),
            JSON.stringify(
                {
                    name: '@fixture/shared',
                    packageManager: 'yarn@4.9.1',
                    devDependencies: {
                        '@zyno-io/ts-server-foundation': '*',
                        ttsc: '^0.1',
                        typescript: '~5.9'
                    }
                },
                null,
                4
            )
        );
        writeFileSync(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));
        writeFileSync(join(siblingWorkspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));
        const yarnPath = join(binDir, 'yarn');
        writeFileSync(
            yarnPath,
            `#!/bin/sh\nprintf "%s" "$PWD" > ${JSON.stringify(installCwdPath)}\nprintf "%s" "$TSF_INSTALL_PACKAGE_MANAGER_RERUN" > ${JSON.stringify(installGuardPath)}\nexit 0\n`
        );
        chmodSync(yarnPath, 0o755);

        const result = runCli('tsf-install.js', [], root, {
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            npm_package_json: join(workspace, 'package.json')
        });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /tsf-install: running yarn install/);
        assert.equal(readFileSync(installCwdPath, 'utf8'), realpathSync(root));
        assert.equal(readFileSync(installGuardPath, 'utf8'), '1');
        const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        assert.equal(pkg.scripts?.postinstall, 'tsf-install');
        assert.equal(pkg.devDependencies?.['@zyno-io/ts-server-foundation'], expectedFoundationVersion);
        assert.equal(pkg.devDependencies?.ttsc, expectedTtscVersion);
        assert.equal(pkg.devDependencies?.typescript, expectedTypescriptVersion);
        const siblingPkg = JSON.parse(readFileSync(join(siblingWorkspace, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
        };
        assert.equal(siblingPkg.devDependencies?.['@zyno-io/ts-server-foundation'], expectedFoundationVersion);
        assert.equal(siblingPkg.devDependencies?.ttsc, expectedTtscVersion);
        assert.equal(siblingPkg.devDependencies?.typescript, expectedTypescriptVersion);
        const siblingTsconfig = JSON.parse(readFileSync(join(siblingWorkspace, 'tsconfig.json'), 'utf8')) as {
            reflection?: boolean;
            compilerOptions?: { plugins?: Array<{ transform?: string }> };
        };
        assert.equal(siblingTsconfig.reflection, true);
        assert.equal(siblingTsconfig.compilerOptions?.plugins?.[0]?.transform, '@zyno-io/ts-server-foundation/type-compiler');
        assert.equal(existsSync(join(root, '.yarn', 'patches')), false);
        assert.equal(existsSync(join(workspace, '.yarn', 'patches')), false);
    });

    it('reruns npm during postinstall and guards against a package-manager loop', () => {
        const dir = tempDir();
        const binDir = join(dir, 'bin');
        const installCwdPath = join(dir, 'install-cwd.txt');
        const installGuardPath = join(dir, 'install-guard.txt');
        const packageJsonAtInstallPath = join(dir, 'package-at-install.json');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify(
                {
                    name: 'fixture',
                    packageManager: 'yarn@4.17.1',
                    devDependencies: {
                        '@zyno-io/ts-server-foundation': '*',
                        ttsc: '^0.1',
                        typescript: '~5.9'
                    }
                },
                null,
                4
            )
        );
        writeFileSync(join(dir, 'package-lock.json'), '{}\n');
        const npmPath = join(binDir, 'npm');
        writeFileSync(
            npmPath,
            `#!/bin/sh\nprintf "%s" "$PWD" > ${JSON.stringify(installCwdPath)}\nprintf "%s" "$TSF_INSTALL_PACKAGE_MANAGER_RERUN" > ${JSON.stringify(installGuardPath)}\ncp "$PWD/package.json" ${JSON.stringify(packageJsonAtInstallPath)}\nexit 0\n`
        );
        chmodSync(npmPath, 0o755);

        const result = runCli('tsf-install.js', [], dir, {
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            npm_lifecycle_event: 'postinstall'
        });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /tsf-install: running npm install/);
        assert.equal(readFileSync(installCwdPath, 'utf8'), realpathSync(dir));
        assert.equal(readFileSync(installGuardPath, 'utf8'), '1');
        const packageAtInstall = JSON.parse(readFileSync(packageJsonAtInstallPath, 'utf8')) as {
            devDependencies: Record<string, string>;
        };
        assert.equal(packageAtInstall.devDependencies['@zyno-io/ts-server-foundation'], expectedFoundationVersion);
        assert.equal(packageAtInstall.devDependencies.ttsc, expectedTtscVersion);
        assert.equal(packageAtInstall.devDependencies.typescript, expectedTypescriptVersion);

        const packageJsonPath = join(dir, 'package.json');
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { devDependencies: Record<string, string> };
        pkg.devDependencies.typescript = '~5.9';
        writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 4)}\n`);
        rmSync(installCwdPath);
        rmSync(installGuardPath);
        rmSync(packageJsonAtInstallPath);

        const guardedResult = runCli('tsf-install.js', [], dir, {
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            TSF_INSTALL_PACKAGE_MANAGER_RERUN: '1'
        });

        assert.equal(guardedResult.status, 0, guardedResult.stderr);
        assert.doesNotMatch(guardedResult.stdout, /tsf-install: running npm install/);
        assert.equal(existsSync(installCwdPath), false);
        assert.equal(existsSync(installGuardPath), false);
        assert.equal(existsSync(packageJsonAtInstallPath), false);
    });

    it('updates TSF compiler workspaces without changing frontend or CLI compiler versions', () => {
        const root = tempDir();
        const ttscWorkspace = join(root, 'packages', 'ttsc');
        const typescriptWorkspace = join(root, 'packages', 'typescript');
        const frameworkWorkspace = join(root, 'packages', 'framework');
        const unrelatedWorkspace = join(root, 'packages', 'unrelated');
        mkdirSync(ttscWorkspace, { recursive: true });
        mkdirSync(typescriptWorkspace, { recursive: true });
        mkdirSync(frameworkWorkspace, { recursive: true });
        mkdirSync(unrelatedWorkspace, { recursive: true });
        writeFileSync(
            join(root, 'package.json'),
            JSON.stringify(
                {
                    private: true,
                    packageManager: 'yarn@4.17.1',
                    workspaces: ['packages/*'],
                    tsf: { compiler: false },
                    devDependencies: { '@zyno-io/ts-server-foundation': '*' }
                },
                null,
                4
            )
        );
        writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));
        writeFileSync(
            join(ttscWorkspace, 'package.json'),
            JSON.stringify({ name: '@fixture/cli', devDependencies: { ttsc: '^0.1', typescript: '7.0.2' } }, null, 4)
        );
        writeFileSync(
            join(typescriptWorkspace, 'package.json'),
            JSON.stringify({ name: '@fixture/ui', dependencies: { typescript: '~6.0.3' } }, null, 4)
        );
        writeFileSync(
            join(frameworkWorkspace, 'package.json'),
            JSON.stringify({ name: '@fixture/framework', devDependencies: { '@zyno-io/ts-server-foundation': '*' } }, null, 4)
        );
        writeFileSync(
            join(unrelatedWorkspace, 'package.json'),
            JSON.stringify({ name: '@fixture/unrelated', devDependencies: { eslint: '*' } }, null, 4)
        );
        for (const workspace of [ttscWorkspace, typescriptWorkspace, frameworkWorkspace, unrelatedWorkspace]) {
            writeFileSync(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));
        }

        const result = runCli('tsf-install.js', ['--no-install'], root);

        assert.equal(result.status, 0, result.stderr);
        const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
        const ttscPkg = JSON.parse(readFileSync(join(ttscWorkspace, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
        };
        const typescriptPkg = JSON.parse(readFileSync(join(typescriptWorkspace, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
        };
        const frameworkPkg = JSON.parse(readFileSync(join(frameworkWorkspace, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
        };
        const unrelatedPkg = JSON.parse(readFileSync(join(unrelatedWorkspace, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
        };
        assert.equal(rootPkg.devDependencies?.['@zyno-io/ts-server-foundation'], '*');
        assert.equal(rootPkg.devDependencies?.ttsc, undefined);
        assert.equal(rootPkg.devDependencies?.typescript, undefined);
        assert.equal(ttscPkg.devDependencies?.ttsc, '^0.1');
        assert.equal(ttscPkg.devDependencies?.typescript, '7.0.2');
        assert.equal(typescriptPkg.dependencies?.typescript, '~6.0.3');
        assert.equal(typescriptPkg.dependencies?.ttsc, undefined);
        assert.equal(frameworkPkg.devDependencies?.['@zyno-io/ts-server-foundation'], expectedFoundationVersion);
        assert.equal(frameworkPkg.devDependencies?.ttsc, expectedTtscVersion);
        assert.equal(frameworkPkg.devDependencies?.typescript, expectedTypescriptVersion);
        assert.equal(unrelatedPkg.devDependencies?.ttsc, undefined);
        assert.equal(unrelatedPkg.devDependencies?.typescript, undefined);
        assert.equal(unrelatedPkg.devDependencies?.['@zyno-io/ts-server-foundation'], undefined);
        assert.equal(JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')).reflection, undefined);
        assert.equal(JSON.parse(readFileSync(join(frameworkWorkspace, 'tsconfig.json'), 'utf8')).reflection, true);
        assert.equal(JSON.parse(readFileSync(join(ttscWorkspace, 'tsconfig.json'), 'utf8')).reflection, undefined);
        assert.equal(JSON.parse(readFileSync(join(typescriptWorkspace, 'tsconfig.json'), 'utf8')).reflection, undefined);
        assert.equal(JSON.parse(readFileSync(join(unrelatedWorkspace, 'tsconfig.json'), 'utf8')).reflection, undefined);
    });

    it('honors explicit TSF compiler workspace overrides', () => {
        const root = tempDir();
        const includedWorkspace = join(root, 'packages', 'included');
        const excludedWorkspace = join(root, 'packages', 'excluded');
        mkdirSync(includedWorkspace, { recursive: true });
        mkdirSync(excludedWorkspace, { recursive: true });
        writeFileSync(
            join(root, 'package.json'),
            JSON.stringify({ private: true, packageManager: 'yarn@4.17.1', workspaces: ['packages/*'] }, null, 4)
        );
        writeFileSync(
            join(includedWorkspace, 'package.json'),
            JSON.stringify({ name: '@fixture/included', tsf: { compiler: true }, devDependencies: { typescript: '~5.9' } }, null, 4)
        );
        writeFileSync(
            join(excludedWorkspace, 'package.json'),
            JSON.stringify(
                {
                    name: '@fixture/excluded',
                    tsf: { compiler: false },
                    devDependencies: { '@zyno-io/ts-server-foundation': '*', typescript: '~6.0.3' }
                },
                null,
                4
            )
        );
        writeFileSync(join(includedWorkspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));
        writeFileSync(join(excludedWorkspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));

        const result = runCli('tsf-install.js', ['--no-install'], root);

        assert.equal(result.status, 0, result.stderr);
        const includedPkg = JSON.parse(readFileSync(join(includedWorkspace, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
        };
        const excludedPkg = JSON.parse(readFileSync(join(excludedWorkspace, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
        };
        assert.equal(includedPkg.devDependencies?.ttsc, expectedTtscVersion);
        assert.equal(includedPkg.devDependencies?.typescript, expectedTypescriptVersion);
        assert.equal(includedPkg.devDependencies?.['@zyno-io/ts-server-foundation'], expectedFoundationVersion);
        assert.equal(excludedPkg.devDependencies?.['@zyno-io/ts-server-foundation'], '*');
        assert.equal(excludedPkg.devDependencies?.typescript, '~6.0.3');
        assert.equal(excludedPkg.devDependencies?.ttsc, undefined);
        const includedTsconfig = JSON.parse(readFileSync(join(includedWorkspace, 'tsconfig.json'), 'utf8')) as {
            reflection?: boolean;
            compilerOptions?: { plugins?: Array<{ transform?: string }> };
        };
        assert.equal(includedTsconfig.reflection, true);
        assert.equal(includedTsconfig.compilerOptions?.plugins?.[0]?.transform, '@zyno-io/ts-server-foundation/type-compiler');
        assert.equal(JSON.parse(readFileSync(join(excludedWorkspace, 'tsconfig.json'), 'utf8')).reflection, undefined);
    });

    it('installs compiler plugins shallowest-first and skips configs extending patched configs', () => {
        const dir = tempDir();
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify(
                {
                    name: 'fixture',
                    packageManager: 'yarn@4.17.1',
                    devDependencies: {
                        '@zyno-io/ts-server-foundation': '*'
                    }
                },
                null,
                4
            )
        );
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify(
                {
                    compilerOptions: {
                        target: 'ES2022',
                        plugins: [{ transform: './node_modules/@zyno-io/ts-server-foundation/dist/src/type-compiler/index.cjs' }]
                    }
                },
                null,
                4
            )
        );
        writeFileSync(join(dir, 'tsconfig.test.json'), JSON.stringify({ extends: './tsconfig.json' }, null, 4));

        mkdirSync(join(dir, 'aaa-child'), { recursive: true });
        writeFileSync(join(dir, 'aaa-child', 'tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json' }, null, 4));

        mkdirSync(join(dir, 'packages', 'standalone', 'deep'), { recursive: true });
        writeFileSync(join(dir, 'packages', 'standalone', 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 4));
        writeFileSync(join(dir, 'packages', 'standalone', 'tsconfig.test.json'), JSON.stringify({ extends: './tsconfig.json' }, null, 4));
        writeFileSync(join(dir, 'packages', 'standalone', 'deep', 'tsconfig.json'), JSON.stringify({ extends: '../tsconfig.test.json' }, null, 4));

        const result = runCli('tsf-install.js', ['--no-install'], dir);

        assert.equal(result.status, 0, result.stderr);
        const hasCompilerPlugin = (path: string) => {
            const tsconfig = JSON.parse(readFileSync(path, 'utf8')) as {
                reflection?: boolean;
                compilerOptions?: { plugins?: Array<{ transform?: string }> };
            };
            return (
                tsconfig.reflection === true &&
                tsconfig.compilerOptions?.plugins?.some(plugin => plugin.transform === '@zyno-io/ts-server-foundation/type-compiler') === true
            );
        };

        assert.equal(hasCompilerPlugin(join(dir, 'tsconfig.json')), true);
        assert.equal(hasCompilerPlugin(join(dir, 'tsconfig.test.json')), false);
        assert.equal(hasCompilerPlugin(join(dir, 'aaa-child', 'tsconfig.json')), false);
        assert.equal(hasCompilerPlugin(join(dir, 'packages', 'standalone', 'tsconfig.json')), true);
        assert.equal(hasCompilerPlugin(join(dir, 'packages', 'standalone', 'tsconfig.test.json')), false);
        assert.equal(hasCompilerPlugin(join(dir, 'packages', 'standalone', 'deep', 'tsconfig.json')), false);
    });

    it('compiles and tests a scaffolded template app against the local package', () => {
        const dir = tempDir();
        const target = join(dir, 'api');
        const create = runCli('tsf-create-app.js', ['@acme/example-api', target]);
        assert.equal(create.status, 0, create.stderr);
        linkLocalTemplateDependencies(target);

        const result = runCli('tsf-dev.js', ['test'], target);

        assert.equal(result.status, 0, result.stderr);
        assert.match(`${result.stdout}\n${result.stderr}`, /pass 1/);
        assert.equal(existsSync(join(target, 'dist', 'src', 'app.js')), true);
        assert.equal(existsSync(join(target, 'dist', 'tests', 'app.spec.js')), true);
    });

    it('supports create-app through the umbrella tsf command', () => {
        const dir = tempDir();
        const target = join(dir, 'api');
        const result = runCli('tsf.js', ['create-app', 'example-api', target]);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, 'example-api');
    });
    it('rejects invalid package names and existing targets', () => {
        const dir = tempDir();
        const invalid = runCli('tsf-create-app.js', ['Bad Name', join(dir, 'bad')]);
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /Invalid package name/);

        const existing = runCli('tsf-create-app.js', ['example-api', dir]);
        assert.notEqual(existing.status, 0);
        assert.match(existing.stderr, /Directory already exists/);
    });

    it('runs compiled node:test specs with tsf-test', () => {
        const dir = tempDir();
        const testsDir = join(dir, 'dist', 'tests');
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
        rmSync(testsDir, { recursive: true, force: true });
        mkdirSync(testsDir, { recursive: true });
        writeFileSync(
            join(testsDir, 'probe.spec.js'),
            "const test = require('node:test'); const assert = require('node:assert/strict'); test('env', () => assert.equal(process.env.APP_ENV, 'test'));\n"
        );

        const result = runCli('tsf-test.js', ['--test-name-pattern', 'env', './tests'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(`${result.stdout}\n${result.stderr}`, /pass 1/);
    });

    it('does not wait for database readiness from ambient development config', () => {
        const dir = tempDir();
        const testsDir = join(dir, 'dist', 'tests');
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
        writeFileSync(join(dir, '.env.development'), 'MYSQL_HOST=127.0.0.1\nMYSQL_USER=root\nMYSQL_DATABASE=local_dev\n');
        rmSync(testsDir, { recursive: true, force: true });
        mkdirSync(testsDir, { recursive: true });
        writeFileSync(
            join(testsDir, 'probe.spec.js'),
            "const test = require('node:test'); const assert = require('node:assert/strict'); test('runs', () => assert.equal(process.env.APP_ENV, 'test'));\n"
        );

        const result = runCli('tsf-test.js', [], dir, {
            TSF_TEST_MYSQL_SESSION_MANAGER: undefined,
            TSF_TEST_MYSQL_SESSION_MANAGER_PORT: undefined
        });
        const output = `${result.stdout}\n${result.stderr}`;

        assert.equal(result.status, 0, output);
        assert.doesNotMatch(output, /Waiting for database to be ready/);
    });

    it('resolves node:test concurrency for the MySQL session pool', () => {
        assert.equal(resolveTestWorkerConcurrency(['--test-concurrency', '3']), 3);
        assert.equal(resolveTestWorkerConcurrency(['--test-concurrency=4']), 4);
        assert.equal(resolveTestWorkerConcurrency(['--test-concurrency=false']), 1);
        assert.ok(resolveTestWorkerConcurrency([]) >= 1);
    });

    it('waits for configured test database readiness once per process', async () => {
        const attempts: string[] = [];
        const messages: string[] = [];
        const config = Object.assign(new BaseAppConfig(), {
            MYSQL_HOST: `ready-${process.pid}-${Date.now()}`,
            MYSQL_USER: 'root'
        });

        const options = {
            intervalMs: 1,
            timeoutMs: 100,
            log: (message: string) => messages.push(message),
            probe: async (adapter: 'mysql' | 'postgres') => {
                attempts.push(adapter);
                if (attempts.length < 3) throw new Error('database is not ready');
            }
        };

        await waitForTestDatabaseReady('mysql', config, options);
        await waitForTestDatabaseReady('mysql', config, options);

        assert.deepEqual(messages, ['Waiting for database to be ready...']);
        assert.deepEqual(attempts, ['mysql', 'mysql', 'mysql']);
    });

    it('logs database readiness through the logger by default', async () => {
        const entries: LogEntry[] = [];
        const config = Object.assign(new BaseAppConfig(), {
            MYSQL_HOST: `logger-ready-${process.pid}-${Date.now()}`,
            MYSQL_USER: 'root'
        });
        setLogSink(entry => entries.push(entry));

        await waitForTestDatabaseReady('mysql', config, {
            intervalMs: 1,
            timeoutMs: 100,
            probe: async () => {}
        });

        assert.deepEqual(
            entries.map(entry => [entry.scope, entry.message]),
            [['DatabaseReadiness', 'Waiting for database to be ready...']]
        );
    });

    it('runs tsf-dev build in a project fixture', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        const packageJson = '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}';
        writeFileSync(join(dir, 'package.json'), packageJson);
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const value: number = 42;\n');

        const result = runCli('tsf-dev.js', ['build'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(join(dir, 'dist', 'src', 'index.js')), true);
        assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), packageJson);
        assert.doesNotMatch(result.stdout, /tsf-install:/);
    });

    it('only rebuilds tsf-dev run for source files matched by tsconfig includes', async () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        const source = (version: string) =>
            [
                "import { writeFileSync } from 'node:fs';",
                `writeFileSync('openapi.yaml', 'generated ${version}\\n');`,
                `console.log(\`fixture app started ${version} \${process.argv.slice(2).join(' ')}\`);`,
                'setInterval(() => undefined, 1000);',
                ''
            ].join('\n');
        writeFileSync(join(dir, 'src', 'index.ts'), source('v1'));

        const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
        const child = spawn(
            process.execPath,
            [join(process.cwd(), 'dist', 'src', 'cli', 'tsf-dev.js'), 'run', 'dist/src/index.js', '--', 'server:start'],
            {
                cwd: dir,
                env: {
                    ...env,
                    TTSC_CACHE_DIR: sharedTtscCacheDir,
                    PORT: '31999'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        let output = '';
        const closed = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
        const waitForOutput = async (needle: string) => {
            for (let attempt = 0; attempt < 1_200; attempt++) {
                if (output.includes(needle)) return;
                await sleep(100);
            }
            throw new Error(`timed out waiting for ${needle}\n${output}`);
        };
        child.stdout.on('data', data => {
            output += data.toString();
        });
        child.stderr.on('data', data => {
            output += data.toString();
        });

        try {
            await waitForOutput('fixture app started v1 server:start');
            await sleep(1200);
            assert.equal(countOccurrences(output, 'fixture app started'), 1, output);
            assert.equal(countOccurrences(output, '[ttsc] rebuilding'), 1, output);

            writeFileSync(join(dir, 'src', 'index.ts'), source('v2'));
            await waitForOutput('fixture app started v2 server:start');
            assert.equal(countOccurrences(output, 'fixture app started'), 2, output);
            assert.equal(countOccurrences(output, '[ttsc] rebuilding'), 2, output);
        } finally {
            child.kill('SIGTERM');
            const exited = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000))]);
            if (!exited) {
                child.kill('SIGKILL');
                await closed;
            }
        }

        assert.match(output, /\[ttsc\] watch build complete/);
    });

    it('skips tsf-dev build when tracked inputs are unchanged', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const value: number = 42;\n');

        const first = runCli('tsf-dev.js', ['build'], dir);
        assert.equal(first.status, 0, first.stderr);
        const compiled = readFileSync(join(dir, 'dist', 'src', 'index.js'), 'utf8');

        const second = runCli('tsf-dev.js', ['build'], dir);

        assert.equal(second.status, 0, second.stderr);
        assert.match(second.stdout, /build is up to date/);
        assert.equal(readFileSync(join(dir, 'dist', 'src', 'index.js'), 'utf8'), compiled);
    });

    it('rebuilds through tsf-dev when tracked output is missing or changed', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const value: number = 42;\n');

        const first = runCli('tsf-dev.js', ['build'], dir);
        assert.equal(first.status, 0, first.stderr);
        writeFileSync(join(dir, 'dist', 'src', 'index.js'), '"stale output";\n');

        const second = runCli('tsf-dev.js', ['build'], dir);

        assert.equal(second.status, 0, second.stderr);
        assert.doesNotMatch(second.stdout, /build is up to date/);
        assert.match(readFileSync(join(dir, 'dist', 'src', 'index.js'), 'utf8'), /exports\.value = 42/);
    });

    it('rebuilds through tsf-dev when yarn.lock changes', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(join(dir, 'yarn.lock'), '# lockfile v1\n');
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const value: number = 42;\n');

        const first = runCli('tsf-dev.js', ['build'], dir);
        assert.equal(first.status, 0, first.stderr);
        writeFileSync(join(dir, 'dist', 'src', 'index.js'), '"stale output";\n');
        writeFileSync(join(dir, 'yarn.lock'), '# lockfile v2\n');
        const future = new Date(Date.now() + 5000);
        utimesSync(join(dir, 'yarn.lock'), future, future);

        const second = runCli('tsf-dev.js', ['build'], dir);

        assert.equal(second.status, 0, second.stderr);
        assert.doesNotMatch(second.stdout, /build is up to date/);
        assert.match(readFileSync(join(dir, 'dist', 'src', 'index.js'), 'utf8'), /exports\.value = 42/);
    });

    it('rebuilds through tsf-dev when package metadata changes', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const value: number = 42;\n');

        const first = runCli('tsf-dev.js', ['build'], dir);
        assert.equal(first.status, 0, first.stderr);
        writeFileSync(join(dir, 'dist', 'src', 'index.js'), '"stale output";\n');
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","private":true,"devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );

        const second = runCli('tsf-dev.js', ['build'], dir);

        assert.equal(second.status, 0, second.stderr);
        assert.doesNotMatch(second.stdout, /build is up to date/);
        assert.match(readFileSync(join(dir, 'dist', 'src', 'index.js'), 'utf8'), /exports\.value = 42/);
    });

    it('runs tsf-dev test without opening an inspector for normal tests', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src', 'tests'), { recursive: true });
        const packageJsonPath = join(dir, 'package.json');
        const packageJson = '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}';
        writeFileSync(packageJsonPath, packageJson);
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                }
            })
        );
        const tsconfigPath = join(dir, 'tsconfig.test.json');
        const tsconfig = JSON.stringify({
            extends: './tsconfig.json',
            include: ['src/tests/**/*.ts']
        });
        writeFileSync(tsconfigPath, tsconfig);
        writeFileSync(
            join(dir, 'src', 'tests', 'probe.spec.ts'),
            "import test from 'node:test'; import assert from 'node:assert/strict'; test('selected env', () => assert.equal(process.env.APP_ENV, 'test'));\n"
        );

        const result = runCli('tsf-dev.js', ['test', '--test-name-pattern', 'selected', './src/tests/probe.spec.ts'], dir);
        const output = `${result.stdout}\n${result.stderr}`;

        assert.equal(result.status, 0, result.stderr);
        assert.match(output, /pass 1/);
        assert.doesNotMatch(output, /Debugger listening/);
        assert.equal(readFileSync(packageJsonPath, 'utf8'), packageJson);
        assert.equal(readFileSync(tsconfigPath, 'utf8'), tsconfig);
    });

    it('reports help successfully for tsf-gen-proto', () => {
        const result = runCli('tsf-gen-proto.js', ['--help']);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage: tsf-gen-proto/);
    });

    it('uses the packaged protoc binary for tsf-gen-proto', () => {
        const dir = tempDir();
        const proto = join(dir, 'service.proto');
        const outputDir = join(dir, 'generated');
        writeFileSync(proto, 'syntax = "proto3"; message Ping { string id = 1; }\n');

        const spawnMock = mock.method(childProcess, 'spawnSync', () => ({ status: 0 }));
        const status = genProto([proto, outputDir]);

        assert.equal(status, 0);
        assert.equal(spawnMock.mock.callCount(), 1);

        const [command, args] = spawnMock.mock.calls[0].arguments as [string, string[]];
        const protocPackageJson = require.resolve('protoc/package.json');
        const protocPackage = JSON.parse(readFileSync(protocPackageJson, 'utf8')) as {
            bin: Record<string, string>;
        };
        assert.equal(command, process.execPath);
        assert.equal(args[0], join(dirname(protocPackageJson), protocPackage.bin.protoc));
        assert.notEqual(command, 'protoc');
    });

    it('runs tsf-dev openapi:generate through the app package entrypoint', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","main":"./dist/src/index.js","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    experimentalDecorators: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(
            join(dir, 'src', 'index.ts'),
            `
import { BaseAppConfig, createApp, http } from '@zyno-io/ts-server-foundation';

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

@http.controller('/package-main-openapi')
class OpenApiController {
    @http.GET()
    get() {
        return { ok: true };
    }
}

const app = createApp({ config: Config, controllers: [OpenApiController], enableHealthcheck: false });
void app.run();
`
        );

        const result = runCli('tsf-dev.js', ['openapi:generate'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Wrote OpenAPI schema/);
        assert.match(readFileSync(join(dir, 'openapi.yaml'), 'utf8'), /\/package-main-openapi:/);
    });

    it('runs tsf-dev migrate through an app emitted from a src rootDir', () => {
        const dir = repoTempDir();
        mkdirSync(join(dir, 'src', 'migrations'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","main":"./dist/index.js","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        installLocalFoundationPackage(dir, process.cwd());
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: './src',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(
            join(dir, 'src', 'index.ts'),
            `
import { writeFileSync } from 'node:fs';
import {
    BaseAppConfig,
    createApp,
    createDatabaseClass,
    type DatabaseDriver,
    type DriverConnection,
    type ExecuteResult,
    type QueryResult,
    type RenderedSql
} from '@zyno-io/ts-server-foundation';

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeConnection implements DriverConnection {
    constructor(private readonly driver: FakeDriver) {}
    async query<T = Record<string, unknown>>(_query: RenderedSql): Promise<QueryResult<T>> {
        return { rows: (this.driver.rows.shift() ?? []) as T[] };
    }
    async execute(_query: RenderedSql): Promise<ExecuteResult> { return { affectedRows: 1 }; }
    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(_name: string): Promise<void> {}
    async rollbackToSavepoint(_name: string): Promise<void> {}
    async release(): Promise<void> {}
}

class FakeDriver implements DatabaseDriver {
    readonly dialect = 'postgres';
    rows: Record<string, unknown>[][] = [[]];
    async connect(): Promise<void> {}
    async close(): Promise<void> { writeFileSync('driver-closed.txt', 'yes'); }
    async acquire(): Promise<DriverConnection> { return new FakeConnection(this); }
}

const DB = createDatabaseClass(() => new FakeDriver());
const app = createApp({ config: Config, db: DB, enableHealthcheck: false, controllers: [], listeners: [] });
void app.run();
`
        );
        writeFileSync(
            join(dir, 'src', 'migrations', '001_first.ts'),
            `
import { writeFileSync } from 'node:fs';
import type { BaseDatabase } from '@zyno-io/ts-server-foundation';

export default async function first(db: BaseDatabase): Promise<void> {
    writeFileSync('entrypoint-migration.txt', process.argv.slice(2).join(' '));
    await db.rawExecute('SELECT 1');
}
`
        );

        const result = runCli('tsf-dev.js', ['migrate'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Ran 1 migration/);
        assert.equal(readFileSync(join(dir, 'entrypoint-migration.txt'), 'utf8'), 'migrate:run');
        assert.equal(readFileSync(join(dir, 'driver-closed.txt'), 'utf8'), 'yes');
    });

    it('runs compiled migrations with tsf-migrate', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        mkdirSync(join(dir, 'dist', 'src', 'migrations'), { recursive: true });
        mkdirSync(join(dir, 'src', 'migrations'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"commonjs"}');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeConnection {
    constructor(driver) { this.driver = driver; }
    async query(query) { this.driver.queries.push(query); return { rows: this.driver.rows.shift() || [] }; }
    async execute(query) { this.driver.executes.push(query); return { affectedRows: 1 }; }
    async begin() {}
    async commit() {}
    async rollback() {}
    async savepoint() {}
    async rollbackToSavepoint() {}
    async release() {}
}

class FakeDriver {
    dialect = 'postgres';
    rows = [[]];
    queries = [];
    executes = [];
    async connect() {}
    async close() {}
    async acquire() { return new FakeConnection(this); }
}

exports.app = createApp({
    config: Config,
    providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
                enableHealthcheck: false,
                controllers: [],
                listeners: []
            });
`
        );
        writeFileSync(
            join(dir, 'dist', 'src', 'migrations', '001_first.js'),
            "exports.default = async db => { require('node:fs').writeFileSync('ran.txt', 'ok'); await db.rawExecute('SELECT 1'); };\n"
        );

        const result = runCli('tsf-migrate.js', ['run', '--app', 'app.js', '--migrations-dir', 'src/migrations'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Ran 1 migration/);
        assert.equal(readFileSync(join(dir, 'ran.txt'), 'utf8'), 'ok');
    });

    it('loads zero-argument app factories with tsf-migrate', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        mkdirSync(join(dir, 'dist', 'src', 'migrations'), { recursive: true });
        mkdirSync(join(dir, 'src', 'migrations'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"commonjs"}');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeConnection {
    constructor(driver) { this.driver = driver; }
    async query() { return { rows: this.driver.rows.shift() || [] }; }
    async execute(query) { this.driver.executes.push(query); return { affectedRows: 1 }; }
    async begin() {}
    async commit() {}
    async rollback() {}
    async savepoint() {}
    async rollbackToSavepoint() {}
    async release() {}
}

class FakeDriver {
    dialect = 'postgres';
    rows = [[]];
    executes = [];
    closed = false;
    async connect() {}
    async close() { this.closed = true; require('node:fs').writeFileSync('closed.txt', 'yes'); }
    async acquire() { return new FakeConnection(this); }
}

exports.createFixtureApp = () =>
    createApp({
        config: Config,
        providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
        enableHealthcheck: false,
        controllers: [],
        listeners: []
    });
`
        );
        writeFileSync(
            join(dir, 'dist', 'src', 'migrations', '001_first.js'),
            "exports.default = async db => { require('node:fs').writeFileSync('factory-ran.txt', 'ok'); await db.rawExecute('SELECT 1'); };\n"
        );

        const result = runCli('tsf-migrate.js', ['run', '--app', 'app.js', '--migrations-dir', 'src/migrations'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Ran 1 migration/);
        assert.equal(readFileSync(join(dir, 'factory-ran.txt'), 'utf8'), 'ok');
        assert.equal(readFileSync(join(dir, 'closed.txt'), 'utf8'), 'yes');
    });

    it('maps monorepo source migration directories to package dist directories', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        mkdirSync(join(dir, 'packages', 'api', 'dist', 'src', 'migrations'), { recursive: true });
        mkdirSync(join(dir, 'packages', 'api', 'src', 'migrations'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"commonjs"}');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeConnection {
    async query() { return { rows: [] }; }
    async execute() { return { affectedRows: 1 }; }
    async begin() {}
    async commit() {}
    async rollback() {}
    async savepoint() {}
    async rollbackToSavepoint() {}
    async release() {}
}

class FakeDriver {
    dialect = 'postgres';
    async connect() {}
    async close() {}
    async acquire() { return new FakeConnection(); }
}

exports.app = createApp({
    config: Config,
    providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
    enableHealthcheck: false
});
`
        );
        writeFileSync(
            join(dir, 'packages', 'api', 'dist', 'src', 'migrations', '001_monorepo.js'),
            "exports.default = async () => { require('node:fs').writeFileSync('monorepo-ran.txt', 'ok'); };\n"
        );

        const result = runCli('tsf-migrate.js', ['run', '--app', 'app.js', '--migrations-dir', 'packages/api/src/migrations'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Ran 1 migration/);
        assert.equal(readFileSync(join(dir, 'monorepo-ran.txt'), 'utf8'), 'ok');
    });

    it('creates scoped migration files with tsf-migrate create', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        mkdirSync(join(dir, 'src', 'migrations'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"commonjs"}');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});
const { appendFileSync } = require('node:fs');

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeConnection {
    constructor(driver) { this.driver = driver; }
    async query(query) {
        appendFileSync('queries.jsonl', JSON.stringify(query) + '\\n');
        return { rows: this.driver.rows.shift() || [] };
    }
    async execute() { return { affectedRows: 1 }; }
    async begin() {}
    async commit() {}
    async rollback() {}
    async savepoint() {}
    async rollbackToSavepoint() {}
    async release() {}
}

class FakeDriver {
    dialect = 'postgres';
    rows = [
        [
            {
                column_name: 'id',
                ordinal_position: 1,
                column_default: null,
                is_nullable: 'NO',
                data_type: 'integer',
                udt_name: 'int4',
                character_maximum_length: null,
                numeric_precision: 32,
                numeric_scale: 0,
                is_identity: 'NO'
            }
        ],
        [{ constraint_name: 'kept_pkey', column_name: 'id' }],
        [],
        [],
        [],
        []
    ];
    async connect() {}
    async close() {}
    async acquire() { return new FakeConnection(this); }
}

exports.app = createApp({
    config: Config,
    providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
    enableHealthcheck: false
});
`
        );

        const result = runCli(
            'tsf-migrate.js',
            [
                'create',
                '--app',
                'app.js',
                '--migrations-dir',
                'src/migrations',
                '--description',
                'drop kept',
                '--pg-schema',
                'tenant',
                '--tables',
                ' kept, other ',
                '--table',
                'kept'
            ],
            dir
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Created migration:/);
        const migrationFiles = readdirSync(join(dir, 'src', 'migrations')).filter(file => file.endsWith('_drop_kept.ts'));
        assert.equal(migrationFiles.length, 1);
        const migrationContent = readFileSync(join(dir, 'src', 'migrations', migrationFiles[0]), 'utf8');
        assert.match(migrationContent, /\/\/ Table: kept/);
        assert.match(migrationContent, /DROP TABLE "tenant"\."kept"/);

        const queries = readFileSync(join(dir, 'queries.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as { sql: string; bindings: unknown[] });
        assert.equal(
            queries.some(query => query.sql.includes('FROM pg_tables')),
            false
        );
        assert.deepStrictEqual(
            queries.map(query => query.bindings),
            [
                ['tenant', 'kept'],
                ['tenant', 'kept'],
                ['tenant', 'kept'],
                ['tenant', 'kept'],
                ['tenant', 'other'],
                ['tenant', 'tenant', 'kept']
            ]
        );
    });

    it('rejects empty scoped migration options', () => {
        const emptyTable = runCli('tsf-migrate.js', ['create', '--table=']);
        assert.notEqual(emptyTable.status, 0);
        assert.match(emptyTable.stderr, /--table requires a non-empty value/);

        const emptyTables = runCli('tsf-migrate.js', ['create', '--tables=,,']);
        assert.notEqual(emptyTables.status, 0);
        assert.match(emptyTables.stderr, /--tables requires one or more non-empty table names/);

        const emptySchema = runCli('tsf-migrate.js', ['create', '--pg-schema=']);
        assert.notEqual(emptySchema.status, 0);
        assert.match(emptySchema.stderr, /--pg-schema requires a non-empty value/);
    });

    it('resets source migrations with tsf-migrate reset', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        mkdirSync(join(dir, 'src', 'migrations'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"commonjs"}');
        writeFileSync(join(dir, 'src', 'migrations', '99999999_999999_old.ts'), 'export default async function oldMigration() {}\n');
        writeFileSync(join(dir, 'src', 'migrations', 'keep.js'), 'keep');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeDriver {
    dialect = 'postgres';
    async connect() {}
    async close() {}
    async acquire() { throw new Error('reset should not acquire a connection without entities'); }
}

exports.app = createApp({
    config: Config,
    providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
    enableHealthcheck: false
});
`
        );

        const result = runCli('tsf-migrate.js', ['reset', '--app', 'app.js', '--migrations-dir', 'src/migrations'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Removed 1 migration file/);
        assert.match(result.stdout, /No entity tables found/);
        assert.equal(existsSync(join(dir, 'src', 'migrations', '99999999_999999_old.ts')), false);
        assert.equal(existsSync(join(dir, 'src', 'migrations', 'keep.js')), true);
    });

    it('standardizes MySQL collations with tsf-migrate charset', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"commonjs"}');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { appendFileSync } = require('node:fs');
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeConnection {
    constructor(driver) { this.driver = driver; }
    async query(query) { this.driver.queries.push(query); return { rows: this.driver.rows.shift() || [] }; }
    async execute(query) {
        appendFileSync('executes.jsonl', JSON.stringify(query) + '\\n');
        return { affectedRows: 1 };
    }
    async begin() {}
    async commit() {}
    async rollback() {}
    async savepoint() {}
    async rollbackToSavepoint() {}
    async release() {}
}

class FakeDriver {
    dialect = 'mysql';
    rows = [[{ databaseName: 'fixture_db' }], [{ Tables_in_fixture_db: 'users' }]];
    queries = [];
    async connect() {}
    async close() {}
    async acquire() { return new FakeConnection(this); }
}

exports.app = createApp({
    config: Config,
    providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
    enableHealthcheck: false
});
`
        );

        const result = runCli('tsf-migrate.js', ['charset', '--app', 'app.js', 'utf8mb4', 'utf8mb4_0900_ai_ci'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Standardized 1 table/);
        const executes = readFileSync(join(dir, 'executes.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as { sql: string; bindings: unknown[] });
        assert.match(executes[0].sql, /ALTER DATABASE `fixture_db` CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci/);
        assert.match(executes[1].sql, /ALTER TABLE `users` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci/);
    });

    it('forwards migrate reset through tsf-dev', () => {
        const dir = repoTempDir();
        const packageRoot = process.cwd();
        mkdirSync(join(dir, 'src', 'migrations'), { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            '{"name":"fixture","type":"commonjs","devDependencies":{"@types/node":"^26","ttsc":"0.18.3","typescript":"7.0.2"}}'
        );
        linkDependency(dir, 'ttsc', join(packageRoot, 'node_modules', 'ttsc'));
        linkDependency(dir, 'typescript', join(packageRoot, 'node_modules', 'typescript'));
        linkDependency(dir, '@types/node', join(packageRoot, 'node_modules', '@types', 'node'));
        installLocalFoundationPackage(dir, packageRoot);
        writeFileSync(
            join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    rootDir: '.',
                    outDir: 'dist',
                    strict: true,
                    skipLibCheck: true,
                    types: ['node']
                },
                include: ['src/**/*.ts']
            })
        );
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const compiled = true;\n');
        writeFileSync(join(dir, 'src', 'migrations', '99999999_999999_old.ts'), 'export default async function oldMigration() {}\n');
        writeFileSync(
            join(dir, 'app.js'),
            `
const { BaseAppConfig, BaseDatabase, createApp } = require(${JSON.stringify(join(packageRoot, 'dist', 'src'))});

class Config extends BaseAppConfig {
    APP_ENV = 'test';
}

class FakeDriver {
    dialect = 'postgres';
    async connect() {}
    async close() {}
    async acquire() { throw new Error('reset should not acquire a connection without entities'); }
}

exports.app = createApp({
    config: Config,
    providers: [{ provide: BaseDatabase, useValue: new BaseDatabase(new FakeDriver()) }],
    enableHealthcheck: false
});
`
        );

        const result = runCli('tsf-dev.js', ['migrate:reset', '--app', 'app.js', '--migrations-dir', 'src/migrations'], dir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Removed 1 migration file/);
        assert.equal(existsSync(join(dir, 'dist', 'src', 'index.js')), true);
        assert.equal(existsSync(join(dir, 'src', 'migrations', '99999999_999999_old.ts')), false);
    });
});
