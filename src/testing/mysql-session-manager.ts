import { createHash, randomUUID } from 'node:crypto';

import mysql, { type Connection, type PoolOptions } from 'mysql2/promise';

import { Env } from '../env';
import { listenRpc, type RpcPeer } from '../database/drivers/mysql-session-rpc';
import { createLogger, type LogData, type ScopedLogger } from '../services/logger';

export interface MySQLSessionManagerOptions {
    mysql: PoolOptions;
    token: string;
    testRunTs?: string;
    poolSize?: number;
}

interface DatabasePoolState {
    key: string;
    prefix: string;
    keepDatabase: boolean;
    slots: DatabaseSlotState[];
    waiters: SlotWaiter[];
    nextSlotIndex: number;
}

interface DatabaseSlotState {
    key: string;
    slotIndex: number;
    databaseName: string;
    databaseReady: Promise<void>;
    schemaReady?: boolean;
    schemaPreparing?: {
        id: string;
        timeout: NodeJS.Timeout;
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: Error) => void;
    };
    connection?: Connection;
    backendConnectionId?: string;
    lease?: Lease;
    waiters: LeaseWaiter[];
    reservation?: SlotReservation;
    queue: Promise<void>;
    transactionReady: boolean;
    transactionStack: string[];
    nextTransactionId: number;
    baselineSavepointName: string;
}

interface SlotReservation {
    id: string;
}

interface Lease {
    id: string;
    clientId: string;
    owner: RpcPeer;
}

interface LeaseWaiter {
    owner: RpcPeer;
    clientId: string;
    resolve: () => void;
    reject: (error: Error) => void;
}

interface SlotWaiter {
    owner: RpcPeer;
    resolve: (slot: DatabaseSlotState) => void;
    reject: (error: Error) => void;
}

export class MySQLSessionManager {
    private rpcServer?: { port: number; close: () => Promise<void> };
    private readonly databases = new Map<string, DatabasePoolState>();
    private readonly poolSize: number;
    private readonly logger: ScopedLogger = createLogger('MySQLSessionManager');
    private nextFrontendConnectionId = 0;
    private nextBackendConnectionId = 0;

    constructor(private readonly options: MySQLSessionManagerOptions) {
        this.poolSize = normalizePoolSize(options.poolSize);
    }

    get port(): number {
        if (!this.rpcServer) throw new Error('MySQL session manager has not started');
        return this.rpcServer.port;
    }

    async start(): Promise<void> {
        this.rpcServer = await listenRpc(0, (method, params, peer) => this.handle(method, params, peer));
        this.logger.debug('Shared MySQL session manager started', { port: this.rpcServer.port, poolSize: this.poolSize });
    }

    async stop(): Promise<void> {
        this.logger.debug('Shared MySQL session manager stopping', { poolSize: this.poolSize, groups: this.databases.size });
        if (this.rpcServer) await this.rpcServer.close();
        this.rpcServer = undefined;

        const groups = [...this.databases.values()];
        this.databases.clear();
        for (const group of groups) {
            for (const waiter of group.waiters.splice(0)) waiter.reject(new Error('MySQL session manager stopped'));
            for (const slot of group.slots) {
                for (const waiter of slot.waiters.splice(0)) waiter.reject(new Error('MySQL session manager stopped'));
                slot.schemaPreparing?.reject(new Error('MySQL session manager stopped'));
                await slot.queue.catch(() => {});
                await this.closeBackendConnection(slot, 'manager-stop');
            }
        }

        for (const group of groups) {
            if (group.keepDatabase || Env.TEST_KEEP_DB) continue;
            for (const slot of group.slots) {
                await this.dropDatabase(slot.databaseName).catch(() => {});
            }
        }
        this.logger.debug('Shared MySQL session manager stopped');
    }

    private async handle(method: string, params: unknown, peer: RpcPeer): Promise<unknown> {
        const request = assertRequest(params, this.options.token);
        switch (method) {
            case 'ensureDatabase':
                return this.ensureDatabase(readString(request, 'key'), readString(request, 'prefix'), readBoolean(request, 'keepDatabase'), peer);
            case 'releaseDatabase':
                return this.releaseDatabase(readString(request, 'key'), readOptionalString(request, 'leaseId'));
            case 'prepareSchema':
                return this.prepareSchema(readString(request, 'key'), readOptionalString(request, 'leaseId'));
            case 'completeSchema':
                return this.completeSchema(
                    readString(request, 'key'),
                    readOptionalString(request, 'leaseId'),
                    readOptionalString(request, 'preparationId'),
                    readBoolean(request, 'ok'),
                    readOptionalString(request, 'error')
                );
            case 'acquire':
                return this.acquire(readString(request, 'key'), readOptionalString(request, 'leaseId'), readString(request, 'clientId'), peer);
            case 'release':
                return this.release(peer);
            case 'query':
                return this.run(peer, 'query', readString(request, 'sql'), readValues(request));
            case 'execute':
                return this.run(peer, 'execute', readString(request, 'sql'), readValues(request));
            default:
                throw new Error(`Unknown MySQL session manager method: ${method}`);
        }
    }

    private async ensureDatabase(
        key: string,
        prefix: string,
        keepDatabase: boolean,
        owner: RpcPeer
    ): Promise<{ databaseName: string; leaseId: string }> {
        const group = this.ensureGroup(key, prefix, keepDatabase);
        const slot = await this.reserveSlot(group, owner);
        this.debugSlot('Shared MySQL database lease reserved', slot);
        try {
            await slot.databaseReady;
        } catch (error) {
            this.logger.error('Shared MySQL database lease reservation failed', error, this.slotLogData(slot));
            await this.destroySlot(group, slot, true);
            throw error;
        }
        this.debugSlot('Shared MySQL database lease ready', slot);
        return { databaseName: slot.databaseName, leaseId: slot.reservation!.id };
    }

    private async releaseDatabase(key: string, leaseId: string | undefined): Promise<{ released: boolean }> {
        const group = this.databases.get(key);
        if (!group) return { released: false };
        const slot = this.findSlotByLeaseId(group, leaseId);
        if (!slot) return { released: false };

        const databaseLeaseId = slot.reservation?.id;
        this.debugSlot('Shared MySQL database lease releasing', slot, { reason: 'release-database', leaseId: databaseLeaseId });
        for (const waiter of slot.waiters.splice(0)) waiter.reject(new Error('MySQL session database lease released'));
        try {
            if (slot.connection) await this.enqueueSlot(slot, () => this.resetConnectionAfterLease(slot));
        } finally {
            for (const waiter of slot.waiters.splice(0)) waiter.reject(new Error('MySQL session database lease released'));
            slot.lease = undefined;
            slot.reservation = undefined;
            this.wakeSlotWaiter(group);
        }
        this.debugSlot('Shared MySQL database lease released', slot, { reason: 'release-database', leaseId: databaseLeaseId });
        return { released: true };
    }

    private ensureGroup(key: string, prefix: string, keepDatabase: boolean): DatabasePoolState {
        let group = this.databases.get(key);
        if (!group) {
            group = {
                key,
                prefix,
                keepDatabase,
                slots: [],
                waiters: [],
                nextSlotIndex: 0
            };
            this.databases.set(key, group);
            this.logger.debug('Shared MySQL database group created', this.groupLogData(group));
        } else {
            group.keepDatabase = group.keepDatabase || keepDatabase;
        }
        return group;
    }

    private async reserveSlot(group: DatabasePoolState, owner: RpcPeer): Promise<DatabaseSlotState> {
        const slot = this.reserveAvailableSlot(group);
        if (slot) {
            this.debugSlot('Shared MySQL database slot reserved', slot, this.groupLogData(group));
            return slot;
        }

        this.logger.debug('Shared MySQL database slot waiting', this.groupLogData(group));
        return new Promise<DatabaseSlotState>((resolve, reject) => {
            const waiter: SlotWaiter = {
                owner,
                resolve,
                reject
            };
            group.waiters.push(waiter);
            owner.once('close', () => {
                const index = group.waiters.indexOf(waiter);
                if (index >= 0) group.waiters.splice(index, 1);
                this.logger.debug('Shared MySQL database slot wait cancelled', this.groupLogData(group));
                reject(new Error('Client disconnected before acquiring a MySQL session database slot'));
            });
        });
    }

    private reserveAvailableSlot(group: DatabasePoolState): DatabaseSlotState | undefined {
        const existing = group.slots.find(slot => !slot.reservation);
        const slot = existing ?? (group.slots.length < this.poolSize ? this.createSlot(group) : undefined);
        if (!slot) return undefined;
        slot.reservation = { id: randomUUID() };
        return slot;
    }

    private wakeSlotWaiter(group: DatabasePoolState): void {
        while (group.waiters.length) {
            const slot = this.reserveAvailableSlot(group);
            if (!slot) return;
            const waiter = group.waiters.shift()!;
            this.debugSlot('Shared MySQL database slot assigned to waiter', slot, this.groupLogData(group));
            waiter.resolve(slot);
        }
    }

    private createSlot(group: DatabasePoolState): DatabaseSlotState {
        const slotIndex = group.nextSlotIndex++;
        const databaseName = this.createDatabaseName(group.key, group.prefix, slotIndex);
        const slot: DatabaseSlotState = {
            key: group.key,
            slotIndex,
            databaseName,
            databaseReady: this.createDatabase(databaseName),
            waiters: [],
            queue: Promise.resolve(),
            transactionReady: false,
            transactionStack: [],
            nextTransactionId: 0,
            baselineSavepointName: `tsf_session_baseline_${slotIndex + 1}`
        };
        group.slots.push(slot);
        this.logSlot('Shared MySQL database slot created', slot, this.groupLogData(group));
        return slot;
    }

    private async prepareSchema(key: string, leaseId: string | undefined): Promise<{ run: boolean; preparationId?: string }> {
        const slot = await this.requireReadySlot(key, leaseId);
        if (slot.schemaReady) {
            this.debugSlot('Shared MySQL schema already prepared', slot);
            return { run: false };
        }
        if (slot.schemaPreparing) {
            this.debugSlot('Shared MySQL schema preparation waiting', slot, { preparationId: slot.schemaPreparing.id });
            await slot.schemaPreparing.promise;
            return { run: false };
        }

        const id = randomUUID();
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((promiseResolve, promiseReject) => {
            resolve = promiseResolve;
            reject = promiseReject;
        });
        promise.catch(() => {});
        const timeout = setTimeout(() => {
            if (slot.schemaPreparing?.id === id) this.failSchemaPreparation(slot, new Error('Timed out preparing shared MySQL schema'));
        }, 180_000);
        slot.schemaPreparing = { id, timeout, promise, resolve, reject };
        this.logSlot('Shared MySQL schema preparation started', slot, { preparationId: id });
        return { run: true, preparationId: id };
    }

    private async completeSchema(
        key: string,
        leaseId: string | undefined,
        preparationId: string | undefined,
        ok: boolean,
        error: string | undefined
    ): Promise<{ completed: boolean }> {
        const slot = await this.requireReadySlot(key, leaseId);
        const preparing = slot.schemaPreparing;
        if (!preparing) return { completed: false };
        if (preparationId !== preparing.id) throw new Error('Schema preparation id does not match the active preparation');

        slot.schemaPreparing = undefined;
        clearTimeout(preparing.timeout);
        if (ok) {
            this.logSlot('Shared MySQL schema preparation completing', slot, { preparationId });
            try {
                slot.schemaReady = true;
                await this.enqueueSlot(slot, async () => {
                    const connection = await this.ensureConnection(slot);
                    await this.restartPersistentTransaction(slot, connection);
                });
                preparing.resolve();
                this.logSlot('Shared MySQL schema preparation completed', slot, { preparationId });
            } catch (startError) {
                slot.schemaReady = false;
                const normalizedError = startError instanceof Error ? startError : new Error(String(startError));
                this.logger.error('Shared MySQL schema preparation completion failed', normalizedError, this.slotLogData(slot, { preparationId }));
                preparing.reject(normalizedError);
                throw normalizedError;
            }
        } else {
            this.logger.error(
                'Shared MySQL schema preparation failed',
                new Error(error || 'Schema preparation failed'),
                this.slotLogData(slot, { preparationId })
            );
            preparing.reject(new Error(error || 'Schema preparation failed'));
            const group = this.databases.get(key);
            if (group) await this.destroySlot(group, slot, true);
        }
        return { completed: true };
    }

    private async acquire(key: string, leaseId: string | undefined, clientId: string, owner: RpcPeer): Promise<{ databaseName: string }> {
        const slot = await this.requireReadySlot(key, leaseId);
        while (slot.lease) {
            this.debugSlot('Shared MySQL frontend connection waiting', slot, {
                clientId,
                activeFrontendConnectionId: slot.lease.id,
                activeClientId: slot.lease.clientId,
                frontendWaiters: slot.waiters.length
            });
            await new Promise<void>((resolve, reject) => {
                const waiter: LeaseWaiter = { owner, clientId, resolve, reject };
                slot.waiters.push(waiter);
                owner.once('close', () => {
                    const index = slot.waiters.indexOf(waiter);
                    if (index >= 0) slot.waiters.splice(index, 1);
                    this.debugSlot('Shared MySQL frontend connection wait cancelled', slot, { clientId });
                    reject(new Error('Client disconnected before acquiring the MySQL session lease'));
                });
            });
        }

        const frontendConnectionId = this.createConnectionId('frontend', ++this.nextFrontendConnectionId);
        slot.lease = { id: frontendConnectionId, clientId, owner };
        this.debugSlot('Shared MySQL frontend connection acquired', slot, { frontendConnectionId, clientId });
        owner.once('close', () => {
            if (slot.lease?.owner === owner) {
                this.debugSlot('Shared MySQL frontend connection disconnected', slot, { frontendConnectionId, clientId });
                void this.release(owner).catch(error =>
                    this.logger.error(
                        'Shared MySQL frontend disconnect cleanup failed',
                        error,
                        this.slotLogData(slot, { frontendConnectionId, clientId })
                    )
                );
            }
        });

        try {
            await this.enqueueSlot(slot, async () => {
                const connection = await this.ensureConnection(slot);
                if (slot.schemaReady) await this.ensurePersistentTransaction(slot, connection);
                else await rollbackConnection(connection);
            });
        } catch (error) {
            this.logger.error('Shared MySQL frontend connection acquire failed', error, this.slotLogData(slot, { frontendConnectionId, clientId }));
            if (slot.lease?.owner === owner) {
                slot.lease = undefined;
                const next = slot.waiters.shift();
                if (next) next.resolve();
            }
            throw error;
        }
        return { databaseName: slot.databaseName };
    }

    private async release(owner: RpcPeer): Promise<{ released: boolean }> {
        const slot = this.findSlotByOwner(owner);
        if (!slot) return { released: false };
        const frontendConnectionId = slot.lease?.id;
        const clientId = slot.lease?.clientId;

        this.debugSlot('Shared MySQL frontend connection releasing', slot, { frontendConnectionId, clientId });
        try {
            await this.enqueueSlot(slot, () => this.resetConnectionAfterLease(slot));
        } finally {
            if (slot.lease?.owner === owner) slot.lease = undefined;
            const next = slot.waiters.shift();
            if (next) {
                this.debugSlot('Shared MySQL frontend connection waiter resumed', slot, { clientId: next.clientId });
                next.resolve();
            }
        }
        this.debugSlot('Shared MySQL frontend connection released', slot, { frontendConnectionId, clientId });
        return { released: true };
    }

    private async run(owner: RpcPeer, operation: 'query' | 'execute', sql: string, values: unknown[]): Promise<unknown> {
        const slot = this.findSlotByOwner(owner);
        if (!slot) throw new Error('Client does not hold the MySQL session lease');
        return this.enqueueSlot(slot, async () => {
            if (slot.lease?.owner !== owner) throw new Error('Client does not hold the MySQL session lease');
            const connection = await this.ensureConnection(slot);
            const runtimeDdl = readRuntimeDdlSignal(sql);
            if (runtimeDdl && !slot.schemaPreparing) {
                if (isInternalLocksTableCreate(runtimeDdl.statement)) return this.runIsolatedSlotStatement(slot, operation, sql, values);
                this.throwRuntimeDdl(slot, runtimeDdl);
            }
            if (slot.schemaReady) {
                await this.ensurePersistentTransaction(slot, connection);
                const transactionCommand = readTransactionCommand(sql);
                if (transactionCommand) return this.runManagedTransactionCommand(slot, connection, transactionCommand);
                this.logManagedSessionSqlSignal(slot, sql);
            }
            const [rows] = operation === 'query' ? await connection.query(sql, values as never[]) : await connection.execute(sql, values as never[]);
            return normalizeMySQLResult(rows);
        });
    }

    private async runIsolatedSlotStatement(
        slot: DatabaseSlotState,
        operation: 'query' | 'execute',
        sql: string,
        values: unknown[]
    ): Promise<unknown> {
        const connection = await mysql.createConnection({ ...this.options.mysql, database: slot.databaseName });
        try {
            const [rows] = operation === 'query' ? await connection.query(sql, values as never[]) : await connection.execute(sql, values as never[]);
            return normalizeMySQLResult(rows);
        } finally {
            await connection.end();
        }
    }

    private async requireReadySlot(key: string, leaseId: string | undefined): Promise<DatabaseSlotState> {
        const group = this.databases.get(key);
        if (!group) throw new Error(`Unknown shared MySQL database key: ${key}`);
        const slot = this.findSlotByLeaseId(group, leaseId);
        if (!slot) throw new Error(`Unknown shared MySQL database lease: ${leaseId ?? '(default)'}`);
        await slot.databaseReady;
        return slot;
    }

    private findSlotByLeaseId(group: DatabasePoolState, leaseId: string | undefined): DatabaseSlotState | undefined {
        if (leaseId) return group.slots.find(slot => slot.reservation?.id === leaseId);
        return group.slots.length === 1 ? group.slots[0] : undefined;
    }

    private findSlotByOwner(owner: RpcPeer): DatabaseSlotState | undefined {
        for (const group of this.databases.values()) {
            const slot = group.slots.find(candidate => candidate.lease?.owner === owner);
            if (slot) return slot;
        }
    }

    private async ensureConnection(slot: DatabaseSlotState): Promise<Connection> {
        if (!slot.connection) {
            const backendConnectionId = this.createConnectionId('backend', ++this.nextBackendConnectionId);
            slot.backendConnectionId = backendConnectionId;
            this.debugSlot('Shared MySQL backend connection opening', slot);
            try {
                slot.connection = await mysql.createConnection({
                    ...this.options.mysql,
                    database: slot.databaseName,
                    decimalNumbers: true
                });
                this.logSlot('Shared MySQL backend connection opened', slot);
            } catch (error) {
                this.logger.error('Shared MySQL backend connection open failed', error, this.slotLogData(slot));
                slot.backendConnectionId = undefined;
                throw error;
            }
        }
        return slot.connection;
    }

    private async enqueueSlot<T>(slot: DatabaseSlotState, worker: () => Promise<T>): Promise<T> {
        const run = slot.queue.catch(() => {}).then(worker);
        slot.queue = run.then(
            () => {},
            () => {}
        );
        return run;
    }

    private async ensurePersistentTransaction(slot: DatabaseSlotState, connection: Connection): Promise<void> {
        if (slot.transactionReady) return;
        await this.restartPersistentTransaction(slot, connection);
    }

    private async restartPersistentTransaction(slot: DatabaseSlotState, connection: Connection): Promise<void> {
        slot.transactionReady = false;
        this.debugSlot('Shared MySQL backend transaction restarting', slot);
        await rollbackConnection(connection);
        await connection.query('START TRANSACTION');
        slot.transactionStack = [];
        slot.nextTransactionId = 0;
        await connection.query(`SAVEPOINT ${quoteIdentifier(slot.baselineSavepointName)}`);
        slot.transactionReady = true;
        this.logSlot('Shared MySQL backend transaction ready', slot, {
            baselineSavepoint: slot.baselineSavepointName
        });
    }

    private async resetConnectionAfterLease(slot: DatabaseSlotState): Promise<void> {
        const connection = slot.connection;
        if (!connection) return;
        if (!slot.schemaReady) {
            this.debugSlot('Shared MySQL backend connection resetting before schema readiness', slot);
            await rollbackConnection(connection);
            slot.transactionReady = false;
            slot.transactionStack = [];
            return;
        }

        await this.ensurePersistentTransaction(slot, connection);
        try {
            await connection.query(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(slot.baselineSavepointName)}`);
            slot.transactionStack = [];
            await connection.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
            this.debugSlot('Shared MySQL backend transaction reset to baseline', slot, {
                baselineSavepoint: slot.baselineSavepointName
            });
        } catch (error) {
            this.logger.warning(
                'Shared MySQL backend transaction baseline reset failed; restarting',
                error,
                this.slotLogData(slot, {
                    baselineSavepoint: slot.baselineSavepointName
                })
            );
            await this.restartPersistentTransaction(slot, connection);
        }
    }

    private async runManagedTransactionCommand(slot: DatabaseSlotState, connection: Connection, command: TransactionCommand): Promise<unknown> {
        this.traceManagedSessionSql(slot, command.toUpperCase(), command.toUpperCase());
        if (command === 'begin') {
            const name = `tsf_session_tx_${++slot.nextTransactionId}`;
            slot.transactionStack.push(name);
            await connection.query(`SAVEPOINT ${quoteIdentifier(name)}`);
            this.debugSlot('Shared MySQL frontend transaction began', slot, { savepoint: name });
            return emptyMySQLResult();
        }

        if (command === 'commit') {
            const name = slot.transactionStack.pop();
            if (name) await connection.query(`RELEASE SAVEPOINT ${quoteIdentifier(name)}`);
            this.debugSlot('Shared MySQL frontend transaction committed', slot, { savepoint: name });
            return emptyMySQLResult();
        }

        const name = slot.transactionStack.pop();
        if (name) await connection.query(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(name)}`);
        else await this.resetConnectionAfterLease(slot);
        this.debugSlot('Shared MySQL frontend transaction rolled back', slot, { savepoint: name });
        return emptyMySQLResult();
    }

    private async destroySlot(group: DatabasePoolState, slot: DatabaseSlotState, dropDatabase: boolean): Promise<void> {
        const databaseLeaseId = slot.reservation?.id;
        this.debugSlot('Shared MySQL database slot destroying', slot, { dropDatabase, leaseId: databaseLeaseId });
        const index = group.slots.indexOf(slot);
        if (index >= 0) group.slots.splice(index, 1);
        for (const waiter of slot.waiters.splice(0)) waiter.reject(new Error('MySQL session database slot removed'));
        slot.schemaPreparing?.reject(new Error('MySQL session database slot removed'));
        await slot.queue.catch(() => {});
        await this.closeBackendConnection(slot, 'slot-destroy');
        slot.lease = undefined;
        slot.reservation = undefined;
        slot.transactionReady = false;
        slot.transactionStack = [];
        if (dropDatabase && !group.keepDatabase && !Env.TEST_KEEP_DB) await this.dropDatabase(slot.databaseName).catch(() => {});
        this.wakeSlotWaiter(group);
        this.logSlot('Shared MySQL database slot destroyed', slot, { dropDatabase, leaseId: databaseLeaseId });
    }

    private async createDatabase(databaseName: string): Promise<void> {
        this.logger.debug('Shared MySQL database creating', { databaseName });
        const connection = await this.adminConnection();
        try {
            await connection.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
        } finally {
            await connection.end();
        }
        this.logger.debug('Shared MySQL database created', { databaseName });
    }

    private async dropDatabase(databaseName: string): Promise<void> {
        this.logger.debug('Shared MySQL database dropping', { databaseName });
        const connection = await this.adminConnection();
        try {
            await connection.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
        } finally {
            await connection.end();
        }
        this.logger.debug('Shared MySQL database dropped', { databaseName });
    }

    private adminConnection(): Promise<Connection> {
        return mysql.createConnection({ ...this.options.mysql, database: 'mysql' });
    }

    private createDatabaseName(key: string, prefix: string, slotIndex: number): string {
        const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_') || 'test';
        const hash = hashKey(key);
        const ts = this.options.testRunTs ?? Env.TEST_RUN_TS ?? String(Math.floor(Date.now() / 1000));
        return `${safePrefix}_${ts}_${process.pid}_${hash}_${slotIndex + 1}`;
    }

    private failSchemaPreparation(slot: DatabaseSlotState, error: Error): void {
        const preparing = slot.schemaPreparing;
        if (!preparing) return;
        this.logger.error('Shared MySQL schema preparation timed out', error, this.slotLogData(slot, { preparationId: preparing.id }));
        slot.schemaPreparing = undefined;
        clearTimeout(preparing.timeout);
        preparing.reject(error);
        const group = this.databases.get(slot.key);
        if (!group) return;
        const index = group.slots.indexOf(slot);
        if (index >= 0) group.slots.splice(index, 1);
        slot.reservation = undefined;
        slot.transactionReady = false;
        slot.transactionStack = [];
        if (!group.keepDatabase && !Env.TEST_KEEP_DB) void this.dropDatabase(slot.databaseName).catch(() => {});
        this.wakeSlotWaiter(group);
    }

    private async closeBackendConnection(slot: DatabaseSlotState, reason: string): Promise<void> {
        const connection = slot.connection;
        if (!connection) return;
        this.logSlot('Shared MySQL backend connection closing', slot, { reason });
        await rollbackConnection(connection);
        await connection
            .end()
            .catch(error => this.logger.error('Shared MySQL backend connection close failed', error, this.slotLogData(slot, { reason })));
        slot.connection = undefined;
        slot.transactionReady = false;
        slot.transactionStack = [];
        this.logSlot('Shared MySQL backend connection closed', slot, { reason });
        slot.backendConnectionId = undefined;
    }

    private logSlot(message: string, slot: DatabaseSlotState, data?: LogData): void {
        this.logger.debug(message, this.slotLogData(slot, data));
    }

    private debugSlot(message: string, slot: DatabaseSlotState, data?: LogData): void {
        this.logger.debug(message, this.slotLogData(slot, data));
    }

    private slotLogData(slot: DatabaseSlotState, data?: LogData): LogData {
        return {
            keyHash: hashKey(slot.key),
            slotIndex: slot.slotIndex,
            databaseName: slot.databaseName,
            leaseId: slot.reservation?.id,
            backendConnectionId: slot.backendConnectionId,
            frontendConnectionId: slot.lease?.id,
            clientId: slot.lease?.clientId,
            frontendWaiters: slot.waiters.length,
            transactionDepth: slot.transactionStack.length,
            transactionReady: slot.transactionReady,
            schemaReady: !!slot.schemaReady,
            ...data
        };
    }

    private groupLogData(group: DatabasePoolState, data?: LogData): LogData {
        return {
            keyHash: hashKey(group.key),
            prefix: group.prefix,
            keepDatabase: group.keepDatabase,
            poolSize: this.poolSize,
            slots: group.slots.length,
            slotWaiters: group.waiters.length,
            ...data
        };
    }

    private createConnectionId(kind: 'frontend' | 'backend', value: number): string {
        return `${kind}-${process.pid}-${value}`;
    }

    private logManagedSessionSqlSignal(slot: DatabaseSlotState, sql: string): void {
        const signal = readManagedSessionSqlSignal(sql);
        if (!signal) return;

        if (signal.invalidatesSavepoints) {
            this.logger.warning(
                'Shared MySQL managed session executing SQL that can invalidate savepoints',
                this.slotLogData(slot, {
                    sqlCommand: signal.command,
                    sqlStatement: signal.statement
                })
            );
            return;
        }

        this.traceManagedSessionSql(slot, signal.command, signal.statement);
    }

    private throwRuntimeDdl(slot: DatabaseSlotState, signal: RuntimeDdlSignal): never {
        throw new Error(
            `Shared MySQL session manager blocked runtime DDL (${signal.command}) on database ${slot.databaseName}. ` +
                `DDL is only allowed during schema preparation and migrations. Statement: ${signal.statement}`
        );
    }

    private traceManagedSessionSql(slot: DatabaseSlotState, sqlCommand: string, sqlStatement: string): void {
        if (!isEnabledFlag(Env.TSF_TEST_MYSQL_SESSION_TRACE_SQL)) return;
        this.logSlot('Shared MySQL managed session SQL', slot, {
            sqlCommand,
            sqlStatement
        });
    }
}

type TransactionCommand = 'begin' | 'commit' | 'rollback';

function normalizePoolSize(poolSize: number | undefined): number {
    if (!Number.isFinite(poolSize) || !poolSize) return 1;
    return Math.max(1, Math.floor(poolSize));
}

function assertRequest(params: unknown, token: string): Record<string, unknown> {
    if (!params || typeof params !== 'object') throw new Error('MySQL session manager request params are required');
    const request = params as Record<string, unknown>;
    if (request.token !== token) throw new Error('Invalid MySQL session manager token');
    return request;
}

function readString(request: Record<string, unknown>, key: string): string {
    const value = request[key];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Expected ${key} to be a non-empty string`);
    return value;
}

function readOptionalString(request: Record<string, unknown>, key: string): string | undefined {
    const value = request[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
    return value;
}

function readBoolean(request: Record<string, unknown>, key: string): boolean {
    const value = request[key];
    if (typeof value !== 'boolean') throw new Error(`Expected ${key} to be a boolean`);
    return value;
}

function readValues(request: Record<string, unknown>): unknown[] {
    const value = request.values;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Expected values to be an array');
    return value;
}

function normalizeMySQLResult(rows: unknown): unknown {
    if (Array.isArray(rows)) return rows;
    if (!rows || typeof rows !== 'object') return rows;
    const result = rows as Record<string, unknown>;
    return {
        affectedRows: result.affectedRows,
        insertId: result.insertId,
        warningStatus: result.warningStatus,
        changedRows: result.changedRows
    };
}

function emptyMySQLResult(): unknown {
    return {
        affectedRows: 0,
        insertId: 0,
        warningStatus: 0,
        changedRows: 0
    };
}

function readTransactionCommand(sql: string): TransactionCommand | undefined {
    const normalized = sql
        .trim()
        .replace(/;+\s*$/, '')
        .replace(/\s+/g, ' ')
        .toUpperCase();
    if (normalized === 'START TRANSACTION' || normalized === 'BEGIN' || normalized === 'BEGIN WORK') return 'begin';
    if (normalized === 'COMMIT' || normalized === 'COMMIT WORK') return 'commit';
    if (normalized === 'ROLLBACK' || normalized === 'ROLLBACK WORK') return 'rollback';
}

interface ManagedSessionSqlSignal {
    command: string;
    statement: string;
    invalidatesSavepoints: boolean;
}

interface RuntimeDdlSignal {
    command: string;
    statement: string;
}

function readRuntimeDdlSignal(sql: string): RuntimeDdlSignal | undefined {
    for (const statement of summarizeSqlStatements(sql)) {
        const command = readDdlCommand(statement.toUpperCase());
        if (command) return { command, statement };
    }
}

function readManagedSessionSqlSignal(sql: string): ManagedSessionSqlSignal | undefined {
    const statement = summarizeSqlStatement(sql);
    if (!statement) return undefined;
    const upper = statement.toUpperCase();

    const invalidatingCommand = readSavepointInvalidatingCommand(upper);
    if (invalidatingCommand) return { command: invalidatingCommand, statement, invalidatesSavepoints: true };

    const traceCommand = readTraceableTransactionCommand(upper);
    if (traceCommand) return { command: traceCommand, statement, invalidatesSavepoints: false };
}

function readSavepointInvalidatingCommand(upperStatement: string): string | undefined {
    const ddlCommand = readDdlCommand(upperStatement);
    if (ddlCommand) return ddlCommand;
    if (/^LOCK\s+TABLES\b/.test(upperStatement)) return 'LOCK TABLES';
    if (/^UNLOCK\s+TABLES\b/.test(upperStatement)) return 'UNLOCK TABLES';
    if (/^SET\s+(?:SESSION\s+|@@SESSION\.)?AUTOCOMMIT\s*=\s*(?:1|ON|TRUE)\b/.test(upperStatement)) return 'SET AUTOCOMMIT';
    if (/^START\s+TRANSACTION\b/.test(upperStatement)) return 'START TRANSACTION';
    if (/^BEGIN\b/.test(upperStatement)) return 'BEGIN';
    if (/^COMMIT\b/.test(upperStatement)) return 'COMMIT';
    if (/^ROLLBACK\b(?!\s+TO\s+SAVEPOINT\b)/.test(upperStatement)) return 'ROLLBACK';
}

function readDdlCommand(upperStatement: string): string | undefined {
    if (/^CREATE\b/.test(upperStatement)) return 'CREATE';
    if (/^ALTER\b/.test(upperStatement)) return 'ALTER';
    if (/^DROP\b/.test(upperStatement)) return 'DROP';
    if (/^TRUNCATE\b/.test(upperStatement)) return 'TRUNCATE';
    if (/^RENAME\b/.test(upperStatement)) return 'RENAME';
}

function isInternalLocksTableCreate(statement: string): boolean {
    return /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?[A-Za-z0-9_]+`?\s*\(\s*`?key`?\s+VARCHAR\(255\)\s+NOT\s+NULL\s+PRIMARY\s+KEY,\s*`?createdAt`?\s+DATETIME\s+NOT\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP,\s*`?lastTouched`?\s+DATETIME\s*\)$/i.test(
        statement
    );
}

function readTraceableTransactionCommand(upperStatement: string): string | undefined {
    if (/^SAVEPOINT\b/.test(upperStatement)) return 'SAVEPOINT';
    if (/^ROLLBACK\s+TO\s+SAVEPOINT\b/.test(upperStatement)) return 'ROLLBACK TO SAVEPOINT';
    if (/^RELEASE\s+SAVEPOINT\b/.test(upperStatement)) return 'RELEASE SAVEPOINT';
}

function summarizeSqlStatement(sql: string): string {
    return stripLeadingSqlComments(sql)
        .trim()
        .replace(/;+\s*$/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 500);
}

function summarizeSqlStatements(sql: string): string[] {
    return splitSqlStatementsForInspection(sql)
        .map(summarizeSqlStatement)
        .filter(statement => statement.length > 0);
}

function splitSqlStatementsForInspection(sql: string): string[] {
    const statements: string[] = [];
    let statementStart = 0;
    let quote: "'" | '"' | '`' | undefined;
    let inLineComment = false;
    let inBlockComment = false;
    let i = 0;

    while (i < sql.length) {
        const char = sql[i];
        const next = sql[i + 1];

        if (inLineComment) {
            if (char === '\n' || char === '\r') inLineComment = false;
            i++;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i += 2;
            } else {
                i++;
            }
            continue;
        }

        if (quote) {
            if ((quote === "'" || quote === '"') && char === '\\') {
                i += 2;
                continue;
            }

            if (char === quote) {
                if (next === quote) {
                    i += 2;
                    continue;
                }
                quote = undefined;
            }
            i++;
            continue;
        }

        if (char === '-' && next === '-') {
            inLineComment = true;
            i += 2;
            continue;
        }

        if (char === '#') {
            inLineComment = true;
            i++;
            continue;
        }

        if (char === '/' && next === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            i++;
            continue;
        }

        if (char === ';') {
            const statement = sql.slice(statementStart, i).trim();
            if (statement) statements.push(statement);
            statementStart = i + 1;
        }

        i++;
    }

    const statement = sql.slice(statementStart).trim();
    if (statement) statements.push(statement);
    return statements;
}

function stripLeadingSqlComments(sql: string): string {
    let statement = sql;
    while (true) {
        const trimmed = statement.trimStart();
        if (trimmed.startsWith('--')) {
            const nextLine = trimmed.indexOf('\n');
            if (nextLine < 0) return '';
            statement = trimmed.slice(nextLine + 1);
            continue;
        }
        if (trimmed.startsWith('#')) {
            const nextLine = trimmed.indexOf('\n');
            if (nextLine < 0) return '';
            statement = trimmed.slice(nextLine + 1);
            continue;
        }
        if (trimmed.startsWith('/*')) {
            const end = trimmed.indexOf('*/');
            if (end < 0) return trimmed;
            statement = trimmed.slice(end + 2);
            continue;
        }
        return trimmed;
    }
}

function isEnabledFlag(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function hashKey(key: string): string {
    return createHash('sha1').update(key).digest('hex').slice(0, 10);
}

async function rollbackConnection(connection: Connection): Promise<void> {
    await connection.query('ROLLBACK').catch(() => {});
    await connection.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
}

function quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
}
