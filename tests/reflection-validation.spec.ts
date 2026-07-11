import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReflectionKind, registerClassMetadata, validate, type ClassMetadata, type Type, type TypePropertySignature } from '../src';

function property(name: string, type: Type, optional = false): TypePropertySignature {
    return { kind: ReflectionKind.propertySignature, name, type, optional };
}

const stringType: Type = { kind: ReflectionKind.string };
const numberType: Type = { kind: ReflectionKind.number };
const booleanType: Type = { kind: ReflectionKind.boolean };

class ReflectionValidationProfile {}

registerClassMetadata(ReflectionValidationProfile, {
    kind: ReflectionKind.class,
    classType: ReflectionValidationProfile,
    name: 'ReflectionValidationProfile',
    typeName: 'ReflectionValidationProfile',
    properties: [
        { name: 'id', type: numberType, primaryKey: true },
        { name: 'email', type: stringType },
        { name: 'enabled', type: { kind: ReflectionKind.union, types: [booleanType, { kind: ReflectionKind.undefined }] }, optional: true }
    ],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

describe('reflection validation', () => {
    it('validates structured object literals with paths and index signatures', () => {
        const type: Type = {
            kind: ReflectionKind.objectLiteral,
            types: [
                property('name', stringType),
                property('count', numberType),
                property('nickname', { kind: ReflectionKind.union, types: [stringType, { kind: ReflectionKind.undefined }] }, true)
            ],
            index: booleanType
        };

        assert.deepStrictEqual(validate({ name: 'Ada', count: 2, nickname: undefined, active: true }, type), []);
        assert.deepStrictEqual(
            validate({ name: 42, active: 'yes' }, type).map(error => [error.code, error.path, error.message]),
            [
                ['type', 'name', 'The value must be a string.'],
                ['required', 'count', 'The value is required.'],
                ['type', 'active', 'The value must be a boolean.']
            ]
        );
    });

    it('validates arrays, tuples, literals, enums, and unions', () => {
        const type: Type = {
            kind: ReflectionKind.objectLiteral,
            types: [
                property('items', { kind: ReflectionKind.array, type: numberType }),
                property('pair', {
                    kind: ReflectionKind.tuple,
                    types: [
                        { ...stringType, type: stringType },
                        { ...numberType, type: numberType }
                    ]
                }),
                property('status', { kind: ReflectionKind.literal, literal: 'ready' }),
                property('role', { kind: ReflectionKind.enum, values: ['admin', 'user'] }),
                property('nullable', { kind: ReflectionKind.union, types: [stringType, { kind: ReflectionKind.null }] })
            ]
        };

        assert.deepStrictEqual(validate({ items: [1, 2], pair: ['a', 1], status: 'ready', role: 'admin', nullable: null }, type), []);
        assert.deepStrictEqual(
            validate({ items: [1, 'bad'], pair: [2], status: 'done', role: 'guest', nullable: 12 }, type).map(error => [error.code, error.path]),
            [
                ['type', 'items.1'],
                ['type', 'pair.0'],
                ['required', 'pair.1'],
                ['type', 'status'],
                ['type', 'role'],
                ['type', 'nullable']
            ]
        );
    });

    it('validates classes registered through runtime metadata', () => {
        assert.deepStrictEqual(validate({ id: 1, email: 'a@example.com' }, ReflectionValidationProfile), []);
        assert.deepStrictEqual(
            validate({ id: '1', enabled: 'yes' }, ReflectionValidationProfile).map(error => [error.code, error.path]),
            [
                ['type', 'id'],
                ['required', 'email'],
                ['type', 'enabled']
            ]
        );
    });
});
