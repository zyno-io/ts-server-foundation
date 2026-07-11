import type { ClassType } from '../types';
import type { Provider, Token } from './provider';

export interface ModuleDefinition<C = unknown> {
    config?: ClassType<C>;
    defaultConfig?: Partial<C>;
    imports?: ModuleLike[];
    exports?: Token[];
    providers?: Provider[];
    controllers?: ClassType[];
    listeners?: ClassType[];
    commands?: ClassType[];
}

export type ModuleLike = ModuleDefinition | ClassType | ModuleInstance;

export interface ModuleInstance {
    definition: ModuleDefinition;
}

export class AppModule<C = unknown> {
    readonly definition: ModuleDefinition<C>;

    constructor(definition: ModuleDefinition<C> = {}) {
        this.definition = definition;
    }
}

export function createModule(definition: ModuleDefinition): AppModule {
    return new AppModule(definition);
}

export function createModuleClass<C = unknown>(definition: ModuleDefinition<C>) {
    return class extends AppModule<C> {
        static readonly definition = definition;

        constructor() {
            super(definition);
        }
    };
}

export function normalizeModule(moduleLike: ModuleLike): ModuleDefinition {
    if (typeof moduleLike === 'function') {
        const maybeDefinition = (moduleLike as ClassType & { definition?: ModuleDefinition }).definition;
        if (maybeDefinition) return maybeDefinition;
        const instance = new moduleLike();
        return normalizeModule(instance as ModuleInstance);
    }

    if ('definition' in moduleLike) return moduleLike.definition;
    return moduleLike;
}
