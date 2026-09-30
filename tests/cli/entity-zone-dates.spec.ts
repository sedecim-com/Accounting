import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  addCalendarDays,
  calendarDateIn,
  calendarDateOf,
  calendarDateTimeIn,
  isRealCalendarDate,
} from '../../src/utils/calendar-date.js';
import { renderConflicts, renderMemory } from '../../src/cli/memory-command.js';
import { rangoDelMes } from '../../src/cli/payroll-isn-command.js';
import { dueDateFromTerms } from '../../src/cli/invoice-command.js';

// MNE-001-290: 31 January 19:00 in Mexico City is 1 February 01:00 UTC.
const JAN_31_1900_CDMX = new Date('2026-02-01T01:00:00Z');
const MX = 'America/Mexico_City';

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

describe('instants print on the entity clock, not UTC', () => {
  it('a question of 31 January 19:00 in CDMX is dated 31 January', () => {
    expect(calendarDateIn(MX, JAN_31_1900_CDMX)).toBe('2026-01-31');
    expect(JAN_31_1900_CDMX.toISOString().slice(0, 10)).toBe('2026-02-01'); // the old answer
  });

  it('prints a wall clock in the zone', () => {
    expect(calendarDateTimeIn(MX, JAN_31_1900_CDMX)).toBe('2026-01-31 19:00');
    expect(calendarDateTimeIn('Asia/Tokyo', JAN_31_1900_CDMX)).toBe('2026-02-01 10:00');
    // midnight is 00:00, never 24:00
    expect(calendarDateTimeIn('Africa/Abidjan', new Date('2026-02-01T00:05:00Z'))).toBe('2026-02-01 00:05');
  });

  it('refuses a zone it does not know', () => {
    expect(() => calendarDateTimeIn('Mars/Olympus', JAN_31_1900_CDMX)).toThrow(/time zone/);
  });

  it('memory list and conflicts take the zone', () => {
    const entry = {
      id: 'm1', answer: 'a', question: 'q', topic: null, answered_by: 'x',
      answered_at: JAN_31_1900_CDMX, is_precedent: true,
    };
    const stats = { active: 1, retired: 0, taught: 0 };
    const out = renderMemory([entry as never], stats, plain, MX).join('\n');
    expect(out).toContain('2026-01-31 · x');
    const conflict = { key: 'k', scope: 'topic', entityName: 'E', entries: [entry] };
    expect(renderConflicts([conflict as never], 1, plain, MX).join('\n')).toContain('2026-01-31 · x');
  });
});

describe('calendar arithmetic without an instant', () => {
  it('validates real days only', () => {
    expect(isRealCalendarDate('2026-02-28')).toBe(true);
    expect(isRealCalendarDate('2026-02-30')).toBe(false);
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    expect(isRealCalendarDate('2026-2-3')).toBe(false);
  });

  it('adds days and rolls months', () => {
    expect(addCalendarDays('2026-01-31', 30)).toBe('2026-03-02');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(calendarDateOf(2026, 13, 1)).toBe('2027-01-01');
  });

  it('keeps the callers that used UTC arithmetic', () => {
    expect(rangoDelMes(2026, 2)).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(rangoDelMes(2026, 12)).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
    expect(dueDateFromTerms('Net 30', '2026-01-31')).toBe('2026-03-02');
  });
});

describe('no CLI surface truncates an instant with toISOString', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  const files = [...walk('src/cli'), 'src/ai/memory-service.ts'];
  const BAD = /toISOString\(\)\s*(\.slice|\.split|\.substring|\.replace)/;

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s', (f) => {
    const offending = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && BAD.test(l));
    expect(offending).toEqual([]);
  });
});
