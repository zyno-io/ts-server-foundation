import { setTimeout as sleep } from 'node:timers/promises';

import mysql from 'mysql2/promise';
import { Client as PgClient, type ClientConfig } from 'pg';

import type { BaseAppConfig } from '../app';
import type { DatabaseDialect } from '../database';
import { createLogger } from '../services/logger';

export type TestDatabaseReadyProbe = (adapter: DatabaseDialect, config: BaseAppConfig) => Promise<void>;

export interface WaitForTestDatabaseReadyOptions {
    timeoutMs?: number;
    intervalMs?: number;
    probe?: TestDatabaseReadyProbe;
    log?: (message: string) => void;
}

const readiness = new Map<string, Promise<void>>();

export async function waitForTestDatabaseReady(
    adapter: DatabaseDialect,
    config: BaseAppConfig,
    options: WaitForTestDatabaseReadyOptions = {}
): Promise<void> {
    const key = readinessKey(adapter, config);
    let promise = readiness.get(key);
    if (!promise) {
        promise = waitForTestDatabaseReadyUncached(adapter, config, options).catch(error => {
            readiness.delete(key);
            throw error;
        });
        readiness.set(key, promise);
    }
    await promise;
}

async function waitForTestDatabaseReadyUncached(
    adapter: DatabaseDialect,
    config: BaseAppConfig,
    options: WaitForTestDatabaseReadyOptions
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const probe = options.probe ?? probeTestDatabase;
    const log = options.log ?? logDatabaseReadiness;

    log('Waiting for database to be ready...');

    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
        const attemptStartedAt = Date.now();
        try {
            await probe(adapter, config);
            return;
        } catch (error) {
            lastError = error;
        }

        const elapsed = Date.now() - startedAt;
        const remaining = timeoutMs - elapsed;
        if (remaining <= 0) break;

        const nextAttemptDelay = Math.max(0, intervalMs - (Date.now() - attemptStartedAt));
        await sleep(Math.min(nextAttemptDelay, remaining));
    }

    throw new Error(`Timed out waiting for ${adapter} database to be ready after ${Math.ceil(timeoutMs / 1000)} seconds`, {
        cause: lastError
    });
}

function logDatabaseReadiness(message: string): void {
    createLogger('DatabaseReadiness').info(message);
}

async function probeTestDatabase(adapter: DatabaseDialect, config: BaseAppConfig): Promise<void> {
    if (adapter === 'mysql') {
        const connection = await mysql.createConnection({
            host: config.MYSQL_HOST,
            port: config.MYSQL_PORT ?? 3306,
            user: config.MYSQL_USER,
            password: config.MYSQL_PASSWORD_SECRET,
            database: 'mysql',
            connectTimeout: 1_000
        });
        try {
            await connection.query('SELECT 1');
        } finally {
            await connection.end();
        }
        return;
    }

    const client = new PgClient({
        host: config.PG_HOST,
        port: config.PG_PORT ?? 5432,
        user: config.PG_USER,
        password: config.PG_PASSWORD_SECRET,
        database: 'postgres',
        ssl: resolvePostgresSsl(config),
        connectionTimeoutMillis: 1_000
    });
    try {
        await client.connect();
        await client.query('SELECT 1');
    } finally {
        await client.end().catch(() => {});
    }
}

function readinessKey(adapter: DatabaseDialect, config: BaseAppConfig): string {
    return adapter === 'mysql'
        ? ['mysql', config.MYSQL_HOST, config.MYSQL_PORT, config.MYSQL_USER].join(':')
        : ['postgres', config.PG_HOST, config.PG_PORT, config.PG_USER, config.PG_SSL, config.PG_SSL_REJECT_UNAUTHORIZED].join(':');
}

function resolvePostgresSsl(config: BaseAppConfig): ClientConfig['ssl'] {
    if (!config.PG_SSL) return undefined;
    return {
        rejectUnauthorized: config.PG_SSL_REJECT_UNAUTHORIZED ?? true
    };
}
