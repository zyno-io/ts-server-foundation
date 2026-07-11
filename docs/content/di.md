# Dependency Injection

TSF has a dependency injection container that uses reflected type metadata for constructor parameter types. It supports class providers, structured providers, scopes, modules, request contexts, and globally injectable exports from imported modules.

## Basic Providers

Register providers through `createApp()` or `createContainer()`:

```ts
import { createApp } from '@zyno-io/ts-server-foundation';

class UserRepository {}

class UserService {
    constructor(readonly users: UserRepository) {}
}

const app = createApp({
    providers: [UserRepository, UserService]
});

const service = app.get(UserService);
```

Constructor dependencies are inferred from reflected class types. Optional constructor parameters are injected only when a matching provider is registered.

## Structured Providers

```ts
const TOKEN = Symbol('token');

const app = createApp({
    providers: [
        { provide: TOKEN, useValue: 7 },
        { provide: BaseUserService, useClass: UserService },
        { provide: CurrentUserService, useExisting: BaseUserService },
        {
            provide: UserPresenter,
            useFactory: (users: UserService) => new UserPresenter(users),
            deps: [UserService]
        }
    ]
});
```

Supported provider forms:

| Provider           | Behavior                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Class              | Singleton class provider by default.                                                            |
| `useValue`         | Static singleton value.                                                                         |
| `useClass`         | Instantiate a concrete class for a token.                                                       |
| `useExisting`      | Alias another provider token and preserve the target provider's scope.                          |
| `useFactory`       | Call a factory with explicit `deps`.                                                            |
| `useTargetFactory` | Call a factory with the consuming class target plus explicit `deps`. Useful for scoped loggers. |

## Scopes

Provider scopes are:

| Scope       | Behavior                                                                               |
| ----------- | -------------------------------------------------------------------------------------- |
| `singleton` | One instance per container. Default for class, `useClass`, and `useFactory` providers. |
| `transient` | New instance per resolution. Default for `useExisting` and `useTargetFactory`.         |
| `request`   | One instance per request context. Requires a request context.                          |
| `http`      | Legacy alias for `request`; normalized to request scope.                               |

```ts
const app = createApp({
    providers: [{ provide: RequestState, useClass: RequestState, scope: 'request' }]
});
```

Request-scoped providers cannot be captured by singletons. The container throws `ScopeMismatchError` instead of letting a singleton hold request-local state forever.

The same rule applies to request-local values placed directly in `RequestContext.instances`: resolving them through a singleton factory is rejected. Request-scoped and transient consumers may depend on request-scoped providers when they are resolved with a context. A transient consumer is rebuilt on every resolution, while its request-scoped dependency is reused within that context. The legacy `scope: 'http'` spelling is normalized to `request` and has identical caching and error behavior.

## Modules And Global Exports

Modules are plain definitions created with `createModule()` or `new AppModule()`.

```ts
import { createApp, createModule } from '@zyno-io/ts-server-foundation';

class ExportedService {}
class HiddenService {}

const featureModule = createModule({
    providers: [ExportedService, HiddenService],
    exports: [ExportedService]
});

class Consumer {
    constructor(readonly service: ExportedService) {}
}

const app = createApp({
    imports: [featureModule],
    providers: [Consumer]
});
```

An exported provider from a module imported by the root app is globally injectable. Consumers do not need to explicitly import the feature module at their own declaration site.

Non-exported providers stay local to their module. Transitive exports do not leak unless the intermediate module re-exports them.

Duplicate global exports are rejected with `DuplicateProviderError`.

Module definitions can also declare `controllers`, `listeners`, and `commands`. `createApp()` walks imported modules recursively, registers their controllers as request-scoped providers, wires decorated listeners, and makes decorated commands available to app command dispatch. Controllers must use `@http.controller()`; commands must use `@cli.command()` or `@cli.controller()`.

## Request Context

The HTTP router creates a request context for controller and middleware resolution. Request-scoped providers resolve from that context.

For manual container usage:

```ts
import { createContainer } from '@zyno-io/ts-server-foundation';

const container = createContainer({
    providers: [{ provide: RequestState, useClass: RequestState, scope: 'request' }]
});

const context = container.createRequestContext();
const state = container.get(RequestState, context);
```

Resolving a request-scoped provider without a request context throws `RequestScopeError`.

## Controller Lifecycle

HTTP controllers are registered as request-scoped providers by `createApp()`. A matched route creates a request context, resolves the controller inside that context, invokes the route method, and then lets the context go.

Normal injected services are singletons by default. This means a controller instance is per request, but a constructor-injected repository/service stays shared unless its provider is explicitly registered with `scope: 'request'` or `scope: 'transient'`.

## Application Lifecycle

`App` exposes five lifecycle tokens:

| Token                       | Dispatch point                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `onAppBootstrap`            | At the start of `app.start()`, before database construction, `AutoConstruct` providers, and the worker runner.       |
| `onServerBootstrap`         | After the Node HTTP server has successfully bound and after signal handlers/DevConsole startup.                      |
| `onServerMainBootstrapDone` | Immediately after all `onServerBootstrap` handlers complete.                                                         |
| `onServerShutdownRequested` | First step of a started app's `stop()` sequence, before framework-owned resources are closed.                        |
| `onServerShutdown`          | After worker services, signal handlers, DevConsole, and the owned HTTP server are closed; before telemetry shutdown. |

`app.start()` dispatches only application bootstrap. `app.http.listen()` calls `start()` automatically and then dispatches the two server-bootstrap tokens after binding. Calling `start()` concurrently shares the in-flight startup work; calling it again after startup is a no-op. After a completed `stop()`, a later `start()` is a new lifecycle and dispatches bootstrap again.

Register a direct handler with `app.on()`:

```ts
import { onAppBootstrap } from '@zyno-io/ts-server-foundation';

const unsubscribe = app.on(
    onAppBootstrap,
    async () => {
        await warmCache();
    },
    10
);
```

Or register a DI-backed listener class:

```ts
import { createApp, event, onAppBootstrap } from '@zyno-io/ts-server-foundation';

class LifecycleListener {
    constructor(private readonly service: UserService) {}

    @event.listen(onAppBootstrap, 10)
    async warm() {
        await this.service.warmCache();
    }
}

const app = createApp({ listeners: [LifecycleListener] });
```

Handlers run sequentially in descending numeric `order`; handlers with the same order retain registration order. `app.on()` registers the callback directly and returns an unsubscribe function. Decorated methods are discovered only on classes listed in `listeners` (including imported-module listeners); those classes are registered with DI and resolved when the event dispatches.

`@AutoConstruct()` follows the provider graph rather than scanning every decorated class in the program. During startup, TSF instantiates only decorated classes already registered as class or `useClass` providers, including registered providers in imported modules. The decorator does not register a class. A configured database is constructed before these providers so entity metadata is ready for startup services.

If worker-runner startup fails, the app attempts both runner and queue-registry rollback. A rollback failure is attached as the startup error's cause when possible; otherwise startup and rollback failures are combined in an `AggregateError`.

`app.stop()` is idempotent after shutdown and does nothing before startup. For a started app it dispatches `onServerShutdownRequested`, closes enabled worker runner/queue resources, removes installed signal handlers, closes DevConsole and the owned HTTP listener, dispatches `onServerShutdown`, then shuts down installed TSF telemetry. A failed listener or framework cleanup step does not prevent later steps from running; after cleanup, `stop()` rethrows the single failure or an `AggregateError` containing multiple failures. It does not infer teardown methods on arbitrary DI providers and does not close a configured database driver; use a shutdown listener for application-owned database clients, Redis clients, or other resources. SIGINT/SIGTERM handlers are installed only after an HTTP listener binds and call `app.stop()` before exiting.

## App-Level Resolution

Use constructor injection first. When you need to resolve from the current app outside constructor injection, use `resolve()` or `r()`:

```ts
import { BaseAppConfig, r, resolve } from '@zyno-io/ts-server-foundation';

const config = resolve(BaseAppConfig);
const sameConfig = r(BaseAppConfig);
```

`resolve()` uses the current app created by `createApp()`.

## Errors

Common DI errors:

| Error                    | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `ProviderNotFoundError`  | No provider is visible for the requested token.                   |
| `DuplicateProviderError` | Two imported modules expose the same token as a global export.    |
| `CyclicDependencyError`  | Constructor/factory dependency graph contains a cycle.            |
| `RequestScopeError`      | A request-scoped provider was resolved without a request context. |
| `ScopeMismatchError`     | A singleton attempted to capture request-scoped state.            |
