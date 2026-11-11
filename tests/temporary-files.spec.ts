import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { access, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '../src/helpers/io/temporary-files';

const execFileAsync = promisify(execFile);

async function withFiles(fn: (files: TemporaryFiles, root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'talk-temp-test-'));
    const files = new TemporaryFiles(root);
    try {
        await fn(files, root);
    } finally {
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
}

async function age(path: string, patch: Record<string, unknown> = {}) {
    const metadata = join(dirname(path), 'owner.json');
    const content = await readFile(metadata, 'utf8');
    await writeFile(metadata, JSON.stringify({ ...JSON.parse(content), createdAt: Date.now() - 2 * 60 * 60 * 1000, ...patch }));
}

/** Real exited owners exercise process checks rather than mocking away the safety boundary. */
async function orphans(root: string, replayable: boolean[]): Promise<string[]> {
    const script = `
        const { TemporaryFiles } = require(process.argv[1]);
        const fs = require('node:fs/promises');
        (async () => {
            const files = new TemporaryFiles(process.argv[2]);
            const paths = [];
            for (const replayable of JSON.parse(process.argv[3])) {
                const path = await files.create(replayable);
                await fs.writeFile(path, 'recoverable test audio');
                paths.push(path);
            }
            process.stdout.write(JSON.stringify(paths));
        })().catch(() => process.exit(1));
    `;
    const result = await execFileAsync(process.execPath, [
        '-e',
        script,
        require.resolve('../src/helpers/io/temporary-files'),
        root,
        JSON.stringify(replayable)
    ]);
    const paths = JSON.parse(result.stdout) as string[];
    for (const path of paths) await age(path);
    return paths;
}

describe('managed temporary files', () => {
    it('allows only the creating process to mark a workspace replayable', async () => {
        await withFiles(async files => {
            const workspace = await files.createWorkspace();
            await workspace.setReplayable();
            const content = await readFile(join(workspace.directory, 'owner.json'), 'utf8');
            assert.equal(JSON.parse(content).replayable, true);
            await age(workspace.path(), { host: 'foreign-host' });
            await assert.rejects(workspace.setReplayable(), /another process/);
            await workspace.dispose();
        });
    });

    it('preserves an oversized orphan directory rather than performing unbounded recovery', async () => {
        await withFiles(async (files, root) => {
            const [path] = await orphans(root, [true]);
            for (let i = 0; i < 65; i++) await writeFile(join(dirname(path), `extra-${i}`), 'derived');
            const result = await files.sweep();
            assert.equal(result.removed, 0);
            assert.equal(result.retained, 1);
            await access(path);
        });
    });

    it('still releases owned bytes when a full disk prevents writing a release marker', async t => {
        await withFiles(async (files, root) => {
            const path = await files.create();
            await writeFile(path, 'owned staging data');
            t.mock.method(fsPromises, 'writeFile', async () => {
                throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            });
            await files.remove(path);
            const entries = await readdir(root);
            assert.deepEqual(entries, []);
        });
    });

    it('handles an upstream failure before output reservation completes', async t => {
        await withFiles(async (files, root) => {
            const source = new Readable({ read() {} });
            const create = files.create.bind(files);
            t.mock.method(files, 'create', async (replayable = false) => {
                source.destroy(new Error('upstream closed early'));
                return create(replayable);
            });
            await assert.rejects(files.fromStream(source), /upstream closed early/);
            const entries = await readdir(root);
            assert.deepEqual(entries, []);
        });
    });

    it('reserves distinct private paths, streams complete bytes, and releases all metadata', async () => {
        await withFiles(async (files, root) => {
            const [first, second] = await Promise.all([files.fromStream(Readable.from(['first'])), files.fromStream(Readable.from(['second']))]);
            assert.notEqual(first, second);
            const bytes = await readFile(first, 'utf8');
            assert.equal(bytes, 'first');
            const directory = await lstat(dirname(first));
            const data = await lstat(first);
            assert.equal(directory.mode & 0o777, 0o700);
            assert.equal(data.mode & 0o777, 0o600);
            await files.remove(first);
            await files.remove(first); // Idempotent even after the private directory is gone.
            await files.remove(second);
            const entries = await readdir(root);
            assert.deepEqual(entries, []);
        });
    });

    for (const failure of ['error', 'abort'] as const) {
        it(`closes streams and removes partial output on ${failure}`, async () => {
            await withFiles(async (files, root) => {
                const controller = new AbortController();
                const source = new Readable({
                    read() {
                        this.push('partial media');
                        if (failure === 'error') this.destroy(new Error('source failed'));
                        else controller.abort();
                    }
                });
                await assert.rejects(
                    files.fromStream(source, true, controller.signal),
                    failure === 'error' ? /source failed/ : { name: 'AbortError' }
                );
                assert.equal(source.destroyed, true);
                const entries = await readdir(root);
                assert.deepEqual(entries, []);
            });
        });
    }

    it('protects an active file regardless of age, and retries an explicitly released file while its owner lives', async () => {
        await withFiles(async files => {
            const path = await files.create(true);
            await writeFile(path, 'still being used');
            await age(path);
            const protectedResult = await files.sweep();
            assert.equal(protectedResult.removed, 0);
            await access(path);
            // Simulate a process dying between publishing release and unlinking the data.
            await writeFile(join(dirname(path), 'released'), '');
            const releasedResult = await files.sweep();
            assert.equal(releasedResult.removed, 1);
            await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
        });
    });

    it('reclaims only replayable files of exited owners; sole-copy media and legacy names survive', async () => {
        await withFiles(async (files, root) => {
            const [cache, soleCopy, empty] = await orphans(root, [true, false, false]);
            await unlink(empty);
            await writeFile(join(root, 'zynotalk_1700000000000_0.1'), 'legacy unclassified media');
            const result = await files.sweep();
            assert.equal(result.removed, 2);
            assert.equal(result.retained, 1);
            await assert.rejects(access(cache), { code: 'ENOENT' });
            await access(soleCopy);
            await access(join(root, 'zynotalk_1700000000000_0.1'));
        });
    });

    it('fails closed for foreign process namespaces, malformed metadata, symlinks, and unknown children', async () => {
        await withFiles(async (files, root) => {
            const [foreign, malformed, linked, extra] = await orphans(root, [true, true, true, true]);
            await age(foreign, { namespace: 'foreign-pid-namespace' });
            await writeFile(join(dirname(malformed), 'owner.json'), '{bad');
            await unlink(linked);
            await symlink(extra, linked);
            await fsPromises.mkdir(join(dirname(extra), 'unexpected-directory'));
            const result = await files.sweep();
            assert.equal(result.removed, 0);
            for (const path of [foreign, malformed, linked, extra]) await access(path);
        });
    });

    it('bounds each pass and advances beyond preserved entries without overlapping scans', async () => {
        await withFiles(async (files, root) => {
            await orphans(root, [...Array<boolean>(110).fill(false), ...Array<boolean>(30).fill(true)]);
            const first = files.sweep();
            assert.equal(files.sweep(), first);
            const initial = await first;
            const passes = [initial];
            for (let pass = 0; pass < 4; pass++) passes.push(await files.sweep());
            assert.ok(passes.every(pass => pass.scanned <= 100 && pass.removed <= 25));
            assert.equal(
                passes.reduce((total, pass) => total + pass.removed, 0),
                30
            );
            const entries = await readdir(root);
            assert.equal(entries.length, 110);
        });
    });
});
