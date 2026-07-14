import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

// oxlint-disable-next-line typescript/no-require-imports
const prebuilt = require('../src/type-compiler/prebuilt.cjs') as {
    hashPluginSource(root: string): string;
    isPublishedReleaseVersion(version: unknown): boolean;
    prebuiltAssetNames(target: string): { binary: string; manifest: string };
};
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    devDependencies: { ttsc: string; typescript: string };
};

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>(resolve => {
                    server.close(() => resolve());
                })
        )
    );
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'tsf-type-compiler-prebuilt-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function serve(files: Record<string, Buffer | string>): Promise<string> {
    const server = http.createServer((request, response) => {
        const body = files[request.url ?? ''];
        if (body === undefined) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) }).end(body);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
}

async function runDownloader(input: unknown): Promise<{ status: number | null; stderr: string }> {
    const child = spawn(process.execPath, [join(process.cwd(), 'src', 'type-compiler', 'download-prebuilt.cjs')], {
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 30_000
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => (stderr += chunk));
    child.stdin.end(JSON.stringify(input));
    const status = await new Promise<number | null>(resolve => child.once('close', resolve));
    return { status, stderr };
}

async function runNode(script: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string; stdout: string }> {
    const child = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => (stderr += chunk));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    const status = await new Promise<number | null>(resolve => child.once('close', resolve));
    return { status, stderr, stdout };
}

function publishedFoundation(directory: string): { dirname: string; source: string; version: string } {
    const root = join(directory, 'foundation');
    const dirname = join(root, 'dist', 'src', 'type-compiler');
    const source = join(dirname, 'go');
    const version = '26.714.1200';
    mkdirSync(dirname, { recursive: true });
    cpSync(join(process.cwd(), 'src', 'type-compiler', 'go'), source, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@zyno-io/ts-server-foundation', version }));
    return { dirname, source, version };
}

function fixture(directory: string) {
    const binary = Buffer.from('portable type compiler fixture');
    const expected = {
        schemaVersion: 1,
        packageVersion: '26.714.1200',
        platform: process.platform,
        arch: process.arch,
        pluginSourceSha256: 'a'.repeat(64),
        ttscVersion: packageJson.devDependencies.ttsc,
        typescriptVersion: packageJson.devDependencies.typescript,
        binaryAsset: `tsf-type-compiler-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
    };
    const manifest = {
        ...expected,
        cgoEnabled: false,
        binarySha256: crypto.createHash('sha256').update(binary).digest('hex'),
        binarySize: binary.length
    };
    return {
        binary,
        destination: join(directory, 'cache', process.platform === 'win32' ? 'plugin.exe' : 'plugin'),
        expected,
        manifest
    };
}

describe('type compiler prebuilds', () => {
    it('recognizes release versions and platform asset names', () => {
        assert.equal(prebuilt.isPublishedReleaseVersion('26.714.1200'), true);
        assert.equal(prebuilt.isPublishedReleaseVersion('0.0.0-dev'), false);
        assert.equal(prebuilt.isPublishedReleaseVersion('26.714.1200-canary.abcdef0'), false);
        assert.deepStrictEqual(prebuilt.prebuiltAssetNames('linux-x64'), {
            binary: 'tsf-type-compiler-linux-x64',
            manifest: 'tsf-type-compiler-linux-x64.json'
        });
        assert.deepStrictEqual(prebuilt.prebuiltAssetNames('win32-arm64'), {
            binary: 'tsf-type-compiler-win32-arm64.exe',
            manifest: 'tsf-type-compiler-win32-arm64.json'
        });
    });

    it('hashes the complete plugin source deterministically', () => {
        const directory = temporaryDirectory();
        writeFileSync(join(directory, 'plugin.go'), 'package main\n');
        const first = prebuilt.hashPluginSource(directory);
        assert.equal(first, prebuilt.hashPluginSource(directory));
        writeFileSync(join(directory, 'plugin.go'), 'package main\n\nfunc main() {}\n');
        assert.notEqual(prebuilt.hashPluginSource(directory), first);
    });

    it('downloads and atomically installs a verified prebuilt binary', async () => {
        const directory = temporaryDirectory();
        const value = fixture(directory);
        const baseUrl = await serve({
            '/binary': value.binary,
            '/manifest': JSON.stringify(value.manifest)
        });
        const result = await runDownloader({
            allowHttp: true,
            binaryUrl: `${baseUrl}/binary`,
            destination: value.destination,
            expected: value.expected,
            manifestUrl: `${baseUrl}/manifest`,
            requestTimeoutMs: 5000
        });

        assert.equal(result.status, 0, result.stderr);
        assert.deepStrictEqual(readFileSync(value.destination), value.binary);
    });

    it('seeds the exact consumer ttsc cache through the published plugin resolver', async () => {
        const directory = temporaryDirectory();
        const foundation = publishedFoundation(directory);
        const cache = join(directory, 'ttsc-cache');
        const value = fixture(directory);
        value.expected.packageVersion = foundation.version;
        value.expected.pluginSourceSha256 = prebuilt.hashPluginSource(foundation.source);
        value.manifest.packageVersion = foundation.version;
        value.manifest.pluginSourceSha256 = value.expected.pluginSourceSha256;
        const target = `${process.platform}-${process.arch}`;
        const assets = prebuilt.prebuiltAssetNames(target);
        const baseUrl = await serve({
            [`/v${foundation.version}/${assets.binary}`]: value.binary,
            [`/v${foundation.version}/${assets.manifest}`]: JSON.stringify(value.manifest)
        });
        const modulePath = join(process.cwd(), 'src', 'type-compiler', 'prebuilt.cjs');
        const result = await runNode(
            `
                const prebuilt = require(${JSON.stringify(modulePath)});
                const installed = prebuilt.tryInstallPrebuiltTypeCompiler(
                    { dirname: ${JSON.stringify(foundation.dirname)}, projectRoot: ${JSON.stringify(process.cwd())} },
                    ${JSON.stringify(foundation.source)}
                );
                process.stdout.write(JSON.stringify(installed));
            `,
            {
                TSF_TYPE_COMPILER_PREBUILT_ALLOW_HTTP: '1',
                TSF_TYPE_COMPILER_PREBUILT_BASE_URL: baseUrl,
                TSF_TYPE_COMPILER_PREBUILT_TIMEOUT_MS: '5000',
                TTSC_CACHE_DIR: cache
            }
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout), true);
        const cacheEntries = readdirSync(join(cache, 'plugins'));
        assert.equal(cacheEntries.length, 1);
        const cachedBinary = join(cache, 'plugins', cacheEntries[0], process.platform === 'win32' ? 'plugin.exe' : 'plugin');
        assert.deepStrictEqual(readFileSync(cachedBinary), value.binary);
    });

    it('returns the source descriptor when a release asset cannot be downloaded', async () => {
        const directory = temporaryDirectory();
        const foundation = publishedFoundation(directory);
        const baseUrl = await serve({});
        const modulePath = join(process.cwd(), 'src', 'type-compiler', 'index.cjs');
        const result = await runNode(
            `
                const plugin = require(${JSON.stringify(modulePath)});
                const descriptor = plugin({ dirname: ${JSON.stringify(foundation.dirname)}, projectRoot: ${JSON.stringify(process.cwd())} });
                process.stdout.write(JSON.stringify(descriptor));
            `,
            {
                TSF_TYPE_COMPILER_PREBUILT_ALLOW_HTTP: '1',
                TSF_TYPE_COMPILER_PREBUILT_BASE_URL: baseUrl,
                TSF_TYPE_COMPILER_PREBUILT_TIMEOUT_MS: '5000',
                TTSC_CACHE_DIR: join(directory, 'ttsc-cache')
            }
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepStrictEqual(JSON.parse(result.stdout), {
            name: 'tsf-type-metadata',
            source: foundation.source
        });
    });

    it('rejects a corrupt prebuilt and leaves the cache empty for source fallback', async () => {
        const directory = temporaryDirectory();
        const value = fixture(directory);
        const baseUrl = await serve({
            '/binary': Buffer.from('corrupt'),
            '/manifest': JSON.stringify(value.manifest)
        });
        const result = await runDownloader({
            allowHttp: true,
            binaryUrl: `${baseUrl}/binary`,
            destination: value.destination,
            expected: value.expected,
            manifestUrl: `${baseUrl}/manifest`,
            requestTimeoutMs: 5000
        });

        assert.equal(result.status, 1);
        assert.match(result.stderr, /checksum mismatch/);
        assert.equal(existsSync(value.destination), false);
    });
});
