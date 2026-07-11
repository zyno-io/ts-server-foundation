import type { Dialect } from './sql';
import { isDatabaseUUIDType, ReflectionKind, type Type } from '../reflection';
import type { ColumnMetadata } from './metadata';
import { resolveColumnType } from './migration/create/type-mapper';
import { normalizeSqlBindingValue, sql, type SqlQuery } from './sql';

export function serializeColumnValue(column: ColumnMetadata | undefined, value: unknown, dialect: Dialect): unknown | SqlQuery {
    if (!column) return value;
    if (value === undefined) return column.nullable ? null : value;
    if (value === null) return value;
    if (isDatabaseUUIDType(column.type)) return serializeUuidValue(value, dialect);
    const columnType = resolveColumnType(column.type, dialect).type;
    if (columnType === 'date') return serializeDateOnlyValue(value);
    if (isBinaryColumnType(columnType)) return serializeBinaryValue(value);
    const normalizedValue = normalizeSqlBindingValue(value);
    if (normalizedValue !== value) return normalizedValue;
    if (dialect === 'mysql' && columnType === 'point') {
        const coordinate = normalizeCoordinate(value);
        if (coordinate) return sql`ST_GeomFromText(${`POINT(${coordinate.x} ${coordinate.y})`})`;
    }
    if (columnType !== 'json') return value;
    return JSON.stringify(value);
}

export function deserializeColumnValue(column: ColumnMetadata | undefined, value: unknown, dialect: Dialect): unknown {
    if (!column || value === null || value === undefined) return value;
    if (isDatabaseUUIDType(column.type)) return deserializeUuidValue(value, dialect);
    const columnType = resolveColumnType(column.type, dialect).type;
    if (columnType === 'date') return deserializeDateOnlyValue(value);
    if (isBinaryColumnType(columnType)) return deserializeBinaryValue(value, column.type);
    if (dialect === 'mysql' && columnType === 'point') return deserializeMySQLPoint(value);
    if (columnType !== 'json') return value;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function isBinaryColumnType(columnType: string): boolean {
    return (
        columnType === 'binary' ||
        columnType === 'varbinary' ||
        columnType === 'blob' ||
        columnType === 'tinyblob' ||
        columnType === 'mediumblob' ||
        columnType === 'longblob' ||
        columnType === 'bytea'
    );
}

function serializeBinaryValue(value: unknown): unknown {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    return value;
}

function deserializeBinaryValue(value: unknown, type: Type): unknown {
    const buffer = binaryValueToBuffer(value);
    if (!buffer) return value;
    if (hasBinaryTypeName(type, 'Buffer')) return buffer;
    if (hasBinaryTypeName(type, 'ArrayBuffer')) return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Uint8Array(buffer);
}

function binaryValueToBuffer(value: unknown): Buffer | undefined {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'binary');
}

function hasBinaryTypeName(type: Type, name: 'ArrayBuffer' | 'Buffer' | 'Uint8Array'): boolean {
    if ((type as Type & { typeName?: string }).typeName === name) return true;
    if (type.kind === ReflectionKind.class && type.classType?.name === name) return true;
    if ('types' in type && Array.isArray(type.types)) return type.types.some(child => hasBinaryTypeName(child, name));
    return false;
}

function serializeUuidValue(value: unknown, dialect: Dialect): unknown {
    if (dialect === 'mysql') return uuidValueToBuffer(value) ?? value;
    return uuidValueToString(value) ?? value;
}

function deserializeUuidValue(value: unknown, dialect: Dialect): unknown {
    if (dialect === 'mysql') return uuidValueToString(value) ?? value;
    return uuidValueToString(value) ?? value;
}

function uuidValueToBuffer(value: unknown): Buffer | undefined {
    if (Buffer.isBuffer(value)) return value.length === 16 ? value : undefined;
    if (value instanceof Uint8Array) return value.byteLength === 16 ? Buffer.from(value) : undefined;
    if (typeof value !== 'string') return undefined;
    const hex = uuidHex(value);
    return hex ? Buffer.from(hex, 'hex') : undefined;
}

function uuidValueToString(value: unknown): string | undefined {
    if (Buffer.isBuffer(value)) return value.length === 16 ? uuidStringFromBuffer(value) : undefined;
    if (value instanceof Uint8Array) return value.byteLength === 16 ? uuidStringFromBuffer(Buffer.from(value)) : undefined;
    if (typeof value !== 'string') return undefined;
    return normalizeUuidString(value) ?? (value.length === 16 ? uuidStringFromBuffer(Buffer.from(value, 'binary')) : undefined);
}

function normalizeUuidString(value: string): string | undefined {
    const hex = uuidHex(value);
    if (!hex) return undefined;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidHex(value: string): string | undefined {
    const normalized = value.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(normalized)) return normalized;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
        return normalized.replace(/-/g, '');
    }
    return undefined;
}

function uuidStringFromBuffer(buffer: Buffer): string {
    const hex = buffer.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serializeDateOnlyValue(value: unknown): unknown {
    if (typeof value === 'string') return value.slice(0, 10);
    if (isDateLike(value)) return formatDateOnlyUtc(value);
    return value;
}

function deserializeDateOnlyValue(value: unknown): unknown {
    if (value instanceof Date) return formatDateOnlyUtc(value);
    if (isDateLike(value)) return formatDateOnlyUtc(value);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return value;
}

function isDateLike(value: unknown): value is {
    getTime(): number;
    getUTCFullYear(): number;
    getUTCMonth(): number;
    getUTCDate(): number;
} {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
        Object.prototype.toString.call(value) === '[object Date]' &&
        typeof candidate.getTime === 'function' &&
        Number.isFinite((candidate.getTime as () => number).call(value)) &&
        typeof candidate.getUTCFullYear === 'function' &&
        typeof candidate.getUTCMonth === 'function' &&
        typeof candidate.getUTCDate === 'function'
    );
}

function formatDateOnlyUtc(value: { getUTCFullYear(): number; getUTCMonth(): number; getUTCDate(): number }): string {
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

function pad(value: number, size = 2): string {
    return String(value).padStart(size, '0');
}

function normalizeCoordinate(value: unknown): { x: number; y: number } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as { x?: unknown; y?: unknown; type?: unknown; coordinates?: unknown };
    if (typeof candidate.x === 'number' && typeof candidate.y === 'number') return { x: candidate.x, y: candidate.y };
    if (candidate.type === 'Point' && Array.isArray(candidate.coordinates)) {
        const [x, y] = candidate.coordinates;
        if (typeof x === 'number' && typeof y === 'number') return { x, y };
    }
}

function deserializeMySQLPoint(value: unknown): unknown {
    const coordinate = normalizeCoordinate(value);
    if (coordinate) return coordinate;
    if (Buffer.isBuffer(value)) return readMySQLPointBuffer(value) ?? value;
    if (typeof value === 'string') return readPointString(value) ?? value;
    return value;
}

function readMySQLPointBuffer(buffer: Buffer): { x: number; y: number } | undefined {
    return readWkbPoint(buffer, 4) ?? readWkbPoint(buffer, 0);
}

function readWkbPoint(buffer: Buffer, offset: number): { x: number; y: number } | undefined {
    if (buffer.length < offset + 21) return undefined;
    const byteOrder = buffer.readUInt8(offset);
    if (byteOrder !== 0 && byteOrder !== 1) return undefined;
    const littleEndian = byteOrder === 1;
    const type = littleEndian ? buffer.readUInt32LE(offset + 1) : buffer.readUInt32BE(offset + 1);
    if ((type & 0xff) !== 1) return undefined;
    const x = littleEndian ? buffer.readDoubleLE(offset + 5) : buffer.readDoubleBE(offset + 5);
    const y = littleEndian ? buffer.readDoubleLE(offset + 13) : buffer.readDoubleBE(offset + 13);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    return { x, y };
}

function readPointString(value: string): { x: number; y: number } | undefined {
    const wkt = /^POINT\s*\(\s*([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)\s*\)$/i.exec(value);
    if (wkt) return { x: Number(wkt[1]), y: Number(wkt[2]) };
    try {
        return normalizeCoordinate(JSON.parse(value));
    } catch {
        return undefined;
    }
}
