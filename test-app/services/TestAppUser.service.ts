import { createPersistedEntity, ScopedLogger, sql, WorkerExecutionResult, WorkerService } from '../../src';
import { TestAppDatabase } from '../database/TestAppDatabase';
import { TestAppUser } from '../entities/TestAppUser.entity';
import { TestAppFeatureService } from '../modules/TestAppFeatureModule';
import { TestAppWorkerJob } from './TestAppWorker.job';

export interface CreatedUserSummary {
    user: {
        id: number;
        name: string;
        role: string | null;
    };
    count: number;
    names: string[];
    rawTag: string;
    rawUserName: string;
    initialRole: string | null;
    mutationAffectedRows: number;
    workerResult: string;
    recordedJob: {
        name: string;
        status: string;
        result: unknown;
    };
    hooks: string[];
    loggerScope: string;
    featureName: string;
}

export class TestAppUserService {
    constructor(
        private readonly db: TestAppDatabase,
        private readonly feature: TestAppFeatureService,
        private readonly worker: WorkerService,
        private readonly logger: ScopedLogger
    ) {}

    get featureName(): string {
        return this.feature.name;
    }

    get loggerScope(): string {
        return this.logger.scope;
    }

    async createUser(name: string, role: string): Promise<CreatedUserSummary> {
        const hooks: string[] = [];
        let initialRole: string | null = null;

        const created = await this.db.transaction(async session => {
            await session.acquireSessionLock(['test-app-user', name]);
            session.addPreCommitHook(async () => {
                hooks.push('pre');
            });
            session.addPostCommitHook(async () => {
                hooks.push('post');
            });

            const user = await createPersistedEntity(TestAppUser, { name, role }, session);
            const rawRows = await session.rawFindUnsafe<{ tag: string }>('SELECT ? AS tag', ['bound-ok']);

            await session.withSavepoint('after-create', async () => {
                const found = await session.query(TestAppUser).filter({ id: user.id }).findOne();
                if (found.name !== name) throw new Error(`Expected savepoint lookup to find ${name}`);
                initialRole = found.role;
            });

            user.name = `${name}-saved`;
            await user.save(session);
            const mutation = await session.query(TestAppUser).filter({ id: user.id }).patchOne({ role: 'member' });

            return {
                id: user.id,
                rawTag: rawRows[0]?.tag ?? '',
                mutationAffectedRows: mutation.affectedRows
            };
        });

        const user = await TestAppUser.query().filter({ id: created.id }).findOne();
        const names = await TestAppUser.query()
            .filter({ role: { $ne: null } })
            .orderBy('name')
            .findField('name');
        const count = await this.db.query(TestAppUser).count();
        const raw = await this.db.rawFind<{ name: string }>(
            sql`SELECT ${sql.identifier('name')} FROM ${sql.identifier('test_app_users')} WHERE ${sql.identifier('id')} = ${created.id}`
        );
        const workerExecution = (await this.worker.queueJob(
            TestAppWorkerJob,
            { name: user.name },
            { runInTest: true, runImmediately: true, recordToDatabase: true }
        )) as WorkerExecutionResult<{ name: string }, { output: string }>;
        const jobRows = await this.db.rawFindUnsafe<{ name: string; status: string; result: unknown }>(
            'SELECT * FROM _jobs ORDER BY createdAt DESC LIMIT 1'
        );

        return {
            user: {
                id: user.id,
                name: user.name,
                role: user.role
            },
            count,
            names,
            rawTag: created.rawTag,
            rawUserName: raw[0]?.name ?? '',
            initialRole,
            mutationAffectedRows: created.mutationAffectedRows,
            workerResult: workerExecution.result.output,
            recordedJob: {
                name: jobRows[0]?.name ?? '',
                status: jobRows[0]?.status ?? '',
                result: jobRows[0]?.result
            },
            hooks,
            loggerScope: this.logger.scope,
            featureName: this.feature.name
        };
    }

    async getUser(id: number): Promise<{ id: number; name: string; role: string | null }> {
        const user = await TestAppUser.query().filter({ id }).findOne();
        return {
            id: user.id,
            name: user.name,
            role: user.role
        };
    }
}
