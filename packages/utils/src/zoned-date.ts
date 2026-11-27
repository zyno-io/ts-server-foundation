const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `YYYY-MM-DD HH:MM[:SS]` (or with `T`) and no offset: a local wall-clock time. */
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const SEARCH_WINDOW_S = 30 * 60 * 60;
const MAX_CACHED_FORMATTERS = 500;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** True for a `YYYY-MM-DD` calendar date with no time part. */
export function isDateOnly(value: string): boolean {
    return DATE_ONLY_RE.test(value);
}

/** Returns `value` when it is a usable IANA zone name, otherwise null. */
export function validTimeZone(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length > 64) return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
        return trimmed;
    } catch {
        return null;
    }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
    let format = formatters.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            era: 'short',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hourCycle: 'h23'
        });
        if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear();
        formatters.set(timeZone, format);
    }
    return format;
}

function dateTimeKey(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
    return (year * 10000 + month * 100 + day) * 1_000_000 + hour * 10000 + minute * 100 + second;
}

/** Local wall-clock time of `instantMs` in `timeZone`: a sortable `YYYYMMDDhhmmss` key and the zone offset in ms. */
function localTime(instantMs: number, timeZone: string): { key: number; offsetMs: number } {
    const parts = formatter(timeZone).formatToParts(new Date(instantMs));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)!.value);
    const era = parts.find(part => part.type === 'era')?.value;
    const year = era === 'BC' ? 1 - get('year') : get('year');
    const local = utcMidnight(year, get('month'), get('day'));
    local.setUTCHours(get('hour'), get('minute'), get('second'));
    return {
        key: dateTimeKey(year, get('month'), get('day'), get('hour'), get('minute'), get('second')),
        offsetMs: local.getTime() - Math.floor(instantMs / 1000) * 1000
    };
}

function localDateTimeKey(instantMs: number, timeZone: string): number {
    return localTime(instantMs, timeZone).key;
}

/** UTC midnight of a calendar date, without `Date.UTC`'s 0-99 => 1900s year mapping. */
function utcMidnight(year: number, month: number, day: number): Date {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date;
}

function parseDateOnly(date: string): { year: number; month: number; day: number } | null {
    const match = DATE_ONLY_RE.exec(date);
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const check = utcMidnight(year, month, day);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { year, month, day };
}

/**
 * The first instant whose local wall-clock time is the target. A time repeated by a fall-back resolves to its
 * first occurrence; a time skipped by a spring-forward resolves to the end of the gap. Works at any time of day,
 * including midnight, and for any transition size.
 */
function firstLocalInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
    const target = dateTimeKey(year, month, day, hour, minute, second);
    const wall = utcMidnight(year, month, day);
    wall.setUTCHours(hour, minute, second);
    const wallMs = wall.getTime();

    // Every offset that can apply is in effect somewhere within ±30h of the wall time. Each yields a candidate
    // instant; those that really show the target locally are its occurrences, and the earliest is the first.
    const offsets = new Set<number>();
    for (let step = -5; step <= 5; step++) offsets.add(localTime(wallMs + step * 6 * 3600 * 1000, timeZone).offsetMs);
    let earliest: number | null = null;
    for (const offsetMs of offsets) {
        const candidate = wallMs - offsetMs;
        if (localDateTimeKey(candidate, timeZone) === target && (earliest === null || candidate < earliest)) earliest = candidate;
    }
    if (earliest !== null) return new Date(earliest);

    // The target was skipped. Local time only jumps forward across a gap, so the first second at or past the
    // target is the end of the gap.
    const wallS = wallMs / 1000;
    let low = wallS - SEARCH_WINDOW_S;
    let high = wallS + SEARCH_WINDOW_S;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (localDateTimeKey(mid * 1000, timeZone) >= target) high = mid;
        else low = mid + 1;
    }
    return new Date(low * 1000);
}

function startOfLocalDay(year: number, month: number, day: number, timeZone: string): Date {
    return firstLocalInstant(year, month, day, 0, 0, 0, timeZone);
}

/** The first instant of local calendar day `YYYY-MM-DD` in `timeZone`, or null for a malformed or impossible date. */
export function startOfZonedDay(date: string, timeZone: string): Date | null {
    const parsed = parseDateOnly(date);
    return parsed ? startOfLocalDay(parsed.year, parsed.month, parsed.day, timeZone) : null;
}

/** `[start, end)` instants of local calendar day `YYYY-MM-DD` in `timeZone`, or null for a malformed date. */
export function zonedDayRange(date: string, timeZone: string): { start: Date; end: Date } | null {
    const parsed = parseDateOnly(date);
    if (!parsed) return null;
    const next = utcMidnight(parsed.year, parsed.month, parsed.day + 1);
    return {
        start: startOfLocalDay(parsed.year, parsed.month, parsed.day, timeZone),
        end: startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone)
    };
}

/** Today's calendar year in `timeZone`. */
export function currentZonedYear(timeZone: string, now = Date.now()): number {
    return Math.floor(localDateTimeKey(now, timeZone) / 10_000_000_000);
}

/** The instant of local wall-clock time `YYYY-MM-DD[T ]HH:MM[:SS]` (no offset) in `timeZone`, or null. */
export function zonedDateTime(value: string, timeZone: string): Date | null {
    const match = LOCAL_DATE_TIME_RE.exec(value);
    if (!match) return null;
    const date = parseDateOnly(`${match[1]}-${match[2]}-${match[3]}`);
    const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
    if (!date || hour > 23 || minute > 59 || second > 59) return null;
    return firstLocalInstant(date.year, date.month, date.day, hour, minute, second, timeZone);
}

/**
 * Parses a search bound. A date-only `YYYY-MM-DD` is local midnight in `timeZone`, and a date and time without
 * an offset is that local wall-clock time. Returns `zoned: false` for any other value, parsed with `new Date`
 * (so a `Z` or `±HH:MM` offset is honoured as given).
 */
export function parseZonedDateBound(value: string, timeZone: string): { date: Date; zoned: boolean } {
    const zoned = startOfZonedDay(value, timeZone) ?? zonedDateTime(value, timeZone);
    return zoned ? { date: zoned, zoned: true } : { date: new Date(value), zoned: false };
}
