import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parse } from 'yaml';

// oxlint-disable-next-line typescript/no-require-imports
const { prepareReleasePackages } = require(join(process.cwd(), 'scripts', 'prepare-release-packages.cjs')) as {
    prepareReleasePackages(root: string, version: string): void;
};

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release package preparation', () => {
    it('versions reflection and utils before publishing foundation with a concrete dependency', () => {
        const root = mkdtempSync(join(tmpdir(), 'tsf-release-packages-'));
        directories.push(root);
        mkdirSync(join(root, 'packages', 'reflection'), { recursive: true });
        mkdirSync(join(root, 'packages', 'utils'), { recursive: true });
        writeFileSync(
            join(root, 'package.json'),
            JSON.stringify({
                name: '@zyno-io/ts-server-foundation',
                version: '0.0.0-dev',
                dependencies: { '@zyno-io/ts-reflection': 'workspace:*', '@zyno-io/ts-utils': 'workspace:*' }
            })
        );
        writeFileSync(join(root, 'packages', 'reflection', 'package.json'), JSON.stringify({ name: '@zyno-io/ts-reflection', version: '0.0.0-dev' }));
        writeFileSync(join(root, 'packages', 'utils', 'package.json'), JSON.stringify({ name: '@zyno-io/ts-utils', version: '0.0.0-dev' }));

        prepareReleasePackages(root, '26.803.1200');

        const foundation = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
            version: string;
            dependencies: Record<string, string>;
        };
        const reflection = JSON.parse(readFileSync(join(root, 'packages', 'reflection', 'package.json'), 'utf8')) as { version: string };
        assert.equal(reflection.version, '26.803.1200');
        const utils = JSON.parse(readFileSync(join(root, 'packages', 'utils', 'package.json'), 'utf8')) as { version: string };
        assert.equal(utils.version, '26.803.1200');
        assert.equal(foundation.version, '26.803.1200');
        assert.equal(foundation.dependencies['@zyno-io/ts-utils'], '26.803.1200');
        assert.equal(foundation.dependencies['@zyno-io/ts-reflection'], '26.803.1200');
    });

    it('publishes only to npmjs, reflection and utils before foundation', () => {
        const gitlab = readFileSync(join(process.cwd(), '.gitlab-ci.yml'), 'utf8');
        const pipeline = parse(gitlab) as Record<string, unknown>;
        assert.equal(pipeline.deploy, undefined);
        assert.doesNotMatch(gitlab, /npm publish|PRIVATE_NPM/);

        const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'publish-npm.yml'), 'utf8');
        const reflectionPublish = '(cd packages/reflection && npm publish --registry https://registry.npmjs.org/ --access public)';
        const utilsPublish = '(cd packages/utils && npm publish --registry https://registry.npmjs.org/ --access public)';
        const foundationPublish = '\n          npm publish --registry https://registry.npmjs.org/ --access public';
        assert.ok(workflow.includes(reflectionPublish));
        assert.ok(workflow.includes(utilsPublish));
        assert.ok(workflow.indexOf(reflectionPublish) < workflow.indexOf(foundationPublish));
        assert.ok(workflow.indexOf(utilsPublish) < workflow.indexOf(foundationPublish));
        assert.match(workflow, /run: yarn build\n/);
    });
});
