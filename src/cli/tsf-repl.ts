#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Recoverable, start as startRepl, type REPLServer } from 'node:repl';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';

import {
    DevConsoleClientMessage,
    DevConsoleServerMessage,
    type DevConsoleClientMessage as DCClientMsg,
    type DevConsoleServerMessage as DCServerMsg
} from '../devconsole/generated/devconsole';
import { SrpcClient } from '../srpc';
import { findProjectRoot, runNode } from './common';
import { type DevRunState, getDevStatePaths, pruneDevState } from './dev-state';

const REPL_CLIENT_SECRET = 'unused-local-devconsole-repl-secret';

export interface ReplCliOptions {
    mode: 'existing' | 'new';
    pid?: number;
    url?: string;
    evalCode?: string;
    script: string;
    debug: boolean;
    tsconfig?: string;
    timeoutMs: number;
    help: boolean;
}

export interface ReplTarget {
    url: string;
    run?: DevRunState;
}

export interface ReplCliIo {
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
    stdin: NodeJS.ReadStream;
}

export async function runReplCli(
    args = process.argv.slice(2),
    io: ReplCliIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }
): Promise<number> {
    const options = parseReplCliArgs(args);
    if (options.help) {
        io.stdout.write(replUsage());
        return 0;
    }

    if (options.mode === 'new') return runNewRepl(findProjectRoot(), options);

    const target = options.url
        ? { url: normalizeReplUrl(options.url) }
        : await resolveExistingReplTarget(findProjectRoot(), options.pid, options.timeoutMs);
    return runExistingRepl(target, options, io);
}

export function parseReplCliArgs(args: readonly string[]): ReplCliOptions {
    const options: ReplCliOptions = {
        mode: 'existing',
        script: '.',
        debug: false,
        timeoutMs: 10_000,
        help: false
    };
    let selectedNew = false;
    let selectedExisting = false;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }
        if (arg === '--new') {
            selectedNew = true;
            options.mode = 'new';
            continue;
        }
        if (arg === '--existing') {
            selectedExisting = true;
            continue;
        }
        if (arg === '--debug') {
            options.debug = true;
            continue;
        }

        const parsed = takeOptionValue(args, index, arg, ['--pid', '--url', '--eval', '-e', '--script', '--timeout', '-p', '--tsconfig']);
        if (parsed) {
            index += parsed.consumed;
            switch (parsed.name) {
                case '--pid': {
                    const pid = Number(parsed.value);
                    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid PID: ${parsed.value}`);
                    options.pid = pid;
                    break;
                }
                case '--url':
                    options.url = parsed.value;
                    break;
                case '--eval':
                case '-e':
                    options.evalCode = parsed.value;
                    break;
                case '--script':
                    options.script = parsed.value;
                    break;
                case '--timeout': {
                    const timeoutMs = Number(parsed.value);
                    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid timeout: ${parsed.value}`);
                    options.timeoutMs = timeoutMs;
                    break;
                }
                case '-p':
                case '--tsconfig':
                    options.tsconfig = parsed.value;
                    break;
            }
            continue;
        }

        throw new Error(`Unknown repl option: ${arg}`);
    }

    if (selectedNew && selectedExisting) throw new Error('--new and --existing are mutually exclusive');
    if (options.pid !== undefined && options.url !== undefined) throw new Error('--pid and --url are mutually exclusive');
    if (selectedNew && (options.pid !== undefined || options.url !== undefined)) {
        throw new Error('--new cannot be combined with --pid or --url');
    }
    if (options.mode === 'existing' && options.script !== '.') throw new Error('--script is only available with --new');
    if (options.mode === 'existing' && options.debug) throw new Error('--debug is only available with --new');
    if (options.mode === 'existing' && options.tsconfig) throw new Error('--tsconfig is only available with --new');
    return options;
}

export function normalizeReplUrl(input: string): string {
    const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
    let url: URL;
    try {
        url = new URL(withProtocol);
    } catch (error) {
        throw new Error(`Invalid REPL URL: ${input}`, { cause: error });
    }

    if (url.username || url.password) throw new Error('REPL URLs must not contain credentials');
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
        throw new Error('The DevConsole REPL is localhost-only; use localhost, 127.0.0.1, or ::1');
    }
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`Unsupported REPL URL protocol: ${url.protocol}`);

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/_devconsole') url.pathname = '/_devconsole/ws';
    else if (path === '/_devconsole/ws') url.pathname = path;
    else throw new Error(`REPL URL must target / or /_devconsole/ws, received: ${url.pathname}`);
    url.search = '';
    url.hash = '';
    return url.toString();
}

export async function resolveExistingReplTarget(projectDir: string, pid?: number, timeoutMs = 10_000): Promise<ReplTarget> {
    const { stateFile } = getDevStatePaths(projectDir);
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const state = pruneDevState(stateFile);
        const runs = Object.values(state?.runs ?? {}).sort((a, b) => a.startedAt - b.startedAt);
        const matches = pid === undefined ? runs : runs.filter(run => run.runnerPid === pid || run.appPid === pid);

        if (pid !== undefined && matches.length === 0) {
            throw new Error(`PID ${pid} is not registered by tsf-dev for this project. Use --url to connect directly.`);
        }
        if (matches.length === 0) {
            throw new Error('No running TSF process found for this project. Start the server or use: tsf repl --new');
        }
        if (matches.length > 1) throw new Error(formatAmbiguousRuns(matches));

        const [run] = matches;
        if (run.devConsoleUrl && run.appPid) return { url: normalizeReplUrl(run.devConsoleUrl), run };
        if (Date.now() >= deadline) {
            throw new Error(
                `The tsf-dev process (runner PID ${run.runnerPid}) did not publish a DevConsole endpoint. ` +
                    'Make sure the application is listening and DevConsole is enabled.'
            );
        }
        await sleep(50);
    }
}

function runNewRepl(projectDir: string, options: ReplCliOptions): number {
    const args = [join(__dirname, 'tsf-dev.js'), 'repl'];
    if (options.debug) args.push('--debug');
    if (options.tsconfig) args.push('--tsconfig', options.tsconfig);
    if (options.script !== '.') args.push('--script', options.script);
    if (options.evalCode !== undefined) args.push('--eval', options.evalCode);
    return runNode(args, projectDir).status;
}

async function runExistingRepl(target: ReplTarget, options: ReplCliOptions, io: ReplCliIo): Promise<number> {
    const client = createReplClient(target.url, options.evalCode === undefined);
    try {
        await client.connect();
        const processInfo = await client.invoke('uGetProcess', {});
        if (target.run?.appPid && processInfo.pid !== target.run.appPid) {
            throw new Error(`Discovered PID ${target.run.appPid}, but ${target.url} reported PID ${processInfo.pid}. Try the command again.`);
        }

        if (options.evalCode !== undefined) {
            const result = await client.invoke('uReplEval', { code: options.evalCode });
            writeLine(io.stdout, result.output);
            if (result.error) {
                writeLine(io.stderr, result.error);
                return 1;
            }
            return 0;
        }

        const overview = await client.invoke('uGetOverview', {});
        io.stdout.write(`Connected to ${overview.name || 'TSF app'} (${overview.env}), pid ${processInfo.pid}\n`);
        await openRemoteRepl(client, io);
        return 0;
    } finally {
        client.disconnect();
    }
}

function createReplClient(url: string, enableReconnect: boolean): SrpcClient<DCClientMsg, DCServerMsg> {
    const client = new SrpcClient<DCClientMsg, DCServerMsg>(
        { info() {}, warn() {}, error() {}, debug() {} },
        url,
        DevConsoleClientMessage,
        DevConsoleServerMessage,
        `tsf-repl-${process.pid}-${randomUUID()}`,
        undefined,
        REPL_CLIENT_SECRET,
        { enableReconnect }
    );
    client.registerMessageHandler('dEvent', () => ({}));
    return client;
}

async function openRemoteRepl(client: SrpcClient<DCClientMsg, DCServerMsg>, io: ReplCliIo): Promise<void> {
    let server: REPLServer | undefined;
    client.registerDisconnectHandler(() => {
        io.stderr.write('\nDisconnected from the application; reconnecting...\n');
    });
    client.registerConnectionHandler(() => {
        if (!server) return;
        void client
            .invoke('uGetProcess', {})
            .then(processInfo => {
                io.stderr.write(`\nReconnected to application pid ${processInfo.pid}.\n`);
                server?.displayPrompt(true);
            })
            .catch(() => {});
    });

    server = startRepl({
        prompt: 'tsf> ',
        input: io.stdin,
        output: io.stdout,
        terminal: !!io.stdin.isTTY && !!io.stdout.isTTY,
        useColors: !!io.stdout.isTTY,
        ignoreUndefined: true,
        eval: (code, _context, _filename, callback) => {
            void client
                .invoke('uReplEval', { code: code.trim() })
                .then(result => {
                    if (result.output && result.error) writeLine(io.stdout, result.output);
                    if (result.error) {
                        const error = remoteError(result.error);
                        // oxlint-disable-next-line promise/no-callback-in-promise -- node:repl requires its evaluation callback.
                        callback(isRecoverableError(result.error) ? new Recoverable(error) : error, undefined);
                        return;
                    }
                    // oxlint-disable-next-line promise/no-callback-in-promise -- node:repl requires its evaluation callback.
                    callback(null, result.output ? new RemoteReplOutput(result.output) : undefined);
                })
                // oxlint-disable-next-line promise/no-callback-in-promise -- node:repl requires its evaluation callback.
                .catch(error => callback(error as Error, undefined));
        },
        completer: (line, callback) => {
            void client
                .invoke('uReplComplete', { code: line, cursorPos: line.length })
                .then(result => {
                    const completeOn = line.slice(result.replaceStart, result.replaceEnd);
                    // oxlint-disable-next-line promise/no-callback-in-promise -- node:repl requires its completion callback.
                    callback(null, [result.items.map(item => item.label), completeOn]);
                })
                // oxlint-disable-next-line promise/no-callback-in-promise -- node:repl requires its completion callback.
                .catch(error => callback(error as Error));
        },
        writer: value => (value instanceof RemoteReplOutput ? value.output : inspect(value, { colors: !!io.stdout.isTTY }))
    });

    if (io.stdin.isTTY && process.env.NODE_REPL_HISTORY !== '') {
        const historyPath = process.env.NODE_REPL_HISTORY || join(homedir(), '.tsf_repl_history');
        server.setupHistory(historyPath, error => {
            if (error) io.stderr.write(`Could not load REPL history: ${error.message}\n`);
        });
    }

    await new Promise<void>(resolve => server?.once('exit', resolve));
}

class RemoteReplOutput {
    constructor(readonly output: string) {}
}

function remoteError(stack: string): Error {
    const error = new Error(stack.split('\n')[0]);
    error.stack = stack;
    return error;
}

function isRecoverableError(error: string): boolean {
    return /SyntaxError: Unexpected end of input/.test(error);
}

function writeLine(stream: NodeJS.WriteStream, value: string): void {
    if (!value) return;
    stream.write(value.endsWith('\n') ? value : `${value}\n`);
}

function formatAmbiguousRuns(runs: DevRunState[]): string {
    const lines = runs.map(run => {
        const appPid = run.appPid ? String(run.appPid) : 'starting';
        const command = [run.script, ...run.command].join(' ');
        return `  app PID ${appPid}, runner PID ${run.runnerPid}: ${command}${run.devConsoleUrl ? ` (${run.devConsoleUrl})` : ''}`;
    });
    return `Multiple running TSF processes were found. Select one with --pid:\n${lines.join('\n')}`;
}

function takeOptionValue(
    args: readonly string[],
    index: number,
    arg: string,
    names: readonly string[]
): { name: string; value: string; consumed: number } | undefined {
    for (const name of names) {
        if (arg === name) {
            const value = args[index + 1];
            if (value === undefined) throw new Error(`${name} requires a value`);
            return { name, value, consumed: 1 };
        }
        if (arg.startsWith(`${name}=`)) {
            return { name, value: arg.slice(name.length + 1), consumed: 0 };
        }
    }
    return undefined;
}

function replUsage(): string {
    return `Usage: tsf repl [options]

Connect to the existing tsf-dev application for the current project by default.

Options:
  --existing             Require an existing process (the default)
  --new                  Build and start a fresh application REPL process
  --pid <pid>            Select a registered app or tsf-dev runner PID
  --url <url>            Connect directly to a localhost DevConsole URL
  --eval <code>, -e      Evaluate JavaScript once and exit
  --script <path>        Application entrypoint for --new (default: .)
  -p, --tsconfig <file>  TypeScript config for --new
  --debug                Start the new process with --inspect-brk
  --timeout <ms>         Wait for endpoint publication (default: 10000)
  --help, -h             Show this help
`;
}

if (require.main === module) {
    runReplCli()
        .then(code => process.exit(code))
        .catch(error => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        });
}
