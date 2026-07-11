import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { toError } from '../utils/error';

export interface ExecProcessOptions {
    cwd?: string;
    errorOnNonZero?: boolean;
    stdio?: SpawnOptions['stdio'];
    onSpawn?: (proc: ChildProcess) => void;
    shell?: boolean;
    env?: NodeJS.ProcessEnv;
}

export interface ExecProcessResult {
    code: number | null;
    stdout: Buffer;
    stderr: Buffer;
}

export async function execProcess(cmd: string, args: readonly string[] = [], options: ExecProcessOptions = {}): Promise<ExecProcessResult> {
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
            const settle = (callback: () => void) => {
                if (settled) return;
                settled = true;
                callback();
            };

            proc.on('error', error => settle(() => reject(error)));
            proc.on('spawn', () => {
                try {
                    options.onSpawn?.(proc);
                } catch (error) {
                    if (!proc.killed) proc.kill();
                    settle(() => reject(error));
                }
            });
            proc.stdout?.on('data', data => stdout.push(Buffer.from(data)));
            proc.stderr?.on('data', data => stderr.push(Buffer.from(data)));
            proc.on('close', code => {
                settle(() => {
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
        throw toError(`Failure during execution of process with command: ${formatCommand(cmd, args)}`, error);
    }
}

function formatCommand(cmd: string, args: readonly string[]): string {
    return [cmd, ...args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg))].join(' ');
}
