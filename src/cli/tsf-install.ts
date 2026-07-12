#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { findPackageRoot, findProjectRoot, readPackageDependencyVersion } from './common';

const PACKAGE_NAME = '@zyno-io/ts-server-foundation';
const INSTALL_COMMAND = 'tsf-install';
const PACKAGE_MANAGER_RERUN_ENV = 'TSF_INSTALL_PACKAGE_MANAGER_RERUN';
const PACKAGE_TYPE_COMPILER_PLUGIN = '@zyno-io/ts-server-foundation/type-compiler';

interface PackageJson {
    version?: string;
    packageManager?: string;
    workspaces?: string[] | { packages?: string[] };
    tsf?: {
        compiler?: boolean;
    };
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    [key: string]: unknown;
}

interface InstallOptions {
    projectDir?: string;
    runPackageManager?: boolean;
}

type PackageManager = 'yarn' | 'npm' | 'pnpm' | 'bun';

interface PackageManagerInfo {
    installDir: string;
    manager: PackageManager;
}

interface BaselineVersions {
    framework: string;
    ttsc: string;
    typescript: string;
}

interface WorkspacePackage {
    dir: string;
    packageJsonPath: string;
    pkg: PackageJson;
}

interface TsconfigJson {
    extends?: unknown;
    compilerOptions?: {
        plugins?: unknown;
        [key: string]: unknown;
    };
    reflection?: unknown;
    [key: string]: unknown;
}

const TSCONFIG_FILE_PATTERN = /^tsconfig(?:\..*)?\.json$/;
const SKIPPED_TSCONFIG_DIRS = new Set(['.git', '.hg', '.svn', '.yarn', 'node_modules', 'dist', 'build', 'coverage']);

export function install(options: InstallOptions = {}): number {
    const projectDir = options.projectDir ?? findInstallProjectRoot();
    const packageJsonPath = join(projectDir, 'package.json');
    const pkg = readPackageJson(packageJsonPath);
    const workspaceRoot = findWorkspaceRoot(projectDir) ?? projectDir;
    const workspacePkg = resolve(workspaceRoot) === resolve(projectDir) ? pkg : readPackageJson(join(workspaceRoot, 'package.json'));
    const packageManager = detectPackageManager(workspaceRoot, workspacePkg);
    const baselineVersions = readBaselineVersions();
    const postinstallChanged = ensurePostinstallScript(pkg);
    const changedPackages = new Map<string, PackageJson>();
    let compilerSetupChanged = false;
    let tsconfigChanged = false;

    if (postinstallChanged) changedPackages.set(resolve(packageJsonPath), pkg);
    for (const workspace of findCompilerWorkspaces(workspaceRoot, workspacePkg, packageJsonPath, pkg)) {
        const packageChanged = ensureCompilerSetup(workspace.pkg, baselineVersions);
        if (packageChanged) {
            changedPackages.set(workspace.packageJsonPath, workspace.pkg);
            compilerSetupChanged = true;
        }
        tsconfigChanged = ensureTsconfigCompilerPlugins(workspace.dir) || tsconfigChanged;
    }

    for (const [changedPackageJsonPath, changedPkg] of changedPackages) writePackageJson(changedPackageJsonPath, changedPkg);
    if (postinstallChanged) console.log('tsf-install: updated postinstall script');
    if (compilerSetupChanged) console.log('tsf-install: updated TypeScript compiler setup');
    if (tsconfigChanged) console.log('tsf-install: updated tsconfig compiler plugin');

    if (compilerSetupChanged && options.runPackageManager !== false && process.env[PACKAGE_MANAGER_RERUN_ENV] !== '1') {
        return runPackageManagerInstall(packageManager.installDir, packageManager.manager);
    }

    return 0;
}

function ensureCompilerSetup(pkg: PackageJson, versions: BaselineVersions): boolean {
    let changed = false;
    changed = ensureDevDependency(pkg, 'ttsc', versions.ttsc) || changed;
    changed = ensureDevDependency(pkg, 'typescript', versions.typescript) || changed;
    changed =
        (pkg.tsf?.compiler === true && !hasFoundationPackageDependency(pkg)
            ? ensureDevDependency(pkg, PACKAGE_NAME, versions.framework)
            : setDependencyVersionIfPresent(pkg, PACKAGE_NAME, versions.framework)) || changed;
    return changed;
}

function findInstallProjectRoot(): string {
    const packageJsonPath = process.env.npm_package_json;
    if (packageJsonPath && basename(packageJsonPath) === 'package.json' && existsSync(packageJsonPath)) {
        return dirname(resolve(packageJsonPath));
    }
    return findProjectRoot();
}

function readPackageJson(path: string): PackageJson {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function writePackageJson(path: string, pkg: PackageJson): void {
    writeFileSync(path, `${JSON.stringify(pkg, null, 4)}\n`);
}

function readBaselineVersions(): BaselineVersions {
    const packageRoot = findPackageRoot();
    const frameworkVersion = readPackageJson(join(packageRoot, 'package.json')).version;
    if (!frameworkVersion) throw new Error(`Could not determine ${PACKAGE_NAME} version`);
    return {
        framework: frameworkVersion,
        ttsc: readPackageDependencyVersion(packageRoot, 'ttsc'),
        typescript: readPackageDependencyVersion(packageRoot, 'typescript')
    };
}

function ensurePostinstallScript(pkg: PackageJson): boolean {
    pkg.scripts ??= {};
    const existing = pkg.scripts.postinstall?.trim();
    if (!existing) {
        pkg.scripts.postinstall = INSTALL_COMMAND;
        return true;
    }
    if (hasInstallCommand(existing)) return false;

    pkg.scripts.postinstall = `${existing} && ${INSTALL_COMMAND}`;
    return true;
}

function hasInstallCommand(script: string): boolean {
    return script
        .split(/\s*(?:&&|\|\||;)\s*/)
        .some(command => /^(?:(?:npx|yarn|bunx)\s+|pnpm\s+(?:exec\s+)?|npm\s+exec\s+)?tsf-install(?:\s|$)/.test(command));
}

function ensureDevDependency(pkg: PackageJson, name: string, version: string): boolean {
    let changed = false;
    if (pkg.dependencies?.[name] !== undefined) {
        delete pkg.dependencies[name];
        changed = true;
    }

    pkg.devDependencies ??= {};
    if (pkg.devDependencies[name] !== version) {
        pkg.devDependencies[name] = version;
        changed = true;
    }

    return changed;
}

function findCompilerWorkspaces(
    workspaceRoot: string,
    workspaceRootPkg: PackageJson,
    projectPackageJsonPath: string,
    projectPkg: PackageJson
): WorkspacePackage[] {
    const resolvedProjectPackageJsonPath = resolve(projectPackageJsonPath);
    const rootPackageJsonPath = resolve(workspaceRoot, 'package.json');
    const packages = new Map<string, WorkspacePackage>();
    packages.set(rootPackageJsonPath, {
        dir: resolve(workspaceRoot),
        packageJsonPath: rootPackageJsonPath,
        pkg: rootPackageJsonPath === resolvedProjectPackageJsonPath ? projectPkg : workspaceRootPkg
    });

    const workspaces = getWorkspacePatterns(workspaceRootPkg);
    if (!workspaces?.length) return projectPkg.tsf?.compiler === false ? [] : [...packages.values()];

    const excludedPaths = new Set(
        workspaces.filter(pattern => pattern.startsWith('!')).flatMap(pattern => globWorkspacePackageJsonPaths(workspaceRoot, pattern.slice(1)))
    );
    for (const packageJsonPath of workspaces
        .filter(pattern => !pattern.startsWith('!'))
        .flatMap(pattern => globWorkspacePackageJsonPaths(workspaceRoot, pattern))
        .sort()) {
        if (excludedPaths.has(packageJsonPath)) continue;
        packages.set(packageJsonPath, {
            dir: dirname(packageJsonPath),
            packageJsonPath,
            pkg: packageJsonPath === resolvedProjectPackageJsonPath ? projectPkg : readPackageJson(packageJsonPath)
        });
    }

    return [...packages.values()].filter(workspace => usesTsfCompiler(workspace.pkg));
}

function findWorkspaceRoot(projectDir: string): string | undefined {
    let dir = resolve(projectDir);
    while (true) {
        const pkg = readPackageJsonIfExists(join(dir, 'package.json'));
        if (pkg && getWorkspacePatterns(pkg)?.length) return dir;

        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

function getWorkspacePatterns(pkg: PackageJson): string[] | undefined {
    return Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
}

function globWorkspacePackageJsonPaths(workspaceRoot: string, workspacePattern: string): string[] {
    const pattern = workspacePattern.replace(/\/$/, '');
    return globSync(`${pattern}/package.json`, {
        cwd: workspaceRoot,
        exclude: ['**/node_modules/**']
    }).map(path => resolve(workspaceRoot, path));
}

function setDependencyVersionIfPresent(pkg: PackageJson, name: string, version: string): boolean {
    let changed = false;
    for (const dependencies of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
        if (dependencies?.[name] === undefined || dependencies[name] === version) continue;
        dependencies[name] = version;
        changed = true;
    }
    return changed;
}

function ensureTsconfigCompilerPlugins(projectDir: string): boolean {
    const patchedTsconfigs = new Set<string>();
    let changed = false;

    for (const tsconfigPath of findTsconfigPaths(projectDir)) {
        const tsconfig = readTsconfigJson(tsconfigPath);
        if (extendsPatchedTsconfig(tsconfigPath, tsconfig, patchedTsconfigs)) continue;

        const result = ensureTsconfigCompilerPlugin(tsconfigPath, tsconfig);
        if (result.hasCompilerSetup) patchedTsconfigs.add(tsconfigPath);
        changed = result.changed || changed;
    }

    return changed;
}

function ensureTsconfigCompilerPlugin(tsconfigPath: string, tsconfig: TsconfigJson): { changed: boolean; hasCompilerSetup: boolean } {
    let changed = false;
    tsconfig.compilerOptions ??= {};
    const plugins = Array.isArray(tsconfig.compilerOptions.plugins) ? tsconfig.compilerOptions.plugins : [];
    if (plugins !== tsconfig.compilerOptions.plugins) {
        tsconfig.compilerOptions.plugins = plugins;
        changed = true;
    }

    const existingPlugin = plugins.find(isTypeCompilerPlugin) as { transform?: unknown } | undefined;
    if (!existingPlugin) {
        plugins.push({ transform: PACKAGE_TYPE_COMPILER_PLUGIN });
        changed = true;
    } else if (existingPlugin.transform !== PACKAGE_TYPE_COMPILER_PLUGIN) {
        existingPlugin.transform = PACKAGE_TYPE_COMPILER_PLUGIN;
        changed = true;
    }

    if (tsconfig.reflection !== true) {
        tsconfig.reflection = true;
        changed = true;
    }

    if (changed) writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 4)}\n`);
    return { changed, hasCompilerSetup: hasTsconfigCompilerSetup(tsconfig) };
}

function findTsconfigPaths(projectDir: string): string[] {
    const root = resolve(projectDir);
    const paths: string[] = [];

    const visit = (dir: string) => {
        if (dir !== root && existsSync(join(dir, 'package.json'))) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIPPED_TSCONFIG_DIRS.has(entry.name)) visit(join(dir, entry.name));
                continue;
            }

            if (entry.isFile() && TSCONFIG_FILE_PATTERN.test(entry.name)) paths.push(resolve(dir, entry.name));
        }
    };

    visit(root);
    return paths.sort(compareTsconfigPaths);
}

function absolutePathDepth(path: string): number {
    return resolve(path)
        .split(/[\\/]+/)
        .filter(Boolean).length;
}

function compareTsconfigPaths(a: string, b: string): number {
    const depthDiff = absolutePathDepth(a) - absolutePathDepth(b);
    if (depthDiff) return depthDiff;
    const basePriorityDiff = tsconfigBasePriority(a) - tsconfigBasePriority(b);
    if (basePriorityDiff) return basePriorityDiff;
    return a.localeCompare(b);
}

function tsconfigBasePriority(path: string): number {
    return basename(path) === 'tsconfig.json' ? 0 : 1;
}

function readTsconfigJson(tsconfigPath: string): TsconfigJson {
    return parseJsonC(readFileSync(tsconfigPath, 'utf8')) as TsconfigJson;
}

function hasTsconfigCompilerSetup(tsconfig: TsconfigJson): boolean {
    return (
        tsconfig.reflection === true &&
        Array.isArray(tsconfig.compilerOptions?.plugins) &&
        tsconfig.compilerOptions.plugins.some(isTypeCompilerPlugin)
    );
}

function extendsPatchedTsconfig(tsconfigPath: string, tsconfig: TsconfigJson, patchedTsconfigs: Set<string>, seen = new Set<string>()): boolean {
    for (const extendedPath of resolveTsconfigExtends(tsconfigPath, tsconfig.extends)) {
        if (seen.has(extendedPath)) continue;
        seen.add(extendedPath);
        if (patchedTsconfigs.has(extendedPath)) return true;
        if (!existsSync(extendedPath)) continue;

        const extendedTsconfig = readTsconfigJson(extendedPath);
        if (hasTsconfigCompilerSetup(extendedTsconfig)) return true;
        if (extendsPatchedTsconfig(extendedPath, extendedTsconfig, patchedTsconfigs, seen)) return true;
    }

    return false;
}

function resolveTsconfigExtends(tsconfigPath: string, extended: unknown): string[] {
    const values = typeof extended === 'string' ? [extended] : Array.isArray(extended) ? extended.filter(value => typeof value === 'string') : [];
    return values.map(value => resolveTsconfigExtendsPath(tsconfigPath, value)).filter((value): value is string => value !== undefined);
}

function resolveTsconfigExtendsPath(tsconfigPath: string, extended: string): string | undefined {
    if (!isAbsolute(extended) && !extended.startsWith('.')) return undefined;
    return resolveTsconfigPathCandidate(isAbsolute(extended) ? extended : resolve(dirname(tsconfigPath), extended));
}

function resolveTsconfigPathCandidate(path: string): string {
    const candidates = path.endsWith('.json') ? [path] : [path, `${path}.json`, join(path, 'tsconfig.json')];
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
    }
    return resolve(candidates[0]);
}

function isTypeCompilerPlugin(plugin: unknown): boolean {
    if (!plugin || typeof plugin !== 'object') return false;
    const transform = (plugin as { transform?: unknown }).transform;
    if (typeof transform !== 'string') return false;
    const normalized = transform.replace(/\\/g, '/');
    return normalized.endsWith('/dist/src/type-compiler/index.cjs') || normalized === PACKAGE_TYPE_COMPILER_PLUGIN;
}

function hasFoundationPackageDependency(pkg: PackageJson): boolean {
    return (
        pkg.dependencies?.[PACKAGE_NAME] !== undefined ||
        pkg.devDependencies?.[PACKAGE_NAME] !== undefined ||
        pkg.peerDependencies?.[PACKAGE_NAME] !== undefined
    );
}

function usesTsfCompiler(pkg: PackageJson): boolean {
    return pkg.tsf?.compiler ?? hasFoundationPackageDependency(pkg);
}

function parseJsonC(contents: string): unknown {
    let output = '';
    let inString = false;
    let stringQuote = '';
    let escaped = false;

    for (let index = 0; index < contents.length; index++) {
        const char = contents[index];
        const next = contents[index + 1];

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === stringQuote) {
                inString = false;
                stringQuote = '';
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            stringQuote = char;
            output += char;
            continue;
        }

        if (char === '/' && next === '/') {
            while (index < contents.length && contents[index] !== '\n') index++;
            output += '\n';
            continue;
        }

        if (char === '/' && next === '*') {
            index += 2;
            while (index < contents.length && !(contents[index] === '*' && contents[index + 1] === '/')) index++;
            index++;
            continue;
        }

        output += char;
    }

    return JSON.parse(output);
}

function detectPackageManager(projectDir: string, pkg: PackageJson): PackageManagerInfo {
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

function readPackageJsonIfExists(path: string): PackageJson | undefined {
    if (!existsSync(path)) return undefined;
    return readPackageJson(path);
}

function getDeclaredPackageManager(pkg: PackageJson): PackageManager | undefined {
    const declared = pkg.packageManager?.split('@')[0];
    if (declared === 'yarn' || declared === 'npm' || declared === 'pnpm' || declared === 'bun') return declared;
}

function detectLockfilePackageManager(dir: string): PackageManager | undefined {
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm';
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
    if (existsSync(join(dir, '.yarnrc.yml'))) return 'yarn';
}

function runPackageManagerInstall(projectDir: string, packageManager: PackageManager): number {
    console.log(`tsf-install: running ${packageManager} install`);
    const result = spawnSync(packageManager, ['install'], {
        cwd: projectDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            [PACKAGE_MANAGER_RERUN_ENV]: '1'
        }
    });
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status ?? 1;
}

function main(args = process.argv.slice(2)): number {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: tsf-install [--no-install]');
        console.log();
        console.log('Ensures a project has the baseline compiler setup required by ts-server-foundation.');
        return 0;
    }

    const runPackageManager = !takeFlag(args, '--no-install');
    if (args.length) {
        console.error(`Unknown option: ${args[0]}`);
        return 1;
    }

    return install({ runPackageManager });
}

function takeFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) return false;
    args.splice(index, 1);
    return true;
}

if (require.main === module) {
    process.exit(main());
}
