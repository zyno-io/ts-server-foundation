const compactMetadataVersion = 1;
const compactMetadataReferenceKey = '$tsf';
const compactMetadataImportKey = '$tsfImport';
const compactMetadataAliasKey = '$tsfAlias';
const compactMetadataTypeKey = '$tsfType';
const compactMetadataNodeKey = '$tsfNode';

type CompactMetadataEnvelope = [version: number, value: unknown];
type CompactMetadataEnvelopeV2 = [version: number, value: unknown, nodes: unknown[]];

/**
 * Reconstruct metadata serialized by the native type compiler.
 *
 * Generated metadata is almost entirely JSON data. Values that must retain
 * JavaScript semantics (constructors, lazy functions, imported metadata,
 * `undefined`, bigint literals, and similar expressions) are supplied through
 * a small side table and represented in the JSON payload by indexed markers.
 *
 * This function is a generated-code ABI. Keep the version in its exported name
 * when adding a new wire format so old compiled applications fail explicitly
 * instead of being decoded with different semantics.
 */
export function decodeCompactMetadataV1<T>(serialized: string, references: readonly unknown[], resolveType?: (index: number) => unknown): T {
    return reviveCompactMetadata(parseCompactMetadataEnvelope(serialized), references, resolveType) as T;
}

/**
 * Lazily reconstruct metadata serialized by the native type compiler.
 *
 * V2 stores repeated object and array subtrees in a graph table. The returned
 * proxy intentionally does not parse that table until metadata is inspected.
 * Compiler-generated assignments such as `metadata.classType = Target` are
 * retained as overrides and therefore do not force eager materialization.
 */
export function decodeCompactMetadataV2<T extends object>(
    serialized: string,
    references: readonly unknown[],
    resolveType?: (index: number) => unknown
): T {
    return lazyCompactMetadata(() => {
        const [encoded, nodes] = parseCompactMetadataEnvelopeV2(serialized);
        const resolveNode = createCompactMetadataNodeResolver(nodes, references, resolveType);
        return reviveCompactMetadata(encoded, references, resolveType, resolveNode);
    }) as T;
}

/** Create one lazy metadata-type registry for a generated module. */
export function createCompactMetadataRegistryV1(serialized: string, references: readonly unknown[]): (index: number) => unknown {
    const encoded = parseCompactMetadataEnvelope(serialized);
    if (!Array.isArray(encoded)) throw new Error('Invalid TSF compact metadata registry');
    const resolved: unknown[] = Array.from({ length: encoded.length });
    const initialized = new Uint8Array(encoded.length);
    const resolveType = (index: number): unknown => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= encoded.length) {
            throw new Error(`Invalid TSF compact metadata type ${index}`);
        }
        if (!initialized[index]) {
            // Publish the encoded object before walking it so recursive type
            // graphs resolve to the same object instead of recursing forever.
            initialized[index] = 1;
            resolved[index] = encoded[index];
            resolved[index] = reviveCompactMetadata(encoded[index], references, resolveType);
        }
        return resolved[index];
    };
    return resolveType;
}

/** Create one fully lazy V2 metadata-type registry for a generated module. */
export function createCompactMetadataRegistryV2(serialized: string, references: readonly unknown[]): (index: number) => unknown {
    let encoded: unknown[] | undefined;
    let resolveNode: ((index: number) => unknown) | undefined;
    let resolved: unknown[] | undefined;
    let initialized: Uint8Array | undefined;
    const resolveType = (index: number): unknown => {
        if (!encoded) {
            const [root, nodes] = parseCompactMetadataEnvelopeV2(serialized);
            if (!Array.isArray(root)) throw new Error('Invalid TSF compact metadata registry');
            encoded = root;
            resolved = Array.from({ length: root.length });
            initialized = new Uint8Array(root.length);
            resolveNode = createCompactMetadataNodeResolver(nodes, references, resolveType);
        }
        if (!Number.isSafeInteger(index) || index < 0 || index >= encoded.length) {
            throw new Error(`Invalid TSF compact metadata type ${index}`);
        }
        if (!initialized![index]) {
            initialized![index] = 1;
            resolved![index] = encoded[index];
            resolved![index] = reviveCompactMetadata(encoded[index], references, resolveType, resolveNode);
        }
        return resolved![index];
    };
    return resolveType;
}

/** Resolve metadata published by a type-only external import at first use. */
export function resolveCompactMetadataAliasV1(
    loadModule: (() => unknown) | ((specifier: string) => unknown),
    specifierOrExportName: string,
    exportNameOrTypeName: string,
    maybeTypeName?: string
): unknown {
    const [load, exportName, typeName] =
        maybeTypeName === undefined
            ? [loadModule as () => unknown, specifierOrExportName, exportNameOrTypeName]
            : [() => (loadModule as (specifier: string) => unknown)(specifierOrExportName), exportNameOrTypeName, maybeTypeName];
    let imported: Record<string, unknown> | undefined;
    try {
        const loaded = load();
        if (loaded && typeof loaded === 'object') imported = loaded as Record<string, unknown>;
    } catch {
        // A declaration-only package has no runtime module. Preserve the
        // previous unknown-class fallback instead of failing module evaluation.
    }
    const aliases = imported?.__tsfTypeAliases as Record<string, unknown> | undefined;
    const alias = aliases?.[exportName];
    if (alias && typeof alias === 'object') return { ...(alias as object), typeName };
    return {
        kind: 16,
        typeName,
        classType: () => imported?.[exportName]
    };
}

function parseCompactMetadataEnvelope(serialized: string): unknown {
    const envelope = JSON.parse(serialized) as CompactMetadataEnvelope;
    if (!Array.isArray(envelope) || envelope.length !== 2 || envelope[0] !== compactMetadataVersion) {
        throw new Error('Unsupported TSF compact metadata format');
    }
    return envelope[1];
}

function parseCompactMetadataEnvelopeV2(serialized: string): [value: unknown, nodes: unknown[]] {
    const envelope = JSON.parse(serialized) as CompactMetadataEnvelopeV2;
    if (!Array.isArray(envelope) || envelope.length !== 3 || envelope[0] !== 2 || !Array.isArray(envelope[2])) {
        throw new Error('Unsupported TSF compact metadata format');
    }
    return [envelope[1], envelope[2]];
}

function reviveCompactMetadata(
    value: unknown,
    references: readonly unknown[],
    resolveType?: (index: number) => unknown,
    resolveNode?: (index: number) => unknown
): unknown {
    if (!value || typeof value !== 'object') return value;
    if (isCompactMetadataReference(value)) {
        return compactMetadataReference(references, value[compactMetadataReferenceKey]);
    }
    if (isCompactMetadataImport(value)) {
        const recipe = value[compactMetadataImportKey];
        const [index, exportName] = recipe.length === 2 ? recipe : [recipe[0], recipe[2]];
        const loadModule = compactMetadataModuleLoader(references, index, recipe.length === 3 ? recipe[1] : undefined);
        return () => (loadModule() as Record<string, unknown> | undefined)?.[exportName];
    }
    if (isCompactMetadataAlias(value)) {
        const recipe = value[compactMetadataAliasKey];
        const [index, exportName, typeName] = recipe.length === 3 ? recipe : [recipe[0], recipe[2], recipe[3]];
        return resolveCompactMetadataAliasV1(
            compactMetadataModuleLoader(references, index, recipe.length === 4 ? recipe[1] : undefined),
            exportName,
            typeName
        );
    }
    if (isCompactMetadataType(value)) {
        if (!resolveType) throw new Error('Missing TSF compact metadata type registry');
        return resolveType(value[compactMetadataTypeKey]);
    }
    if (isCompactMetadataNode(value)) {
        if (!resolveNode) throw new Error('Missing TSF compact metadata node registry');
        return resolveNode(value[compactMetadataNodeKey]);
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            value[index] = reviveCompactMetadata(value[index], references, resolveType, resolveNode);
        }
        return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        record[key] = reviveCompactMetadata(record[key], references, resolveType, resolveNode);
    }
    return record;
}

function createCompactMetadataNodeResolver(
    encoded: unknown[],
    references: readonly unknown[],
    resolveType?: (index: number) => unknown
): (index: number) => unknown {
    const resolved: unknown[] = Array.from({ length: encoded.length });
    const initialized = new Uint8Array(encoded.length);
    const resolveNode = (index: number): unknown => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= encoded.length) {
            throw new Error(`Invalid TSF compact metadata node ${index}`);
        }
        if (!initialized[index]) {
            initialized[index] = 1;
            resolved[index] = encoded[index];
            resolved[index] = reviveCompactMetadata(encoded[index], references, resolveType, resolveNode);
        }
        return resolved[index];
    };
    return resolveNode;
}

function lazyCompactMetadata(load: () => unknown): object {
    const target: Record<PropertyKey, unknown> = {};
    let initialized = false;
    const initialize = (): void => {
        if (initialized) return;
        const value = load();
        if (!value || typeof value !== 'object') throw new Error('Invalid TSF compact metadata root');
        for (const key of Reflect.ownKeys(value)) {
            if (Object.prototype.hasOwnProperty.call(target, key)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor) Object.defineProperty(target, key, descriptor);
        }
        initialized = true;
    };
    return new Proxy(target, {
        get(current, key, receiver) {
            initialize();
            return Reflect.get(current, key, receiver);
        },
        set(current, key, value) {
            return Reflect.set(current, key, value, current);
        },
        has(current, key) {
            initialize();
            return Reflect.has(current, key);
        },
        ownKeys(current) {
            initialize();
            return Reflect.ownKeys(current);
        },
        getOwnPropertyDescriptor(current, key) {
            initialize();
            return Reflect.getOwnPropertyDescriptor(current, key);
        },
        defineProperty(current, key, descriptor) {
            return Reflect.defineProperty(current, key, descriptor);
        },
        deleteProperty(current, key) {
            initialize();
            return Reflect.deleteProperty(current, key);
        },
        getPrototypeOf(current) {
            initialize();
            return Reflect.getPrototypeOf(current);
        },
        setPrototypeOf(current, prototype) {
            initialize();
            return Reflect.setPrototypeOf(current, prototype);
        },
        isExtensible(current) {
            return Reflect.isExtensible(current);
        },
        preventExtensions(current) {
            initialize();
            return Reflect.preventExtensions(current);
        }
    });
}

function compactMetadataReference(references: readonly unknown[], index: number): unknown {
    if (index < 0 || index >= references.length) {
        throw new Error(`Invalid TSF compact metadata reference ${index}`);
    }
    return references[index];
}

function compactMetadataModuleLoader(references: readonly unknown[], index: number, specifier?: string): () => unknown {
    const reference = compactMetadataReference(references, index);
    if (typeof reference !== 'function') {
        throw new Error(`Invalid TSF compact metadata module loader ${index}`);
    }
    if (specifier === undefined) return reference as () => unknown;
    return () => {
        try {
            return (reference as (moduleSpecifier: string) => unknown)(specifier);
        } catch {
            return undefined;
        }
    };
}

function isCompactMetadataReference(value: object): value is Record<typeof compactMetadataReferenceKey, number> {
    if (Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
        keys.length === 1 &&
        keys[0] === compactMetadataReferenceKey &&
        Number.isSafeInteger((value as Record<string, unknown>)[compactMetadataReferenceKey])
    );
}

function isCompactMetadataImport(
    value: object
): value is Record<
    typeof compactMetadataImportKey,
    [loaderReference: number, exportName: string] | [requireReference: number, moduleSpecifier: string, exportName: string]
> {
    if (Array.isArray(value)) return false;
    const keys = Object.keys(value);
    const recipe = (value as Record<string, unknown>)[compactMetadataImportKey];
    return (
        keys.length === 1 &&
        keys[0] === compactMetadataImportKey &&
        Array.isArray(recipe) &&
        (recipe.length === 2 || recipe.length === 3) &&
        Number.isSafeInteger(recipe[0]) &&
        typeof recipe[1] === 'string' &&
        (recipe.length === 2 || typeof recipe[2] === 'string')
    );
}

function isCompactMetadataAlias(
    value: object
): value is Record<
    typeof compactMetadataAliasKey,
    | [loaderReference: number, exportName: string, typeName: string]
    | [requireReference: number, moduleSpecifier: string, exportName: string, typeName: string]
> {
    if (Array.isArray(value)) return false;
    const keys = Object.keys(value);
    const recipe = (value as Record<string, unknown>)[compactMetadataAliasKey];
    return (
        keys.length === 1 &&
        keys[0] === compactMetadataAliasKey &&
        Array.isArray(recipe) &&
        (recipe.length === 3 || recipe.length === 4) &&
        Number.isSafeInteger(recipe[0]) &&
        typeof recipe[1] === 'string' &&
        typeof recipe[2] === 'string' &&
        (recipe.length === 3 || typeof recipe[3] === 'string')
    );
}

function isCompactMetadataType(value: object): value is Record<typeof compactMetadataTypeKey, number> {
    if (Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
        keys.length === 1 && keys[0] === compactMetadataTypeKey && Number.isSafeInteger((value as Record<string, unknown>)[compactMetadataTypeKey])
    );
}

function isCompactMetadataNode(value: object): value is Record<typeof compactMetadataNodeKey, number> {
    if (Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
        keys.length === 1 && keys[0] === compactMetadataNodeKey && Number.isSafeInteger((value as Record<string, unknown>)[compactMetadataNodeKey])
    );
}
