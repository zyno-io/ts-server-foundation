import type { ClassMetadata, EntityIndexMetadata } from './model';

export type EntityOptions = {
    collectionName?: string;
    indexes?: EntityIndexMetadata[];
    excludeMigration?: boolean;
};

export type EntityClassDecorator = ClassDecorator & {
    index(names: readonly (string | number | symbol)[], options?: Record<string, any>): EntityClassDecorator;
    excludeMigration(): EntityClassDecorator;
};

export const classMetadata = new WeakMap<Function, ClassMetadata>();
export const classOptions = new WeakMap<Function, EntityOptions>();

export function applyMetadataOptions(metadata: ClassMetadata, options?: EntityOptions): void {
    if (!options) return;
    if (options.collectionName) metadata.collectionName = options.collectionName;
    if (options.indexes?.length) metadata.indexes = [...options.indexes];
    if (options.excludeMigration) metadata.excludeMigration = true;
}
