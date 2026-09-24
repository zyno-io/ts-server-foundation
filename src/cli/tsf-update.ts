#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
    detectPackageManager,
    findProjectRoot,
    findWorkspaceRoot,
    getWorkspacePatterns,
    globWorkspacePackageJsonPaths,
    readPackageJsonIfExists,
    runPackageManagerInstall,
    type WorkspacePackageJson
} from './common';

const PACKAGE_NAME = '@zyno-io/ts-server-foundation';
const PROTOCOL_SPEC_PATTERN = /^(?:workspace|link|file|portal|patch|npm):/;

export interface UpdatePackageInfo {
    version: string;
    dependencies?: Record<string, string>;
}

export interface UpdateOptions {
    projectDir?: string;
    spec?: string;
    install?: boolean;
    packageInfo?: UpdatePackageInfo;
}

interface DependentPackageJson extends WorkspacePackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

export function update(options: UpdateOptions = {}): number {
    const projectDir = options.projectDir ?? findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectDir) ?? projectDir;
    const spec = options.spec ?? 'latest';

    let packageInfo: UpdatePackageInfo;
    if (options.packageInfo) {
        packageInfo = options.packageInfo;
    } else {
        try {
            packageInfo = fetchPackageInfo(spec);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            return 1;
        }
    }

    const rootPackageJsonPath = resolve(workspaceRoot, 'package.json');
    const rootPkg = readPackageJsonIfExists(rootPackageJsonPath);
    if (!rootPkg) {
        console.error(`Could not find ${rootPackageJsonPath}.`);
        return 1;
    }

    let changedAny = false;
    for (const packageJsonPath of findWorkspacePackageJsonPaths(workspaceRoot, rootPkg)) {
        const label = relative(workspaceRoot, packageJsonPath) || 'package.json';
        if (updatePackageJson(packageJsonPath, label, packageInfo)) changedAny = true;
    }

    if (!changedAny || options.install === false) return 0;

    const packageManager = detectPackageManager(workspaceRoot, rootPkg);
    // Not a tsf-install rerun: the postinstall tsf-install must stay free to reinstall if the new version changes compiler setup.
    return runPackageManagerInstall(packageManager.installDir, packageManager.manager, { command: 'tsf-update', markRerun: false });
}

export function parseUpdateArgs(args: readonly string[]): { spec?: string; install: boolean; unknownArgs: string[] } {
    const remaining = [...args];
    const install = !takeFlag(remaining, '--no-install');
    const spec = remaining.shift();
    return { spec, install, unknownArgs: remaining };
}

export function runUpdateCli(args = process.argv.slice(2)): number {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: tsf-update [version-or-dist-tag] [--no-install]');
        console.log();
        console.log(
            `Updates ${PACKAGE_NAME} to the given version or dist-tag (default: latest) across the workspace, aligns dependencies it publishes, and reinstalls unless --no-install is passed.`
        );
        return 0;
    }

    const { spec, install, unknownArgs } = parseUpdateArgs(args);
    if (unknownArgs.length) {
        console.error(`Unknown option: ${unknownArgs[0]}`);
        return 1;
    }

    return update({ spec, install });
}

function takeFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) return false;
    args.splice(index, 1);
    return true;
}

function findWorkspacePackageJsonPaths(workspaceRoot: string, workspaceRootPkg: WorkspacePackageJson): string[] {
    const rootPackageJsonPath = resolve(workspaceRoot, 'package.json');
    const packageJsonPaths = new Set<string>([rootPackageJsonPath]);

    const patterns = getWorkspacePatterns(workspaceRootPkg);
    if (!patterns?.length) return [...packageJsonPaths];

    const excludedPaths = new Set(
        patterns.filter(pattern => pattern.startsWith('!')).flatMap(pattern => globWorkspacePackageJsonPaths(workspaceRoot, pattern.slice(1)))
    );
    for (const packageJsonPath of patterns
        .filter(pattern => !pattern.startsWith('!'))
        .flatMap(pattern => globWorkspacePackageJsonPaths(workspaceRoot, pattern))
        .sort()) {
        if (!excludedPaths.has(packageJsonPath)) packageJsonPaths.add(packageJsonPath);
    }

    return [...packageJsonPaths];
}

function updatePackageJson(packageJsonPath: string, label: string, packageInfo: UpdatePackageInfo): boolean {
    const raw = readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as DependentPackageJson;

    const declaresFoundation = pkg.dependencies?.[PACKAGE_NAME] !== undefined || pkg.devDependencies?.[PACKAGE_NAME] !== undefined;
    if (!declaresFoundation) return false;

    let changed = applyDependencyUpdate(pkg, PACKAGE_NAME, packageInfo.version, label);
    for (const [dependencyName, dependencySpec] of Object.entries(packageInfo.dependencies ?? {})) {
        changed = applyDependencyUpdate(pkg, dependencyName, dependencySpec, label) || changed;
    }

    if (changed) writePackageJson(packageJsonPath, raw, pkg);
    else console.log(`${label}: already up to date.`);

    return changed;
}

function applyDependencyUpdate(pkg: DependentPackageJson, name: string, newSpec: string, label: string): boolean {
    let changed = false;
    for (const section of ['dependencies', 'devDependencies'] as const) {
        const bag = pkg[section];
        const current = bag?.[name];
        if (current === undefined || current === newSpec) continue;

        if (current === '*' || PROTOCOL_SPEC_PATTERN.test(current)) {
            console.log(`${label}: Leaving ${name} at ${current}.`);
            continue;
        }

        console.log(`${label}: Updating ${name} from ${current} to ${newSpec}.`);
        bag![name] = newSpec;
        changed = true;
    }
    return changed;
}

function writePackageJson(path: string, raw: string, pkg: DependentPackageJson): void {
    const indent = detectIndent(raw);
    const serialized = JSON.stringify(pkg, null, indent);
    writeFileSync(path, raw.endsWith('\n') ? `${serialized}\n` : serialized);
}

function detectIndent(raw: string): string {
    const match = raw.match(/\r?\n([ \t]+)\S/);
    return match ? match[1] : '    ';
}

function fetchPackageInfo(spec: string): UpdatePackageInfo {
    const result = spawnSync('npm', ['view', `${PACKAGE_NAME}@${spec}`, 'version', 'dependencies', '--json'], { encoding: 'utf8' });
    if (result.error) throw new Error(`Could not run npm: ${result.error.message}`);
    if (result.status !== 0) {
        const message = result.stderr?.trim() || `npm view exited with status ${result.status ?? 'unknown'}`;
        throw new Error(`Could not fetch ${PACKAGE_NAME}@${spec} from npm: ${message}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(`Could not parse npm view output for ${PACKAGE_NAME}@${spec}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const info = (Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed) as { version?: unknown; dependencies?: unknown } | undefined;
    const version = info?.version;
    if (typeof version !== 'string' || !version) {
        throw new Error(`Could not determine the published version of ${PACKAGE_NAME}@${spec}.`);
    }

    return { version, dependencies: isStringRecord(info?.dependencies) ? info.dependencies : undefined };
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === 'string');
}

if (require.main === module) {
    process.exit(runUpdateCli());
}
