/* oxlint-disable typescript/no-require-imports -- ttsc loads this descriptor as CommonJS. */
const path = require('node:path');
const fs = require('node:fs');
const { tryInstallPrebuiltTypeCompiler } = require('./prebuilt.cjs');
const { preparePnpPaths } = require('./pnp.cjs');

module.exports = context => {
    const dirname = resolvePluginDirectory(context?.dirname);
    const pluginContext = { ...context, dirname };
    const source = preparePnpPaths(pluginContext, path.join(dirname, 'go'));
    tryInstallPrebuiltTypeCompiler(pluginContext, source);
    return {
        name: 'tsf-type-metadata',
        source
    };
};

function resolvePluginDirectory(contextDirectory) {
    const candidate = typeof contextDirectory === 'string' ? resolveVirtualPath(contextDirectory) : undefined;
    return candidate !== undefined && belongsToReflectionPackage(candidate) ? candidate : resolveVirtualPath(__dirname);
}

function belongsToReflectionPackage(directory) {
    let current = path.resolve(directory);
    while (true) {
        try {
            if (JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')).name === '@zyno-io/ts-reflection') return true;
        } catch {
            // Continue searching ancestor directories.
        }
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}

function resolveVirtualPath(directory) {
    try {
        return require('pnpapi').resolveVirtual(directory) ?? directory;
    } catch {
        return directory;
    }
}
