import { knownPrimitiveKind, validationAnnotation } from './annotations';
import { ValidatorError } from './errors';
import { ReflectionClass, readClassMetadata } from './reflection-class';
import { deserializer } from './deserializer';
import {
    allowsNull,
    allowsUndefined,
    joinPath,
    literalNumber,
    mergedIntersectionObjectLiteral,
    normalizeTypeMetadata,
    objectLiteralIndexType,
    objectLiteralPropertiesFromType,
    resolveRuntimeValue,
    tryResolveClassType,
    unwrapValueType
} from './type-utils';
import { isReflectedType, ReflectionKind, type ClassType, type Type } from './model';
import { coerceBooleanValue } from './primitive-conversion';

export type RuntimeValidator = (value: unknown) => ValidatorError | undefined | void;

const runtimeValidators = new Map<string, RuntimeValidator>();

export const validationRegistry = {
    register(name: string, validator: RuntimeValidator): void {
        runtimeValidators.set(name, validator);
    },

    get(name: string): RuntimeValidator | undefined {
        return runtimeValidators.get(name);
    }
};

export function validate<T>(value: unknown, target?: ClassType<T> | Type): ValidatorError[] {
    const type = resolveTargetType(value, target);
    if (!type) return [];
    return validateValue(value, type);
}

export function deserialize<T>(value: unknown, type?: Type): T {
    if (!type) throw new Error('deserialize<T>() was not transformed by the metadata compiler');
    normalizeTypeMetadata(type);
    return deserializeValue(value, type) as T;
}

export function validatedDeserialize<T>(value: unknown, _a?: unknown, _b?: unknown, _c?: unknown, type?: Type): T {
    if (!type) throw new Error('validatedDeserialize<T>() requires reflected type metadata');
    normalizeTypeMetadata(type);
    const result = deserializeValue(value, type) as T;
    const errors = validateValue(result, type);
    if (errors.length) throw errors[0];
    return result;
}

export function assert<T>(value: unknown, _deserializer?: unknown, type?: Type): asserts value is T {
    if (!type) throw new Error('assert<T>() requires explicit reflected type metadata');
    normalizeTypeMetadata(type);
    const errors = validateValue(value, type);
    if (errors.length) throw errors[0];
}

export function is<T>(value: unknown, _deserializer?: unknown, type?: Type): value is T {
    if (!type) throw new Error('is<T>() requires explicit reflected type metadata');
    normalizeTypeMetadata(type);
    return validateValue(value, type).length === 0;
}

export function cast<T>(value: unknown, _deserializer?: unknown, _a?: unknown, _b?: unknown, type?: Type): T {
    if (!type) throw new Error('cast<T>() requires explicit reflected type metadata');
    normalizeTypeMetadata(type);
    return deserializeValue(value, type) as T;
}

export function resolveReceiveType(value?: Type): Type {
    if (isReflectedType(value)) return value;
    throw new Error('Unsupported receive type payload');
}

function resolveTargetType(value: unknown, target?: Function | Type): Type | undefined {
    if (isReflectedType(target)) {
        normalizeTypeMetadata(target);
        return target;
    }
    if (typeof target === 'function') return readClassMetadata(target);
    if (value && typeof value === 'object') return readClassMetadata(value.constructor);
}

function validateValue(value: unknown, type: Type, path = ''): ValidatorError[] {
    const errors: ValidatorError[] = [];
    const concrete = unwrapValueType(type);
    const knownPrimitive = knownPrimitiveKind(concrete);

    if (value === undefined) {
        if (!allowsUndefined(type)) errors.push(new ValidatorError('required', 'The value is required.', path));
        return errors;
    }
    if (value === null) {
        if (!allowsNull(type)) errors.push(new ValidatorError('required', 'The value cannot be null.', path));
        return errors;
    }

    if (knownPrimitive === ReflectionKind.string) {
        if (typeof value !== 'string') errors.push(new ValidatorError('type', 'The value must be a string.', path));
    } else if (knownPrimitive === ReflectionKind.number) {
        if (typeof value !== 'number' || Number.isNaN(value)) errors.push(new ValidatorError('type', 'The value must be a number.', path));
    } else if (knownPrimitive === ReflectionKind.boolean) {
        if (typeof value !== 'boolean') errors.push(new ValidatorError('type', 'The value must be a boolean.', path));
    } else if (concrete.kind === ReflectionKind.undefined || concrete.kind === ReflectionKind.null || concrete.kind === ReflectionKind.never) {
        errors.push(new ValidatorError('type', 'The value does not match the required type.', path));
    } else if (concrete.kind === ReflectionKind.string || concrete.kind === ReflectionKind.templateLiteral) {
        if (typeof value !== 'string') errors.push(new ValidatorError('type', 'The value must be a string.', path));
    } else if (concrete.kind === ReflectionKind.number) {
        if (typeof value !== 'number' || Number.isNaN(value)) errors.push(new ValidatorError('type', 'The value must be a number.', path));
    } else if (concrete.kind === ReflectionKind.boolean) {
        if (typeof value !== 'boolean') errors.push(new ValidatorError('type', 'The value must be a boolean.', path));
    } else if (concrete.kind === ReflectionKind.array) {
        if (!Array.isArray(value)) {
            errors.push(new ValidatorError('type', 'The value must be an array.', path));
        } else {
            value.forEach((item, index) => {
                errors.push(...validateValue(item, concrete.type, joinPath(path, String(index))));
            });
        }
    } else if (concrete.kind === ReflectionKind.tuple) {
        if (!Array.isArray(value)) {
            errors.push(new ValidatorError('type', 'The value must be an array.', path));
        } else {
            concrete.types.forEach((item, index) => {
                errors.push(...validateValue(value[index], item.type, joinPath(path, String(index))));
            });
        }
    } else if (concrete.kind === ReflectionKind.union) {
        const branchErrors = concrete.types.map(item => validateValue(value, item, path));
        const matches = branchErrors.some(item => item.length === 0);
        if (!matches) {
            const best = branchErrors.filter(item => item.length > 0).sort((a, b) => a.length - b.length)[0];
            if (best?.length) errors.push(...best);
            else errors.push(new ValidatorError('type', 'The value does not match any allowed type.', path));
        }
    } else if (concrete.kind === ReflectionKind.objectLiteral) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            errors.push(new ValidatorError('type', 'The value must be an object.', path));
            return errors;
        }
        const record = value as Record<string, unknown>;
        const propertyNames = new Set<string>();
        for (const property of objectLiteralPropertiesFromType(concrete)) {
            propertyNames.add(String(property.name));
            const propertyPath = joinPath(path, String(property.name));
            if (record[property.name as string] === undefined && property.optional) continue;
            errors.push(...validateValue(record[property.name as string], property.type, propertyPath));
        }
        const indexType = objectLiteralIndexType(concrete);
        if (indexType) {
            for (const [key, item] of Object.entries(record)) {
                if (!propertyNames.has(key)) errors.push(...validateValue(item, indexType, joinPath(path, key)));
            }
        }
    } else if (concrete.kind === ReflectionKind.literal) {
        if (value !== concrete.literal) errors.push(new ValidatorError('type', `The value must be ${String(concrete.literal)}.`, path));
    } else if (concrete.kind === ReflectionKind.enum) {
        if (!concrete.values.includes(value)) errors.push(new ValidatorError('type', 'The value does not match any allowed enum value.', path));
    } else if (concrete.kind === ReflectionKind.class) {
        const Target = tryResolveClassType(concrete.classType);
        if (!Target) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                errors.push(new ValidatorError('type', 'The value must be an object.', path));
            }
            return errors;
        }
        if (Target === Date) {
            // Built-ins can carry validation annotations but do not have project metadata.
        } else {
            const reflection = ReflectionClass.from(Target);
            const record = value as Record<string, unknown>;
            for (const property of reflection.getProperties()) {
                if (record[String(property.name)] === undefined && property.isOptional()) continue;
                errors.push(...validateValue(record[String(property.name)], property.getType(), joinPath(path, String(property.name))));
            }
        }
    }

    for (const annotation of validationAnnotation.getAnnotations(type)) {
        if (annotation.name === 'minLength' && typeof value === 'string') {
            const min = literalNumber(annotation.args[0]);
            if (min !== undefined && value.length < min)
                errors.push(new ValidatorError('minLength', `The value must be at least ${min} characters.`, path));
        } else if (annotation.name === 'maxLength' && typeof value === 'string') {
            const max = literalNumber(annotation.args[0]);
            if (max !== undefined && value.length > max)
                errors.push(new ValidatorError('maxLength', `The value must be at most ${max} characters.`, path));
        } else if (annotation.name === 'minimum' && typeof value === 'number') {
            const min = literalNumber(annotation.args[0]);
            if (min !== undefined && value < min) errors.push(new ValidatorError('minimum', `The value must be at least ${min}.`, path));
        } else if (annotation.name === 'greaterThan' && typeof value === 'number') {
            const min = literalNumber(annotation.args[0]);
            if (min !== undefined && value <= min) errors.push(new ValidatorError('greaterThan', `The value must be greater than ${min}.`, path));
        } else if (annotation.name === 'maximum' && typeof value === 'number') {
            const max = literalNumber(annotation.args[0]);
            if (max !== undefined && value > max) errors.push(new ValidatorError('maximum', `The value must be at most ${max}.`, path));
        } else if (annotation.name === 'lessThan' && typeof value === 'number') {
            const max = literalNumber(annotation.args[0]);
            if (max !== undefined && value >= max) errors.push(new ValidatorError('lessThan', `The value must be less than ${max}.`, path));
        } else if (annotation.name === 'pattern' && typeof value === 'string') {
            const pattern = resolveRuntimeValue(annotation.args[0]);
            const regexp = typeof pattern === 'string' ? new RegExp(pattern) : pattern instanceof RegExp ? pattern : undefined;
            if (regexp && !regexp.test(value)) errors.push(new ValidatorError('pattern', 'The value does not match the required pattern.', path));
        } else if (annotation.name === 'validate') {
            const validator = resolveRuntimeValue(annotation.args[0]);
            if (typeof validator === 'function') {
                const result = validator(value);
                if (result instanceof ValidatorError) errors.push(new ValidatorError(result.code, result.message, path));
            }
        } else if (annotation.name === 'validator') {
            const name = resolveRuntimeValue(annotation.args[0]);
            const validator = typeof name === 'string' ? validationRegistry.get(name) : undefined;
            if (validator) {
                const result = validator(value);
                if (result instanceof ValidatorError) errors.push(new ValidatorError(result.code, result.message, path));
            }
        }
    }

    return errors;
}

function deserializeValue(value: unknown, type: Type): unknown {
    if (value === null || value === undefined) return value;

    if (type.kind === ReflectionKind.intersection) {
        const mergedObject = mergedIntersectionObjectLiteral(type);
        if (mergedObject && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
            return deserializer.apply(type, deserializeValue(value, mergedObject));
        }

        let result: unknown = value;
        if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
            const output: Record<string, unknown> = {};
            let merged = false;
            for (const item of type.types) {
                const part = deserializeValue(value, item);
                if (part && typeof part === 'object' && !Array.isArray(part) && !(part instanceof Date)) {
                    Object.assign(output, part);
                    merged = true;
                }
            }
            result = merged ? output : value;
        } else {
            for (const item of type.types) result = deserializeValue(result, item);
        }
        return deserializer.apply(type, result);
    }

    const concrete = unwrapValueType(type);
    let result: unknown = value;
    if (concrete.kind === ReflectionKind.number && typeof value === 'string' && value.trim() !== '') {
        result = Number(value);
    } else if (concrete.kind === ReflectionKind.boolean) {
        result = coerceBooleanValue(value);
    } else if (concrete.kind === ReflectionKind.enum && typeof value === 'string') {
        const numeric = Number(value);
        if (!Number.isNaN(numeric) && concrete.values.includes(numeric)) result = numeric;
    } else if (concrete.kind === ReflectionKind.array && Array.isArray(value)) {
        result = value.map(item => deserializeValue(item, concrete.type));
    } else if (concrete.kind === ReflectionKind.tuple && Array.isArray(value)) {
        result = concrete.types.map((item, index) => deserializeValue(value[index], item.type));
    } else if (concrete.kind === ReflectionKind.union) {
        for (const item of concrete.types) {
            const candidate = deserializeValue(value, item);
            if (validateValue(candidate, item).length === 0) {
                result = candidate;
                break;
            }
        }
    } else if (concrete.kind === ReflectionKind.class) {
        const Target = tryResolveClassType(concrete.classType);
        if (!Target) return deserializer.apply(type, value);
        if (Target === Date) return deserializer.apply(type, value instanceof Date ? value : new Date(value as any));
        if (typeof value !== 'object') return deserializer.apply(type, value);
        const output = new Target() as Record<string, unknown>;
        const input = value as Record<string, unknown>;
        for (const property of ReflectionClass.from(Target).getProperties()) {
            output[String(property.name)] = deserializeValue(input[String(property.name)], property.getType());
        }
        result = output;
    } else if (concrete.kind === ReflectionKind.objectLiteral && typeof value === 'object') {
        const properties = objectLiteralPropertiesFromType(concrete);
        const indexType = objectLiteralIndexType(concrete);
        if (properties.length === 0 && !indexType) return deserializer.apply(type, value);
        const input = value as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        const propertyNames = new Set<string>();
        for (const property of properties) {
            const name = String(property.name);
            propertyNames.add(name);
            output[name] = deserializeValue(input[name], property.type);
        }
        if (indexType) {
            for (const [key, item] of Object.entries(input)) {
                if (!propertyNames.has(key)) output[key] = deserializeValue(item, indexType);
            }
        }
        result = output;
    }

    return deserializer.apply(type, result);
}
