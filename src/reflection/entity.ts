import { readClassMetadata } from './reflection-class';
import {
    applyMetadataOptions,
    classOptions,
    type EntityClassDecorator,
    type EntityOptions,
    type GeneratedColumnOptions,
    type GeneratedColumnStorage
} from './metadata-store';

type EntityDecorator = (<T extends Function>(target: T) => T) & {
    name(name: string): EntityClassDecorator;
    index(names: readonly (string | number | symbol)[], options?: Record<string, any>): EntityClassDecorator;
    excludeMigration(): EntityClassDecorator;
    generated(expression: string, options?: { storage?: GeneratedColumnStorage }): PropertyDecorator;
};

export const entity = function entityDecorator<T extends Function>(target: T): T {
    applyClassOptions(target, {});
    return target;
} as EntityDecorator;

Object.defineProperty(entity, 'name', {
    configurable: true,
    value(name: string) {
        return createEntityDecorator({ collectionName: name });
    }
});

Object.defineProperty(entity, 'index', {
    configurable: true,
    value(names: readonly (string | number | symbol)[], options: Record<string, any> = {}) {
        return createEntityDecorator({ indexes: [{ names: [...names], options }] });
    }
});

Object.defineProperty(entity, 'excludeMigration', {
    configurable: true,
    value() {
        return createEntityDecorator({ excludeMigration: true });
    }
});

Object.defineProperty(entity, 'generated', {
    configurable: true,
    value(expression: string, options: { storage?: GeneratedColumnStorage } = {}) {
        const generated = normalizeGeneratedColumnOptions(expression, options.storage);
        return (target: object, propertyKey: string | symbol) => {
            if (typeof propertyKey !== 'string') throw new Error('Generated columns require a string property name');
            applyClassOptions(target.constructor, { generatedColumns: { [propertyKey]: generated } });
        };
    }
});

function ensureClassOptions(target: Function): EntityOptions {
    let options = classOptions.get(target);
    if (!options) {
        options = {};
        classOptions.set(target, options);
    }
    return options;
}

function createEntityDecorator(options: EntityOptions): EntityClassDecorator {
    const decorator = function compatibleEntityDecorator<T extends Function>(target: T): T {
        applyClassOptions(target, options);
        return target;
    } as EntityClassDecorator;

    Object.defineProperty(decorator, 'index', {
        configurable: true,
        value(names: readonly (string | number | symbol)[], indexOptions: Record<string, any> = {}) {
            return createEntityDecorator({
                ...options,
                indexes: [...(options.indexes ?? []), { names: [...names], options: indexOptions }]
            });
        }
    });

    Object.defineProperty(decorator, 'excludeMigration', {
        configurable: true,
        value() {
            return createEntityDecorator({
                ...options,
                excludeMigration: true
            });
        }
    });

    return decorator;
}

function applyClassOptions(target: Function, incoming: EntityOptions): void {
    const options = ensureClassOptions(target);
    if (incoming.collectionName) options.collectionName = incoming.collectionName;
    if (incoming.indexes?.length) options.indexes = [...(options.indexes ?? []), ...incoming.indexes];
    if (incoming.excludeMigration) options.excludeMigration = true;
    if (incoming.generatedColumns) options.generatedColumns = { ...options.generatedColumns, ...incoming.generatedColumns };

    const metadata = readClassMetadata(target);
    if (metadata) applyMetadataOptions(metadata, options);
}

function normalizeGeneratedColumnOptions(expression: string, storage: GeneratedColumnStorage | undefined): GeneratedColumnOptions {
    if (!expression.trim()) throw new Error('Generated column expressions must not be empty');
    if (storage !== undefined && storage !== 'virtual' && storage !== 'stored') {
        throw new Error(`Unsupported generated column storage ${storage}`);
    }
    return { expression, storage: storage ?? 'virtual' };
}
