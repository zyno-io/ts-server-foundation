'use strict';
/* oxlint-disable typescript/no-require-imports -- this file ships with the CommonJS plugin descriptor. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_RELEASE_BASE_URL = 'https://github.com/zyno-io/ts-server-foundation/releases/download';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;
const PREBUILT_MISS_TTL_MS = 10 * 60 * 1000;
const PREBUILT_SCHEMA_VERSION = 1;
const attemptedCacheKeys = new Set();
const customGoEnvironmentKeys = [
    'GOOS',
    'GOARCH',
    'GOAMD64',
    'GOARM',
    'GOARM64',
    'GO386',
    'GOMIPS',
    'GOMIPS64',
    'GOPPC64',
    'GORISCV64',
    'GOWASM',
    'GOFLAGS',
    'GOEXPERIMENT',
    'GOFIPS140',
    'GO_EXTLINK_ENABLED',
    'GCCGO',
    'GCCGOTOOLDIR',
    'CGO_ENABLED',
    'AR',
    'CC',
    'CXX',
    'FC',
    'PKG_CONFIG',
    'CGO_CFLAGS',
    'CGO_CFLAGS_ALLOW',
    'CGO_CFLAGS_DISALLOW',
    'CGO_CPPFLAGS',
    'CGO_CPPFLAGS_ALLOW',
    'CGO_CPPFLAGS_DISALLOW',
    'CGO_CXXFLAGS',
    'CGO_CXXFLAGS_ALLOW',
    'CGO_CXXFLAGS_DISALLOW',
    'CGO_FFLAGS',
    'CGO_FFLAGS_ALLOW',
    'CGO_FFLAGS_DISALLOW',
    'CGO_LDFLAGS',
    'CGO_LDFLAGS_ALLOW',
    'CGO_LDFLAGS_DISALLOW',
    'GOTOOLCHAIN',
    'GOROOT',
    'CPATH',
    'C_INCLUDE_PATH',
    'CPLUS_INCLUDE_PATH',
    'DYLD_LIBRARY_PATH',
    'INCLUDE',
    'LD_LIBRARY_PATH',
    'LIB',
    'LIBRARY_PATH',
    'LIBPATH',
    'MACOSX_DEPLOYMENT_TARGET',
    'OBJC_INCLUDE_PATH',
    'PKG_CONFIG_ALLOW_SYSTEM_CFLAGS',
    'PKG_CONFIG_ALLOW_SYSTEM_LIBS',
    'PKG_CONFIG_LIBDIR',
    'PKG_CONFIG_PATH',
    'PKG_CONFIG_SYSROOT_DIR',
    'PKG_CONFIG_TOP_BUILD_DIR',
    'SDKROOT'
];

function tryInstallPrebuiltTypeCompiler(context, source) {
    try {
        if (!prebuiltDownloadsEnabled() || !context?.projectRoot || hasCustomGoBuildEnvironment()) return false;

        const packageRoot = findFoundationPackageRoot(context.dirname);
        const packageVersion = readJson(path.join(packageRoot, 'package.json')).version;
        if (!isPublishedReleaseVersion(packageVersion)) return false;

        const build = resolveTtscBuild(context.projectRoot, source);
        const target = `${process.platform}-${process.arch}`;
        const destination = path.join(build.cachePaths.pluginRoot, build.cacheKey, process.platform === 'win32' ? 'plugin.exe' : 'plugin');
        if (fs.existsSync(destination)) return true;

        const attemptKey = `${packageVersion}:${target}:${build.cacheKey}`;
        if (attemptedCacheKeys.has(attemptKey)) return false;
        attemptedCacheKeys.add(attemptKey);

        const missMarker = path.join(build.cachePaths.root, 'prebuilt-misses', crypto.createHash('sha256').update(attemptKey).digest('hex'));
        if (isFreshMissMarker(missMarker)) return false;

        const assets = prebuiltAssetNames(target);
        const releaseBaseUrl = (process.env.TSF_TYPE_COMPILER_PREBUILT_BASE_URL ?? DEFAULT_RELEASE_BASE_URL).replace(/\/+$/, '');
        const releaseUrl = `${releaseBaseUrl}/${encodeURIComponent(`v${packageVersion}`)}`;
        const timeout = resolveDownloadTimeout();
        const result = spawnSync(process.execPath, [path.join(__dirname, 'download-prebuilt.cjs')], {
            encoding: 'utf8',
            input: JSON.stringify({
                allowHttp: process.env.TSF_TYPE_COMPILER_PREBUILT_ALLOW_HTTP === '1',
                binaryUrl: `${releaseUrl}/${encodeURIComponent(assets.binary)}`,
                destination,
                expected: {
                    binaryAsset: assets.binary,
                    packageVersion,
                    platform: process.platform,
                    arch: process.arch,
                    pluginSourceSha256: hashPluginSource(source),
                    schemaVersion: PREBUILT_SCHEMA_VERSION,
                    ttscVersion: build.ttscVersion,
                    typescriptVersion: build.typescriptVersion
                },
                manifestUrl: `${releaseUrl}/${encodeURIComponent(assets.manifest)}`,
                requestTimeoutMs: Math.min(timeout, 15_000)
            }),
            timeout,
            windowsHide: true
        });
        if (result.status === 0 && fs.existsSync(destination)) {
            fs.rmSync(missMarker, { force: true });
            debug(`installed ${target} prebuilt compiler in ${destination}`);
            return true;
        }

        recordMiss(missMarker, result.error?.message ?? result.stderr ?? result.stdout ?? `exit ${result.status}`);
        return false;
    } catch (error) {
        debug(`prebuilt compiler unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

function resolveTtscBuild(projectRoot, source) {
    const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
    const ttscPackageJson = projectRequire.resolve('ttsc/package.json');
    const ttscRoot = path.dirname(ttscPackageJson);
    const internalsPath = path.join(ttscRoot, 'lib', 'plugin', 'internal', 'buildSourcePlugin.js');
    const internals = require(internalsPath);
    if (typeof internals.computeCacheKey !== 'function' || typeof internals.resolveSourceBuildCachePaths !== 'function') {
        throw new Error('installed ttsc does not expose compatible cache helpers');
    }

    const ttscVersion = readJson(ttscPackageJson).version;
    const typescriptVersion = readJson(projectRequire.resolve('typescript/package.json')).version;
    const goBinary = resolveGoBinary(ttscRoot, internalsPath);
    const cacheKey = internals.computeCacheKey({
        dir: source,
        entry: '.',
        goBinary,
        overlayDirs: findTtscOverlayDirs(ttscRoot),
        ttscVersion,
        tsgoVersion: typescriptVersion
    });
    return {
        cacheKey,
        cachePaths: internals.resolveSourceBuildCachePaths(projectRoot),
        ttscVersion,
        typescriptVersion
    };
}

function resolveGoBinary(ttscRoot, internalsPath) {
    if (process.env.TTSC_GO_BINARY) return process.env.TTSC_GO_BINARY;
    const executable = process.platform === 'win32' ? 'go.exe' : 'go';
    try {
        return createRequire(internalsPath).resolve(`@ttsc/${process.platform}-${process.arch}/bin/go/bin/${executable}`);
    } catch {
        const platformPackage = path.resolve(ttscRoot, '..', `ttsc-${process.platform}-${process.arch}`, 'bin', 'go', 'bin', executable);
        if (fs.existsSync(platformPackage)) return platformPackage;
        const local = path.resolve(ttscRoot, '..', 'native', 'go', 'bin', executable);
        if (fs.existsSync(local)) return local;
        const homeSdk = path.join(process.env.HOME ?? '', 'go-sdk', 'go', 'bin', executable);
        if (fs.existsSync(homeSdk)) return homeSdk;
        return 'go';
    }
}

function findTtscOverlayDirs(ttscRoot) {
    const directories = [];
    if (fs.existsSync(path.join(ttscRoot, 'go.mod'))) directories.push(ttscRoot);
    collectGoModules(path.join(ttscRoot, 'shim'), directories);
    return directories.sort();
}

function collectGoModules(directory, output) {
    if (!fs.existsSync(directory)) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === 'go.mod')) output.push(directory);
    for (const entry of entries) {
        if (!entry.isDirectory() || ['.git', '.ttsc', 'node_modules'].includes(entry.name)) continue;
        collectGoModules(path.join(directory, entry.name), output);
    }
}

function hashPluginSource(root) {
    const hash = crypto.createHash('sha256');
    for (const file of collectSourceFiles(root)) {
        hash.update(`f=${path.relative(root, file).replaceAll(path.sep, '/')}\n`);
        hash.update(fs.readFileSync(file));
        hash.update('\n');
    }
    return hash.digest('hex');
}

function collectSourceFiles(root) {
    const output = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && ['.git', '.ttsc', 'node_modules'].includes(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && !shouldOmitSourceFile(entry.name)) output.push(file);
        }
    };
    walk(root);
    return output.sort();
}

function shouldOmitSourceFile(name) {
    return (
        name === 'go.work' ||
        name === 'go.work.sum' ||
        name.endsWith('~') ||
        name.endsWith('.tgz') ||
        name.endsWith('.tar.gz') ||
        name === '.DS_Store' ||
        name === 'Thumbs.db'
    );
}

function prebuiltAssetNames(target) {
    const base = `tsf-type-compiler-${target}`;
    return {
        binary: target.startsWith('win32-') ? `${base}.exe` : base,
        manifest: `${base}.json`
    };
}

function findFoundationPackageRoot(start) {
    let directory = path.resolve(start);
    for (;;) {
        const packageJson = path.join(directory, 'package.json');
        if (fs.existsSync(packageJson)) {
            const pkg = readJson(packageJson);
            if (pkg.name === '@zyno-io/ts-server-foundation') return directory;
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error('could not locate the ts-server-foundation package root');
        directory = parent;
    }
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function prebuiltDownloadsEnabled() {
    return !['0', 'false', 'off'].includes((process.env.TSF_TYPE_COMPILER_PREBUILT ?? '').toLowerCase());
}

function isPublishedReleaseVersion(version) {
    return typeof version === 'string' && version !== '0.0.0-dev' && !version.includes('-canary.') && /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version);
}

function hasCustomGoBuildEnvironment() {
    if (process.env.TTSC_GO_BINARY) return true;
    return customGoEnvironmentKeys.some(key => {
        const value = process.env[key];
        return value !== undefined && value !== '' && !(key === 'CGO_ENABLED' && value === '0');
    });
}

function resolveDownloadTimeout() {
    const parsed = Number(process.env.TSF_TYPE_COMPILER_PREBUILT_TIMEOUT_MS ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    return Number.isFinite(parsed) ? Math.max(1000, Math.min(120_000, Math.floor(parsed))) : DEFAULT_DOWNLOAD_TIMEOUT_MS;
}

function isFreshMissMarker(file) {
    try {
        return Date.now() - fs.statSync(file).mtimeMs < PREBUILT_MISS_TTL_MS;
    } catch {
        return false;
    }
}

function recordMiss(file, reason) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${String(reason).trim().slice(0, 2000)}\n`);
    } catch {
        // A read-only cache must never prevent ttsc's source-build fallback.
    }
    debug(`prebuilt compiler unavailable: ${String(reason).trim()}`);
}

function debug(message) {
    if (process.env.TSF_TYPE_COMPILER_PREBUILT_DEBUG === '1') process.stderr.write(`tsf type compiler: ${message}\n`);
}

module.exports = {
    PREBUILT_SCHEMA_VERSION,
    hashPluginSource,
    isPublishedReleaseVersion,
    prebuiltAssetNames,
    resolveTtscBuild,
    tryInstallPrebuiltTypeCompiler
};
