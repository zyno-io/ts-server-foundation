import { deserializer, ReflectionKind, validationRegistry, ValidatorError } from '../reflection';
import type { TsfTypeTag, TsfValidatorTag } from '../reflection';
import { PhoneNumberFormat, PhoneNumberUtil } from 'google-libphonenumber';
import { getFirstTypeAnnotation } from './type-annotations';

const phoneFormatter = PhoneNumberUtil.getInstance();
const InvalidPhoneSymbol = '¡InvalidPhone¡';

export function cleanPhone(value: string, country: string = 'US'): string | null {
    const cleaned = cleanPhoneInternal(value, country);
    return cleaned === InvalidPhoneSymbol ? null : cleaned;
}

function cleanPhoneInternal(value: string, country: string = 'US', stripUSPrefix = false): string {
    if (typeof value !== 'string') return InvalidPhoneSymbol;
    const number = tryOrErrorSync(() => phoneFormatter.parseAndKeepRawInput(value, country));
    if (number instanceof Error) return InvalidPhoneSymbol;
    if (!phoneFormatter.isValidNumber(number)) return InvalidPhoneSymbol;
    const result = phoneFormatter.format(number, PhoneNumberFormat.E164);
    if (!stripUSPrefix) return result;
    return result.startsWith('+1') ? result.slice(2) : InvalidPhoneSymbol;
}

export function formatPhoneFriendly(value: string, country?: string): string | null {
    const number = tryOrErrorSync(() => phoneFormatter.parse(value, country));
    if (number instanceof Error) return null;
    if (!phoneFormatter.isValidNumber(number)) return null;
    return phoneFormatter.format(number, PhoneNumberFormat.NATIONAL);
}

function validatePhone(value: unknown) {
    if (value === InvalidPhoneSymbol) {
        return new ValidatorError('invalidPhone', 'The phone number is invalid.');
    }
}

validationRegistry.register('phone', validatePhone);
validationRegistry.register('phoneNanp', validatePhone);

deserializer.addDecorator(
    t => {
        const typeType = getFirstTypeAnnotation(t, 'tsf:type');
        return typeType?.kind === ReflectionKind.literal && typeType.literal === 'phone';
    },
    (_type, state) => {
        state.addTransform(value => cleanPhoneInternal(value as string));
    }
);

deserializer.addDecorator(
    t => {
        const typeType = getFirstTypeAnnotation(t, 'tsf:type');
        return typeType?.kind === ReflectionKind.literal && typeType.literal === 'phoneNanp';
    },
    (_type, state) => {
        state.addTransform(value => cleanPhoneInternal(value as string, 'US', true));
    }
);

export type PhoneNumber = string & TsfValidatorTag<'string', 'phone'> & TsfTypeTag<'string', 'phone'>;
export type PhoneNumberNANP = string & TsfValidatorTag<'string', 'phoneNanp'> & TsfTypeTag<'string', 'phoneNanp'>;

function tryOrErrorSync<T>(fn: () => T): T | Error {
    try {
        return fn();
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}
