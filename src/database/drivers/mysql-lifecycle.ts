import { getCurrentApp } from '../../app/current';

type MySQLCleanup = () => Promise<void>;

// Keep cleanup reachable when application modules are reloaded in the same process.
const cleanupKey = Symbol.for('@zyno-io/ts-server-foundation/mysql-cleanups');
const processState = globalThis as typeof globalThis & { [cleanupKey]?: Set<MySQLCleanup> };
const cleanups = (processState[cleanupKey] ??= new Set<MySQLCleanup>());

export function registerMySQLCleanup(cleanup: MySQLCleanup): () => void {
    cleanups.add(cleanup);
    let unregisterAppCleanup: (() => void) | undefined;
    try {
        const app = getCurrentApp();
        unregisterAppCleanup = app.registerCleanup(cleanup);
    } catch {
        // Standalone drivers can be constructed without an application.
    }
    return () => {
        cleanups.delete(cleanup);
        unregisterAppCleanup?.();
    };
}

export async function closeMySQLPools(): Promise<void> {
    const results = await Promise.allSettled([...cleanups].map(cleanup => cleanup()));
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'MySQL pool cleanup failed');
}
