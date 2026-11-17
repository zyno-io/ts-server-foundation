import createDebug from 'debug';

const debug = createDebug('tsf:mysql:recovery');
// Cover two HAProxy health checks, while trying healthy PXC members quickly.
const RETRY_DELAYS_MS = [100, 200, 300, 400, ...Array<number>(40).fill(500)];
const RETRY_BUDGET_MS = 21_000;

export function isWsrepNotReady(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { message?: unknown; sqlMessage?: unknown };
    return [candidate.sqlMessage, candidate.message].some(
        message => typeof message === 'string' && /\bwsrep\b.*\b(?:has not yet prepared|not ready)\b.*\b(?:node|application use)\b/i.test(message)
    );
}

export function isTransientMySQLConnectionError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown; message?: unknown; sqlMessage?: unknown };
    if (
        [
            'ECONNREFUSED',
            'ECONNRESET',
            'ETIMEDOUT',
            'EHOSTUNREACH',
            'ENETUNREACH',
            'EPIPE',
            'PROTOCOL_CONNECTION_LOST',
            'ER_SERVER_SHUTDOWN'
        ].includes(String(candidate.code))
    )
        return true;
    return [candidate.message, candidate.sqlMessage].some(
        message =>
            typeof message === 'string' &&
            /^(?:Connection lost(?:\b|:)|The server closed the connection\b|Can't add new command when connection is in closed state)/i.test(message)
    );
}

export function isRetryableMySQLAcquisitionError(error: unknown): boolean {
    return isWsrepNotReady(error) || isTransientMySQLConnectionError(error);
}

export async function retryMySQL<T>(operation: () => Promise<T>, isRetryable: (error: unknown) => boolean): Promise<T> {
    const deadline = Date.now() + RETRY_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            const result = await operation();
            if (attempt) debug('Recovered after %d retries', attempt);
            return result;
        } catch (error) {
            const delay = RETRY_DELAYS_MS[attempt];
            if (delay === undefined || !isRetryable(error) || Date.now() + delay > deadline) throw error;
            // Do not send intermediate failures (or SQL/bindings) to error reporting.
            debug('Retrying transient MySQL failure in %dms (attempt %d)', delay, attempt + 1);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// A WSREP error for a batch can follow an earlier successful statement.
// Reject ambiguous batches/comments instead of replaying their partial effects.
export function isSingleMySQLStatement(sql: string): boolean {
    const text = sql.trim().replace(/;$/, '');
    return !/[;]|\/\*|--|#/.test(text);
}

// A query API can execute arbitrary SQL. Restrict lost-response replay to a
// single plain SELECT with known read-only builtins. Unknown/stored functions,
// locks, variables, executable comments and session state require caller policy.
const READ_FUNCTIONS = new Set([
    'ABS',
    'AVG',
    'CAST',
    'CEIL',
    'CEILING',
    'COALESCE',
    'CONCAT',
    'CONCAT_WS',
    'CONVERT',
    'COUNT',
    'DATE',
    'DATEDIFF',
    'DATE_ADD',
    'DATE_FORMAT',
    'DATE_SUB',
    'DAY',
    'FLOOR',
    'GREATEST',
    'IF',
    'IFNULL',
    'JSON_ARRAY',
    'JSON_CONTAINS',
    'JSON_EXTRACT',
    'JSON_LENGTH',
    'JSON_OBJECT',
    'JSON_UNQUOTE',
    'LEAST',
    'LENGTH',
    'LOWER',
    'MAX',
    'MIN',
    'MONTH',
    'NOW',
    'NULLIF',
    'REPLACE',
    'ROUND',
    'SUBSTR',
    'SUBSTRING',
    'SUM',
    'TRIM',
    'UNIX_TIMESTAMP',
    'UPPER',
    'UTC_TIMESTAMP',
    'YEAR',
    // SQL grammar followed by parentheses, rather than function calls.
    'IN',
    'EXISTS',
    'NOT',
    'AND',
    'OR',
    'FROM',
    'WHERE',
    'ON',
    'AS',
    'SELECT'
]);

export function isReplayableMySQLRead(sql: string): boolean {
    // Reject quoting/escape mode ambiguity and comments rather than attempting
    // to parse server-specific SQL modes. Bound values remain safe placeholders.
    if (/["'\\]|\/\*|--|#/.test(sql)) return false;
    const text = sql
        .replace(/`(?:``|[^`])*`/g, ' identifier ')
        .trim()
        .replace(/;$/, '');
    if (!/^SELECT\b/i.test(text) || /[;@`]|\b(?:INTO|FOR|LOCK|PROCEDURE|SQL_CALC_FOUND_ROWS)\b/i.test(text)) return false;
    for (const match of text.matchAll(/([\w$.]+)\s*\(/g)) {
        if (!READ_FUNCTIONS.has(match[1].toUpperCase())) return false;
    }
    return true;
}
