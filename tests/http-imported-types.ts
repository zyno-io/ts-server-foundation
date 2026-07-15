export interface ImportedBodyItem {
    name: string;
    qty: number;
}

export class ImportedBodyEntity {
    startsAt!: Date | null;
    name!: string;
    omitted!: string;
}

interface ImportedBindingNodeBase {
    id: string;
    type: 'timeCondition';
    matchNext: string;
    noMatchNext: string;
}

export type ImportedBindingNode = ImportedBindingNodeBase &
    (
        | {
              timeConditionId: string;
              locationId?: never;
          }
        | {
              locationId: string;
              timeConditionId?: never;
          }
    );

export interface ImportedBindingRequest {
    nodes: Record<string, ImportedBindingNode>;
}
