import { AutoIncrement, entity, PrimaryKey, type UUID, type UuidString } from '../src';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BaseDatabase,
    BaseEntity,
    createSqlQuery,
    createEntity,
    createEntities,
    createPersistedEntity,
    createPersistedEntities,
    createQueuedEntities,
    createQueuedEntity,
    DatabaseSession,
    DatabaseDriver,
    type Coordinate,
    DateString,
    DriverConnection,
    ExecuteResult,
    getDirtyDetails,
    getDirtyFields,
    getEntitiesById,
    getEntityMetadata,
    getFieldOriginal,
    getKeyedEntities,
    getKeyedGroupedEntities,
    flattenMutexKey,
    MySQLCoordinate,
    type HasDefault,
    isEntityDirty,
    logSql,
    markEntityClean,
    persistEntities,
    QueryResult,
    NullableMySQLCoordinate,
    registerDatabaseQueryObserver,
    resolveRelated,
    resolveRelatedByPivot,
    sql,
    UniqueConstraintError,
    revertDirtyEntity
} from '../src';
import type { RenderedSql } from '../src';

class FakeConnection implements DriverConnection {
    released = false;
    commands: string[] = [];

    constructor(private driver: FakeDriver) {}

    async query<T = Record<string, unknown>>(query: RenderedSql): Promise<QueryResult<T>> {
        this.commands.push('query');
        this.driver.queries.push(query);
        if (this.driver.queryError) throw this.driver.queryError;
        const rows = this.driver.rowSets.length ? this.driver.rowSets.shift()! : this.driver.rows;
        return { rows: rows as T[] };
    }

    async execute(query: RenderedSql): Promise<ExecuteResult> {
        this.commands.push('execute');
        this.driver.executes.push(query);
        if (this.driver.executeError) throw this.driver.executeError;
        return this.driver.executeResult;
    }

    async begin(): Promise<void> {
        this.commands.push('begin');
    }

    async commit(): Promise<void> {
        this.commands.push('commit');
        if (this.driver.commitError) throw this.driver.commitError;
    }

    async rollback(): Promise<void> {
        this.commands.push('rollback');
    }

    async savepoint(name: string): Promise<void> {
        this.commands.push(`savepoint:${name}`);
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        this.commands.push(`rollbackToSavepoint:${name}`);
    }

    async release(): Promise<void> {
        this.commands.push('release');
        this.released = true;
    }
}

class FakeDriver implements DatabaseDriver {
    readonly dialect: 'postgres' | 'mysql';
    rows: Record<string, unknown>[] = [];
    rowSets: Record<string, unknown>[][] = [];
    executeResult: ExecuteResult = { affectedRows: 1, insertId: 10 };
    executeError?: unknown;
    queryError?: unknown;
    commitError?: unknown;
    queries: RenderedSql[] = [];
    executes: RenderedSql[] = [];
    connections: FakeConnection[] = [];

    constructor(dialect: 'postgres' | 'mysql' = 'postgres') {
        this.dialect = dialect;
    }

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async acquire(): Promise<DriverConnection> {
        const connection = new FakeConnection(this);
        this.connections.push(connection);
        return connection;
    }
}

function createMySQLPointBuffer(x: number, y: number): Buffer {
    const buffer = Buffer.alloc(25);
    buffer.writeUInt32LE(0, 0);
    buffer.writeUInt8(1, 4);
    buffer.writeUInt32LE(1, 5);
    buffer.writeDoubleLE(x, 9);
    buffer.writeDoubleLE(y, 17);
    return buffer;
}

function uuidBuffer(value: string): Buffer {
    return Buffer.from(value.replace(/-/g, ''), 'hex');
}

@entity.name('users')
class User extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string;
    email!: string | null;
}

@entity.name('dated_records')
class DatedRecord extends BaseEntity {
    id!: number & PrimaryKey;
    createdAt!: Date;
    expiresAt!: Date | null;
}

@entity.name('date_string_records')
class DateStringRecord extends BaseEntity {
    id!: number & PrimaryKey;
    birthdate!: DateString | null;
}

@entity.name('uuid_records')
class UuidRecord extends BaseEntity {
    id!: UUID & PrimaryKey;
    relatedId!: UUID | null;
    label!: string;
}

@entity.name('uuid_string_records')
class UuidStringRecord extends BaseEntity {
    id!: UuidString & PrimaryKey;
    relatedId!: UuidString | null;
    label!: string;
}

@entity.name('binary_records')
class BinaryRecord extends BaseEntity {
    id!: number & PrimaryKey;
    data!: Uint8Array;
    nullableData!: Uint8Array | null;
    optionalData?: Uint8Array;
}

@entity.name('bigint_records')
class BigIntRecord extends BaseEntity {
    id!: number & PrimaryKey;
    count!: bigint;
    optionalCount?: bigint;
}

@entity.name('locations')
class LocationEntity extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    location!: MySQLCoordinate;
    nullableLocation!: NullableMySQLCoordinate;
    plainCoordinate!: Coordinate;
}

@entity.name('api_tokens')
class ApiToken extends BaseEntity {
    token!: string & PrimaryKey;
    label!: string;
}

@entity.name('defaulted_users')
class DefaultedUser extends BaseEntity {
    id!: number & PrimaryKey & AutoIncrement;
    name!: string;
    role!: string & HasDefault;
}

@entity.name('admin_users')
class AdminUser extends BaseEntity {
    id!: number & PrimaryKey;
    isAdmin: boolean & HasDefault = false;
}

@entity.name('account_balances')
class AccountBalance extends BaseEntity {
    id!: number & PrimaryKey;
    balance!: number;
}

@entity.name('session_user_ids')
class SessionUserId {
    sessionId!: string & PrimaryKey;
    userId!: string & PrimaryKey;
}

class AuditedEntity extends BaseEntity {}

@entity.name('audited_session_user_ids')
class AuditedSessionUserId extends AuditedEntity {
    sessionId!: string & PrimaryKey;
    userId!: string & PrimaryKey;
}

@entity.name('composite_links')
class CompositeLink extends BaseEntity {
    orgId!: string & PrimaryKey;
    userId!: string & PrimaryKey;
    role!: string;
}

@entity.name('json_settings')
class JsonSetting extends BaseEntity {
    id!: number & PrimaryKey;
    tags: string[] = [];
    config: { enabled: boolean; retries: number } = { enabled: false, retries: 0 };
}

type TargetPlatform = 'ios' | 'android';
type AssetPlatform = TargetPlatform | 'all';

@entity.name('platform_assets')
class PlatformAsset extends BaseEntity {
    id!: number & PrimaryKey;
    platform!: AssetPlatform;
}

@entity.name('relation_sources')
class RelationSource extends BaseEntity {
    id!: number & PrimaryKey;
    relatedId!: number | null;
}

@entity.name('relation_targets')
class RelationTarget extends BaseEntity {
    id!: number & PrimaryKey;
    label!: string;
}

@entity.name('relation_pivots')
class RelationPivot extends BaseEntity {
    id!: number & PrimaryKey;
    sourceId!: number;
    relatedId!: number;
}

describe('database metadata and entities', () => {
    it('reads entity metadata from type reflection', () => {
        const metadata = getEntityMetadata(User);
        assert.equal(metadata.tableName, 'users');
        assert.equal(metadata.primaryKey.propertyName, 'id');
        assert.equal(metadata.primaryKey.autoIncrement, true);
        assert.deepStrictEqual(
            metadata.columns.map(column => column.propertyName),
            ['id', 'name', 'email']
        );

        const composite = getEntityMetadata(SessionUserId);
        assert.deepStrictEqual(
            composite.primaryKeys.map(column => column.propertyName),
            ['sessionId', 'userId']
        );
    });

    it('creates entities with auto increment sentinel and nullable database defaults', () => {
        const user = createEntity(User, { name: 'Alice' });
        assert.equal(user.id, 0);
        assert.equal(user.email, null);
        assert.equal(user.name, 'Alice');

        const binary = createEntity(BinaryRecord, {
            id: 1,
            data: new Uint8Array(),
            nullableData: null
        });
        assert.equal(binary.optionalData, null);
    });

    it('tracks and reverts dirty fields', () => {
        const user = createEntity(User, { id: 1, name: 'Alice', email: 'a@example.com' });
        markEntityClean(user);
        user.email = 'b@example.com';

        assert.equal(isEntityDirty(user), true);
        assert.deepStrictEqual(getDirtyDetails(user), {
            email: { original: 'a@example.com', current: 'b@example.com' }
        });
        assert.equal(getFieldOriginal(user, 'email'), 'a@example.com');

        revertDirtyEntity(user);
        assert.equal(user.email, 'a@example.com');
    });

    it('tracks in-place mutations to JSON and array fields', () => {
        const setting = createEntity(JsonSetting, {
            id: 1,
            tags: ['alpha'],
            config: { enabled: false, retries: 0 }
        });
        markEntityClean(setting);

        setting.tags.push('beta');
        setting.config.retries = 2;

        assert.deepStrictEqual(getDirtyFields(setting), ['tags', 'config']);
        assert.deepStrictEqual(getDirtyDetails(setting), {
            tags: { original: ['alpha'], current: ['alpha', 'beta'] },
            config: { original: { enabled: false, retries: 0 }, current: { enabled: false, retries: 2 } }
        });

        revertDirtyEntity(setting);
        assert.deepStrictEqual(setting.tags, ['alpha']);
        assert.deepStrictEqual(setting.config, { enabled: false, retries: 0 });
    });
});

describe('database query builder and persistence', () => {
    it('binds nested string literal union values without JSON encoding', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [PlatformAsset]);

        await db.persist(createEntity(PlatformAsset, { id: 1, platform: 'ios' }));
        await db.query(PlatformAsset).filter({ platform: 'android' }).find();

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `platform_assets` (`id`, `platform`) VALUES (?, ?)',
            bindings: [1, 'ios']
        });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `platform` FROM `platform_assets` WHERE `platform` = ?',
            bindings: ['android']
        });
    });

    it('preserves numeric zero in batched, keyed, and grouped entity lookups', async () => {
        const driver = new FakeDriver();
        new BaseDatabase(driver, [RelationTarget, RelationPivot]);

        driver.rows = [{ id: 0, label: 'Zero' }];
        const entities = await getEntitiesById({
            schema: RelationTarget,
            ids: [undefined, 0, null, 0]
        });
        assert.equal(entities[0].id, 0);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "label" FROM "relation_targets" WHERE "id" IN ($1)',
            bindings: [0]
        });

        const keyed = await getKeyedEntities({ schema: RelationTarget, ids: [0] });
        assert.equal(keyed['0'].label, 'Zero');

        driver.rows = [
            { id: 1, sourceId: 0, relatedId: 10 },
            { id: 2, sourceId: 0, relatedId: 11 }
        ];
        const grouped = await getKeyedGroupedEntities({
            schema: RelationPivot,
            ids: [0],
            keyField: 'sourceId'
        });
        assert.deepStrictEqual(
            grouped['0'].map(pivot => pivot.sourceId),
            [0, 0]
        );
        assert.deepStrictEqual(driver.queries[2], {
            sql: 'SELECT "id", "sourceId", "relatedId" FROM "relation_pivots" WHERE "sourceId" IN ($1)',
            bindings: [0]
        });
    });

    it('resolves direct and pivot relations whose source or target ID is zero', async () => {
        const driver = new FakeDriver();
        new BaseDatabase(driver, [RelationSource, RelationTarget, RelationPivot]);

        const directSource = createEntity(RelationSource, { id: 1, relatedId: 0 });
        driver.rows = [{ id: 0, label: 'Zero' }];
        const [direct] = await resolveRelated({
            src: [directSource],
            srcIdField: 'relatedId',
            targetField: 'related',
            targetSchema: RelationTarget
        });
        assert.equal(direct.related?.id, 0);

        const pivotSource = createEntity(RelationSource, { id: 0, relatedId: null });
        driver.rowSets = [[{ id: 1, sourceId: 0, relatedId: 0 }], [{ id: 0, label: 'Zero' }]];
        const [resolved] = await resolveRelatedByPivot({
            src: [pivotSource],
            pivotSchema: RelationPivot,
            pivotIdKey: 'sourceId',
            pivotRelatedKey: 'relatedId',
            targetField: 'related',
            targetSchema: RelationTarget
        });
        assert.equal(resolved.related[0].id, 0);
        assert.equal(resolved.related[0].pivot.sourceId, 0);
        assert.deepStrictEqual(
            driver.queries.slice(-2).map(query => query.bindings),
            [[0], [0]]
        );
    });

    it('generates select SQL and hydrates clean entities', async () => {
        const driver = new FakeDriver();
        driver.rows = [{ id: 1, name: 'Alice', email: 'a@example.com' }];
        const db = new BaseDatabase(driver, [User]);

        const users = await db
            .query(User)
            .filter({ id: { $in: [1, 2] }, email: null })
            .orderBy('id', 'desc')
            .limit(5)
            .find();

        assert.equal(users[0].name, 'Alice');
        assert.equal(isEntityDirty(users[0]), false);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE "id" IN ($1, $2) AND "email" IS NULL ORDER BY "id" DESC LIMIT $3',
            bindings: [1, 2, 5]
        });
    });

    it('supports sort and skip aliases', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db.query(User).sort({ name: 'asc', id: 'desc' }).skip(10).limit(5).find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" ORDER BY "name" ASC, "id" DESC LIMIT $1 OFFSET $2',
            bindings: [5, 10]
        });
    });

    it('rejects configured entities that do not extend BaseEntity', () => {
        const driver = new FakeDriver();

        assert.throws(() => new BaseDatabase(driver, [SessionUserId]), /Database entity SessionUserId must extend BaseEntity/);
    });

    it('accepts configured entities that indirectly extend BaseEntity', () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [AuditedSessionUserId]);

        assert.deepStrictEqual(db.entityRegistry, [AuditedSessionUserId]);
    });

    it('uses all composite primary-key columns for mutations', async () => {
        const driver = new FakeDriver();
        driver.rows = [
            { orgId: 'org-1', userId: 'user-1' },
            { orgId: 'org-1', userId: 'user-2' }
        ];
        driver.executeResult = { affectedRows: 2 };
        const db = new BaseDatabase(driver, [CompositeLink]);

        const patch = await db.query(CompositeLink).filter({ orgId: 'org-1' }).patchMany({ role: 'viewer' });
        const del = await db.query(CompositeLink).filter({ orgId: 'org-1' }).deleteMany();

        assert.deepStrictEqual(patch.primaryKeys, [
            { orgId: 'org-1', userId: 'user-1' },
            { orgId: 'org-1', userId: 'user-2' }
        ]);
        assert.deepStrictEqual(del.primaryKeys, patch.primaryKeys);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "orgId", "userId" FROM "composite_links" WHERE "orgId" = $1',
            bindings: ['org-1']
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE "composite_links" SET "role" = $1 WHERE ("orgId" = $2 AND "userId" = $3) OR ("orgId" = $4 AND "userId" = $5)',
            bindings: ['viewer', 'org-1', 'user-1', 'org-1', 'user-2']
        });
        assert.deepStrictEqual(driver.executes[1], {
            sql: 'DELETE FROM "composite_links" WHERE ("orgId" = $1 AND "userId" = $2) OR ("orgId" = $3 AND "userId" = $4)',
            bindings: ['org-1', 'user-1', 'org-1', 'user-2']
        });

        const existing = createEntity(CompositeLink, {
            orgId: 'org-2',
            userId: 'user-3',
            role: 'editor'
        });
        markEntityClean(existing);
        existing.role = 'admin';
        await existing.save();

        assert.deepStrictEqual(driver.executes[2], {
            sql: 'UPDATE "composite_links" SET "role" = $1 WHERE "orgId" = $2 AND "userId" = $3',
            bindings: ['admin', 'org-2', 'user-3']
        });
    });

    it('serializes JSON column values before binding them', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [JsonSetting]);

        await createPersistedEntity(JsonSetting, {
            id: 1,
            tags: ['alpha', 'beta'],
            config: { enabled: true, retries: 2 }
        });
        driver.rows = [{ id: 1 }];
        await db
            .query(JsonSetting)
            .filter({ tags: ['alpha'] })
            .patchMany({ config: { enabled: false, retries: 3 } });

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO "json_settings" ("id", "tags", "config") VALUES ($1, $2, $3)',
            bindings: [1, '["alpha","beta"]', '{"enabled":true,"retries":2}']
        });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id" FROM "json_settings" WHERE "tags" = $1',
            bindings: ['["alpha"]']
        });
        assert.deepStrictEqual(driver.executes[1], {
            sql: 'UPDATE "json_settings" SET "config" = $1 WHERE "id" IN ($2)',
            bindings: ['{"enabled":false,"retries":3}', 1]
        });

        driver.rows = [{ id: 2, tags: '["loaded"]', config: '{"enabled":true,"retries":4}' }];
        const loaded = await db.query(JsonSetting).findOne();
        assert.deepStrictEqual(loaded.tags, ['loaded']);
        assert.deepStrictEqual(loaded.config, { enabled: true, retries: 4 });
    });

    it('inserts auto-increment entities and assigns generated id', async () => {
        const driver = new FakeDriver();
        driver.rows = [{ id: 42 }];
        const db = new BaseDatabase(driver, [User]);

        const user = await createPersistedEntity(User, { name: 'Alice', email: null });

        assert.equal(user.id, 42);
        assert.equal(isEntityDirty(user), false);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'INSERT INTO "users" ("name", "email") VALUES ($1, $2) RETURNING "id"',
            bindings: ['Alice', null]
        });
        assert.equal(driver.executes.length, 0);
        assert.equal(User.getDatabase(), db);
    });

    it('inserts new entities with assigned primary keys', async () => {
        const driver = new FakeDriver();
        new BaseDatabase(driver, [ApiToken]);

        const token = createEntity(ApiToken, { token: 'secret', label: 'Deploy key' });
        await token.save();

        assert.equal(isEntityDirty(token), false);
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO "api_tokens" ("token", "label") VALUES ($1, $2)',
            bindings: ['secret', 'Deploy key']
        });
    });

    it('omits undefined HasDefault columns on insert', async () => {
        const driver = new FakeDriver();
        driver.rows = [{ id: 42 }];
        new BaseDatabase(driver, [DefaultedUser]);

        const user = await createPersistedEntity(DefaultedUser, { name: 'Alice' });

        assert.equal(user.id, 42);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'INSERT INTO "defaulted_users" ("name") VALUES ($1) RETURNING "id"',
            bindings: ['Alice']
        });
    });

    it('queues and persists entity batches', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User, ApiToken]);

        await db.transaction(async session => {
            const queued = createQueuedEntity(User, { name: 'Queued one', email: null }, session);
            const queuedBatch = createQueuedEntities(
                User,
                [
                    { name: 'Queued two', email: null },
                    { name: 'Queued three', email: null }
                ],
                session
            );

            assert.equal(queued.id, 0);
            assert.equal(queuedBatch.length, 2);
            assert.equal(driver.executes.length, 0);
        });

        assert.equal(driver.executes.length, 3);

        driver.executes.length = 0;
        const tokens = createEntities(ApiToken, [
            { token: 'one', label: 'One' },
            { token: 'two', label: 'Two' }
        ]);
        await persistEntities(tokens);
        assert.equal(driver.executes.length, 2);

        driver.executes.length = 0;
        const persisted = await createPersistedEntities(ApiToken, [{ token: 'three', label: 'Three' }]);
        assert.equal(persisted.length, 1);
        assert.equal(driver.executes.length, 1);
    });

    it('updates only dirty fields for existing entities', async () => {
        const driver = new FakeDriver();
        new BaseDatabase(driver, [User]);
        const user = createEntity(User, { id: 7, name: 'Alice', email: 'a@example.com' });
        markEntityClean(user);
        user.name = 'Bob';

        await user.save();

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE "users" SET "name" = $1 WHERE "id" = $2',
            bindings: ['Bob', 7]
        });
    });

    it('renders combined filter operators', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db
            .query(User)
            .filter({ id: { $gte: 5, $lte: 10 }, email: { $ne: null } })
            .find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE "id" >= $1 AND "id" <= $2 AND "email" IS NOT NULL',
            bindings: [5, 10]
        });
    });

    it('serializes Date bindings as UTC SQL datetime values', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [DatedRecord]);
        const now = new Date(Date.UTC(2026, 6, 1, 7, 7, 10, 336));

        await db
            .query(DatedRecord)
            .filter({ createdAt: now, expiresAt: { $lt: now } })
            .find();
        await db.rawExecuteUnsafe('UPDATE dated_records SET expiresAt = ? WHERE createdAt < ?', [now, now]);

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `createdAt`, `expiresAt` FROM `dated_records` WHERE `createdAt` = ? AND `expiresAt` < ?',
            bindings: ['2026-07-01 07:07:10.336', '2026-07-01 07:07:10.336']
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE dated_records SET expiresAt = ? WHERE createdAt < ?',
            bindings: ['2026-07-01 07:07:10.336', '2026-07-01 07:07:10.336']
        });
    });

    it('hydrates and serializes DateString fields as date-only strings', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [DateStringRecord]);
        driver.rows = [{ id: 1, birthdate: new Date(Date.UTC(1987, 5, 1, 0, 0, 0)) }];

        const loaded = await db.query(DateStringRecord).findOne();
        await db
            .query(DateStringRecord)
            .filter({ birthdate: { $lt: new Date(Date.UTC(1987, 5, 2, 13, 14, 15)) } })
            .find();

        assert.equal(loaded.birthdate, '1987-06-01');
        assert.deepStrictEqual(driver.queries[1], {
            sql: 'SELECT `id`, `birthdate` FROM `date_string_records` WHERE `birthdate` < ?',
            bindings: ['1987-06-02']
        });
    });

    it('serializes and hydrates UUID columns for MySQL binary and Postgres uuid storage', async () => {
        const id = '018f1f93-0f3a-75d1-a73b-f7f67a41dd2b';
        const relatedId = '018f1f93-0f3a-75d1-a73b-f7f67a41dd2c';
        const mysqlDriver = new FakeDriver('mysql');
        const mysqlDb = new BaseDatabase(mysqlDriver, [UuidRecord]);

        await mysqlDb.persist(createEntity(UuidRecord, { id, relatedId, label: 'alpha' }));
        await mysqlDb
            .query(UuidRecord)
            .filter({ id, relatedId: { $in: [relatedId] } })
            .find();

        assert.deepStrictEqual(mysqlDriver.executes[0], {
            sql: 'INSERT INTO `uuid_records` (`id`, `relatedId`, `label`) VALUES (?, ?, ?)',
            bindings: [uuidBuffer(id), uuidBuffer(relatedId), 'alpha']
        });
        assert.deepStrictEqual(mysqlDriver.queries[0], {
            sql: 'SELECT `id`, `relatedId`, `label` FROM `uuid_records` WHERE `id` = ? AND `relatedId` IN (?)',
            bindings: [uuidBuffer(id), uuidBuffer(relatedId)]
        });

        mysqlDriver.rows = [{ id: uuidBuffer(id), relatedId: uuidBuffer(relatedId), label: 'loaded' }];
        const loaded = await mysqlDb.query(UuidRecord).findOne();
        assert.equal(loaded.id, id);
        assert.equal(loaded.relatedId, relatedId);

        mysqlDriver.rows = [{ id: uuidBuffer(id) }];
        const patch = await mysqlDb.query(UuidRecord).filter({ label: 'loaded' }).patchMany({ label: 'patched' });
        assert.deepStrictEqual(patch.primaryKeys, [{ id }]);
        assert.deepStrictEqual(mysqlDriver.executes[1], {
            sql: 'UPDATE `uuid_records` SET `label` = ? WHERE `id` IN (?)',
            bindings: ['patched', uuidBuffer(id)]
        });

        const existing = createEntity(UuidRecord, { id, relatedId, label: 'before' });
        markEntityClean(existing);
        existing.label = 'after';
        await mysqlDb.persist(existing);

        assert.deepStrictEqual(mysqlDriver.executes[2], {
            sql: 'UPDATE `uuid_records` SET `label` = ? WHERE `id` = ?',
            bindings: ['after', uuidBuffer(id)]
        });

        const postgresDriver = new FakeDriver('postgres');
        const postgresDb = new BaseDatabase(postgresDriver, [UuidRecord]);
        await postgresDb.persist(createEntity(UuidRecord, { id, relatedId, label: 'pg' }));

        assert.deepStrictEqual(postgresDriver.executes[0], {
            sql: 'INSERT INTO "uuid_records" ("id", "relatedId", "label") VALUES ($1, $2, $3)',
            bindings: [id, relatedId, 'pg']
        });
    });

    it('keeps UuidString columns as string values for MySQL char storage', async () => {
        const id = '018f1f93-0f3a-75d1-a73b-f7f67a41dd2b';
        const relatedId = '018f1f93-0f3a-75d1-a73b-f7f67a41dd2c';
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [UuidStringRecord]);

        await db.persist(createEntity(UuidStringRecord, { id, relatedId, label: 'alpha' }));
        await db
            .query(UuidStringRecord)
            .filter({ id: { $in: [id] }, relatedId: { $in: [relatedId] } })
            .find();

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `uuid_string_records` (`id`, `relatedId`, `label`) VALUES (?, ?, ?)',
            bindings: [id, relatedId, 'alpha']
        });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `relatedId`, `label` FROM `uuid_string_records` WHERE `id` IN (?) AND `relatedId` IN (?)',
            bindings: [id, relatedId]
        });
    });

    it('serializes and hydrates binary columns without JSON encoding bytes', async () => {
        const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [BinaryRecord]);

        await db.persist(createEntity(BinaryRecord, { id: 1, data, nullableData: null }));
        await db.query(BinaryRecord).filter({ data }).find();

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `binary_records` (`id`, `data`, `nullableData`, `optionalData`) VALUES (?, ?, ?, ?)',
            bindings: [1, Buffer.from(data), null, null]
        });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `data`, `nullableData`, `optionalData` FROM `binary_records` WHERE `data` = ?',
            bindings: [Buffer.from(data)]
        });

        driver.rows = [{ id: 1, data: Buffer.from(data), nullableData: null, optionalData: null }];
        const loaded = await db.query(BinaryRecord).findOne();
        assert.equal(Buffer.isBuffer(loaded.data), false);
        assert.ok(loaded.data instanceof Uint8Array);
        assert.deepStrictEqual(Array.from(loaded.data), Array.from(data));
        assert.equal(loaded.nullableData, null);
        assert.equal(loaded.optionalData, null);
    });

    it('serializes and hydrates bigint columns as bigint entity values', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [BigIntRecord]);

        await db.persist(createEntity(BigIntRecord, { id: 1, count: 9007199254740993n }));
        await db.query(BigIntRecord).filter({ count: 9007199254740993n }).find();

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `bigint_records` (`id`, `count`, `optionalCount`) VALUES (?, ?, ?)',
            bindings: [1, '9007199254740993', null]
        });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `count`, `optionalCount` FROM `bigint_records` WHERE `count` = ?',
            bindings: ['9007199254740993']
        });

        driver.rows = [{ id: 1, count: '9007199254740993', optionalCount: null }];
        const loaded = await db.query(BigIntRecord).findOne();
        assert.equal(loaded.count, 9007199254740993n);
        assert.equal(loaded.optionalCount, null);
    });

    it('renders not-in filter operators', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db
            .query(User)
            .filter({ name: { $nin: ['draft', 'canceled'] } })
            .find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE "name" NOT IN ($1, $2)',
            bindings: ['draft', 'canceled']
        });
    });

    it('renders not-in filter operators with null semantics', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db
            .query(User)
            .filter({ email: { $nin: [null, 'blocked@example.com'] } })
            .find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE "email" IS NOT NULL AND "email" NOT IN ($1)',
            bindings: ['blocked@example.com']
        });
    });

    it('renders undefined filters as SQL IS NULL', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db.query(User).filter({ email: undefined }).find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE "email" IS NULL',
            bindings: []
        });
    });

    it('renders like filter operators', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db
            .query(User)
            .filter({ name: { $like: 'AL%' }, email: { $notLike: '%@example.test' } })
            .find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE "name" LIKE $1 AND "email" NOT LIKE $2',
            bindings: ['AL%', '%@example.test']
        });
    });

    it('renders logical filter groups', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db
            .query(User)
            .filter({
                $and: [{ id: { $gte: 5 } }, { $or: [{ name: 'Alice' }, { email: null }] }]
            })
            .find();

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id", "name", "email" FROM "users" WHERE ("id" >= $1 AND ("name" = $2 OR "email" IS NULL))',
            bindings: [5, 'Alice']
        });
    });

    it('finds projected fields and counts rows', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        driver.rows = [{ name: 'Alice' }, { name: 'Bob' }];
        const names = await db
            .query(User)
            .filter({ email: { $ne: null } })
            .orderBy('name')
            .findField('name');

        driver.rows = [{ count: '2' }];
        const count = await db
            .query(User)
            .filter({ email: { $ne: null } })
            .orderBy('name')
            .limit(1)
            .count();

        assert.deepStrictEqual(names, ['Alice', 'Bob']);
        assert.equal(count, 2);
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "name" FROM "users" WHERE "email" IS NOT NULL ORDER BY "name" ASC',
            bindings: []
        });
        assert.deepStrictEqual(driver.queries[1], {
            sql: 'SELECT COUNT(*) AS "count" FROM "users" WHERE "email" IS NOT NULL',
            bindings: []
        });
    });

    it('coerces reflected boolean columns when hydrating MySQL rows', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [AdminUser]);
        driver.rows = [{ id: 1, isAdmin: 1 }];

        const users = await db.query(AdminUser).find();
        assert.equal(users[0].isAdmin, true);
        assert.equal(isEntityDirty(users[0]), false);

        driver.rows = [{ isAdmin: 0 }];
        const values = await db.query(AdminUser).findField('isAdmin');
        assert.deepStrictEqual(values, [false]);
    });

    it('coerces reflected number columns when hydrating MySQL numeric strings', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [AccountBalance]);
        driver.rows = [{ id: 1, balance: '50.00' }];

        const accounts = await db.query(AccountBalance).find();

        assert.strictEqual(accounts[0].balance, 50);
    });

    it('serializes and hydrates MySQL point columns as coordinates', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [LocationEntity]);

        await createPersistedEntity(LocationEntity, {
            location: { x: 1.25, y: -2.5 },
            nullableLocation: { x: 3.5, y: 4.75 },
            plainCoordinate: { x: -10, y: 20 }
        });

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `locations` (`location`, `nullableLocation`, `plainCoordinate`) VALUES (ST_GeomFromText(?), ST_GeomFromText(?), ST_GeomFromText(?))',
            bindings: ['POINT(1.25 -2.5)', 'POINT(3.5 4.75)', 'POINT(-10 20)']
        });

        driver.rows = [
            {
                id: 10,
                location: createMySQLPointBuffer(1.25, -2.5),
                nullableLocation: createMySQLPointBuffer(3.5, 4.75),
                plainCoordinate: createMySQLPointBuffer(-10, 20)
            }
        ];
        const locations = await db.query(LocationEntity).find();

        assert.deepStrictEqual(locations[0].location, { x: 1.25, y: -2.5 });
        assert.deepStrictEqual(locations[0].nullableLocation, { x: 3.5, y: 4.75 });
        assert.deepStrictEqual(locations[0].plainCoordinate, { x: -10, y: 20 });
    });

    it('patches and deletes many rows through primary-key subqueries', async () => {
        const driver = new FakeDriver();
        driver.rows = [{ id: 7 }, { id: 8 }];
        driver.executeResult = { affectedRows: 2 };
        const db = new BaseDatabase(driver, [User]);

        const patchResult = await db.query(User).filter({ email: null }).orderBy('id').limit(2).patchMany({ name: 'Updated' });

        driver.rows = [{ id: 7 }];
        driver.executeResult = { affectedRows: 1 };
        const deleteResult = await db.query(User).filter({ name: 'Updated' }).deleteMany();

        assert.deepStrictEqual(patchResult, { affectedRows: 2, primaryKeys: [{ id: 7 }, { id: 8 }] });
        assert.deepStrictEqual(deleteResult, { affectedRows: 1, primaryKeys: [{ id: 7 }] });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "id" FROM "users" WHERE "email" IS NULL ORDER BY "id" ASC LIMIT $1',
            bindings: [2]
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE "users" SET "name" = $1 WHERE "id" IN ($2, $3)',
            bindings: ['Updated', 7, 8]
        });
        assert.deepStrictEqual(driver.queries[1], {
            sql: 'SELECT "id" FROM "users" WHERE "name" = $1',
            bindings: ['Updated']
        });
        assert.deepStrictEqual(driver.executes[1], {
            sql: 'DELETE FROM "users" WHERE "id" IN ($1)',
            bindings: [7]
        });
    });

    it('applies the complete patchOne filter directly to MySQL updates', async () => {
        const driver = new FakeDriver('mysql');
        driver.executeResult = { affectedRows: 1 };
        const db = new BaseDatabase(driver, [User]);

        const result = await db.query(User).filter({ id: 7, name: 'pending' }).patchOne({ name: 'committed' });

        assert.equal(result.modified, 1);
        assert.deepStrictEqual(result.primaryKeys, [{ id: 7 }]);
        assert.equal(driver.queries.length, 0);
        assert.equal(driver.executes.length, 1);
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE `users` SET `name` = ? WHERE `id` = ? AND `name` = ?',
            bindings: ['committed', 7, 'pending']
        });
    });

    it('applies patchOne filters directly to PostgreSQL updates', async () => {
        const driver = new FakeDriver();
        driver.executeResult = { affectedRows: 1 };
        const db = new BaseDatabase(driver, [User]);

        const result = await db.query(User).filter({ id: 7, name: 'pending' }).patchOne({ name: 'committed' });

        assert.equal(result.modified, 1);
        assert.deepStrictEqual(result.primaryKeys, [{ id: 7 }]);
        assert.equal(driver.queries.length, 0);
        assert.equal(driver.executes.length, 1);
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE "users" SET "name" = $1 WHERE "id" = $2 AND "name" = $3',
            bindings: ['committed', 7, 'pending']
        });
    });

    it('reports zero modified when patchOne matches no row', async () => {
        const driver = new FakeDriver('mysql');
        driver.executeResult = { affectedRows: 0 };
        const db = new BaseDatabase(driver, [User]);

        const result = await db.query(User).filter({ id: 7, name: 'pending' }).patchOne({ name: 'committed' });

        assert.equal(result.affectedRows, 0);
        assert.equal(result.modified, 0);
        assert.equal(driver.queries.length, 0);
        assert.equal(driver.executes.length, 1);
    });

    it('requires exact primary-key filters for patchOne and deleteOne', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User, CompositeLink]);

        await assert.rejects(
            () => db.query(User).filter({ name: 'pending' }).patchOne({ name: 'committed' }),
            /patchOne requires an exact filter for primary key User\.id/
        );
        await assert.rejects(
            () =>
                db
                    .query(User)
                    .filter({ id: { $in: [7] } })
                    .deleteOne(),
            /deleteOne requires an exact filter for primary key User\.id/
        );
        await assert.rejects(
            () => db.query(CompositeLink).filter({ orgId: 'org-1' }).deleteOne(),
            /deleteOne requires an exact filter for primary key CompositeLink\.userId/
        );

        assert.equal(driver.queries.length, 0);
        assert.equal(driver.executes.length, 0);
    });

    it('deletes one row directly with a complete composite primary-key filter', async () => {
        const driver = new FakeDriver();
        driver.executeResult = { affectedRows: 1 };
        const db = new BaseDatabase(driver, [CompositeLink]);

        const result = await db.query(CompositeLink).filter({ orgId: 'org-1', userId: 'user-1', role: 'viewer' }).deleteOne();

        assert.deepStrictEqual(result, {
            affectedRows: 1,
            primaryKeys: [{ orgId: 'org-1', userId: 'user-1' }]
        });
        assert.equal(driver.queries.length, 0);
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'DELETE FROM "composite_links" WHERE "orgId" = $1 AND "userId" = $2 AND "role" = $3',
            bindings: ['org-1', 'user-1', 'viewer']
        });
    });

    it('skips no-op patches before selecting primary keys', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        const result = await db
            .query(User)
            .filter({ email: null })
            .patchMany({ notAColumn: 99 } as Partial<User>);

        assert.deepStrictEqual(result, { affectedRows: 0, primaryKeys: [] });
        assert.equal(driver.queries.length, 0);
        assert.equal(driver.executes.length, 0);
    });

    it('allows patchMany to update primary-key fields', async () => {
        const driver = new FakeDriver();
        driver.rows = [{ token: 'old-token' }];
        driver.executeResult = { affectedRows: 1 };
        const db = new BaseDatabase(driver, [ApiToken]);

        const result = await db
            .query(ApiToken)
            .filter({ token: 'old-token' })
            .patchMany({ token: 'new-token' } as Partial<ApiToken>);

        assert.deepStrictEqual(result, { affectedRows: 1, primaryKeys: [{ token: 'old-token' }] });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT "token" FROM "api_tokens" WHERE "token" = $1',
            bindings: ['old-token']
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE "api_tokens" SET "token" = $1 WHERE "token" IN ($2)',
            bindings: ['new-token', 'old-token']
        });
    });

    it('renders mysql offset-only primary-key paging with an unbounded limit', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 9 }, { id: 10 }];
        driver.executeResult = { affectedRows: 2 };
        const db = new BaseDatabase(driver, [User]);

        const result = await db.query(User).orderBy('id').offset(5).deleteMany();

        assert.deepStrictEqual(result, { affectedRows: 2, primaryKeys: [{ id: 9 }, { id: 10 }] });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id` FROM `users` ORDER BY `id` ASC LIMIT 18446744073709551615 OFFSET ?',
            bindings: [5]
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'DELETE FROM `users` WHERE `id` IN (?, ?)',
            bindings: [9, 10]
        });
    });

    it('flushes queued session entities before raw reads', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 10, name: 'Queued', email: null }];
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            session.add(createEntity(User, { name: 'Queued', email: null }));
            await session.rawFindUnsafe('SELECT * FROM users WHERE id = ?', [10]);
        });

        assert.equal(driver.executes.length, 1);
        assert.equal(driver.queries.length, 1);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'query', 'commit', 'release']);
    });

    it('does not flush queued session entities before entity query reads', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [];
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            session.add(createEntity(User, { name: 'Queued', email: null }));
            await session.query(User).filter({ name: 'Queued' }).find();
        });

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `name`, `email` FROM `users` WHERE `name` = ?',
            bindings: ['Queued']
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `users` (`name`, `email`) VALUES (?, ?)',
            bindings: ['Queued', null]
        });
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'query', 'execute', 'commit', 'release']);
    });

    it('persists queued entity mutations made after an intermediate flush', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 10, name: 'Queued', email: null }];
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            const user = createEntity(User, { name: 'Queued', email: null });
            session.add(user);
            await session.rawFindUnsafe('SELECT * FROM users WHERE id = ?', [10]);
            user.email = 'after-flush@example.com';
        });

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'INSERT INTO `users` (`name`, `email`) VALUES (?, ?)',
            bindings: ['Queued', null]
        });
        assert.deepStrictEqual(driver.executes[1], {
            sql: 'UPDATE `users` SET `email` = ? WHERE `id` = ?',
            bindings: ['after-flush@example.com', 10]
        });
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'query', 'execute', 'commit', 'release']);
    });

    it('persists mutations to entities loaded through a session query', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 7, name: 'Alice', email: 'a@example.com' }];
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            const user = await session.query(User).filter({ id: 7 }).findOne();
            user.email = 'b@example.com';
        });

        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT `id`, `name`, `email` FROM `users` WHERE `id` = ? LIMIT ?',
            bindings: [7, 1]
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE `users` SET `email` = ? WHERE `id` = ?',
            bindings: ['b@example.com', 7]
        });
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'query', 'execute', 'commit', 'release']);
    });

    it('explicitly manages dirty entities and stops persistence after unmanage', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);
        const managed = createEntity(User, { id: 7, name: 'Managed', email: null });
        const unmanaged = createEntity(User, { id: 8, name: 'Unmanaged', email: null });
        markEntityClean(managed);
        markEntityClean(unmanaged);

        await db.transaction(async session => {
            session.manage(managed, unmanaged);
            managed.email = 'managed@example.com';
            unmanaged.email = 'unmanaged@example.com';
            session.unmanage(unmanaged);
        });

        assert.deepStrictEqual(driver.executes, [
            {
                sql: 'UPDATE `users` SET `email` = ? WHERE `id` = ?',
                bindings: ['managed@example.com', 7]
            }
        ]);
    });

    it('can remove queued persistence without deleting the entity', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            const user = createEntity(User, { name: 'Not persisted', email: null });
            session.add(user);
            session.removeQueued(user);
        });

        assert.equal(driver.executes.length, 0);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'commit', 'release']);
    });

    it('does not manage projected session query entities', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [{ amountTip: 10 }];
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            await session.query(User).select('email').find();
        });

        assert.equal(driver.executes.length, 0);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'query', 'commit', 'release']);
    });

    it('queues session removals synchronously before the next read', async () => {
        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 7, name: 'Alice', email: 'a@example.com' }];
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            const user = await session.query(User).filter({ id: 7 }).findOne();
            session.remove(user);
            await session.rawFindUnsafe('SELECT * FROM users');
        });

        assert.deepStrictEqual(driver.executes[0], {
            sql: 'DELETE FROM `users` WHERE `id` = ?',
            bindings: [7]
        });
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'query', 'execute', 'query', 'commit', 'release']);
    });

    it('cancels a queued insert when the entity is removed before flush', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            const user = createEntity(User, { name: 'Cancelled', email: null });
            session.add(user);
            session.remove(user);
        });

        assert.equal(driver.executes.length, 0);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'commit', 'release']);
    });

    it('awaits unawaited session query deletes before commit', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            void session.query(User).filter({ id: 7 }).deleteOne();
        });

        assert.equal(driver.queries.length, 0);
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'DELETE FROM `users` WHERE `id` = ?',
            bindings: [7]
        });
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'commit', 'release']);
    });

    it('awaits unawaited session query patches before commit', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            void session.query(User).filter({ id: 7 }).patchOne({ email: 'queued@example.com' });
        });

        assert.equal(driver.queries.length, 0);
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE `users` SET `email` = ? WHERE `id` = ?',
            bindings: ['queued@example.com', 7]
        });
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'commit', 'release']);
    });

    it('rolls back rejected unawaited session query mutations', async () => {
        const driver = new FakeDriver('mysql');
        const error = new Error('delete failed');
        driver.executeError = error;
        const db = new BaseDatabase(driver, [User]);

        await assert.rejects(
            db.transaction(async session => {
                void session
                    .query(User)
                    .filter({ id: 7 })
                    .deleteOne()
                    .catch(() => {});
            }),
            error
        );

        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'rollback', 'release']);
    });

    it('runs transaction hooks around queued entities', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);
        const order: string[] = [];

        await db.transaction(async session => {
            session.add(createEntity(User, { name: 'Alice', email: null }));
            session.addPreCommitHook(async () => {
                order.push('pre');
                driver.connections[0].commands.push('pre');
            });
            session.addPostCommitHook(async () => {
                order.push('post');
                driver.connections[0].commands.push('post');
            });
        });

        assert.deepStrictEqual(order, ['pre', 'post']);
        assert.equal(driver.executes.length, 1);
        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'pre', 'commit', 'post', 'release']);
    });

    it('rolls back and releases failed transactions', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await assert.rejects(
            db.transaction(async session => {
                session.add(createEntity(User, { name: 'Alice', email: null }));
                throw new Error('boom');
            }),
            /boom/
        );

        assert.equal(driver.executes.length, 0);
        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'rollback', 'release']);
    });

    it('skips post-commit hooks when a transaction rolls back after flush', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);
        let postCommitRan = false;

        await assert.rejects(
            db.transaction(async session => {
                session.add(createEntity(User, { name: 'Alice', email: null }));
                session.addPreCommitHook(async () => {
                    driver.connections[0].commands.push('pre');
                    throw new Error('pre failed');
                });
                session.addPostCommitHook(async () => {
                    postCommitRan = true;
                });
            }),
            /pre failed/
        );

        assert.equal(postCommitRan, false);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'pre', 'rollback', 'release']);
    });

    it('uses the transaction connection for session raw queries', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            await session.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['A', 1]);
            await db.rawFindUnsafe('SELECT * FROM users WHERE id = ?', [1], session);
        });

        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'query', 'commit', 'release']);
    });

    it('reuses a scoped connection for raw operations', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);

        await db.withConnection(async scopedDb => {
            assert.equal(scopedDb, db);
            await scopedDb.rawFindUnsafe('SELECT * FROM users WHERE id = ?', [1]);
            await scopedDb.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['A', 1]);
            await scopedDb.withConnection(async nestedDb => {
                await nestedDb.rawExecuteUnsafe('DELETE FROM users WHERE id = ?', [1]);
            });
        });

        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(driver.connections[0].commands, ['query', 'execute', 'execute', 'release']);
    });

    it('supports transactional savepoints', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            await session.withSavepoint('sp1', async () => {
                await session.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['A', 1]);
            });
        });

        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'savepoint:sp1', 'execute', 'commit', 'release']);
    });

    it('rolls back failed savepoint work and keeps the outer transaction alive', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            await assert.rejects(
                session.withSavepoint('sp1', async () => {
                    await session.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['A', 1]);
                    throw new Error('savepoint failed');
                }),
                /savepoint failed/
            );
            await session.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['B', 2]);
        });

        assert.deepStrictEqual(driver.connections[0].commands, [
            'begin',
            'savepoint:sp1',
            'execute',
            'rollbackToSavepoint:sp1',
            'execute',
            'commit',
            'release'
        ]);
    });

    it('drops queued entities and hooks added inside rolled-back savepoints', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);
        let preCommitRan = false;

        await db.transaction(async session => {
            await assert.rejects(
                session.withSavepoint('sp1', async () => {
                    session.add(createEntity(User, { name: 'Rolled back', email: null }));
                    session.addPreCommitHook(async () => {
                        preCommitRan = true;
                    });
                    throw new Error('savepoint failed');
                }),
                /savepoint failed/
            );
        });

        assert.equal(preCommitRan, false);
        assert.equal(driver.executes.length, 0);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'savepoint:sp1', 'rollbackToSavepoint:sp1', 'commit', 'release']);
    });

    it('acquires PostgreSQL advisory transaction locks', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            await session.acquireSessionLock(['user', 123]);
        });

        assert.equal(flattenMutexKey(['user', 123]), 'user:123');
        assert.equal(flattenMutexKey([User, 123]), 'User:123');
        assert.equal(driver.executes.length, 1);
        assert.match(driver.executes[0].sql, /^SELECT pg_advisory_xact_lock\(\$1, \$2\)$/);
        assert.equal(driver.executes[0].bindings.length, 2);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'commit', 'release']);
    });

    it('acquires MySQL row locks through the locks table', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User], {
            enableLocksTable: true,
            lockTableName: '_test_locks'
        });

        await db.transaction(async session => {
            await session.acquireSessionLock(['resource', 7n]);
        });

        assert.equal(driver.connections.length, 4);
        assert.deepStrictEqual(
            driver.executes.map(query => query.sql),
            [
                'CREATE TABLE IF NOT EXISTS `_test_locks` (`key` VARCHAR(255) NOT NULL PRIMARY KEY, `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, `lastTouched` DATETIME)',
                'DELETE FROM `_test_locks` WHERE `lastTouched` < NOW() - INTERVAL 1 HOUR',
                'INSERT IGNORE INTO `_test_locks` (`key`) VALUES (?)',
                'UPDATE `_test_locks` SET `lastTouched` = NOW() WHERE `key` = ?'
            ]
        );
        assert.deepStrictEqual(driver.executes[2].bindings, ['resource:7']);
        assert.deepStrictEqual(driver.executes[3].bindings, ['resource:7']);
        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'commit', 'release']);
        assert.deepStrictEqual(driver.connections[1].commands, ['execute', 'release']);
        assert.deepStrictEqual(driver.connections[2].commands, ['execute', 'release']);
        assert.deepStrictEqual(driver.connections[3].commands, ['execute', 'release']);
    });

    it('uses an existing MySQL locks table when lazy creation is not enabled', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.transaction(async session => {
            await session.acquireSessionLock(['resource', 7n]);
        });

        assert.deepStrictEqual(
            driver.executes.map(query => query.sql),
            ['INSERT IGNORE INTO `_locks` (`key`) VALUES (?)', 'UPDATE `_locks` SET `lastTouched` = NOW() WHERE `key` = ?']
        );
        assert.deepStrictEqual(driver.executes[0].bindings, ['resource:7']);
        assert.deepStrictEqual(driver.executes[1].bindings, ['resource:7']);
    });

    it('rejects session locks outside active transactions', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver, [User]);
        const session = new DatabaseSession(db);

        await assert.rejects(session.acquireSessionLock('user:123'), /active transaction/);
    });

    it('renders unsafe raw queries with bindings', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);
        driver.rows = [{ name: 'Alice' }];

        const found = await db.rawFindOneUnsafe<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
        await db.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['A', 1]);

        assert.deepStrictEqual(found, { name: 'Alice' });
        assert.deepStrictEqual(driver.queries[0], {
            sql: 'SELECT name FROM users WHERE id = $1',
            bindings: [1]
        });
        assert.deepStrictEqual(driver.executes[0], {
            sql: 'UPDATE users SET name = $1 WHERE id = $2',
            bindings: ['A', 1]
        });
    });

    it('exposes the session raw query facade', async () => {
        const driver = new FakeDriver();
        driver.rows = [{ id: 7 }];
        const db = new BaseDatabase(driver, [User]);
        const session = new DatabaseSession(db);

        const row = await session.raw(sql`SELECT ${7} AS ${sql.identifier('id')}`).findOne<{ id: number }>();
        await session.raw(sql`DELETE FROM ${sql.identifier('users')} WHERE ${sql.identifier('id')} = ${7}`).execute();

        assert.deepStrictEqual(row, { id: 7 });
        assert.deepStrictEqual(driver.queries[0], { sql: 'SELECT $1 AS "id"', bindings: [7] });
        assert.deepStrictEqual(driver.executes[0], { sql: 'DELETE FROM "users" WHERE "id" = $1', bindings: [7] });
    });

    it('deserializes unsafe raw rows when a receive type is provided', async () => {
        interface TypedRawRow {
            id: number;
            createdAt: Date;
        }

        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 1, createdAt: '2026-07-01T12:34:56.000Z' }];
        const db = new BaseDatabase(driver, [User]);

        const rows = await db.rawFindUnsafe<TypedRawRow>('SELECT id, createdAt FROM users');

        assert.equal(rows[0].id, 1);
        assert.equal(rows[0].createdAt instanceof Date, true);
        assert.equal(rows[0].createdAt.toISOString(), '2026-07-01T12:34:56.000Z');
    });

    it('deserializes unsafe session raw rows when a receive type is provided', async () => {
        interface TypedSessionRawRow {
            id: number;
            createdAt: Date;
        }

        const driver = new FakeDriver('mysql');
        driver.rows = [{ id: 1, createdAt: '2026-07-01T12:34:56.000Z' }];
        const db = new BaseDatabase(driver, [User]);
        const session = new DatabaseSession(db);

        const rows = await session.rawFindUnsafe<TypedSessionRawRow>('SELECT id, createdAt FROM users');

        assert.equal(rows[0].id, 1);
        assert.equal(rows[0].createdAt instanceof Date, true);
        assert.equal(rows[0].createdAt.toISOString(), '2026-07-01T12:34:56.000Z');
    });

    it('emits database query observer start and finish phases', async () => {
        const driver = new FakeDriver();
        const db = new BaseDatabase(driver, [User]);
        const observed: Array<{
            id: string;
            phase: string;
            operation: string;
            sql: string;
            durationMs: number;
        }> = [];
        const unregister = registerDatabaseQueryObserver(entry => {
            observed.push({
                id: entry.id,
                phase: entry.phase,
                operation: entry.operation,
                sql: entry.sql,
                durationMs: entry.durationMs
            });
        });

        try {
            await db.rawFindUnsafe('SELECT name FROM users WHERE id = ?', [1]);
            await db.rawExecuteUnsafe('UPDATE users SET name = ? WHERE id = ?', ['A', 1]);
        } finally {
            unregister();
        }

        assert.deepStrictEqual(
            observed.map(entry => [entry.operation, entry.phase]),
            [
                ['query', 'start'],
                ['query', 'finish'],
                ['execute', 'start'],
                ['execute', 'finish']
            ]
        );
        assert.equal(observed[0].id, observed[1].id);
        assert.equal(observed[2].id, observed[3].id);
        assert.notEqual(observed[0].id, observed[2].id);
        assert.equal(observed[0].durationMs, 0);
        assert.equal(observed[2].durationMs, 0);
        assert.equal(observed[1].sql, 'SELECT name FROM users WHERE id = $1');
    });

    it('runs unbound multi-statement raw queries on one connection', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);
        driver.rows = [{ ok: 1 }];

        const rows = await db.rawFindUnsafe(`
            CREATE TABLE users (id int);
            SELECT 1 AS ok;
        `);

        assert.deepStrictEqual(rows, [{ ok: 1 }]);
        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(
            driver.queries.map(query => query.sql),
            ['CREATE TABLE users (id int)', 'SELECT 1 AS ok']
        );
        assert.deepStrictEqual(driver.connections[0].commands, ['query', 'query', 'release']);
    });

    it('runs unbound multi-statement raw executes and aggregates results', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);
        driver.executeResult = { affectedRows: 2, rowCount: 2 };

        const result = await db.rawExecuteUnsafe(`
            UPDATE users SET name = 'A';
            UPDATE users SET name = 'B';
        `);

        assert.deepStrictEqual(result, { affectedRows: 4, rowCount: 4 });
        assert.equal(driver.connections.length, 1);
        assert.deepStrictEqual(
            driver.executes.map(query => query.sql),
            ["UPDATE users SET name = 'A'", "UPDATE users SET name = 'B'"]
        );
        assert.deepStrictEqual(driver.connections[0].commands, ['execute', 'execute', 'release']);
    });

    it('runs bound multi-statement MySQL raw executes with per-statement bindings', async () => {
        const driver = new FakeDriver('mysql');
        const db = new BaseDatabase(driver, [User]);

        await db.rawExecuteUnsafe(
            `
                UPDATE users SET name = ? WHERE id = ?;
                UPDATE users SET email = ? WHERE id = ?;
            `,
            ['Alice', 1, 'a@example.com', 2]
        );

        assert.deepStrictEqual(driver.executes, [
            {
                sql: 'UPDATE users SET name = ? WHERE id = ?',
                bindings: ['Alice', 1]
            },
            {
                sql: 'UPDATE users SET email = ? WHERE id = ?',
                bindings: ['a@example.com', 2]
            }
        ]);
    });

    it('runs bound multi-statement PostgreSQL raw queries with renumbered placeholders', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver, [User]);

        await db.rawFind(sql`
            SELECT ${'first'} AS value;
            SELECT ${'second'} AS value, ${'third'} AS other;
        `);

        assert.deepStrictEqual(driver.queries, [
            {
                sql: 'SELECT $1 AS value',
                bindings: ['first']
            },
            {
                sql: 'SELECT $1 AS value, $2 AS other',
                bindings: ['second', 'third']
            }
        ]);
    });

    it('does not split raw SQL at semicolons inside quoted text or comments', async () => {
        const driver = new FakeDriver('postgres');
        const db = new BaseDatabase(driver, [User]);

        await db.rawExecuteUnsafe(`
            INSERT INTO users (name) VALUES ('semi;colon');
            -- this comment has a semicolon;
            UPDATE users SET name = "semi;identifier";
            /* block comment; */
            SELECT $$semi;literal$$;
        `);

        assert.deepStrictEqual(
            driver.executes.map(query => query.sql),
            [
                "INSERT INTO users (name) VALUES ('semi;colon')",
                '-- this comment has a semicolon;\n            UPDATE users SET name = "semi;identifier"',
                '/* block comment; */\n            SELECT $$semi;literal$$'
            ]
        );
    });

    it('normalizes duplicate-key driver errors to UniqueConstraintError', async () => {
        const mysqlError = Object.assign(new Error('Duplicate entry'), {
            code: 'ER_DUP_ENTRY',
            errno: 1062
        });
        const mysqlDriver = new FakeDriver('mysql');
        mysqlDriver.executeError = mysqlError;
        const mysqlDb = new BaseDatabase(mysqlDriver, [User]);

        await assert.rejects(
            () => mysqlDb.rawExecuteUnsafe('INSERT INTO users (id) VALUES (?)', [1]),
            (error: unknown) => {
                assert.ok(error instanceof UniqueConstraintError);
                assert.strictEqual(error.cause, mysqlError);
                return true;
            }
        );

        const postgresError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        const postgresDriver = new FakeDriver('postgres');
        postgresDriver.queryError = postgresError;
        const postgresDb = new BaseDatabase(postgresDriver, [User]);

        await assert.rejects(
            () => postgresDb.rawFind(sql`SELECT ${'duplicate'}`),
            (error: unknown) => {
                assert.ok(error instanceof UniqueConstraintError);
                assert.strictEqual(error.cause, postgresError);
                return true;
            }
        );
    });

    it('normalizes deferred duplicate-key transaction errors to UniqueConstraintError', async () => {
        const commitError = Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505'
        });
        const driver = new FakeDriver('postgres');
        driver.commitError = commitError;
        const db = new BaseDatabase(driver, [User]);

        await assert.rejects(
            () =>
                db.transaction(async session => {
                    await session.rawExecuteUnsafe("INSERT INTO users (name) VALUES ('Avery')");
                }),
            (error: unknown) => {
                assert.ok(error instanceof UniqueConstraintError);
                assert.strictEqual(error.cause, commitError);
                return true;
            }
        );

        assert.deepStrictEqual(driver.connections[0].commands, ['begin', 'execute', 'commit', 'rollback', 'release']);
    });

    it('logs SQL with interpolated bindings for debugging', () => {
        const originalLog = console.log;
        let logged = '';
        console.log = (message?: unknown) => {
            logged = String(message);
        };

        try {
            logSql('UPDATE users SET name = ?, email = ? WHERE id = ?', ["O'Malley", null, 7]);
        } finally {
            console.log = originalLog;
        }

        assert.equal(logged, `UPDATE users SET name = "O'Malley", email = null WHERE id = 7`);
    });

    it('rejects invalid SQL identifiers and placeholder counts', () => {
        assert.throws(() => sql.identifier(), /requires at least one name/);
        assert.throws(() => sql.identifier(''), /Invalid SQL identifier segment/);
        assert.throws(() => sql.identifier('users', 'bad\0column'), /Invalid SQL identifier segment/);
        assert.throws(() => createSqlQuery('SELECT * FROM users WHERE id = ? AND active = ?', [1]), /Expected 2 SQL bindings, received 1/);
    });
});
