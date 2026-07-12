import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { readTypeScriptOutputConfig, resolveTypeScriptOutputPath } from '../src/typescript-output';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tsf-typescript-output-'));
    tempDirs.push(dir);
    return dir;
}

describe('TypeScript output paths', () => {
    it('maps source paths using inherited JSONC compiler options', () => {
        const root = tempDir();
        mkdirSync(join(root, 'src', 'tests'), { recursive: true });
        writeFileSync(
            join(root, 'tsconfig.json'),
            `{
                // Paths are relative to the config that declares them.
                "compilerOptions": {
                    "rootDir": "./src",
                    "outDir": "./build",
                },
            }`
        );
        writeFileSync(join(root, 'tsconfig.test.json'), '{"extends":"./tsconfig.json","include":["src/**/*"]}');

        const config = readTypeScriptOutputConfig({ cwd: root, tsconfigPath: 'tsconfig.test.json' });
        const output = resolveTypeScriptOutputPath('src/tests/example.spec.ts', {
            cwd: root,
            tsconfigPath: 'tsconfig.test.json'
        });

        assert.equal(config?.rootDir, join(root, 'src'));
        assert.equal(config?.outDir, join(root, 'build'));
        assert.equal(output, join(root, 'build', 'tests', 'example.spec.js'));
    });

    it('does not map source paths outside rootDir', () => {
        const root = tempDir();
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: './src', outDir: './dist' } }));

        assert.equal(resolveTypeScriptOutputPath('tests/example.spec.ts', { cwd: root }), undefined);
    });
});
