import type { Dir } from 'node:fs';
import type { Readable } from 'node:stream';

import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, open, opendir, readFile, readlink, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const PREFIX = 'tsf-temp-v1-';
const DIRECTORY_NAME = /^tsf-temp-v1-[a-zA-Z0-9]{6}$/;
const STALE_AFTER_MS = 60 * 60 * 1000;
const MAX_RECOVERY_FILES = 64;

export interface TemporaryWorkspaceOptions {
    /** Only opt in when a retained source permits replay after the creating process exits. */
    replayable?: boolean;
}

export interface TemporaryFileCleanupResult {
    scanned: number;
    removed: number;
    retained: number;
    failed: number;
}

interface Owner {
    kind: 'file' | 'workspace';
    pid: number;
    host: string;
    boot: string | null;
    namespace: string | null;
    start: string | null;
    createdAt: number;
    replayable: boolean;
}

/** Owns every generated file within a private directory. Dispose only after its users have settled. */
export class TemporaryWorkspace {
    constructor(
        readonly directory: string,
        private readonly files: TemporaryFiles
    ) {}

    /** Allocate a name before starting a writer; the writer may require a nonexistent output file. */
    path(name = 'data'): string {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(name) || ['owner.json', 'released'].includes(name)) {
            throw new Error('Temporary workspace paths must be ordinary leaf filenames');
        }
        return join(this.directory, name);
    }

    async setReplayable(): Promise<void> {
        await this.files.markReplayable(this.directory);
    }

    async dispose(): Promise<void> {
        await this.files.releaseWorkspace(this.directory);
    }
}

/** Process-local staging, never durable storage. Unknown and potentially sole-copy leftovers fail closed. */
export class TemporaryFiles {
    private readonly root: string;
    private directory?: Dir;
    private sweeping?: Promise<TemporaryFileCleanupResult>;

    constructor(root = tmpdir()) {
        this.root = resolve(root);
    }

    async createWorkspace(options: TemporaryWorkspaceOptions = {}): Promise<TemporaryWorkspace> {
        return this.allocateWorkspace(options, 'workspace');
    }

    private async allocateWorkspace(options: TemporaryWorkspaceOptions, kind: Owner['kind']): Promise<TemporaryWorkspace> {
        const directory = await mkdtemp(join(this.root, PREFIX));
        try {
            const identity = await processIdentity(process.pid);
            const owner: Owner = {
                ...identity,
                kind,
                pid: process.pid,
                host: hostname(),
                createdAt: Date.now(),
                replayable: options.replayable === true
            };
            await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
            return new TemporaryWorkspace(directory, this);
        } catch (error) {
            await rm(directory, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }

    async withWorkspace<T>(fn: (workspace: TemporaryWorkspace) => Promise<T>, options: TemporaryWorkspaceOptions = {}): Promise<T> {
        const workspace = await this.createWorkspace(options);
        try {
            return await fn(workspace);
        } finally {
            // Cleanup failure must not replace the operation's outcome; the release marker permits retry.
            await workspace.dispose().catch(() => {});
        }
    }

    /** A reserved single-file workspace. Successful return transfers its lifetime to the caller. */
    async create(replayable = false): Promise<string> {
        const workspace = await this.allocateWorkspace({ replayable }, 'file');
        try {
            const file = await open(workspace.path(), 'wx', 0o600);
            await file.close();
            return workspace.path();
        } catch (error) {
            await workspace.dispose().catch(() => {});
            throw error;
        }
    }

    /** Both pipeline ends settle before a failed/aborted partial output is released. */
    async fromStream(source: Readable, replayable = false, signal?: AbortSignal): Promise<string> {
        let path: string | undefined;
        let earlyError: Error | undefined;
        const rememberError = (error: Error) => {
            earlyError = error;
        };
        source.on('error', rememberError);
        try {
            path = await this.create(replayable);
            if (earlyError) throw earlyError;
            await pipeline(source, createWriteStream(path, { mode: 0o600 }), { signal });
            return path;
        } catch (error) {
            source.destroy();
            if (path) await this.remove(path).catch(() => {});
            throw error;
        } finally {
            source.off('error', rememberError);
        }
    }

    /** Explicit release by the caller, never a filename/age-based ownership inference. */
    async remove(path: string): Promise<void> {
        const directory = dirname(path);
        let singleFile = false;
        if (basename(path) === 'data' && this.ownsDirectory(directory)) {
            try {
                const content = await readFile(join(directory, 'owner.json'), 'utf8');
                const owner = JSON.parse(content) as Owner;
                singleFile = owner.kind === 'file';
            } catch {
                /* Unknown workspace ownership never permits disposing its siblings. */
            }
        }
        if (!singleFile) {
            await unlink(path).catch(error => {
                if (!isMissing(error)) throw error;
            });
            return;
        }
        await this.releaseWorkspace(directory);
    }

    async releaseWorkspace(directory: string): Promise<void> {
        if (!this.ownsDirectory(directory)) throw new Error('Not a managed temporary workspace');
        const info = await lstat(directory).catch(error => {
            if (!isMissing(error)) throw error;
            return undefined;
        });
        if (!info) return;
        const uid = process.getuid?.();
        if (!info.isDirectory() || (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))) {
            throw new Error('Unsafe temporary workspace');
        }
        try {
            await writeFile(join(directory, 'released'), '', { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (isMissing(error)) return;
            // A full disk can block the marker write; still try to release owned bytes immediately.
        }
        // Explicit scope disposal owns the entire directory, including partial/unregistered outputs.
        await rm(directory, { recursive: true, force: true });
    }

    async markReplayable(directory: string): Promise<void> {
        if (!this.ownsDirectory(directory)) throw new Error('Not a managed temporary workspace');
        const content = await readFile(join(directory, 'owner.json'), 'utf8');
        const owner = JSON.parse(content) as Owner;
        const identity = await processIdentity(process.pid);
        if (
            owner.host !== hostname() ||
            owner.pid !== process.pid ||
            owner.start !== identity.start ||
            owner.boot !== identity.boot ||
            owner.namespace !== identity.namespace
        ) {
            throw new Error("Cannot change another process's temporary workspace");
        }
        await writeFile(join(directory, 'owner.json'), JSON.stringify({ ...owner, replayable: true }), { mode: 0o600 });
    }

    sweep(): Promise<TemporaryFileCleanupResult> {
        return (this.sweeping ??= this.sweepBatch().finally(() => {
            this.sweeping = undefined;
        }));
    }

    async close(): Promise<void> {
        await this.sweeping;
        await this.directory?.close();
        this.directory = undefined;
    }

    private ownsDirectory(directory: string): boolean {
        return dirname(directory) === this.root && DIRECTORY_NAME.test(basename(directory));
    }

    private async sweepBatch(): Promise<TemporaryFileCleanupResult> {
        const result = { scanned: 0, removed: 0, retained: 0, failed: 0 };
        this.directory ??= await opendir(this.root);
        while (result.scanned < 100 && result.removed < 25) {
            const entry = await this.directory.read();
            if (!entry) {
                await this.directory.close();
                this.directory = undefined;
                break;
            }
            result.scanned++;
            if (!entry.isDirectory() || !DIRECTORY_NAME.test(entry.name)) continue;
            const directory = join(this.root, entry.name);
            try {
                const files = await this.recoverableFiles(directory);
                if (!files) {
                    result.retained++;
                    continue;
                }
                // No recursive recovery: bound directory entries and never follow links or foreign children.
                for (const name of files.filter(name => name !== 'owner.json' && name !== 'released')) await unlink(join(directory, name));
                for (const name of ['owner.json', 'released'])
                    await unlink(join(directory, name)).catch(error => {
                        if (!isMissing(error)) throw error;
                    });
                await rmdir(directory);
                result.removed++;
            } catch (error) {
                if (!isMissing(error)) result.failed++;
            }
        }
        return result;
    }

    private async recoverableFiles(directory: string): Promise<string[] | undefined> {
        const info = await lstat(directory);
        if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) return;
        const entries = await opendir(directory);
        const files: string[] = [];
        try {
            for (let count = 0; count <= MAX_RECOVERY_FILES; count++) {
                const entry = await entries.read();
                if (!entry) break;
                if (count === MAX_RECOVERY_FILES) return;
                const stat = await lstat(join(directory, entry.name));
                if (!stat.isFile() || stat.nlink !== 1) return;
                files.push(entry.name);
            }
        } finally {
            await entries.close();
        }
        if (files.includes('released')) return files;
        const metadata = await lstat(join(directory, 'owner.json'));
        if (metadata.size > 2048) return;
        const content = await readFile(join(directory, 'owner.json'), 'utf8');
        const owner = JSON.parse(content) as Owner;
        if (
            !owner ||
            !['file', 'workspace'].includes(owner.kind) ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0 ||
            owner.host !== hostname() ||
            typeof owner.replayable !== 'boolean' ||
            ![owner.boot, owner.namespace, owner.start].every(value => value === null || typeof value === 'string') ||
            (process.platform === 'linux' && (!owner.boot || !owner.namespace || typeof owner.start !== 'string' || !/^\d+$/.test(owner.start))) ||
            typeof owner.createdAt !== 'number' ||
            !Number.isFinite(owner.createdAt) ||
            owner.createdAt < 0 ||
            Date.now() - owner.createdAt < STALE_AFTER_MS
        )
            return;
        const exited = await ownerExited(owner);
        if (!exited) return;
        return owner.replayable || files.length === 1 ? files : undefined;
    }
}

async function processIdentity(pid: number): Promise<Pick<Owner, 'boot' | 'namespace' | 'start'>> {
    if (process.platform !== 'linux') return { boot: null, namespace: null, start: null };
    const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
    const namespace = await readlink('/proc/self/ns/pid');
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (!start) throw new Error('Missing process start identity');
    return { boot: boot.trim(), namespace, start };
}

async function ownerExited(owner: Owner): Promise<boolean> {
    try {
        const current = await processIdentity(process.pid);
        if (owner.boot !== current.boot || owner.namespace !== current.namespace) return false;
        process.kill(owner.pid, 0);
        if (process.platform !== 'linux') return false;
        const identity = await processIdentity(owner.pid);
        // A reused PID can only have a later start tick in this same boot/namespace.
        // Future/impossible metadata is not proof that an owner exited.
        return typeof owner.start === 'string' && identity.start !== null && BigInt(owner.start) < BigInt(identity.start);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export const temporaryFiles = new TemporaryFiles();

export function withTemporaryWorkspace<T>(fn: (workspace: TemporaryWorkspace) => Promise<T>, options: TemporaryWorkspaceOptions = {}): Promise<T> {
    return temporaryFiles.withWorkspace(fn, options);
}
