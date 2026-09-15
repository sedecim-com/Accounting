import { describe, it, expect } from 'vitest';
import { toCalendarDate } from '../../src/utils/calendar-date.js';

/**
 * The timezone is switched INSIDE each case and restored in `finally`, and the
 * switch is verified first: on a machine without timezone data it would
 * silently stay put and every assertion would pass for the wrong reason.
 */
function inTimezone(tz: string, expectedOffsetMinutes: number, run: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    expect(new Date('2026-03-01T12:00:00Z').getTimezoneOffset(), `did not switch to ${tz}`).toBe(expectedOffsetMinutes);
    run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const ZONES: Array<[string, number]> = [
  ['America/Mexico_City', 360],
  ['UTC', 0],
  ['Asia/Tokyo', -540],
];

describe('toCalendarDate', () => {
  for (const [tz, offset] of ZONES) {
    describe(`in ${tz}`, () => {
      it('keeps a YYYY-MM-DD string as that very day — never reparsed through Date', () => {
        inTimezone(tz, offset, () => {
          expect(toCalendarDate('2026-03-01')).toBe('2026-03-01');
          expect(toCalendarDate('2026-01-01')).toBe('2026-01-01');
        });
      });

      it('cuts an ISO string that carries a time, instead of reinterpreting it', () => {
        inTimezone(tz, offset, () => {
          expect(toCalendarDate('2026-03-01T23:30:00-06:00')).toBe('2026-03-01');
          expect(toCalendarDate('2026-03-01T12:00:00')).toBe('2026-03-01');
        });
      });

      it('reads a Date by its LOCAL fields — the day pg would send for it', () => {
        inTimezone(tz, offset, () => {
          // Local midnight, as pg parses a DATE column: the stored day, in every zone.
          expect(toCalendarDate(new Date(2026, 2, 1))).toBe('2026-03-01');
          // A local evening: still that local day, whatever the UTC day is.
          expect(toCalendarDate(new Date(2026, 6, 1, 19, 0, 0))).toBe('2026-07-01');
        });
      });
    });
  }

  it('is idempotent', () => {
    expect(toCalendarDate(toCalendarDate('2026-12-31'))).toBe('2026-12-31');
  });

  it('refuses what it cannot read, and names it', () => {
    expect(() => toCalendarDate('01/03/2026')).toThrow(/Unreadable date/);
    expect(() => toCalendarDate('2026-02-30')).toThrow(/does not exist/);
    expect(() => toCalendarDate(new Date('not a date'))).toThrow(/Invalid date/);
  });
});
