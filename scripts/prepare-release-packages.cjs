#!/usr/bin/env node
'use strict';
/* oxlint-disable typescript/no-require-imports -- release tooling runs as CommonJS. */

const fs = require('node:fs');
const path = require('node:path');

const FOUNDATION_PACKAGE = '@zyno-io/ts-server-foundation';
const REFLECTION_PACKAGE = '@zyno-io/ts-reflection';
const UTILS_PACKAGE = '@zyno-io/ts-utils';

function prepareReleasePackages(root, version) {
    if (typeof version !== 'string' || version.trim() === '') throw new Error('a release version is required');

    const foundationPath = path.join(root, 'package.json');
    const reflectionPath = path.join(root, 'packages', 'reflection', 'package.json');
    const utilsPath = path.join(root, 'packages', 'utils', 'package.json');
    const foundation = readPackage(foundationPath);
    const reflection = readPackage(reflectionPath);
    const utils = readPackage(utilsPath);
    if (foundation.name !== FOUNDATION_PACKAGE) throw new Error(`expected ${FOUNDATION_PACKAGE} at ${foundationPath}`);
    if (reflection.name !== REFLECTION_PACKAGE) throw new Error(`expected ${REFLECTION_PACKAGE} at ${reflectionPath}`);
    if (utils.name !== UTILS_PACKAGE) throw new Error(`expected ${UTILS_PACKAGE} at ${utilsPath}`);
    if (!foundation.dependencies || typeof foundation.dependencies !== 'object') throw new Error('foundation package has no dependencies');
    if (typeof foundation.dependencies[REFLECTION_PACKAGE] !== 'string') throw new Error(`foundation package must depend on ${REFLECTION_PACKAGE}`);
    if (typeof foundation.dependencies[UTILS_PACKAGE] !== 'string') throw new Error(`foundation package must depend on ${UTILS_PACKAGE}`);

    reflection.version = version;
    utils.version = version;
    foundation.version = version;
    foundation.dependencies[REFLECTION_PACKAGE] = version;
    foundation.dependencies[UTILS_PACKAGE] = version;
    writePackage(reflectionPath, reflection);
    writePackage(utilsPath, utils);
    writePackage(foundationPath, foundation);
}

function readPackage(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePackage(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`);
}

if (require.main === module) prepareReleasePackages(process.cwd(), process.argv[2]);

module.exports = { prepareReleasePackages };
