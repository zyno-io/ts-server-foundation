import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    deserialize,
    deserializer,
    entity,
    ReflectionClass,
    ReflectionKind,
    registerClassMetadata,
    typeAnnotation,
    typeOf,
    validate,
    validationRegistry,
    ValidatorError,
    type ClassMetadata,
    type TsfTypiaTag,
    type Type,
    type Validate
} from '../src';

const numberType: Type = { kind: ReflectionKind.number };
const stringType: Type = { kind: ReflectionKind.string };

class ReflectionMetadataBase {}
class ReflectionMetadataOrg {}
class ReflectionMetadataUser extends ReflectionMetadataBase {}

let decoratorObservedProperties: string[] = [];
let decoratorMutatedMetadata: ClassMetadata | undefined;
let decoratorReplacementSource: (Function & { __tsfType: ClassMetadata }) | undefined;

function observeReflectedClass<T extends new (...args: any[]) => any>(target: T): T {
    decoratorObservedProperties = ReflectionClass.from(target)
        .getProperties()
        .map(property => property.getNameAsString());
    return target;
}

function replaceReflectedClass<T extends new (...args: any[]) => any>(target: T): T {
    decoratorReplacementSource = target as T & { __tsfType: ClassMetadata };
    return class extends target {};
}

function mutateReflectedClass<T extends new (...args: any[]) => any>(target: T): T {
    const metadata = (target as T & { __tsfType: ClassMetadata }).__tsfType;
    metadata.typeName = 'DecoratorMutatedModel:decorated';
    decoratorMutatedMetadata = metadata;
    ReflectionClass.from(target);
    return target;
}

@observeReflectedClass
class DecoratorObservedModel {
    id!: number;
}

@replaceReflectedClass
class DecoratorReplacedModel {
    value!: string;
}

@mutateReflectedClass
class DecoratorMutatedModel {
    enabled!: boolean;
}

registerClassMetadata(ReflectionMetadataBase, {
    kind: ReflectionKind.class,
    classType: ReflectionMetadataBase,
    name: 'ReflectionMetadataBase',
    typeName: 'ReflectionMetadataBase',
    properties: [{ name: 'id', type: numberType, primaryKey: true, autoIncrement: true }],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

registerClassMetadata(ReflectionMetadataOrg, {
    kind: ReflectionKind.class,
    classType: ReflectionMetadataOrg,
    name: 'ReflectionMetadataOrg',
    typeName: 'ReflectionMetadataOrg',
    properties: [{ name: 'id', type: stringType, primaryKey: true }],
    methods: [],
    constructorParameters: [],
    hasConstructor: false
} satisfies ClassMetadata);

entity.name('reflection_metadata_users').index(['email'], { unique: false }).excludeMigration()(ReflectionMetadataUser);

registerClassMetadata(ReflectionMetadataUser, {
    kind: ReflectionKind.class,
    classType: ReflectionMetadataUser,
    name: 'ReflectionMetadataUser',
    typeName: 'ReflectionMetadataUser',
    properties: [
        { name: 'email', type: stringType, index: { name: 'users_email_idx' }, unique: { name: 'users_email_unique' } },
        {
            name: 'org',
            type: { kind: ReflectionKind.class, classType: ReflectionMetadataOrg, typeName: 'ReflectionMetadataOrg' },
            reference: { onDelete: 'CASCADE' }
        }
    ],
    methods: [
        {
            name: 'setEmail',
            parameters: [{ name: 'value', type: stringType }],
            returnType: { kind: ReflectionKind.void }
        }
    ],
    constructorParameters: [{ name: 'email', type: stringType, default: true }],
    hasConstructor: true
} satisfies ClassMetadata);

describe('reflection metadata wrappers', () => {
    it('makes metadata visible during decoration and after constructor replacement', () => {
        const emitted = (DecoratorReplacedModel as typeof DecoratorReplacedModel & { __tsfType: ClassMetadata }).__tsfType;

        assert.deepStrictEqual(decoratorObservedProperties, ['id']);
        assert.strictEqual(emitted, decoratorReplacementSource?.__tsfType);
        assert.strictEqual(emitted.classType, DecoratorReplacedModel);
        assert.equal(ReflectionClass.from(DecoratorReplacedModel).getProperty('value').type.kind, ReflectionKind.string);
    });

    it('preserves metadata identity and mutations across class decoration', () => {
        const emitted = (DecoratorMutatedModel as typeof DecoratorMutatedModel & { __tsfType: ClassMetadata }).__tsfType;

        assert.strictEqual(emitted, decoratorMutatedMetadata);
        assert.equal(emitted.typeName, 'DecoratorMutatedModel:decorated');
        assert.equal(ReflectionClass.from(DecoratorMutatedModel).getProperty('enabled').type.kind, ReflectionKind.boolean);
    });

    it('reflects generic object metadata through typeOf', () => {
        const type = typeOf<{ required: string; optional?: number }>();

        assert.equal(type.kind, ReflectionKind.objectLiteral);
        if (type.kind !== ReflectionKind.objectLiteral) return;
        const properties = Object.fromEntries(type.types.map(property => [String(property.name), property]));
        assert.equal(properties.required.type.kind, ReflectionKind.string);
        assert.equal(properties.required.optional === true, false);
        assert.equal(properties.optional.optional, true);
    });

    it('supports public custom deserializer and named-validator registries', () => {
        type LowercaseString = string & TsfTypiaTag<'string', 'tsf:test-lowercase'>;
        type UppercaseString = string & Validate<'reflectionUppercase'>;

        deserializer.addDecorator(
            type => typeAnnotation.getType(type, 'tsf:test-lowercase') !== undefined,
            (_type, state) => state.addTransform(value => (typeof value === 'string' ? value.toLowerCase() : value))
        );
        validationRegistry.register('reflectionUppercase', value => {
            if (typeof value !== 'string' || !/^[A-Z]+$/.test(value)) {
                return new ValidatorError('reflectionUppercase', 'The value must be uppercase.');
            }
        });

        assert.deepStrictEqual(deserialize<{ name: LowercaseString }>({ name: 'ALICE' }), { name: 'alice' });
        assert.deepStrictEqual(
            validate<{ code: UppercaseString }>({ code: 'abc' }).map(error => [error.code, error.path]),
            [['reflectionUppercase', 'code']]
        );
    });

    it('combines inherited metadata, entity options, and property index flags', () => {
        const reflection = ReflectionClass.from(ReflectionMetadataUser);

        assert.equal(reflection.name, 'ReflectionMetadataUser');
        assert.equal(reflection.getCollectionName(), 'reflection_metadata_users');
        assert.equal(reflection.isDatabaseMigrationSkipped('mysql'), true);
        assert.deepStrictEqual(
            reflection.getProperties().map(property => [property.getNameAsString(), property.isPrimaryKey(), property.isAutoIncrement()]),
            [
                ['id', true, true],
                ['email', false, false],
                ['org', false, false]
            ]
        );
        assert.deepStrictEqual(
            reflection.indexes.map(index => [index.names, index.options]),
            [
                [['email'], { unique: false }],
                [['email'], { name: 'users_email_idx' }],
                [['email'], { name: 'users_email_unique', unique: true }]
            ]
        );
    });

    it('exposes methods, constructor parameters, references, and resolved classes', () => {
        const reflection = ReflectionClass.from(ReflectionMetadataUser);
        const method = reflection.getMethod('setEmail');
        const constructor = reflection.getConstructorOrUndefined();
        const org = reflection.getProperty('org');

        assert.deepStrictEqual(
            method.getParameters().map(parameter => [parameter.getName(), parameter.isOptional(), parameter.hasDefault()]),
            [['value', false, false]]
        );
        assert.equal(method.getReturnType().kind, ReflectionKind.void);
        assert.deepStrictEqual(
            constructor?.getParameters().map(parameter => [parameter.getName(), parameter.hasDefault()]),
            [['email', true]]
        );
        assert.equal(org.isReference(), true);
        assert.deepStrictEqual(org.getReference(), { onDelete: 'CASCADE' });
        assert.equal(org.getResolvedReflectionClass().getClassType(), ReflectionMetadataOrg);
    });

    it('throws useful errors for missing metadata members', () => {
        const reflection = ReflectionClass.from(ReflectionMetadataUser);

        assert.throws(() => reflection.getProperty('missing'), /Property missing does not exist/);
        assert.throws(() => reflection.getMethod('missing'), /Method missing does not exist/);
    });
});
