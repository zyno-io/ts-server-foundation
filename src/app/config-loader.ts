import { ReflectionClass, ReflectionKind, Type, validate } from '../reflection';
import { loadConfig } from '@zyno-io/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Env } from '../env';
import type { ClassType } from '../types';
import { isTestEnvironment } from './const';

export class ConfigLoader<C extends object> {
    constructor(
        private configClass: ClassType<C>,
        private defaultConfig?: Partial<C>
    ) {}

    load(): C {
        if (!Env.APP_ENV) {
            if (isTestEnvironment()) {
                Env.APP_ENV = 'test';
            } else if (Env.NODE_ENV !== 'production') {
                Env.APP_ENV = 'development';
            } else {
                throw new Error('APP_ENV must be specified in the environment');
            }
        }

        const config = new this.configClass();
        if (this.defaultConfig) Object.assign(config, this.defaultConfig);

        const loaded = this.loadConfigObject();
        const reflection = ReflectionClass.from(this.configClass);

        for (const prop of reflection.getProperties()) {
            const key = String(prop.name);
            if (key in loaded) {
                (config as Record<string, unknown>)[key] = coerceConfigValue(loaded[key], prop.getType());
            }
        }

        const errors = validate(config, this.configClass);
        if (errors.length) {
            throw new Error(`Invalid configuration: ${errors.map(e => `${e.path}: ${e.message}`).join(', ')}`);
        }

        return config;
    }

    loadConfigObject(): Record<string, string> {
        const cwd = process.cwd();
        const configFiles = [
            '.env',
            '.env.local',
            ...(isTestEnvironment() ? ['.env.development', '.env.development.local'] : []),
            `.env.${Env.APP_ENV}`,
            `.env.${Env.APP_ENV}.local`
        ];

        const paths: string[] = [];
        for (const file of configFiles) {
            const path = resolve(cwd, file);
            if (existsSync(path)) paths.push(path);
        }

        return loadConfig({
            file: paths
        });
    }
}

function coerceConfigValue(value: string, type: Type): unknown {
    const concrete = unwrapOptional(type);
    if (concrete.kind === ReflectionKind.number) return Number(value);
    if (concrete.kind === ReflectionKind.boolean) return value === '1' || value === 'true';
    if (concrete.kind === ReflectionKind.literal) {
        if (typeof concrete.literal === 'number') return Number(value);
        if (typeof concrete.literal === 'boolean') return value === '1' || value === 'true';
    }
    return value;
}

function unwrapOptional(type: Type): Type {
    if (type.kind !== ReflectionKind.union) return type;
    const concrete = type.types.find(t => t.kind !== ReflectionKind.undefined && t.kind !== ReflectionKind.null);
    return concrete ?? type;
}
