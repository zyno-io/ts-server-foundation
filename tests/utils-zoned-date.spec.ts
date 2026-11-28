import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { currentZonedYear, isDateOnly, parseZonedDateBound, startOfZonedDay, validTimeZone, zonedDateTime, zonedDayRange } from '@zyno-io/ts-utils';

const iso = (date: Date | null | undefined) => date?.toISOString();

describe('startOfZonedDay', () => {
    it('returns local midnight using the offset in effect at that midnight', () => {
        assert.equal(iso(startOfZonedDay('2026-01-15', 'America/New_York')), '2026-01-15T05:00:00.000Z');
        assert.equal(iso(startOfZonedDay('2026-07-15', 'America/New_York')), '2026-07-15T04:00:00.000Z');
        assert.equal(iso(startOfZonedDay('2026-07-15', 'Asia/Kolkata')), '2026-07-14T18:30:00.000Z');
        assert.equal(iso(startOfZonedDay('2026-07-15', 'UTC')), '2026-07-15T00:00:00.000Z');
    });

    it('handles the days on either side of US DST changes', () => {
        // Spring forward happens at 02:00 on 2026-03-08, so that day's midnight is still EST.
        assert.equal(iso(startOfZonedDay('2026-03-08', 'America/New_York')), '2026-03-08T05:00:00.000Z');
        assert.equal(iso(startOfZonedDay('2026-03-09', 'America/New_York')), '2026-03-09T04:00:00.000Z');
        assert.equal(iso(startOfZonedDay('2026-11-01', 'America/New_York')), '2026-11-01T04:00:00.000Z');
        assert.equal(iso(startOfZonedDay('2026-11-02', 'America/New_York')), '2026-11-02T05:00:00.000Z');
    });

    it('starts a day whose midnight is skipped at the DST transition', () => {
        // Chile springs forward from 00:00 to 01:00 on 2026-09-06; the day starts at 01:00 -03 = 04:00Z.
        assert.equal(iso(startOfZonedDay('2026-09-06', 'America/Santiago')), '2026-09-06T04:00:00.000Z');
    });

    it('starts at the first midnight when a fall-back repeats midnight east of UTC', () => {
        // Amman fell back from 01:00 +03 to 00:00 +02 on 2021-10-29, so that local day starts at 00:00 +03.
        assert.equal(iso(startOfZonedDay('2021-10-29', 'Asia/Amman')), '2021-10-28T21:00:00.000Z');
        assert.equal(iso(zonedDayRange('2021-10-28', 'Asia/Amman')?.end), '2021-10-28T21:00:00.000Z');
    });

    it('handles a gap that straddles midnight', () => {
        // Toronto jumped from 23:30 to 00:30 on 1919-03-31; the day starts at 00:30 -04.
        assert.equal(iso(startOfZonedDay('1919-03-31', 'America/Toronto')), '1919-03-31T04:30:00.000Z');
    });

    it('handles years outside 1900-9998', () => {
        assert.equal(iso(startOfZonedDay('0100-01-01', 'UTC')), '0100-01-01T00:00:00.000Z');
        assert.equal(iso(startOfZonedDay('0050-06-01', 'UTC')), '0050-06-01T00:00:00.000Z');
        assert.equal(iso(zonedDayRange('9999-12-31', 'UTC')?.end), '+010000-01-01T00:00:00.000Z');
    });

    it('rejects malformed and impossible dates', () => {
        for (const value of ['2026-02-30', '2026-13-01', '2026-3-1', '2026-03-10T00:00:00Z', 'yesterday']) {
            assert.equal(startOfZonedDay(value, 'UTC'), null, value);
        }
    });
});

describe('zonedDayRange', () => {
    it('spans one local day, which is 23 or 25 hours across DST changes', () => {
        const spring = zonedDayRange('2026-03-08', 'America/New_York')!;
        assert.equal(iso(spring.start), '2026-03-08T05:00:00.000Z');
        assert.equal(iso(spring.end), '2026-03-09T04:00:00.000Z');

        const fall = zonedDayRange('2026-11-01', 'America/New_York')!;
        assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * 60 * 60 * 1000);

        const monthEnd = zonedDayRange('2026-12-31', 'UTC')!;
        assert.equal(iso(monthEnd.end), '2027-01-01T00:00:00.000Z');
    });
});

describe('parseZonedDateBound', () => {
    it('zones date-only values and local date-times, and passes offset timestamps through', () => {
        assert.deepEqual(parseZonedDateBound('2026-03-10', 'America/Chicago'), { date: new Date('2026-03-10T05:00:00.000Z'), zoned: true });
        assert.deepEqual(parseZonedDateBound('2026-03-10 14:15', 'America/Chicago'), { date: new Date('2026-03-10T19:15:00.000Z'), zoned: true });
        assert.deepEqual(parseZonedDateBound('2026-03-10T14:15:30', 'Asia/Tokyo'), { date: new Date('2026-03-10T05:15:30.000Z'), zoned: true });
        assert.deepEqual(parseZonedDateBound('2026-03-10T12:00:00-05:00', 'Asia/Tokyo'), {
            date: new Date('2026-03-10T17:00:00.000Z'),
            zoned: false
        });
        assert.deepEqual(parseZonedDateBound('2026-03-10T12:00:00Z', 'Asia/Tokyo'), { date: new Date('2026-03-10T12:00:00.000Z'), zoned: false });
    });
});

describe('zonedDateTime', () => {
    it('maps a time skipped by spring-forward to the end of the gap, and a repeated time to its first occurrence', () => {
        assert.equal(iso(zonedDateTime('2026-03-08 02:30', 'America/New_York')), '2026-03-08T07:00:00.000Z');
        assert.equal(iso(zonedDateTime('2026-11-01 01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
    });

    it('rejects out-of-range and non-matching values', () => {
        for (const value of ['2026-03-10 24:00', '2026-03-10 12:60', '2026-02-30 12:00', '2026-03-10', '2026-03-10T12:00Z']) {
            assert.equal(zonedDateTime(value, 'UTC'), null, value);
        }
    });
});

describe('validTimeZone and isDateOnly', () => {
    it('accepts IANA zones and rejects anything else', () => {
        assert.equal(validTimeZone(' America/New_York '), 'America/New_York');
        assert.equal(validTimeZone('Mars/Olympus'), null);
        assert.equal(validTimeZone(''), null);
        assert.equal(validTimeZone(undefined), null);
    });

    it('recognizes date-only strings', () => {
        assert.equal(isDateOnly('2026-03-10'), true);
        assert.equal(isDateOnly('2026-03-10T00:00:00Z'), false);
    });
});

describe('currentZonedYear', () => {
    it('reads the current year in the given zone', () => {
        const newYearUtc = Date.parse('2027-01-01T01:00:00Z');
        assert.equal(currentZonedYear('America/Los_Angeles', newYearUtc), 2026);
        assert.equal(currentZonedYear('UTC', newYearUtc), 2027);
    });
});

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

const localKey = (instantMs: number, zone: string): { date: string; key: string } => {
    let format = keyFormatters.get(zone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
        });
        keyFormatters.set(zone, format);
    }
    const parts = format.formatToParts(new Date(instantMs));
    const get = (type: string) => parts.find(part => part.type === type)!.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    return { date, key: `${date}T${get('hour')}:${get('minute')}:${get('second')}` };
};

const offsetOf = (instantMs: number, zone: string): number => Date.parse(`${localKey(instantMs, zone).key}Z`) - instantMs;

/** Local dates (as the zone sees them just after the change) on which the UTC offset changes during 2024-2026. */
function transitionDays(zone: string): string[] {
    const days = new Set<string>();
    const step = 3 * 86_400_000;
    const end = Date.parse('2027-01-01T00:00:00Z');
    let from = Date.parse('2024-01-01T00:00:00Z');
    let fromOffset = offsetOf(from, zone);
    for (let to = from + step; to < end; to += step) {
        const toOffset = offsetOf(to, zone);
        if (toOffset !== fromOffset) {
            // Bisect (whole seconds) to the first instant with the new offset.
            let low = from / 1000;
            let high = to / 1000;
            while (high - low > 1) {
                const mid = Math.floor((low + high) / 2);
                if (offsetOf(mid * 1000, zone) === fromOffset) low = mid;
                else high = mid;
            }
            days.add(localKey(high * 1000, zone).date);
        }
        from = to;
        fromOffset = toOffset;
    }
    return [...days];
}

describe('zoned date brute force across every zone', () => {
    it('finds the true start of day and resolves every hour around transition days', () => {
        const zones = Intl.supportedValuesOf('timeZone');
        assert.ok(zones.length > 300);
        const started = Date.now();
        let checkedDays = 0;

        for (const zone of zones) {
            // A plain day too, so zones without transitions are exercised.
            for (const day of [...transitionDays(zone), '2025-06-15']) {
                checkedDays++;
                const start = startOfZonedDay(day, zone);
                assert.ok(start, `${zone} ${day}`);
                assert.equal(localKey(start.getTime(), zone).date, day, `${zone} ${day}: start is on the day`);
                assert.ok(localKey(start.getTime() - 1000, zone).date < day, `${zone} ${day}: previous second is before the day`);

                for (let hour = 0; hour < 24; hour++) {
                    const hh = String(hour).padStart(2, '0');
                    const target = `${day}T${hh}:00:00`;
                    const instant = zonedDateTime(`${day} ${hh}:00`, zone);
                    assert.ok(instant, `${zone} ${target}`);
                    const actual = localKey(instant.getTime(), zone).key;
                    // An existing time resolves to itself, and a skipped one to the first second after the gap.
                    assert.ok(actual >= target, `${zone} ${target} resolved to ${actual}`);
                    // Either way the previous second is before the target, which also rules out the second
                    // occurrence of a time repeated by a fall-back (its previous second is the repeat's end).
                    assert.ok(localKey(instant.getTime() - 1000, zone).key < target, `${zone} ${target}: previous second is before the target`);
                }
            }
        }

        const elapsed = Date.now() - started;
        console.log(`brute force: ${checkedDays} days across ${zones.length} zones in ${elapsed}ms`);
        assert.ok(checkedDays > 500, `checked ${checkedDays} days`);
    });
});
