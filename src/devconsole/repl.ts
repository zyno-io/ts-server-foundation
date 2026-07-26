import { homedir } from 'node:os';
import { join } from 'node:path';
import { start as startRepl } from 'node:repl';
import { inspect } from 'node:util';

import type { App, BaseAppConfig } from '../app';
import { BaseDatabase } from '../database';
import { getProviderScope, type Token } from '../di';

export interface ReplEvaluation {
    output: string;
    error?: string;
}

interface ReplGlobalOwner {
    tokens: Record<string, unknown>;
    instances: Record<string, unknown>;
}

const replContextCleanups = new WeakMap<Record<string, unknown>, () => void>();
const replGlobalOwners: ReplGlobalOwner[] = [];
let originalDollarDescriptor: PropertyDescriptor | undefined;
let originalDoubleDollarDescriptor: PropertyDescriptor | undefined;

export function createReplContext<C extends BaseAppConfig>(app: App<C>): Record<string, unknown> {
    const resolve = <T>(token: Token<T>) => app.get(token);
    const db = tryGet(app, BaseDatabase);
    const { tokens, instances } = createProviderNamespaces(app, db);
    const context = {
        app,
        container: app.container,
        config: app.config,
        db,
        resolve,
        r: resolve,
        $: tokens,
        $$: instances,
        process,
        Buffer,
        inspect
    };
    replContextCleanups.set(context, installReplGlobals(tokens, instances));
    return context;
}

/** Releases the global namespace installation associated with a REPL context. */
export function disposeReplContext(context: Record<string, unknown>): void {
    const cleanup = replContextCleanups.get(context);
    if (!cleanup) return;
    replContextCleanups.delete(context);
    cleanup();
}

/**
 * Builds the DK-style provider namespaces without resolving providers. `$` exposes
 * their tokens while `$$` resolves on first property access from the provider's
 * owning module, preserving module-local dependency lookup.
 */
function createProviderNamespaces<C extends BaseAppConfig>(
    app: App<C>,
    db: BaseDatabase | undefined
): {
    tokens: Record<string, unknown>;
    instances: Record<string, unknown>;
} {
    const tokens = Object.create(null) as Record<string, unknown>;
    const instances = Object.create(null) as Record<string, unknown>;

    for (const registered of app.container.listRegisteredProviders()) {
        // Request-scoped providers need a request context and therefore cannot be
        // resolved safely in the REPL. This also excludes HTTP controllers.
        // Transient providers remain available: resolving them is valid outside a
        // request and intentionally creates a fresh value per property access.
        if (getProviderScope(registered.provider) === 'request') continue;
        const name = getReplTokenName(registered.token);
        if (!name || Object.hasOwn(tokens, name)) continue;

        // Keep the first registration, matching DK's provider-tree traversal. The
        // container order is deterministic, and using null-prototype objects makes
        // names such as `constructor` and `__proto__` safe REPL properties.
        Object.defineProperty(tokens, name, {
            enumerable: true,
            get: () => registered.token
        });
        Object.defineProperty(instances, name, {
            enumerable: true,
            get: () => app.container.resolve(registered.token, registered.moduleId)
        });
    }

    // Entities are classes rather than providers, so make them available only on
    // `$$`. Provider names retain precedence if a name collides.
    for (const entity of db?.entityRegistry ?? []) {
        if (!entity.name || Object.hasOwn(instances, entity.name)) continue;
        Object.defineProperty(instances, entity.name, {
            enumerable: true,
            get: () => entity
        });
    }

    return { tokens, instances };
}

function getReplTokenName(token: Token): string | undefined {
    if (typeof token === 'string') return token;
    if (typeof token === 'function') return token.name || undefined;
    if (typeof token === 'number' || typeof token === 'bigint' || typeof token === 'boolean') return String(token);
    if (typeof token === 'symbol') return token.description || token.toString();
    return undefined;
}

function installReplGlobals(tokens: Record<string, unknown>, instances: Record<string, unknown>): () => void {
    const globalContext = globalThis as typeof globalThis & Record<string, unknown>;
    if (replGlobalOwners.length === 0) {
        originalDollarDescriptor = Object.getOwnPropertyDescriptor(globalContext, '$');
        originalDoubleDollarDescriptor = Object.getOwnPropertyDescriptor(globalContext, '$$');
    }

    const owner = { tokens, instances };
    replGlobalOwners.push(owner);
    globalContext.$ = tokens;
    globalContext.$$ = instances;

    return () => {
        const index = replGlobalOwners.indexOf(owner);
        if (index < 0) return;
        const wasActive = index === replGlobalOwners.length - 1;
        replGlobalOwners.splice(index, 1);
        if (!wasActive) return;

        const previousOwner = replGlobalOwners.at(-1);
        restoreReplGlobal(globalContext, '$', owner.tokens, previousOwner?.tokens, originalDollarDescriptor);
        restoreReplGlobal(globalContext, '$$', owner.instances, previousOwner?.instances, originalDoubleDollarDescriptor);
        if (replGlobalOwners.length === 0) {
            originalDollarDescriptor = undefined;
            originalDoubleDollarDescriptor = undefined;
        }
    };
}

function restoreReplGlobal(
    globalContext: typeof globalThis & Record<string, unknown>,
    name: '$' | '$$',
    ownedValue: Record<string, unknown>,
    previousValue: Record<string, unknown> | undefined,
    originalDescriptor: PropertyDescriptor | undefined
): void {
    // Do not overwrite a global changed by application code after this REPL
    // context was installed.
    if (globalContext[name] !== ownedValue) return;
    if (previousValue) {
        globalContext[name] = previousValue;
        return;
    }
    if (originalDescriptor) Object.defineProperty(globalContext, name, originalDescriptor);
    else delete globalContext[name];
}

export async function evaluateReplCode(context: Record<string, unknown>, code: string, colors = false): Promise<ReplEvaluation> {
    const logs: string[] = [];
    const capture = (...args: unknown[]) =>
        logs.push(args.map(item => (typeof item === 'string' ? item : inspect(item, { depth: 4, colors }))).join(' '));
    const localConsole = {
        log: capture,
        warn: capture,
        error: capture,
        info: capture,
        debug: capture
    };

    try {
        const fn = new Function('context', 'console', `with (context) { return eval(${JSON.stringify(code)}) }`);
        let result = fn(context, localConsole);
        if (result && typeof result === 'object' && typeof result.then === 'function') result = await result;
        const resultText = result === undefined ? '' : inspect(result, { depth: 4, colors });
        return { output: [...logs, resultText].filter(Boolean).join('\n') };
    } catch (error) {
        return {
            output: logs.join('\n'),
            error: error instanceof Error ? (error.stack ?? error.message) : String(error)
        };
    }
}

export async function runLocalAppRepl<C extends BaseAppConfig>(app: App<C>, args: string[]): Promise<void> {
    if (takeHelpArgument(args)) {
        process.stdout.write(localReplUsage());
        return;
    }
    const evalCode = takeEvalArgument(args);
    if (args.length) throw new Error(`repl does not accept arguments: ${args.join(' ')}`);

    // A local REPL needs the application container, but it is not a running server.
    // Its dedicated mode suppresses operational services without changing normal DI startup.
    app.configureForRepl();

    try {
        await app.start();
        if (evalCode !== undefined) {
            const context = createReplContext(app);
            try {
                const result = await evaluateReplCode(context, evalCode, !!process.stdout.isTTY);
                if (result.output) process.stdout.write(`${result.output}\n`);
                if (result.error) {
                    const error = new Error(result.error);
                    error.stack = result.error;
                    throw error;
                }
            } finally {
                disposeReplContext(context);
            }
            return;
        }

        await openLocalRepl(app);
    } finally {
        await app.stop();
    }
}

function openLocalRepl<C extends BaseAppConfig>(app: App<C>): Promise<void> {
    const server = startRepl({
        prompt: 'tsf> ',
        useColors: !!process.stdout.isTTY,
        ignoreUndefined: true
    });
    const context = createReplContext(app);
    Object.assign(server.context, context);

    if (process.stdin.isTTY && process.env.NODE_REPL_HISTORY !== '') {
        const historyPath = process.env.NODE_REPL_HISTORY || join(homedir(), '.tsf_repl_history');
        server.setupHistory(historyPath, error => {
            if (error) process.stderr.write(`Could not load REPL history: ${error.message}\n`);
        });
    }

    return new Promise(resolve =>
        server.once('exit', () => {
            disposeReplContext(context);
            resolve();
        })
    );
}

function takeEvalArgument(args: string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--eval' || arg === '-e') {
            const value = args[index + 1];
            if (value === undefined) throw new Error(`${arg} requires JavaScript source`);
            args.splice(index, 2);
            return value;
        }
        if (arg.startsWith('--eval=')) {
            args.splice(index, 1);
            return arg.slice('--eval='.length);
        }
    }
    return undefined;
}

function takeHelpArgument(args: string[]): boolean {
    return args.some(arg => arg === '--help' || arg === '-h');
}

export function localReplUsage(): string {
    return `Usage: node <entrypoint> repl [options]\n\nStart a local application REPL without starting HTTP listeners or workers.\n\nOptions:\n  --eval <code>, -e <code>  Evaluate JavaScript once and exit\n  --help, -h                Show this help\n`;
}

export function tryGet<C extends BaseAppConfig, T>(app: App<C>, token: Token<T>): T | undefined {
    try {
        return app.get(token);
    } catch {
        return undefined;
    }
}
