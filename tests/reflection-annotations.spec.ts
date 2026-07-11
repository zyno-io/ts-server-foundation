import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { databaseAnnotation, isDatabaseUUIDType, isUUIDType, ReflectionKind, typeAnnotation, validationAnnotation, type Type } from '../src';

const stringType: Type = { kind: ReflectionKind.string };

describe('reflection annotations', () => {
    it('finds explicit annotations across metadata-only intersections', () => {
        const type: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                {
                    kind: ReflectionKind.unknown,
                    typeName: 'Marker',
                    annotations: {
                        'example:name': { kind: ReflectionKind.literal, literal: 'value' }
                    }
                }
            ]
        };

        const annotation = typeAnnotation.getType(type, 'example:name');
        assert.equal(annotation?.kind, ReflectionKind.literal);
        assert.equal((annotation as { literal?: unknown } | undefined)?.literal, 'value');
    });

    it('exposes explicit foundation annotations and validators', () => {
        const lengthType: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                {
                    kind: ReflectionKind.unknown,
                    annotations: {
                        'tsf:length': { kind: ReflectionKind.literal, literal: 5 }
                    },
                    validation: [
                        { name: 'minLength', args: [{ kind: ReflectionKind.literal, literal: 5 }] },
                        { name: 'maxLength', args: [{ kind: ReflectionKind.literal, literal: 5 }] }
                    ]
                }
            ]
        } as Type;
        const emailType: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                {
                    kind: ReflectionKind.unknown,
                    validation: [
                        { name: 'pattern', args: [{ kind: ReflectionKind.literal, literal: '^[a-zA-Z0-9_+.-]+@[a-zA-Z0-9-.]+\\.[a-zA-Z]+$' }] }
                    ]
                }
            ]
        } as Type;
        const dateType: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                {
                    kind: ReflectionKind.unknown,
                    annotations: {
                        'tsf:type': { kind: ReflectionKind.literal, literal: 'date' }
                    },
                    database: { mysql: { type: 'DATE' } }
                }
            ]
        } as Type;

        const lengthMarker = typeAnnotation.getType(lengthType, 'tsf:length');
        const validators = Object.fromEntries(
            validationAnnotation
                .getAnnotations(lengthType)
                .map(annotation => [annotation.name, (annotation.args[0] as { literal?: unknown } | undefined)?.literal])
        );

        assert.equal(lengthMarker?.kind, ReflectionKind.literal);
        assert.equal((lengthMarker as { literal?: unknown } | undefined)?.literal, 5);
        assert.deepStrictEqual(validators, { minLength: 5, maxLength: 5 });
        assert.equal(validationAnnotation.getAnnotations(emailType).at(0)?.name, 'pattern');
        assert.deepStrictEqual(databaseAnnotation.getDatabase(dateType, 'mysql'), { type: 'DATE' });
    });

    it('distinguishes general UUID aliases from database UUID aliases by explicit metadata', () => {
        const uuidString: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                {
                    kind: ReflectionKind.unknown,
                    annotations: {
                        'tsf:type': { kind: ReflectionKind.literal, literal: 'uuidString' }
                    }
                }
            ]
        } as Type;
        const uuid: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                {
                    kind: ReflectionKind.unknown,
                    annotations: {
                        'tsf:type': { kind: ReflectionKind.literal, literal: 'uuid' }
                    }
                }
            ]
        } as Type;
        const unresolvedUuid: Type = { kind: ReflectionKind.unknown, typeName: 'UUID' };

        assert.equal(isUUIDType(uuidString), true);
        assert.equal(isDatabaseUUIDType(uuidString), false);
        assert.equal(isUUIDType(uuid), true);
        assert.equal(isDatabaseUUIDType(uuid), true);
        assert.equal(isUUIDType(unresolvedUuid), false);
        assert.equal(isDatabaseUUIDType(unresolvedUuid), false);
    });

    it('reads custom typia tags as shared annotations', () => {
        const taggedDate: Type = {
            kind: ReflectionKind.intersection,
            types: [
                stringType,
                typiaTag('format', literal('date')),
                typiaTag('tsf:type', literal('date')),
                typiaTag('database:field', literal('*'), objectLiteral([signature('type', literal('DATE'))]))
            ]
        };

        const typeMarker = typeAnnotation.getType(taggedDate, 'tsf:type');
        const pattern = validationAnnotation.getAnnotations(taggedDate).find(annotation => annotation.name === 'pattern')?.args[0];

        assert.equal((typeMarker as { literal?: unknown } | undefined)?.literal, 'date');
        assert.equal((pattern as { literal?: unknown } | undefined)?.literal, '^\\d{4}-\\d{2}-\\d{2}$');
        assert.deepStrictEqual(databaseAnnotation.getDatabase(taggedDate, 'mysql'), { type: 'DATE' });
    });

    it('does not infer foundation alias metadata from matching names', () => {
        const compiledUuidString: Type = {
            kind: ReflectionKind.intersection,
            typeName: 'UuidString',
            types: [stringType, { kind: ReflectionKind.unknown, typeName: 'UuidString' } as Type]
        };
        const compiledDateString: Type = {
            kind: ReflectionKind.intersection,
            typeName: 'DateString',
            types: [stringType, { kind: ReflectionKind.unknown, typeName: 'DateString' } as Type]
        };
        const unresolvedUuidString: Type = { kind: ReflectionKind.unknown, typeName: 'UuidString' };

        assert.equal(typeAnnotation.getType(compiledUuidString, 'tsf:type'), undefined);
        assert.equal(isUUIDType(compiledUuidString), false);
        assert.equal(isDatabaseUUIDType(compiledUuidString), false);
        assert.equal(typeAnnotation.getType(compiledDateString, 'tsf:type'), undefined);
        assert.equal(databaseAnnotation.getDatabase(compiledDateString, 'mysql'), undefined);
        assert.equal(typeAnnotation.getType(unresolvedUuidString, 'tsf:type'), undefined);
    });

    it('does not return MySQL-only typia tags for generic database lookups', () => {
        const mysqlDate: Type = {
            kind: ReflectionKind.intersection,
            types: [stringType, typiaTag('database:mysql', literal('*'), objectLiteral([signature('type', literal('DATE'))]))]
        };

        assert.deepStrictEqual(databaseAnnotation.getDatabase(mysqlDate, 'mysql'), { type: 'DATE' });
        assert.equal(databaseAnnotation.getDatabase(mysqlDate, 'postgres'), undefined);
        assert.equal(databaseAnnotation.getDatabase(mysqlDate, '*'), undefined);
    });
});

function literal(value: unknown): Type {
    return { kind: ReflectionKind.literal, literal: value };
}

function signature(name: string, type: Type): Type {
    return { kind: ReflectionKind.propertySignature, name, type };
}

function objectLiteral(types: Type[]): Type {
    return { kind: ReflectionKind.objectLiteral, types: types as never };
}

function typiaTag(kind: string, value?: Type, schema?: Type): Type {
    const tagFields = [signature('kind', literal(kind))];
    if (value) tagFields.push(signature('value', value));
    if (schema) tagFields.push(signature('schema', schema));
    return objectLiteral([signature('typia.tag', objectLiteral(tagFields))]);
}
