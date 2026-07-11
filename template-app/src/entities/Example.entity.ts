import { AutoIncrement, entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity } from '@zyno-io/ts-server-foundation';

@entity.name('examples')
export class ExampleEntity extends BaseEntity {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
    createdAt: Date = new Date();
}
