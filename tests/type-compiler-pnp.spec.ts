import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

// oxlint-disable-next-line typescript/no-require-imports
const pnp = require(join(process.cwd(), 'packages', 'reflection', 'src', 'type-compiler', 'pnp.cjs')) as {
    isArchivePath(value: string): boolean;
    materializeImportedPackageRoots(
        context: { projectRoot: string; tsconfig: string },
        pnpapi: { resolveToUnqualified(request: string, issuer: string): string | null },
        cacheRoot: string
    ): Record<string, string>;
    materializeTypeScriptPackage(packageName: string, source: string, cacheRoot: string): string;
    packageNameFromSpecifier(specifier: string): string;
};

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'tsf-pnp-'));
    directories.push(directory);
    return directory;
}

describe('type compiler PnP handoff', () => {
    it('recognizes Yarn ZipFS package paths without treating normal paths as archives', () => {
        assert.equal(pnp.isArchivePath('/repo/.yarn/cache/example-npm-1.0.0.zip/node_modules/example'), true);
        assert.equal(pnp.isArchivePath('/repo/node_modules/example'), false);
    });

    it('derives the owning package from bare, scoped, and subpath imports', () => {
        assert.equal(pnp.packageNameFromSpecifier('example/subpath'), 'example');
        assert.equal(pnp.packageNameFromSpecifier('@scope/example/subpath'), '@scope/example');
        assert.equal(pnp.packageNameFromSpecifier('./local'), '');
        assert.equal(pnp.packageNameFromSpecifier('node:fs'), '');
    });

    it('copies declaration sources rather than an entire archived package', () => {
        const root = temporaryDirectory();
        const source = join(root, 'cache.zip', 'node_modules', 'example');
        mkdirSync(join(source, 'nested'), { recursive: true });
        writeFileSync(join(source, 'index.d.ts'), 'export declare function receive<T>(value?: T): T;\n');
        writeFileSync(join(source, 'runtime.js'), 'module.exports = {};\n');
        writeFileSync(join(source, 'nested', 'model.ts'), 'export interface Model { id: string; }\n');

        const materialized = pnp.materializeTypeScriptPackage('example', source, join(root, 'project', '.yarn', 'tsf-pnp'));
        assert.equal(readFileSync(join(materialized, 'index.d.ts'), 'utf8').includes('receive'), true);
        assert.equal(existsSync(join(materialized, 'nested', 'model.ts')), true);
        assert.equal(existsSync(join(materialized, 'runtime.js')), false);
    });

    it('tolerates package directories disappearing before materialization', () => {
        const root = temporaryDirectory();
        const source = join(root, 'removed-package');
        mkdirSync(source, { recursive: true });
        rmSync(source, { recursive: true });

        const materialized = pnp.materializeTypeScriptPackage('example', source, join(root, 'project', '.yarn', 'tsf-pnp'));

        assert.equal(existsSync(materialized), true);
    });

    it('skips virtual PnP resolutions that point to files instead of package directories', () => {
        const root = temporaryDirectory();
        const project = join(root, 'project');
        const virtualModule = join(root, '.pnp.cjs');
        mkdirSync(join(project, 'src'), { recursive: true });
        writeFileSync(join(project, 'tsconfig.json'), '{}\n');
        writeFileSync(join(project, 'src', 'index.ts'), "import 'pnpapi';\n");
        writeFileSync(virtualModule, 'module.exports = {};\n');

        const roots = pnp.materializeImportedPackageRoots(
            { projectRoot: project, tsconfig: join(project, 'tsconfig.json') },
            { resolveToUnqualified: () => virtualModule },
            join(project, '.yarn', 'tsf-pnp')
        );

        assert.deepStrictEqual(roots, {});
    });
});
