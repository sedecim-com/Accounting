import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { registerPayCalendarCommand } from '../../src/cli/pay-schedule-command.js';
import { planPayPeriods, writePayPeriods } from '../../src/services/payroll/common/pay-period-service.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-403 (#587) · MNE-001-404 (#613) · THE PAY CALENDAR FROM THE TERMINAL
//
// pay-schedule create · list and pay-period create · list, driven through the
// CLI leaves against a migrated Postgres. What this pins: a pay run no longer
// needs REST or SQL to have a period to run over, a period range written twice
// is written once, and a sibling company's schedule is as absent as a missing
// one.
// ============================================================

let f: Fixture;
let sibling: Fixture;
let email: string;
let scheduleId: string;
let siblingSchedule: string;

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

interface CliResult { exitCode?: number; out: string; errs: unknown[] }

async function cli(argv: string[], fx: Fixture = f): Promise<CliResult> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const errs: unknown[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerPayCalendarCommand(p, {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errs.push(e); },
    });
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', fx.entityId, '-t', fx.tenantId, '-u', email]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return { exitCode, out: out.join(''), errs };
}

const rowsOf = (r: CliResult): Array<Record<string, unknown>> =>
  (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows;

const periodsOf = async (schedule: string): Promise<string[]> =>
  (await query<{ span: string }>(
    `SELECT period_start::text || '..' || period_end::text AS span
       FROM pay_periods WHERE pay_schedule_id = $1 ORDER BY period_start`,
    [schedule]
  )).rows.map((r) => r.span);

const scheduleArgs = ['--name', 'Quincenal', '--frequency', 'quincenal', '--country', 'MX', '--first-start', '2026-07-01'];

beforeAll(async () => {
  f = await crearInquilino('MNE-001-403 · pay calendar from the terminal');
  sibling = await crearEntidadHermana(f, 'MNE-001-403 · sibling');
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('pay-schedule create · list', () => {
  it('create --dry-run shows the schedule and writes none', async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs, '--dry-run', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(rowsOf(r)[0].frequency).toBe('quincenal');
    const { rows } = await query('SELECT 1 FROM pay_schedules WHERE entity_id = $1', [f.entityId]);
    expect(rows).toEqual([]);
  });

  it('create writes the schedule and list shows it', async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    scheduleId = String(rowsOf(r)[0].id);
    const listed = await cli(['pay-schedule', 'list', '--json']);
    expect(listed.exitCode, String(listed.errs[0])).toBe(0);
    expect(rowsOf(listed).map((x) => [x.id, x.frequency, x.first_start])).toEqual([
      [scheduleId, 'quincenal', '2026-07-01'],
    ]);
  });

  it('an unknown frequency is a usage error and writes nothing', async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs.slice(0, 2), '--frequency', 'catorcenal',
      '--country', 'MX', '--first-start', '2026-07-01', '--json']);
    expect(r.exitCode).toBe(2);
    const { rows } = await query('SELECT 1 FROM pay_schedules WHERE entity_id = $1', [f.entityId]);
    expect(rows).toHaveLength(1);
  });

  // Date.parse rolls 2026-02-30 into March, so a shape check alone lets the
  // dry run approve a day the write then fails on inside Postgres.
  it('a first start that is not a real day is a usage error and writes nothing', async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs.slice(0, 6), '--first-start', '2026-02-30', '--json']);
    expect(r.exitCode).toBe(2);
    const { rows } = await query('SELECT 1 FROM pay_schedules WHERE entity_id = $1', [f.entityId]);
    expect(rows).toHaveLength(1);
  });

  // pay_schedules.name is VARCHAR(100) (008_payroll.sql): unbounded, the dry
  // run approved a name the write then failed on inside Postgres (exit 1).
  it('a name longer than 100 characters is a usage error and writes nothing', async () => {
    const r = await cli(['pay-schedule', 'create', '--name', 'Q'.repeat(101), ...scheduleArgs.slice(2), '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(2);
    const { rows } = await query('SELECT 1 FROM pay_schedules WHERE entity_id = $1', [f.entityId]);
    expect(rows).toHaveLength(1);
  });
});

describe('pay-period create · list', () => {
  it('create --dry-run shows the periods it would write and writes none', async () => {
    const r = await cli(['pay-period', 'create', '--schedule', scheduleId, '--count', '2', '--dry-run', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(rowsOf(r).map((x) => `${String(x.start)}..${String(x.end)}`)).toEqual(['2026-07-01..2026-07-15', '2026-07-16..2026-07-31']);
    expect(await periodsOf(scheduleId)).toEqual([]);
  });

  it('create writes the periods of the schedule, and list shows them', async () => {
    const r = await cli(['pay-period', 'create', '--schedule', scheduleId, '--count', '2', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(rowsOf(r)).toHaveLength(2);
    expect(await periodsOf(scheduleId)).toEqual(['2026-07-01..2026-07-15', '2026-07-16..2026-07-31']);
    const listed = await cli(['pay-period', 'list', '--year', '2026', '--json']);
    expect(rowsOf(listed).map((x) => x.id).sort()).toEqual(rowsOf(r).map((x) => x.id).sort());
  });

  it('create again continues after the last period: no period is repeated', async () => {
    const r = await cli(['pay-period', 'create', '--schedule', scheduleId, '--count', '1', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(await periodsOf(scheduleId)).toEqual([
      '2026-07-01..2026-07-15', '2026-07-16..2026-07-31', '2026-08-01..2026-08-15',
    ]);
  });

  // Number() reads `1e1` as ten: a count must be written as digits.
  it('a count in scientific notation is a usage error and writes nothing', async () => {
    const r = await cli(['pay-period', 'create', '--schedule', scheduleId, '--count', '1e1', '--json']);
    expect(r.exitCode).toBe(2);
    expect(await periodsOf(scheduleId)).toHaveLength(3);
  });

  it('the same range written twice is written once, and the second write reports nothing created', async () => {
    const scope = entityScope(f.tenantId, f.entityId);
    const plan = await planPayPeriods(scope, scheduleId, 2);
    expect(await writePayPeriods(scope, scheduleId, plan)).toHaveLength(2);
    expect(await writePayPeriods(scope, scheduleId, plan)).toEqual([]);
    expect(await periodsOf(scheduleId)).toHaveLength(5);
  });
});

describe('the entity boundary', () => {
  beforeAll(async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs, '--json'], sibling);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    siblingSchedule = String(rowsOf(r)[0].id);
    expect((await cli(['pay-period', 'create', '--schedule', siblingSchedule, '--count', '1', '--json'], sibling)).exitCode).toBe(0);
  });

  it('a sibling company schedule is not found, like a missing one, and gets no period', async () => {
    const foreign = await cli(['pay-period', 'create', '--schedule', siblingSchedule, '--count', '2', '--json']);
    const missing = await cli(['pay-period', 'create', '--schedule', randomUUID(), '--count', '2', '--json']);
    expect(foreign.exitCode, String(foreign.errs[0])).toBe(3);
    expect(missing.exitCode).toBe(3);
    expect(await periodsOf(siblingSchedule)).toEqual(['2026-07-01..2026-07-15']);
    const scope = entityScope(f.tenantId, f.entityId);
    await expect(writePayPeriods(scope, siblingSchedule, await planPayPeriods(entityScope(sibling.tenantId, sibling.entityId), siblingSchedule, 1)))
      .rejects.toThrow(/not found/i);
    expect(await periodsOf(siblingSchedule)).toEqual(['2026-07-01..2026-07-15']);
  });

  it('a schedule id that is not a UUID is not found, not an internal error', async () => {
    const r = await cli(['pay-period', 'create', '--schedule', 'not-a-uuid', '--count', '1', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(3);
  });

  it('the lists of one company never show the other company schedules or periods', async () => {
    const schedules = rowsOf(await cli(['pay-schedule', 'list', '--json'])).map((x) => x.id);
    expect(schedules).toEqual([scheduleId]);
    const periods = rowsOf(await cli(['pay-period', 'list', '--json']));
    expect(periods).toHaveLength(5);
    expect(periods.every((x) => x.schedule_id === scheduleId)).toBe(true);
  });
});

describe('the list filters', () => {
  it('pay-period list --year and --status keep only the matching periods', async () => {
    expect(rowsOf(await cli(['pay-period', 'list', '--year', '2026', '--json']))).toHaveLength(5);
    expect(rowsOf(await cli(['pay-period', 'list', '--year', '2027', '--json']))).toEqual([]);
    expect(rowsOf(await cli(['pay-period', 'list', '--status', 'draft', '--json']))).toHaveLength(5);
    expect(rowsOf(await cli(['pay-period', 'list', '--status', 'calculated', '--json']))).toEqual([]);
  });

  it('pay-schedule list hides an inactive schedule unless --all', async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs.slice(0, 1), 'Semanal', '--frequency', 'weekly',
      '--country', 'MX', '--first-start', '2026-07-06', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const inactive = String(rowsOf(r)[0].id);
    // No leaf retires a schedule yet; the fixture does it directly.
    await query('UPDATE pay_schedules SET is_active = false WHERE id = $1 AND entity_id = $2', [inactive, f.entityId]);
    expect(rowsOf(await cli(['pay-schedule', 'list', '--json'])).map((x) => x.id)).toEqual([scheduleId]);
    expect(rowsOf(await cli(['pay-schedule', 'list', '--all', '--json'])).map((x) => x.id).sort())
      .toEqual([scheduleId, inactive].sort());
  });
});

// Last, because it adds an active schedule the list cases above would see.
// The edge of the VARCHAR(100) bound: a refusal that starts below 100
// characters would reject names Postgres accepts.
describe('the name bound', () => {
  it('a name of exactly 100 characters is written', async () => {
    const name = 'Ñ'.repeat(100);
    const r = await cli(['pay-schedule', 'create', '--name', name, ...scheduleArgs.slice(2), '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const { rows } = await query('SELECT 1 FROM pay_schedules WHERE entity_id = $1 AND name = $2', [f.entityId, name]);
    expect(rows).toHaveLength(1);
  });

  // VARCHAR(100) counts characters. A character outside the BMP is one
  // character and two UTF-16 units, so a bound on `name.length` would refuse
  // a name Postgres accepts.
  it('the bound counts characters, not UTF-16 units', async () => {
    const name = '\u{1F4C5}'.repeat(100);
    expect(name.length).toBe(200);
    const r = await cli(['pay-schedule', 'create', '--name', name, ...scheduleArgs.slice(2), '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const { rows } = await query('SELECT 1 FROM pay_schedules WHERE entity_id = $1 AND name = $2', [f.entityId, name]);
    expect(rows).toHaveLength(1);
  });
});
