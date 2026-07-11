import { BaseDatabase } from '../../src';
import { TestAppUser } from '../entities/TestAppUser.entity';
import { TestAppMemoryDriver } from './TestAppMemoryDriver';

export class TestAppDatabase extends BaseDatabase {
    static readonly driver = new TestAppMemoryDriver();

    constructor() {
        super(TestAppDatabase.driver, [TestAppUser]);
    }
}
