import type { Length, OnUpdate, UuidString } from '../src';

export class OpenApiImportedResponseSource {
    id!: UuidString;
    label!: string;
}

export class OpenApiImportedTimestampedSource {
    id!: UuidString;
    kind!: string;
    code!: Length<4>;
    updatedAt!: Date & OnUpdate<'CURRENT_TIMESTAMP'>;
}

interface OpenApiImportedReportCategory {
    categoryId: string;
    total: number;
}

interface OpenApiImportedReportDetail {
    detailTypeId: string;
    total: number;
    itemCount: number;
}

interface OpenApiImportedReportCustomEntry {
    customEntryId: string;
    total: number;
}

export class OpenApiImportedReportSource {
    id!: string;
    scopeId!: string;
    groupId!: string;
    totalAmount!: number;
    categoryBreakdown!: OpenApiImportedReportCategory[];
    detailBreakdown!: OpenApiImportedReportDetail[];
    customEntries!: OpenApiImportedReportCustomEntry[];
}

export interface OpenApiImportedGenericError<Code extends string = string> {
    error: string;
    code?: Code;
    retryable?: boolean;
}
