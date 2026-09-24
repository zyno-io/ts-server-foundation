import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { Env, type EnvObject, toProcessEnv } from '../env';

export interface SpawnResult {
    status: number;
}

export interface WorkspacePackageJson {
    packageManager?: string;
    workspaces?: string[] | { packages?: string[] };
    [key: string]: unknown;
}

export type PackageManager = 'yarn' | 'npm' | 'pnpm' | 'bun';

export interface PackageManagerInfo {
    installDir: string;
    manager: PackageManager;
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

export function readPackageJsonIfExists(path: string): WorkspacePackageJson | undefined {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as WorkspacePackageJson;
}

export function getWorkspacePatterns(pkg: WorkspacePackageJson): string[] | undefined {
    return Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
}

export function globWorkspacePackageJsonPaths(workspaceRoot: string, workspacePattern: string): string[] {
    const pattern = workspacePattern.replace(/\/$/, '');
    return globSync(`${pattern}/package.json`, {
        cwd: workspaceRoot,
        exclude: ['**/node_modules/**']
    }).map(path => resolve(workspaceRoot, path));
}

export function findWorkspaceRoot(projectDir: string): string | undefined {
    let dir = resolve(projectDir);
    while (true) {
        const pkg = readPackageJsonIfExists(join(dir, 'package.json'));
        if (pkg && getWorkspacePatterns(pkg)?.length) return dir;

        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

export function detectPackageManager(projectDir: string, pkg: WorkspacePackageJson): PackageManagerInfo {
    let dir = projectDir;
    while (true) {
        const lockfile = detectLockfilePackageManager(dir);
        if (lockfile) return { installDir: dir, manager: lockfile };

        const packageJson = dir === projectDir ? pkg : readPackageJsonIfExists(join(dir, 'package.json'));
        if (packageJson) {
            const declared = getDeclaredPackageManager(packageJson);
            if (declared) return { installDir: dir, manager: declared };
        }

        const parent = dirname(dir);
        if (parent === dir) return { installDir: projectDir, manager: 'npm' };
        dir = parent;
    }
}

export function getDeclaredPackageManager(pkg: WorkspacePackageJson): PackageManager | undefined {
    const declared = pkg.packageManager?.split('@')[0];
    if (declared === 'yarn' || declared === 'npm' || declared === 'pnpm' || declared === 'bun') return declared;
}

export function detectLockfilePackageManager(dir: string): PackageManager | undefined {
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm';
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
    if (existsSync(join(dir, '.yarnrc.yml'))) return 'yarn';
}

export const PACKAGE_MANAGER_RERUN_ENV = 'TSF_INSTALL_PACKAGE_MANAGER_RERUN';

export function runPackageManagerInstall(
    projectDir: string,
    packageManager: PackageManager,
    { command = 'tsf-install', markRerun = true }: { command?: string; markRerun?: boolean } = {}
): number {
    console.log(`${command}: running ${packageManager} install`);
    const result = spawnSync(packageManager, ['install'], {
        cwd: projectDir,
        stdio: 'inherit',
        env: markRerun ? { ...process.env, [PACKAGE_MANAGER_RERUN_ENV]: '1' } : process.env
    });
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status ?? 1;
}
