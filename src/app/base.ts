import { Container, getProviderToken, isStructuredProvider } from '../di';
import { normalizeModule } from '../di';
import { BaseDatabase, loadMigrationsFromDirectory, MigrationRunner } from '../database';
import type { ModuleDefinition, ModuleLike, Provider, Token } from '../di';
import { EventBus, EventToken, getListenerMethodMetadata } from '../events';
import { HealthcheckController, HealthcheckService } from '../health';
import { DevConsoleController, DevConsoleRuntime, shouldEnableDevConsole } from '../devconsole';
import {
    HttpRequest,
    HttpResponse,
    HttpServerRuntime,
    HttpRouter,
    MemoryHttpResponse,
    getControllerMetadata,
    type HttpCorsConfig,
    type HttpRequestLoggingOptions,
    type RouteParameterResolverRegistry,
    type StaticFilesOptions
} from '../http';
import { getPackageName } from '../helpers';
import { createLoggerProviders, ScopedLogger, WorkerQueueRegistry, WorkerRecorderService, WorkerRunnerService, WorkerService } from '../services';
import { MailService } from '../services/mail';
import { sql } from '../database/sql';
import { OpenApiController, dumpOpenApiSchema, shouldDumpOpenApiSchema, shouldExposeOpenApi } from '../openapi';
import { MetricsController } from '../telemetry/otel/metrics.controller';
import { OtelState } from '../telemetry/otel/helpers';
import { isOtelMetricsEndpointEnabled } from '../telemetry/otel/metrics';
import { installSentry } from '../telemetry/sentry';
import { isClass, type ClassType } from '../types';
import { BaseAppConfig } from './config';
import { ConfigLoader } from './config-loader';
import {
    isAutoConstructProvider,
    onAppBootstrap,
    onServerBootstrap,
    onServerMainBootstrapDone,
    onServerShutdown,
    onServerShutdownRequested
} from './lifecycle';
import { parseEntrypointMigrationsDir } from './migrations-entrypoint';
import { getCommandMetadata } from './commands';
import { setCurrentApp } from './current';

export { getCurrentApp, setCurrentApp } from './current';

export interface CreateAppOptions<C extends BaseAppConfig = BaseAppConfig> extends ModuleDefinition<C> {
    config?: ClassType<C>;
    defaultConfig?: Partial<C>;
    db?: ClassType;
    frameworkConfig?: Record<string, unknown>;
    serverConfig?: Record<string, unknown>;
    cors?: HttpCorsConfig<C>;
    staticFiles?: boolean | StaticFilesOptions;
    requestLogging?: HttpRequestLoggingOptions;
    httpResolvers?: RouteParameterResolverRegistry;
    enableHealthcheck?: boolean;
    enableWorker?: boolean;
    enableDkRpc?: boolean;
}

interface RegisteredCommand {
    classType: ClassType;
    moduleId?: number;
}

export type AppCleanup = () => void | Promise<void>;

interface RegisteredAppCleanup {
    cleanup?: AppCleanup;
}

export class App<C extends BaseAppConfig = BaseAppConfig> {
    readonly container: Container;
    readonly events = new EventBus();
    readonly config: C;
    readonly router: HttpRouter;
    readonly http: HttpServerRuntime<C>;
    private readonly listenerClasses: ClassType[];
    private readonly commandClasses: ClassType[];
    private readonly commandModuleIds: Map<ClassType, number>;
    private started = false;
    private starting?: Promise<void>;
    private signalHandlers?: Partial<Record<NodeJS.Signals, () => void>>;
    private forceWorkerRunner = false;
    private readonly devConsole?: DevConsoleRuntime;
    private openApiDumpTimer?: NodeJS.Timeout;
    private readonly registeredCleanups: RegisteredAppCleanup[] = [];
    private cliServiceMode = false;

    constructor(readonly options: CreateAppOptions<C>) {
        const configClass = options.config ?? (BaseAppConfig as ClassType<C>);
        this.config = new ConfigLoader(configClass, options.defaultConfig).load();
        if (this.config.SENTRY_DSN) {
            installSentry({ dsn: this.config.SENTRY_DSN });
        }
        const configProviders: Provider[] = [{ provide: configClass, useValue: this.config }];
        if (configClass !== BaseAppConfig) {
            configProviders.push({ provide: BaseAppConfig, useExisting: configClass });
        }
        const defaultControllers: ClassType[] = [];
        if (options.enableHealthcheck !== false) defaultControllers.push(HealthcheckController);
        if (shouldEnableDevConsole(this.config)) defaultControllers.push(DevConsoleController);
        if (shouldExposeOpenApi(this.config)) defaultControllers.push(OpenApiController);
        if (isOtelMetricsEndpointEnabled()) defaultControllers.push(MetricsController);
        const rootControllers = uniqueClasses([...(options.controllers ?? []), ...defaultControllers]);
        assertHttpControllerClasses(rootControllers);
        const rootCommands = uniqueClasses([...(options.commands ?? [])]);
        const imports = addFrameworkProvidersToImports(options.imports ?? []);
        const controllers = uniqueClasses([...rootControllers, ...collectImportedControllers(imports)]);
        this.listenerClasses = uniqueClasses([...(options.listeners ?? []), ...collectImportedListeners(imports)]);
        this.commandClasses = uniqueClasses([...rootCommands, ...collectImportedCommands(imports)]);
        assertCommandClasses(this.commandClasses);
        const appProviders = uniqueProviders([
            { provide: App, useValue: this },
            ...configProviders,
            ...createLoggerProviders(),
            MailService,
            ...(options.enableHealthcheck === false ? [] : [HealthcheckService]),
            ...(options.db ? [options.db, { provide: BaseDatabase, useExisting: options.db }] : []),
            ...(options.enableWorker
                ? [
                      WorkerQueueRegistry,
                      WorkerRecorderService,
                      {
                          provide: WorkerRunnerService,
                          useFactory: (app: App, queueRegistry: WorkerQueueRegistry, recorder: WorkerRecorderService, logger: ScopedLogger) =>
                              new WorkerRunnerService(app, queueRegistry, recorder, logger),
                          deps: [App, WorkerQueueRegistry, WorkerRecorderService, ScopedLogger]
                      },
                      WorkerService
                  ]
                : []),
            ...(options.providers ?? [])
        ]);
        const controllerProviders: Provider[] = rootControllers.map(controller => createControllerProvider(controller, this));
        const commandProviders: Provider[] = rootCommands.map(command => createCommandProvider(command));
        this.container = new Container({
            ...options,
            imports,
            providers: [...appProviders, ...controllerProviders, ...commandProviders]
        });
        const rootLogger = this.container.get(ScopedLogger);
        this.router = new HttpRouter(this.container, this.events, options.httpResolvers);
        this.http = new HttpServerRuntime({
            config: this.config,
            router: this.router,
            logger: rootLogger,
            frameworkConfig: options.frameworkConfig,
            serverConfig: options.serverConfig,
            cors: options.cors,
            staticFiles: options.staticFiles,
            requestLogging: options.requestLogging,
            packageName: getPackageName() ?? 'app',
            devConsoleEnabled: shouldEnableDevConsole(this.config),
            listenHooks: () => {
                const startedBeforeListen = this.started;
                return {
                    start: () => this.start(),
                    afterListen: async server => {
                        this.devConsole?.start(server);
                        this.installSignalHandlers();
                        await this.events.dispatch(onServerBootstrap, undefined);
                        await this.events.dispatch(onServerMainBootstrapDone, undefined);
                    },
                    onListenError: async () => {
                        if (!startedBeforeListen && this.started) await this.stop();
                    }
                };
            }
        });
        if (shouldEnableDevConsole(this.config)) this.devConsole = new DevConsoleRuntime(this, rootLogger);
        if (options.db && options.enableHealthcheck !== false) {
            this.registerDatabaseHealthcheck(options.db);
        }
        const controllerModuleIds = this.getControllerModuleIds(controllers);
        this.commandModuleIds = this.getCommandModuleIds(this.commandClasses);
        for (const controller of controllers) this.router.registerController(controller, controllerModuleIds.get(controller));
        this.registerDecoratedListeners();
    }

    get<T>(token: Token<T>): T {
        return this.container.get(token);
    }

    getInjectorContext(): Container {
        return this.container;
    }

    on<TEvent>(token: EventToken<TEvent>, handler: (event: TEvent) => void | Promise<void>, order = 0): () => void {
        return this.events.listen(token, handler, order);
    }

    /**
     * Register cleanup for a resource acquired by this application.
     *
     * Cleanups run once in reverse registration order after the normal shutdown event. They also run
     * when `stop()` is called after a partial/failed startup, where lifecycle listeners are not safe to
     * dispatch. The returned function unregisters cleanup for resources released early.
     */
    registerCleanup(cleanup: AppCleanup): () => void {
        const registered: RegisteredAppCleanup = { cleanup };
        this.registeredCleanups.push(registered);
        return () => {
            registered.cleanup = undefined;
        };
    }

    async start(): Promise<void> {
        if (this.started) return;
        if (this.starting) {
            await this.starting;
            return;
        }

        this.starting = this.startInternal();
        try {
            await this.starting;
        } finally {
            this.starting = undefined;
        }
    }

    private async startInternal(): Promise<void> {
        await this.events.dispatch(onAppBootstrap, undefined);
        if (this.options.db) this.container.get(this.options.db);
        this.createAutoConstructInstances();
        let workerStartAttempted = false;
        try {
            if (this.shouldStartWorkerRunner()) {
                workerStartAttempted = true;
                await this.container.get(WorkerRunnerService).start();
            }
            if (shouldDumpOpenApiSchema(this.config)) this.scheduleOpenApiSchemaDump();
            this.started = true;
        } catch (error) {
            const cleanupErrors: unknown[] = [];
            const runCleanup = async (cleanup: () => void | Promise<void>) => {
                try {
                    await cleanup();
                } catch (cleanupError) {
                    cleanupErrors.push(cleanupError);
                }
            };
            if (workerStartAttempted) await runCleanup(() => this.container.get(WorkerRunnerService).shutdown());
            if (this.options.enableWorker) await runCleanup(() => this.container.get(WorkerQueueRegistry).shutdown());
            if (cleanupErrors.length) {
                const rollbackError =
                    cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'Application startup rollback failed');
                if (error instanceof Error && error.cause === undefined) error.cause = rollbackError;
                else throw new AggregateError([error, rollbackError], 'Application startup and rollback failed');
            }
            throw error;
        }
    }

    async stop(): Promise<void> {
        const errors: unknown[] = [];
        const runStep = async (step: () => void | Promise<void>) => {
            try {
                await step();
            } catch (error) {
                errors.push(error);
            }
        };

        if (!this.started) {
            this.clearOpenApiDumpTimer();
            await runStep(() => this.devConsole?.close());
            await runStep(() => this.runRegisteredCleanups());
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
            return;
        }

        await runStep(() => this.events.dispatch(onServerShutdownRequested, undefined));
        this.clearOpenApiDumpTimer();
        if (this.options.enableWorker) {
            await runStep(() => this.container.get(WorkerRunnerService).shutdown());
            await runStep(() => this.container.get(WorkerQueueRegistry).shutdown());
        }
        await runStep(() => this.removeSignalHandlers());
        await runStep(() => this.devConsole?.close());
        await runStep(() => this.http.close());
        await runStep(() => this.events.dispatch(onServerShutdown, undefined));
        await runStep(() => this.runRegisteredCleanups());
        await runStep(() => this.shutdownTelemetryIfInstalled());
        this.started = false;

        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
    }

    async run(port?: number, host?: string): Promise<void> {
        if (await this.runEntrypointCommand(process.argv.slice(2))) return;
        await this.http.listen(port, host);
    }

    configureForCliService(): void {
        if (this.started || this.starting) throw new Error('Cannot configure CLI service mode after application startup');
        this.cliServiceMode = true;
        this.router.restrictControllers([HealthcheckController, MetricsController]);
    }

    private async runEntrypointCommand(args: string[]): Promise<boolean> {
        const [command, ...rest] = args;
        if (command) {
            const customCommand = this.findCommand(command);
            if (customCommand) {
                const instance = this.container.resolve(customCommand.classType, customCommand.moduleId);
                await this.invokeCommand(instance, rest);
                return true;
            }
        }
        switch (command) {
            case 'server:start':
                return false;
            case 'worker:start':
                await this.runWorkerEntrypoint();
                return true;
            case 'migrate':
            case 'migrate:run':
                await this.runMigrationsFromEntrypoint(rest);
                return true;
            case 'openapi:generate':
                await this.runOpenApiGenerationFromEntrypoint(rest);
                return true;
            case undefined:
                this.printEntrypointUsage();
                return true;
            default:
                this.printEntrypointUsage(`Unknown entrypoint command: ${command}`);
                return true;
        }
    }

    private printEntrypointUsage(message?: string): void {
        if (message) console.error(message);
        const entrypoint = process.argv[1] || '<entrypoint>';
        const customCommands = this.commandClasses
            .map(commandClass => getCommandMetadata(commandClass))
            .filter((metadata): metadata is NonNullable<typeof metadata> => !!metadata);
        const customCommandLines = customCommands.map(metadata => `  ${metadata.name.padEnd(20)} ${metadata.description ?? ''}`.trimEnd()).join('\n');
        console.error(`Usage: node ${entrypoint} <command> [options]

Commands:
  server:start          Start the HTTP server
  worker:start          Start the worker runner and HTTP health checks
  migrate, migrate:run  Run compiled database migrations
  openapi:generate      Write openapi.yaml from registered routes
${customCommandLines ? `${customCommandLines}\n` : ''}

Examples:
  node ${entrypoint} server:start
  node ${entrypoint} worker:start
  node ${entrypoint} migrate:run
  node ${entrypoint} openapi:generate`);
        process.exitCode = 1;
    }

    private findCommand(command: string): RegisteredCommand | undefined {
        const classType = this.commandClasses.find(commandClass => getCommandMetadata(commandClass)?.name === command);
        if (!classType) return undefined;
        return {
            classType,
            moduleId: this.commandModuleIds.get(classType)
        };
    }

    private async invokeCommand(instance: unknown, args: string[]): Promise<void> {
        if (!instance || typeof (instance as { execute?: unknown }).execute !== 'function') {
            throw new Error(`Command ${instance?.constructor?.name ?? '<unknown>'} does not define execute()`);
        }
        await (instance as { execute(args: string[]): unknown }).execute(args);
    }

    private async runWorkerEntrypoint(): Promise<void> {
        if (!this.options.enableWorker) throw new Error('Cannot start worker without enableWorker: true');
        this.forceWorkerRunner = true;
        await this.http.listen();
        await new Promise<void>(() => {});
    }

    private async runMigrationsFromEntrypoint(args: string[]): Promise<void> {
        if (!this.options.db) throw new Error('Cannot run migrations without a configured database provider');
        const db = this.get(BaseDatabase);
        try {
            const migrationsDir = parseEntrypointMigrationsDir(args);
            const migrations = await loadMigrationsFromDirectory(migrationsDir);
            const executions = await new MigrationRunner(db).run(migrations);
            if (this.options.enableWorker) await this.get(WorkerRunnerService).removeStaleBullMqCronJobs();
            console.log(`Ran ${executions.length} migration(s).`);
        } finally {
            if (this.options.enableWorker) await this.get(WorkerQueueRegistry).shutdown();
            await db.driver.close();
        }
    }

    private async runOpenApiGenerationFromEntrypoint(args: string[]): Promise<void> {
        if (args.length) throw new Error(`openapi:generate does not accept arguments: ${args.join(' ')}`);
        const path = await dumpOpenApiSchema(this);
        console.log(`Wrote OpenAPI schema to ${path}`);
    }

    async request(request: HttpRequest, response: HttpResponse = new MemoryHttpResponse()): Promise<HttpResponse> {
        return this.http.request(request, response);
    }

    private shouldStartWorkerRunner(): boolean {
        if (!this.options.enableWorker) return false;
        if (this.forceWorkerRunner) return true;
        if (this.config.ENABLE_JOB_RUNNER !== undefined) return this.config.ENABLE_JOB_RUNNER === true;
        return this.config.APP_ENV !== 'production';
    }

    private createAutoConstructInstances() {
        for (const registered of this.container.listRegisteredProviders()) {
            const classType = getProviderClass(registered.provider);
            if (classType && isAutoConstructProvider(classType, { cli: this.cliServiceMode })) {
                this.container.resolve(registered.token, registered.moduleId);
            }
        }
    }

    private scheduleOpenApiSchemaDump(): void {
        this.clearOpenApiDumpTimer();
        const logger = this.container.get(ScopedLogger).scoped('app');
        this.openApiDumpTimer = setTimeout(() => {
            this.openApiDumpTimer = undefined;
            void dumpOpenApiSchema(this)
                .then(path => logger.info(`OpenAPI schema written to: ${path}`))
                .catch(error => logger.error('Failed to write OpenAPI schema', error));
        }, 250);
        this.openApiDumpTimer.unref?.();
    }

    private clearOpenApiDumpTimer(): void {
        if (!this.openApiDumpTimer) return;
        clearTimeout(this.openApiDumpTimer);
        this.openApiDumpTimer = undefined;
    }

    private registerDatabaseHealthcheck(dbClass: ClassType): void {
        const healthcheck = this.container.get(HealthcheckService);
        healthcheck.register('database', async () => {
            const db = this.container.get<any>(dbClass);
            if (!db?.driver || typeof db.driver.connect !== 'function') throw new Error('Configured db provider is not a BaseDatabase instance');
            await db.driver.connect();
            await db.rawFind(sql`SELECT 1`);
        });
    }

    private getControllerModuleIds(controllers: readonly ClassType[]): Map<ClassType, number> {
        const controllerSet = new Set<ClassType>(controllers);
        const moduleIds = new Map<ClassType, number>();
        for (const registered of this.container.listRegisteredProviders()) {
            if (typeof registered.token === 'function' && controllerSet.has(registered.token as ClassType)) {
                moduleIds.set(registered.token as ClassType, registered.moduleId);
            }
        }
        return moduleIds;
    }

    private getCommandModuleIds(commands: readonly ClassType[]): Map<ClassType, number> {
        const commandSet = new Set<ClassType>(commands);
        const moduleIds = new Map<ClassType, number>();
        for (const registered of this.container.listRegisteredProviders()) {
            if (
                typeof registered.token === 'function' &&
                commandSet.has(registered.token as ClassType) &&
                !moduleIds.has(registered.token as ClassType)
            ) {
                moduleIds.set(registered.token as ClassType, registered.moduleId);
            }
        }
        return moduleIds;
    }

    private registerDecoratedListeners(): void {
        const registeredProviders = this.container.listRegisteredProviders();
        for (const listenerClass of this.listenerClasses) {
            const registered = registeredProviders.find(item => item.token === listenerClass);
            const moduleId = registered?.moduleId;
            for (const metadata of getListenerMethodMetadata(listenerClass.prototype)) {
                this.events.listen(
                    metadata.token,
                    async event => {
                        const listener = moduleId === undefined ? this.container.get(listenerClass) : this.container.resolve(listenerClass, moduleId);
                        await (listener as Record<symbol | string, (event: unknown) => void | Promise<void>>)[metadata.methodName](event);
                    },
                    metadata.order
                );
            }
        }
    }

    private async shutdownTelemetryIfInstalled(): Promise<void> {
        if (!OtelState.tracerProvider && !OtelState.meterProvider) return;
        const { shutdownTelemetry } = await import('../telemetry/otel/index');
        await shutdownTelemetry();
    }

    private async runRegisteredCleanups(): Promise<void> {
        const errors: unknown[] = [];
        while (this.registeredCleanups.length) {
            const registered = this.registeredCleanups.pop()!;
            const cleanup = registered.cleanup;
            registered.cleanup = undefined;
            if (!cleanup) continue;
            try {
                await cleanup();
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Application resource cleanup failed');
    }

    private installSignalHandlers(): void {
        if (this.signalHandlers) return;
        const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
        this.signalHandlers = {};
        for (const signal of signals) {
            const handler = () => {
                this.stop()
                    .catch(error => {
                        console.error(error);
                        process.exit(1);
                    })
                    .then(() => process.exit(0));
            };
            this.signalHandlers[signal] = handler;
            process.once(signal, handler);
        }
    }

    private removeSignalHandlers(): void {
        if (!this.signalHandlers) return;
        for (const [signal, handler] of Object.entries(this.signalHandlers)) {
            if (handler) process.off(signal as NodeJS.Signals, handler);
        }
        this.signalHandlers = undefined;
    }
}

export function createApp<C extends BaseAppConfig = BaseAppConfig>(options: CreateAppOptions<C>): App<C> {
    const app = new App(options);
    setCurrentApp(app);
    return app;
}

function getProviderClass(provider: Provider): ClassType | undefined {
    if (!isStructuredProvider(provider)) return isClass(provider) ? provider : undefined;
    if ('useClass' in provider) return provider.useClass;
    return undefined;
}

function createControllerProvider(controller: ClassType, app?: App<any>): Provider {
    if (controller === DevConsoleController) {
        if (!app) throw new Error('DevConsoleController requires an app instance');
        return {
            provide: DevConsoleController,
            useFactory: () => new DevConsoleController(app),
            scope: 'request'
        };
    }
    if (controller === OpenApiController) {
        if (!app) throw new Error('OpenApiController requires an app instance');
        return {
            provide: OpenApiController,
            useFactory: () => new OpenApiController(app),
            scope: 'request'
        };
    }
    return {
        provide: controller,
        useClass: controller,
        scope: 'request'
    };
}

function createCommandProvider(command: ClassType): Provider {
    return {
        provide: command,
        useClass: command
    };
}

function uniqueClasses<T extends ClassType>(classes: T[]): T[] {
    return [...new Set(classes)];
}

function addFrameworkProvidersToImports(imports: ModuleLike[]): ModuleDefinition[] {
    return imports.map(imported => addFrameworkProvidersToModule(normalizeModule(imported)));
}

function addFrameworkProvidersToModule(definition: ModuleDefinition): ModuleDefinition {
    const controllers = definition.controllers ?? [];
    assertHttpControllerClasses(controllers);
    const commands = definition.commands ?? [];
    assertCommandClasses(commands);
    const controllerProviders = controllers.map(controller => createControllerProvider(controller));
    const commandProviders = commands.map(command => createCommandProvider(command));
    return {
        ...definition,
        imports: addFrameworkProvidersToImports(definition.imports ?? []),
        providers: uniqueProviders([...(definition.providers ?? []), ...controllerProviders, ...commandProviders])
    };
}

function collectImportedControllers(imports: ModuleLike[]): ClassType[] {
    const result: ClassType[] = [];
    for (const imported of imports) {
        const definition = normalizeModule(imported);
        result.push(...(definition.controllers ?? []), ...collectImportedControllers(definition.imports ?? []));
    }
    return result;
}

function collectImportedListeners(imports: ModuleLike[]): ClassType[] {
    const result: ClassType[] = [];
    for (const imported of imports) {
        const definition = normalizeModule(imported);
        result.push(...(definition.listeners ?? []), ...collectImportedListeners(definition.imports ?? []));
    }
    return result;
}

function collectImportedCommands(imports: ModuleLike[]): ClassType[] {
    const result: ClassType[] = [];
    for (const imported of imports) {
        const definition = normalizeModule(imported);
        result.push(...(definition.commands ?? []), ...collectImportedCommands(definition.imports ?? []));
    }
    return result;
}

function uniqueProviders(providers: Provider[]): Provider[] {
    const order: Token[] = [];
    const byToken = new Map<Token, Provider>();
    for (const provider of providers) {
        const token = getProviderToken(provider);
        if (!byToken.has(token)) order.push(token);
        byToken.set(token, provider);
    }
    return order.map(token => byToken.get(token)!);
}

function assertHttpControllerClasses(controllers: readonly ClassType[]): void {
    for (const controller of controllers) {
        if (typeof controller === 'function' && getControllerMetadata(controller)) continue;
        throw new Error(`Controller ${getClassName(controller)} passed to controllers must be decorated with @http.controller()`);
    }
}

function assertCommandClasses(commands: readonly ClassType[]): void {
    for (const command of commands) {
        if (typeof command === 'function' && getCommandMetadata(command)) continue;
        throw new Error(`Command ${getClassName(command)} passed to commands must be decorated with @cli.command() or @cli.controller()`);
    }
}

function getClassName(classType: ClassType): string {
    return typeof classType === 'function' && classType.name ? classType.name : '<anonymous>';
}
