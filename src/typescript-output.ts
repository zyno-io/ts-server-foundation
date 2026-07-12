import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface TsconfigJson {
    extends?: string | string[];
    compilerOptions?: {
        outDir?: string;
        rootDir?: string;
    };
}

export interface TypeScriptOutputConfig {
    configPath: string;
    outDir?: string;
    rootDir?: string;
}

export interface TypeScriptOutputOptions {
    cwd?: string;
    tsconfigPath?: string;
}

export function readTypeScriptOutputConfig(options: TypeScriptOutputOptions = {}): TypeScriptOutputConfig | undefined {
    const cwd = resolve(options.cwd ?? process.cwd());
    const configuredPath = options.tsconfigPath ?? process.env.TSF_TSCONFIG;
    const configPath = configuredPath ? resolve(cwd, configuredPath) : findTsconfig(cwd);
    if (!configPath) return undefined;
    return readEffectiveTypeScriptOutputConfig(configPath, new Set());
}

export function resolveTypeScriptOutputPath(sourcePath: string, options: TypeScriptOutputOptions = {}): string | undefined {
    const cwd = resolve(options.cwd ?? process.cwd());
    const absoluteSource = resolve(cwd, sourcePath);
    const configuredPath = options.tsconfigPath ?? process.env.TSF_TSCONFIG;
    const config = configuredPath
        ? readTypeScriptOutputConfig({ cwd, tsconfigPath: configuredPath })
        : readTypeScriptOutputConfig({ cwd: absoluteSource });
    if (!config?.outDir || !config.rootDir) return undefined;

    const relativeSource = relative(config.rootDir, absoluteSource);
    if (isOutsideDirectory(relativeSource)) return undefined;
    return replaceTypeScriptExtension(resolve(config.outDir, relativeSource));
}

export function resolveTypeScriptOutDir(options: TypeScriptOutputOptions = {}): string | undefined {
    return readTypeScriptOutputConfig(options)?.outDir;
}

function readEffectiveTypeScriptOutputConfig(configPath: string, seen: Set<string>): TypeScriptOutputConfig | undefined {
    const absoluteConfigPath = resolve(configPath);
    if (seen.has(absoluteConfigPath) || !existsSync(absoluteConfigPath)) return undefined;
    seen.add(absoluteConfigPath);

    let config: TsconfigJson;
    try {
        config = parseJsonC(readFileSync(absoluteConfigPath, 'utf8')) as TsconfigJson;
    } catch {
        return undefined;
    }

    let inherited: TypeScriptOutputConfig | undefined;
    for (const extended of normalizeExtends(config.extends)) {
        const extendedPath = resolveTsconfigExtends(absoluteConfigPath, extended);
        if (!extendedPath) continue;
        const resolved = readEffectiveTypeScriptOutputConfig(extendedPath, new Set(seen));
        if (resolved) {
            inherited = {
                configPath: absoluteConfigPath,
                rootDir: resolved.rootDir ?? inherited?.rootDir,
                outDir: resolved.outDir ?? inherited?.outDir
            };
        }
    }

    const configDir = dirname(absoluteConfigPath);
    return {
        configPath: absoluteConfigPath,
        rootDir: typeof config.compilerOptions?.rootDir === 'string' ? resolve(configDir, config.compilerOptions.rootDir) : inherited?.rootDir,
        outDir: typeof config.compilerOptions?.outDir === 'string' ? resolve(configDir, config.compilerOptions.outDir) : inherited?.outDir
    };
}

function findTsconfig(start: string): string | undefined {
    let directory = start;
    try {
        if (!statSync(directory).isDirectory()) directory = dirname(directory);
    } catch {
        directory = extname(directory) ? dirname(directory) : directory;
    }

    while (true) {
        const candidate = join(directory, 'tsconfig.json');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}

function normalizeExtends(value: TsconfigJson['extends']): string[] {
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function resolveTsconfigExtends(configPath: string, specifier: string): string | undefined {
    if (isAbsolute(specifier) || specifier.startsWith('.')) {
        return firstExistingConfigPath(resolve(dirname(configPath), specifier));
    }

    const requireFromConfig = createRequire(configPath);
    try {
        return requireFromConfig.resolve(specifier);
    } catch {
        try {
            return requireFromConfig.resolve(`${specifier}/tsconfig.json`);
        } catch {
            return undefined;
        }
    }
}

function firstExistingConfigPath(path: string): string | undefined {
    for (const candidate of [path, `${path}.json`, join(path, 'tsconfig.json')]) {
        if (existsSync(candidate)) return candidate;
    }
}

function isOutsideDirectory(path: string): boolean {
    return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function replaceTypeScriptExtension(path: string): string {
    return path.replace(/(?:\.d)?\.(?:cts|mts|tsx?)$/i, match => {
        const normalized = match.toLowerCase();
        if (normalized === '.mts') return '.mjs';
        if (normalized === '.cts') return '.cjs';
        return '.js';
    });
}

function parseJsonC(contents: string): unknown {
    let output = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < contents.length; index++) {
        const char = contents[index]!;
        const next = contents[index + 1];
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
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
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

    return JSON.parse(stripTrailingJsonCommas(output));
}

function stripTrailingJsonCommas(contents: string): string {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let index = 0; index < contents.length; index++) {
        const char = contents[index]!;
        if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === ',') {
            let nextIndex = index + 1;
            while (/\s/.test(contents[nextIndex] ?? '')) nextIndex++;
            if (contents[nextIndex] === '}' || contents[nextIndex] === ']') continue;
        }
        output += char;
    }

    return output;
}
