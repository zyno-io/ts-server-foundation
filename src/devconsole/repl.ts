import { homedir } from 'node:os';
import { join } from 'node:path';
import { start as startRepl } from 'node:repl';
import { inspect } from 'node:util';

import type { App, BaseAppConfig } from '../app';
import { BaseDatabase } from '../database';
import type { Token } from '../di';

export interface ReplEvaluation {
    output: string;
    error?: string;
}

export function createReplContext<C extends BaseAppConfig>(app: App<C>): Record<string, unknown> {
    const resolve = <T>(token: Token<T>) => app.get(token);
    return {
        app,
        container: app.container,
        config: app.config,
        db: tryGet(app, BaseDatabase),
        resolve,
        r: resolve,
        $: resolve,
        process,
        Buffer,
        inspect
    };
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
    const evalCode = takeEvalArgument(args);
    if (args.length) throw new Error(`repl does not accept arguments: ${args.join(' ')}`);

    try {
        await app.start();
        if (evalCode !== undefined) {
            const result = await evaluateReplCode(createReplContext(app), evalCode, !!process.stdout.isTTY);
            if (result.output) process.stdout.write(`${result.output}\n`);
            if (result.error) {
                const error = new Error(result.error);
                error.stack = result.error;
                throw error;
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
    Object.assign(server.context, createReplContext(app));

    if (process.stdin.isTTY && process.env.NODE_REPL_HISTORY !== '') {
        const historyPath = process.env.NODE_REPL_HISTORY || join(homedir(), '.tsf_repl_history');
        server.setupHistory(historyPath, error => {
            if (error) process.stderr.write(`Could not load REPL history: ${error.message}\n`);
        });
    }

    return new Promise(resolve => server.once('exit', resolve));
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

function tryGet<C extends BaseAppConfig, T>(app: App<C>, token: Token<T>): T | undefined {
    try {
        return app.get(token);
    } catch {
        return undefined;
    }
}
