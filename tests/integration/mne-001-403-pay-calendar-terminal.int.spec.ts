import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { registerPayCalendarCommand } from '../../src/cli/pay-schedule-command.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-403 (#587) · THE PAY CALENDAR FROM THE TERMINAL
//
// pay-schedule create · list, driven through the CLI leaves against a
// migrated Postgres. What this pins: a pay run no longer needs REST or SQL to
// have a schedule, and a sibling company's schedule never shows in the list.
// The periods are still created over REST (#613).
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

describe('the entity boundary', () => {
  beforeAll(async () => {
    const r = await cli(['pay-schedule', 'create', ...scheduleArgs, '--json'], sibling);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    siblingSchedule = String(rowsOf(r)[0].id);
  });

  it('the list of one company never shows the other company schedules', async () => {
    const schedules = rowsOf(await cli(['pay-schedule', 'list', '--json'])).map((x) => x.id);
    expect(schedules).not.toContain(siblingSchedule);
    expect(schedules).toEqual([scheduleId]);
  });
});

describe('the list filters', () => {
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
