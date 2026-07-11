#!/usr/bin/env node
const { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const pluginDir = join(root, 'src/type-compiler/go');
const ttscDir = join(root, 'node_modules/ttsc');
const shimDir = join(ttscDir, 'shim');

if (!existsSync(join(ttscDir, 'go.mod'))) {
    console.error('Missing node_modules/ttsc. Run yarn install before Go plugin tests.');
    process.exit(1);
}

function shimModules(dir) {
    const result = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (!statSync(path).isDirectory()) continue;
        if (existsSync(join(path, 'go.mod'))) result.push(path);
        result.push(...shimModules(path));
    }
    return result.sort();
}

const workDir = mkdtempSync(join(tmpdir(), 'tsf-type-compiler-go-'));
const workFile = join(workDir, 'go.work');

try {
    const init = spawnSync('go', ['work', 'init', pluginDir, ...shimModules(shimDir)], {
        cwd: workDir,
        stdio: 'inherit'
    });
    if (init.status !== 0) process.exit(init.status ?? 1);

    writeFileSync(workFile, `\nreplace github.com/samchon/ttsc/packages/ttsc v0.0.0 => ${ttscDir}\n`, { flag: 'a' });

    const result = spawnSync('go', ['test', '.'], {
        cwd: pluginDir,
        env: { ...process.env, GOWORK: workFile },
        stdio: 'inherit'
    });
    process.exit(result.status ?? 1);
} finally {
    rmSync(workDir, { recursive: true, force: true });
}
