#!/usr/bin/env node

import { randomBytes } from 'node:crypto';

import { Env } from '../env';
import { setLogSink, type LogData, type LogEntry } from '../services/logger';
import { MySQLSessionManager } from './mysql-session-manager';

async function main(): Promise<void> {
    installStderrLogSink();
    const token = randomBytes(24).toString('hex');
    const manager = new MySQLSessionManager({
        token,
        testRunTs: Env.TEST_RUN_TS,
        poolSize: Env.TSF_TEST_MYSQL_SESSION_POOL_SIZE ? Number(Env.TSF_TEST_MYSQL_SESSION_POOL_SIZE) : undefined,
        mysql: {
            host: Env.MYSQL_HOST,
            port: Env.MYSQL_PORT ? Number(Env.MYSQL_PORT) : 3306,
            user: Env.MYSQL_USER,
            password: Env.MYSQL_PASSWORD_SECRET
        }
    });

    await manager.start();
    console.log(`TSF_MYSQL_SESSION_MANAGER_READY ${JSON.stringify({ port: manager.port, token })}`);

    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        await manager.stop();
        process.exit(0);
    };

    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

function installStderrLogSink(): void {
    setLogSink(entry => {
        console.error(formatLogEntry(entry));
    });
}

function formatLogEntry(entry: LogEntry): string {
    const error = formatLogError(entry.error);
    return `tsf-test mysql: [${entry.message}]${formatLogData(entry.data)}${error}`;
}

function formatLogData(data: LogData | undefined): string {
    if (!data || Object.keys(data).length === 0) return '';
    const entries = Object.entries(data)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatLogValue(value)}`);
    return entries.length ? ` ${entries.join(' ')}` : '';
}

function formatLogError(error: unknown): string {
    if (!error) return '';
    if (error instanceof Error) return ` error=${formatLogValue(error.stack ?? error.message)}`;
    return ` error=${formatLogValue(error)}`;
}

function formatLogValue(value: unknown): string {
    if (typeof value === 'string') {
        return /^[A-Za-z0-9_.:/@+-]+$/.test(value) ? value : JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);

    try {
        const formatted = JSON.stringify(value);
        return formatted === undefined ? String(value) : formatted;
    } catch {
        return String(value);
    }
}
