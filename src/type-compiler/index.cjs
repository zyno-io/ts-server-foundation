/* oxlint-disable typescript/no-require-imports -- ttsc loads this descriptor as CommonJS. */
const path = require('node:path');
const { tryInstallPrebuiltTypeCompiler } = require('./prebuilt.cjs');

module.exports = context => {
    const source = path.join(context.dirname, 'go');
    tryInstallPrebuiltTypeCompiler(context, source);
    return {
        name: 'tsf-type-metadata',
        source
    };
};
