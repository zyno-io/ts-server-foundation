import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { ReflectionKind, typeOf } from '@zyno-io/ts-reflection';

const requireFromTest = createRequire(__filename);

describe('@zyno-io/ts-reflection', () => {
    it('publishes a narrow, dual-module reflection surface', () => {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'reflection', 'package.json'), 'utf8')) as {
            exports: Record<string, string | { types: string; import: string; require: string }>;
        };

        assert.deepStrictEqual(Object.keys(pkg.exports), ['.', './type-metadata-runtime', './type-compiler']);
        assert.deepStrictEqual(pkg.exports['.'], {
            types: './dist/index.d.ts',
            import: './dist/index.js',
            require: './dist/index.cjs'
        });
        assert.deepStrictEqual(pkg.exports['./type-metadata-runtime'], {
            types: './dist/type-metadata-runtime.d.ts',
            import: './dist/type-metadata-runtime.js',
            require: './dist/type-metadata-runtime.cjs'
        });
        assert.equal(pkg.exports['./type-compiler'], './dist/type-compiler/index.cjs');
    });

    it('loads as CommonJS and ESM without server dependencies', async () => {
        const common = requireFromTest('@zyno-io/ts-reflection');
        const esm = await import('@zyno-io/ts-reflection');
        const typeCompiler = requireFromTest('@zyno-io/ts-reflection/type-compiler');

        for (const runtime of [common, esm]) {
            assert.equal(typeof runtime.typeOf, 'function');
            assert.equal(typeof runtime.validate, 'function');
            assert.equal(typeof runtime.deserialize, 'function');
            assert.equal(typeof runtime.ReflectionKind, 'object');
        }

        const source = [
            readFileSync(join(process.cwd(), 'packages', 'reflection', 'dist', 'index.js'), 'utf8'),
            readFileSync(join(process.cwd(), 'packages', 'reflection', 'dist', 'index.cjs'), 'utf8')
        ].join('\n');
        assert.doesNotMatch(source, /node:/);
        assert.doesNotMatch(source, /ts-server-foundation|ioredis|mysql2|@opentelemetry/);
        assert.equal(typeof typeCompiler, 'function');
    });

    it('receives compiler metadata when imported from the reflection package', () => {
        const type = typeOf<{ label: string }>();

        assert.equal(type.kind, ReflectionKind.objectLiteral);
        if (type.kind !== ReflectionKind.objectLiteral) return;
        assert.equal(type.types[0]?.name, 'label');
        assert.equal(type.types[0]?.type.kind, ReflectionKind.string);
    });

    it('type-checks from a NodeNext consumer', () => {
        const directory = mkdtempSync(join(process.cwd(), '.tmp-reflection-api-'));
        const fixture = join(directory, 'imports.mts');
        writeFileSync(
            fixture,
            `
                import { ReflectionKind, typeOf, type Type } from '@zyno-io/ts-reflection';

                const reflected: Type = typeOf<{ id: string }>();
                void [ReflectionKind, reflected];
            `,
            'utf8'
        );

        try {
            const typescript = requireFromTest.resolve('typescript');
            execFileSync(
                process.execPath,
                [
                    join(dirname(typescript), 'tsc.js'),
                    '--ignoreConfig',
                    '--noEmit',
                    '--strict',
                    '--skipLibCheck',
                    '--target',
                    'ES2022',
                    '--module',
                    'NodeNext',
                    '--moduleResolution',
                    'NodeNext',
                    fixture
                ],
                { cwd: process.cwd(), stdio: 'pipe' }
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('shares its runtime singleton exports with foundation compatibility imports', () => {
        const reflection = requireFromTest('@zyno-io/ts-reflection');
        const foundation = requireFromTest('@zyno-io/ts-server-foundation');

        assert.strictEqual(foundation.ReflectionKind, reflection.ReflectionKind);
        assert.strictEqual(foundation.deserializer, reflection.deserializer);
        assert.strictEqual(foundation.validationRegistry, reflection.validationRegistry);
        assert.strictEqual(foundation.validate, reflection.validate);
    });
});
