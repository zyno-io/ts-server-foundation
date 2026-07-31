#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const projectRoot = process.cwd();
const projectRequire = createRequire(join(projectRoot, 'package.json'));
const ttscLauncher = join(dirname(projectRequire.resolve('ttsc/package.json')), 'lib', 'launcher', 'ttsc.js');
const typescriptRoot = dirname(projectRequire.resolve('typescript/package.json'));
const cacheDir = resolve(process.env.TTSC_CACHE_DIR ?? join(projectRoot, '.yarn', 'ttsc-cache'));
const fixture = mkdtempSync(join(tmpdir(), 'tsf-test-type-compiler-'));

try {
    mkdirSync(join(fixture, 'node_modules'), { recursive: true });
    symlinkSync(typescriptRoot, join(fixture, 'node_modules', 'typescript'), 'dir');
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(fixture, 'index.ts'), 'export const prewarmed = true;\n');
    writeFileSync(
        join(fixture, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'commonjs',
                outDir: './dist',
                plugins: [{ transform: join(projectRoot, 'src', 'type-compiler', 'index.cjs') }]
            },
            include: ['./index.ts'],
            reflection: true
        })
    );

    console.log(`tsf-test: preparing type compiler cache at ${cacheDir}`);
    const result = spawnSync(process.execPath, [ttscLauncher, '-p', 'tsconfig.json'], {
        cwd: fixture,
        env: { ...process.env, NO_COLOR: '1', TTSC_CACHE_DIR: cacheDir },
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
    rmSync(fixture, { force: true, recursive: true });
}
