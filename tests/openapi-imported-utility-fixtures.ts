import type { UuidString } from '../src';

export class OpenApiImportedResponseSource {
    id!: UuidString;
    label!: string;
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
