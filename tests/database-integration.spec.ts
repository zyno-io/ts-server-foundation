import { AutoIncrement, DatabaseField, entity, PrimaryKey } from '../src';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseEntity,
    createPersistedEntity,
    getFieldOriginal,
    isEntityDirty,
    MySQLDriver,
    PostgresDriver,
    sql,
    type MySQLDatabaseConfig,
    type PostgresDatabaseConfig
} from '../src';

const MYSQL_USER_TABLE = 'tsf_crud_mysql_users';
const MYSQL_LOCK_TABLE = 'tsf_crud_mysql_locks';
const MYSQL_JSON_TABLE = 'tsf_crud_mysql_json';
const MYSQL_DATE_TABLE = 'tsf_crud_mysql_dates';
const PG_USER_TABLE = 'tsf_crud_pg_users';
const PG_JSON_TABLE = 'tsf_crud_pg_json';

@entity.name(MYSQL_USER_TABLE)
class MySQLCrudUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string & DatabaseField<{ name: 'display_name' }>;
    email!: string | null;
    score!: number;
}

@entity.name(PG_USER_TABLE)
class PostgresCrudUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string & DatabaseField<{ name: 'display_name' }>;
    email!: string | null;
    score!: number;
}

@entity.name(MYSQL_JSON_TABLE)
class MySQLJsonRow extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    tags: string[] = [];
    config: { enabled: boolean; retries: number } = { enabled: false, retries: 0 };
}

@entity.name(MYSQL_DATE_TABLE)
class MySQLDateRow extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    recordedAt!: Date;
}

@entity.name(PG_JSON_TABLE)
class PostgresJsonRow extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    tags: string[] = [];
    config: { enabled: boolean; retries: number } = { enabled: false, retries: 0 };
}

describe('database real CRUD integration', () => {
    const mysqlConfig = readMySQLConfig();
    const pgConfig = readPostgresConfig();

    it(
        'runs active-record, query, transaction, and lock flows on MySQL',
        {
            skip: mysqlConfig ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL CRUD integration'
        },
        async () => {
            if (!mysqlConfig) return;
            const db = new BaseDatabase(new MySQLDriver(mysqlConfig), [MySQLCrudUser, MySQLJsonRow, MySQLDateRow], {
                enableLocksTable: true,
                lockTableName: MYSQL_LOCK_TABLE
            });

            try {
                await resetMySQLSchema(db);
                await createMySQLSchema(db);
                await runCrudFlow(db, MySQLCrudUser);
                await runTransactionFlow(db, MySQLCrudUser, 'mysql');
                await runJsonFlow(db, MySQLJsonRow);
                await runMySQLDateFlow(db);
            } finally {
                await resetMySQLSchema(db);
                await db.driver.close();
            }
        }
    );

    it(
        'runs active-record, query, transaction, and lock flows on PostgreSQL',
        {
            skip: pgConfig ? false : 'set PG_HOST, PG_USER, and PG_DATABASE to run PostgreSQL CRUD integration'
        },
        async () => {
            if (!pgConfig) return;
            const db = new BaseDatabase(new PostgresDriver(pgConfig), [PostgresCrudUser, PostgresJsonRow]);

            try {
                await resetPostgresSchema(db);
                await createPostgresSchema(db);
                await runCrudFlow(db, PostgresCrudUser);
                await runTransactionFlow(db, PostgresCrudUser, 'postgres');
                await runJsonFlow(db, PostgresJsonRow);
            } finally {
                await resetPostgresSchema(db);
                await db.driver.close();
            }
        }
    );
});

async function runCrudFlow<T extends BaseEntity & { id: number; name: string; email: string | null; score: number }>(
    db: BaseDatabase,
    Entity: new () => T
): Promise<void> {
    const alice = await createPersistedEntity(Entity, {
        name: 'Alice',
        email: 'alice@example.com',
        score: 10
    } as Partial<T>);
    const bob = await createPersistedEntity(Entity, {
        name: 'Bob',
        email: null,
        score: 20
    } as Partial<T>);
    const cara = await createPersistedEntity(Entity, {
        name: 'Cara',
        email: 'cara@example.com',
        score: 30
    } as Partial<T>);

    assert.ok(alice.id > 0);
    assert.ok(bob.id > alice.id);
    assert.equal(isEntityDirty(alice), false);

    const filtered = await db
        .query(Entity)
        .filter({ score: { $gte: 10 }, email: { $ne: null } })
        .orderBy('score', 'desc')
        .limit(2)
        .find();
    assert.deepStrictEqual(
        filtered.map(user => user.name),
        ['Cara', 'Alice']
    );

    assert.deepStrictEqual(
        await db
            .query(Entity)
            .filter({ id: { $in: [alice.id, bob.id] } })
            .orderBy('name')
            .findField('name'),
        ['Alice', 'Bob']
    );
    assert.equal(
        await db
            .query(Entity)
            .filter({ email: { $ne: null } })
            .count(),
        2
    );
    assert.equal(await db.query(Entity).filter({ id: cara.id }).has(), true);

    const raw = await db.rawFind<{ name: string; score: number }>(
        sql`SELECT ${sql.identifier('display_name')} AS ${sql.identifier('name')}, ${sql.identifier('score')} FROM ${sql.identifier(
            getTableName(Entity)
        )} WHERE ${sql.identifier('id')} = ${alice.id}`
    );
    assert.deepStrictEqual(raw, [{ name: 'Alice', score: 10 }]);

    const rawUnsafe = await db.rawFindOneUnsafe<{ label: string }>('SELECT ? AS label', ['bound-value']);
    assert.deepStrictEqual(rawUnsafe, { label: 'bound-value' });

    alice.name = 'Alice Updated';
    await alice.save();
    assert.equal(isEntityDirty(alice), false);
    assert.equal(getFieldOriginal(alice, 'name'), 'Alice Updated');
    assert.equal((await db.query(Entity).filter({ id: alice.id }).findOne()).name, 'Alice Updated');

    const patch = await db
        .query(Entity)
        .filter({ id: bob.id })
        .patchOne({ score: 25 } as Partial<T>);
    assert.equal(patch.affectedRows, 1);
    assert.deepStrictEqual(patch.primaryKeys, [{ id: bob.id }]);
    assert.equal((await db.query(Entity).filter({ id: bob.id }).findOne()).score, 25);

    await cara.delete();
    assert.equal(await db.query(Entity).count(), 2);

    const deletion = await db.query(Entity).filter({ id: bob.id }).deleteOne();
    assert.equal(deletion.affectedRows, 1);
    assert.equal(await db.query(Entity).count(), 1);
}

async function runJsonFlow<
    T extends BaseEntity & {
        id: number;
        tags: string[];
        config: { enabled: boolean; retries: number };
    }
>(db: BaseDatabase, Entity: new () => T): Promise<void> {
    const created = await createPersistedEntity(Entity, {
        tags: ['alpha', 'beta'],
        config: { enabled: true, retries: 1 }
    } as Partial<T>);
    assert.ok(created.id > 0);

    const loaded = await db.query(Entity).filter({ id: created.id }).findOne();
    assert.deepStrictEqual(loaded.tags, ['alpha', 'beta']);
    assert.deepStrictEqual(loaded.config, { enabled: true, retries: 1 });

    loaded.tags = ['gamma'];
    loaded.config = { enabled: true, retries: 2 };
    await loaded.save();

    const saved = await db.query(Entity).filter({ id: created.id }).findOne();
    assert.deepStrictEqual(saved.tags, ['gamma']);
    assert.deepStrictEqual(saved.config, { enabled: true, retries: 2 });

    await db
        .query(Entity)
        .filter({ id: created.id })
        .patchOne({
            tags: ['delta', 'epsilon'],
            config: { enabled: false, retries: 3 }
        } as Partial<T>);

    const patched = await db.query(Entity).filter({ id: created.id }).findOne();
    assert.deepStrictEqual(patched.tags, ['delta', 'epsilon']);
    assert.deepStrictEqual(patched.config, { enabled: false, retries: 3 });
}

async function runMySQLDateFlow(db: BaseDatabase): Promise<void> {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
        const recordedAt = new Date('2026-07-12T21:31:43.123Z');
        const created = await createPersistedEntity(MySQLDateRow, { recordedAt });
        const loaded = await db.query(MySQLDateRow).filter({ id: created.id }).findOne();

        assert.equal(loaded.recordedAt.toISOString(), recordedAt.toISOString());
    } finally {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
    }
}

async function runTransactionFlow<T extends BaseEntity & { id: number; name: string; email: string | null; score: number }>(
    db: BaseDatabase,
    Entity: new () => T,
    dialect: 'mysql' | 'postgres'
): Promise<void> {
    const hooks: string[] = [];

    await db.transaction(async session => {
        await session.acquireSessionLock(['crud-flow', dialect]);
        session.addPreCommitHook(async () => {
            hooks.push('pre');
        });
        session.addPostCommitHook(async () => {
            hooks.push('post');
        });

        const committed = await createPersistedEntity(Entity, { name: `${dialect}-committed`, email: null, score: 40 } as Partial<T>, session);
        const rows = await session.rawFindUnsafe<{ id: number }>(`SELECT id FROM ${quoteIdentifier(getTableName(Entity), dialect)} WHERE id = ?`, [
            committed.id
        ]);
        assert.equal(rows.length, 1);

        await assert.rejects(
            session.withSavepoint('rollback_insert', async () => {
                await createPersistedEntity(Entity, { name: `${dialect}-savepoint-rollback`, email: null, score: 50 } as Partial<T>, session);
                throw new Error('rollback savepoint');
            }),
            /rollback savepoint/
        );
    });

    assert.deepStrictEqual(hooks, ['pre', 'post']);
    assert.equal(
        await db
            .query(Entity)
            .filter({ name: `${dialect}-committed` })
            .count(),
        1
    );
    assert.equal(
        await db
            .query(Entity)
            .filter({ name: `${dialect}-savepoint-rollback` })
            .count(),
        0
    );

    await assert.rejects(
        db.transaction(async session => {
            await createPersistedEntity(Entity, { name: `${dialect}-rolled-back`, email: null, score: 60 } as Partial<T>, session);
            throw new Error('rollback transaction');
        }),
        /rollback transaction/
    );
    assert.equal(
        await db
            .query(Entity)
            .filter({ name: `${dialect}-rolled-back` })
            .count(),
        0
    );
}

async function resetMySQLSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS \`${MYSQL_DATE_TABLE}\``);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS \`${MYSQL_JSON_TABLE}\``);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS \`${MYSQL_USER_TABLE}\``);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS \`${MYSQL_LOCK_TABLE}\``);
}

async function createMySQLSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`
        CREATE TABLE \`${MYSQL_USER_TABLE}\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`display_name\` varchar(255) NOT NULL,
            \`email\` varchar(255) NULL,
            \`score\` int NOT NULL,
            PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE \`${MYSQL_JSON_TABLE}\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`tags\` json NOT NULL,
            \`config\` json NOT NULL,
            PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE \`${MYSQL_DATE_TABLE}\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`recordedAt\` datetime(3) NOT NULL,
            PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
    `);
}

async function resetPostgresSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS "${PG_JSON_TABLE}"`);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS "${PG_USER_TABLE}"`);
}

async function createPostgresSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`
        CREATE TABLE "${PG_USER_TABLE}" (
            "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "display_name" varchar(255) NOT NULL,
            "email" varchar(255) NULL,
            "score" integer NOT NULL
        )
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE "${PG_JSON_TABLE}" (
            "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "tags" jsonb NOT NULL,
            "config" jsonb NOT NULL
        )
    `);
}

function getTableName(Entity: new () => BaseEntity): string {
    return Entity === MySQLCrudUser ? MYSQL_USER_TABLE : PG_USER_TABLE;
}

function quoteIdentifier(identifier: string, dialect: 'mysql' | 'postgres'): string {
    return dialect === 'mysql' ? `\`${identifier.replace(/`/g, '``')}\`` : `"${identifier.replace(/"/g, '""')}"`;
}

function readMySQLConfig(): MySQLDatabaseConfig | undefined {
    if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) return undefined;
    return {
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : undefined,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD_SECRET,
        database: process.env.MYSQL_DATABASE,
        connectionLimit: 2
    };
}

function readPostgresConfig(): PostgresDatabaseConfig | undefined {
    if (!process.env.PG_HOST || !process.env.PG_USER || !process.env.PG_DATABASE) return undefined;
    return {
        host: process.env.PG_HOST,
        port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD_SECRET,
        database: process.env.PG_DATABASE,
        max: 2,
        ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined
    };
}
