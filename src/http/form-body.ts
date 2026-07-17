import { HttpBadRequestError, HttpPayloadTooLargeError } from './errors';

export interface FormBodyLimits {
    maxFormFields: number;
    maxFormFieldNameLength: number;
    maxFormDepth: number;
    maxFormArrayIndex: number;
}

export const defaultFormBodyLimits: FormBodyLimits = {
    maxFormFields: 10_000,
    maxFormFieldNameLength: 2_048,
    maxFormDepth: 16,
    maxFormArrayIndex: 10_000
};

type FormPathToken = { kind: 'property'; name: string } | { kind: 'index'; index: number } | { kind: 'append' };

interface ObjectNode {
    kind: 'object';
    children: Map<string, FormNode>;
}

interface IndexedArrayNode {
    kind: 'indexed-array';
    children: Map<number, FormNode>;
}

interface AppendArrayNode {
    kind: 'append-array';
    values: unknown[];
}

interface LeafNode {
    kind: 'leaf';
    values: unknown[];
}

type FormNode = ObjectNode | IndexedArrayNode | AppendArrayNode | LeafNode;
type FormContainerNode = ObjectNode | IndexedArrayNode | AppendArrayNode;

const unsafePropertyNames = new Set(['__proto__', 'prototype', 'constructor']);
const canonicalArrayIndexPattern = /^(?:0|[1-9]\d*)$/;
const numericLikePropertyPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export class FormBodyBuilder {
    private readonly root: ObjectNode = createObjectNode();
    private structureCount = 0;

    constructor(private readonly limits: FormBodyLimits) {}

    add(name: string, value: unknown): void {
        this.consumeStructure();
        const tokens = parseFormFieldPath(name, this.limits);
        insertValue(this.root, tokens, value, name);
    }

    addTopLevelFile(name: string, value: unknown): void {
        assertTopLevelFormFieldName(name, this.limits);
        insertValue(this.root, [{ kind: 'property', name }], value, name);
    }

    mergeObject(value: Record<string, unknown>): void {
        const source = importObjectNode(value, this.limits, () => this.consumeStructure());
        mergeNodes(this.root, source, '');
    }

    merge(builder: FormBodyBuilder): void {
        mergeNodes(this.root, builder.root, '');
    }

    build(): Record<string, unknown> {
        return materializeNode(this.root, '') as Record<string, unknown>;
    }

    private consumeStructure(): void {
        this.structureCount += 1;
        if (this.structureCount > this.limits.maxFormFields) {
            throw new HttpPayloadTooLargeError('Form contains too many fields');
        }
    }
}

export function parseFormUrlEncodedBody(text: string, limits: FormBodyLimits): Record<string, unknown> {
    const builder = new FormBodyBuilder(limits);
    for (const [name, value] of new URLSearchParams(text)) builder.add(name, value);
    return builder.build();
}

export function assertTopLevelFormFieldName(name: string, limits: FormBodyLimits): void {
    const tokens = parseFormFieldPath(name, limits);
    if (tokens.length !== 1 || tokens[0].kind !== 'property') {
        throw new HttpBadRequestError(`File field "${name}" must be a top-level field`);
    }
}

function parseFormFieldPath(name: string, limits: FormBodyLimits): FormPathToken[] {
    if (!name) throw new HttpBadRequestError('Form field name cannot be empty');
    if (name.length > limits.maxFormFieldNameLength) {
        throw new HttpPayloadTooLargeError('Form field name is too long');
    }

    const firstBracket = name.indexOf('[');
    const rootName = firstBracket === -1 ? name : name.slice(0, firstBracket);
    if (!rootName || rootName.includes(']')) throw malformedFieldName(name);

    const tokens: FormPathToken[] = [propertyToken(rootName)];
    let offset = firstBracket === -1 ? name.length : firstBracket;
    while (offset < name.length) {
        if (name[offset] !== '[') throw malformedFieldName(name);
        const closingBracket = name.indexOf(']', offset + 1);
        if (closingBracket === -1) throw malformedFieldName(name);

        const segment = name.slice(offset + 1, closingBracket);
        if (segment.includes('[')) throw malformedFieldName(name);
        tokens.push(parseBracketToken(segment, name, limits));
        offset = closingBracket + 1;
        if (offset < name.length && name[offset] !== '[') throw malformedFieldName(name);
    }

    if (tokens.length > limits.maxFormDepth) {
        throw new HttpPayloadTooLargeError('Form field nesting is too deep');
    }
    const appendIndex = tokens.findIndex(token => token.kind === 'append');
    if (appendIndex !== -1 && appendIndex !== tokens.length - 1) {
        throw new HttpBadRequestError(`Array append notation must be terminal in form field "${name}"`);
    }
    return tokens;
}

function parseBracketToken(segment: string, fieldName: string, limits: FormBodyLimits): FormPathToken {
    if (segment === '') return { kind: 'append' };
    if (/^\d+$/.test(segment)) {
        if (!canonicalArrayIndexPattern.test(segment)) {
            throw new HttpBadRequestError(`Invalid array index in form field "${fieldName}"`);
        }
        const index = Number(segment);
        if (!Number.isSafeInteger(index) || index > limits.maxFormArrayIndex) {
            throw new HttpPayloadTooLargeError(`Array index is too large in form field "${fieldName}"`);
        }
        return { kind: 'index', index };
    }
    if (numericLikePropertyPattern.test(segment)) {
        throw new HttpBadRequestError(`Invalid array index in form field "${fieldName}"`);
    }
    return propertyToken(segment);
}

function propertyToken(name: string): FormPathToken {
    assertSafePropertyName(name);
    return { kind: 'property', name };
}

function assertSafePropertyName(name: string): void {
    if (unsafePropertyNames.has(name)) throw new HttpBadRequestError(`Unsafe form field property "${name}"`);
}

function malformedFieldName(name: string): HttpBadRequestError {
    return new HttpBadRequestError(`Malformed form field name "${name}"`);
}

function insertValue(container: FormContainerNode, tokens: FormPathToken[], value: unknown, fieldName: string, offset = 0): void {
    const token = tokens[offset];
    const last = offset === tokens.length - 1;

    if (container.kind === 'append-array') {
        if (token.kind !== 'append' || !last) throw conflictingStructure(fieldName);
        container.values.push(value);
        return;
    }

    if (container.kind === 'object' && token.kind !== 'property') throw conflictingStructure(fieldName);
    if (container.kind === 'indexed-array' && token.kind !== 'index') throw conflictingStructure(fieldName);
    if (token.kind === 'append') throw conflictingStructure(fieldName);

    const key = token.kind === 'property' ? token.name : token.index;
    const children = container.children as Map<typeof key, FormNode>;
    const existing = children.get(key);
    if (last) {
        if (!existing) {
            children.set(key, { kind: 'leaf', values: [value] });
            return;
        }
        if (existing.kind !== 'leaf') throw conflictingStructure(fieldName);
        existing.values.push(value);
        return;
    }

    const next = tokens[offset + 1];
    const expectedKind = next.kind === 'property' ? 'object' : next.kind === 'index' ? 'indexed-array' : 'append-array';
    let child = existing;
    if (!child) {
        child =
            expectedKind === 'object' ? createObjectNode() : expectedKind === 'indexed-array' ? createIndexedArrayNode() : createAppendArrayNode();
        children.set(key, child);
    } else if (child.kind !== expectedKind) {
        throw conflictingStructure(fieldName);
    }

    insertValue(child as FormContainerNode, tokens, value, fieldName, offset + 1);
}

function conflictingStructure(fieldName: string): HttpBadRequestError {
    return new HttpBadRequestError(`Conflicting form field structure at "${fieldName}"`);
}

function importObjectNode(value: Record<string, unknown>, limits: FormBodyLimits, consumeStructure: () => void): ObjectNode {
    const root = createObjectNode();
    for (const [name, child] of Object.entries(value)) {
        assertSafePropertyName(name);
        consumeStructure();
        root.children.set(name, importJsonNode(child, limits, consumeStructure, 1));
    }
    return root;
}

function importJsonNode(value: unknown, limits: FormBodyLimits, consumeStructure: () => void, depth: number): FormNode {
    if (depth > limits.maxFormDepth) throw new HttpPayloadTooLargeError('Form field nesting is too deep');
    if (Array.isArray(value)) {
        const node = createIndexedArrayNode();
        value.forEach((child, index) => {
            if (index > limits.maxFormArrayIndex) throw new HttpPayloadTooLargeError('Form array index is too large');
            consumeStructure();
            node.children.set(index, importJsonNode(child, limits, consumeStructure, depth + 1));
        });
        return node;
    }
    if (value !== null && typeof value === 'object') {
        const node = createObjectNode();
        for (const [name, child] of Object.entries(value)) {
            assertSafePropertyName(name);
            consumeStructure();
            node.children.set(name, importJsonNode(child, limits, consumeStructure, depth + 1));
        }
        return node;
    }
    return { kind: 'leaf', values: [value] };
}

function mergeNodes(target: FormNode, source: FormNode, path: string): void {
    if (target.kind !== source.kind) throw mergeConflict(path);
    if (target.kind === 'leaf' || target.kind === 'append-array') throw mergeConflict(path);

    const sourceContainer = source as ObjectNode | IndexedArrayNode;
    const targetChildren = target.children as Map<string | number, FormNode>;
    for (const [key, sourceChild] of sourceContainer.children) {
        const childPath = appendPath(path, key);
        const targetChild = targetChildren.get(key);
        if (!targetChild) {
            targetChildren.set(key, sourceChild);
            continue;
        }
        mergeNodes(targetChild, sourceChild, childPath);
    }
}

function mergeConflict(path: string): HttpBadRequestError {
    return new HttpBadRequestError(`Conflicting form field values at "${path || '<root>'}"`);
}

function materializeNode(node: FormNode, path: string): unknown {
    if (node.kind === 'leaf') return node.values.length === 1 ? node.values[0] : [...node.values];
    if (node.kind === 'append-array') return [...node.values];
    if (node.kind === 'object') {
        const value: Record<string, unknown> = Object.create(null);
        for (const [name, child] of node.children) value[name] = materializeNode(child, appendPath(path, name));
        return value;
    }

    if (!node.children.size) return [];
    let maximumIndex = 0;
    for (const index of node.children.keys()) maximumIndex = Math.max(maximumIndex, index);
    const value: unknown[] = [];
    for (let index = 0; index <= maximumIndex; index += 1) {
        const child = node.children.get(index);
        if (!child) throw new HttpBadRequestError(`Sparse form array at "${path}": missing index ${index}`);
        value.push(materializeNode(child, appendPath(path, index)));
    }
    return value;
}

function appendPath(path: string, key: string | number): string {
    if (typeof key === 'number') return `${path}[${key}]`;
    return path ? `${path}[${key}]` : key;
}

function createObjectNode(): ObjectNode {
    return { kind: 'object', children: new Map() };
}

function createIndexedArrayNode(): IndexedArrayNode {
    return { kind: 'indexed-array', children: new Map() };
}

function createAppendArrayNode(): AppendArrayNode {
    return { kind: 'append-array', values: [] };
}
