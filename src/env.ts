export interface EnvObject {
    APP_ENV?: string;
    NODE_ENV?: string;
    NODE_TEST_CONTEXT?: string;
    TZ?: string;

    DEVCONSOLE_ENABLED?: string;
    PORT?: string;
    DB_ADAPTER?: string;

    MYSQL_HOST?: string;
    MYSQL_PORT?: string;
    MYSQL_USER?: string;
    MYSQL_PASSWORD_SECRET?: string;
    MYSQL_DATABASE?: string;
    MYSQL_CONNECTION_LIMIT?: string;
    MYSQL_MIN_IDLE_CONNECTIONS?: string;
    MYSQL_IDLE_TIMEOUT_SECONDS?: string;

    PG_HOST?: string;
    PG_PORT?: string;
    PG_USER?: string;
    PG_PASSWORD_SECRET?: string;
    PG_DATABASE?: string;
    PG_SCHEMA?: string;
    PG_SSL?: string;
    PG_SSL_REJECT_UNAUTHORIZED?: string;
    PG_CONNECTION_LIMIT?: string;
    PG_IDLE_TIMEOUT_SECONDS?: string;

    AUTH_JWT_ISSUER?: string;
    AUTH_JWT_EXPIRATION_MINS?: string;
    AUTH_JWT_COOKIE_NAME?: string;
    AUTH_JWT_SECRET?: string;
    AUTH_JWT_SECRET_B64?: string;
    AUTH_JWT_ED_SECRET?: string;
    AUTH_JWT_ENABLE_VERIFY?: string;
    AUTH_BASIC_SECRET?: string;

    CRYPTO_SECRET?: string;
    CRYPTO_IV_LENGTH?: string;

    USE_REAL_IP_HEADER?: string;

    REDIS_SENTINEL_HOST?: string;
    REDIS_SENTINEL_PORT?: string;
    REDIS_SENTINEL_NAME?: string;
    REDIS_HOST?: string;
    REDIS_PORT?: string;
    REDIS_PREFIX?: string;

    CACHE_REDIS_SENTINEL_HOST?: string;
    CACHE_REDIS_SENTINEL_PORT?: string;
    CACHE_REDIS_SENTINEL_NAME?: string;
    CACHE_REDIS_HOST?: string;
    CACHE_REDIS_PORT?: string;
    CACHE_REDIS_PREFIX?: string;

    MUTEX_REDIS_SENTINEL_HOST?: string;
    MUTEX_REDIS_SENTINEL_PORT?: string;
    MUTEX_REDIS_SENTINEL_NAME?: string;
    MUTEX_REDIS_HOST?: string;
    MUTEX_REDIS_PORT?: string;
    MUTEX_REDIS_PREFIX?: string;

    BROADCAST_REDIS_SENTINEL_HOST?: string;
    BROADCAST_REDIS_SENTINEL_PORT?: string;
    BROADCAST_REDIS_SENTINEL_NAME?: string;
    BROADCAST_REDIS_HOST?: string;
    BROADCAST_REDIS_PORT?: string;
    BROADCAST_REDIS_PREFIX?: string;

    MESH_REDIS_SENTINEL_HOST?: string;
    MESH_REDIS_SENTINEL_PORT?: string;
    MESH_REDIS_SENTINEL_NAME?: string;
    MESH_REDIS_HOST?: string;
    MESH_REDIS_PORT?: string;
    MESH_REDIS_PREFIX?: string;

    BULL_REDIS_SENTINEL_HOST?: string;
    BULL_REDIS_SENTINEL_PORT?: string;
    BULL_REDIS_SENTINEL_NAME?: string;
    BULL_REDIS_HOST?: string;
    BULL_REDIS_PORT?: string;
    BULL_REDIS_PREFIX?: string;

    BULL_QUEUE?: string;
    MUTEX_MODE?: string;

    ENABLE_OPENAPI_SCHEMA?: string;
    ENABLE_OPENAPI_ROUTE?: string;
    ENABLE_JOB_RUNNER?: string;

    SENTRY_DSN?: string;
    OTEL_SDK_DISABLED?: string;
    OTEL_DEBUG?: string;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
    OTEL_METRICS_ENDPOINT_ENABLED?: string;

    ALERTS_SLACK_WEBHOOK_URL?: string;

    SRPC_AUTH_SECRET?: string;
    SRPC_AUTH_CLOCK_DRIFT_MS?: string;

    HTTP_REQUEST_LOGGING_MODE?: string;
    HEALTHZ_ENABLE_REQUEST_LOGGING?: string;
    ENABLE_PINO_PRETTY?: string;
    ENABLE_PINO_SINGLE_LINE?: string;
    LOG_LEVEL?: string;

    MAIL_FROM?: string;
    MAIL_FROM_NAME?: string;
    MAIL_PROVIDER?: string;
    SMTP_HOST?: string;
    SMTP_PORT?: string;
    SMTP_USER?: string;
    SMTP_PASSWORD_SECRET?: string;
    SMTP_TLS?: string;
    POSTMARK_SECRET?: string;

    PROTOC?: string;
    TEST_KEEP_DB?: string;
    TEST_RUN_TS?: string;
    TSF_TEST_DATABASE_NAME?: string;
    TSF_TEST_ALLOW_SAVEPOINTS?: string;
    TSF_TEST_MYSQL_SESSION_MANAGER?: string;
    TSF_TEST_MYSQL_SESSION_POOL_SIZE?: string;
    TSF_TEST_MYSQL_SESSION_MANAGER_PORT?: string;
    TSF_TEST_MYSQL_SESSION_MANAGER_TOKEN?: string;
    TSF_TEST_MYSQL_SESSION_KEY?: string;
    TSF_TEST_MYSQL_SESSION_LEASE_ID?: string;
    TSF_TEST_MYSQL_SESSION_DATABASE?: string;
    TSF_TEST_MYSQL_SESSION_TRACE_SQL?: string;

    [key: string]: string | undefined;
}

const initialEnv = { ...process.env } as EnvObject;

export const Env = new Proxy(initialEnv, {
    get(_target, property) {
        if (typeof property === 'string') return process.env[property];
        return Reflect.get(process.env, property);
    },
    set(_target, property, value) {
        if (typeof property !== 'string') return false;
        if (value === undefined) delete process.env[property];
        else process.env[property] = String(value);
        return true;
    },
    deleteProperty(_target, property) {
        if (typeof property !== 'string') return false;
        delete process.env[property];
        return true;
    },
    has(_target, property) {
        return typeof property === 'string' && property in process.env;
    },
    ownKeys() {
        return Reflect.ownKeys(process.env);
    },
    getOwnPropertyDescriptor(_target, property) {
        if (typeof property !== 'string' || !(property in process.env)) return undefined;
        return {
            configurable: true,
            enumerable: true,
            value: process.env[property],
            writable: true
        };
    }
}) as EnvObject;

export function envSnapshot(): EnvObject {
    return { ...Env };
}

export function applyEnv(env: EnvObject): void {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) process.env[key] = value;
    }
}

export function toProcessEnv(env: EnvObject = Env): NodeJS.ProcessEnv {
    return { ...env };
}
