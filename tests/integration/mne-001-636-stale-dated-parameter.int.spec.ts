import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import pg from 'pg';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePayRun, createPayRun, type PayRunInput } from '../../src/services/payroll/common/pay-run-service.js';
import { registerPayRunCommand } from '../../src/cli/pay-run-command.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-636 (#953) · A RUN PAID AFTER THE DUE DATE OF AN UNLOADED
// PARAMETER SAYS WHICH VALUE IT USES AND SINCE WHEN
//
// The minimum wages take a new value on 1 January and the UMA on 1 February.
// A dated lookup takes the last row in force, so a value nobody loaded lets
// the previous one rule (docs/RUNBOOK.md, «Renovación semestral del corpus
// normativo», step 4).
//
// THE CATALOGUE IS SYNTHETIC: the minimum wage and UMA rows end in 2026. The
// migrated `tax_parameters` closes its last window on 2026-12-31 (migration
// 080), and a 2027 run then fails closed, loudly. This spec opens that window
// (`effective_to` NULL, «sigue vigente» in the column's own comment), which
// is the shape migration 073 wrote and a later load can take: that is the
// silent case. The salary is flagged ISR-exempt because the ISR tariff is
// looked up by its year label and, with no 2027 tariff, stops the run before
// the part this spec measures (measured on develop: «No ISR brackets found for
// year 2027»). The old-age table of migration 330 already holds 2027.
//
// HAND FIGURES (SBC 400.00, a fortnight of 15 contribution days, UMA 117.31):
//   IMSS employee: excess over 3 UMA 400 − 351.93 = 48.07 × 0.40 % × 15 = 2.8842,
//   plus 400 × (0.25 + 0.375 + 0.625 + 1.125) % × 15 = 142.50 → 145.38.
//   Net pay: 6 000.00 − 145.38 = 5 854.62 (no ISR, no subsidy, no credit).
// ============================================================

apartarCatalogos('tax_parameters', 'legal_parameters');

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

interface Warning { table: string; key: string; value: string; since: string; dueFrom: string; payDate: string }
interface CliResult { exitCode?: number; out: string; err: string; errs: unknown[] }
interface CliRow { status: string; net_pay: string; warnings: string[] }

let f: Fixture;
let email: string;
let scheduleId: string;
let employeeNumber = 0;

async function newPeriod(start: string, end: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1, $2, $3, $4, $5, $5, $6, 'draft')`,
    [id, f.tenantId, scheduleId, start, end, Number(end.slice(0, 4))]
  );
  return id;
}

async function newEmployee(): Promise<string> {
  const id = uuidv4();
  employeeNumber += 1;
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
       work_state, pay_schedule_id, salary_type, currency_code)
     VALUES ($1, $2, $3, $4, 'Worker', 'Synthetic', '2025-03-09', 'active', 'MX',
       'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', '400.0000', '01', '02', 'JA', $5,
       'salary', 'MXN')`,
    [id, f.tenantId, f.entityId, `MX-636-${employeeNumber}`, scheduleId]
  );
  return id;
}

function inputOf(periodId: string, employees: string[]): PayRunInput {
  return {
    tenant_id: f.tenantId, pay_period_id: periodId, created_by: f.userId,
    employee_inputs: employees.map((employee_id) => ({
      employee_id,
      earnings: [{ earning_type: 'salary', amount: 6000, is_taxable_isr: false }],
    })),
  };
}

/** A run over a new period, calculated by the service; its result and its totals. */
async function calculated(start: string, end: string, workers = 1) {
  const scope = entityScope(f.tenantId, f.entityId);
  const employees: string[] = [];
  for (let i = 0; i < workers; i++) employees.push(await newEmployee());
  const input = inputOf(await newPeriod(start, end), employees);
  const runId = await createPayRun(input, scope);
  const result = (await calculatePayRun(runId, input, scope)) as unknown as { warnings?: Warning[] } | undefined;
  const totals = await query<{ employee_taxes: string; net: string }>(
    `SELECT total_employee_taxes::text AS employee_taxes, total_net_pay::text AS net
       FROM pay_runs WHERE id = $1 AND tenant_id = $2`,
    [runId, f.tenantId]
  );
  return { runId, input, warnings: result?.warnings, totals: totals.rows[0] };
}

const brief = (w: Warning[] | undefined) =>
  (w ?? []).map((x) => `${x.key} ${x.value} since ${x.since} due ${x.dueFrom} paid ${x.payDate}`);

async function cli(argv: string[]): Promise<CliResult> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const errs: unknown[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerPayRunCommand(p, {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errs.push(e); },
      confirm: async () => true,
    });
    await p.parseAsync(['node', 'mnemosine', 'pay-run', ...argv, '-e', f.entityId, '-t', f.tenantId, '-u', email]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return { exitCode, out: out.join(''), err: err.join(''), errs };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-636 · stale dated parameter');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  scheduleId = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
     VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
    [scheduleId, f.tenantId, f.entityId]
  );
  // The synthetic catalogue: nothing after 2026 for the minimum wages and the
  // UMA, and the last window open.
  await query(`DELETE FROM tax_parameters WHERE jurisdiction = 'MX' AND effective_from > DATE '2026-12-31'`);
  await query(
    `DELETE FROM legal_parameters WHERE jurisdiction = 'MX' AND effective_from > DATE '2026-12-31'
        AND (key LIKE 'uma.%' OR key LIKE 'minimum_wage.%')`
  );
  const opened = await query(
    `UPDATE tax_parameters SET effective_to = NULL WHERE jurisdiction = 'MX' AND effective_from = DATE '2026-02-01'`
  );
  expect(opened.rowCount).toBe(1);
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

afterEach(() => vi.restoreAllMocks());

describe('a run paid after a due date whose new row is not loaded', () => {
  it('ACCEPTANCE: paid on 15 January 2027 it names both minimum wages, the value and since when; not the UMA', async () => {
    const r = await calculated('2027-01-01', '2027-01-15');
    expect(r.totals).toEqual({ employee_taxes: '145.38', net: '5854.62' });
    expect(brief(r.warnings)).toEqual([
      'salario_minimo_general_diario 315.04 since 2026-01-01 due 2027-01-01 paid 2027-01-15',
      'salario_minimo_frontera_diario 440.87 since 2026-01-01 due 2027-01-01 paid 2027-01-15',
    ]);
  });

  it('pay-run calculate --json carries the warnings, and the table output prints them', async () => {
    const r = await calculated('2027-01-16', '2027-01-31');
    const file = join(mkdtempSync(join(tmpdir(), 'mne636-')), 'inputs.json');
    writeFileSync(file, JSON.stringify(r.input));

    const json = await cli(['calculate', r.runId, '--file', file, '--json']);
    expect(json.exitCode, String(json.errs[0])).toBe(0);
    const [row] = (JSON.parse(json.out) as { rows: CliRow[] }).rows;
    expect(row.status).toBe('calculated');
    expect(row.warnings).toHaveLength(2);
    expect(row.warnings[0]).toContain('315.04');
    expect(row.warnings[0]).toContain('2026-01-01');
    expect(row.warnings[0]).toContain('2027-01-01');
    expect(row.warnings[1]).toContain('440.87');

    const table = await cli(['calculate', r.runId, '--file', file]);
    expect(table.exitCode, String(table.errs[0])).toBe(0);
    expect(table.err).toContain(row.warnings[0]);
    expect(table.err).toContain(row.warnings[1]);
  });

  it('paid on 15 February 2027 the two UMAs join, and no amount changes', async () => {
    const r = await calculated('2027-02-01', '2027-02-15');
    expect(r.totals).toEqual({ employee_taxes: '145.38', net: '5854.62' });
    expect(brief(r.warnings)).toEqual([
      'salario_minimo_general_diario 315.04 since 2026-01-01 due 2027-01-01 paid 2027-02-15',
      'salario_minimo_frontera_diario 440.87 since 2026-01-01 due 2027-01-01 paid 2027-02-15',
      'uma_daily 117.31 since 2026-02-01 due 2027-02-01 paid 2027-02-15',
      'uma.monthly 3566.2200 since 2026-02-01 due 2027-02-01 paid 2027-02-15',
    ]);
  });

  it('a run paid in 2026, before any due date it has not met, says nothing', async () => {
    const r = await calculated('2026-12-16', '2026-12-31');
    expect(r.warnings).toEqual([]);
  });

  it('cost: the check reads once per run, not per paycheck', async () => {
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    const r = await calculated('2027-03-01', '2027-03-15', 2);
    const sql = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(r.warnings).toHaveLength(4);
    expect(sql.filter((s) => s.includes('WITH annual_windows AS'))).toHaveLength(1);
  });

  describe('with the 2027 rows loaded', () => {
    beforeAll(async () => {
      // Synthetic 2027 values, from no publication: what is pinned is that a
      // loaded row silences the warning, not the figures.
      await query(
        `UPDATE tax_parameters SET effective_to = DATE '2026-12-31'
          WHERE jurisdiction = 'MX' AND effective_from = DATE '2026-02-01'`
      );
      await query(
        `INSERT INTO tax_parameters (jurisdiction, tax_year, params, effective_from, effective_to)
         SELECT 'MX', 2027,
                params || '{"salario_minimo_general_diario": 350.00, "salario_minimo_frontera_diario": 480.00}'::jsonb,
                DATE '2027-01-01', DATE '2027-01-31'
           FROM tax_parameters WHERE jurisdiction = 'MX' AND effective_from = DATE '2026-02-01'`
      );
      await query(
        `INSERT INTO tax_parameters (jurisdiction, tax_year, params, effective_from, effective_to)
         SELECT 'MX', 2027, params || '{"uma_daily": 120.00}'::jsonb, DATE '2027-02-01', NULL
           FROM tax_parameters WHERE jurisdiction = 'MX' AND effective_from = DATE '2027-01-01'`
      );
      await query(
        `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
         VALUES ('MX', 'uma.monthly', '2027-02-01', '3648.0000', 'MXN', 'https://example.invalid/synthetic', 'synthetic')`
      );
    });

    it('paid on 15 January or on 15 April 2027 the run says nothing', async () => {
      // A period of its own: the schedule holds one period per start date.
      const jan = await calculated('2027-01-02', '2027-01-15');
      expect(jan.warnings).toEqual([]);
      const apr = await calculated('2027-04-01', '2027-04-15');
      expect(apr.warnings).toEqual([]);
    });
  });
});
