'use strict';
/* oxlint-disable typescript/no-require-imports -- release tooling runs as CommonJS. */

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const { PREBUILT_SCHEMA_VERSION, hashPluginSource, isPublishedReleaseVersion, prebuiltAssetNames } = require('../src/type-compiler/prebuilt.cjs');

function main(args) {
    const options = parseArgs(args);
    if (process.env.CGO_ENABLED !== '0') throw new Error('type compiler prebuilds must be created with CGO_ENABLED=0');

    const packageJson = readJson(path.join(process.cwd(), 'package.json'));
    const packageVersion = options.version;
    if (!isPublishedReleaseVersion(packageVersion)) throw new Error(`invalid published package version ${packageVersion}`);
    const target = `${process.platform}-${process.arch}`;
    const assets = prebuiltAssetNames(target);
    const binary = findPreparedBinary(options.cacheDir);
    verifyPortableBinary(binary);
    const binaryContent = fs.readFileSync(binary);
    const manifest = {
        schemaVersion: PREBUILT_SCHEMA_VERSION,
        packageVersion,
        platform: process.platform,
        arch: process.arch,
        pluginSourceSha256: hashPluginSource(path.join(process.cwd(), 'src', 'type-compiler', 'go')),
        ttscVersion: packageJson.devDependencies.ttsc,
        typescriptVersion: packageJson.devDependencies.typescript,
        cgoEnabled: false,
        binaryAsset: assets.binary,
        binarySha256: crypto.createHash('sha256').update(binaryContent).digest('hex'),
        binarySize: binaryContent.length,
        commit: process.env.GITHUB_SHA ?? null
    };

    fs.mkdirSync(options.output, { recursive: true });
    const outputBinary = path.join(options.output, assets.binary);
    fs.copyFileSync(binary, outputBinary);
    if (process.platform !== 'win32') fs.chmodSync(outputBinary, 0o755);
    fs.writeFileSync(path.join(options.output, assets.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
}

function findPreparedBinary(cacheDir) {
    const pluginRoot = path.join(cacheDir, 'plugins');
    const executable = process.platform === 'win32' ? 'plugin.exe' : 'plugin';
    const candidates = fs
        .readdirSync(pluginRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(pluginRoot, entry.name, executable))
        .filter(file => fs.existsSync(file));
    if (candidates.length !== 1) throw new Error(`expected one prepared type compiler binary under ${pluginRoot}, found ${candidates.length}`);
    return candidates[0];
}

function parseArgs(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (!value || !['--cache-dir', '--output', '--version'].includes(key)) throw new Error(`invalid argument ${key ?? ''}`.trim());
        if (key === '--cache-dir') options.cacheDir = path.resolve(value);
        if (key === '--output') options.output = path.resolve(value);
        if (key === '--version') options.version = value;
    }
    if (!options.cacheDir || !options.output || !options.version)
        throw new Error('usage: build-type-compiler-prebuilt --cache-dir DIR --output DIR --version VERSION');
    return options;
}

function verifyPortableBinary(binary) {
    const result = spawnSync(resolveGoInspector(), ['version', '-m', binary], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0)
        throw new Error(`could not inspect prepared binary: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);

    const goPlatform = process.platform === 'win32' ? 'windows' : process.platform;
    const settings = new Map(
        result.stdout
            .split(/\r?\n/)
            .map(line => /^\s*build\s+([^=\s]+)=(.*)$/.exec(line))
            .filter(Boolean)
            .map(match => [match[1], match[2]])
    );
    for (const [key, expected] of [
        ['CGO_ENABLED', '0'],
        ['GOOS', goPlatform],
        ['GOARCH', process.arch]
    ]) {
        if (settings.get(key) !== expected) throw new Error(`prepared binary has ${key}=${settings.get(key) ?? 'unknown'}; expected ${expected}`);
    }
}

function resolveGoInspector() {
    if (process.env.TTSC_GO_BINARY) return process.env.TTSC_GO_BINARY;
    const executable = process.platform === 'win32' ? 'go.exe' : 'go';
    try {
        const ttscPackageJson = require.resolve('ttsc/package.json');
        return createRequire(ttscPackageJson).resolve(`@ttsc/${process.platform}-${process.arch}/bin/go/bin/${executable}`);
    } catch {
        return 'go';
    }
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

main(process.argv.slice(2));
