import {
    databaseAnnotation,
    deserialize,
    MaxLength,
    MinLength,
    Minimum,
    Pattern,
    ReflectionClass,
    ReflectionKind,
    typeOf,
    validate,
    validatedDeserialize,
    validationRegistry,
    ValidatorError,
    type GreaterThan,
    type LessThan,
    type ReceiveType,
    type Type,
    type Validate,
    typeAnnotation,
    validationAnnotation
} from '../src';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    cleanPhone,
    DateString,
    EmailAddress,
    EMAIL_REGEX,
    formatPhoneFriendly,
    Length,
    NonEmptyTrimmedString,
    PhoneNumber,
    PhoneNumberNANP,
    TrimmedString,
    UnsignedNumber,
    UuidString,
    ValidDate,
    WithDefault
} from '../src';

export class DynamicImportTypeDependency {}

class TypeUtilityMetadataModel {
    id!: string;
    email!: EmailAddress;
    name?: TrimmedString;
    active!: boolean;
}

type TypeUtilityMetadataUnion =
    | { type: 'email'; email: EmailAddress; code: Length<4> }
    | { type: 'phone'; phone: PhoneNumberNANP }
    | { type: 'ignored'; value: number };

describe('custom types', () => {
    function reflectedExplicit<T>(_value: unknown, type?: ReceiveType<T>) {
        return type;
    }

    function reflectedWithTimeout<T>(_query: string, _bindings: unknown[] = [], timeout = 30_000, type?: ReceiveType<T>) {
        return { timeout, type };
    }

    function reflectedHandler<T>(_handler: (args: T) => unknown, type?: ReceiveType<T>) {
        return type;
    }

    class ReceiveTypeMethodCollisionFixture {
        reflectedExplicit(_value: unknown): unknown {
            return _value;
        }
    }

    class DynamicImportTypeConsumer {
        setDependency(_dependency: import('./types.spec').DynamicImportTypeDependency) {}
    }

    it('ignores call-shaped generic metadata helpers in comments', () => {
        // typeOf<{ count: string }>()
        const reflected = typeOf<{ name: string; count: number }>();

        assert.equal(validate({ name: 'a', count: 2 }, reflected).length, 0);
        assert.deepEqual(
            validate({ name: 'a', count: 'bad' }, reflected).map(error => error.path),
            ['count']
        );
    });

    it('injects omitted ReceiveType metadata for explicit generic function calls', () => {
        const reflected = reflectedExplicit<{ name: string; count: number }>({});

        assert.ok(reflected);
        assert.equal(validate({ name: 'a', count: 2 }, reflected).length, 0);
        assert.deepEqual(
            validate({ name: 'a', count: 'bad' }, reflected).map(error => error.path),
            ['count']
        );
    });

    it('injects ReceiveType metadata after omitted optional arguments in template literal calls', () => {
        const fileNumbers = ['1193514'];
        const reflected = reflectedWithTimeout<{ DBR_NO: string; DBR_NAME1: string }>(
            `
                SELECT DBR.DBR_NO, DBR.DBR_NAME1
                FROM cds.DBR
                WHERE DBR.DBR_NO IN (${fileNumbers.map(() => '?').join(`,`)})
            `,
            fileNumbers
        );

        assert.equal(reflected.timeout, 30_000);
        assert.ok(reflected.type);
        assert.equal(validate({ DBR_NO: '1193514', DBR_NAME1: 'Ada' }, reflected.type).length, 0);
        assert.deepEqual(
            validate({ DBR_NO: 1193514, DBR_NAME1: 'Ada' }, reflected.type).map(error => error.path),
            ['DBR_NO']
        );
    });

    it('injects omitted ReceiveType metadata from typed callback parameters', () => {
        const reflected = reflectedHandler((args: { name: string; count: number }) => args.name);

        assert.ok(reflected);
        assert.equal(validate({ name: 'a', count: 2 }, reflected).length, 0);
        assert.deepEqual(
            validate({ name: 'a', count: 'bad' }, reflected).map(error => error.path),
            ['count']
        );
    });

    it('injects omitted ReceiveType metadata from named typed callback parameters', () => {
        const handler = (args: { name: string; count: number }) => args.name;
        const reflected = reflectedHandler(handler);

        assert.ok(reflected);
        assert.equal(validate({ name: 'a', count: 2 }, reflected).length, 0);
        assert.deepEqual(
            validate({ name: 'a', count: 'bad' }, reflected).map(error => error.path),
            ['count']
        );
    });

    it('does not inject ReceiveType metadata into same-named method declarations', () => {
        const fixture = new ReceiveTypeMethodCollisionFixture();
        const reflected = reflectedExplicit<{ name: string; count: number }>(fixture.reflectedExplicit({}));

        assert.ok(reflected);
        assert.equal(validate({ name: 'a', count: 2 }, reflected).length, 0);
        assert.deepEqual(
            validate({ name: 'a', count: 'bad' }, reflected).map(error => error.path),
            ['count']
        );
    });

    it('resolves dynamic import type references in method metadata synchronously', () => {
        const type = ReflectionClass.from(DynamicImportTypeConsumer).getMethod('setDependency').getParameters()[0].getType();

        assert.equal(type.kind, ReflectionKind.class);
        assert.equal((type as Type & { classType?: unknown }).classType, DynamicImportTypeDependency);
    });

    it('reflects utility-heavy generic type metadata through typeOf', () => {
        type UtilityShape = Required<Pick<TypeUtilityMetadataModel, 'id' | 'email'>> & {
            settings: Partial<Record<'email' | 'phone', EmailAddress | null>>;
            config: Extract<TypeUtilityMetadataUnion, { type: 'email' | 'phone' }>;
        };

        const reflected = typeOf<UtilityShape>();

        assert.equal(
            validate(
                {
                    id: 'user-1',
                    email: 'user@example.com',
                    settings: {
                        email: null,
                        phone: 'phone@example.com'
                    },
                    config: {
                        type: 'email',
                        email: 'user@example.com',
                        code: '1234'
                    }
                },
                reflected
            ).length,
            0
        );

        const errors = validate(
            {
                email: 'not-an-email',
                settings: {
                    email: null,
                    phone: 'also-not-an-email',
                    extra: 42
                },
                config: {
                    type: 'email',
                    email: 'bad',
                    code: '123'
                }
            },
            reflected
        );

        assert.deepEqual(
            errors.map(error => [error.code, error.path]),
            [
                ['required', 'id'],
                ['pattern', 'email'],
                ['pattern', 'settings.phone'],
                ['pattern', 'config.email'],
                ['minLength', 'config.code']
            ]
        );
    });

    it('validates email addresses with the project regex', () => {
        assert.equal(EMAIL_REGEX.test('test@example.com'), true);
        assert.equal(EMAIL_REGEX.test('UPPER+tag@example.com'), true);
        assert.equal(EMAIL_REGEX.test('test+extras@example.com'), true);
        assert.equal(EMAIL_REGEX.test('with_underscores@example.com'), true);
        assert.equal(EMAIL_REGEX.test('and-hyphens@example.com'), true);
        assert.equal(EMAIL_REGEX.test('test@example.com@example.com'), false);
        assert.equal(EMAIL_REGEX.test('test@sgnl24'), false);
    });

    it('injects metadata for validatedDeserialize calls', () => {
        const value = validatedDeserialize<{ platform: 'ios' | 'android'; features: string[] }>({
            platform: 'ios',
            features: ['contacts']
        });

        assert.deepEqual(value, { platform: 'ios', features: ['contacts'] });
        assert.throws(
            () => validatedDeserialize<{ platform: 'ios' | 'android'; features: string[] }>({ platform: 'web', features: [] }),
            ValidatorError
        );
    });

    it('trims annotated strings during type deserialization', () => {
        interface Input {
            name: TrimmedString;
            requiredName: NonEmptyTrimmedString;
            words: string;
        }

        const result = deserialize<Input>({
            name: '  test  ',
            requiredName: '  required  ',
            words: '  with leading spaces'
        });

        assert.deepStrictEqual(result, {
            name: 'test',
            requiredName: 'required',
            words: '  with leading spaces'
        });
    });

    it('cleans and formats phone numbers', () => {
        assert.equal(cleanPhone('(404)-900-5600'), '+14049005600');
        assert.equal(cleanPhone('not a number'), null);
        assert.equal(formatPhoneFriendly('+14049005600', 'US'), '(404) 900-5600');
    });

    it('normalizes phone annotations during type deserialization', () => {
        interface IntlInput {
            phone: PhoneNumber;
        }

        interface NanpInput {
            phone: PhoneNumberNANP;
        }

        assert.deepStrictEqual(deserialize<IntlInput>({ phone: '(404)-900-5600' }), { phone: '+14049005600' });
        const invalid = deserialize<IntlInput>({ phone: '123.456.7890' });
        assert.deepStrictEqual(invalid, { phone: '¡InvalidPhone¡' });
        assert.equal(validate<IntlInput>(invalid)[0]?.code, 'invalidPhone');
        assert.deepStrictEqual(deserialize<NanpInput>({ phone: '(404)-900-5600' }), { phone: '4049005600' });
    });

    it('validates fixed lengths and invalid Date objects', () => {
        interface Input {
            code: Length<6>;
            startsAt: ValidDate;
        }

        const errors = validate<Input>({ code: '123', startsAt: new Date(Number.NaN) });

        assert.equal(errors.length, 2);
        assert.equal(errors[0].code, 'minLength');
        assert.equal(errors[1].code, 'invalidDate');
    });

    it('does not infer custom type behavior from unresolved alias names', () => {
        const unresolvedUuid = {
            kind: ReflectionKind.unknown,
            typeName: 'UuidString'
        } as unknown as Type;

        assert.equal(typeAnnotation.getType(unresolvedUuid, 'tsf:type'), undefined);
        assert.equal(validate(42, unresolvedUuid).length, 0);
    });

    it('defines Length with type min/max validators and the tsf length marker', () => {
        class Input {
            code!: Length<6>;
        }

        const shortErrors = validate({ code: '123' }, Input);
        const longErrors = validate({ code: '1234567' }, Input);
        const type = ReflectionClass.from(Input).getProperty('code').getType();
        const values = Object.fromEntries(
            validationAnnotation
                .getAnnotations(type)
                .map(annotation => [annotation.name, (annotation.args[0] as { literal?: unknown } | undefined)?.literal])
        );
        const lengthMarker = typeAnnotation.getType(type, 'tsf:length');

        assert.deepEqual(
            shortErrors.map(error => error.code),
            ['minLength']
        );
        assert.deepEqual(
            longErrors.map(error => error.code),
            ['maxLength']
        );
        assert.equal(values.minLength, 6);
        assert.equal(values.maxLength, 6);
        assert.equal(lengthMarker?.kind, ReflectionKind.literal);
        assert.equal((lengthMarker as { literal?: unknown } | undefined)?.literal, 6);
    });

    it('defines shared number and default marker aliases', () => {
        validationRegistry.register('uppercaseOnly', value => {
            if (typeof value !== 'string' || !/^[A-Z]+$/.test(value)) {
                return new ValidatorError('uppercaseOnly', 'The value must be uppercase.');
            }
        });
        const reflected = typeOf<{
            count: UnsignedNumber;
            retries: number & Minimum<0>;
            amount: number & GreaterThan<0>;
            percent: number & LessThan<100>;
            serial: string & Pattern<'^[A-Z]+$'>;
            checked: string & Validate<'uppercaseOnly'>;
            name: WithDefault<string>;
        }>();
        assert.equal(reflected.kind, ReflectionKind.objectLiteral);
        const properties = Object.fromEntries(reflected.types.map(property => [String(property.name), property.type] as const)) as Record<
            string,
            Type
        >;

        const countMinimum = validationAnnotation.getAnnotations(properties.count).find(annotation => annotation.name === 'minimum')?.args[0];
        const retriesMinimum = validationAnnotation.getAnnotations(properties.retries).find(annotation => annotation.name === 'minimum')?.args[0];
        const amountGreaterThan = validationAnnotation.getAnnotations(properties.amount).find(annotation => annotation.name === 'greaterThan')
            ?.args[0];
        const percentLessThan = validationAnnotation.getAnnotations(properties.percent).find(annotation => annotation.name === 'lessThan')?.args[0];
        const serialPattern = validationAnnotation.getAnnotations(properties.serial).find(annotation => annotation.name === 'pattern')?.args[0];
        const checkedValidator = validationAnnotation.getAnnotations(properties.checked).find(annotation => annotation.name === 'validator')?.args[0];
        assert.equal((countMinimum as { literal?: unknown } | undefined)?.literal, 0);
        assert.equal((retriesMinimum as { literal?: unknown } | undefined)?.literal, 0);
        assert.equal((amountGreaterThan as { literal?: unknown } | undefined)?.literal, 0);
        assert.equal((percentLessThan as { literal?: unknown } | undefined)?.literal, 100);
        assert.equal((serialPattern as { literal?: unknown } | undefined)?.literal, '^[A-Z]+$');
        assert.equal((checkedValidator as { literal?: unknown } | undefined)?.literal, 'uppercaseOnly');
        assert.equal(typeAnnotation.getType(properties.name, 'tsf:hasDefault')?.kind, ReflectionKind.undefined);
        assert.equal(validate<{ serial: string & Pattern<'^[A-Z]+$'> }>({ serial: 'abc' })[0]?.code, 'pattern');
        assert.equal(validate<{ amount: number & GreaterThan<0> }>({ amount: 0 })[0]?.code, 'greaterThan');
        assert.equal(validate<{ amount: number & GreaterThan<0> }>({ amount: 1 }).length, 0);
        assert.equal(validate<{ percent: number & LessThan<100> }>({ percent: 100 })[0]?.code, 'lessThan');
        assert.equal(validate<{ percent: number & LessThan<100> }>({ percent: 99 }).length, 0);
        assert.equal(validate<{ checked: string & Validate<'uppercaseOnly'> }>({ checked: 'abc' })[0]?.code, 'uppercaseOnly');
    });

    it('preserves tag-backed domain metadata through utility types', () => {
        type Contact = {
            email: EmailAddress;
            birthday: DateString;
            id: UuidString;
            code: Length<4>;
            name: TrimmedString;
            phone: PhoneNumber;
            startsAt: ValidDate;
        };
        type ContactPatch = Partial<Pick<Contact, 'email' | 'birthday' | 'id' | 'code' | 'name' | 'phone' | 'startsAt'>>;

        const reflected = typeOf<ContactPatch>();
        assert.equal(reflected.kind, ReflectionKind.objectLiteral);
        const properties = Object.fromEntries(reflected.types.map(property => [String(property.name), property.type] as const)) as Record<
            string,
            Type
        >;

        assert.equal(typeAnnotation.getType(properties.id, 'tsf:type')?.kind, ReflectionKind.literal);
        assert.equal((typeAnnotation.getType(properties.id, 'tsf:type') as { literal?: unknown } | undefined)?.literal, 'uuidString');
        assert.equal((typeAnnotation.getType(properties.birthday, 'tsf:type') as { literal?: unknown } | undefined)?.literal, 'date');
        assert.deepEqual(databaseAnnotation.getDatabase(properties.birthday, 'mysql'), { type: 'DATE' });
        assert.equal((typeAnnotation.getType(properties.code, 'tsf:length') as { literal?: unknown } | undefined)?.literal, 4);
        assert.equal(typeAnnotation.getType(properties.name, 'tsf:trim')?.kind, ReflectionKind.undefined);

        const codeValidators = validationAnnotation.getAnnotations(properties.code).map(annotation => annotation.name);
        const emailValidators = validationAnnotation.getAnnotations(properties.email).map(annotation => annotation.name);
        const phoneValidator = validationAnnotation.getAnnotations(properties.phone).find(annotation => annotation.name === 'validator')?.args[0];
        const dateValidator = validationAnnotation.getAnnotations(properties.startsAt).find(annotation => annotation.name === 'validator')?.args[0];
        assert.deepEqual(codeValidators, ['minLength', 'maxLength']);
        assert.deepEqual(emailValidators, ['pattern']);
        assert.equal(validate<{ email: EmailAddress }>({ email: 'UPPER+tag@example.com' }).length, 0);
        assert.equal(validate<{ email: EmailAddress }>({ email: 'bad@example' })[0]?.code, 'pattern');
        assert.equal((phoneValidator as { literal?: unknown } | undefined)?.literal, 'phone');
        assert.equal((dateValidator as { literal?: unknown } | undefined)?.literal, 'validDate');
    });

    it('exposes MinLength and MaxLength as validation annotations', () => {
        class Input {
            min!: string & MinLength<3>;
            max!: string & MaxLength<5>;
            bounded!: string & MinLength<2> & MaxLength<4>;
        }

        const errors = validate(
            {
                min: 'ab',
                max: 'abcdef',
                bounded: 'x'
            },
            Input
        );
        const boundedType = ReflectionClass.from(Input).getProperty('bounded').getType();
        const annotations = validationAnnotation.getAnnotations(boundedType);
        const values = Object.fromEntries(
            annotations.map(annotation => [annotation.name, (annotation.args[0] as { literal?: unknown } | undefined)?.literal])
        );

        assert.deepEqual(
            errors.map(error => error.code),
            ['minLength', 'maxLength', 'minLength']
        );
        assert.equal(values.minLength, 2);
        assert.equal(values.maxLength, 4);
    });
});
