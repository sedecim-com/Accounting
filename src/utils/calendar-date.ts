import { ValidationError } from './errors.js';

/**
 * A CALENDAR DATE, as the 'YYYY-MM-DD' text a DATE column stores (#211).
 *
 * A calendar date is not an instant, and a JS `Date` is. The two meet at the
 * pg driver, which serialises a `Date` parameter with the process's LOCAL
 * fields plus its offset (`node_modules/pg/lib/utils.js`, `dateToString`), and
 * Postgres keeps only the date part when that text lands in a DATE. So:
 *
 *  · `new Date('2026-03-01')` is UTC midnight. West of Greenwich its local
 *    fields are February 28th, and that is what the column received. Measured
 *    in America/Mexico_City through REST: an entry dated March 1st stored on
 *    February 28th, in February's period; an entry or a receipt dated January
 *    1st refused with PERIOD_CLOSED, because December 31st of the previous
 *    year has no period; a vendor payment stored on April 1st with ITS OWN
 *    entry on March 31st.
 *  · A `Date` that pg PARSES from a DATE column is LOCAL midnight, so its local
 *    fields are exactly the stored day in every zone.
 *
 * Hence the two rules below. A string is never reinterpreted through `new
 * Date(string)`: its day is its text. A `Date` is read with its LOCAL fields —
 * the very day pg would have sent — so every caller that already passes a
 * `Date` keeps its current behaviour exactly. The function is idempotent and
 * total over `Date | string`, which is what lets a caller drop a `new Date(x)`
 * wrapper without ever making things worse.
 *
 * What it refuses, it names: an unreadable string or an invalid `Date` is a
 * 422 here, where today it was a Postgres error with no line to point at.
 */
export function toCalendarDate(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError('Invalid date: the value is not a real point in time.', 'date');
    }
    return formatParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  // An ISO string that carries a time already has its date resolved: it is
  // cut, not reinterpreted — the same rule as the CLI's output kernel.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!match) {
    throw new ValidationError(`Unreadable date "${value}": expected YYYY-MM-DD.`, 'date');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // The day must exist. UTC arithmetic here is only a calendar check — no
  // timezone can move it — and it is what rejects 2026-02-30.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ValidationError(`The date "${value}" does not exist in the calendar.`, 'date');
  }
  return formatParts(year, month, day);
}

function formatParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * CALENDAR DAYS BETWEEN TWO DATES, counted on the calendar and not on a clock.
 *
 * Three places subtracted milliseconds and divided by 86_400_000, and each got
 * a different answer depending on where the server stood. The two operands were
 * never the same kind of thing: one side arrived as a 'YYYY-MM-DD' string —
 * which `new Date()` reads as UTC midnight — and the other as the Date that pg
 * builds from a DATE column, which is LOCAL midnight. Subtracting them mixes
 * two origins that differ by the offset, and the quotient lands a whole day off
 * on one half of the planet.
 *
 * Measured on a 2/10 Net 30 bill dated 2026-08-01 paid on 2026-08-12 — day
 * eleven, outside the discount window: UTC answered 11 (right), Mexico_City,
 * Tijuana and New_York answered 10 (and granted a 2 % discount that had
 * expired), while Madrid and Tokyo answered 11. Neither rounding nor flooring
 * fixes it: the error is in the operands, not in the division.
 *
 * A DST change is the same trap by another door — a 23- or 25-hour day makes
 * the quotient a fraction — and it does not arise here: both ends are reduced
 * to their calendar parts first, and `Date.UTC` of three integers has no
 * daylight saving to cross.
 */
export function daysBetween(from: Date | string, to: Date | string): number {
  const [fy, fm, fd] = toCalendarDate(from).split('-').map(Number);
  const [ty, tm, td] = toCalendarDate(to).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * TODAY'S CALENDAR DATE IN A TIME ZONE (#242).
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day: in Mexico City from
 * 18:00 to midnight it is already tomorrow, and in Tokyo from midnight to 09:00
 * it is still yesterday. The process's local fields are no better — the
 * server runs in UTC — and neither is a bare `CURRENT_DATE`, which is the
 * database session's day. The day a document is dated is the day in the zone
 * its books live in, and that zone is the `zona_horaria` policy: callers reach
 * this through `todayFor` (src/services/policy/today.ts), not directly.
 *
 * The zone is checked against `Intl.supportedValuesOf('timeZone')` first. A
 * misspelt zone must be refused, not quietly read as some other clock.
 */
export function calendarDateIn(timeZone: string, now: Date = new Date()): string {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const field = (type: 'year' | 'month' | 'day') => Number(parts.find((p) => p.type === type)?.value);
  return formatParts(field('year'), field('month'), field('day'));
}

let knownZones: Set<string> | undefined;

/** Refuses a zone the runtime does not list (#242): the value is typed by a person. */
export function assertTimeZone(timeZone: string): void {
  knownZones ??= new Set(Intl.supportedValuesOf('timeZone'));
  if (!knownZones.has(timeZone)) {
    throw new ValidationError(
      `"${timeZone}" is not a time zone this system knows. Use an IANA name such as ` +
        'America/Mexico_City, America/Tijuana, America/Cancun or America/Hermosillo.',
      'zona_horaria'
    );
  }
}
