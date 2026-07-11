import { AutoIncrement, entity, PrimaryKey } from '../../src';

import { BaseEntity } from '../../src';

@entity.name('test_app_users')
export class TestAppUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string;
    role!: string | null;
}
