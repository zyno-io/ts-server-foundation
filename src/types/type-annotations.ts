import { deserializer, typeAnnotation, validationRegistry, ValidatorError } from '../reflection';
import type {
    MaxLength,
    MinLength,
    Minimum,
    MySQL,
    Type,
    TypeAnnotation,
    TypiaFormat,
    TsfDatabaseFieldTag,
    TsfTypeTag,
    TsfTypiaTag,
    TsfValidatorTag
} from '../reflection';

export type DateString = string & TypiaFormat<'date'> & TsfDatabaseFieldTag<{ type: 'DATE' }> & TsfTypeTag<'string', 'date'>;
export type OnUpdate<T extends string> = TypeAnnotation<'tsf:onUpdate', T>;
export type HasDefault = TypeAnnotation<'tsf:hasDefault'>;
export type WithDefault<T> = T & HasDefault;
export type UuidString = string & TypiaFormat<'uuid'> & TsfTypeTag<'string', 'uuidString'>;
export type { UUID } from '../reflection';
export type UnsignedNumber = number & Minimum<0>;

export class Coordinate {
    x!: number;
    y!: number;
}

export type MySQLCoordinate = Coordinate & MySQL<{ type: 'point' }>;
export type NullableMySQLCoordinate = (Coordinate & MySQL<{ type: 'point' }>) | null;

export type Length<T extends number> = string & MinLength<T> & MaxLength<T> & TsfTypiaTag<'string', 'tsf:length', T>;

function validateDate(value: unknown) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return new ValidatorError('invalidDate', 'The date is invalid.');
    }
}

validationRegistry.register('validDate', validateDate);

export type ValidDate = Date & TsfValidatorTag<'object', 'validDate'>;

export type TrimmedString = string & TsfTypiaTag<'string', 'tsf:trim'>;
export type NonEmptyTrimmedString = TrimmedString & MinLength<1>;

export function getFirstTypeAnnotation(t: Type, ...names: string[]) {
    for (const name of names) {
        const annotation = typeAnnotation.getType(t, name);
        if (annotation) return annotation;
    }
}

deserializer.addDecorator(
    t => getFirstTypeAnnotation(t, 'tsf:trim') !== undefined,
    (_type, state) => {
        state.addTransform(value => (typeof value === 'string' ? value.trim() : value));
    }
);

export const EMAIL_REGEX = /^[a-z0-9_+.-]+@[a-z0-9-.]+\.[a-z]+$/i;
export type EmailAddress = string & TypiaFormat<'email'>;
