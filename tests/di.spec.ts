import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createApp,
    createContainer,
    createModule,
    DuplicateProviderError,
    ProviderNotFoundError,
    RequestScopeError,
    ScopeMismatchError,
    r
} from '../src';

describe('di container', () => {
    it('resolves a simple class provider', () => {
        class Service {}

        const container = createContainer({ providers: [Service] });
        assert.ok(container.get(Service) instanceof Service);
    });

    it('resolves constructor dependencies from type reflection', () => {
        class Dependency {}
        class Service {
            constructor(readonly dependency: Dependency) {}
        }

        const container = createContainer({ providers: [Dependency, Service] });
        assert.ok(container.get(Service).dependency instanceof Dependency);
    });

    it('inherits base constructor dependencies for default subclass constructors', () => {
        class Dependency {}
        abstract class BaseService {
            constructor(readonly dependency: Dependency) {}
        }
        class Service extends BaseService {}

        const container = createContainer({ providers: [Dependency, Service] });
        assert.ok(container.get(Service).dependency instanceof Dependency);
    });

    it('does not inherit base constructor dependencies for explicit zero-argument subclass constructors', () => {
        class Dependency {}
        abstract class BaseService {
            constructor(readonly dependency?: Dependency) {}
        }
        class Service extends BaseService {
            constructor() {
                super();
            }
        }

        const container = createContainer({ providers: [Dependency, Service] });
        assert.equal(container.get(Service).dependency, undefined);
    });

    it('does not inherit constructor dependencies through unreflected dynamic base classes', () => {
        const DynamicBase = Function('return class { constructor(driver) { this.driver = driver; } }')() as new (driver?: unknown) => {
            driver?: unknown;
        };
        class Service extends DynamicBase {}

        const container = createContainer({ providers: [Service] });
        assert.equal(container.get(Service).driver, undefined);
    });

    it('does not read inherited static type metadata from unreflected dynamic base classes', () => {
        class ReflectedBase {
            constructor(readonly driver: string) {}
        }
        const DynamicBase = Function('Base', 'return class extends Base { constructor() { super(); } }')(ReflectedBase) as new () => ReflectedBase;
        class Service extends DynamicBase {}

        const container = createContainer({ providers: [Service] });
        assert.equal(container.get(Service).driver, undefined);
    });

    it('omits optional constructor dependencies when no provider is registered', () => {
        class OptionalDependency {}
        class Service {
            constructor(readonly dependency?: OptionalDependency) {}
        }

        const container = createContainer({ providers: [Service] });
        assert.equal(container.get(Service).dependency, undefined);
    });

    it('injects optional constructor dependencies when a provider is registered', () => {
        class OptionalDependency {}
        class Service {
            constructor(readonly dependency?: OptionalDependency) {}
        }

        const container = createContainer({ providers: [OptionalDependency, Service] });
        assert.ok(container.get(Service).dependency instanceof OptionalDependency);
    });

    it('resolves useValue, useExisting, useClass, and useFactory providers', () => {
        class Source {}
        class Impl extends Source {}
        const TOKEN = Symbol('token');
        const ALIAS = Symbol('alias');
        const FACTORY = Symbol('factory');

        const container = createContainer({
            providers: [
                { provide: TOKEN, useValue: 7 },
                { provide: Source, useClass: Impl },
                { provide: ALIAS, useExisting: Source },
                { provide: FACTORY, useFactory: (value: number) => value + 1, deps: [TOKEN] }
            ]
        });

        assert.equal(container.get(TOKEN), 7);
        assert.ok(container.get(Source) instanceof Impl);
        assert.strictEqual(container.get(ALIAS), container.get(Source));
        assert.equal(container.get(FACTORY), 8);
    });

    it('lets later providers override earlier providers in the same module', () => {
        class Service {
            value = 'default';
        }
        class TestService extends Service {
            override value = 'test';
        }

        const container = createContainer({
            providers: [Service, { provide: Service, useClass: TestService }]
        });

        assert.equal(container.get(Service).value, 'test');
    });

    it('preserves the target provider scope for useExisting aliases', () => {
        class TransientService {}
        class RequestService {}
        const TRANSIENT_ALIAS = Symbol('transient alias');
        const REQUEST_ALIAS = Symbol('request alias');

        const container = createContainer({
            providers: [
                { provide: TransientService, useClass: TransientService, scope: 'transient' },
                { provide: RequestService, useClass: RequestService, scope: 'request' },
                { provide: TRANSIENT_ALIAS, useExisting: TransientService },
                { provide: REQUEST_ALIAS, useExisting: RequestService }
            ]
        });
        const firstContext = container.createRequestContext();
        const secondContext = container.createRequestContext();

        assert.notStrictEqual(container.get(TRANSIENT_ALIAS), container.get(TRANSIENT_ALIAS));
        assert.strictEqual(container.get(REQUEST_ALIAS, firstContext), container.get(REQUEST_ALIAS, firstContext));
        assert.notStrictEqual(container.get(REQUEST_ALIAS, firstContext), container.get(REQUEST_ALIAS, secondContext));
        assert.throws(() => container.get(REQUEST_ALIAS), RequestScopeError);
    });

    it('caches singletons by default', () => {
        class Service {}
        const container = createContainer({ providers: [Service] });
        assert.strictEqual(container.get(Service), container.get(Service));
    });

    it('creates transient instances per resolution', () => {
        class Service {}
        const container = createContainer({
            providers: [{ provide: Service, useClass: Service, scope: 'transient' }]
        });
        assert.notStrictEqual(container.get(Service), container.get(Service));
    });

    it('creates request-scoped instances per context', () => {
        class Service {}
        const container = createContainer({
            providers: [{ provide: Service, useClass: Service, scope: 'request' }]
        });
        const a = container.createRequestContext();
        const b = container.createRequestContext();

        assert.strictEqual(container.get(Service, a), container.get(Service, a));
        assert.notStrictEqual(container.get(Service, a), container.get(Service, b));
    });

    it('normalizes the legacy http provider scope to request scope', () => {
        class Service {}
        const container = createContainer({
            providers: [{ provide: Service, useClass: Service, scope: 'http' }]
        });
        const firstContext = container.createRequestContext();
        const secondContext = container.createRequestContext();

        assert.strictEqual(container.get(Service, firstContext), container.get(Service, firstContext));
        assert.notStrictEqual(container.get(Service, firstContext), container.get(Service, secondContext));
        assert.throws(() => container.get(Service), RequestScopeError);
    });

    it('allows transient providers to consume request state without capturing it', () => {
        class RequestState {}
        class RequestOperation {
            constructor(readonly state: RequestState) {}
        }
        const container = createContainer({
            providers: [
                { provide: RequestState, useClass: RequestState, scope: 'request' },
                { provide: RequestOperation, useClass: RequestOperation, scope: 'transient' }
            ]
        });
        const firstContext = container.createRequestContext();
        const secondContext = container.createRequestContext();
        const first = container.get(RequestOperation, firstContext);
        const again = container.get(RequestOperation, firstContext);
        const second = container.get(RequestOperation, secondContext);

        assert.notStrictEqual(first, again);
        assert.strictEqual(first.state, again.state);
        assert.notStrictEqual(first.state, second.state);
    });

    it('throws when resolving request-scoped provider outside a request context', () => {
        class Service {}
        const container = createContainer({
            providers: [{ provide: Service, useClass: Service, scope: 'request' }]
        });
        assert.throws(() => container.get(Service), RequestScopeError);
    });

    it('rejects request-scoped dependencies captured by singletons', () => {
        class RequestService {}
        class SingletonService {
            constructor(readonly requestService: RequestService) {}
        }

        const container = createContainer({
            providers: [{ provide: RequestService, useClass: RequestService, scope: 'request' }, SingletonService]
        });

        assert.throws(() => container.get(SingletonService, container.createRequestContext()), ScopeMismatchError);
    });

    it('rejects dynamic request context values captured by singletons', () => {
        const REQUEST_TOKEN = Symbol('request token');
        class SingletonService {
            constructor(readonly requestValue: string) {}
        }

        const container = createContainer({
            providers: [
                {
                    provide: SingletonService,
                    useFactory: (value: string) => new SingletonService(value),
                    deps: [REQUEST_TOKEN]
                }
            ]
        });
        const context = container.createRequestContext();
        context.instances.set(REQUEST_TOKEN, 'request-value');

        assert.throws(() => container.get(SingletonService, context), ScopeMismatchError);
    });

    it('makes exported imported-module providers globally injectable', () => {
        class ExportedService {}
        class Consumer {
            constructor(readonly exportedService: ExportedService) {}
        }

        const feature = createModule({
            providers: [ExportedService],
            exports: [ExportedService]
        });

        const container = createContainer({
            imports: [feature],
            providers: [Consumer]
        });

        assert.ok(container.get(Consumer).exportedService instanceof ExportedService);
    });

    it('does not make non-exported imported-module providers globally injectable', () => {
        class HiddenService {}
        class Consumer {
            constructor(readonly hiddenService: HiddenService) {}
        }

        const feature = createModule({ providers: [HiddenService] });
        const container = createContainer({ imports: [feature], providers: [Consumer] });

        assert.throws(() => container.get(Consumer), ProviderNotFoundError);
    });

    it('does not leak exports from transitive imports unless they are re-exported', () => {
        class TransitiveService {}
        class ParentConsumer {
            constructor(readonly service: TransitiveService) {}
        }
        class RootConsumer {
            constructor(readonly service: TransitiveService) {}
        }

        const child = createModule({ providers: [TransitiveService], exports: [TransitiveService] });
        const parent = createModule({
            imports: [child],
            providers: [ParentConsumer],
            exports: [ParentConsumer]
        });
        const container = createContainer({ imports: [parent], providers: [RootConsumer] });

        assert.ok(container.get(ParentConsumer).service instanceof TransitiveService);
        assert.throws(() => container.get(RootConsumer), ProviderNotFoundError);

        const reExportingParent = createModule({ imports: [child], exports: [TransitiveService] });
        const reExportingContainer = createContainer({
            imports: [reExportingParent],
            providers: [RootConsumer]
        });

        assert.ok(reExportingContainer.get(RootConsumer).service instanceof TransitiveService);
    });

    it('rejects duplicate exported providers', () => {
        class Service {}
        const a = createModule({ providers: [Service], exports: [Service] });
        const b = createModule({ providers: [Service], exports: [Service] });

        assert.throws(() => createContainer({ imports: [a, b] }), DuplicateProviderError);
    });

    it('resolves app-level singletons through the current app', () => {
        class Service {}
        createApp({ providers: [Service] });
        assert.strictEqual(r(Service), r(Service));
    });

    it('does not cache app-level transient providers outside the container', () => {
        class Service {}
        createApp({ providers: [{ provide: Service, useClass: Service, scope: 'transient' }] });
        assert.notStrictEqual(r(Service), r(Service));
    });
});
