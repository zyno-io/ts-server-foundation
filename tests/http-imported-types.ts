export interface ImportedBodyItem {
    name: string;
    qty: number;
}

export class ImportedBodyEntity {
    startsAt!: Date | null;
    name!: string;
    omitted!: string;
}
