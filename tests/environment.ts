/** Restore keys in place so Node child processes see the same native environment. */
export function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
}
