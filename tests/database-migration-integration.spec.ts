import { AutoIncrement, entity, Index, MaxLength, PrimaryKey, Reference, Unique } from '../src';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseEntity,
    createMigrationPlan,
    MySQLDriver,
    PostgresDriver,
    type MySQLDatabaseConfig,
    type PostgresDatabaseConfig
} from '../src';

const MYSQL_USER_TABLE = 'tsf_migration_mysql_users';
const MYSQL_POST_TABLE = 'tsf_migration_mysql_posts';
const PG_USER_TABLE = 'tsf_migration_pg_users';
const PG_POST_TABLE = 'tsf_migration_pg_posts';

@entity.name(MYSQL_USER_TABLE)
class MySQLMigrationUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    email!: string & MaxLength<255> & Unique;
    status!: 'active' | 'disabled';
    code!: string & MaxLength<6>;
}

@entity.name(MYSQL_POST_TABLE)
class MySQLMigrationPost extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    user!: MySQLMigrationUser & Reference<{ onDelete: 'RESTRICT'; onUpdate: 'CASCADE' }>;
    title!: string & MaxLength<200> & Index;
}

@entity.name(PG_USER_TABLE)
class PostgresMigrationUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    email!: string & MaxLength<255> & Unique;
    status!: 'active' | 'disabled';
    phase!: 'new' | 'old';
    code!: string & MaxLength<6>;
}

@entity.name(PG_POST_TABLE)
class PostgresMigrationPost extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    user!: PostgresMigrationUser & Reference<{ onDelete: 'RESTRICT'; onUpdate: 'CASCADE' }>;
    title!: string & MaxLength<200> & Index;
}

describe('migration create real database integration', () => {
    const mysqlConfig = readMySQLConfig();
    const pgConfig = readPostgresConfig();

    it(
        'generates MySQL DDL that applies cleanly and converges',
        {
            skip: mysqlConfig ? false : 'set MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE to run MySQL migration integration'
        },
        async () => {
            if (!mysqlConfig) return;
            const db = new BaseDatabase(new MySQLDriver(mysqlConfig), [MySQLMigrationUser, MySQLMigrationPost]);
            try {
                await resetMySQLSchema(db);
                await createOldMySQLSchema(db);

                const plan = await createMigrationPlan(db, {
                    tableNames: [MYSQL_USER_TABLE, MYSQL_POST_TABLE]
                });
                assert.equal(plan.hasChanges, true);
                assert.match(plan.statements.join('\n'), new RegExp(`ALTER TABLE \`${MYSQL_POST_TABLE}\` DROP FOREIGN KEY`));
                assert.match(plan.statements.join('\n'), new RegExp(`ALTER TABLE \`${MYSQL_POST_TABLE}\` ADD CONSTRAINT`));

                await executeStatements(db, plan.statements);

                const converged = await createMigrationPlan(db, {
                    tableNames: [MYSQL_USER_TABLE, MYSQL_POST_TABLE]
                });
                assert.deepStrictEqual(converged.statements, []);
                assert.equal(converged.hasChanges, false);
            } finally {
                await resetMySQLSchema(db);
                await db.driver.close();
            }
        }
    );

    it(
        'generates PostgreSQL DDL that applies cleanly and converges',
        {
            skip: pgConfig ? false : 'set PG_HOST, PG_USER, and PG_DATABASE to run PostgreSQL migration integration'
        },
        async () => {
            if (!pgConfig) return;
            const db = new BaseDatabase(new PostgresDriver(pgConfig), [PostgresMigrationUser, PostgresMigrationPost]);
            try {
                await resetPostgresSchema(db);
                await createOldPostgresSchema(db);

                const plan = await createMigrationPlan(db, { tableNames: [PG_USER_TABLE, PG_POST_TABLE] });
                assert.equal(plan.hasChanges, true);
                assert.match(plan.statements.join('\n'), new RegExp(`CREATE TYPE "${PG_USER_TABLE}_phase_enum"`));
                assert.match(plan.statements.join('\n'), new RegExp(`CREATE TYPE "${PG_USER_TABLE}_status_enum__next"`));
                assert.match(plan.statements.join('\n'), new RegExp(`ALTER TABLE "${PG_POST_TABLE}" DROP CONSTRAINT`));
                assert.match(plan.statements.join('\n'), new RegExp(`ALTER TABLE "${PG_POST_TABLE}" ADD CONSTRAINT`));

                await executeStatements(db, plan.statements);

                const converged = await createMigrationPlan(db, {
                    tableNames: [PG_USER_TABLE, PG_POST_TABLE]
                });
                assert.deepStrictEqual(converged.statements, []);
                assert.equal(converged.hasChanges, false);
            } finally {
                await resetPostgresSchema(db);
                await db.driver.close();
            }
        }
    );
});

async function executeStatements(db: BaseDatabase, statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
        if (statement.startsWith('\0table:')) continue;
        await db.rawExecuteUnsafe(statement);
    }
}

async function resetMySQLSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS \`${MYSQL_POST_TABLE}\``);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS \`${MYSQL_USER_TABLE}\``);
}

async function createOldMySQLSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`
        CREATE TABLE \`${MYSQL_USER_TABLE}\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`email\` varchar(100) NOT NULL DEFAULT 'legacy@example.com',
            \`status\` enum('disabled', 'active') NOT NULL DEFAULT 'disabled',
            PRIMARY KEY (\`id\`),
            UNIQUE KEY \`${MYSQL_USER_TABLE}_email_key\` (\`email\`)
        ) ENGINE=InnoDB
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE \`${MYSQL_POST_TABLE}\` (
            \`id\` int NOT NULL AUTO_INCREMENT,
            \`user\` int NOT NULL,
            \`old_column\` varchar(255) NULL,
            PRIMARY KEY (\`id\`),
            KEY \`${MYSQL_POST_TABLE}_i_user\` (\`user\`),
            CONSTRAINT \`${MYSQL_POST_TABLE}_fk_user_${MYSQL_USER_TABLE}_id\`
                FOREIGN KEY (\`user\`) REFERENCES \`${MYSQL_USER_TABLE}\` (\`id\`)
                ON DELETE CASCADE ON UPDATE CASCADE
        ) ENGINE=InnoDB
    `);
}

async function resetPostgresSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS "${PG_POST_TABLE}"`);
    await db.rawExecuteUnsafe(`DROP TABLE IF EXISTS "${PG_USER_TABLE}"`);
    await db.rawExecuteUnsafe(`DROP TYPE IF EXISTS "${PG_USER_TABLE}_phase_enum"`);
    await db.rawExecuteUnsafe(`DROP TYPE IF EXISTS "${PG_USER_TABLE}_status_enum"`);
    await db.rawExecuteUnsafe(`DROP TYPE IF EXISTS "${PG_USER_TABLE}_status_enum__next"`);
}

async function createOldPostgresSchema(db: BaseDatabase): Promise<void> {
    await db.rawExecuteUnsafe(`CREATE TYPE "${PG_USER_TABLE}_status_enum" AS ENUM ('disabled', 'active')`);
    await db.rawExecuteUnsafe(`
        CREATE TABLE "${PG_USER_TABLE}" (
            "id" integer GENERATED BY DEFAULT AS IDENTITY,
            "email" varchar(100) NOT NULL DEFAULT 'legacy@example.com',
            "status" "${PG_USER_TABLE}_status_enum" NOT NULL DEFAULT 'disabled',
            CONSTRAINT "${PG_USER_TABLE}_custom_pk" PRIMARY KEY ("id"),
            CONSTRAINT "${PG_USER_TABLE}_email_key" UNIQUE ("email")
        )
    `);
    await db.rawExecuteUnsafe(`
        CREATE TABLE "${PG_POST_TABLE}" (
            "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "user" integer NOT NULL,
            "old_column" varchar(255) NULL,
            CONSTRAINT "${PG_POST_TABLE}_fk_user_${PG_USER_TABLE}_id"
                FOREIGN KEY ("user") REFERENCES "${PG_USER_TABLE}" ("id")
                ON DELETE CASCADE ON UPDATE CASCADE
        )
    `);
    await db.rawExecuteUnsafe(`CREATE INDEX "${PG_POST_TABLE}_i_user" ON "${PG_POST_TABLE}" ("user")`);
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
