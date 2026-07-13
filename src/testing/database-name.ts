import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const DIRECTORY_HASH_LENGTH = 4;
const DATABASE_NAME_HASH_LENGTH = 8;
const MAX_DATABASE_NAME_LENGTH = 63;
const MAX_DATABASE_PREFIX_LENGTH = 40;

export function createTestDatabasePrefix(prefix = 'test', directory = process.cwd()): string {
    const safePrefix = shortenValue(prefix.replace(/[^a-zA-Z0-9_]/g, '_') || 'test', MAX_DATABASE_PREFIX_LENGTH - DIRECTORY_HASH_LENGTH - 1);
    const directoryHash = createHash('sha1').update(resolve(directory)).digest('hex').slice(0, DIRECTORY_HASH_LENGTH);
    return `${safePrefix}_${directoryHash}`;
}

export function formatTestDatabaseName(prefix: string, parts: readonly (number | string)[]): string {
    const name = `${createTestDatabasePrefix(prefix)}_${parts.join('_')}`;
    return shortenValue(name, MAX_DATABASE_NAME_LENGTH);
}

function shortenValue(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const hash = createHash('sha1').update(value).digest('hex').slice(0, DATABASE_NAME_HASH_LENGTH);
    return `${value.slice(0, maxLength - DATABASE_NAME_HASH_LENGTH - 1)}_${hash}`;
}
