import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { toError } from '../utils/error';

export interface ExecProcessOptions {
    cwd?: string;
    errorOnNonZero?: boolean;
    stdio?: SpawnOptions['stdio'];
    onSpawn?: (proc: ChildProcess) => void;
    shell?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Abort waits for the child to close before rejecting, so callers can safely dispose its files. */
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Escalate an uncooperative direct child from SIGTERM to SIGKILL. */
    killGraceMs?: number;
}

export interface ExecProcessResult {
    code: number | null;
    stdout: Buffer;
    stderr: Buffer;
}

export async function execProcess(cmd: string, args: readonly string[] = [], options: ExecProcessOptions = {}): Promise<ExecProcessResult> {
    if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
    ) {
        throw new Error('Process timeout must be a positive timer duration');
    }
    const graceMs = options.killGraceMs ?? 1000;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647) throw new Error('Invalid process kill grace period');
    const deadline = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal && deadline ? AbortSignal.any([options.signal, deadline]) : (options.signal ?? deadline);
    if (signal?.aborted) throw processAbortError(signal.reason);
    try {
        return await new Promise<ExecProcessResult>((resolve, reject) => {
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const proc = spawn(cmd, [...args], {
                cwd: options.cwd,
                stdio: options.stdio,
                shell: options.shell,
                env: options.env
            });

            let settled = false;
            let failure: unknown;
            let abortError: Error | undefined;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            const settle = (callback: () => void) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                clearTimeout(killTimer);
                callback();
            };

            const terminate = () => {
                if (proc.exitCode !== null || proc.signalCode !== null) return;
                proc.kill('SIGTERM');
                killTimer ??= setTimeout(() => {
                    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
                }, graceMs);
                killTimer.unref();
            };
            const abort = () => {
                abortError ??= processAbortError(signal?.reason);
                terminate();
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            // Spawn failures and aborts still emit close. Do not release a caller's scope before that boundary.
            proc.on('error', error => {
                failure ??= error;
            });
            proc.on('spawn', () => {
                try {
                    options.onSpawn?.(proc);
                } catch (error) {
                    failure ??= error;
                    terminate();
                }
            });
            proc.stdout?.on('data', data => stdout.push(Buffer.from(data)));
            proc.stderr?.on('data', data => stderr.push(Buffer.from(data)));
            proc.on('close', code => {
                settle(() => {
                    if (abortError || failure) {
                        reject(abortError ?? failure);
                        return;
                    }
                    const result = {
                        code,
                        stdout: Buffer.concat(stdout),
                        stderr: Buffer.concat(stderr)
                    };

                    if (options.errorOnNonZero !== false && code !== 0) {
                        reject(Object.assign(new Error(`Process exited with code ${code}`), { result }));
                        return;
                    }

                    resolve(result);
                });
            });
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw toError(`Failure during execution of process with command: ${formatCommand(cmd, args)}`, error);
    }
}

function processAbortError(reason: unknown): Error {
    return Object.assign(new Error('Process aborted', { cause: reason }), { name: 'AbortError' });
}

function formatCommand(cmd: string, args: readonly string[]): string {
    return [cmd, ...args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg))].join(' ');
}
