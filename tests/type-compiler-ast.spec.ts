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
                },
                './type-metadata-runtime': {
                    types: './compact-metadata.d.ts',
                    import: './compact-metadata.js',
                    require: './compact-metadata.cjs'
                }
            }
        })
    );
    writeFileSync(
        join(packageDirectory, 'index.d.ts'),
        `export { typeOf } from './dist/src/reflection/reflection-class.js';
         export type ReceiveType<T = any> = { kind: number; readonly __receiveType?: T };
         export declare class BaseDatabase {
             rawFindUnsafe<T = Record<string, unknown>>(text: string, bindings?: unknown[], session?: unknown, type?: ReceiveType<T>): T[];
         }
         export declare class DatabaseSession {
             rawFindUnsafe<T = Record<string, unknown>>(text: string, bindings?: unknown[], type?: ReceiveType<T>): T[];
         }
         export declare function createMySQLDatabase(): new () => BaseDatabase;
        `
    );
    writeFileSync(join(reflectionDirectory, 'reflection-class.d.ts'), `export declare function typeOf<T>(type?: unknown): T;\n`);
    writeFileSync(
        join(packageDirectory, 'index.js'),
        `export function typeOf(type) { if (!type) throw new Error('not transformed'); return type; }
         export class BaseDatabase { rawFindUnsafe(...args) { return args; } }
         export class DatabaseSession { rawFindUnsafe(...args) { return args; } }
         export function createMySQLDatabase() { return class extends BaseDatabase {}; }
        `
    );
    writeFileSync(
        join(packageDirectory, 'index.cjs'),
        `exports.typeOf = function typeOf(type) { if (!type) throw new Error('not transformed'); return type; };
         class BaseDatabase { rawFindUnsafe(...args) { return args; } }
         class DatabaseSession { rawFindUnsafe(...args) { return args; } }
         exports.BaseDatabase = BaseDatabase;
         exports.DatabaseSession = DatabaseSession;
         exports.createMySQLDatabase = function createMySQLDatabase() { return class extends BaseDatabase {}; };
        `
    );
    writeFileSync(
        join(packageDirectory, 'compact-metadata.d.ts'),
        `export declare function decodeCompactMetadataV1<T>(serialized: string, references: readonly unknown[], resolveType?: (index: number) => unknown): T;
         export declare function createCompactMetadataRegistryV1(serialized: string, references: readonly unknown[]): (index: number) => unknown;
         export declare function resolveCompactMetadataAliasV1(loadModule: () => unknown, exportName: string, typeName: string): unknown;\n`
    );
    const compactRuntime = `
        function moduleLoader(references, index, specifier) {
            const reference = references[index];
            if (specifier === undefined) return reference;
            return () => { try { return reference(specifier); } catch { return undefined; } };
        }
        function revive(value, references, resolveType) {
            if (!value || typeof value !== 'object') return value;
            const keys = Array.isArray(value) ? [] : Object.keys(value);
            if (keys.length === 1 && keys[0] === '$tsf') return references[value.$tsf];
            if (keys.length === 1 && keys[0] === '$tsfImport') {
                const recipe = value.$tsfImport;
                const loader = moduleLoader(references, recipe[0], recipe.length === 3 ? recipe[1] : undefined);
                const exportName = recipe.length === 3 ? recipe[2] : recipe[1];
                return () => { const imported = loader(); return imported && imported[exportName]; };
            }
            if (keys.length === 1 && keys[0] === '$tsfAlias') {
                const recipe = value.$tsfAlias;
                const loader = moduleLoader(references, recipe[0], recipe.length === 4 ? recipe[1] : undefined);
                return resolveAlias(loader, recipe.length === 4 ? recipe[2] : recipe[1], recipe.length === 4 ? recipe[3] : recipe[2]);
            }
            if (keys.length === 1 && keys[0] === '$tsfType') return resolveType(value.$tsfType);
            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) value[index] = revive(value[index], references, resolveType);
            } else {
                for (const key of keys) value[key] = revive(value[key], references, resolveType);
            }
            return value;
        }
        function parse(serialized) {
            const envelope = JSON.parse(serialized);
            if (!Array.isArray(envelope) || envelope[0] !== 1) throw new Error('invalid compact metadata');
            return envelope[1];
        }
        function decode(serialized, references, resolveType) {
            return revive(parse(serialized), references, resolveType);
        }
        function createRegistry(serialized, references) {
            const encoded = parse(serialized);
            const resolved = new Array(encoded.length);
            const initialized = new Uint8Array(encoded.length);
            const resolveType = index => {
                if (!initialized[index]) {
                    initialized[index] = 1;
                    resolved[index] = encoded[index];
                    resolved[index] = revive(encoded[index], references, resolveType);
                }
                return resolved[index];
            };
            return resolveType;
        }
        function resolveAlias(loadModule, exportName, typeName) {
            let imported;
            try { imported = loadModule(); } catch {}
            const alias = imported && imported.__tsfTypeAliases && imported.__tsfTypeAliases[exportName];
            return alias
                ? Object.assign({}, alias, { typeName })
                : { kind: 16, typeName, classType: () => imported && imported[exportName] };
        }
    `;
    writeFileSync(
        join(packageDirectory, 'compact-metadata.js'),
        `${compactRuntime}\nexport { createRegistry as createCompactMetadataRegistryV1, decode as decodeCompactMetadataV1, resolveAlias as resolveCompactMetadataAliasV1 };\n`
    );
    writeFileSync(
        join(packageDirectory, 'compact-metadata.cjs'),
        `${compactRuntime}\nexports.createCompactMetadataRegistryV1 = createRegistry; exports.decodeCompactMetadataV1 = decode; exports.resolveCompactMetadataAliasV1 = resolveAlias;\n`
    );
    writeFileSync(
        join(orderAliasDirectory, 'package.json'),
        JSON.stringify({
            name: '@fixture/order-alias',
            exports: { '.': { types: './index.d.cts', require: './index.cjs' } }
        })
    );
    writeFileSync(
        join(orderAliasDirectory, 'index.d.cts'),
        `export type OrderAlias = { value: string };
         export type DistributionAlias = { id: string } & ({ a: string; b?: never } | { b: string; a?: never });\n`
    );
    writeFileSync(
        join(orderAliasDirectory, 'index.cjs'),
        `(globalThis.__tsfOrder ??= []).push('metadata');
         exports.__tsfTypeAliases = {
             OrderAlias: { kind: 18, typeName: 'OrderAlias', types: [{ kind: 20, name: 'value', type: { kind: 6 }, optional: false }] },
             DistributionAlias: {
                 kind: 13,
                 typeName: 'DistributionAlias',
                 types: [
                     { kind: 18, types: [{ kind: 20, name: 'id', type: { kind: 6 }, optional: false }] },
                     { kind: 12, types: [
                         { kind: 18, types: [
                             { kind: 20, name: 'a', type: { kind: 6 }, optional: false },
                             { kind: 20, name: 'b', type: { kind: 0 }, optional: true }
                         ] },
                         { kind: 18, types: [
                             { kind: 20, name: 'b', type: { kind: 6 }, optional: false },
                             { kind: 20, name: 'a', type: { kind: 0 }, optional: true }
                         ] }
                     ] }
                 ]
             }
         };\n`
    );

    writeFileSync(join(directory, 'dependency.mts'), `export class EsmDependency { value = 'esm'; }\n`);
    writeFileSync(join(directory, 'dependency.cts'), `export class CommonDependency { value = 'commonjs'; }\n`);
    writeFileSync(join(directory, 'ambient-dependency.mts'), `export class AmbientDependency { value = 'ambient'; }\n`);
    writeFileSync(
        join(directory, 'model.mts'),
        `
            import { createMySQLDatabase, DatabaseSession, typeOf } from '@zyno-io/ts-server-foundation';
            import type { EsmDependency } from './dependency.mjs';
            import type { AmbientDependency } from './ambient-dependency.mjs';
            declare class AmbientOnly { ignored: string; }
            declare namespace AmbientScope { class Nested { dependency: AmbientDependency; } }
            export declare const __tsfTypeAliases: Record<string, unknown>;
            export type RuntimeAlias = { active: boolean };
            export class EsmModel { dependency!: EsmDependency; }
            export const objectMetadata = typeOf<{ label: string }>();
            type ContactRows = ({ id: string; hasAlerts: boolean; marketingOptOut: boolean | null; tagIds: string[] })[];
            class Db extends createMySQLDatabase() {}
            export function receiveTypeArguments() {
                const db = new Db();
                const session = new DatabaseSession();
                return {
                    database: db.rawFindUnsafe<Omit<ContactRows[number], 'tagIds'>>('SELECT contacts', []),
                    session: session.rawFindUnsafe<{ enabled: boolean }>('SELECT session', []),
                    untyped: db.rawFindUnsafe('SELECT raw', [])
                };
            }
            export function createNestedMetadata() {
                class NestedDependency {}
                class NestedModel { constructor(public dependency: NestedDependency) {} }
                return { NestedDependency, NestedModel, received: typeOf<NestedDependency>() };
            }
        `
    );
    writeFileSync(
        join(directory, 'model.cts'),
        `
            import { createMySQLDatabase, DatabaseSession, typeOf } from '@zyno-io/ts-server-foundation';
            import type { CommonDependency } from './dependency.cjs';
            import type { DistributionAlias, OrderAlias } from '@fixture/order-alias';
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
            export const importedDistributionMetadata = typeOf<Record<string, DistributionAlias>>();
            type ContactRows = ({ id: string; hasAlerts: boolean; marketingOptOut: boolean | null; tagIds: string[] })[];
            class Db extends createMySQLDatabase() {}
            export function receiveTypeArguments() {
                const db = new Db();
                const session = new DatabaseSession();
                return {
                    database: db.rawFindUnsafe<Omit<ContactRows[number], 'tagIds'>>('SELECT contacts', []),
                    session: session.rawFindUnsafe<{ enabled: boolean }>('SELECT session', []),
                    untyped: db.rawFindUnsafe('SELECT raw', [])
                };
            }
            export function createNestedMetadata() {
                class NestedDependency {}
                class NestedModel { constructor(public dependency: NestedDependency) {} }
                return { NestedDependency, NestedModel, received: typeOf<NestedDependency>() };
            }
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
            assert.doesNotMatch(esmOutput, /__tsf_metadata_runtime_/);
            assert.doesNotMatch(esmOutput, /\beval\s*\(/);
            assert.match(esmOutput, /type-metadata-runtime/);
            assert.match(esmOutput, /from "\.\/dependency\.mjs"/);
            assert.doesNotMatch(esmOutput, /ambient-dependency\.mjs/);
            assert.doesNotMatch(esmOutput, /AmbientOnly\.__tsfType/);
            assert.doesNotMatch(commonOutput, /__tsf_runtime_/);
            assert.doesNotMatch(commonOutput, /__tsf_metadata_runtime_/);
            assert.doesNotMatch(commonOutput, /\beval\s*\(/);
            assert.match(commonOutput, /type-metadata-runtime/);
            assert.match(commonOutput, /\\"\$tsfImport\\":\[\d+,\\"\.\/dependency\.cjs\\"/);

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
            assert.equal(common.importedDistributionMetadata.index.kind, 13);
            assert.equal(common.importedDistributionMetadata.index.types[1].kind, 12);
            assert.deepStrictEqual(
                common.importedDistributionMetadata.index.types[1].types.map((type: { kind: number }) => type.kind),
                [18, 18]
            );
            assert.equal(common.CommonModel.__tsfType.properties[0].name, 'dependency');
            assert.strictEqual(common.CommonModel.__tsfType, common.decoratorMetadata);
            assert.deepStrictEqual(common.evaluationOrder, ['base', 'metadata']);
            for (const compiled of [esm, common]) {
                const received = compiled.receiveTypeArguments();
                assert.equal(received.database.length, 4);
                assert.equal(received.database[2], undefined);
                assert.deepStrictEqual(
                    received.database[3].types.map((property: { name: string }) => property.name),
                    ['id', 'hasAlerts', 'marketingOptOut']
                );
                assert.equal(received.database[3].types[1].type.kind, 8);
                assert.deepStrictEqual(
                    received.database[3].types[2].type.types.map((type: { kind: number }) => type.kind),
                    [8, 5]
                );
                assert.equal(received.session.length, 3);
                assert.equal(received.session[2].types[0].name, 'enabled');
                assert.equal(received.session[2].types[0].type.kind, 8);
                assert.equal(received.untyped.length, 2);
                const nested = compiled.createNestedMetadata();
                const constructorType = nested.NestedModel.__tsfType.constructorParameters[0].type;
                assert.strictEqual(constructorType.classType(), nested.NestedDependency);
                assert.strictEqual(nested.received.classType(), nested.NestedDependency);
            }
        } finally {
            delete (globalThis as typeof globalThis & { __tsfOrder?: string[] }).__tsfOrder;
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
