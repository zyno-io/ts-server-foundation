import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

function createFixture(): string {
    const directory = join(tmpdir(), `tsf-ast-transform-${process.pid}-${Date.now()}`);
    const packageDirectory = join(directory, 'node_modules', '@zyno-io', 'ts-server-foundation');
    const reflectionDirectory = join(packageDirectory, 'dist', 'src', 'reflection');
    const orderAliasDirectory = join(directory, 'node_modules', '@fixture', 'order-alias');
    mkdirSync(reflectionDirectory, { recursive: true });
    mkdirSync(orderAliasDirectory, { recursive: true });

    symlinkSync(join(process.cwd(), 'node_modules', 'typescript'), join(directory, 'node_modules', 'typescript'), 'dir');

    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(
        join(packageDirectory, 'package.json'),
        JSON.stringify({
            name: '@zyno-io/ts-server-foundation',
            type: 'module',
            exports: {
                '.': {
                    types: './index.d.ts',
                    import: './index.js',
                    require: './index.cjs'
                }
            }
        })
    );
    writeFileSync(join(packageDirectory, 'index.d.ts'), `export { typeOf } from './dist/src/reflection/reflection-class.js';\n`);
    writeFileSync(join(reflectionDirectory, 'reflection-class.d.ts'), `export declare function typeOf<T>(type?: unknown): T;\n`);
    writeFileSync(
        join(packageDirectory, 'index.js'),
        `export function typeOf(type) { if (!type) throw new Error('not transformed'); return type; }\n`
    );
    writeFileSync(
        join(packageDirectory, 'index.cjs'),
        `exports.typeOf = function typeOf(type) { if (!type) throw new Error('not transformed'); return type; };\n`
    );
    writeFileSync(
        join(orderAliasDirectory, 'package.json'),
        JSON.stringify({
            name: '@fixture/order-alias',
            exports: { '.': { types: './index.d.cts', require: './index.cjs' } }
        })
    );
    writeFileSync(join(orderAliasDirectory, 'index.d.cts'), `export type OrderAlias = { value: string };\n`);
    writeFileSync(
        join(orderAliasDirectory, 'index.cjs'),
        `(globalThis.__tsfOrder ??= []).push('metadata');
         exports.__tsfTypeAliases = {
             OrderAlias: { kind: 18, typeName: 'OrderAlias', types: [{ kind: 20, name: 'value', type: { kind: 6 }, optional: false }] }
         };\n`
    );

    writeFileSync(join(directory, 'dependency.mts'), `export class EsmDependency { value = 'esm'; }\n`);
    writeFileSync(join(directory, 'dependency.cts'), `export class CommonDependency { value = 'commonjs'; }\n`);
    writeFileSync(join(directory, 'ambient-dependency.mts'), `export class AmbientDependency { value = 'ambient'; }\n`);
    writeFileSync(
        join(directory, 'model.mts'),
        `
            import { typeOf } from '@zyno-io/ts-server-foundation';
            import type { EsmDependency } from './dependency.mjs';
            import type { AmbientDependency } from './ambient-dependency.mjs';
            declare class AmbientOnly { ignored: string; }
            declare namespace AmbientScope { class Nested { dependency: AmbientDependency; } }
            export declare const __tsfTypeAliases: Record<string, unknown>;
            export type RuntimeAlias = { active: boolean };
            export class EsmModel { dependency!: EsmDependency; }
            export const objectMetadata = typeOf<{ label: string }>();
        `
    );
    writeFileSync(
        join(directory, 'model.cts'),
        `
            import { typeOf } from '@zyno-io/ts-server-foundation';
            import type { CommonDependency } from './dependency.cjs';
            import type { OrderAlias } from '@fixture/order-alias';
            const evaluationOrder = ((globalThis as typeof globalThis & { __tsfOrder?: string[] }).__tsfOrder ??= []);
            let decoratorMetadata: unknown;
            function createBase() { evaluationOrder.push('base'); return class {}; }
            function replaceClass<T extends new (...args: any[]) => any>(target: T): T {
                decoratorMetadata = (target as T & { __tsfType: unknown }).__tsfType;
                return class extends target {};
            }
            @replaceClass
            export class CommonModel extends createBase() { dependency!: CommonDependency; alias!: OrderAlias; }
            export { decoratorMetadata, evaluationOrder };
            export const objectMetadata = typeOf<{ count: number }>();
        `
    );
    writeFileSync(
        join(directory, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2019',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    outDir: './dist',
                    declaration: true,
                    declarationMap: true,
                    sourceMap: true,
                    strict: true,
                    experimentalDecorators: true,
                    plugins: [{ transform: join(process.cwd(), 'src', 'type-compiler', 'index.cjs') }]
                },
                include: ['./*.mts', './*.cts'],
                reflection: true
            },
            null,
            4
        )
    );
    return directory;
}

describe('AST metadata compiler integration', () => {
    it('emits executable NodeNext ESM and CommonJS with declarations and source maps', async () => {
        const directory = createFixture();
        delete (globalThis as typeof globalThis & { __tsfOrder?: string[] }).__tsfOrder;
        try {
            const executable = join(process.cwd(), 'node_modules', '.bin', 'ttsc');
            const result = spawnSync(executable, ['-p', 'tsconfig.json'], {
                cwd: directory,
                encoding: 'utf8',
                env: { ...process.env, NO_COLOR: '1' }
            });
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

            const esmOutputPath = join(directory, 'dist', 'model.mjs');
            const commonOutputPath = join(directory, 'dist', 'model.cjs');
            const esmOutput = readFileSync(esmOutputPath, 'utf8');
            const commonOutput = readFileSync(commonOutputPath, 'utf8');

            assert.doesNotMatch(esmOutput, /__tsf_runtime_|\brequire\s*\(/);
            assert.match(esmOutput, /from "\.\/dependency\.mjs"/);
            assert.doesNotMatch(esmOutput, /ambient-dependency\.mjs/);
            assert.doesNotMatch(esmOutput, /AmbientOnly\.__tsfType/);
            assert.doesNotMatch(commonOutput, /__tsf_runtime_/);
            assert.match(commonOutput, /typeof require !== "undefined" \? require\("\.\/dependency\.cjs"\)/);

            for (const path of ['model.mjs.map', 'model.cjs.map', 'model.d.mts', 'model.d.mts.map', 'model.d.cts', 'model.d.cts.map']) {
                assert.equal(existsSync(join(directory, 'dist', path)), true, `${path} was not emitted`);
            }
            assert.doesNotMatch(readFileSync(join(directory, 'dist', 'model.d.mts'), 'utf8'), /\b__tsfType\b/);
            JSON.parse(readFileSync(join(directory, 'dist', 'model.mjs.map'), 'utf8'));
            JSON.parse(readFileSync(join(directory, 'dist', 'model.cjs.map'), 'utf8'));

            const importModule = Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, any>>;
            const esm = await importModule(`${pathToFileURL(esmOutputPath).href}?test=${Date.now()}`);
            const common = await importModule(`${pathToFileURL(commonOutputPath).href}?test=${Date.now()}`);
            assert.equal(esm.objectMetadata.types[0].name, 'label');
            assert.equal(esm.EsmModel.__tsfType.properties[0].name, 'dependency');
            assert.equal(esm.__tsfTypeAliases.RuntimeAlias.types[0].name, 'active');
            assert.equal(common.objectMetadata.types[0].name, 'count');
            assert.equal(common.CommonModel.__tsfType.properties[0].name, 'dependency');
            assert.strictEqual(common.CommonModel.__tsfType, common.decoratorMetadata);
            assert.deepStrictEqual(common.evaluationOrder, ['base', 'metadata']);
        } finally {
            delete (globalThis as typeof globalThis & { __tsfOrder?: string[] }).__tsfOrder;
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
