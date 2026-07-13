import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCompactMetadataRegistryV1, decodeCompactMetadataV1, resolveCompactMetadataAliasV1 } from '../src/reflection/compact-metadata';

describe('compact metadata runtime', () => {
    it('revives runtime references without changing JSON metadata', () => {
        class Model {}
        const validator = (value: unknown) => typeof value === 'string';
        const metadata = decodeCompactMetadataV1<{
            kind: number;
            classType: () => typeof Model;
            validator: typeof validator;
            missing: undefined;
            nested: Array<{ value: string }>;
        }>('[1,{"kind":16,"classType":{"$tsf":0},"validator":{"$tsf":1},"missing":{"$tsf":2},"nested":[{"value":"ok"}]}]', [
            () => Model,
            validator,
            undefined
        ]);

        assert.equal(metadata.kind, 16);
        assert.strictEqual(metadata.classType(), Model);
        assert.strictEqual(metadata.validator, validator);
        assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'missing'), true);
        assert.equal(metadata.missing, undefined);
        assert.deepEqual(metadata.nested, [{ value: 'ok' }]);
    });

    it('preserves marker-shaped application data supplied through a slot', () => {
        const applicationValue = { $tsf: 7 };
        const decoded = decodeCompactMetadataV1<{ value: typeof applicationValue }>('[1,{"value":{"$tsf":0}}]', [applicationValue]);
        assert.strictEqual(decoded.value, applicationValue);
    });

    it('reconstructs imported class thunks and aliases from module-loader recipes', () => {
        class Model {}
        let loads = 0;
        const loadModule = () => {
            loads++;
            return {
                Model,
                __tsfTypeAliases: { Alias: { kind: 6, typeName: 'Original' } }
            };
        };
        const imported = decodeCompactMetadataV1<{ classType: () => typeof Model }>('[1,{"classType":{"$tsfImport":[0,"Model"]}}]', [loadModule]);
        assert.equal(loads, 0);
        assert.strictEqual(imported.classType(), Model);
        assert.equal(loads, 1);

        const alias = decodeCompactMetadataV1<Record<string, unknown>>('[1,{"$tsfAlias":[0,"Alias","RenamedAlias"]}]', [loadModule]);
        assert.deepEqual(alias, { kind: 6, typeName: 'RenamedAlias' });
        assert.equal(loads, 2);

        const required = decodeCompactMetadataV1<{ classType: () => typeof Model; alias: Record<string, unknown> }>(
            '[1,{"classType":{"$tsfImport":[0,"./model.js","Model"]},"alias":{"$tsfAlias":[0,"./model.js","Alias","RequiredAlias"]}}]',
            [
                (specifier: string) => {
                    assert.equal(specifier, './model.js');
                    return loadModule();
                }
            ]
        );
        assert.strictEqual(required.classType(), Model);
        assert.deepEqual(required.alias, { kind: 6, typeName: 'RequiredAlias' });
    });

    it('lazily resolves one compact per-module type registry, including cycles', () => {
        const resolveType = createCompactMetadataRegistryV1(
            '[1,[{"kind":6},{"kind":14,"element":{"$tsfType":0}},{"kind":14,"element":{"$tsfType":2}}]]',
            []
        );
        const primitive = resolveType(0);
        assert.strictEqual(resolveType(0), primitive);
        assert.strictEqual((resolveType(1) as { element: unknown }).element, primitive);
        const recursive = resolveType(2) as { element: unknown };
        assert.strictEqual(recursive.element, recursive);
        assert.throws(() => resolveType(3), /Invalid TSF compact metadata type 3/);
    });

    it('rejects incompatible payloads and invalid references', () => {
        assert.throws(() => decodeCompactMetadataV1('[2,{}]', []), /Unsupported TSF compact metadata format/);
        assert.throws(() => decodeCompactMetadataV1('[1,{"$tsf":1}]', [0]), /Invalid TSF compact metadata reference 1/);
        assert.throws(() => decodeCompactMetadataV1('[1,{"$tsfType":0}]', []), /Missing TSF compact metadata type registry/);
        assert.throws(() => decodeCompactMetadataV1('[1,{"$tsfImport":[0,"Model"]}]', [0]), /Invalid TSF compact metadata module loader 0/);
    });

    it('resolves published aliases and safely falls back for declaration-only modules', () => {
        const published = { kind: 6, typeName: 'Original' };
        const resolved = resolveCompactMetadataAliasV1(() => ({ __tsfTypeAliases: { Alias: published } }), 'Alias', 'RenamedAlias') as Record<
            string,
            unknown
        >;
        assert.deepEqual(resolved, { kind: 6, typeName: 'RenamedAlias' });
        assert.notStrictEqual(resolved, published);

        const missing = resolveCompactMetadataAliasV1(
            () => {
                throw new Error('module has no runtime entry');
            },
            'Alias',
            'Alias'
        ) as { kind: number; classType: () => unknown };
        assert.equal(missing.kind, 16);
        assert.equal(missing.classType(), undefined);
    });
});
