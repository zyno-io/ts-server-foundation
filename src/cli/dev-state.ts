import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const TSF_DEV_STATE_FILE_ENV = 'TSF_DEV_STATE_FILE';
export const TSF_DEV_RUN_ID_ENV = 'TSF_DEV_RUN_ID';
export const TSF_DEV_RUNNER_PID_ENV = 'TSF_DEV_RUNNER_PID';

export interface DevRunState {
    runId: string;
    runnerPid: number;
    appPid?: number;
    script: string;
    command: string[];
    devConsoleUrl?: string;
    startedAt: number;
    updatedAt: number;
}

export interface DevState {
    version: 2;
    ready: boolean;
    pids: number[];
    runs: Record<string, DevRunState>;
}

export interface DevStatePaths {
    stateFile: string;
    buildLockFile: string;
}

export function getDevStatePaths(projectDir: string): DevStatePaths {
    const canonicalDir = canonicalProjectDirectory(projectDir);
    const projectHash = createHash('md5').update(canonicalDir).digest('hex').slice(0, 12);
    return {
        stateFile: resolve(tmpdir(), `tsf-dev-${projectHash}.json`),
        buildLockFile: resolve(tmpdir(), `tsf-dev-${projectHash}.lock`)
    };
}

export function readDevState(stateFile: string): DevState | undefined {
    try {
        return normalizeDevState(JSON.parse(readFileSync(stateFile, 'utf8')));
    } catch {
        return undefined;
    }
}

export function updateDevState(stateFile: string, update: (state: DevState) => void): DevState {
    return withStateLock(stateFile, () => {
        const state = readDevState(stateFile) ?? emptyDevState();
        update(state);
        writeDevState(stateFile, state);
        return state;
    });
}

export function pruneDevState(stateFile: string): DevState | undefined {
    if (!existsSync(stateFile)) return undefined;
    return updateDevState(stateFile, state => {
        state.pids = state.pids.filter(isPidAlive);
        for (const [runId, run] of Object.entries(state.runs)) {
            const runnerAlive = isPidAlive(run.runnerPid);
            const appAlive = isPidAlive(run.appPid);
            if (!appAlive) {
                delete run.appPid;
                delete run.devConsoleUrl;
            }
            if (!runnerAlive && !appAlive) delete state.runs[runId];
        }
    });
}

export function registerDevRun(stateFile: string, run: DevRunState): void {
    updateDevState(stateFile, state => {
        state.pids = state.pids.filter(isPidAlive);
        if (!state.pids.includes(run.runnerPid)) state.pids.push(run.runnerPid);
        state.runs[run.runId] = run;
    });
}

export function unregisterDevRun(stateFile: string, runId: string, runnerPid: number): void {
    updateDevState(stateFile, state => {
        const run = state.runs[runId];
        if (run?.runnerPid === runnerPid) delete state.runs[runId];
        state.pids = state.pids.filter(pid => pid !== runnerPid && isPidAlive(pid));
    });
}

export function publishDevConsoleEndpoint(server: Server): (() => void) | undefined {
    const stateFile = process.env[TSF_DEV_STATE_FILE_ENV];
    const runId = process.env[TSF_DEV_RUN_ID_ENV];
    const runnerPid = Number(process.env[TSF_DEV_RUNNER_PID_ENV]);
    const devConsoleUrl = getLoopbackDevConsoleUrl(server);
    if (!stateFile || !runId || !Number.isSafeInteger(runnerPid) || runnerPid <= 0 || !devConsoleUrl) return undefined;

    const appPid = process.pid;
    const now = Date.now();
    updateDevState(stateFile, state => {
        const existing = state.runs[runId];
        state.pids = state.pids.filter(isPidAlive);
        if (!state.pids.includes(runnerPid)) state.pids.push(runnerPid);
        state.runs[runId] = {
            runId,
            runnerPid,
            appPid,
            script: existing?.script ?? '.',
            command: existing?.command ?? [],
            devConsoleUrl,
            startedAt: existing?.startedAt ?? now,
            updatedAt: now
        };
    });

    return () => {
        updateDevState(stateFile, state => {
            const run = state.runs[runId];
            if (run?.appPid !== appPid) return;
            delete run.appPid;
            delete run.devConsoleUrl;
            run.updatedAt = Date.now();
        });
    };
}

export function getLoopbackDevConsoleUrl(server: Server): string | undefined {
    const address = server.address();
    if (!address || typeof address === 'string') return undefined;

    let host: string;
    switch (address.address) {
        case '::':
        case '::1':
            host = '[::1]';
            break;
        case '0.0.0.0':
        case '127.0.0.1':
        case '::ffff:127.0.0.1':
            host = '127.0.0.1';
            break;
        default:
            return undefined;
    }

    return `ws://${host}:${address.port}/_devconsole/ws`;
}

export function isPidAlive(pid: number | undefined): boolean {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function emptyDevState(): DevState {
    return { version: 2, ready: false, pids: [], runs: {} };
}

function normalizeDevState(value: unknown): DevState {
    if (!value || typeof value !== 'object') throw new Error('Invalid tsf-dev state');
    const raw = value as Partial<DevState>;
    const pids = Array.isArray(raw.pids) ? raw.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0) : [];
    const runs: Record<string, DevRunState> = {};
    if (raw.runs && typeof raw.runs === 'object') {
        for (const [runId, candidate] of Object.entries(raw.runs)) {
            if (!candidate || typeof candidate !== 'object') continue;
            const run = candidate as Partial<DevRunState>;
            if (!Number.isSafeInteger(run.runnerPid) || !run.runnerPid || run.runnerPid <= 0) continue;
            runs[runId] = {
                runId,
                runnerPid: run.runnerPid,
                appPid: Number.isSafeInteger(run.appPid) && run.appPid! > 0 ? run.appPid : undefined,
                script: typeof run.script === 'string' ? run.script : '.',
                command: Array.isArray(run.command) ? run.command.filter(item => typeof item === 'string') : [],
                devConsoleUrl: typeof run.devConsoleUrl === 'string' ? run.devConsoleUrl : undefined,
                startedAt: typeof run.startedAt === 'number' ? run.startedAt : 0,
                updatedAt: typeof run.updatedAt === 'number' ? run.updatedAt : 0
            };
        }
    }
    return {
        version: 2,
        ready: raw.ready === true,
        pids,
        runs
    };
}

function writeDevState(stateFile: string, state: DevState): void {
    mkdirSync(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
        renameSync(temporary, stateFile);
    } finally {
        try {
            unlinkSync(temporary);
        } catch {
            // The atomic rename normally removes the temporary path.
        }
    }
}

function withStateLock<T>(stateFile: string, callback: () => T): T {
    const lockFile = `${stateFile}.state-lock`;
    const startedAt = Date.now();
    while (true) {
        try {
            writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            removeStaleLock(lockFile);
            if (Date.now() - startedAt >= 2_000) throw new Error(`Timed out waiting for tsf-dev state lock: ${lockFile}`);
            sleepSync(10);
        }
    }

    try {
        return callback();
    } finally {
        try {
            unlinkSync(lockFile);
        } catch {
            // Ignore cleanup races with stale-lock recovery.
        }
    }
}

function removeStaleLock(lockFile: string): void {
    try {
        const owner = readFileSync(lockFile, 'utf8').trim();
        const ownerPid = Number(owner);
        if (owner && isPidAlive(ownerPid)) return;
        if (!owner && Date.now() - statSync(lockFile).mtimeMs < 100) return;
        unlinkSync(lockFile);
    } catch {
        try {
            unlinkSync(lockFile);
        } catch {
            // Another process may have released it already.
        }
    }
}

function sleepSync(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function canonicalProjectDirectory(projectDir: string): string {
    try {
        return realpathSync(projectDir);
    } catch {
        return resolve(projectDir);
    }
}
