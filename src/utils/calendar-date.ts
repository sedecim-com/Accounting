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
