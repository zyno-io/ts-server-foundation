import { AutoIncrement, DatabaseField, entity, Index, Indexed, MaxLength, Minimum, PrimaryKey, Reference, Unique } from '../src';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseEntity,
    compareSchemas,
    createMigrationPlan,
    DatabaseDriver,
    DriverConnection,
    ExecuteResult,
    defaultBlueprintIdentifierName,
    defaultEntityIndexName,
    generateDDL,
    QueryResult,
    maxIdentifierLength,
    normalizeGeneratedIdentifier,
    readDatabaseSchema,
    readEntitiesSchema,
    RenderedSql,
    SchemaTableBuilder,
    writeMigrationFile,
    type ColumnSchema,
    type Coordinate,
    type DateString,
    type NullableMySQLCoordinate,
    Length,
    type TableSchema,
    type UnsignedNumber,
    type UUID,
    type UuidString
} from '../src';

class FakeConnection implements DriverConnection {
    constructor(private readonly driver: FakeDriver) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        this.driver.queries.push(query);
        const rows = this.driver.rows.shift() ?? [];
        return { rows: rows as T[] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        this.driver.executes.push(query);
        return { affectedRows: 1 };
    }

    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async savepoint(): Promise<void> {}
    async rollbackToSavepoint(): Promise<void> {}
    async release(): Promise<void> {}
}

class FakeDriver implements DatabaseDriver {
    rows: Record<string, unknown>[][] = [];
    queries: RenderedSql[] = [];
    executes: RenderedSql[] = [];

    constructor(readonly dialect: 'mysql' | 'postgres') {}

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        return new FakeConnection(this);
    }
}

@entity.name('migration_users')
class MigrationUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    uuid!: UuidString;
    email!: string & DatabaseField<{ name: 'email_address' }>;
    displayName!: string & MaxLength<100>;
    status!: 'active' | 'disabled';
    code!: Length<6>;
    birthDate!: DateString | null;
    metadata!: { flags: string[] };
}

@entity.name('migration_union_users')
class MigrationUnionUser extends BaseEntity {
    id!: number & PrimaryKey;
    birthDate!: DateString | null;
    mixed!: DateString | UuidString;
}

@entity.name('migration_default_users')
class MigrationDefaultUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    status = 'active';
    count = 0;
    enabled = true;
}

@entity.name('migration_posts')
class MigrationPost extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    user!: MigrationUser & Reference<{ onDelete: 'RESTRICT'; onUpdate: 'CASCADE' }>;
    slug!: string & Unique;
    title!: string & MaxLength<200> & Index<{ name: 'migration_posts_title_idx' }>;
}

@entity.name('migration_featured_posts')
class MigrationFeaturedPost extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    user!: MigrationUser & Reference & Unique;
}

@entity.name('migration_index_unique_entities')
class MigrationIndexUniqueEntity extends BaseEntity {
    id!: number & PrimaryKey;
    slug!: string & MaxLength<100> & Index & Unique;
    status!: Indexed<'active' | 'disabled' | null, { name: 'migration_index_unique_status_idx' }>;
}

@entity.name('parents')
class MigrationParent extends BaseEntity {
    id!: number & PrimaryKey;
}

@entity.name('children')
class MigrationChild extends BaseEntity {
    id!: number & PrimaryKey;
    parent!: MigrationParent & Reference<{ onDelete: 'CASCADE'; onUpdate: 'CASCADE' }>;
}

@entity.name('migration_broken_entities')
class MigrationBrokenEntity extends BaseEntity {
    name!: string;
}

@entity.name('migration_number_entities')
class MigrationNumberEntity extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    score!: number;
    attempts!: number & Minimum<0>;
    total!: UnsignedNumber;
}

@entity.name('migration_uuid_entities')
class MigrationUuidEntity extends BaseEntity {
    id!: UUID & PrimaryKey;
    relatedId!: UUID | null;
}

@entity.name('migration_binary_entities')
class MigrationBinaryEntity extends BaseEntity {
    id!: number & PrimaryKey;
    payload!: Uint8Array;
    optionalPayload?: Uint8Array;
    nullablePayload!: Uint8Array | null;
}

@entity.name('migration_locations')
class MigrationLocationEntity extends BaseEntity {
    id!: number & PrimaryKey;
    zipGeo!: NullableMySQLCoordinate;
    centerPoint!: Coordinate;
}

@entity.name('migration_skipped_entities')
@entity.excludeMigration()
class MigrationSkippedEntity extends BaseEntity {
    id!: number & PrimaryKey;
    name!: string;
}

const tmpDirs: string[] = [];

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tsf-migration-'));
    tmpDirs.push(dir);
    return dir;
}

function col(overrides: Partial<ColumnSchema> & Pick<ColumnSchema, 'name'>): ColumnSchema {
    return {
        type: 'varchar',
        unsigned: false,
        nullable: false,
        autoIncrement: false,
        primaryKey: false,
        ordinalPosition: 1,
        ...overrides
    };
}

function table(name: string, columns: ColumnSchema[], overrides: Partial<TableSchema> = {}): TableSchema {
    return {
        name,
        columns,
        indexes: [],
        foreignKeys: [],
        ...overrides
    };
}

describe('migration schema identifier helpers', () => {
    it('leaves generated identifiers unchanged when they are within the dialect limit', () => {
        assert.equal(normalizeGeneratedIdentifier('users_email_index', 'mysql'), 'users_email_index');
        assert.equal(defaultBlueprintIdentifierName('users', ['email'], 'index', 'postgres'), 'users_email_index');
    });

    it('shortens generated identifiers with a stable hash when needed', () => {
        const original = 'idx_fixture_longIdentifierSegments_entries_longIdentifierSegmentId';
        const name = defaultEntityIndexName('fixture_longIdentifierSegments_entries', ['longIdentifierSegmentId'], 'mysql');

        assert.equal(original.length, 66);
        assert.equal(name.length, maxIdentifierLength('mysql'));
        assert.notEqual(name, original);
        assert.match(name, /^idx_fixture_/);
        assert.match(name, /_[0-9a-f]{8}_/);
        assert.match(name, /SegmentId$/);
        assert.equal(defaultEntityIndexName('fixture_longIdentifierSegments_entries', ['longIdentifierSegmentId'], 'mysql'), name);
    });

    it('uses the Postgres identifier limit for generated names', () => {
        const name = normalizeGeneratedIdentifier('a_very_long_table_name_for_identifier_limit_tests_a_very_long_column_name_index', 'postgres');

        assert.ok(name.length <= maxIdentifierLength('postgres'));
        assert.match(name, /_[0-9a-f]{8}_/);
    });
});

describe('migration create entity schema', () => {
    it('reads entity metadata into dialect-aware table schemas', () => {
        const mysqlDb = new BaseDatabase(new FakeDriver('mysql'), [MigrationUser]);
        const postgresDb = new BaseDatabase(new FakeDriver('postgres'), [MigrationUser]);

        const mysqlTable = readEntitiesSchema(mysqlDb).get('migration_users')!;
        const postgresTable = readEntitiesSchema(postgresDb).get('migration_users')!;
        const mysqlColumns = Object.fromEntries(mysqlTable.columns.map(column => [column.name, column]));
        const postgresColumns = Object.fromEntries(postgresTable.columns.map(column => [column.name, column]));

        assert.equal(mysqlColumns.id.type, 'int');
        assert.equal(mysqlColumns.id.autoIncrement, true);
        assert.equal(mysqlColumns.id.primaryKey, true);
        assert.equal(mysqlColumns.uuid.name, 'uuid');
        assert.equal(mysqlColumns.uuid.type, 'char');
        assert.equal(mysqlColumns.uuid.size, 36);
        assert.equal(mysqlColumns.uuid.unsigned, false);
        assert.equal(mysqlColumns.uuid.nullable, false);
        assert.equal(mysqlColumns.uuid.autoIncrement, false);
        assert.equal(mysqlColumns.uuid.primaryKey, false);
        assert.equal(mysqlColumns.email_address.type, 'varchar');
        assert.equal(mysqlColumns.displayName.type, 'varchar');
        assert.equal(mysqlColumns.displayName.size, 100);
        assert.equal(mysqlColumns.status.type, 'enum');
        assert.deepStrictEqual(mysqlColumns.status.enumValues, ['active', 'disabled']);
        assert.equal(postgresColumns.status.type, 'enum');
        assert.deepStrictEqual(postgresColumns.status.enumValues, ['active', 'disabled']);
        assert.equal(postgresColumns.status.enumTypeName, 'migration_users_status_enum');
        assert.equal(mysqlColumns.code.type, 'char');
        assert.equal(mysqlColumns.code.size, 6);
        assert.equal(mysqlColumns.birthDate.type, 'date');
        assert.equal(mysqlColumns.birthDate.nullable, true);
        assert.equal(mysqlColumns.metadata.type, 'json');
        assert.equal(postgresColumns.uuid.type, 'uuid');
    });

    it('maps UUID entity fields to MySQL binary and PostgreSQL uuid columns', () => {
        const mysqlDb = new BaseDatabase(new FakeDriver('mysql'), [MigrationUuidEntity]);
        const postgresDb = new BaseDatabase(new FakeDriver('postgres'), [MigrationUuidEntity]);
        const mysqlColumns = Object.fromEntries(
            readEntitiesSchema(mysqlDb)
                .get('migration_uuid_entities')!
                .columns.map(column => [column.name, column])
        );
        const postgresColumns = Object.fromEntries(
            readEntitiesSchema(postgresDb)
                .get('migration_uuid_entities')!
                .columns.map(column => [column.name, column])
        );

        assert.equal(mysqlColumns.id.type, 'binary');
        assert.equal(mysqlColumns.id.size, 16);
        assert.equal(mysqlColumns.id.primaryKey, true);
        assert.equal(mysqlColumns.relatedId.type, 'binary');
        assert.equal(mysqlColumns.relatedId.size, 16);
        assert.equal(mysqlColumns.relatedId.nullable, true);
        assert.equal(postgresColumns.id.type, 'uuid');
        assert.equal(postgresColumns.relatedId.type, 'uuid');
    });

    it('maps Uint8Array entity fields to dialect binary columns', () => {
        const mysqlDb = new BaseDatabase(new FakeDriver('mysql'), [MigrationBinaryEntity]);
        const postgresDb = new BaseDatabase(new FakeDriver('postgres'), [MigrationBinaryEntity]);
        const mysqlColumns = Object.fromEntries(
            readEntitiesSchema(mysqlDb)
                .get('migration_binary_entities')!
                .columns.map(column => [column.name, column])
        );
        const postgresColumns = Object.fromEntries(
            readEntitiesSchema(postgresDb)
                .get('migration_binary_entities')!
                .columns.map(column => [column.name, column])
        );

        assert.equal(mysqlColumns.payload.type, 'blob');
        assert.equal(postgresColumns.payload.type, 'bytea');
        assert.equal(mysqlColumns.optionalPayload.type, 'blob');
        assert.equal(mysqlColumns.optionalPayload.nullable, true);
        assert.equal(mysqlColumns.nullablePayload.type, 'blob');
        assert.equal(mysqlColumns.nullablePayload.nullable, true);
    });

    it('maps nullable MySQL coordinate aliases to point columns', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationLocationEntity]);
        const columns = Object.fromEntries(
            readEntitiesSchema(db)
                .get('migration_locations')!
                .columns.map(column => [column.name, column])
        );

        assert.equal(columns.zipGeo.type, 'point');
        assert.equal(columns.zipGeo.nullable, true);
        assert.equal(columns.centerPoint.type, 'point');
        assert.equal(columns.centerPoint.nullable, false);
    });

    it('skips entities excluded from migration generation', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationUser, MigrationSkippedEntity]);
        const schema = readEntitiesSchema(db);

        assert.equal(schema.has('migration_users'), true);
        assert.equal(schema.has('migration_skipped_entities'), false);
    });

    it('maps plain numbers to floating-point columns without changing numeric primary keys', () => {
        const mysqlDb = new BaseDatabase(new FakeDriver('mysql'), [MigrationNumberEntity]);
        const postgresDb = new BaseDatabase(new FakeDriver('postgres'), [MigrationNumberEntity]);
        const mysqlColumns = Object.fromEntries(
            readEntitiesSchema(mysqlDb)
                .get('migration_number_entities')!
                .columns.map(column => [column.name, column])
        );
        const postgresColumns = Object.fromEntries(
            readEntitiesSchema(postgresDb)
                .get('migration_number_entities')!
                .columns.map(column => [column.name, column])
        );

        assert.equal(mysqlColumns.id.type, 'int');
        assert.equal(mysqlColumns.id.autoIncrement, true);
        assert.equal(mysqlColumns.score.type, 'double');
        assert.equal(mysqlColumns.attempts.type, 'double');
        assert.equal(mysqlColumns.attempts.unsigned, true);
        assert.equal(mysqlColumns.total.type, 'double');
        assert.equal(mysqlColumns.total.unsigned, true);
        assert.equal(postgresColumns.id.type, 'int');
        assert.equal(postgresColumns.score.type, 'double');
        assert.equal(postgresColumns.attempts.type, 'double');
        assert.equal(postgresColumns.attempts.unsigned, false);
        assert.equal(postgresColumns.total.type, 'double');
        assert.equal(postgresColumns.total.unsigned, false);
    });

    it('does not let recursive annotations preempt mixed union handling', () => {
        const db = new BaseDatabase(new FakeDriver('postgres'), [MigrationUnionUser]);
        const table = readEntitiesSchema(db).get('migration_union_users')!;
        const columns = Object.fromEntries(table.columns.map(column => [column.name, column]));

        assert.equal(columns.birthDate.type, 'date');
        assert.equal(columns.birthDate.nullable, true);
        assert.equal(columns.mixed.type, 'json');
    });

    it('reads field initializer defaults into entity schemas', () => {
        const mysqlDb = new BaseDatabase(new FakeDriver('mysql'), [MigrationDefaultUser]);
        const postgresDb = new BaseDatabase(new FakeDriver('postgres'), [MigrationDefaultUser]);
        const mysqlColumns = Object.fromEntries(
            readEntitiesSchema(mysqlDb)
                .get('migration_default_users')!
                .columns.map(column => [column.name, column])
        );
        const postgresColumns = Object.fromEntries(
            readEntitiesSchema(postgresDb)
                .get('migration_default_users')!
                .columns.map(column => [column.name, column])
        );

        assert.equal(mysqlColumns.status.defaultValue, 'active');
        assert.equal(mysqlColumns.count.defaultValue, 0);
        assert.equal(mysqlColumns.enabled.type, 'tinyint');
        assert.equal(mysqlColumns.enabled.size, 1);
        assert.equal(mysqlColumns.enabled.unsigned, true);
        assert.equal(mysqlColumns.enabled.defaultValue, '1');
        assert.equal(postgresColumns.enabled.type, 'boolean');
        assert.equal(postgresColumns.enabled.defaultValue, true);
    });

    it('reads indexes and reference foreign keys from type metadata', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationUser, MigrationPost]);
        const table = readEntitiesSchema(db).get('migration_posts')!;
        const columns = Object.fromEntries(table.columns.map(column => [column.name, column]));

        assert.equal(columns.user.type, 'int');
        assert.equal(columns.user.unsigned, false);
        const indexes = Object.fromEntries(table.indexes.map(index => [index.name, index]));
        assert.deepStrictEqual(indexes.idx_migration_posts_user, {
            name: 'idx_migration_posts_user',
            columns: ['user'],
            unique: false
        });
        assert.deepStrictEqual(indexes.idx_migration_posts_slug, {
            name: 'idx_migration_posts_slug',
            columns: ['slug'],
            unique: true,
            size: undefined
        });
        assert.deepStrictEqual(indexes.migration_posts_title_idx, {
            name: 'migration_posts_title_idx',
            columns: ['title'],
            unique: false,
            size: undefined
        });
        assert.deepStrictEqual(table.foreignKeys, [
            {
                name: 'fk_migration_posts_user',
                localColumns: ['user'],
                foreignTable: 'migration_users',
                foreignColumns: ['id'],
                onDelete: 'RESTRICT',
                onUpdate: 'CASCADE'
            }
        ]);
    });

    it('does not add a redundant non-unique index for uniquely indexed references', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationUser, MigrationFeaturedPost]);
        const table = readEntitiesSchema(db).get('migration_featured_posts')!;
        const userIndexes = table.indexes.filter(index => index.columns[0] === 'user');

        assert.deepStrictEqual(userIndexes, [
            {
                name: 'idx_migration_featured_posts_user',
                columns: ['user'],
                unique: true,
                size: undefined
            }
        ]);
    });

    it('merges generated Index and Unique metadata on the same columns', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationIndexUniqueEntity]);
        const table = readEntitiesSchema(db).get('migration_index_unique_entities')!;
        const columns = Object.fromEntries(table.columns.map(column => [column.name, column]));
        const slugIndexes = table.indexes.filter(index => index.columns[0] === 'slug');

        assert.equal(columns.status.type, 'enum');
        assert.equal(columns.status.nullable, true);
        assert.deepStrictEqual(columns.status.enumValues, ['active', 'disabled']);
        assert.equal(slugIndexes.length, 1);
        assert.equal(slugIndexes[0].name, 'idx_migration_index_unique_entities_slug');
        assert.equal(slugIndexes[0].unique, true);
        assert.deepStrictEqual(
            table.indexes.find(index => index.columns[0] === 'status'),
            {
                name: 'migration_index_unique_status_idx',
                columns: ['status'],
                unique: false,
                size: undefined
            }
        );
    });
});

describe('migration create database reader', () => {
    it('reads MySQL information_schema columns into table schemas', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows.push([
            {
                COLUMN_NAME: 'id',
                ORDINAL_POSITION: 1,
                COLUMN_DEFAULT: null,
                IS_NULLABLE: 'NO',
                DATA_TYPE: 'int',
                COLUMN_TYPE: 'int unsigned',
                CHARACTER_MAXIMUM_LENGTH: null,
                NUMERIC_PRECISION: 10,
                NUMERIC_SCALE: 0,
                EXTRA: 'auto_increment',
                COLUMN_KEY: 'PRI'
            },
            {
                COLUMN_NAME: 'status',
                ORDINAL_POSITION: 2,
                COLUMN_DEFAULT: 'active',
                IS_NULLABLE: 'NO',
                DATA_TYPE: 'enum',
                COLUMN_TYPE: "enum('active','disabled')",
                CHARACTER_MAXIMUM_LENGTH: null,
                NUMERIC_PRECISION: null,
                NUMERIC_SCALE: null,
                EXTRA: '',
                COLUMN_KEY: ''
            }
        ]);
        driver.rows.push(
            [{ COLUMN_NAME: 'id' }],
            [
                {
                    INDEX_NAME: 'migration_users_i_status',
                    NON_UNIQUE: 1,
                    SEQ_IN_INDEX: 1,
                    COLUMN_NAME: 'status',
                    SUB_PART: null
                },
                {
                    INDEX_NAME: 'migration_users_u_email_status',
                    NON_UNIQUE: 0,
                    SEQ_IN_INDEX: 1,
                    COLUMN_NAME: 'email_address',
                    SUB_PART: null
                },
                {
                    INDEX_NAME: 'migration_users_u_email_status',
                    NON_UNIQUE: 0,
                    SEQ_IN_INDEX: 2,
                    COLUMN_NAME: 'status',
                    SUB_PART: null
                },
                {
                    INDEX_NAME: 'migration_users_i_prefix',
                    NON_UNIQUE: 1,
                    SEQ_IN_INDEX: 1,
                    COLUMN_NAME: 'email_address',
                    SUB_PART: 20
                },
                {
                    INDEX_NAME: 'migration_users_i_prefix',
                    NON_UNIQUE: 1,
                    SEQ_IN_INDEX: 2,
                    COLUMN_NAME: 'status',
                    SUB_PART: null
                }
            ],
            [
                {
                    CONSTRAINT_NAME: 'migration_users_fk_status_lookup_id',
                    COLUMN_NAME: 'status',
                    REFERENCED_TABLE_NAME: 'status_lookup',
                    REFERENCED_COLUMN_NAME: 'id',
                    ORDINAL_POSITION: 1,
                    UPDATE_RULE: 'CASCADE',
                    DELETE_RULE: 'RESTRICT'
                }
            ]
        );
        const db = new BaseDatabase(driver);

        const schema = await readDatabaseSchema(db, ['migration_users']);
        const table = schema.get('migration_users')!;

        assert.equal(table.columns[0].unsigned, true);
        assert.equal(table.columns[0].autoIncrement, true);
        assert.deepStrictEqual(table.primaryKeyColumns, ['id']);
        assert.deepStrictEqual(table.columns[1].enumValues, ['active', 'disabled']);
        assert.deepStrictEqual(table.indexes, [
            {
                name: 'migration_users_i_status',
                columns: ['status'],
                unique: false
            },
            {
                name: 'migration_users_u_email_status',
                columns: ['email_address', 'status'],
                unique: true
            },
            {
                name: 'migration_users_i_prefix',
                columns: ['email_address', 'status'],
                unique: false,
                columnSizes: {
                    email_address: 20
                }
            }
        ]);
        assert.deepStrictEqual(table.foreignKeys, [
            {
                name: 'migration_users_fk_status_lookup_id',
                localColumns: ['status'],
                foreignTable: 'status_lookup',
                foreignColumns: ['id'],
                onDelete: 'RESTRICT',
                onUpdate: 'CASCADE'
            }
        ]);
        assert.equal(driver.queries[0].bindings[0], 'migration_users');
    });

    it('reads PostgreSQL columns and primary keys into table schemas', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows.push(
            [
                {
                    column_name: 'id',
                    ordinal_position: 1,
                    column_default: "nextval('migration_users_id_seq'::regclass)",
                    is_nullable: 'NO',
                    data_type: 'integer',
                    udt_name: 'int4',
                    character_maximum_length: null,
                    numeric_precision: 32,
                    numeric_scale: 0,
                    is_identity: 'NO'
                },
                {
                    column_name: 'email_address',
                    ordinal_position: 2,
                    column_default: null,
                    is_nullable: 'YES',
                    data_type: 'character varying',
                    udt_name: 'varchar',
                    character_maximum_length: 255,
                    numeric_precision: null,
                    numeric_scale: null,
                    is_identity: 'NO'
                }
            ],
            [{ column_name: 'id' }],
            [
                {
                    index_name: 'migration_users_u_email_address',
                    is_unique: true,
                    columns: ['email_address']
                }
            ],
            [
                {
                    constraint_name: 'migration_users_fk_email_lookup_id',
                    column_name: 'email_address',
                    foreign_table_name: 'email_lookup',
                    foreign_column_name: 'id',
                    ordinal_position: 1,
                    update_rule: 'NO ACTION',
                    delete_rule: 'CASCADE'
                }
            ]
        );
        const db = new BaseDatabase(driver);

        const schema = await readDatabaseSchema(db, ['migration_users']);
        const table = schema.get('migration_users')!;

        assert.equal(table.columns[0].type, 'int');
        assert.equal(table.columns[0].autoIncrement, true);
        assert.equal(table.columns[0].primaryKey, true);
        assert.equal(table.columns[1].type, 'varchar');
        assert.equal(table.columns[1].nullable, true);
        assert.deepStrictEqual(table.indexes, [
            {
                name: 'migration_users_u_email_address',
                columns: ['email_address'],
                unique: true
            }
        ]);
        assert.deepStrictEqual(table.foreignKeys, [
            {
                name: 'migration_users_fk_email_lookup_id',
                localColumns: ['email_address'],
                foreignTable: 'email_lookup',
                foreignColumns: ['id'],
                onDelete: 'CASCADE',
                onUpdate: 'NO ACTION'
            }
        ]);
    });

    it('reads PostgreSQL enum columns with values', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows.push(
            [
                {
                    column_name: 'status',
                    ordinal_position: 1,
                    column_default: null,
                    is_nullable: 'NO',
                    data_type: 'USER-DEFINED',
                    udt_name: 'migration_users_status_enum',
                    character_maximum_length: null,
                    numeric_precision: null,
                    numeric_scale: null,
                    is_identity: 'NO'
                }
            ],
            [
                { type_name: 'migration_users_status_enum', enum_value: 'active', sort_order: 1 },
                { type_name: 'migration_users_status_enum', enum_value: 'disabled', sort_order: 2 }
            ],
            [],
            [],
            []
        );
        const db = new BaseDatabase(driver);

        const schema = await readDatabaseSchema(db, ['migration_users']);
        const status = schema.get('migration_users')!.columns[0];

        assert.equal(status.type, 'enum');
        assert.equal(status.enumTypeName, 'migration_users_status_enum');
        assert.deepStrictEqual(status.enumValues, ['active', 'disabled']);
    });
});

describe('migration create comparison and DDL', () => {
    it('detects added tables and generates create table DDL', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationUser]);
        const diff = compareSchemas(readEntitiesSchema(db), new Map(), 'mysql');
        const ddl = generateDDL(diff);

        assert.equal(diff.addedTables.length, 1);
        assert.match(ddl.join('\n'), /CREATE TABLE `migration_users`/);
        assert.match(ddl.join('\n'), /`id` int AUTO_INCREMENT NOT NULL|`id` int NOT NULL AUTO_INCREMENT/);
        assert.match(ddl.join('\n'), /PRIMARY KEY \(`id`\)/);
        assert.match(ddl.join('\n'), /`status` ENUM\('active', 'disabled'\) NOT NULL/);
        assert.match(ddl.join('\n'), /ENGINE=InnoDB/);
    });

    it('generates PostgreSQL enum type DDL for added tables', () => {
        const db = new BaseDatabase(new FakeDriver('postgres'), [MigrationUser]);
        const diff = compareSchemas(readEntitiesSchema(db), new Map(), 'postgres', 'tenant');
        const ddl = generateDDL(diff).join('\n');

        assert.match(ddl, /CREATE TYPE "tenant"\."migration_users_status_enum" AS ENUM \('active', 'disabled'\)/);
        assert.match(ddl, /"status" "tenant"\."migration_users_status_enum" NOT NULL/);
        assert.doesNotMatch(ddl, /"status" varchar\(255\)/);
    });

    it('detects modified tables and generates alter table DDL', () => {
        const db = new BaseDatabase(new FakeDriver('postgres'), [MigrationUser]);
        const entitySchema = readEntitiesSchema(db);
        const dbSchema = new Map([
            [
                'migration_users',
                {
                    name: 'migration_users',
                    columns: [
                        {
                            name: 'id',
                            type: 'int',
                            unsigned: false,
                            nullable: false,
                            autoIncrement: true,
                            primaryKey: true,
                            ordinalPosition: 1
                        },
                        {
                            name: 'email_address',
                            type: 'varchar',
                            size: 100,
                            unsigned: false,
                            nullable: true,
                            autoIncrement: false,
                            primaryKey: false,
                            ordinalPosition: 2
                        },
                        {
                            name: 'old_column',
                            type: 'varchar',
                            size: 255,
                            unsigned: false,
                            nullable: true,
                            autoIncrement: false,
                            primaryKey: false,
                            ordinalPosition: 3
                        }
                    ],
                    indexes: [
                        {
                            name: 'migration_users_i_legacy',
                            columns: ['old_column'],
                            unique: false
                        },
                        {
                            name: 'migration_users_u_email_address',
                            columns: ['email_address'],
                            unique: false
                        }
                    ],
                    foreignKeys: [
                        {
                            name: 'migration_users_fk_old_column_legacy_id',
                            localColumns: ['old_column'],
                            foreignTable: 'legacy',
                            foreignColumns: ['id'],
                            onDelete: 'CASCADE',
                            onUpdate: 'CASCADE'
                        }
                    ]
                }
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const tableDiff = diff.modifiedTables[0];
        const ddl = generateDDL(diff).join('\n');

        assert.deepStrictEqual(
            tableDiff.addedColumns.map(column => column.name),
            ['uuid', 'displayName', 'status', 'code', 'birthDate', 'metadata']
        );
        assert.deepStrictEqual(
            tableDiff.removedColumns.map(column => column.name),
            ['old_column']
        );
        assert.equal(tableDiff.modifiedColumns[0].name, 'email_address');
        assert.deepStrictEqual(
            tableDiff.removedIndexes.map(index => index.name),
            ['migration_users_i_legacy', 'migration_users_u_email_address']
        );
        assert.deepStrictEqual(
            tableDiff.removedForeignKeys.map(foreignKey => foreignKey.name),
            ['migration_users_fk_old_column_legacy_id']
        );
        assert.match(ddl, /ALTER TABLE "migration_users" DROP COLUMN "old_column"/);
        assert.match(ddl, /ALTER TABLE "migration_users" ADD COLUMN "uuid" uuid NOT NULL/);
        assert.match(ddl, /ALTER TABLE "migration_users" ALTER COLUMN "email_address" TYPE varchar\(255\)/);
        assert.match(ddl, /DROP INDEX "migration_users_i_legacy"/);
        assert.match(ddl, /ALTER TABLE "migration_users" DROP CONSTRAINT "migration_users_fk_old_column_legacy_id"/);
    });

    it('generates index and foreign-key DDL for added tables', () => {
        const db = new BaseDatabase(new FakeDriver('mysql'), [MigrationUser, MigrationPost]);
        const diff = compareSchemas(readEntitiesSchema(db), new Map(), 'mysql');
        const ddl = generateDDL(diff).join('\n');

        assert.match(ddl, /CREATE UNIQUE INDEX `idx_migration_posts_slug` ON `migration_posts` \(`slug`\)/);
        assert.match(ddl, /CREATE INDEX `migration_posts_title_idx` ON `migration_posts` \(`title`\)/);
        assert.match(ddl, /CREATE INDEX `idx_migration_posts_user` ON `migration_posts` \(`user`\)/);
        assert.match(
            ddl,
            /ALTER TABLE `migration_posts` ADD CONSTRAINT `fk_migration_posts_user` FOREIGN KEY \(`user`\) REFERENCES `migration_users` \(`id`\) ON DELETE RESTRICT ON UPDATE CASCADE/
        );
    });

    it('generates per-column MySQL prefix lengths for indexes', () => {
        const entitySchema = new Map([
            [
                'prefixes',
                table(
                    'prefixes',
                    [col({ name: 'email', type: 'varchar', size: 255 }), col({ name: 'status', type: 'varchar', size: 20, ordinalPosition: 2 })],
                    {
                        indexes: [
                            {
                                name: 'prefixes_i_email_status',
                                columns: ['email', 'status'],
                                unique: false,
                                columnSizes: {
                                    email: 20
                                }
                            }
                        ]
                    }
                )
            ]
        ]);

        const ddl = generateDDL(compareSchemas(entitySchema, new Map(), 'mysql')).join('\n');

        assert.match(ddl, /CREATE INDEX `prefixes_i_email_status` ON `prefixes` \(`email`\(20\), `status`\)/);
    });

    it('recreates composite indexes when order, uniqueness, or prefix lengths change', () => {
        const entitySchema = new Map([
            [
                'accounts',
                table(
                    'accounts',
                    [
                        col({ name: 'email', type: 'varchar', size: 255 }),
                        col({ name: 'tenant_id', type: 'int', ordinalPosition: 2 }),
                        col({ name: 'status', type: 'varchar', size: 20, ordinalPosition: 3 })
                    ],
                    {
                        indexes: [
                            {
                                name: 'accounts_i_lookup',
                                columns: ['tenant_id', 'email', 'status'],
                                unique: true,
                                columnSizes: { email: 120 }
                            }
                        ]
                    }
                )
            ]
        ]);
        const dbSchema = new Map([
            [
                'accounts',
                table(
                    'accounts',
                    [
                        col({ name: 'email', type: 'varchar', size: 255 }),
                        col({ name: 'tenant_id', type: 'int', ordinalPosition: 2 }),
                        col({ name: 'status', type: 'varchar', size: 20, ordinalPosition: 3 })
                    ],
                    {
                        indexes: [
                            {
                                name: 'accounts_i_lookup',
                                columns: ['email', 'tenant_id', 'status'],
                                unique: false,
                                columnSizes: { email: 64 }
                            }
                        ]
                    }
                )
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'mysql');
        const ddl = generateDDL(diff);

        assert.equal(diff.modifiedTables[0].modifiedIndexes.length, 1);
        assert.deepStrictEqual(diff.modifiedTables[0].modifiedIndexes[0].newIndex.columns, ['tenant_id', 'email', 'status']);
        assert.equal(diff.modifiedTables[0].modifiedIndexes[0].newIndex.unique, true);
        assert.deepStrictEqual(diff.modifiedTables[0].modifiedIndexes[0].newIndex.columnSizes, {
            email: 120
        });
        assert.ok(ddl.indexOf('DROP INDEX `accounts_i_lookup` ON `accounts`') > -1);
        assert.ok(
            ddl.indexOf('CREATE UNIQUE INDEX `accounts_i_lookup` ON `accounts` (`tenant_id`, `email`(120), `status`)') >
                ddl.indexOf('DROP INDEX `accounts_i_lookup` ON `accounts`')
        );
    });

    it('removes stale defaults and treats enum order as schema-significant', () => {
        const entitySchema = new Map([
            [
                'settings',
                table('settings', [
                    col({
                        name: 'mode',
                        type: 'enum',
                        enumValues: ['active', 'disabled'],
                        enumTypeName: 'settings_mode_enum'
                    }),
                    col({ name: 'label', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'settings',
                table('settings', [
                    col({
                        name: 'mode',
                        type: 'enum',
                        enumValues: ['disabled', 'active'],
                        enumTypeName: 'settings_mode_enum'
                    }),
                    col({
                        name: 'label',
                        type: 'varchar',
                        size: 255,
                        defaultValue: 'legacy',
                        ordinalPosition: 2
                    })
                ])
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const ddl = generateDDL(diff).join('\n');
        const modifications = diff.modifiedTables[0].modifiedColumns;

        assert.equal(modifications.find(modification => modification.name === 'mode')?.typeChanged, true);
        assert.equal(modifications.find(modification => modification.name === 'label')?.defaultChanged, true);
        assert.match(ddl, /CREATE TYPE "settings_mode_enum__next" AS ENUM \('active', 'disabled'\)/);
        assert.match(
            ddl,
            /ALTER TABLE "settings" ALTER COLUMN "mode" TYPE "settings_mode_enum__next" USING "mode"::text::"settings_mode_enum__next"/
        );
        assert.match(ddl, /DROP TYPE "settings_mode_enum"/);
        assert.match(ddl, /ALTER TYPE "settings_mode_enum__next" RENAME TO "settings_mode_enum"/);
        assert.match(ddl, /ALTER TABLE "settings" ALTER COLUMN "label" DROP DEFAULT/);
    });

    it('emits default and nullability changes for both dialects', () => {
        const entitySchema = new Map([
            [
                'settings',
                table('settings', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({ name: 'label', type: 'varchar', size: 255, nullable: true, ordinalPosition: 2 }),
                    col({ name: 'enabled', type: 'boolean', defaultValue: true, ordinalPosition: 3 })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'settings',
                table('settings', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({
                        name: 'label',
                        type: 'varchar',
                        size: 255,
                        defaultValue: 'legacy',
                        ordinalPosition: 2
                    }),
                    col({ name: 'enabled', type: 'boolean', nullable: true, ordinalPosition: 3 })
                ])
            ]
        ]);

        const postgresDiff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const postgresDdl = generateDDL(postgresDiff);
        const mysqlDdl = generateDDL(compareSchemas(entitySchema, dbSchema, 'mysql')).join('\n');

        assert.equal(postgresDiff.modifiedTables[0].modifiedColumns.find(modification => modification.name === 'label')?.nullableChanged, true);
        assert.equal(postgresDiff.modifiedTables[0].modifiedColumns.find(modification => modification.name === 'label')?.defaultChanged, true);
        assert.ok(postgresDdl.includes('ALTER TABLE "settings" ALTER COLUMN "label" DROP NOT NULL'));
        assert.ok(postgresDdl.includes('ALTER TABLE "settings" ALTER COLUMN "label" DROP DEFAULT'));
        assert.ok(postgresDdl.includes('ALTER TABLE "settings" ALTER COLUMN "enabled" SET NOT NULL'));
        assert.ok(postgresDdl.includes('ALTER TABLE "settings" ALTER COLUMN "enabled" SET DEFAULT TRUE'));
        assert.match(mysqlDdl, /ALTER TABLE `settings` MODIFY COLUMN `label` varchar\(255\)/);
        assert.match(mysqlDdl, /ALTER TABLE `settings` MODIFY COLUMN `enabled` tinyint\(1\) NOT NULL DEFAULT TRUE/);
    });

    it('uses ALTER TYPE for append-only PostgreSQL enum changes', () => {
        const entitySchema = new Map([
            [
                'settings',
                table('settings', [
                    col({
                        name: 'mode',
                        type: 'enum',
                        enumValues: ['active', 'disabled', 'paused'],
                        enumTypeName: 'settings_mode_enum'
                    })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'settings',
                table('settings', [
                    col({
                        name: 'mode',
                        type: 'enum',
                        enumValues: ['active', 'disabled'],
                        enumTypeName: 'settings_mode_enum'
                    })
                ])
            ]
        ]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'postgres')).join('\n');

        assert.match(ddl, /ALTER TYPE "settings_mode_enum" ADD VALUE IF NOT EXISTS 'paused'/);
        assert.doesNotMatch(ddl, /settings_mode_enum__next/);
    });

    it('rewrites shared PostgreSQL enum types after every dependent column moves', () => {
        const entitySchema = new Map([
            [
                'settings',
                table('settings', [
                    col({
                        name: 'primaryMode',
                        type: 'enum',
                        enumValues: ['active', 'disabled'],
                        enumTypeName: 'settings_mode_enum'
                    }),
                    col({
                        name: 'secondaryMode',
                        type: 'enum',
                        enumValues: ['active', 'disabled'],
                        enumTypeName: 'settings_mode_enum',
                        ordinalPosition: 2
                    })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'settings',
                table('settings', [
                    col({
                        name: 'primaryMode',
                        type: 'enum',
                        enumValues: ['disabled', 'active'],
                        enumTypeName: 'settings_mode_enum'
                    }),
                    col({
                        name: 'secondaryMode',
                        type: 'enum',
                        enumValues: ['disabled', 'active'],
                        enumTypeName: 'settings_mode_enum',
                        ordinalPosition: 2
                    })
                ])
            ]
        ]);

        const statements = generateDDL(compareSchemas(entitySchema, dbSchema, 'postgres'));
        const create = statements.indexOf(`CREATE TYPE "settings_mode_enum__next" AS ENUM ('active', 'disabled')`);
        const primaryAlter = statements.indexOf(
            `ALTER TABLE "settings" ALTER COLUMN "primaryMode" TYPE "settings_mode_enum__next" USING "primaryMode"::text::"settings_mode_enum__next"`
        );
        const secondaryAlter = statements.indexOf(
            `ALTER TABLE "settings" ALTER COLUMN "secondaryMode" TYPE "settings_mode_enum__next" USING "secondaryMode"::text::"settings_mode_enum__next"`
        );
        const drop = statements.indexOf(`DROP TYPE "settings_mode_enum"`);

        assert.ok(create > -1);
        assert.ok(primaryAlter > create);
        assert.ok(secondaryAlter > create);
        assert.ok(drop > primaryAlter);
        assert.ok(drop > secondaryAlter);
        assert.equal(statements.filter(statement => statement === `DROP TYPE "settings_mode_enum"`).length, 1);
    });

    it('drops owned PostgreSQL enum types after removing enum columns and tables', () => {
        const entitySchema = new Map([['kept', table('kept', [col({ name: 'id', type: 'int' })])]]);
        const dbSchema = new Map([
            [
                'kept',
                table('kept', [
                    col({ name: 'id', type: 'int' }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'disabled'],
                        enumTypeName: 'kept_status_enum',
                        ordinalPosition: 2
                    })
                ])
            ],
            [
                'removed',
                table('removed', [
                    col({
                        name: 'mode',
                        type: 'enum',
                        enumValues: ['on', 'off'],
                        enumTypeName: 'removed_mode_enum'
                    })
                ])
            ]
        ]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'postgres')).join('\n');

        assert.match(ddl, /ALTER TABLE "kept" DROP COLUMN "status"\nDROP TYPE IF EXISTS "kept_status_enum"/);
        assert.match(ddl, /DROP TABLE "removed"\nDROP TYPE IF EXISTS "removed_mode_enum"/);
    });

    it('keeps MySQL datetime distinct from timestamp', () => {
        const entitySchema = new Map([['events', table('events', [col({ name: 'startsAt', type: 'datetime' })])]]);
        const dbSchema = new Map([['events', table('events', [col({ name: 'startsAt', type: 'timestamp' })])]]);

        const diff = compareSchemas(entitySchema, dbSchema, 'mysql');

        assert.equal(diff.modifiedTables[0].modifiedColumns[0].typeChanged, true);
    });

    it('does not detect drift for legacy signed MySQL boolean columns', () => {
        const entitySchema = new Map([
            [
                'flags',
                table('flags', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({ name: 'active', type: 'tinyint', size: 1, unsigned: true, ordinalPosition: 2 })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'flags',
                table('flags', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({ name: 'active', type: 'tinyint', size: 1, unsigned: false, ordinalPosition: 2 })
                ])
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'mysql');

        assert.equal(diff.modifiedTables.length, 0);
    });

    it('does not detect drift for MySQL boolean columns without display width', () => {
        const entitySchema = new Map([
            [
                'flags',
                table('flags', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({ name: 'active', type: 'tinyint', size: 1, unsigned: true, ordinalPosition: 2 })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'flags',
                table('flags', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({
                        name: 'active',
                        type: 'tinyint',
                        size: undefined,
                        unsigned: true,
                        ordinalPosition: 2
                    })
                ])
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'mysql');

        assert.equal(diff.modifiedTables.length, 0);
    });

    it('still detects unsigned changes for non-boolean tinyint columns', () => {
        const entitySchema = new Map([
            [
                'metrics',
                table('metrics', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({
                        name: 'attempt',
                        type: 'tinyint',
                        size: undefined,
                        unsigned: true,
                        ordinalPosition: 2
                    })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'metrics',
                table('metrics', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({
                        name: 'attempt',
                        type: 'tinyint',
                        size: undefined,
                        unsigned: false,
                        ordinalPosition: 2
                    })
                ])
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'mysql');

        assert.equal(diff.modifiedTables.length, 1);
        assert.equal(diff.modifiedTables[0].modifiedColumns[0].typeChanged, true);
    });

    it('does not detect drift for legacy generated entity index and foreign-key names', () => {
        const columns = [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent', type: 'int', ordinalPosition: 2 })];
        const entitySchema = new Map([
            [
                'children',
                table('children', columns, {
                    indexes: [{ name: 'idx_children_parent', columns: ['parent'], unique: false }],
                    foreignKeys: [
                        {
                            name: 'fk_children_parent',
                            localColumns: ['parent'],
                            foreignTable: 'parents',
                            foreignColumns: ['id'],
                            onDelete: 'CASCADE',
                            onUpdate: 'CASCADE'
                        }
                    ]
                })
            ]
        ]);
        const dbSchema = new Map([
            [
                'children',
                table('children', columns, {
                    indexes: [{ name: 'children_i_parent', columns: ['parent'], unique: false }],
                    foreignKeys: [
                        {
                            name: 'children_fk_parent_parents_id',
                            localColumns: ['parent'],
                            foreignTable: 'parents',
                            foreignColumns: ['id'],
                            onDelete: 'CASCADE',
                            onUpdate: 'CASCADE'
                        }
                    ]
                })
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');

        assert.equal(diff.modifiedTables.length, 0);
    });

    it('still detects explicit index and foreign-key name changes', () => {
        const columns = [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent', type: 'int', ordinalPosition: 2 })];
        const entitySchema = new Map([
            [
                'children',
                table('children', columns, {
                    indexes: [{ name: 'custom_parent_idx_next', columns: ['parent'], unique: false }],
                    foreignKeys: [
                        {
                            name: 'custom_parent_fk_next',
                            localColumns: ['parent'],
                            foreignTable: 'parents',
                            foreignColumns: ['id']
                        }
                    ]
                })
            ]
        ]);
        const dbSchema = new Map([
            [
                'children',
                table('children', columns, {
                    indexes: [{ name: 'custom_parent_idx', columns: ['parent'], unique: false }],
                    foreignKeys: [
                        {
                            name: 'custom_parent_fk',
                            localColumns: ['parent'],
                            foreignTable: 'parents',
                            foreignColumns: ['id']
                        }
                    ]
                })
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const tableDiff = diff.modifiedTables[0];

        assert.deepStrictEqual(
            tableDiff.removedIndexes.map(index => index.name),
            ['custom_parent_idx']
        );
        assert.deepStrictEqual(
            tableDiff.addedIndexes.map(index => index.name),
            ['custom_parent_idx_next']
        );
        assert.deepStrictEqual(
            tableDiff.removedForeignKeys.map(foreignKey => foreignKey.name),
            ['custom_parent_fk']
        );
        assert.deepStrictEqual(
            tableDiff.addedForeignKeys.map(foreignKey => foreignKey.name),
            ['custom_parent_fk_next']
        );
    });

    it('adds foreign keys after all table creates and structural alters', () => {
        const entitySchema = new Map([
            [
                'parents',
                table('parents', [
                    col({ name: 'id', type: 'int', primaryKey: true }),
                    col({ name: 'code', type: 'varchar', size: 50, ordinalPosition: 2 })
                ])
            ],
            [
                'children',
                table(
                    'children',
                    [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent_code', type: 'varchar', size: 50, ordinalPosition: 2 })],
                    {
                        foreignKeys: [
                            {
                                name: 'children_fk_parent_code',
                                localColumns: ['parent_code'],
                                foreignTable: 'parents',
                                foreignColumns: ['code']
                            }
                        ]
                    }
                )
            ]
        ]);
        const dbSchema = new Map([['parents', table('parents', [col({ name: 'id', type: 'int', primaryKey: true })])]]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'postgres'));
        const addColumnIndex = ddl.indexOf('ALTER TABLE "parents" ADD COLUMN "code" varchar(50) NOT NULL');
        const addForeignKeyIndex = ddl.indexOf(
            'ALTER TABLE "children" ADD CONSTRAINT "children_fk_parent_code" FOREIGN KEY ("parent_code") REFERENCES "parents" ("code")'
        );

        assert.ok(addColumnIndex > -1);
        assert.ok(addForeignKeyIndex > addColumnIndex);
    });

    it('recreates foreign keys when referential actions change', () => {
        const entitySchema = new Map([
            [
                'children',
                table('children', [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent_id', type: 'int', ordinalPosition: 2 })], {
                    foreignKeys: [
                        {
                            name: 'children_parent_id_fkey',
                            localColumns: ['parent_id'],
                            foreignTable: 'parents',
                            foreignColumns: ['id'],
                            onDelete: 'CASCADE',
                            onUpdate: 'CASCADE'
                        }
                    ]
                })
            ]
        ]);
        const dbSchema = new Map([
            [
                'children',
                table('children', [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent_id', type: 'int', ordinalPosition: 2 })], {
                    foreignKeys: [
                        {
                            name: 'children_parent_id_fkey',
                            localColumns: ['parent_id'],
                            foreignTable: 'parents',
                            foreignColumns: ['id'],
                            onDelete: 'RESTRICT',
                            onUpdate: 'NO ACTION'
                        }
                    ]
                })
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const ddl = generateDDL(diff);
        const dropIndex = ddl.indexOf('ALTER TABLE "children" DROP CONSTRAINT "children_parent_id_fkey"');
        const addIndex = ddl.indexOf(
            'ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") ON DELETE CASCADE ON UPDATE CASCADE'
        );

        assert.equal(diff.modifiedTables[0].modifiedForeignKeys.length, 1);
        assert.ok(dropIndex > -1);
        assert.ok(addIndex > dropIndex);
    });

    it('uses Postgres constraint names for primary-key and unique-index drops', () => {
        const entitySchema = new Map([
            ['accounts', table('accounts', [col({ name: 'id', type: 'int' }), col({ name: 'email', ordinalPosition: 2 })])]
        ]);
        const dbSchema = new Map([
            [
                'accounts',
                table('accounts', [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'email', ordinalPosition: 2 })], {
                    primaryKeyConstraintName: 'accounts_custom_pk',
                    indexes: [
                        {
                            name: 'accounts_email_key',
                            columns: ['email'],
                            unique: true,
                            constraintName: 'accounts_email_key'
                        }
                    ]
                })
            ]
        ]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'postgres')).join('\n');

        assert.match(ddl, /ALTER TABLE "accounts" DROP CONSTRAINT "accounts_email_key"/);
        assert.match(ddl, /ALTER TABLE "accounts" DROP CONSTRAINT "accounts_custom_pk"/);
        assert.doesNotMatch(ddl, /DROP INDEX "accounts_email_key"/);
        assert.doesNotMatch(ddl, /DROP CONSTRAINT "accounts_pkey"/);
    });

    it('schema-qualifies Postgres DDL when a schema is supplied', () => {
        const entitySchema = new Map([
            [
                'children',
                table('children', [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent_id', type: 'int', ordinalPosition: 2 })], {
                    indexes: [{ name: 'children_i_parent_id', columns: ['parent_id'], unique: false }],
                    foreignKeys: [
                        {
                            name: 'children_fk_parent_id',
                            localColumns: ['parent_id'],
                            foreignTable: 'parents',
                            foreignColumns: ['id']
                        }
                    ]
                })
            ]
        ]);

        const ddl = generateDDL(compareSchemas(entitySchema, new Map(), 'postgres', 'tenant')).join('\n');

        assert.match(ddl, /CREATE TABLE "tenant"."children"/);
        assert.match(ddl, /CREATE INDEX "tenant"."children_i_parent_id" ON "tenant"."children"/);
        assert.match(ddl, /REFERENCES "tenant"."parents" \("id"\)/);
    });

    it('strips and restores MySQL AUTO_INCREMENT around primary-key changes', () => {
        const entitySchema = new Map([
            [
                'accounts',
                table('accounts', [
                    col({ name: 'id', type: 'int', autoIncrement: true, primaryKey: true }),
                    col({ name: 'tenant_id', type: 'int', primaryKey: true, ordinalPosition: 2 })
                ])
            ]
        ]);
        const dbSchema = new Map([['accounts', table('accounts', [col({ name: 'id', type: 'int', autoIncrement: true, primaryKey: true })])]]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'mysql'));
        const stripIndex = ddl.indexOf('ALTER TABLE `accounts` MODIFY COLUMN `id` int NOT NULL');
        const dropPrimaryIndex = ddl.indexOf('ALTER TABLE `accounts` DROP PRIMARY KEY');
        const addPrimaryIndex = ddl.indexOf('ALTER TABLE `accounts` ADD PRIMARY KEY (`id`, `tenant_id`)');
        const restoreIndex = ddl.indexOf('ALTER TABLE `accounts` MODIFY COLUMN `id` int NOT NULL AUTO_INCREMENT');

        assert.ok(stripIndex > -1);
        assert.ok(dropPrimaryIndex > stripIndex);
        assert.ok(addPrimaryIndex > dropPrimaryIndex);
        assert.ok(restoreIndex > addPrimaryIndex);
    });

    it('does not strip MySQL AUTO_INCREMENT for non-primary-key changes', () => {
        const entitySchema = new Map([
            [
                'accounts',
                table('accounts', [
                    col({ name: 'id', type: 'int', autoIncrement: true, primaryKey: true }),
                    col({ name: 'email', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            ]
        ]);
        const dbSchema = new Map([
            [
                'accounts',
                table('accounts', [
                    col({ name: 'id', type: 'int', autoIncrement: true, primaryKey: true }),
                    col({ name: 'email', type: 'varchar', size: 100, ordinalPosition: 2 })
                ])
            ]
        ]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'mysql')).join('\n');

        assert.doesNotMatch(ddl, /MODIFY COLUMN `id` int NOT NULL$/m);
        assert.match(ddl, /ALTER TABLE `accounts` MODIFY COLUMN `email` varchar\(255\) NOT NULL/);
    });

    it('emits explicit Postgres identity changes when auto-increment changes', () => {
        const entitySchema = new Map([['accounts', table('accounts', [col({ name: 'id', type: 'int', autoIncrement: true, primaryKey: true })])]]);
        const dbSchema = new Map([['accounts', table('accounts', [col({ name: 'id', type: 'int', primaryKey: true })])]]);

        const ddl = generateDDL(compareSchemas(entitySchema, dbSchema, 'postgres')).join('\n');

        assert.match(ddl, /ALTER TABLE "accounts" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY/);
    });

    it('uses explicit primary-key order when comparing composite keys', () => {
        const columns = [
            col({ name: 'account_id', type: 'int', primaryKey: true, ordinalPosition: 1 }),
            col({ name: 'tenant_id', type: 'int', primaryKey: true, ordinalPosition: 2 })
        ];
        const entitySchema = new Map([['accounts', table('accounts', columns, { primaryKeyColumns: ['account_id', 'tenant_id'] })]]);
        const dbSchema = new Map([['accounts', table('accounts', columns, { primaryKeyColumns: ['tenant_id', 'account_id'] })]]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const ddl = generateDDL(diff).join('\n');

        assert.equal(diff.modifiedTables[0].primaryKeyChanged, true);
        assert.deepStrictEqual(diff.modifiedTables[0].oldPrimaryKey, ['tenant_id', 'account_id']);
        assert.match(ddl, /ALTER TABLE "accounts" ADD PRIMARY KEY \("account_id", "tenant_id"\)/);
    });

    it('preserves unchanged local foreign keys around affected column changes', () => {
        const foreignKey = {
            name: 'children_parent_id_fkey',
            localColumns: ['parent_id'],
            foreignTable: 'parents',
            foreignColumns: ['id']
        };
        const entitySchema = new Map([
            [
                'children',
                table(
                    'children',
                    [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent_id', type: 'bigint', ordinalPosition: 2 })],
                    {
                        foreignKeys: [foreignKey]
                    }
                )
            ]
        ]);
        const dbSchema = new Map([
            [
                'children',
                table('children', [col({ name: 'id', type: 'int', primaryKey: true }), col({ name: 'parent_id', type: 'int', ordinalPosition: 2 })], {
                    foreignKeys: [foreignKey]
                })
            ]
        ]);

        const diff = compareSchemas(entitySchema, dbSchema, 'postgres');
        const ddl = generateDDL(diff);
        const dropForeignKey = ddl.indexOf('ALTER TABLE "children" DROP CONSTRAINT "children_parent_id_fkey"');
        const alterColumn = ddl.indexOf('ALTER TABLE "children" ALTER COLUMN "parent_id" TYPE bigint');
        const addForeignKey = ddl.indexOf(
            'ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id")'
        );

        assert.deepStrictEqual(diff.modifiedTables[0].preservedForeignKeys, [foreignKey]);
        assert.ok(dropForeignKey > -1);
        assert.ok(alterColumn > dropForeignKey);
        assert.ok(addForeignKey > alterColumn);
    });

    it('drops inbound foreign keys before scoped table drops', () => {
        const dbSchema = new Map([['parents', table('parents', [col({ name: 'id', type: 'int', primaryKey: true })])]]);
        const diff = compareSchemas(new Map(), dbSchema, 'postgres', 'tenant');
        diff.externalForeignKeyDrops = [
            {
                tableName: 'children',
                foreignKey: {
                    name: 'children_parent_id_fkey',
                    localColumns: ['parent_id'],
                    foreignTable: 'parents',
                    foreignColumns: ['id']
                }
            }
        ];
        diff.externalForeignKeyAdds = [];

        const ddl = generateDDL(diff);
        const dropForeignKey = ddl.indexOf('ALTER TABLE "tenant"."children" DROP CONSTRAINT "children_parent_id_fkey"');
        const dropTable = ddl.indexOf('DROP TABLE "tenant"."parents"');

        assert.ok(dropForeignKey > -1);
        assert.ok(dropTable > dropForeignKey);
    });
});

describe('migration schema builder compatibility', () => {
    it('builds the complete MySQL column and constraint vocabulary', () => {
        const table = new SchemaTableBuilder('all_types', 'mysql');

        table.id();
        table.uuidString('uuidString');
        table.uuid('uuid');
        table.string('string').index('all_types_string_idx');
        table.char('char', 8).unique('all_types_char_uidx');
        table.text('text');
        table.tinyText('tinyText');
        table.mediumText('mediumText');
        table.longText('longText');
        table.integer('integer');
        table.tinyint('tinyint');
        table.smallint('smallint');
        table.bigint('bigint');
        table.bigInteger('bigInteger');
        table.float('float');
        table.double('double');
        table.decimal('decimal', 12, 4);
        table.boolean('boolean');
        table.dateTime('dateTime');
        table.timestamp('timestamp');
        table.timestamptz('timestamptz');
        table.time('time');
        table.date('date');
        table.json('json');
        table.jsonb('jsonb');
        table.binary('binary', 16);
        table.blob('blob');
        table.enum('status', ['active', 'disabled']);
        table.point('point');
        table.integer('parentId').references('id').on('parents');
        table.timestamps();
        table.spatialIndex('point');
        table.foreign(['uuidString', 'uuid']).referencesAll(['leftId', 'rightId']).on('parents').onDelete('CASCADE').onUpdate('CASCADE');

        const schema = table.toSchema();
        const columns = Object.fromEntries(schema.columns.map(column => [column.name, column]));

        assert.equal(schema.columns.length, 32);
        assert.deepStrictEqual([columns.id.type, columns.id.unsigned, columns.id.autoIncrement, columns.id.primaryKey], ['bigint', true, true, true]);
        assert.deepStrictEqual([columns.uuidString.type, columns.uuidString.size], ['char', 36]);
        assert.deepStrictEqual([columns.uuid.type, columns.uuid.size], ['binary', 16]);
        assert.deepStrictEqual([columns.decimal.type, columns.decimal.size, columns.decimal.scale], ['decimal', 12, 4]);
        assert.deepStrictEqual([columns.boolean.type, columns.boolean.size, columns.boolean.unsigned], ['tinyint', 1, true]);
        assert.equal(columns.jsonb.type, 'json');
        assert.equal(columns.point.type, 'point');
        assert.equal(columns.createdAt.defaultExpression, 'CURRENT_TIMESTAMP');
        assert.equal(columns.updatedAt.onUpdateExpression, 'CURRENT_TIMESTAMP');
        assert.deepStrictEqual(
            schema.indexes.map(index => [index.name, index.unique, index.spatial === true]),
            [
                ['all_types_string_idx', false, false],
                ['all_types_char_uidx', true, false],
                ['all_types_point_index', false, true]
            ]
        );
        assert.deepStrictEqual(schema.foreignKeys[0], {
            name: 'all_types_parentId_foreign',
            localColumns: ['parentId'],
            foreignTable: 'parents',
            foreignColumns: ['id'],
            onDelete: 'RESTRICT',
            onUpdate: 'RESTRICT'
        });
        assert.deepStrictEqual(schema.foreignKeys[1], {
            name: 'all_types_uuidString_uuid_foreign',
            localColumns: ['uuidString', 'uuid'],
            foreignTable: 'parents',
            foreignColumns: ['leftId', 'rightId'],
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        });
    });

    it('supports schema catalog checks, dialect guards, raw statements, and enum registry flushes', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows.push([{ found: 1 }], [{ found: 1 }], []);
        const db = new BaseDatabase(driver);

        await db.schema.dropIfExists('old_events');
        await db.schema.raw('ANALYZE');
        await db.schema.onlyOn('postgres', () => db.schema.raw('SET lock_timeout = 5000'));
        await db.schema.onlyOn('mysql', () => db.schema.raw('SHOULD NOT RUN'));
        await db.schema.enumType('event_status', ['active', 'disabled']);
        await db.schema.enumType('event_status', ['active', 'disabled']);

        assert.equal(await db.schema.hasTable('events'), true);
        assert.equal(await db.schema.hasColumn('events', 'status'), true);
        assert.equal(await db.schema.hasIndex('events', 'events_status_idx'), false);

        const executeCountBeforeFlush = driver.executes.length;
        await db.schema.flush();
        await db.schema.enumType('event_status', ['active', 'disabled']);

        assert.equal(driver.executes[0].sql, 'DROP TABLE IF EXISTS "old_events"');
        assert.equal(driver.executes[1].sql, 'ANALYZE');
        assert.equal(driver.executes[2].sql, 'SET lock_timeout = 5000');
        assert.equal(
            driver.executes.some(query => query.sql.includes('SHOULD NOT RUN')),
            false
        );
        assert.equal(driver.executes.length, executeCountBeforeFlush + 2);
        assert.match(driver.executes.at(-2)!.sql, /CREATE TYPE "event_status" AS ENUM/);
        assert.match(driver.executes.at(-1)!.sql, /CREATE CAST \(text AS "event_status"\)/);
        assert.match(driver.queries[0].sql, /information_schema\.tables/);
        assert.match(driver.queries[1].sql, /information_schema\.columns/);
        assert.match(driver.queries[2].sql, /pg_indexes/);
    });

    it('executes schema.create migrations for MySQL', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver);

        await db.schema.create('schema_users', t => {
            t.uuidString('id').primary();
            t.string('email', 255);
            t.integer('count').unsigned().default(0);
            t.boolean('enabled').default('1');
            t.time('closeoutTime').nullable();
            t.dateTime('createdAt').defaultRaw('CURRENT_TIMESTAMP');
            t.enum('status', ['active', 'disabled']);
            t.json('metadata').nullable();
            t.index(['createdAt']);
            t.unique(['email'], 'schema_users_email_uidx');
        });

        assert.equal(driver.executes.length, 3);
        assert.match(driver.executes[0].sql, /CREATE TABLE `schema_users`/);
        assert.match(driver.executes[0].sql, /`id` char\(36\) NOT NULL/);
        assert.match(driver.executes[0].sql, /`count` int unsigned NOT NULL DEFAULT 0/);
        assert.match(driver.executes[0].sql, /`enabled` tinyint\(1\) unsigned NOT NULL DEFAULT '1'/);
        assert.match(driver.executes[0].sql, /`closeoutTime` time/);
        assert.match(driver.executes[0].sql, /`status` ENUM\('active', 'disabled'\) NOT NULL/);
        assert.match(driver.executes[0].sql, /PRIMARY KEY \(`id`\)/);
        assert.equal(driver.executes[1].sql, 'CREATE INDEX `schema_users_createdAt_index` ON `schema_users` (`createdAt`)');
        assert.equal(driver.executes[2].sql, 'CREATE UNIQUE INDEX `schema_users_email_uidx` ON `schema_users` (`email`)');
    });

    it('executes schema.create migrations for PostgreSQL enums', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver);

        await db.schema.create('schema_users', t => {
            t.uuidString('id').primary();
            t.enum('status', ['active', 'disabled']);
            t.time('closeoutTime').nullable();
            t.index(['status'], 'schema_users_status_idx');
        });

        assert.equal(driver.executes.length, 3);
        assert.equal(driver.executes[0].sql, `CREATE TYPE "schema_users_status_enum" AS ENUM ('active', 'disabled')`);
        assert.match(driver.executes[1].sql, /CREATE TABLE "schema_users"/);
        assert.match(driver.executes[1].sql, /"id" uuid NOT NULL/);
        assert.match(driver.executes[1].sql, /"status" "schema_users_status_enum" NOT NULL/);
        assert.match(driver.executes[1].sql, /"closeoutTime" time/);
        assert.equal(driver.executes[2].sql, 'CREATE INDEX "schema_users_status_idx" ON "schema_users" ("status")');
    });

    it('executes DKSF-compatible schema.alter migrations for MySQL', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver);

        await db.schema.alter('events', t => {
            t.dropIndex('createdAt');
            t.renameIndex('externalReference2', 'externalReference');
            t.boolean('redacted').default('0').change();
            t.integer('sequenceId').unsigned().autoIncrement().change();
            t.string('displayPrefix', 255).nullable().after('displayName');
            t.index('tenantId', 'idx_events_tenantId');
        });

        assert.deepEqual(
            driver.executes.map(execute => execute.sql),
            [
                'DROP INDEX `createdAt` ON `events`',
                'ALTER TABLE `events` RENAME INDEX `externalReference2` TO `externalReference`',
                'ALTER TABLE `events` ADD COLUMN `displayPrefix` varchar(255) AFTER `displayName`',
                "ALTER TABLE `events` MODIFY COLUMN `redacted` tinyint(1) unsigned NOT NULL DEFAULT '0'",
                'ALTER TABLE `events` MODIFY COLUMN `sequenceId` int unsigned NOT NULL AUTO_INCREMENT',
                'CREATE INDEX `idx_events_tenantId` ON `events` (`tenantId`)'
            ]
        );
    });

    it('orders alter removals, column placement, primary keys, indexes, and foreign keys', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver);

        await db.schema.alter('children', table => {
            table.dropForeign('children_parent_foreign');
            table.dropUnique('children_slug_unique');
            table.dropPrimary();
            table.dropColumn('legacy');
            table.string('firstColumn').first();
            table.string('requiredName').notNull().change();
            table.primary(['id', 'tenantId']);
            table.unique('slug', 'children_slug_unique_v2');
            table.foreign('parentId', 'children_parent_foreign_v2').references('id').on('parents').onDelete('CASCADE');
        });

        assert.deepStrictEqual(
            driver.executes.map(execute => execute.sql),
            [
                'ALTER TABLE `children` DROP FOREIGN KEY `children_parent_foreign`',
                'DROP INDEX `children_slug_unique` ON `children`',
                'ALTER TABLE `children` DROP PRIMARY KEY',
                'ALTER TABLE `children` DROP COLUMN `legacy`',
                'ALTER TABLE `children` ADD COLUMN `firstColumn` varchar(255) NOT NULL FIRST',
                'ALTER TABLE `children` MODIFY COLUMN `requiredName` varchar(255) NOT NULL',
                'ALTER TABLE `children` ADD PRIMARY KEY (`id`, `tenantId`)',
                'CREATE UNIQUE INDEX `children_slug_unique_v2` ON `children` (`slug`)',
                'ALTER TABLE `children` ADD CONSTRAINT `children_parent_foreign_v2` FOREIGN KEY (`parentId`) REFERENCES `parents` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT'
            ]
        );
    });

    it('executes DKSF-compatible schema drop, rename, and renameColumn migrations', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver);

        await db.schema.drop('archivedRecords');
        await db.schema.rename('tenantRecords', 'records');
        await db.schema.alter('eventMessages', t => {
            t.renameColumn('replyContext', 'context');
        });

        assert.deepEqual(
            driver.executes.map(execute => execute.sql),
            [
                'DROP TABLE `archivedRecords`',
                'RENAME TABLE `tenantRecords` TO `records`',
                'ALTER TABLE `eventMessages` RENAME COLUMN `replyContext` TO `context`'
            ]
        );
    });

    it('executes DKSF-compatible schema.alter migrations for PostgreSQL', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver);

        await db.schema.alter('users', t => {
            t.dropIndex('users_email_idx');
            t.renameIndex('users_name_idx_old', 'users_name_idx');
            t.string('email', 255).nullable().change();
        });

        assert.deepEqual(
            driver.executes.map(execute => execute.sql),
            [
                'DROP INDEX "users_email_idx"',
                'ALTER INDEX "users_name_idx_old" RENAME TO "users_name_idx"',
                'ALTER TABLE "users" ALTER COLUMN "email" TYPE varchar(255)',
                'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL',
                'ALTER TABLE "users" ALTER COLUMN "email" DROP DEFAULT'
            ]
        );
    });
});

describe('migration create plan and files', () => {
    it('builds a migration plan from entity and database schemas', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows.push([], []);
        const db = new BaseDatabase(driver, [MigrationUser]);

        const plan = await createMigrationPlan(db);

        assert.equal(plan.hasChanges, true);
        assert.equal(plan.diff.addedTables[0].name, 'migration_users');
        assert.match(plan.statements.join('\n'), /CREATE TABLE `migration_users`/);
    });

    it('limits migration plans to requested tables', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows.push([]);
        const db = new BaseDatabase(driver, [MigrationUser, MigrationPost, MigrationBrokenEntity]);

        const plan = await createMigrationPlan(db, { tableNames: ['migration_users'] });

        assert.deepStrictEqual(
            plan.diff.addedTables.map(table => table.name),
            ['migration_users']
        );
        assert.doesNotMatch(plan.statements.join('\n'), /migration_posts/);
        assert.equal(driver.queries.length, 1);
        assert.deepStrictEqual(driver.queries[0].bindings, ['migration_users']);
    });

    it('reads inbound foreign keys for scoped table drops', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows.push(
            [
                {
                    column_name: 'id',
                    ordinal_position: 1,
                    column_default: null,
                    is_nullable: 'NO',
                    data_type: 'integer',
                    udt_name: 'int4',
                    character_maximum_length: null,
                    numeric_precision: 32,
                    numeric_scale: 0,
                    is_identity: 'NO'
                }
            ],
            [{ constraint_name: 'parents_pkey', column_name: 'id' }],
            [],
            [],
            [
                {
                    table_name: 'children',
                    constraint_name: 'children_parent_id_fkey',
                    column_name: 'parent_id',
                    foreign_table_name: 'parents',
                    foreign_column_name: 'id',
                    ordinal_position: 1,
                    update_rule: 'NO ACTION',
                    delete_rule: 'CASCADE'
                }
            ]
        );
        const db = new BaseDatabase(driver, []);

        const plan = await createMigrationPlan(db, { tableNames: ['parents'], pgSchema: 'tenant' });
        const dropForeignKey = plan.statements.indexOf('ALTER TABLE "tenant"."children" DROP CONSTRAINT "children_parent_id_fkey"');
        const dropTable = plan.statements.indexOf('DROP TABLE "tenant"."parents"');

        assert.equal(plan.hasChanges, true);
        assert.deepStrictEqual(plan.diff.externalForeignKeyDrops, [
            {
                tableName: 'children',
                foreignKey: {
                    name: 'children_parent_id_fkey',
                    localColumns: ['parent_id'],
                    foreignTable: 'parents',
                    foreignColumns: ['id'],
                    onDelete: 'CASCADE',
                    onUpdate: 'NO ACTION'
                }
            }
        ]);
        assert.ok(dropForeignKey > -1);
        assert.ok(dropTable > dropForeignKey);
        assert.deepStrictEqual(driver.queries.at(-1)?.bindings, ['tenant', 'tenant', 'parents']);
    });

    it('restores inbound foreign keys after scoped referenced-column changes', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows.push(
            [
                {
                    column_name: 'id',
                    ordinal_position: 1,
                    column_default: null,
                    is_nullable: 'NO',
                    data_type: 'character varying',
                    udt_name: 'varchar',
                    character_maximum_length: 255,
                    numeric_precision: null,
                    numeric_scale: null,
                    is_identity: 'NO'
                }
            ],
            [{ constraint_name: 'parents_pkey', column_name: 'id' }],
            [],
            [],
            [
                {
                    table_name: 'children',
                    constraint_name: 'children_parent_id_fkey',
                    column_name: 'parent_id',
                    foreign_table_name: 'parents',
                    foreign_column_name: 'id',
                    ordinal_position: 1,
                    update_rule: 'NO ACTION',
                    delete_rule: 'CASCADE'
                }
            ]
        );
        const db = new BaseDatabase(driver, [MigrationParent]);

        const plan = await createMigrationPlan(db, { tableNames: ['parents'], pgSchema: 'tenant' });
        const dropForeignKey = plan.statements.indexOf('ALTER TABLE "tenant"."children" DROP CONSTRAINT "children_parent_id_fkey"');
        const alterColumn = plan.statements.indexOf('ALTER TABLE "tenant"."parents" ALTER COLUMN "id" TYPE integer');
        const addForeignKey = plan.statements.indexOf(
            'ALTER TABLE "tenant"."children" ADD CONSTRAINT "children_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tenant"."parents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION'
        );

        assert.equal(plan.hasChanges, true);
        assert.equal(plan.diff.externalForeignKeyAdds.length, 1);
        assert.ok(dropForeignKey > -1);
        assert.ok(alterColumn > dropForeignKey);
        assert.ok(addForeignKey > alterColumn);
    });

    it('drops inbound foreign keys before full-plan referenced-column changes', async () => {
        const driver = new FakeDriver('postgres');
        driver.rows.push(
            [{ tablename: 'parents' }, { tablename: 'children' }],
            [
                {
                    column_name: 'id',
                    ordinal_position: 1,
                    column_default: null,
                    is_nullable: 'NO',
                    data_type: 'character varying',
                    udt_name: 'varchar',
                    character_maximum_length: 255,
                    numeric_precision: null,
                    numeric_scale: null,
                    is_identity: 'NO'
                }
            ],
            [{ constraint_name: 'parents_pkey', column_name: 'id' }],
            [],
            [],
            [
                {
                    column_name: 'id',
                    ordinal_position: 1,
                    column_default: null,
                    is_nullable: 'NO',
                    data_type: 'integer',
                    udt_name: 'int4',
                    character_maximum_length: null,
                    numeric_precision: 32,
                    numeric_scale: 0,
                    is_identity: 'NO'
                },
                {
                    column_name: 'parent',
                    ordinal_position: 2,
                    column_default: null,
                    is_nullable: 'NO',
                    data_type: 'integer',
                    udt_name: 'int4',
                    character_maximum_length: null,
                    numeric_precision: 32,
                    numeric_scale: 0,
                    is_identity: 'NO'
                }
            ],
            [{ constraint_name: 'children_pkey', column_name: 'id' }],
            [
                {
                    index_name: 'children_i_parent',
                    is_unique: false,
                    constraint_name: null,
                    columns: ['parent']
                }
            ],
            [
                {
                    table_name: 'children',
                    constraint_name: 'children_fk_parent_parents_id',
                    column_name: 'parent',
                    foreign_table_name: 'parents',
                    foreign_column_name: 'id',
                    ordinal_position: 1,
                    update_rule: 'CASCADE',
                    delete_rule: 'CASCADE'
                }
            ],
            [
                {
                    table_name: 'children',
                    constraint_name: 'children_fk_parent_parents_id',
                    column_name: 'parent',
                    foreign_table_name: 'parents',
                    foreign_column_name: 'id',
                    ordinal_position: 1,
                    update_rule: 'CASCADE',
                    delete_rule: 'CASCADE'
                }
            ]
        );
        const db = new BaseDatabase(driver, [MigrationParent, MigrationChild]);

        const plan = await createMigrationPlan(db, { pgSchema: 'tenant' });
        const dropForeignKey = plan.statements.indexOf('ALTER TABLE "tenant"."children" DROP CONSTRAINT "children_fk_parent_parents_id"');
        const alterColumn = plan.statements.indexOf('ALTER TABLE "tenant"."parents" ALTER COLUMN "id" TYPE integer');
        const addForeignKey = plan.statements.indexOf(
            'ALTER TABLE "tenant"."children" ADD CONSTRAINT "children_fk_parent_parents_id" FOREIGN KEY ("parent") REFERENCES "tenant"."parents" ("id") ON DELETE CASCADE ON UPDATE CASCADE'
        );

        assert.equal(plan.hasChanges, true);
        assert.equal(plan.diff.externalForeignKeyAdds.length, 1);
        assert.equal(plan.diff.externalForeignKeyAdds[0].foreignKey.name, 'children_fk_parent_parents_id');
        assert.ok(dropForeignKey > -1);
        assert.ok(alterColumn > dropForeignKey);
        assert.ok(addForeignKey > alterColumn);
    });

    it('writes runnable migration files with grouped raw SQL statements', () => {
        const dir = tmpDir();
        const file = writeMigrationFile(['\0table:users', 'CREATE TABLE "users" ("id" integer NOT NULL)'], 'create users', {
            migrationsDir: dir,
            now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
        });

        assert.equal(file, join(dir, '20260102_030405_create_users.ts'));
        const content = readFileSync(file, 'utf8');
        assert.match(content, /import \{ createMigration \} from '@zyno-io\/ts-server-foundation'/);
        assert.match(content, /\/\/ Table: users/);
        assert.match(content, /await db\.rawExecute\(`CREATE TABLE "users" \("id" integer NOT NULL\)`\);/);
    });
});
