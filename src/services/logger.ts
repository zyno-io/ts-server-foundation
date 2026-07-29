import type { Provider } from '../di';
import createDebug from 'debug';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

import { isDevFeatureEnabled } from '../app/config';
import { isDevelopmentEnvironment, isTestEnvironment } from '../app/const';
import { Env } from '../env';
import { getContext, withContextData as withSharedContextData } from '../helpers/async/context';
import { DecoratedError, isError, reportError, toError } from '../helpers/utils/error';

export type LogData = Record<string, unknown>;

export enum LoggerLevel {
    none = 0,
    alert = 1,
    error = 2,
    warning = 3,
    log = 4,
    info = 5,
    debug = 6,
    debug2 = 7
}

export interface LogEntry {
    level: LoggerLevel;
    levelName: keyof typeof LoggerLevel;
    scope?: string;
    message: string;
    data?: LogData;
    error?: unknown;
    timestamp: Date;
}

export type LogSink = (entry: LogEntry) => void;

export const shouldUsePinoPretty = isDevFeatureEnabled(Env.ENABLE_PINO_PRETTY);
export const shouldUseSingleLine = isDevFeatureEnabled(Env.ENABLE_PINO_SINGLE_LINE);
export const LoggerContextProps: string[] = ['http', 'job'];
export const LoggerHttpContextProps: string[] = ['reqId', 'traceId'];
export const LoggerContextSymbol = Symbol('LoggerContext');

const PinoSeverityMap = {
    [LoggerLevel.none]: 'DEFAULT',
    [LoggerLevel.alert]: 'ALERT',
    [LoggerLevel.error]: 'ERROR',
    [LoggerLevel.warning]: 'WARNING',
    [LoggerLevel.log]: 'NOTICE',
    [LoggerLevel.info]: 'INFO',
    [LoggerLevel.debug]: 'DEBUG',
    [LoggerLevel.debug2]: 'DEBUG'
} as const;

type Severity = (typeof PinoSeverityMap)[keyof typeof PinoSeverityMap];
type SeverityLogFn = (data: LogData, message?: string) => void;
type SeverityLogger = PinoLogger & Record<Severity, SeverityLogFn>;

const InvertedPinoSeverityMap: Record<Severity, number> = {
    DEFAULT: LoggerLevel.none,
    ALERT: LoggerLevel.alert,
    ERROR: LoggerLevel.error,
    WARNING: LoggerLevel.warning,
    NOTICE: LoggerLevel.log,
    INFO: LoggerLevel.info,
    DEBUG: LoggerLevel.debug
};

const StandardSeverityAliases: Record<string, Severity> = {
    fatal: 'ALERT',
    error: 'ERROR',
    warn: 'WARNING',
    info: 'INFO',
    debug: 'DEBUG',
    trace: 'DEBUG'
};

let currentSink: LogSink = defaultLogSink;
let defaultLogger: ExtendedLogger;
let defaultPinoLogger: PinoLogger | undefined;

export class Logger {
    level = LoggerLevel.info;

    constructor(
        readonly scope = '',
        protected scopeData?: LogData,
        protected sink: LogSink = currentSink
    ) {}

    scoped(shortName: string, data?: LogData): ScopedLogger {
        const name = shortName ? (this.scope.length ? `${this.scope}:${shortName}` : shortName) : this.scope;
        const scoped = new ScopedLogger(name, mergeData(this.scopeData, data), this.sink);
        scoped.level = this.level;
        return scoped;
    }

    setScopeData(data?: LogData): this {
        this.scopeData = data;
        return this;
    }

    data(data: LogData): ScopedLogger {
        return this.scoped('', data);
    }

    is(level: LoggerLevel): boolean {
        return level <= this.level;
    }

    alert(...messages: unknown[]): void {
        this.write(LoggerLevel.alert, messages);
    }

    error(...messages: unknown[]): void {
        this.write(LoggerLevel.error, messages);
    }

    warning(...messages: unknown[]): void {
        this.write(LoggerLevel.warning, messages);
    }

    warn(...messages: unknown[]): void {
        this.warning(...messages);
    }

    log(...messages: unknown[]): void {
        this.write(LoggerLevel.log, messages);
    }

    info(...messages: unknown[]): void {
        this.write(LoggerLevel.info, messages);
    }

    debug(...messages: unknown[]): void {
        if (!createDebug(this.scope).enabled) return;
        this.write(LoggerLevel.debug, messages, true);
    }

    debug2(...messages: unknown[]): void {
        this.write(LoggerLevel.debug2, messages);
    }

    protected write(level: LoggerLevel, messages: unknown[], force = false): void {
        if (!force && level > this.level) return;
        const parsed = parseLogMessages(messages, this.scopeData);
        const message = stripColors(parsed.message);
        const error = transformLogError(parsed.error);
        const contextProps = getLoggerContextProps();
        const entryData = mergeData(parsed.data, contextProps);
        this.sink({
            level,
            levelName: getLevelName(level),
            scope: this.scope || undefined,
            message,
            data: entryData,
            error,
            timestamp: new Date()
        });

        if (error || level === LoggerLevel.alert || level === LoggerLevel.error) {
            this.handleError(level, message, error, parsed.data, contextProps);
        }
    }

    protected handleError(
        level: LoggerLevel,
        message: string | undefined,
        error: unknown,
        data: LogData | undefined,
        contextProps: LogData | undefined
    ): void {
        const resolvedError = message && message !== 'Controller error' ? new Error(message) : error ? toError(error) : new Error('Unknown error');
        if (resolvedError !== error && error !== undefined) {
            (resolvedError as DecoratedError).cause = error;
        }
        reportError(level, resolvedError, {
            data,
            scope: this.scope || undefined,
            scopeData: this.scopeData,
            ...contextProps
        });
    }
}

export class ScopedLogger extends Logger {}

export class ExtendedLogger extends ScopedLogger {}

export type LoggerInterface = Logger;

defaultLogger = new ExtendedLogger();

export const pinoLogger = new Proxy({} as PinoLogger, {
    get(_target, property) {
        const logger = getDefaultPinoLogger() as SeverityLogger;
        if (typeof property === 'string' && property in StandardSeverityAliases && !(property in logger)) {
            const value = logger[StandardSeverityAliases[property]];
            return typeof value === 'function' ? value.bind(logger) : value;
        }

        const value = Reflect.get(logger, property, logger);
        return typeof value === 'function' ? value.bind(logger) : value;
    }
});

export function createLogger(subject: string | object, defaultData?: LogData): ScopedLogger {
    const name = typeof subject === 'string' ? subject : subject.constructor.name;
    return defaultLogger.scoped(name, defaultData);
}

export async function withLoggerContext<T>(data: LogData, fn: () => Promise<T>): Promise<T> {
    const existingContext = getContext();
    const existingLoggerContext = existingContext?.[LoggerContextSymbol];
    return withSharedContextData(
        {
            [LoggerContextSymbol]: {
                ...(isLogObject(existingLoggerContext) ? existingLoggerContext : undefined),
                ...data
            }
        },
        fn
    );
}

export function projectLoggerHttpContext(context: unknown): LogData | undefined {
    if (!isLogObject(context)) return undefined;

    const entries = LoggerHttpContextProps.flatMap(prop => (Object.hasOwn(context, prop) ? [[prop, context[prop]] as [string, unknown]] : []));
    return entries.length ? Object.fromEntries(entries) : undefined;
}

export function setLogSink(sink: LogSink): void {
    currentSink = sink;
    defaultLogger = new ExtendedLogger('', undefined, sink);
}

export function resetLogSink(): void {
    currentSink = defaultLogSink;
    defaultLogger = new ExtendedLogger();
}

export function createLoggerProviders(): Provider[] {
    const logger = new ExtendedLogger('', undefined, currentSink);
    defaultLogger = logger;
    return [
        { provide: ExtendedLogger, useValue: logger },
        {
            provide: ScopedLogger,
            useTargetFactory: (target, resolvedLogger: ExtendedLogger) => (target ? resolvedLogger.scoped(target.name) : resolvedLogger),
            deps: [ExtendedLogger]
        },
        { provide: Logger, useExisting: ExtendedLogger }
    ];
}

function parseLogMessages(input: unknown[], scopeData?: LogData): { message: string; data?: LogData; error?: unknown } {
    const messages = [...input];
    let error = isError(messages[0]) ? messages.shift() : isError(messages[1]) ? messages.splice(1, 1).shift() : undefined;
    const message = typeof messages[0] === 'string' ? (messages.shift() as string) : '';
    let data: LogData | undefined;

    if (messages.length === 1 && typeof messages[0] === 'object') {
        data = Object.assign(data ?? {}, messages[0]);
    } else if (messages.length) {
        data = {};
        messages.forEach((item, index) => {
            data![`arg${index}`] = item;
        });
    } else {
        data = undefined;
    }

    if (!error && data && 'err' in data) {
        error = data.err;
        delete data.err;
    }

    if (scopeData) {
        data = Object.assign(data ?? {}, scopeData);
    }

    return { message, data, error };
}

function mergeData(...values: (LogData | undefined)[]): LogData | undefined {
    const merged = Object.assign({}, ...values.filter(Boolean));
    return Object.keys(merged).length ? merged : undefined;
}

function getLevelName(level: LoggerLevel): keyof typeof LoggerLevel {
    return (LoggerLevel[level] ?? 'info') as keyof typeof LoggerLevel;
}

function defaultLogSink(entry: LogEntry): void {
    const data = {
        ...(entry.error ? { err: entry.error } : undefined),
        ...(entry.scope ? { scope: entry.scope } : undefined),
        ...entry.data
    };

    const logger = getDefaultPinoLogger() as SeverityLogger;
    logger[PinoSeverityMap[entry.level]](data, entry.message);
}

function getDefaultPinoLogger(): PinoLogger {
    defaultPinoLogger ??= pino(
        {
            formatters: {
                level: label => ({ severity: label }),
                bindings: isDevelopmentEnvironment() ? () => ({ pid: process.pid }) : () => ({})
            },
            timestamp: pino.stdTimeFunctions.isoTime,
            messageKey: 'message',
            customLevels: InvertedPinoSeverityMap,
            useOnlyCustomLevels: true,
            level: 'DEFAULT'
        },
        createPinoPrettyStream()
    ) as unknown as PinoLogger;
    return defaultPinoLogger;
}

function createPinoPrettyStream(): DestinationStream | undefined {
    if (!shouldUsePinoPretty) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PinoPretty = require('pino-pretty') as
        | { default?: (options: Record<string, unknown>) => DestinationStream }
        | ((options: Record<string, unknown>) => DestinationStream);
    const createPrettyStream = typeof PinoPretty === 'function' ? PinoPretty : PinoPretty.default;
    if (!createPrettyStream) return undefined;

    return createPrettyStream({
        colorize: true,
        singleLine: shouldUseSingleLine,
        messageFormat: `\x1b[90m${process.pid} \x1b[35m{scope} \x1b[36m{message}`,
        ignore: 'scope',
        level: Env.LOG_LEVEL || (Env.NODE_ENV === 'production' ? 'info' : 'debug'),
        levelFirst: true,
        levelKey: 'severity',
        customLevels: Object.entries(InvertedPinoSeverityMap)
            .map(([severity, level]) => `${severity}:${level}`)
            .join(','),
        messageKey: 'message',
        customColors: 'alert:bgRed,error:red,warning:yellow,notice:green,info:blue,debug:gray,default:white',
        sync: isTestEnvironment()
    });
}

function getLoggerContextProps(): LogData | undefined {
    const context = getContext();
    if (!context) return undefined;

    const entries: [string, unknown][] = [];
    for (const prop of LoggerContextProps) {
        if (!context[prop]) continue;
        const value = prop === 'http' ? projectLoggerHttpContext(context[prop]) : context[prop];
        if (value) entries.push([prop, value]);
    }

    const loggerContext = context[LoggerContextSymbol];
    if (isLogObject(loggerContext)) {
        for (const [key, value] of Object.entries(loggerContext)) entries.push([key, value]);
    }

    return entries.length ? Object.fromEntries(entries) : undefined;
}

function stripColors(message: string): string {
    return message.includes('<') ? message.replace(/<(\/)?([a-zA-Z]+)>/g, '') : message;
}

function transformLogError(error: unknown): unknown {
    if (!isLogObject(error)) return error;
    if (Array.isArray(error.errors) && error.errors.includes(error)) return withoutSelfReferentialErrors(error);
    if (error.constructor?.name === 'DatabaseError') {
        delete error.entity;
        delete error.classSchema;
        return error;
    }
    if (error.isAxiosError === true) return transformAxiosError(error);
    return error;
}

function withoutSelfReferentialErrors(error: LogData): LogData {
    const normalized = Object.create(Object.getPrototypeOf(error), Object.getOwnPropertyDescriptors(error)) as LogData;
    delete normalized.errors;
    return normalized;
}

function transformAxiosError(error: LogData): LogData {
    const config = isLogObject(error.config) ? error.config : undefined;
    const response = isLogObject(error.response) ? error.response : undefined;
    const state = createAxiosSanitizationState();
    return {
        code: error.code,
        message: error.message,
        stack: error.stack,
        request: {
            url: sanitizeAxiosUrl(config?.url, state),
            method: config?.method,
            headers: sanitizeAxiosHeaders(config?.headers, state),
            data: sanitizeAxiosPayload(config?.data, state)
        },
        response: {
            status: response?.status,
            headers: sanitizeAxiosHeaders(response?.headers, state),
            data: sanitizeAxiosPayload(response?.data, state)
        }
    };
}

const AxiosSensitiveKey =
    /(?:authorization|cookie|token|secret|password|passwd|passcode|api[-_]?key|credential|private[-_]?key|client[-_]?secret|signature|(?:^|[-_])sig(?:$|[-_])|jwt|(?:^|[-_])pin(?:$|[-_])|ssn|social[-_]?security|e-?mail|card(?:[-_]?number)?|cc[-_]?number|cvv|cvc|phone|address|date[-_]?of[-_]?birth|dob)/i;
const AxiosSensitiveUrlParameter =
    /(?:code|authorization|cookie|token|secret|password|passcode|api[-_]?key|credential|private[-_]?key|client[-_]?secret|signature|(?:^|[-_])sig(?:$|[-_])|jwt|(?:^|[-_])pin(?:$|[-_])|ssn|social[-_]?security|e-?mail|card(?:[-_]?number)?|cc[-_]?number|cvv|cvc|phone|address|date[-_]?of[-_]?birth|dob)/i;
const AxiosSafeHeader =
    /^(?:x[-_]?)?(?:request|correlation)[-_]?id$|^(?:traceparent|tracestate|b3|x-b3-[a-z-]+|x-amzn-(?:requestid|trace-id)|(?:x-)?intuit[-_]?tid)$/i;
const AxiosRedacted = '[REDACTED]';
const AxiosMaxDepth = 5;
const AxiosMaxProperties = 50;
const AxiosMaxArrayItems = 50;
const AxiosMaxQueryParameters = 50;
const AxiosMaxStringLength = 4_096;
const AxiosMaxNodes = 200;
const AxiosMaxOutputLength = 32_768;
const AxiosJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const AxiosEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const AxiosCardNumber = /(?:\d[ -]?){13,19}/;

interface AxiosSanitizationState {
    seen: WeakSet<object>;
    nodes: number;
    outputLength: number;
}

/**
 * Axios errors commonly contain complete request configs. Normalize them into a
 * useful but safe diagnostic shape; never mutate the error/config owned by Axios.
 */
function createAxiosSanitizationState(): AxiosSanitizationState {
    return { seen: new WeakSet<object>(), nodes: 0, outputLength: 0 };
}

function sanitizeAxiosHeaders(headers: unknown, state: AxiosSanitizationState): LogData | undefined {
    const source = toAxiosHeadersObject(headers);
    if (!source) return undefined;

    const safeHeaders: LogData = {};
    for (const name in source) {
        if (!Object.hasOwn(source, name)) continue;
        if (!AxiosSafeHeader.test(name)) continue;
        if (!consumeAxiosNode(state) || !consumeAxiosOutput(state, name.length)) break;
        safeHeaders[name] = sanitizeAxiosHeaderValue(source[name], state);
    }
    return Object.keys(safeHeaders).length ? safeHeaders : undefined;
}

function sanitizeAxiosHeaderValue(value: unknown, state: AxiosSanitizationState): unknown {
    if (typeof value === 'string') return sanitizeAxiosScalarString(value, state);
    if (Array.isArray(value))
        return value
            .slice(0, AxiosMaxArrayItems)
            .map(item => (typeof item === 'string' ? sanitizeAxiosScalarString(item, state) : '[non-scalar header]'));
    return value === undefined ? undefined : '[non-scalar header]';
}

function sanitizeAxiosUrl(value: unknown, state: AxiosSanitizationState): unknown {
    if (typeof value !== 'string') return value === undefined ? undefined : '[invalid URL]';
    if (value.length > AxiosMaxOutputLength) return `[TRUNCATED URL: ${value.length} chars]`;

    try {
        const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(value);
        const url = new URL(value, 'http://axios.invalid');
        url.username = '';
        url.password = '';
        url.search = sanitizeAxiosQuery(url.search.slice(1));
        // URL fragments are not sent in an HTTP request and commonly carry OAuth credentials.
        url.hash = '';
        return sanitizeAxiosScalarString(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, state);
    } catch {
        const [path, queryAndHash = ''] = value.split('?', 2);
        if (!queryAndHash) return sanitizeAxiosScalarString(path.split('#', 1)[0], state);
        const [query] = queryAndHash.split('#', 1);
        return sanitizeAxiosScalarString(`${path}?${sanitizeAxiosQuery(query)}`, state);
    }
}

function sanitizeAxiosQuery(query: string): string {
    const parts: string[] = [];
    let start = 0;
    for (let count = 0; start <= query.length && count < AxiosMaxQueryParameters; count++) {
        const end = query.indexOf('&', start);
        const part = query.slice(start, end === -1 ? undefined : end);
        const separator = part.indexOf('=');
        const key = separator === -1 ? part : part.slice(0, separator);
        let decodedKey = key;
        try {
            decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
        } catch {
            // Preserve malformed query strings as-is unless their raw key is sensitive.
        }
        parts.push(AxiosSensitiveUrlParameter.test(decodedKey) ? `${key}=${AxiosRedacted}` : part);
        if (end === -1) return parts.join('&');
        start = end + 1;
    }
    return `${parts.join('&')}&[TRUNCATED]`;
}

function sanitizeAxiosPayload(value: unknown, state: AxiosSanitizationState): unknown {
    return sanitizeAxiosValue(value, 0, state);
}

function sanitizeAxiosValue(value: unknown, depth: number, state: AxiosSanitizationState): unknown {
    if (!consumeAxiosNode(state)) return '[TRUNCATED: output limit]';
    if (typeof value === 'string') return sanitizeAxiosString(value, depth, state);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= AxiosMaxDepth) return '[TRUNCATED: maximum depth]';
    if (state.seen.has(value)) return '[CIRCULAR]';
    state.seen.add(value);
    if (isOpaqueAxiosPayload(value)) return `[${value.constructor?.name ?? 'opaque payload'}]`;

    if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (let index = 0; index < Math.min(value.length, AxiosMaxArrayItems); index++)
            items.push(sanitizeAxiosValue(value[index], depth + 1, state));
        if (value.length > AxiosMaxArrayItems) items.push(`[TRUNCATED: ${value.length - AxiosMaxArrayItems} items]`);
        return items;
    }

    const source = isLogObject(value) ? value : undefined;
    if (!source) return `[${value.constructor?.name ?? 'object'}]`;
    const result: LogData = {};
    let propertyCount = 0;
    for (const key in source) {
        if (!Object.hasOwn(source, key)) continue;
        if (propertyCount++ >= AxiosMaxProperties || !consumeAxiosOutput(state, key.length)) {
            result._truncated = 'additional properties';
            break;
        }
        result[key] = AxiosSensitiveKey.test(key) ? AxiosRedacted : sanitizeAxiosValue(source[key], depth + 1, state);
    }
    return result;
}

function sanitizeAxiosString(value: string, depth: number, state: AxiosSanitizationState): unknown {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        if (value.length > AxiosMaxOutputLength) return `[TRUNCATED JSON body: ${value.length} chars]`;
        try {
            return sanitizeAxiosValue(JSON.parse(value), depth + 1, state);
        } catch {
            return '[UNPARSEABLE JSON body]';
        }
    }
    if (value.includes('=') && !/[\r\n]/.test(value)) return sanitizeAxiosScalarString(sanitizeAxiosQuery(value), state);
    return sanitizeAxiosScalarString(value, state);
}

function sanitizeAxiosScalarString(value: string, state: AxiosSanitizationState): string {
    if (AxiosJwt.test(value) || AxiosEmail.test(value) || AxiosCardNumber.test(value)) return AxiosRedacted;
    const remaining = AxiosMaxOutputLength - state.outputLength;
    if (remaining <= 0) return '[TRUNCATED: output limit]';
    const length = Math.min(value.length, AxiosMaxStringLength, remaining);
    state.outputLength += length;
    return length === value.length ? value : `${value.slice(0, length)}[TRUNCATED]`;
}

function consumeAxiosNode(state: AxiosSanitizationState): boolean {
    return ++state.nodes <= AxiosMaxNodes;
}

function consumeAxiosOutput(state: AxiosSanitizationState, length: number): boolean {
    if (state.outputLength + length > AxiosMaxOutputLength) return false;
    state.outputLength += length;
    return true;
}

function isOpaqueAxiosPayload(value: object): boolean {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
    return /(?:formdata|stream|readable|writable|duplex|blob|file)/i.test(value.constructor?.name ?? '');
}

function toAxiosHeadersObject(value: unknown): LogData | undefined {
    if (!value || typeof value !== 'object') return undefined;
    if (isOpaqueAxiosPayload(value)) return undefined;
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
        try {
            const json = (value as { toJSON: () => unknown }).toJSON();
            return isLogObject(json) ? json : undefined;
        } catch {
            return undefined;
        }
    }
    return isLogObject(value) ? value : undefined;
}

function isLogObject(value: unknown): value is LogData {
    return !!value && typeof value === 'object';
}
