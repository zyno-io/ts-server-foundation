import { entity } from '../../reflection';
import type { integer, MaxLength, MySQL, PrimaryKey } from '../../reflection';

import { BaseEntity } from '../../database';

@entity.name('_jobs')
export class JobEntity extends BaseEntity {
    id!: string & PrimaryKey & MaxLength<191>;
    queue!: string & MaxLength<191>;
    queueId!: string & MaxLength<191>;
    attempt!: integer;
    name!: string & MaxLength<191>;
    data!: unknown | null;
    traceId!: (string & MaxLength<64>) | null;
    status!: ('completed' | 'failed') & MaxLength<32>;
    result!: unknown | null;
    createdAt!: Date & MySQL<{ type: 'datetime(3)' }>;
    shouldExecuteAt!: Date & MySQL<{ type: 'datetime(3)' }>;
    executedAt!: Date & MySQL<{ type: 'datetime(3)' }>;
    completedAt!: Date & MySQL<{ type: 'datetime(3)' }>;
}
