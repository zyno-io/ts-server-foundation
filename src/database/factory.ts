import type { PoolOptions } from 'mysql2/promise';
import type { PoolConfig } from 'pg';

import { BaseAppConfig } from '../app/config';
import { ConfigLoader } from '../app/config-loader';
import { getAppConfig } from '../app/resolver';
import { Env } from '../env';
import type { ClassType } from '../types';
import { BaseDatabase, type BaseDatabaseOptions } from './database';
import type { DatabaseDriver } from './driver';
import {
    MySQLDriver,
    createSharedMySQLSessionPool,
    getSharedMySQLSessionManagerConfig,
    type MySQLPoolLike,
    PostgresDriver,
    type PgPoolLike
} from './drivers';
import type { EntityClass } from './metadata';

export type DatabaseDialect = 'mysql' | 'postgres';

export interface SharedDatabaseConfig extends BaseDatabaseOptions {
    enableLocksTable?: boolean;
}

export interface MySQLDatabaseConfig extends PoolOptions, BaseDatabaseOptions {
    enableLocksTable?: boolean;
}

export interface PostgresDatabaseConfig extends PoolConfig, BaseDatabaseOptions {
    enableLocksTable?: boolean;
}

export function createDatabaseClass(
    driverFactory: () => DatabaseDriver,
    entities: EntityClass[] = [],
    options: BaseDatabaseOptions = {}
): ClassType<BaseDatabase> {
    return class extends BaseDatabase {
        constructor() {
            super(driverFactory(), entities, options);
        }
    };
}

export function createMySQLDatabase(config: MySQLDatabaseConfig | MySQLPoolLike = {}, entities: EntityClass[] = []): ClassType<BaseDatabase> {
    return class extends BaseDatabase {
        constructor() {
            const { driverInput, options } = resolveMySQLInput(config);
            super(new MySQLDriver(driverInput), entities, options);
        }
    };
}

export function createPostgresDatabase(config: PostgresDatabaseConfig | PgPoolLike = {}, entities: EntityClass[] = []): ClassType<BaseDatabase> {
    return class extends BaseDatabase {
        constructor() {
            const { driverInput, options } = resolvePostgresInput(config);
            super(new PostgresDriver(driverInput), entities, options);
        }
    };
}

export function createDatabase(config?: SharedDatabaseConfig, entities?: EntityClass[]): ClassType<BaseDatabase>;
export function createDatabase(dialect: 'mysql', config?: MySQLDatabaseConfig | MySQLPoolLike, entities?: EntityClass[]): ClassType<BaseDatabase>;
export function createDatabase(dialect: 'postgres', config?: PostgresDatabaseConfig | PgPoolLike, entities?: EntityClass[]): ClassType<BaseDatabase>;
export function createDatabase(
    dialectOrConfig?: DatabaseDialect | SharedDatabaseConfig | MySQLDatabaseConfig | PostgresDatabaseConfig | MySQLPoolLike | PgPoolLike,
    configOrEntities?: MySQLDatabaseConfig | PostgresDatabaseConfig | MySQLPoolLike | PgPoolLike | EntityClass[],
    entities: EntityClass[] = []
): ClassType<BaseDatabase> {
    if (typeof dialectOrConfig === 'string') {
        const dialect = dialectOrConfig;
        const config = configOrEntities && !Array.isArray(configOrEntities) ? configOrEntities : {};
        const entityList = Array.isArray(configOrEntities) ? configOrEntities : entities;
        return dialect === 'mysql'
            ? createMySQLDatabase(config as MySQLDatabaseConfig | MySQLPoolLike, entityList)
            : createPostgresDatabase(config as PostgresDatabaseConfig | PgPoolLike, entityList);
    }

    const dialect = Env.DB_ADAPTER as DatabaseDialect | undefined;
    const config = dialectOrConfig ?? {};
    const entityList = Array.isArray(configOrEntities) ? configOrEntities : entities;

    if (dialect === 'mysql') return createMySQLDatabase(config as SharedDatabaseConfig, entityList);
    if (dialect === 'postgres') return createPostgresDatabase(config as SharedDatabaseConfig, entityList);
    throw new Error("DB_ADAPTER must be set to 'mysql' or 'postgres' when createDatabase() is called without an explicit dialect");
}

function resolveMySQLInput(config: MySQLDatabaseConfig | MySQLPoolLike): {
    driverInput: PoolOptions | MySQLPoolLike;
    options: BaseDatabaseOptions;
} {
    if (isMySQLPoolLike(config)) return { driverInput: config, options: {} };

    const appConfig = readAppConfig();
    const production = appConfig.APP_ENV === 'production';
    const { enableLocksTable, lockTableName, ...poolConfig } = config;
    const testDatabaseName = appConfig.APP_ENV === 'test' ? Env.TSF_TEST_DATABASE_NAME : undefined;
    const sharedSessionKey = appConfig.APP_ENV === 'test' ? Env.TSF_TEST_MYSQL_SESSION_KEY : undefined;
    const sharedSessionLeaseId = appConfig.APP_ENV === 'test' ? Env.TSF_TEST_MYSQL_SESSION_LEASE_ID : undefined;

    if (sharedSessionKey && getSharedMySQLSessionManagerConfig()) {
        return {
            driverInput: createSharedMySQLSessionPool(sharedSessionKey, undefined, sharedSessionLeaseId),
            options: { enableLocksTable, lockTableName }
        };
    }

    return {
        driverInput: {
            host: appConfig.MYSQL_HOST,
            port: appConfig.MYSQL_PORT,
            user: appConfig.MYSQL_USER,
            password: appConfig.MYSQL_PASSWORD_SECRET,
            database: appConfig.MYSQL_DATABASE,
            waitForConnections: true,
            connectionLimit: appConfig.MYSQL_CONNECTION_LIMIT ?? (production ? 10 : 5),
            idleTimeout: (appConfig.MYSQL_IDLE_TIMEOUT_SECONDS ?? (production ? 60 : 5)) * 1000,
            ...poolConfig,
            ...(testDatabaseName ? { database: testDatabaseName } : {})
        },
        options: { enableLocksTable, lockTableName }
    };
}

function resolvePostgresInput(config: PostgresDatabaseConfig | PgPoolLike): {
    driverInput: PoolConfig | PgPoolLike;
    options: BaseDatabaseOptions;
} {
    if (isPgPoolLike(config)) return { driverInput: config, options: {} };

    const appConfig = readAppConfig();
    const production = appConfig.APP_ENV === 'production';
    const { enableLocksTable: _enableLocksTable, lockTableName, ...poolConfig } = config;
    const ssl = appConfig.PG_SSL ? { rejectUnauthorized: appConfig.PG_SSL_REJECT_UNAUTHORIZED ?? true } : undefined;
    const testDatabaseName = appConfig.APP_ENV === 'test' ? Env.TSF_TEST_DATABASE_NAME : undefined;

    return {
        driverInput: {
            host: appConfig.PG_HOST,
            port: appConfig.PG_PORT,
            user: appConfig.PG_USER,
            password: appConfig.PG_PASSWORD_SECRET,
            database: appConfig.PG_DATABASE,
            ssl,
            max: appConfig.PG_CONNECTION_LIMIT ?? (production ? 10 : 5),
            idleTimeoutMillis: (appConfig.PG_IDLE_TIMEOUT_SECONDS ?? (production ? 60 : 5)) * 1000,
            ...poolConfig,
            ...(testDatabaseName ? { database: testDatabaseName } : {})
        },
        options: { lockTableName }
    };
}

function readAppConfig(): BaseAppConfig {
    try {
        return getAppConfig();
    } catch {
        return new ConfigLoader(BaseAppConfig).load();
    }
}

function isMySQLPoolLike(value: MySQLDatabaseConfig | MySQLPoolLike): value is MySQLPoolLike {
    return typeof (value as MySQLPoolLike).getConnection === 'function' && typeof (value as MySQLPoolLike).end === 'function';
}

function isPgPoolLike(value: PostgresDatabaseConfig | PgPoolLike): value is PgPoolLike {
    return typeof (value as PgPoolLike).connect === 'function' && typeof (value as PgPoolLike).end === 'function';
}
