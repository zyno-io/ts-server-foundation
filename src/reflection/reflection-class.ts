import { databaseAnnotation } from './annotations';
import { applyMetadataOptions, classMetadata, classOptions } from './metadata-store';
import { allowsNull, allowsUndefined, normalizeTypeMetadata, resolveClassType, unwrapValueType } from './type-utils';
import {
    ReflectionKind,
    type ClassMetadata,
    type ClassType,
    type MethodMetadata,
    type ParameterMetadata,
    type PropertyMetadata,
    type ReceiveType,
    type Type
} from './model';

export function typeOf<T>(type?: Type): ReceiveType<T> {
    if (!type) throw new Error('typeOf<T>() was not transformed by the metadata compiler');
    normalizeTypeMetadata(type);
    return type as ReceiveType<T>;
}

export function registerClassMetadata(target: ClassType, metadata: ClassMetadata): void {
    metadata.classType = target;
    applyMetadataOptions(metadata, classOptions.get(target));
    classMetadata.set(target, metadata);
}

export class ReflectionClass<T = any> {
    readonly name: string;
    readonly indexes: { names: (string | number | symbol)[]; options: Record<string, any> }[];
    private readonly metadata: ClassMetadata;

    private constructor(
        private readonly classType: ClassType<T>,
        metadata: ClassMetadata
    ) {
        this.metadata = metadata;
        this.name = metadata.name || classType.name;
        const propertyIndexes = metadata.properties.flatMap(property => {
            const result: { names: (string | number | symbol)[]; options: Record<string, any> }[] = [];
            if (property.index) result.push({ names: [property.name], options: property.index });
            if (property.unique) result.push({ names: [property.name], options: { ...property.unique, unique: true } });
            return result;
        });
        this.indexes = [...(metadata.indexes ?? []), ...propertyIndexes];
    }

    static from<T>(classType: ClassType<T>): ReflectionClass<T> {
        const metadata = readClassMetadata(classType);
        if (!metadata) {
            throw new Error(`No runtime type metadata for ${classType.name}. Did the tsf metadata compiler run?`);
        }
        return new ReflectionClass(classType, metadata);
    }

    getClassType(): ClassType<T> {
        return this.classType;
    }

    getCollectionName(): string | undefined {
        return this.metadata.collectionName ?? classOptions.get(this.classType)?.collectionName;
    }

    isDatabaseMigrationSkipped(_dialect: string): boolean {
        return this.metadata.excludeMigration === true || classOptions.get(this.classType)?.excludeMigration === true;
    }

    getProperties(): ReflectionProperty[] {
        return collectClassProperties(this.classType, this.metadata).map(property => new ReflectionProperty(property));
    }

    getProperty(name: string | number | symbol): ReflectionProperty {
        const property = collectClassProperties(this.classType, this.metadata).find(item => item.name === name);
        if (!property) throw new Error(`Property ${String(name)} does not exist on ${this.name}`);
        return new ReflectionProperty(property);
    }

    getPrimary(): ReflectionProperty {
        const property = collectClassProperties(this.classType, this.metadata).find(item => item.primaryKey);
        if (!property) throw new Error(`Class ${this.name} has no primary key`);
        return new ReflectionProperty(property);
    }

    getMethod(name: string | symbol): ReflectionMethod {
        const method = collectClassMethods(this.classType, this.metadata).find(item => item.name === name || String(item.name) === String(name));
        if (!method) throw new Error(`Method ${String(name)} does not exist on ${this.name}`);
        return new ReflectionMethod(method);
    }

    getConstructorOrUndefined(): ReflectionMethod | undefined {
        const parameters = collectClassConstructorParameters(this.classType, this.metadata);
        if (!parameters.length) return undefined;
        return new ReflectionMethod({
            name: 'constructor',
            parameters,
            returnType: { kind: ReflectionKind.void }
        });
    }
}

export class ReflectionProperty {
    readonly type: Type;
    readonly name: string | number | symbol;

    constructor(private readonly metadata: PropertyMetadata) {
        this.type = metadata.type;
        this.name = metadata.name;
    }

    getNameAsString(): string {
        return String(this.name);
    }

    getType(): Type {
        return this.type;
    }

    getDescription(): string {
        return this.metadata.description ?? '';
    }

    isPublic(): boolean {
        return true;
    }

    isPrimaryKey(): boolean {
        return this.metadata.primaryKey === true;
    }

    isAutoIncrement(): boolean {
        return this.metadata.autoIncrement === true;
    }

    isOptional(): boolean {
        return this.metadata.optional === true || allowsUndefined(this.type);
    }

    isNullable(): boolean {
        return allowsNull(this.type);
    }

    getDatabase<T = any>(dialect: string = '*'): T | undefined {
        const direct = databaseAnnotation.getDatabase<T>(this.type, dialect);
        if (direct) return direct;
        return databaseAnnotation.getDatabase<T>(this.type, '*');
    }

    isBackReference(): boolean {
        return false;
    }

    isDatabaseSkipped(_dialect: string): boolean {
        return false;
    }

    isDatabaseMigrationSkipped(_dialect: string): boolean {
        return false;
    }

    isReference(): boolean {
        return this.metadata.reference !== undefined;
    }

    getReference<T = any>(): T | undefined {
        return this.metadata.reference as T | undefined;
    }

    getResolvedReflectionClass(): ReflectionClass {
        const concrete = unwrapValueType(this.type);
        if (concrete.kind !== ReflectionKind.class) {
            throw new Error(`Property ${String(this.name)} is not a class reference`);
        }
        return ReflectionClass.from(resolveClassType(concrete.classType));
    }
}

export class ReflectionMethod {
    constructor(private readonly metadata: MethodMetadata) {}

    getDescription(): string {
        return this.metadata.description ?? '';
    }

    getParameters(): ReflectionParameter[] {
        return this.metadata.parameters.map(parameter => new ReflectionParameter(parameter));
    }

    getReturnType(): Type {
        return this.metadata.returnType;
    }
}

export class ReflectionParameter {
    constructor(private readonly metadata: ParameterMetadata) {}

    getName(): string {
        return this.metadata.name;
    }

    getType(): Type {
        return this.metadata.type;
    }

    isOptional(): boolean {
        return this.metadata.optional === true || allowsUndefined(this.metadata.type);
    }

    hasDefault(): boolean {
        return this.metadata.default === true;
    }
}

export function readClassMetadata(target: Function): ClassMetadata | undefined {
    const cached = classMetadata.get(target);
    if (cached) {
        normalizeTypeMetadata(cached);
        return cached;
    }
    const metadata = Object.prototype.hasOwnProperty.call(target, '__tsfType')
        ? (target as Function & { __tsfType?: ClassMetadata }).__tsfType
        : undefined;
    if (!metadata) {
        const base = readBaseClass(target);
        if (!base) return undefined;
        const synthetic: ClassMetadata = {
            kind: ReflectionKind.class,
            classType: target as ClassType,
            name: target.name,
            typeName: target.name,
            properties: [],
            methods: [],
            constructorParameters: [],
            hasConstructor: true
        };
        applyMetadataOptions(synthetic, classOptions.get(target));
        classMetadata.set(target, synthetic);
        return synthetic;
    }
    const options = classOptions.get(target);
    applyMetadataOptions(metadata, options);
    normalizeTypeMetadata(metadata);
    classMetadata.set(target, metadata);
    return metadata;
}

function collectClassProperties(target: Function, metadata: ClassMetadata): PropertyMetadata[] {
    const base = readBaseClass(target);
    const inherited = base ? collectClassProperties(base.classType, base.metadata) : [];
    const ownNames = new Set(metadata.properties.map(property => property.name));
    return [...inherited.filter(property => !ownNames.has(property.name)), ...metadata.properties];
}

function collectClassMethods(target: Function, metadata: ClassMetadata): MethodMetadata[] {
    const base = readBaseClass(target);
    const inherited = base ? collectClassMethods(base.classType, base.metadata) : [];
    const ownNames = new Set(metadata.methods.map(method => method.name));
    return [...inherited.filter(method => !ownNames.has(method.name)), ...metadata.methods];
}

function collectClassConstructorParameters(target: Function, metadata: ClassMetadata): ParameterMetadata[] {
    if (metadata.constructorParameters.length || metadata.hasConstructor) return metadata.constructorParameters;
    const base = readBaseClass(target);
    return base ? collectClassConstructorParameters(base.classType, base.metadata) : [];
}

function readBaseClass(target: Function): { classType: ClassType; metadata: ClassMetadata } | undefined {
    const basePrototype = target.prototype ? Object.getPrototypeOf(target.prototype) : undefined;
    const classType = basePrototype?.constructor as ClassType | undefined;
    if (!classType || classType === Object || classType === target) return undefined;
    const metadata = readClassMetadata(classType);
    return metadata ? { classType, metadata } : undefined;
}
