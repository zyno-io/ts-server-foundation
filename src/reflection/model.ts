export enum ReflectionKind {
    never = 0,
    any = 1,
    unknown = 2,
    void = 3,
    undefined = 4,
    null = 5,
    string = 6,
    number = 7,
    boolean = 8,
    bigint = 9,
    literal = 10,
    enum = 11,
    union = 12,
    intersection = 13,
    array = 14,
    tuple = 15,
    class = 16,
    object = 17,
    objectLiteral = 18,
    property = 19,
    propertySignature = 20,
    method = 21,
    promise = 22,
    templateLiteral = 23
}

export type ClassType<T = any> = new (...args: any[]) => T;
export type AbstractClassType<T = any> = abstract new (...args: any[]) => T;

export interface TypeBase<K extends ReflectionKind = ReflectionKind> {
    kind: K;
    typeName?: string;
    description?: string;
    parent?: Type;
    annotations?: Record<string, Type>;
    validation?: ValidationAnnotation[];
    database?: Record<string, Record<string, any>>;
}

export type PrimitiveReflectionKind =
    | ReflectionKind.never
    | ReflectionKind.any
    | ReflectionKind.unknown
    | ReflectionKind.void
    | ReflectionKind.undefined
    | ReflectionKind.null
    | ReflectionKind.string
    | ReflectionKind.number
    | ReflectionKind.boolean
    | ReflectionKind.bigint
    | ReflectionKind.object
    | ReflectionKind.method
    | ReflectionKind.templateLiteral;

export type TypePrimitive = TypeBase<PrimitiveReflectionKind>;
export type TypeLiteral = TypeBase<ReflectionKind.literal> & { literal: unknown };
export type TypeEnum = TypeBase<ReflectionKind.enum> & { values: unknown[] };
export type TypeUnion = TypeBase<ReflectionKind.union> & { types: Type[] };
export type TypeIntersection = TypeBase<ReflectionKind.intersection> & { types: Type[] };
export type TypeArray = TypeBase<ReflectionKind.array> & { type: Type };
export type TypePromise = TypeBase<ReflectionKind.promise> & { type: Type };
export type TypeTupleEntry = Type & { type: Type };
export type TypeTuple = TypeBase<ReflectionKind.tuple> & { types: TypeTupleEntry[] };
export type TypeClass = TypeBase<ReflectionKind.class> & { classType: ClassType };
export type TypeObjectLiteral = TypeBase<ReflectionKind.objectLiteral> & {
    types: TypePropertySignature[];
    index?: Type;
    implements?: Type[];
};
export type TypeProperty = TypeBase<ReflectionKind.property> & {
    name: string | number | symbol;
    type: Type;
    optional?: boolean;
};

export type Type =
    | TypePrimitive
    | TypeLiteral
    | TypeEnum
    | TypeUnion
    | TypeIntersection
    | TypeArray
    | TypePromise
    | TypeTuple
    | TypeClass
    | TypeObjectLiteral
    | TypeProperty
    | TypePropertySignature;
export type ReceiveType<T = any> = Type & { readonly __receiveType?: T };

export function isReflectedType(value: unknown): value is Type {
    return !!value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'number';
}

export interface TypePropertySignature extends TypeBase<ReflectionKind.propertySignature> {
    kind: ReflectionKind.propertySignature;
    name: string | number | symbol;
    type: Type;
    optional?: boolean;
}

export interface ValidationAnnotation {
    name: string;
    args: Type[];
}

export interface PropertyMetadata {
    name: string | number | symbol;
    type: Type;
    optional?: boolean;
    primaryKey?: boolean;
    autoIncrement?: boolean;
    reference?: Record<string, any>;
    index?: Record<string, any>;
    unique?: Record<string, any>;
    description?: string;
}

export interface ParameterMetadata {
    name: string;
    type: Type;
    optional?: boolean;
    default?: boolean;
}

export interface MethodMetadata {
    name: string | symbol;
    parameters: ParameterMetadata[];
    returnType: Type;
    description?: string;
}

export interface ClassMetadata extends TypeBase<ReflectionKind.class> {
    kind: ReflectionKind.class;
    classType: ClassType;
    name: string;
    properties: PropertyMetadata[];
    methods: MethodMetadata[];
    constructorParameters: ParameterMetadata[];
    hasConstructor?: boolean;
    collectionName?: string;
    indexes?: EntityIndexMetadata[];
    excludeMigration?: boolean;
}

// Marker aliases intentionally share one structural optional field so intersections
// such as `string & TypeAnnotation<"a"> & TypeAnnotation<"b">` stay assignable.
declare const TypeAnnotationSymbol: unique symbol;
export type TypeAnnotation<Name extends string, Value = undefined> = {
    readonly [TypeAnnotationSymbol]?: unknown;
};

export type TypiaTagTarget = 'boolean' | 'bigint' | 'number' | 'string' | 'array' | 'object';
export type TypiaTagBase<Tag extends { target: TypiaTagTarget; kind: string; value?: unknown }> = {
    readonly 'typia.tag'?: Tag;
};
export type TypiaFormat<Value extends string> = TypiaTagBase<{
    target: 'string';
    kind: 'format';
    value: Value;
    exclusive: true;
    schema: { format: Value };
}>;
export type TsfTypiaTag<Target extends TypiaTagTarget, Kind extends string, Value = undefined> = TypiaTagBase<{
    target: Target;
    kind: Kind;
    value: Value;
}>;
export type TsfTypiaSchemaTag<Target extends TypiaTagTarget, Kind extends string, Value, Schema extends object> = TypiaTagBase<{
    target: Target;
    kind: Kind;
    value: Value;
    schema: Schema;
}>;
export type TsfTypeTag<Target extends TypiaTagTarget, Name extends string> = TsfTypiaTag<Target, 'tsf:type', Name>;
export type TsfValidatorTag<Target extends TypiaTagTarget, Name extends string> = TsfTypiaTag<Target, 'tsf:validator', Name>;
export type TsfDatabaseTag<Kind extends string, Options extends object = {}> = TsfTypiaSchemaTag<TypiaTagTarget, Kind, '*', Options>;
export type TsfDatabaseFieldTag<Options extends object> = TypeAnnotation<'database:field', Options>;
export type PrimaryKey = TsfTypiaTag<TypiaTagTarget, 'database:primaryKey', true>;
export type AutoIncrement = TsfTypiaTag<TypiaTagTarget, 'database:autoIncrement', true>;
export type Unique<Options extends object = {}> = TsfDatabaseTag<'database:unique', Options>;
export type Index<Options extends object = {}> = TsfDatabaseTag<'database:index', Options>;
export type Indexed<T, Options extends object = {}> = T extends null | undefined ? T : T & Index<Options>;
export type Reference<Options extends object = {}> = TsfDatabaseTag<'database:reference', Options>;
export type DatabaseField<Options extends object = {}> = TsfDatabaseFieldTag<Options>;
export type MySQL<Options extends object = {}> = TypeAnnotation<'database:mysql', Options>;
export type Pattern<T extends string> = TypiaTagBase<{
    target: 'string';
    kind: 'pattern';
    value: T;
    schema: { pattern: T };
}>;
export type MinLength<T extends number> = TypiaTagBase<{
    target: 'string';
    kind: 'minLength';
    value: T;
    validate: `${T} <= $input.length`;
    exclusive: true;
    schema: { minLength: T };
}>;
export type MaxLength<T extends number> = TypiaTagBase<{
    target: 'string';
    kind: 'maxLength';
    value: T;
    validate: `$input.length <= ${T}`;
    exclusive: true;
    schema: { maxLength: T };
}>;
export type Minimum<T extends number> = TypiaTagBase<{
    target: 'number';
    kind: 'minimum';
    value: T;
    validate: `${T} <= $input`;
    exclusive: true;
    schema: { minimum: T };
}>;
export type GreaterThan<T extends number> = TypiaTagBase<{
    target: 'number';
    kind: 'greaterThan';
    value: T;
    validate: `${T} < $input`;
    exclusive: true;
    schema: { exclusiveMinimum: T };
}>;
export type Maximum<T extends number> = TypiaTagBase<{
    target: 'number';
    kind: 'maximum';
    value: T;
    validate: `$input <= ${T}`;
    exclusive: true;
    schema: { maximum: T };
}>;
export type LessThan<T extends number> = TypiaTagBase<{
    target: 'number';
    kind: 'lessThan';
    value: T;
    validate: `$input < ${T}`;
    exclusive: true;
    schema: { exclusiveMaximum: T };
}>;
export type Validate<T> = T extends string ? TsfValidatorTag<TypiaTagTarget, T> : TypeAnnotation<'validation:custom', T>;
export type UUID = string & TypiaFormat<'uuid'> & TsfTypeTag<'string', 'uuid'>;
export type integer = number & TsfTypiaTag<'number', 'type', 'int32'> & TsfTypeTag<'number', 'integer'>;
export type HttpBody<T> = T & TypeAnnotation<'httpBody', { type: T }>;
export type HttpQueries<T> = T & TypeAnnotation<'httpQueries', { type: T }>;
export type HttpQuery<T, Options extends { name?: string } = {}> = T & TypeAnnotation<'httpQuery', Options & { type: T }>;
export type HttpPath<T, Options extends { name?: string } = {}> = T & TypeAnnotation<'httpPath', Options & { type: T }>;
export type HttpHeader<T, Options extends { name?: string } = {}> = T & TypeAnnotation<'httpHeader', Options & { type: T }>;
export type ApiName<T extends string> = TypeAnnotation<'openapi:name', T>;
export type ApiType<Name extends string, T> = T & ApiName<Name>;
export type ApiResponse<T, Status extends number = 200> = Promise<T>;

export type EntityIndexMetadata = { names: (string | number | symbol)[]; options: Record<string, any> };
