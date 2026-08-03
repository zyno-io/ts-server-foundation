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
    it('versions reflection before publishing foundation with a concrete dependency', () => {
        const root = mkdtempSync(join(tmpdir(), 'tsf-release-packages-'));
        directories.push(root);
        mkdirSync(join(root, 'packages', 'reflection'), { recursive: true });
        writeFileSync(
            join(root, 'package.json'),
            JSON.stringify({
                name: '@zyno-io/ts-server-foundation',
                version: '0.0.0-dev',
                dependencies: { '@zyno-io/ts-reflection': 'workspace:*' }
            })
        );
        writeFileSync(join(root, 'packages', 'reflection', 'package.json'), JSON.stringify({ name: '@zyno-io/ts-reflection', version: '0.0.0-dev' }));

        prepareReleasePackages(root, '26.803.1200');

        const foundation = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
            version: string;
            dependencies: Record<string, string>;
        };
        const reflection = JSON.parse(readFileSync(join(root, 'packages', 'reflection', 'package.json'), 'utf8')) as { version: string };
        assert.equal(reflection.version, '26.803.1200');
        assert.equal(foundation.version, '26.803.1200');
        assert.equal(foundation.dependencies['@zyno-io/ts-reflection'], '26.803.1200');
    });

    it('retains reflection artifacts and publishes reflection ahead of foundation', () => {
        const pipeline = parse(readFileSync(join(process.cwd(), '.gitlab-ci.yml'), 'utf8')) as {
            'test-and-build': { script: string[]; artifacts: { paths: string[] } };
            deploy: { script: string[] };
        };

        assert.match(pipeline['test-and-build'].script.join('\n'), /node scripts\/prepare-release-packages\.cjs/);
        assert.deepStrictEqual(
            pipeline['test-and-build'].artifacts.paths.filter(path => path.startsWith('packages/reflection/')),
            ['packages/reflection/dist/', 'packages/reflection/package.json']
        );
        const privateReflectionPublish = '(cd packages/reflection && npm publish --registry https://${PRIVATE_NPM_HOST}/)';
        const privateFoundationPublish = 'npm publish --registry https://${PRIVATE_NPM_HOST}/';
        const deployScript = pipeline.deploy.script.join('\n');
        assert.ok(deployScript.indexOf(privateReflectionPublish) < deployScript.indexOf(privateFoundationPublish));
    });
});
