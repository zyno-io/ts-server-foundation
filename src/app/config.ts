import { DEFAULT_AVAILABILITY_ALERT_AFTER_MS } from '../helpers/availability';
import { isDevelopmentEnvironment, isTestEnvironment } from './const';

export class BaseAppConfig {
    APP_ENV!: string;
    DEVCONSOLE_ENABLED?: boolean;
    PORT?: number;
    DB_ADAPTER?: 'mysql' | 'postgres';

    MYSQL_HOST?: string;
    MYSQL_PORT?: number;
    MYSQL_USER?: string;
    MYSQL_PASSWORD_SECRET?: string;
    MYSQL_DATABASE?: string;
    MYSQL_CONNECTION_LIMIT?: number;
    MYSQL_MIN_IDLE_CONNECTIONS?: number;
    MYSQL_IDLE_TIMEOUT_SECONDS?: number;

    PG_HOST?: string;
    PG_PORT?: number;
    PG_USER?: string;
    PG_PASSWORD_SECRET?: string;
    PG_DATABASE?: string;
    PG_SCHEMA?: string;
    PG_SSL?: boolean;
    PG_SSL_REJECT_UNAUTHORIZED?: boolean;
    PG_CONNECTION_LIMIT?: number;
    PG_IDLE_TIMEOUT_SECONDS?: number;

    AUTH_JWT_ISSUER?: string;
    AUTH_JWT_EXPIRATION_MINS?: number;
    AUTH_JWT_COOKIE_NAME?: string;
    AUTH_JWT_SECRET?: string;
    AUTH_JWT_SECRET_B64?: string;
    AUTH_JWT_ED_SECRET?: string;
    AUTH_JWT_ENABLE_VERIFY: boolean = true;

    AUTH_BASIC_SECRET?: string;

    CRYPTO_SECRET?: string;
    CRYPTO_IV_LENGTH: number = 12;

    USE_REAL_IP_HEADER?: boolean;

    REDIS_SENTINEL_HOST?: string;
    REDIS_SENTINEL_PORT?: number;
    REDIS_SENTINEL_NAME?: string;
    REDIS_HOST?: string;
    REDIS_PORT?: number;
    REDIS_PREFIX?: string;
    REDIS_UNAVAILABLE_ALERT_AFTER_MS: number = DEFAULT_AVAILABILITY_ALERT_AFTER_MS;

    CACHE_REDIS_SENTINEL_HOST?: string;
    CACHE_REDIS_SENTINEL_PORT?: number;
    CACHE_REDIS_SENTINEL_NAME?: string;
    CACHE_REDIS_HOST?: string;
    CACHE_REDIS_PORT?: number;
    CACHE_REDIS_PREFIX?: string;

    MUTEX_REDIS_SENTINEL_HOST?: string;
    MUTEX_REDIS_SENTINEL_PORT?: number;
    MUTEX_REDIS_SENTINEL_NAME?: string;
    MUTEX_REDIS_HOST?: string;
    MUTEX_REDIS_PORT?: number;
    MUTEX_REDIS_PREFIX?: string;

    BROADCAST_REDIS_SENTINEL_HOST?: string;
    BROADCAST_REDIS_SENTINEL_PORT?: number;
    BROADCAST_REDIS_SENTINEL_NAME?: string;
    BROADCAST_REDIS_HOST?: string;
    BROADCAST_REDIS_PORT?: number;
    BROADCAST_REDIS_PREFIX?: string;

    MESH_REDIS_SENTINEL_HOST?: string;
    MESH_REDIS_SENTINEL_PORT?: number;
    MESH_REDIS_SENTINEL_NAME?: string;
    MESH_REDIS_HOST?: string;
    MESH_REDIS_PORT?: number;
    MESH_REDIS_PREFIX?: string;

    BULL_REDIS_SENTINEL_HOST?: string;
    BULL_REDIS_SENTINEL_PORT?: number;
    BULL_REDIS_SENTINEL_NAME?: string;
    BULL_REDIS_HOST?: string;
    BULL_REDIS_PORT?: number;
    BULL_REDIS_PREFIX?: string;

    BULL_QUEUE: string = 'default';
    MUTEX_MODE: 'local' | 'redis' = 'local';

    ENABLE_OPENAPI_SCHEMA?: boolean;
    ENABLE_OPENAPI_ROUTE?: boolean;
    ENABLE_JOB_RUNNER?: boolean;

    SENTRY_DSN?: string;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    ALERTS_SLACK_WEBHOOK_URL?: string;

    SRPC_AUTH_SECRET?: string;
    SRPC_AUTH_CLOCK_DRIFT_MS = 30_000;

    HTTP_REQUEST_LOGGING_MODE: 'none' | 'e2e' | 'finish' | 'errors' = isTestEnvironment() ? 'errors' : 'e2e';
    HEALTHZ_ENABLE_REQUEST_LOGGING: boolean = false;
    HTTP_MAX_REQUEST_BODY_BYTES: number = 100 * 1024 * 1024;
    HTTP_MAX_REQUEST_COMPRESSED_BODY_BYTES: number = 25 * 1024 * 1024;

    MAIL_FROM?: string;
    MAIL_FROM_NAME?: string;
    MAIL_PROVIDER: 'smtp' | 'postmark' = 'smtp';
    SMTP_HOST: string = '127.0.0.1';
    SMTP_PORT: number = 1025;
    SMTP_USER?: string;
    SMTP_PASSWORD_SECRET?: string;
    SMTP_TLS: boolean = false;
    POSTMARK_SECRET?: string;
}

export function isDevFeatureEnabled(envVar: boolean | string | undefined, defaultInDev: boolean = true): boolean {
    if (typeof envVar === 'boolean') return envVar;
    if (envVar === '0' || envVar === 'false') return false;
    if (envVar === '1' || envVar === 'true') return true;
    return isDevelopmentEnvironment() || isTestEnvironment() ? defaultInDev : false;
}
