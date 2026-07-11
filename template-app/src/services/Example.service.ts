import { createPersistedEntity, ScopedLogger } from '@zyno-io/ts-server-foundation';

import { DB } from '../database';
import { ExampleEntity } from '../entities/Example.entity';

export class ExampleService {
    constructor(
        private readonly db: DB,
        private readonly logger: ScopedLogger
    ) {}

    async findAll(): Promise<ExampleEntity[]> {
        return this.db.query(ExampleEntity).orderBy('id', 'desc').find();
    }

    async create(name: string): Promise<ExampleEntity> {
        this.logger.info('Creating example', { name });
        return createPersistedEntity(ExampleEntity, { name });
    }
}
