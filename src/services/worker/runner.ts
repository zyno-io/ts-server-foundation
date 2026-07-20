import type { App } from '../../app';
import { createAvailabilityMonitor, withContextData, type AvailabilityMonitor } from '../../helpers';
import { ScopedLogger } from '../logger';
import { WorkerQueueRegistry, type BullMqCronJobSchedule, type BullMqWorkerJobData } from './queue';
import { WorkerRecorderService } from './recorder';
import { BaseJob, getRegisteredWorkerJobs, type IJobOptions, type JobClass, type QueuedWorkerJob } from './types';
import { notifyWorkerObservers } from './observer';
import { Worker as BullWorker, type Job as BullJob } from 'bullmq';

const BULLMQ_REDIS_WARNING_AFTER_MS = 2_000;

export interface WorkerExecutionResult<I = unknown, O = unknown> {
    job: QueuedWorkerJob<I>;
    result: O;
}

export class WorkerRunnerService {
    private running = false;
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly executing = new Set<string>();
    private readonly bullWorkers = new Map<string, BullWorker<BullMqWorkerJobData>>();
    private readonly bullWorkerRedisLifecycleCleanup = new Set<() => void>();
    private bullWorkerRedisMonitor?: AvailabilityMonitor;

    constructor(
        private readonly app: App,
        private readonly queueRegistry: WorkerQueueRegistry,
        private readonly recorder: WorkerRecorderService,
        private readonly logger: ScopedLogger
    ) {}

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        const registeredJobs = this.getRegisteredJobs();
        for (const jobClass of registeredJobs) {
            this.logger.info('Registering job', {
                job: {
                    name: jobClass.name,
                    queue: this.queueRegistry.getQueueName(jobClass),
                    schedule: jobClass.CRON_SCHEDULE
                }
            });
        }

        if (this.queueRegistry.usesBullMq()) {
            await this.startBullMqWorkers();
            await this.scheduleBullMqCronJobs();
            this.logger.info('Worker started', {
                backend: 'bullmq',
                queues: this.getRegisteredQueueNames()
            });
            return;
        }

        this.scheduleCronJobs();
        this.logger.info('Worker started', {
            backend: 'memory',
            queues: this.getRegisteredQueueNames()
        });
        await this.drainReadyJobs();
    }

    async shutdown(): Promise<void> {
        const wasStarted = this.running || this.timers.size > 0 || this.bullWorkers.size > 0 || this.executing.size > 0;
        if (!wasStarted) return;

        this.running = false;
        this.logger.info('Worker stopping', {
            queues: this.getRegisteredQueueNames(),
            runningJobIds: [...this.executing]
        });
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const cleanup of this.bullWorkerRedisLifecycleCleanup) cleanup();
        this.bullWorkerRedisLifecycleCleanup.clear();
        this.bullWorkerRedisMonitor?.stop();
        this.bullWorkerRedisMonitor = undefined;
        if (this.executing.size) {
            this.logger.warn('Waiting for jobs to finish', { jobIds: [...this.executing] });
        }
        let workerStopFailed = false;
        await Promise.all(
            [...this.bullWorkers.entries()].map(async ([queue, worker]) => {
                try {
                    await worker.close();
                } catch (error) {
                    workerStopFailed = true;
                    this.logger.error('Failed to stop worker', error, { queue });
                }
            })
        );
        this.bullWorkers.clear();
        while (this.executing.size) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!workerStopFailed) this.logger.info('Worker stopped');
    }

    async removeStaleBullMqCronJobs(): Promise<void> {
        const desiredSchedules: BullMqCronJobSchedule[] = [];
        for (const jobClass of getRegisteredWorkerJobs()) {
            const pattern = jobClass.CRON_SCHEDULE;
            if (!pattern || !this.isRegisteredJob(jobClass)) continue;
            desiredSchedules.push({
                queue: this.queueRegistry.getQueueName(jobClass),
                name: jobClass.name,
                pattern
            });
        }

        const removed = await this.queueRegistry.removeStaleBullMqJobSchedulers(desiredSchedules);
        for (const scheduler of removed) {
            this.logger.info('Deregistered job during migration', { job: scheduler });
        }
    }

    schedule(job: QueuedWorkerJob): void {
        if (!this.running || job.status !== 'queued') return;
        const delay = Math.max(0, job.shouldExecuteAt.getTime() - Date.now());
        if (delay > 0) {
            if (this.timers.has(job.id)) return;
            const timer = setTimeout(() => {
                this.timers.delete(job.id);
                this.runScheduledJob(job, false).catch(error => {
                    this.logger.error('Queued job failed', error, { job: getJobLogData(job) });
                });
            }, delay);
            this.timers.set(job.id, timer);
            return;
        }

        this.runScheduledJob(job, false).catch(error => {
            this.logger.error('Queued job failed', error, { job: getJobLogData(job) });
        });
    }

    async drainReadyJobs(queue?: string): Promise<void> {
        if (this.queueRegistry.usesBullMq()) return;
        const jobs = queue ? this.queueRegistry.getQueuedJobs(queue) : this.queueRegistry.getAllQueuedJobs();
        for (const job of jobs) {
            if (job.status !== 'queued') continue;
            if (job.shouldExecuteAt.getTime() > Date.now()) {
                this.schedule(job);
                continue;
            }
            await this.runScheduledJob(job);
        }
    }

    async executeQueuedJob<I, O>(job: QueuedWorkerJob<I>, options: IJobOptions = job.options): Promise<WorkerExecutionResult<I, O>> {
        return this.executeJob(job, options, true);
    }

    private async executeJob<I, O>(job: QueuedWorkerJob<I>, options: IJobOptions, logFailure: boolean): Promise<WorkerExecutionResult<I, O>> {
        if (this.executing.has(job.id)) throw new Error(`Job ${job.name}:${job.id} is already executing`);

        this.executing.add(job.id);
        job.attemptsMade++;
        job.data = this.queueRegistry.normalizeJobData(job.data);
        notifyWorkerObservers({ type: 'active', job });
        this.logger.info('Job activated', { job: getJobLogData(job) });
        try {
            const result = await withContextData(
                {
                    job: {
                        queue: job.queue,
                        id: job.id,
                        name: job.name
                    }
                },
                async () => this.resolveJob(job.jobClass).handle(job.data)
            );
            this.queueRegistry.markCompleted(job, result);
            await this.recorder.recordCompleted(job, result, options);
            this.logger.info('Job completed', { job: getJobLogData(job) });
            return { job, result: result as O };
        } catch (error) {
            const failure = formatFailure(error);
            this.queueRegistry.markFailed(job, failure);
            if (logFailure) {
                this.logger.error(`Job failed: ${failure.message}`, error, { job: getJobLogData(job) });
            }
            await this.recorder.recordFailed(job, failure, options);
            throw error;
        } finally {
            this.queueRegistry.remove(job);
            this.executing.delete(job.id);
        }
    }

    private scheduleCronJobs(): void {
        for (const jobClass of getRegisteredWorkerJobs()) {
            const schedule = jobClass.CRON_SCHEDULE;
            if (!schedule || !this.isRegisteredJob(jobClass)) continue;
            const repeatKey = `${jobClass.name}:${schedule}`;
            if (this.hasQueuedRepeatJob(repeatKey)) continue;
            const job = this.queueRegistry.add(jobClass, {}, { delay: getCronDelayMs(schedule), repeatKey });
            this.schedule(job);
        }
    }

    private rescheduleCronJob(job: QueuedWorkerJob): void {
        const repeatKey = job.options.repeatKey;
        const schedule = job.jobClass.CRON_SCHEDULE;
        if (!this.running || !repeatKey || !schedule) return;
        if (this.hasQueuedRepeatJob(repeatKey)) return;
        const next = this.queueRegistry.add(job.jobClass, {}, { delay: getCronDelayMs(schedule), repeatKey });
        this.schedule(next);
    }

    private async runScheduledJob<I, O>(job: QueuedWorkerJob<I>, logFailure = true): Promise<WorkerExecutionResult<I, O>> {
        try {
            return await this.executeJob<I, O>(job, job.options, logFailure);
        } finally {
            this.rescheduleCronJob(job);
        }
    }

    private resolveJob<I, O>(jobClass: JobClass<I, O>): BaseJob<I, O> {
        const registered = this.app.container.listRegisteredProviders().find(item => item.token === jobClass);
        if (!registered) throw new Error(`Job handler is not registered as a provider: ${jobClass.name}`);
        return this.app.container.resolve(jobClass, registered.moduleId);
    }

    private isRegisteredJob(jobClass: JobClass): boolean {
        return this.app.container.listRegisteredProviders().some(item => item.token === jobClass);
    }

    private hasQueuedRepeatJob(repeatKey: string): boolean {
        return this.queueRegistry.getAllQueuedJobs().some(job => job.status === 'queued' && job.options.repeatKey === repeatKey);
    }

    private async startBullMqWorkers(): Promise<void> {
        this.bullWorkerRedisMonitor ??= createAvailabilityMonitor(this.logger, {
            alertAfterMs: this.app.config.REDIS_UNAVAILABLE_ALERT_AFTER_MS,
            name: 'BullMQ worker Redis',
            warningAfterMs: BULLMQ_REDIS_WARNING_AFTER_MS
        });
        for (const queueName of this.getRegisteredQueueNames()) {
            if (this.bullWorkers.has(queueName)) continue;
            const worker = new BullWorker<BullMqWorkerJobData>(
                queueName,
                async job => {
                    await this.executeBullMqJob(job);
                },
                this.queueRegistry.getBullMqOptions()
            );
            worker.on('failed', (job, error) => {
                this.logger.error(`Job failed: ${error.message}`, error, {
                    job: {
                        queue: queueName,
                        id: job?.id,
                        name: job?.name,
                        attempt: job?.attemptsMade
                    }
                });
            });
            worker.on('stalled', jobId => {
                this.logger.warn('Job stalled', { job: { queue: queueName, id: jobId } });
            });
            worker.on('error', error => {
                const timer = setTimeout(() => {
                    if (!this.running) return;
                    if (isBullWorkerRedisReady(worker)) {
                        this.logger.error('BullMQ worker error', error, { queue: queueName });
                    } else {
                        this.bullWorkerRedisMonitor?.unavailable(error);
                    }
                }, 0);
                timer.unref?.();
            });
            worker.once('ready', () => {
                this.logger.info('Worker ready', { queue: queueName });
            });
            this.bullWorkers.set(queueName, worker);
            this.bullWorkerRedisLifecycleCleanup.add(
                observeBullWorkerRedisLifecycle(
                    worker,
                    () => this.bullWorkerRedisMonitor?.unavailable(),
                    () => {
                        if ([...this.bullWorkers.values()].every(isBullWorkerRedisReady)) {
                            this.bullWorkerRedisMonitor?.available();
                        }
                    }
                )
            );
        }
    }

    private async scheduleBullMqCronJobs(): Promise<void> {
        for (const jobClass of getRegisteredWorkerJobs()) {
            const schedule = jobClass.CRON_SCHEDULE;
            if (!schedule || !this.isRegisteredJob(jobClass)) continue;
            const repeatKey = `${jobClass.name}:${schedule}`;
            const queue = this.queueRegistry.getBullQueue(this.queueRegistry.getQueueName(jobClass));
            await queue.upsertJobScheduler(
                repeatKey,
                { pattern: schedule },
                {
                    name: jobClass.name,
                    data: {
                        data: {},
                        options: { repeatKey }
                    },
                    opts: {
                        removeOnComplete: 1000,
                        removeOnFail: 1000
                    }
                }
            );
        }
    }

    private async executeBullMqJob<I, O>(job: BullJob<BullMqWorkerJobData<I>>): Promise<WorkerExecutionResult<I, O>> {
        const jobClass = this.resolveJobClassByName<I, O>(job.name);
        const queuedJob = this.queueRegistry.fromBullJob(job, jobClass);
        return this.executeJob<I, O>(queuedJob, queuedJob.options, false);
    }

    private resolveJobClassByName<I, O>(name: string): JobClass<I, O> {
        const jobClass = getRegisteredWorkerJobs().find(candidate => candidate.name === name && this.isRegisteredJob(candidate));
        if (!jobClass) throw new Error(`Job handler is not registered as a provider: ${name}`);
        return jobClass as JobClass<I, O>;
    }

    private getRegisteredQueueNames(): string[] {
        const queues = new Set<string>([this.queueRegistry.getDefaultQueueName()]);
        for (const jobClass of getRegisteredWorkerJobs()) {
            if (this.isRegisteredJob(jobClass)) queues.add(this.queueRegistry.getQueueName(jobClass));
        }
        return [...queues];
    }

    private getRegisteredJobs(): JobClass[] {
        return getRegisteredWorkerJobs().filter(jobClass => this.isRegisteredJob(jobClass));
    }
}

interface BullWorkerRedisClient {
    status?: string;
    on(event: 'ready' | 'reconnecting', listener: () => void): unknown;
    removeListener(event: 'ready' | 'reconnecting', listener: () => void): unknown;
}

function getBullWorkerRedisClients(worker: BullWorker): BullWorkerRedisClient[] {
    // RedisConnection.status remains "ready" while its ioredis client reconnects. Read the actual
    // command and blocking clients so failover lifecycle events and recovery are both observable.
    const internal = worker as unknown as {
        connection?: { _client?: BullWorkerRedisClient };
        blockingConnection?: { _client?: BullWorkerRedisClient };
    };
    return [internal.connection?._client, internal.blockingConnection?._client].filter(
        (client): client is BullWorkerRedisClient => client !== undefined
    );
}

function isBullWorkerRedisReady(worker: BullWorker): boolean {
    const clients = getBullWorkerRedisClients(worker);
    return clients.length === 2 && clients.every(client => client.status === 'ready');
}

function observeBullWorkerRedisLifecycle(worker: BullWorker, onUnavailable: () => void, onReady: () => void): () => void {
    const clients = getBullWorkerRedisClients(worker);
    for (const client of clients) {
        client.on('reconnecting', onUnavailable);
        client.on('ready', onReady);
    }
    return () => {
        for (const client of clients) {
            client.removeListener('reconnecting', onUnavailable);
            client.removeListener('ready', onReady);
        }
    };
}

function formatFailure(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) return { message: error.message, stack: error.stack };
    return { message: String(error) };
}

function getJobLogData(job: QueuedWorkerJob): { queue: string; id: string; name: string; attempt: number } {
    return {
        queue: job.queue,
        id: job.id,
        name: job.name,
        attempt: job.attemptsMade
    };
}

function getCronDelayMs(schedule: string): number {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) throw new Error(`Invalid cron schedule "${schedule}"`);
    const fields = parts.length === 5 ? ['0', ...parts] : parts;
    const cron = {
        seconds: parseCronField(fields[0], 0, 59),
        minutes: parseCronField(fields[1], 0, 59),
        hours: parseCronField(fields[2], 0, 23),
        daysOfMonth: parseCronField(fields[3], 1, 31),
        months: parseCronField(fields[4], 1, 12),
        daysOfWeek: uniqueSorted(parseCronField(fields[5], 0, 7).map(value => (value === 7 ? 0 : value)))
    };
    const now = new Date();
    const next = nextCronDate(cron, now);
    return Math.max(1, next.getTime() - now.getTime());
}

interface ParsedCron {
    seconds: number[];
    minutes: number[];
    hours: number[];
    daysOfMonth: number[];
    months: number[];
    daysOfWeek: number[];
}

function nextCronDate(cron: ParsedCron, now: Date): Date {
    const candidate = new Date(now.getTime() + 1000);
    candidate.setMilliseconds(0);
    const maxMinutes = 366 * 5 * 24 * 60;

    for (let attempt = 0; attempt < maxMinutes; attempt++) {
        if (matchesCronMinute(candidate, cron)) {
            const second = cron.seconds.find(value => value >= candidate.getSeconds());
            if (second !== undefined) {
                const next = new Date(candidate);
                next.setSeconds(second, 0);
                if (next > now) return next;
            }
        }
        candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
    }

    throw new Error('Could not calculate next cron execution within five years');
}

function matchesCronMinute(date: Date, cron: ParsedCron): boolean {
    if (!cron.minutes.includes(date.getMinutes())) return false;
    if (!cron.hours.includes(date.getHours())) return false;
    if (!cron.months.includes(date.getMonth() + 1)) return false;

    const dayOfMonthWildcard = cron.daysOfMonth.length === 31;
    const dayOfWeekWildcard = cron.daysOfWeek.length === 7;
    const dayOfMonthMatches = cron.daysOfMonth.includes(date.getDate());
    const dayOfWeekMatches = cron.daysOfWeek.includes(date.getDay());

    if (dayOfMonthWildcard && dayOfWeekWildcard) return true;
    if (dayOfMonthWildcard) return dayOfWeekMatches;
    if (dayOfWeekWildcard) return dayOfMonthMatches;
    return dayOfMonthMatches || dayOfWeekMatches;
}

function parseCronField(expression: string, min: number, max: number): number[] {
    const values = new Set<number>();
    for (const part of expression.split(',')) {
        addCronPart(values, part.trim(), min, max);
    }
    return [...values].sort((a, b) => a - b);
}

function uniqueSorted(values: number[]): number[] {
    return [...new Set(values)].sort((a, b) => a - b);
}

function addCronPart(values: Set<number>, expression: string, min: number, max: number): void {
    if (!expression) throw new Error('Invalid empty cron field');
    const [rangeExpression, stepExpression] = expression.split('/');
    if (stepExpression !== undefined && !/^\d+$/.test(stepExpression)) throw new Error(`Invalid cron step "${expression}"`);
    const step = stepExpression === undefined ? 1 : Number(stepExpression);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${expression}"`);

    const [start, end] = parseCronRange(rangeExpression, min, max);
    for (let value = start; value <= end; value += step) {
        if (value < min || value > max) throw new Error(`Cron value ${value} is outside ${min}-${max}`);
        values.add(value);
    }
}

function parseCronRange(expression: string, min: number, max: number): [number, number] {
    if (expression === '*') return [min, max];
    const range = expression.match(/^(\d+)-(\d+)$/);
    if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start > end) throw new Error(`Invalid cron range "${expression}"`);
        return [start, end];
    }
    if (/^\d+$/.test(expression)) {
        const value = Number(expression);
        return [value, value];
    }
    throw new Error(`Unsupported cron field "${expression}"`);
}
