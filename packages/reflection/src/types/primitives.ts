export type ConcretePrimitive = string | number | boolean;
export type DefinedPrimitive = ConcretePrimitive | null;
export type Primitive = DefinedPrimitive | undefined;
export type StrictBool = true | false;
export type KVObject<T = any> = Record<string, T>;
export type NestedKVObject<T = any> = KVObject<T | T[] | KVObject<T>>;
export type Serializable<T = ConcretePrimitive> = T | T[] | NestedKVObject<T> | NestedKVObject<T>[];

export type RequireFields<T, K extends keyof T> = T & {
    [P in K]-?: T[P];
};

type NullUnionKeys<T extends object> = {
    [K in keyof T]-?: null extends T[K] ? K : never;
}[keyof T];

type Simplify<T> = {
    [K in keyof T]: T[K];
};

export type Overwrite<A extends object, B extends object> = Simplify<Omit<A, keyof B> & B>;
export type OptionalNulls<T extends object> = Simplify<Omit<T, NullUnionKeys<T>> & Partial<Pick<T, NullUnionKeys<T>>>>;

export type StringKeyOf<T> = Extract<keyof T, string>;
export type ObjectKeysMatching<O extends object, V> = {
    [K in StringKeyOf<O>]: O[K] extends V ? (O[K] extends (...args: any[]) => any ? never : K) : V extends O[K] ? K : never;
}[StringKeyOf<O>];

export type ArrowFunction = (...args: any[]) => any;
export type ArrowFunctionNoArgs = () => any;
export type VoidFunction = () => void;

type IfAny<T, Y, N> = 0 extends 1 & T ? Y : N;
type DefinitelyFunction<T> = IfAny<T, never, T extends (...args: any[]) => any ? T : never>;

export type MethodsOf<T> = {
    [K in keyof T as DefinitelyFunction<T[K]> extends never ? never : K]: T[K];
};

export type MethodKeys<T> = keyof MethodsOf<T>;
