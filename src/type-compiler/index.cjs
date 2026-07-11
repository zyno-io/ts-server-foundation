const path = require('node:path');

module.exports = context => ({
    name: 'tsf-type-metadata',
    source: path.join(context.dirname, 'go')
});
