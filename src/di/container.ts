import { ReflectionClass, ReflectionKind, Type } from '../reflection';

import { isClass, type ClassType } from '../types';
import { CyclicDependencyError, DuplicateProviderError, ProviderNotFoundError, RequestScopeError, ScopeMismatchError } from './errors';
import { getProviderScope, getProviderToken, isStructuredProvider, Provider, Token } from './provider';
import { ModuleDefinition, normalizeModule } from './module';

interface RegisteredProvider {
    provider: Provider;
    moduleId: number;
    exported: boolean;
}

interface ModuleRecord {
    id: number;
    definition: ModuleDefinition;
    localProviders: Map<Token, RegisteredProvider>;
    importedProviders: Map<Token, RegisteredProvider>;
    exportedProviders: Map<Token, RegisteredProvider>;
}

interface ConstructorDependency {
    token?: Token;
    optional: boolean;
}

export interface RequestContext {
    instances: Map<Token, unknown>;
}

export class Container {
    private modules: ModuleRecord[] = [];
    private rootProviders = new Map<Token, RegisteredProvider>();
    private exportedProviders = new Map<Token, RegisteredProvider>();
    private singletons = new Map<Token, unknown>();

    constructor(root: ModuleDefinition) {
        this.compile(root);
    }

    createRequestContext(): RequestContext {
        return { instances: new Map() };
    }

    get<T>(token: Token<T>, context?: RequestContext): T {
        return this.resolve(token, undefined, context, []);
    }

    has(token: Token, requestingModuleId?: number): boolean {
        return !!this.findRegisteredProvider(token, requestingModuleId);
    }

    resolve<T>(
        token: Token<T>,
        requestingModuleId?: number,
        context?: RequestContext,
        chain: Token[] = [],
        singletonInChain = false,
        injectionTarget?: ClassType
    ): T {
        if (chain.includes(token)) {
            throw new CyclicDependencyError([...chain, token]);
        }

        if (context?.instances.has(token)) {
            if (singletonInChain) throw new ScopeMismatchError(token, chain);
            return context.instances.get(token) as T;
        }

        const registered = this.findRegisteredProvider(token, requestingModuleId);
        if (!registered) {
            throw new ProviderNotFoundError(token, chain);
        }

        const scope = getProviderScope(registered.provider);
        if (scope === 'singleton' && this.singletons.has(token)) return this.singletons.get(token) as T;
        if (scope === 'request') {
            if (singletonInChain) throw new ScopeMismatchError(token, chain);
            if (!context) throw new RequestScopeError(token);
            if (context.instances.has(token)) return context.instances.get(token) as T;
        }

        const value = this.instantiate<T>(registered, context, [...chain, token], singletonInChain || scope === 'singleton', injectionTarget);

        if (scope === 'singleton') this.singletons.set(token, value);
        if (scope === 'request') context!.instances.set(token, value);

        return value;
    }

    listProviders(): Token[] {
        return [
            ...new Set([...this.rootProviders.keys(), ...this.exportedProviders.keys(), ...this.modules.flatMap(m => [...m.localProviders.keys()])])
        ];
    }

    listExports(): Token[] {
        return [...this.exportedProviders.keys()];
    }

    listRegisteredProviders(): {
        token: Token;
        provider: Provider;
        moduleId: number;
        exported: boolean;
    }[] {
        const result: { token: Token; provider: Provider; moduleId: number; exported: boolean }[] = [];
        const seen = new Set<RegisteredProvider>();
        const providers = [
            ...this.rootProviders.values(),
            ...this.exportedProviders.values(),
            ...this.modules.flatMap(module => [...module.localProviders.values()])
        ];

        for (const registered of providers) {
            if (seen.has(registered)) continue;
            seen.add(registered);
            result.push({
                token: getProviderToken(registered.provider),
                provider: registered.provider,
                moduleId: registered.moduleId,
                exported: registered.exported
            });
        }

        return result;
    }

    private compile(root: ModuleDefinition) {
        const rootRecord = this.addModule(root);
        for (const provider of [...(root.providers ?? []), ...(root.listeners ?? [])]) {
            this.registerProvider(rootRecord, provider);
            this.registerRootProvider(provider, rootRecord);
        }

        for (const imported of root.imports ?? []) {
            const importedRecord = this.compileImportedModule(normalizeModule(imported), true);
            this.addImportedExports(rootRecord, importedRecord);
        }
    }

    private compileImportedModule(definition: ModuleDefinition, exposeExportsGlobally: boolean): ModuleRecord {
        const record = this.addModule(definition);
        for (const provider of [...(definition.providers ?? []), ...(definition.listeners ?? [])]) {
            this.registerProvider(record, provider);
        }

        for (const imported of definition.imports ?? []) {
            const importedRecord = this.compileImportedModule(normalizeModule(imported), false);
            this.addImportedExports(record, importedRecord);
        }

        for (const token of definition.exports ?? []) {
            const registered = record.localProviders.get(token) ?? record.importedProviders.get(token);
            if (!registered) throw new ProviderNotFoundError(token);
            const exported = { ...registered, exported: true };
            record.exportedProviders.set(token, exported);
            if (exposeExportsGlobally) this.registerExport(token, exported);
        }

        return record;
    }

    private addModule(definition: ModuleDefinition): ModuleRecord {
        const record: ModuleRecord = {
            id: this.modules.length,
            definition,
            localProviders: new Map(),
            importedProviders: new Map(),
            exportedProviders: new Map()
        };
        this.modules.push(record);
        return record;
    }

    private addImportedExports(record: ModuleRecord, importedRecord: ModuleRecord): void {
        for (const [token, provider] of importedRecord.exportedProviders) {
            if (!record.importedProviders.has(token)) record.importedProviders.set(token, provider);
        }
    }

    private registerProvider(moduleRecord: ModuleRecord, provider: Provider) {
        const token = getProviderToken(provider);
        moduleRecord.localProviders.set(token, {
            provider,
            moduleId: moduleRecord.id,
            exported: false
        });
    }

    private registerRootProvider(provider: Provider, moduleRecord: ModuleRecord) {
        const token = getProviderToken(provider);
        this.rootProviders.set(token, { provider, moduleId: moduleRecord.id, exported: true });
    }

    private registerExport(token: Token, provider: RegisteredProvider) {
        if (this.exportedProviders.has(token)) throw new DuplicateProviderError(token, 'global exports');
        this.exportedProviders.set(token, { ...provider, exported: true });
    }

    private findRegisteredProvider(token: Token, requestingModuleId?: number): RegisteredProvider | undefined {
        if (requestingModuleId !== undefined) {
            const module = this.modules[requestingModuleId];
            const local = module?.localProviders.get(token);
            if (local) return local;
            const imported = module?.importedProviders.get(token);
            if (imported) return imported;
        }

        return this.rootProviders.get(token) ?? this.exportedProviders.get(token);
    }

    private instantiate<T>(
        registered: RegisteredProvider,
        context: RequestContext | undefined,
        chain: Token[],
        singletonInChain: boolean,
        injectionTarget?: ClassType
    ): T {
        const provider = registered.provider;

        if (!isStructuredProvider(provider)) {
            if (!isClass(provider)) throw new Error(`Provider ${provider.name || '<anonymous>'} is not constructable`);
            return this.instantiateClass(provider, registered.moduleId, context, chain, singletonInChain) as T;
        }

        if ('useValue' in provider) return provider.useValue as T;
        if ('useExisting' in provider)
            return this.resolve(provider.useExisting, registered.moduleId, context, chain, singletonInChain, injectionTarget) as T;
        if ('useFactory' in provider) {
            const deps = provider.deps ?? [];
            const args = deps.map(dep => this.resolve(dep, registered.moduleId, context, chain, singletonInChain, injectionTarget));
            return provider.useFactory(...args) as T;
        }
        if ('useTargetFactory' in provider) {
            const deps = provider.deps ?? [];
            const args = deps.map(dep => this.resolve(dep, registered.moduleId, context, chain, singletonInChain, injectionTarget));
            return provider.useTargetFactory(injectionTarget ?? getInjectionTarget(chain), ...args) as T;
        }
        if ('useClass' in provider) {
            return this.instantiateClass(provider.useClass, registered.moduleId, context, chain, singletonInChain) as T;
        }

        throw new ProviderNotFoundError(getProviderToken(provider), chain);
    }

    private instantiateClass<T>(
        classType: ClassType<T>,
        moduleId: number,
        context: RequestContext | undefined,
        chain: Token[],
        singletonInChain: boolean
    ): T {
        const deps = this.getConstructorDependencies(classType).map(dep => {
            if (!dep.token) return undefined;
            if (dep.optional && !this.findRegisteredProvider(dep.token, moduleId)) return undefined;
            return this.resolve(dep.token, moduleId, context, chain, singletonInChain, classType);
        });
        return new classType(...deps);
    }

    private getConstructorDependencies(classType: ClassType): ConstructorDependency[] {
        let reflection: ReflectionClass;
        try {
            reflection = ReflectionClass.from(classType);
        } catch (error) {
            if (classType.length === 0 && error instanceof Error && error.message.includes('No runtime type metadata')) return [];
            throw error;
        }
        const constructor = reflection.getConstructorOrUndefined();
        if (!constructor) return [];

        return constructor.getParameters().map(parameter => {
            const type = parameter.getType();
            const optional = parameter.isOptional() || parameter.hasDefault();
            const token = tokenFromType(type);
            if (!token && !optional) {
                throw new Error(`Cannot resolve constructor parameter ${parameter.getName()} of ${classType.name}; use an explicit factory provider`);
            }
            return { token, optional };
        });
    }
}

function getInjectionTarget(chain: Token[]): ClassType | undefined {
    for (let i = chain.length - 2; i >= 0; i--) {
        const token = chain[i];
        if (typeof token === 'function' && token.prototype) return token as ClassType;
    }
}

function tokenFromType(type: Type): Token | undefined {
    const concrete = unwrapOptionalType(type);
    if (concrete.kind === ReflectionKind.class) return concrete.classType;
    return undefined;
}

function unwrapOptionalType(type: Type): Type {
    if (type.kind !== ReflectionKind.union) return type;
    const concrete = type.types.filter(t => t.kind !== ReflectionKind.undefined && t.kind !== ReflectionKind.null);
    return concrete.length === 1 ? concrete[0] : type;
}

export function createContainer(definition: ModuleDefinition): Container {
    return new Container(definition);
}
