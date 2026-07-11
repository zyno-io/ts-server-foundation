import { ReflectionClass, ReflectionKind, type Type } from '../reflection';

import { type BaseEntityClassType, createPersistedEntity, type NewEntityFields } from '../database';

const SchemaSymbol = Symbol('Schema');

export type StringifiedDates<T> = {
    [K in keyof T]: NonNullable<T[K]> extends Date ? string | T[K] : T[K];
};

export type TestFields<T extends BaseEntityClassType> = StringifiedDates<NewEntityFields<InstanceType<T>>>;
export type MockData<T extends BaseEntityClassType> = TestFields<T> & {
    [SchemaSymbol]: T;
};

export function defineEntityFixtures<T extends BaseEntityClassType, K extends PropertyKey>(
    cls: T,
    data: { [P in K]: TestFields<T> }
): { [P in K]: MockData<T> } {
    for (const key in data) {
        Object.defineProperty(data[key], SchemaSymbol, { enumerable: false, value: cls });
    }
    return data as { [P in K]: MockData<T> };
}

export function prepareEntityFixtures<T extends BaseEntityClassType>(entity: T, data: TestFields<T>): NewEntityFields<InstanceType<T>> {
    const result: Record<string | number | symbol, unknown> = { ...data };
    const dateProperties = ReflectionClass.from(entity)
        .getProperties()
        .filter(property => isDatePropertyType(property.getType()))
        .map(property => property.getNameAsString());
    for (const property of dateProperties) {
        if (typeof result[property] === 'string') result[property] = new Date(result[property] as string);
    }
    return result as NewEntityFields<InstanceType<T>>;
}

export async function loadEntityFixtures(entities: readonly MockData<BaseEntityClassType>[]): Promise<void> {
    for (const entity of entities) {
        const data = prepareEntityFixtures(entity[SchemaSymbol], entity);
        await createPersistedEntity(entity[SchemaSymbol], data);
    }
}

function isDatePropertyType(type: Type): boolean {
    if (isDate(type)) return true;
    if (type.kind === ReflectionKind.intersection) return type.types.some(isDatePropertyType);
    if (type.kind !== ReflectionKind.union) return false;
    const concrete = type.types.filter(item => item.kind !== ReflectionKind.undefined && item.kind !== ReflectionKind.null);
    return concrete.length > 0 && concrete.every(isDatePropertyType);
}

function isDate(type: Type): boolean {
    return type.kind === ReflectionKind.class && (type.classType === Date || type.classType.name === 'Date');
}
