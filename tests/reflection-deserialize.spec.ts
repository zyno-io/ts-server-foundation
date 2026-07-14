import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    assert as reflectedAssert,
    cast,
    deserialize,
    is as reflectedIs,
    ReflectionKind,
    registerClassMetadata,
    validate,
    validatedDeserialize,
    ValidatorError,
    type ClassMetadata,
    type Type
} from '../src';

const stringType: Type = { kind: ReflectionKind.string };
const numberType: Type = { kind: ReflectionKind.number };
const booleanType: Type = { kind: ReflectionKind.boolean };

class ReflectionDeserializeChild {
    amount!: number;
    enabled!: boolean;
}

class ReflectionDeserializeParent {
    child!: ReflectionDeserializeChild;
    tags!: string[];
}

registerClassMetadata(ReflectionDeserializeChild, {
    kind: ReflectionKind.class,
    classType: ReflectionDeserializeChild,
    name: 'ReflectionDeserializeChild',
    typeName: 'ReflectionDeserializeChild',
    properties: [
        { name: 'amount', type: numberType },
        { name: 'enabled', type: booleanType }
    ],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

registerClassMetadata(ReflectionDeserializeParent, {
    kind: ReflectionKind.class,
    classType: ReflectionDeserializeParent,
    name: 'ReflectionDeserializeParent',
    typeName: 'ReflectionDeserializeParent',
    properties: [
        { name: 'child', type: { kind: ReflectionKind.class, classType: ReflectionDeserializeChild, typeName: 'ReflectionDeserializeChild' } },
        { name: 'tags', type: { kind: ReflectionKind.array, type: stringType } }
    ],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

describe('reflection deserialization', () => {
    it('injects metadata for generic compatibility helpers imported from the foundation', () => {
        assert.equal(cast<number>('42'), 42);
        reflectedAssert<number>(42);
        assert.throws(() => reflectedAssert<number>('42'), ValidatorError);
        assert.equal(reflectedIs<number>(42), true);
        assert.equal(reflectedIs<number>('42'), false);
    });

    it('fails closed when compatibility helpers are called without generic or explicit metadata', () => {
        assert.throws(() => cast('42'), /cast<T>\(\) requires explicit reflected type metadata/);
        assert.throws(() => reflectedAssert(42), /assert<T>\(\) requires explicit reflected type metadata/);
        assert.throws(() => reflectedIs(42), /is<T>\(\) requires explicit reflected type metadata/);
    });

    it('casts, asserts, and checks values when explicit metadata is supplied', () => {
        assert.equal(cast<number>('42', undefined, undefined, undefined, numberType), 42);

        reflectedAssert<number>(42, undefined, numberType);
        assert.throws(() => reflectedAssert<number>('42', undefined, numberType), ValidatorError);

        assert.equal(reflectedIs<number>(42, undefined, numberType), true);
        assert.equal(reflectedIs<number>('42', undefined, numberType), false);
    });

    it('coerces primitives, tuples, enums, and dates from reflected type metadata', () => {
        assert.equal(deserialize('42', numberType), 42);
        assert.equal(deserialize('true', booleanType), true);
        assert.equal(deserialize(1, booleanType), true);
        assert.equal(deserialize(0, booleanType), false);
        assert.equal(deserialize(2, booleanType), true);
        assert.equal(deserialize(1n, booleanType), true);
        assert.equal(deserialize(0n, booleanType), false);
        assert.equal(deserialize('2', { kind: ReflectionKind.enum, values: [1, 2, 3] }), 2);
        assert.deepStrictEqual(
            deserialize(['1', 'false'], {
                kind: ReflectionKind.tuple,
                types: [
                    { ...numberType, type: numberType },
                    { ...booleanType, type: booleanType }
                ]
            }),
            [1, false]
        );

        const date = deserialize('2024-01-02T03:04:05.000Z', { kind: ReflectionKind.class, typeName: 'Date', classType: Date });
        assert.equal(date instanceof Date, true);
        assert.equal((date as Date).toISOString(), '2024-01-02T03:04:05.000Z');
    });

    it('selects the first valid union branch after deserialization', () => {
        const numericType: Type = { kind: ReflectionKind.union, types: [numberType, stringType] };
        const fallbackType: Type = { kind: ReflectionKind.union, types: [booleanType, stringType] };
        const nullableBooleanType: Type = { kind: ReflectionKind.union, types: [booleanType, { kind: ReflectionKind.null }] };

        assert.equal(deserialize('42', numericType), 42);
        assert.equal(deserialize('abc', fallbackType), 'abc');
        assert.equal(deserialize(1, nullableBooleanType), true);
        assert.equal(deserialize(0, nullableBooleanType), false);
        assert.equal(deserialize(null, nullableBooleanType), null);
    });

    it('creates class instances and recursively deserializes properties', () => {
        const result = deserialize(
            {
                child: { amount: '12.5', enabled: 1 },
                tags: [1, 'ready']
            },
            { kind: ReflectionKind.class, classType: ReflectionDeserializeParent, typeName: 'ReflectionDeserializeParent' }
        );

        assert.equal(result instanceof ReflectionDeserializeParent, true);
        assert.equal((result as ReflectionDeserializeParent).child instanceof ReflectionDeserializeChild, true);
        assert.deepStrictEqual(
            result,
            Object.assign(new ReflectionDeserializeParent(), {
                child: Object.assign(new ReflectionDeserializeChild(), { amount: 12.5, enabled: true }),
                tags: [1, 'ready']
            })
        );
    });

    it('preserves class and object-literal fields when deserializing intersections', () => {
        const result = deserialize(
            { amount: '12.5', enabled: 1, label: 'joined' },
            {
                kind: ReflectionKind.intersection,
                types: [
                    { kind: ReflectionKind.class, classType: ReflectionDeserializeChild, typeName: 'ReflectionDeserializeChild' },
                    {
                        kind: ReflectionKind.objectLiteral,
                        types: [{ kind: ReflectionKind.propertySignature, name: 'label', type: stringType }]
                    }
                ]
            }
        );

        assert.deepStrictEqual(result, { amount: 12.5, enabled: true, label: 'joined' });
    });

    it('throws the first validation error from validatedDeserialize', () => {
        assert.throws(
            () =>
                validatedDeserialize({ child: { amount: [], enabled: 'true' }, tags: [] }, undefined, undefined, undefined, {
                    kind: ReflectionKind.class,
                    classType: ReflectionDeserializeParent,
                    typeName: 'ReflectionDeserializeParent'
                }),
            /The value must be a number/
        );
    });

    it('rejects NaN as an invalid number', () => {
        assert.equal(validate(Number.NaN, numberType)[0]?.code, 'type');
        assert.throws(() => validatedDeserialize('not-a-number', undefined, undefined, undefined, numberType), /The value must be a number/);
    });
});
