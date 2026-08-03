'use strict';
/* oxlint-disable typescript/no-require-imports -- this helper is spawned by the CommonJS plugin descriptor. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;

async function main() {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const manifest = JSON.parse((await download(input.manifestUrl, MAX_MANIFEST_BYTES, input)).toString('utf8'));
    validateManifest(manifest, input.expected);

    const binary = await download(input.binaryUrl, MAX_BINARY_BYTES, input);
    const digest = crypto.createHash('sha256').update(binary).digest('hex');
    if (digest !== manifest.binarySha256) throw new Error(`binary checksum mismatch: expected ${manifest.binarySha256}, received ${digest}`);
    if (binary.length !== manifest.binarySize) throw new Error(`binary size mismatch: expected ${manifest.binarySize}, received ${binary.length}`);

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tsf-type-compiler-'));
    const temporaryBinary = path.join(temporaryDirectory, path.basename(input.destination));
    try {
        fs.writeFileSync(temporaryBinary, binary, { mode: 0o755 });
        fs.mkdirSync(path.dirname(input.destination), { recursive: true });
        if (fs.existsSync(input.destination)) return;
        try {
            fs.renameSync(temporaryBinary, input.destination);
        } catch (error) {
            if (!fs.existsSync(input.destination)) throw error;
        }
        if (process.platform !== 'win32') fs.chmodSync(input.destination, 0o755);
    } finally {
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
}

function validateManifest(manifest, expected) {
    for (const key of [
        'schemaVersion',
        'packageVersion',
        'platform',
        'arch',
        'pluginSourceSha256',
        'ttscVersion',
        'typescriptVersion',
        'binaryAsset'
    ]) {
        if (manifest[key] !== expected[key]) throw new Error(`manifest ${key} mismatch: expected ${expected[key]}, received ${manifest[key]}`);
    }
    if (manifest.cgoEnabled !== false) throw new Error('prebuilt compiler must be produced with CGO_ENABLED=0');
    if (!/^[a-f0-9]{64}$/.test(manifest.binarySha256)) throw new Error('manifest has an invalid binary checksum');
    if (!Number.isSafeInteger(manifest.binarySize) || manifest.binarySize <= 0 || manifest.binarySize > MAX_BINARY_BYTES) {
        throw new Error('manifest has an invalid binary size');
    }
}

function download(location, maximumBytes, options, redirects = 0) {
    const url = new URL(location);
    if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) {
        throw new Error(`refusing prebuilt compiler URL protocol ${url.protocol}`);
    }
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = client.get(
            url,
            {
                headers: {
                    Accept: 'application/octet-stream, application/json',
                    'User-Agent': 'ts-server-foundation-type-compiler'
                }
            },
            response => {
                if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    if (redirects >= MAX_REDIRECTS) return reject(new Error('too many prebuilt compiler redirects'));
                    return resolve(download(new URL(response.headers.location, url).href, maximumBytes, options, redirects + 1));
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    return reject(new Error(`prebuilt compiler request returned HTTP ${response.statusCode}`));
                }
                const declaredLength = Number(response.headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
                    response.destroy();
                    return reject(new Error(`prebuilt compiler response exceeds ${maximumBytes} bytes`));
                }
                const chunks = [];
                let size = 0;
                response.on('data', chunk => {
                    size += chunk.length;
                    if (size > maximumBytes) {
                        response.destroy(new Error(`prebuilt compiler response exceeds ${maximumBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => resolve(Buffer.concat(chunks)));
                response.on('error', reject);
            }
        );
        request.setTimeout(options.requestTimeoutMs, () => request.destroy(new Error('prebuilt compiler request timed out')));
        request.on('error', reject);
    });
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
