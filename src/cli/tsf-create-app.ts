#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findPackageRoot, readPackageDependencyVersion } from './common';

const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function createAppFromTemplate(args = process.argv.slice(2)): number {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        return args.length === 0 ? 1 : 0;
    }

    const packageName = args[0];
    if (!PACKAGE_NAME_PATTERN.test(packageName)) {
        console.error(`Error: Invalid package name: ${packageName}`);
        return 1;
    }

    const unscopedName = packageName.includes('/') ? packageName.split('/').pop()! : packageName;
    const targetDir = args[1] || unscopedName;
    const absoluteTarget = resolve(targetDir);

    if (existsSync(absoluteTarget)) {
        console.error(`Error: Directory already exists: ${absoluteTarget}`);
        return 1;
    }

    const packageRoot = findPackageRoot();
    const templateDir = join(packageRoot, 'template-app');
    if (!existsSync(templateDir)) {
        console.error('Error: Template directory not found. Ensure @zyno-io/ts-server-foundation is properly installed.');
        return 1;
    }

    const version = getFoundationVersion(packageRoot);
    const replacements: Record<string, string> = {
        '%%PACKAGE_NAME%%': packageName,
        '%%APP_DB_NAME%%': unscopedName.replace(/[^a-z0-9]/g, '_'),
        '%%APP_REDIS_PREFIX%%': unscopedName.replace(/[-_.]/g, ''),
        '%%FOUNDATION_VERSION%%': version,
        '%%TSF_VERSION%%': version,
        '%%TTSC_VERSION%%': readPackageDependencyVersion(packageRoot, 'ttsc'),
        '%%TYPESCRIPT_VERSION%%': readPackageDependencyVersion(packageRoot, 'typescript')
    };

    console.log(`Creating ${packageName} in ${absoluteTarget}...`);
    copyTemplate(templateDir, absoluteTarget, replacements);
    console.log();
    console.log('Done. Next steps:');
    console.log(`  cd ${targetDir}`);
    console.log('  corepack yarn install');
    console.log('  corepack yarn dev');
    return 0;
}

function printUsage(): void {
    console.log('Usage: tsf-create-app <package-name> [path]');
    console.log();
    console.log('Arguments:');
    console.log('  <package-name>  npm package name, for example @myorg/my-api or my-api');
    console.log('  [path]          Output directory, defaulting to the unscoped package name');
}

function getFoundationVersion(packageRoot: string): string {
    try {
        const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
            version?: string;
        };
        if (!pkg.version || pkg.version === '0.0.0-dev') return '*';
        return `^${pkg.version}`;
    } catch {
        return '*';
    }
}

function copyTemplate(src: string, dest: string, replacements: Record<string, string>): void {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const destName = entry.name === 'gitignore.tmpl' ? '.gitignore' : entry.name.endsWith('.tmpl') ? entry.name.slice(0, -5) : entry.name;
        const destPath = join(dest, destName);

        if (entry.isDirectory()) {
            copyTemplate(srcPath, destPath, replacements);
            continue;
        }

        let content = readFileSync(srcPath, 'utf8');
        for (const [key, value] of Object.entries(replacements)) {
            content = content.split(key).join(value);
        }
        writeFileSync(destPath, content);
    }
}

if (require.main === module) {
    process.exit(createAppFromTemplate());
}
