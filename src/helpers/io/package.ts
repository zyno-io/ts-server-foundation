import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageJson {
    name?: string;
    version?: string;
    [key: string]: unknown;
}

let cachedPackageJson: PackageJson | undefined;
let hasCachedPackageJson = false;

export function getPackageJson(): PackageJson | undefined {
    if (hasCachedPackageJson) return cachedPackageJson;
    hasCachedPackageJson = true;

    try {
        cachedPackageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
    } catch {
        cachedPackageJson = undefined;
    }

    return cachedPackageJson;
}

export function resetPackageJsonCache(): void {
    cachedPackageJson = undefined;
    hasCachedPackageJson = false;
}

export function getPackageVersion(): string | undefined {
    return getPackageJson()?.version;
}

export function getPackageName(): string | undefined {
    return getPackageJson()?.name;
}
