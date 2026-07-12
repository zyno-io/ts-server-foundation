#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Env } from '../env';
import { cleanDist, extractTsconfigArg, findProjectRoot, resolveFromProject, runNode } from './common';
import { install } from './tsf-install';

Env.APP_ENV ||= 'development';

const projectDir = findProjectRoot();
const projectHash = createHash('md5').update(projectDir).digest('hex').slice(0, 12);
const devLockFile = join(tmpdir(), `tsf-dev-${projectHash}.lock`);
const devStateFile = join(tmpdir(), `tsf-dev-${projectHash}.json`);

interface DevState {
    ready: boolean;
    pids: number[];
}

interface BuildState {
    version: 2;
    tsconfig: string;
    fingerprint: string;
    inputCount: number;
    outputFingerprint: string;
    outputCount: number;
    builtAt: string;
}

interface BuildFingerprint {
    fingerprint: string;
    fileCount: number;
}

interface TsconfigWatchConfig {
    files?: string[];
    include?: string[];
    exclude?: string[];
    compilerOptions?: {
        outDir?: string;
    };
}

interface DevBuildHandle {
    kill(signal?: NodeJS.Signals | number): void;
    closed?: Promise<number>;
}

interface CompilerWatchHandle extends DevBuildHandle {
    ready: Promise<void>;
    closed: Promise<number>;
}

async function main(args = process.argv.slice(2)): Promise<number> {
    const [cmd, ...rest] = args;
    switch (cmd) {
        case 'clean':
            cleanDist(projectDir);
            return 0;
        case 'build':
            return await cmdBuild(rest);
        case 'run':
            return cmdRun(rest);
        case 'test':
            return cmdTest(rest);
        case 'migrate':
            return cmdMigrate('run', rest);
        case 'migrate:create':
            return cmdMigrate('create', rest);
        case 'migrate:reset':
            return cmdMigrate('reset', rest);
        case 'migrate:charset':
            return cmdMigrate('charset', rest);
        case 'openapi:generate':
            return cmdOpenApiGenerate(rest);
        default:
            printUsage();
            return 1;
    }
}

function printUsage(): void {
    console.error(`Usage: tsf-dev <command> [options]

Commands:
  clean                         Remove dist/
  build [--watch] [-p file]     Clean and compile TypeScript
  run [--debug] [script] -- server:start
                                Ensure a watch build and run node --watch
  test [--debug] [-p file]      Build tests and run tsf-test
  migrate [-p file]             Build and run compiled migrations
  migrate:create [-p file]      Build and create a raw SQL migration
  migrate:reset [-p file]       Build and create a base migration
  migrate:charset [-p file]     Build and standardize MySQL charset/collation
  openapi:generate [-p file]    Build and write openapi.yaml

Common options:
  -p, --tsconfig <file>         TypeScript config file`);
}

async function cmdBuild(args: string[]): Promise<number> {
    const watch = takeFlag(args, '--watch');
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.json';
    const installStatus = ensureProjectInstalled();
    if (installStatus !== 0) return installStatus;
    const status = getBuildStatus(tsconfig);
    if (watch) {
        if (!isDevRunning() && !status.fresh) cleanDist(projectDir);
        const compiler = startTscWatch(tsconfig);
        const stop = () => compiler.kill('SIGTERM');
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        return await compiler.closed;
    }
    return runTscIfNeeded(tsconfig, status);
}

async function cmdRun(args: string[]): Promise<number> {
    const separator = args.indexOf('--');
    const ownArgs = separator >= 0 ? args.slice(0, separator) : args;
    const childArgs = separator >= 0 ? args.slice(separator + 1) : [];
    const debug = takeFlag(ownArgs, '--debug');
    const tsconfig = extractTsconfigArg(ownArgs) ?? 'tsconfig.json';
    const script = ownArgs.find(arg => !arg.startsWith('-')) ?? '.';
    const installStatus = ensureProjectInstalled();
    if (installStatus !== 0) return installStatus;
    const tscChild = await ensureDevBuild(tsconfig);
    registerDevPid();
    process.on('exit', unregisterDevPid);

    const inspectFlag = debug ? '--inspect-brk' : '--inspect';
    const inspectArg = Env.PORT ? `${inspectFlag}=${Number(Env.PORT) + 1000}` : inspectFlag;
    const child = spawn(process.execPath, ['--enable-source-maps', '--watch', '--watch-preserve-output', inspectArg, script, ...childArgs], {
        cwd: projectDir,
        stdio: 'inherit'
    });

    return await new Promise(resolve => {
        child.on('close', code => {
            tscChild?.kill();
            resolve(code ?? 0);
        });
        process.on('SIGTERM', () => {
            child.kill('SIGTERM');
            tscChild?.kill('SIGTERM');
        });
    });
}

function cmdTest(args: string[]): number {
    const debug = takeFlag(args, '--debug');
    const tsconfig = extractTsconfigArg(args) ?? (existsSync(join(projectDir, 'tsconfig.test.json')) ? 'tsconfig.test.json' : 'tsconfig.json');
    const tscStatus = runTscIfNeeded(tsconfig);
    if (tscStatus !== 0) return tscStatus;
    const testCli = join(__dirname, 'tsf-test.js');
    const testArgs = debug ? ['--inspect-brk=9268', ...args] : args;
    const testRunTs = Env.TEST_RUN_TS ?? String(Math.floor(Date.now() / 1000));
    return runNode([testCli, ...testArgs], projectDir, {
        APP_ENV: 'test',
        TZ: 'UTC',
        TEST_RUN_TS: testRunTs,
        TSF_TSCONFIG: tsconfig
    }).status;
}

function cmdMigrate(command: 'run' | 'create' | 'reset' | 'charset', args: string[]): number {
    const debug = takeFlag(args, '--debug');
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.json';
    const installStatus = ensureProjectInstalled();
    if (installStatus !== 0) return installStatus;
    const tscStatus = runTscIfNeeded(tsconfig);
    if (tscStatus !== 0) return tscStatus;
    if (command === 'run') {
        return runNode([...(debug ? ['--inspect-brk=9226'] : []), '--enable-source-maps', '.', 'migrate:run', ...args], projectDir, {
            TSF_TSCONFIG: tsconfig
        }).status;
    }
    return runNode([...(debug ? ['--inspect-brk=9226'] : []), join(__dirname, 'tsf-migrate.js'), command, ...args], projectDir, {
        TSF_TSCONFIG: tsconfig
    }).status;
}

function cmdOpenApiGenerate(args: string[]): number {
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.json';
    const installStatus = ensureProjectInstalled();
    if (installStatus !== 0) return installStatus;
    const tscStatus = runTscIfNeeded(tsconfig);
    if (tscStatus !== 0) return tscStatus;
    return runNode(['--enable-source-maps', '.', 'openapi:generate', ...args], projectDir, {
        APP_ENV: Env.APP_ENV ?? 'development'
    }).status;
}

function ensureProjectInstalled(): number {
    return install({ projectDir });
}

function runTsc(tsconfig: string): number {
    return runNode([getTscPath(), '-p', tsconfig], projectDir).status;
}

function runTscIfNeeded(tsconfig: string, existingStatus = getBuildStatus(tsconfig)): number {
    if (existingStatus.fresh) {
        console.log(`tsf-dev: build is up to date for ${tsconfig}`);
        return 0;
    }

    if (!isDevRunning()) cleanDist(projectDir);
    const status = runTsc(tsconfig);
    if (status === 0) writeBuildState(tsconfig);
    return status;
}

function takeFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) return false;
    args.splice(index, 1);
    return true;
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readDevState(): DevState | undefined {
    try {
        return JSON.parse(readFileSync(devStateFile, 'utf8')) as DevState;
    } catch {
        return undefined;
    }
}

function writeDevState(state: DevState): void {
    mkdirSync(dirname(devStateFile), { recursive: true });
    writeFileSync(devStateFile, JSON.stringify(state));
}

function isDevRunning(): boolean {
    const state = readDevState();
    return !!state?.ready && state.pids.some(isPidAlive);
}

function registerDevPid(): void {
    const state = readDevState() ?? { ready: true, pids: [] };
    state.pids = state.pids.filter(isPidAlive);
    if (!state.pids.includes(process.pid)) state.pids.push(process.pid);
    writeDevState(state);
}

function unregisterDevPid(): void {
    const state = readDevState();
    if (!state) return;
    state.pids = state.pids.filter(pid => pid !== process.pid && isPidAlive(pid));
    if (state.pids.length === 0) {
        try {
            unlinkSync(devStateFile);
        } catch {
            // ignore
        }
    } else {
        writeDevState(state);
    }
}

function tryAcquireBuildLock(): boolean {
    try {
        writeFileSync(devLockFile, String(process.pid), { flag: 'wx' });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
            const pid = Number(readFileSync(devLockFile, 'utf8'));
            if (!isPidAlive(pid)) {
                unlinkSync(devLockFile);
                return tryAcquireBuildLock();
            }
        } catch {
            return tryAcquireBuildLock();
        }
        return false;
    }
}

function releaseBuildLock(): void {
    try {
        unlinkSync(devLockFile);
    } catch {
        // ignore
    }
}

async function ensureDevBuild(tsconfig: string): Promise<DevBuildHandle | undefined> {
    if (isDevRunning()) return undefined;
    if (!tryAcquireBuildLock()) {
        while (true) {
            if (readDevState()?.ready) return undefined;
            await sleep(200);
            try {
                const pid = Number(readFileSync(devLockFile, 'utf8'));
                if (!isPidAlive(pid) && tryAcquireBuildLock()) break;
            } catch {
                if (tryAcquireBuildLock()) break;
            }
        }
    }

    const status = getBuildStatus(tsconfig);
    if (status.fresh) {
        writeDevState({ ready: true, pids: [] });
        releaseBuildLock();
        return watchBuildInputsUntilChanged(tsconfig, collectCompilerWatchInputs(tsconfig));
    }

    cleanDist(projectDir);
    writeDevState({ ready: false, pids: [] });
    const compiler = startTscWatch(tsconfig);
    try {
        await compiler.ready;
    } catch (error) {
        releaseBuildLock();
        throw error;
    }
    writeDevState({ ready: true, pids: [] });
    releaseBuildLock();
    return compiler;
}

function startTscWatch(tsconfig: string): CompilerWatchHandle {
    let stopped = false;
    let running = false;
    let rerun = false;
    let watcher: FSWatcher | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let debounceTimer: NodeJS.Timeout | undefined;
    let baseline = collectCompilerWatchInputs(tsconfig);
    let resolveReady!: () => void;
    let resolveClosed!: (code: number) => void;
    let readyResolved = false;

    const ready = new Promise<void>(resolve => {
        resolveReady = resolve;
    });
    const closed = new Promise<number>(resolve => {
        resolveClosed = resolve;
    });

    const markReady = () => {
        if (readyResolved) return;
        readyResolved = true;
        resolveReady();
    };
    const close = (code = 0) => {
        stopped = true;
        watcher?.close();
        if (pollTimer) clearInterval(pollTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        resolveClosed(code);
    };
    const rebuild = () => {
        if (stopped || running) {
            rerun = true;
            return;
        }
        running = true;
        baseline = collectCompilerWatchInputs(tsconfig);
        process.stdout.write(`[ttsc] rebuilding at ${new Date().toLocaleTimeString()}\n`);
        const status = runTsc(tsconfig);
        if (status === 0) {
            writeBuildState(tsconfig);
            process.stdout.write('[ttsc] watch build complete\n');
            markReady();
        } else {
            process.stdout.write('[ttsc] watch build failed\n');
        }
        running = false;
        if (rerun) {
            rerun = false;
            scheduleCheck();
        }
    };
    const checkForChanges = () => {
        if (stopped) return;
        const current = collectCompilerWatchInputs(tsconfig);
        if (current.fingerprint === baseline.fingerprint && current.fileCount === baseline.fileCount) return;
        baseline = current;
        rebuild();
    };
    const scheduleCheck = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkForChanges, 100);
    };

    process.stdout.write(`[ttsc] watching ${relative(projectDir, dirname(resolve(projectDir, tsconfig))) || '.'}\n`);
    try {
        watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
            if (isPotentialCompilerWatchInputPath(filename)) scheduleCheck();
        });
    } catch {
        pollTimer = setInterval(checkForChanges, 1000);
    }
    rebuild();

    return {
        ready,
        closed,
        kill(signal?: NodeJS.Signals | number) {
            close(typeof signal === 'number' ? signal : 0);
        }
    };
}

function watchBuildInputsUntilChanged(tsconfig: string, baseline: BuildFingerprint): DevBuildHandle {
    let stopped = false;
    let compiler: DevBuildHandle | undefined;
    let watcher: FSWatcher | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let debounceTimer: NodeJS.Timeout | undefined;

    const startCompiler = () => {
        if (stopped || compiler) return;
        watcher?.close();
        watcher = undefined;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        compiler = startTscWatch(tsconfig);
    };
    const checkForChanges = () => {
        if (stopped || compiler) return;
        const current = collectCompilerWatchInputs(tsconfig);
        if (current.fingerprint !== baseline.fingerprint || current.fileCount !== baseline.fileCount) startCompiler();
    };
    const scheduleCheck = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkForChanges, 100);
    };

    try {
        watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
            if (isPotentialCompilerWatchInputPath(filename)) scheduleCheck();
        });
    } catch {
        pollTimer = setInterval(checkForChanges, 1000);
    }

    return {
        kill(signal?: NodeJS.Signals | number) {
            stopped = true;
            watcher?.close();
            if (pollTimer) clearInterval(pollTimer);
            if (debounceTimer) clearTimeout(debounceTimer);
            compiler?.kill(signal);
        }
    };
}

function getBuildStatus(tsconfig: string): {
    fresh: boolean;
    inputs: BuildFingerprint;
    outputs: BuildFingerprint;
} {
    const inputs = collectBuildInputs(tsconfig);
    const outputs = collectBuildOutputs();
    const state = readBuildState(tsconfig);
    return {
        fresh:
            !!state &&
            state.version === 2 &&
            state.fingerprint === inputs.fingerprint &&
            state.inputCount === inputs.fileCount &&
            state.outputFingerprint === outputs.fingerprint &&
            state.outputCount === outputs.fileCount,
        inputs,
        outputs
    };
}

function readBuildState(tsconfig: string): BuildState | undefined {
    try {
        return JSON.parse(readFileSync(getBuildStateFile(tsconfig), 'utf8')) as BuildState;
    } catch {
        return undefined;
    }
}

function writeBuildState(tsconfig: string): void {
    const inputs = collectBuildInputs(tsconfig);
    const outputs = collectBuildOutputs();
    const state: BuildState = {
        version: 2,
        tsconfig: normalizeBuildPath(tsconfig),
        fingerprint: inputs.fingerprint,
        inputCount: inputs.fileCount,
        outputFingerprint: outputs.fingerprint,
        outputCount: outputs.fileCount,
        builtAt: new Date().toISOString()
    };
    mkdirSync(join(projectDir, 'dist'), { recursive: true });
    writeFileSync(getBuildStateFile(tsconfig), JSON.stringify(state, null, 2));
}

function getBuildStateFile(tsconfig: string): string {
    const hash = createHash('md5').update(normalizeBuildPath(tsconfig)).digest('hex').slice(0, 12);
    return join(projectDir, 'dist', `.tsf-dev-build-${hash}.json`);
}

function collectBuildInputs(tsconfig: string): BuildFingerprint {
    const files = new Set<string>();
    collectBuildInputFiles(projectDir, files);
    const tsconfigPath = resolve(projectDir, tsconfig);
    if (existsSync(tsconfigPath)) files.add(tsconfigPath);

    return fingerprintFiles(files);
}

function collectCompilerWatchInputs(tsconfig: string): BuildFingerprint {
    const files = new Set<string>();
    const tsconfigDir = dirname(resolve(projectDir, tsconfig));
    const config = readTsconfig(tsconfig);
    const rawIncludes = config.files ?? config.include;
    const includes = normalizeTsconfigPatterns(rawIncludes ?? ['**/*']);
    const excludes = normalizeTsconfigPatterns([
        ...(typeof config.compilerOptions?.outDir === 'string' ? [config.compilerOptions.outDir] : []),
        ...(config.exclude ?? [])
    ]);

    for (const file of rawIncludes === undefined ? collectAllCompilerWatchFiles(tsconfigDir) : collectTsconfigPatternFiles(tsconfigDir, includes)) {
        const relativePath = relative(tsconfigDir, file).replace(/\\/g, '/');
        if (isIgnoredCompilerWatchPath(relativePath) || matchesTsconfigPattern(relativePath, excludes)) continue;
        if (isCompilerWatchInputFile(relativePath)) files.add(file);
    }

    return fingerprintFiles(files);
}

function readTsconfig(tsconfig: string): TsconfigWatchConfig {
    try {
        return JSON.parse(stripJsonComments(readFileSync(resolve(projectDir, tsconfig), 'utf8'))) as TsconfigWatchConfig;
    } catch {
        return {};
    }
}

function collectAllCompilerWatchFiles(dir: string): Set<string> {
    const files = new Set<string>();
    collectCompilerWatchFiles(dir, dir, files);
    return files;
}

function collectCompilerWatchFiles(rootDir: string, dir: string, files: Set<string>): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const relativePath = relative(rootDir, path).replace(/\\/g, '/');
        if (isIgnoredCompilerWatchPath(relativePath)) continue;
        if (entry.isDirectory()) {
            collectCompilerWatchFiles(rootDir, path, files);
            continue;
        }
        if (entry.isFile() && isCompilerWatchInputFile(entry.name)) files.add(path);
    }
}

function collectTsconfigPatternFiles(baseDir: string, patterns: string[]): Set<string> {
    const files = new Set<string>();
    for (const pattern of patterns) {
        for (const entry of globSync(pattern, { cwd: baseDir })) {
            const path = resolve(baseDir, entry);
            if (isFile(path)) files.add(path);
        }
    }
    return files;
}

function normalizeTsconfigPatterns(patterns: string[]): string[] {
    return patterns
        .filter(pattern => typeof pattern === 'string' && pattern.trim() !== '')
        .map(pattern => {
            const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
            if (hasGlobMagic(normalized) || isCompilerWatchInputFile(normalized)) return normalized;
            return `${normalized}/**/*`;
        });
}

function matchesTsconfigPattern(path: string, patterns: string[]): boolean {
    return patterns.some(pattern => globToRegExp(pattern).test(path));
}

function globToRegExp(pattern: string): RegExp {
    let regex = '^';
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index]!;
        const next = pattern[index + 1];
        if (char === '*') {
            if (next === '*') {
                const after = pattern[index + 2];
                if (after === '/') {
                    regex += '(?:.*/)?';
                    index += 2;
                } else {
                    regex += '.*';
                    index += 1;
                }
            } else {
                regex += '[^/]*';
            }
        } else if (char === '?') {
            regex += '[^/]';
        } else {
            regex += escapeRegExp(char);
        }
    }
    return new RegExp(`${regex}$`);
}

function hasGlobMagic(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function stripJsonComments(text: string): string {
    let output = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        const next = text[index + 1];
        if (lineComment) {
            if (char === '\n' || char === '\r') {
                lineComment = false;
                output += char;
            }
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index++;
            continue;
        }
        output += char;
    }

    return output.replace(/,\s*([}\]])/g, '$1');
}

function collectBuildOutputs(): BuildFingerprint {
    const files = new Set<string>();
    collectBuildOutputFiles(join(projectDir, 'dist'), files);
    return fingerprintFiles(files);
}

function fingerprintFiles(files: Set<string>): BuildFingerprint {
    const hash = createHash('sha256');
    const sorted = [...files].sort();
    for (const file of sorted) {
        hash.update(normalizeBuildPath(file));
        hash.update('\0');
        hash.update(readFileSync(file));
        hash.update('\n');
    }

    return {
        fingerprint: hash.digest('hex'),
        fileCount: sorted.length
    };
}

function collectBuildInputFiles(dir: string, files: Set<string>): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === '.yarn') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectBuildInputFiles(path, files);
            continue;
        }
        if (!entry.isFile()) continue;
        if (isBuildInputFile(entry.name)) files.add(path);
    }
}

function collectBuildOutputFiles(dir: string, files: Set<string>): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectBuildOutputFiles(path, files);
            continue;
        }
        if (!entry.isFile() || isBuildStateFile(entry.name)) continue;
        files.add(path);
    }
}

function isBuildInputFile(name: string): boolean {
    return (
        name.endsWith('.ts') ||
        name.endsWith('.tsx') ||
        name.endsWith('.mts') ||
        name.endsWith('.cts') ||
        name.endsWith('.js') ||
        name.endsWith('.jsx') ||
        name.endsWith('.mjs') ||
        name.endsWith('.cjs') ||
        name.endsWith('.json') ||
        name === 'yarn.lock'
    );
}

function isPotentialCompilerWatchInputPath(filename: string | Buffer | null): boolean {
    if (!filename) return true;
    const normalized = filename.toString().replace(/\\/g, '/');
    if (isIgnoredCompilerWatchPath(normalized)) return false;
    const segments = normalized.split('/');
    return isCompilerWatchInputFile(segments.at(-1) ?? normalized);
}

function isCompilerWatchInputFile(name: string): boolean {
    return (
        name.endsWith('.ts') ||
        name.endsWith('.tsx') ||
        name.endsWith('.mts') ||
        name.endsWith('.cts') ||
        name.endsWith('.js') ||
        name.endsWith('.jsx') ||
        name.endsWith('.mjs') ||
        name.endsWith('.cjs')
    );
}

function isIgnoredCompilerWatchPath(path: string): boolean {
    const segments = path.split('/');
    return segments.includes('node_modules') || segments.includes('dist') || segments.includes('.git') || segments.includes('.yarn');
}

function isBuildStateFile(name: string): boolean {
    return /^\.tsf-dev-build-[a-f0-9]+\.json$/.test(name);
}

function normalizeBuildPath(path: string): string {
    const absolute = resolve(projectDir, path);
    return relative(projectDir, absolute).replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function getTscPath(): string {
    return join(dirname(resolveFromProject(projectDir, 'ttsc/package.json')), 'lib/launcher/ttsc.js');
}

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}
