import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Env, type EnvObject, toProcessEnv } from '../env';

export interface SpawnResult {
    status: number;
}

export function findPackageRoot(start = __dirname): string {
    let dir = start;
    while (true) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) throw new Error('Could not find package root');
        dir = parent;
    }
}

export function findProjectRoot(start = process.cwd()): string {
    let dir = start;
    while (true) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) throw new Error('Could not find package.json in any parent directory');
        dir = parent;
    }
}

export function readPackageDependencyVersion(packageRoot: string, name: string): string {
    const packageJsonPath = join(packageRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
    };
    const version = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name];
    if (!version) throw new Error(`${name} is not declared in ${packageJsonPath}`);
    return version;
}

export function extractTsconfigArg(args: string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-p' || arg === '--tsconfig') {
            const value = args[index + 1];
            args.splice(index, 2);
            return value;
        }
        if (arg.startsWith('-p=')) {
            args.splice(index, 1);
            return arg.slice(3);
        }
        if (arg.startsWith('--tsconfig=')) {
            args.splice(index, 1);
            return arg.slice('--tsconfig='.length);
        }
    }
}

export function cleanDist(projectDir = findProjectRoot()): void {
    rmSync(join(projectDir, 'dist'), { recursive: true, force: true });
}

export function resolveFromProject(projectDir: string, specifier: string): string {
    try {
        return createRequire(join(projectDir, 'package.json')).resolve(specifier);
    } catch (error) {
        throw new Error(`Could not resolve ${specifier} from ${projectDir}. Install it in the project before running this command.`, {
            cause: error
        });
    }
}

export function runNode(args: string[], cwd = process.cwd(), env: EnvObject = Env): SpawnResult {
    const result = spawnSync(process.execPath, args, {
        cwd,
        env: toProcessEnv({ ...Env, ...env }),
        stdio: 'inherit'
    });
    return { status: result.status ?? 1 };
}

export function runBinary(bin: string, args: string[], cwd = process.cwd(), env: EnvObject = Env): SpawnResult {
    const result = spawnSync(bin, args, {
        cwd,
        env: toProcessEnv({ ...Env, ...env }),
        stdio: 'inherit'
    });
    if (result.error) {
        console.error(result.error.message);
        return { status: 1 };
    }
    return { status: result.status ?? 1 };
}
