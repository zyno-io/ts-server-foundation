'use strict';
/* oxlint-disable typescript/no-require-imports -- this helper runs inside the CommonJS ttsc descriptor. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_DIRECTORY = '.yarn/tsf-pnp';
const EXTERNAL_ROOTS_FILE = 'external-package-roots.json';
const MATERIALIZATION_SCHEMA_VERSION = 2;
const TYPE_SCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/i;
const PRUNED_DIRECTORIES = new Set(['.git', '.hg', '.svn', '.yarn', 'node_modules', 'coverage']);

/**
 * Yarn's ZipFS is available to Node but not to ttsc's Go subprocess. Keep the
 * handoff deliberately narrow: only this plugin's Go source and declaration
 * files for packages imported by the project are copied to a writable cache.
 */
function preparePnpPaths(context, source) {
    const pnpapi = loadPnpApi(context.projectRoot);
    if (pnpapi === undefined) return source;

    const cacheRoot = path.join(context.projectRoot, CACHE_DIRECTORY);
    const materializedSource = isArchivePath(source) ? materializeGoSource(source, cacheRoot) : source;
    const packageRoots = materializeImportedPackageRoots(context, pnpapi, cacheRoot);
    writeExternalPackageRoots(cacheRoot, packageRoots);
    return materializedSource;
}

function loadPnpApi(projectRoot) {
    if (!hasPnpManifest(projectRoot)) return undefined;
    try {
        return require('pnpapi');
    } catch {
        return undefined;
    }
}

function hasPnpManifest(projectRoot) {
    let directory = path.resolve(projectRoot);
    while (true) {
        if (fs.existsSync(path.join(directory, '.pnp.cjs'))) return true;
        const parent = path.dirname(directory);
        if (parent === directory) return false;
        directory = parent;
    }
}

function materializeGoSource(source, cacheRoot) {
    const key = hashDirectory(source);
    const destination = path.join(cacheRoot, 'plugin-source', key);
    if (fs.existsSync(path.join(destination, '.complete'))) return destination;

    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
        copyDirectory(source, temporary);
        fs.writeFileSync(path.join(temporary, '.complete'), '1\n');
        publishDirectory(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true, recursive: true });
    }
    return destination;
}

function copyDirectory(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (PRUNED_DIRECTORIES.has(entry.name)) continue;
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) copyDirectory(from, to);
        else if (entry.isFile()) fs.copyFileSync(from, to);
    }
}

function materializeImportedPackageRoots(context, pnpapi, cacheRoot) {
    const roots = {};
    const queued = new Set();
    const queue = [];
    const enqueue = (packageName, issuer, parent, direct) => {
        if (packageName === '') return;
        const key = `${issuer}\0${packageName}\0${parent ?? ''}`;
        if (!queued.has(key)) {
            queued.add(key);
            queue.push({ packageName, issuer, parent, direct });
        }
    };
    const projectIssuer = path.join(context.projectRoot, 'package.json');
    for (const packageName of importedPackageNames(context)) {
        enqueue(packageName, projectIssuer, undefined, true);
        enqueue(definitelyTypedPackageName(packageName), projectIssuer, undefined, true);
    }
    for (const packageName of configuredTypePackages(context, pnpapi)) enqueue(packageName, projectIssuer, undefined, true);
    enqueue('tslib', projectIssuer, undefined, true);

    for (const request of queue) {
        let packageRoot;
        try {
            packageRoot = pnpapi.resolveToUnqualified(request.packageName, request.issuer);
        } catch {
            continue;
        }
        if (typeof packageRoot !== 'string' || !fs.existsSync(packageRoot)) continue;
        const normalized = cleanPackageRoot(packageRoot);
        const source = materializeTypeScriptPackage(request.packageName, normalized, cacheRoot);
        const bridgePackage = request.parent === undefined
            ? path.join(context.projectRoot, 'node_modules', ...request.packageName.split('/'))
            : path.join(request.parent, 'node_modules', ...request.packageName.split('/'));
        linkBridgePackage(bridgePackage, source);
        for (const dependency of importedPackageNamesFromDirectory(normalized)) {
            enqueue(dependency, path.join(normalized, 'package.json'), source, false);
        }
        if (request.direct) roots[request.packageName] = bridgePackage;
    }
    return roots;
}

function configuredTypePackages(context, pnpapi) {
    const types = new Set();
    const visit = (configPath, seen = new Set()) => {
        if (seen.has(configPath)) return;
        seen.add(configPath);
        let config;
        try {
            config = parseJsonc(fs.readFileSync(configPath, 'utf8'));
        } catch {
            return;
        }
        const inherited = typeof config.extends === 'string' ? [config.extends] : Array.isArray(config.extends) ? config.extends : [];
        for (const specifier of inherited) {
            if (typeof specifier !== 'string') continue;
            const resolved = resolveExtendedConfig(specifier, configPath, pnpapi);
            if (resolved !== undefined) visit(resolved, seen);
        }
        if (!Array.isArray(config.compilerOptions?.types)) return;
        for (const name of config.compilerOptions.types) {
            if (typeof name !== 'string') continue;
            types.add(name.startsWith('@') || name.includes('/') ? name : `@types/${name}`);
        }
    };
    visit(context.tsconfig);
    return [...types].sort();
}

function resolveExtendedConfig(specifier, issuer, pnpapi) {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        const candidate = path.resolve(path.dirname(issuer), specifier);
        return candidate.endsWith('.json') ? candidate : `${candidate}.json`;
    }
    for (const request of [specifier, `${specifier}.json`]) {
        try {
            const resolved = pnpapi.resolveRequest(request, issuer);
            if (typeof resolved === 'string') return resolved;
        } catch {
            // Try the package root below.
        }
    }
    try {
        const root = cleanPackageRoot(pnpapi.resolveToUnqualified(specifier, issuer));
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const config = typeof manifest.tsconfig === 'string' ? manifest.tsconfig : 'tsconfig.json';
        return path.resolve(root, config);
    } catch {
        return undefined;
    }
}

function parseJsonc(source) {
    let output = '';
    let quoted = false;
    let quote = '';
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];
        if (quoted) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quoted = false;
            continue;
        }
        if (char === '"' || char === "'") {
            quoted = true;
            quote = char;
            output += char;
        } else if (char === '/' && next === '/') {
            while (index < source.length && source[index] !== '\n') index++;
            output += '\n';
        } else if (char === '/' && next === '*') {
            index += 2;
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
            index++;
        } else {
            output += char;
        }
    }
    return JSON.parse(output.replace(/,\s*([}\]])/g, '$1'));
}

function linkBridgePackage(destination, source) {
    try {
        if (fs.realpathSync(destination) === fs.realpathSync(source)) return;
    } catch {
        // Create the link below.
    }
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    try {
        if (!fs.lstatSync(destination).isSymbolicLink()) return;
    } catch {
        // The destination does not exist yet.
    }
    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        fs.symlinkSync(source, temporary, process.platform === 'win32' ? 'junction' : 'dir');
        try {
            fs.renameSync(temporary, destination);
        } catch (error) {
            try {
                if (fs.realpathSync(destination) === fs.realpathSync(source)) return;
                if (!fs.lstatSync(destination).isSymbolicLink()) return;
                fs.unlinkSync(destination);
                fs.renameSync(temporary, destination);
            } catch {
                if (fs.realpathSync(destination) !== fs.realpathSync(source)) throw error;
            }
        }
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function importedPackageNames(context) {
    const specs = new Set();
    for (const file of projectSourceFiles(context)) {
        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        for (const name of packageNamesFromSource(source)) specs.add(name);
    }
    return [...specs].sort();
}

function importedPackageNamesFromDirectory(directory) {
    const specs = new Set();
    const visit = current => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!PRUNED_DIRECTORIES.has(entry.name)) visit(path.join(current, entry.name));
                continue;
            }
            if (!entry.isFile() || !TYPE_SCRIPT_SOURCE.test(entry.name)) continue;
            let source;
            try {
                source = fs.readFileSync(path.join(current, entry.name), 'utf8');
            } catch {
                continue;
            }
            for (const name of packageNamesFromSource(source)) specs.add(name);
        }
    };
    visit(directory);
    return [...specs].sort();
}

function packageNamesFromSource(source) {
    const names = new Set();
    const expression =
        /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+[^=]+?=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of source.matchAll(expression)) {
        const name = packageNameFromSpecifier(match[1] ?? match[2] ?? match[3]);
        if (name !== '') names.add(name);
    }
    for (const match of source.matchAll(/^\s*\/\/\/\s*<reference\s+types=['"]([^'"]+)['"]/gm)) {
        const name = match[1];
        names.add(name.startsWith('@types/') ? name : `@types/${name}`);
    }
    return names;
}

function projectSourceFiles(context) {
    const files = [];
    const visit = directory => {
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!PRUNED_DIRECTORIES.has(entry.name) && entry.name !== 'dist' && entry.name !== 'build') visit(file);
            } else if (entry.isFile() && TYPE_SCRIPT_SOURCE.test(entry.name)) {
                files.push(file);
            }
        }
    };
    visit(context.projectRoot);
    return files;
}

function packageNameFromSpecifier(specifier) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.startsWith('node:')) return '';
    const parts = specifier.split('/');
    if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '';
    return parts[0] ?? '';
}

function definitelyTypedPackageName(packageName) {
    if (packageName.startsWith('@')) {
        const [scope, name] = packageName.slice(1).split('/');
        return scope && name ? `@types/${scope}__${name}` : '';
    }
    return `@types/${packageName}`;
}

function materializeTypeScriptPackage(packageName, source, cacheRoot) {
    const packageJson = path.join(source, 'package.json');
    let manifest = '';
    try {
        manifest = fs.readFileSync(packageJson, 'utf8');
    } catch {
        // The package directory itself is still sufficient for the fallback scanner.
    }
    const hash = crypto
        .createHash('sha256')
        .update(`${MATERIALIZATION_SCHEMA_VERSION}\0${packageName}\0${source}\0${manifest}`);
    if (!isArchivePath(source)) hashTypeScriptFiles(source, source, hash);
    const key = hash.digest('hex');
    const container = path.join(cacheRoot, 'packages', key);
    const destination = path.join(container, 'node_modules', ...packageName.split('/'));
    if (fs.existsSync(path.join(container, '.complete'))) return destination;

    const temporary = `${container}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const temporaryPackage = path.join(temporary, 'node_modules', ...packageName.split('/'));
    fs.mkdirSync(temporaryPackage, { recursive: true });
    try {
        copyTypeScriptFiles(source, temporaryPackage);
        fs.writeFileSync(path.join(temporary, '.complete'), '1\n');
        publishDirectory(temporary, container);
    } finally {
        fs.rmSync(temporary, { force: true, recursive: true });
    }
    return destination;
}

function hashTypeScriptFiles(root, directory, hash) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) {
            if (!PRUNED_DIRECTORIES.has(entry.name)) hashTypeScriptFiles(root, path.join(directory, entry.name), hash);
            continue;
        }
        if (!entry.isFile() || (entry.name !== 'package.json' && !TYPE_SCRIPT_SOURCE.test(entry.name))) continue;
        const file = path.join(directory, entry.name);
        hash.update(`${path.relative(root, file).replaceAll(path.sep, '/')}\n`);
        hash.update(fs.readFileSync(file));
    }
}

function copyTypeScriptFiles(source, destination) {
    const walk = (from, to) => {
        let entries;
        try {
            entries = fs.readdirSync(from, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!PRUNED_DIRECTORIES.has(entry.name)) walk(path.join(from, entry.name), path.join(to, entry.name));
                continue;
            }
            if (!entry.isFile() || (entry.name !== 'package.json' && !TYPE_SCRIPT_SOURCE.test(entry.name))) continue;
            const target = path.join(to, entry.name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(from, entry.name), target);
        }
    };
    walk(source, destination);
}

function writeExternalPackageRoots(cacheRoot, roots) {
    const destination = path.join(cacheRoot, EXTERNAL_ROOTS_FILE);
    const serialized = `${JSON.stringify(roots)}\n`;
    try {
        if (fs.readFileSync(destination, 'utf8') === serialized) return;
    } catch {
        // Write the first map below.
    }
    fs.mkdirSync(cacheRoot, { recursive: true });
    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        fs.writeFileSync(temporary, serialized);
        fs.renameSync(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function publishDirectory(temporary, destination) {
    try {
        fs.renameSync(temporary, destination);
    } catch (error) {
        if (!fs.existsSync(path.join(destination, '.complete'))) throw error;
    }
}

function cleanPackageRoot(root) {
    return root.endsWith(path.sep) ? root.slice(0, -1) : root;
}

function isArchivePath(value) {
    return /\.zip[\\/]node_modules[\\/]/.test(value);
}

function hashDirectory(root) {
    const hash = crypto.createHash('sha256');
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (PRUNED_DIRECTORIES.has(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(file);
            } else if (entry.isFile()) {
                hash.update(`${path.relative(root, file).replaceAll(path.sep, '/')}\n`);
                hash.update(fs.readFileSync(file));
            }
        }
    };
    visit(root);
    return hash.digest('hex');
}

module.exports = {
    CACHE_DIRECTORY,
    EXTERNAL_ROOTS_FILE,
    importedPackageNames,
    isArchivePath,
    materializeImportedPackageRoots,
    materializeTypeScriptPackage,
    packageNameFromSpecifier,
    preparePnpPaths
};
