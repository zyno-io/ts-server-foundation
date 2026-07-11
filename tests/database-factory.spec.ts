import { AutoIncrement, entity, PrimaryKey } from '../src';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseEntity,
    createDatabase,
    createMySQLDatabase,
    createPostgresDatabase,
    MySQLConnectionLike,
    MySQLPoolLike,
    PgClientLike,
    PgPoolLike
} from '../src';

@entity.name('factory_users')
class FactoryUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string;
}

class FakePgClient implements PgClientLike {
    async query<T = Record<string, unknown>>(): Promise<{ rows: T[]; rowCount: number | null }> {
        return { rows: [], rowCount: 0 };
    }

    release(): void {}
}

class FakePgPool implements PgPoolLike {
    async connect(): Promise<PgClientLike> {
        return new FakePgClient();
    }

    async end(): Promise<void> {}
}

class FakeMySQLConnection implements MySQLConnectionLike {
    async query<T = unknown>(): Promise<[T, unknown]> {
        return [[] as T, undefined];
    }

    async execute<T = unknown>(): Promise<[T, unknown]> {
        return [{ affectedRows: 0 } as T, undefined];
    }

    release(): void {}
}

class FakeMySQLPool implements MySQLPoolLike {
    async getConnection(): Promise<MySQLConnectionLike> {
        return new FakeMySQLConnection();
    }

    async end(): Promise<void> {}
}

const originalEnv = { ...process.env };

describe('database factories', () => {
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('creates MySQL and PostgreSQL database classes with supplied pools', () => {
        const MySQLDB = createMySQLDatabase(new FakeMySQLPool(), [FactoryUser]);
        const PostgresDB = createPostgresDatabase(new FakePgPool(), [FactoryUser]);

        const mysql = new MySQLDB();
        const postgres = new PostgresDB();

        assert.ok(mysql instanceof BaseDatabase);
        assert.equal(mysql.driver.dialect, 'mysql');
        assert.deepStrictEqual(mysql.entityRegistry, [FactoryUser]);
        assert.equal(postgres.driver.dialect, 'postgres');
        assert.deepStrictEqual(postgres.entityRegistry, [FactoryUser]);
    });

    it('selects an explicit dialect through createDatabase', () => {
        const MySQLDB = createDatabase('mysql', new FakeMySQLPool(), [FactoryUser]);
        const PostgresDB = createDatabase('postgres', new FakePgPool(), [FactoryUser]);

        assert.equal(new MySQLDB().driver.dialect, 'mysql');
        assert.equal(new PostgresDB().driver.dialect, 'postgres');
    });

    it('selects shared dialect from DB_ADAPTER and preserves database options', () => {
        process.env.APP_ENV = 'test';
        process.env.DB_ADAPTER = 'mysql';

        const DB = createDatabase({ enableLocksTable: true, lockTableName: '_custom_locks' }, [FactoryUser]);
        const db = new DB();

        assert.equal(db.driver.dialect, 'mysql');
        assert.equal(db.options.enableLocksTable, true);
        assert.equal(db.options.lockTableName, '_custom_locks');
    });

    it('rejects shared factory calls without DB_ADAPTER', () => {
        delete process.env.DB_ADAPTER;

        assert.throws(() => createDatabase({}, [FactoryUser]), /DB_ADAPTER/);
    });
});
