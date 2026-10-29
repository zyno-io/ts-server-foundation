import { getAppConfig } from '../../app/resolver';
import { Env } from '../../env';
import { getPackageName } from '../io/package';

export function getRedisPrefix(configPrefix?: string): string {
    const config = getAppConfig();
    const utilityPrefix = configPrefix ? config[`${configPrefix}_REDIS_PREFIX` as keyof typeof config] : undefined;
    const configuredPrefix = String(utilityPrefix ?? config.REDIS_PREFIX ?? getPackageName() ?? 'app');
    const namespace = Env.TSF_TEST_REDIS_NAMESPACE;
    return namespace ? `${configuredPrefix}:test:${namespace}` : configuredPrefix;
}
