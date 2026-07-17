import { BaseAppConfig } from '../../app';
import { ScopedLogger } from '../logger';
import { WorkerQueueRegistry } from './queue';
import { WorkerRunnerService, type WorkerExecutionResult } from './runner';
import { BaseJob, InputDataSymbol, type IJobOptions, type JobClass, type QueuedWorkerJob } from './types';

export * from './entity';
export * from './queue';
export * from './recorder';
export * from './runner';
export * from './types';
export * from './observer';

export class WorkerService {
    constructor(
        private readonly config: BaseAppConfig,
        private readonly queueRegistry: WorkerQueueRegistry,
        private readonly runner: WorkerRunnerService,
        private readonly logger: ScopedLogger
    ) {}

    async queueJob<I extends object, O, T extends BaseJob<I, O>>(
        jobClass: JobClass<I, O> & { prototype: T },
        data: T[typeof InputDataSymbol],
        options: IJobOptions = {}
    ): Promise<QueuedWorkerJob<I> | WorkerExecutionResult<I, O> | undefined> {
        if (this.config.APP_ENV === 'test' && options.runInTest !== true) {
            this.logger.warn('Not queueing job in test environment', {
                jobName: jobClass.name,
                data,
                options
            });
            return undefined;
        }

        if (options.runImmediately) {
            const job = this.queueRegistry.add(jobClass, data, options);
            return this.runner.executeQueuedJob(job, options);
        }

        try {
            const job = await this.queueRegistry.enqueue(jobClass, data, options);
            this.logger.info('Queued job', { job: { name: job.name, id: job.id, queue: job.queue } });

            if (!this.queueRegistry.usesBullMq()) this.runner.schedule(job);
            return job;
        } catch (error) {
            this.logger.error('Failed to queue job', error, {
                job: {
                    name: jobClass.name,
                    queue: this.queueRegistry.getQueueName(jobClass, options)
                }
            });
            throw error;
        }
    }

    async runJob<I extends object, O, T extends BaseJob<I, O>>(
        jobClass: JobClass<I, O> & { prototype: T },
        data: T[typeof InputDataSymbol],
        options: IJobOptions = {}
    ): Promise<WorkerExecutionResult<I, O>> {
        const job = this.queueRegistry.add(jobClass, data, options);
        return this.runner.executeQueuedJob(job, options);
    }
}
