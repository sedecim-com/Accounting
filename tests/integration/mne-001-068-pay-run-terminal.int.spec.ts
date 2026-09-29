import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerPayRunCommand } from '../../src/cli/pay-run-command.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
// The calculators register on import; without it the MX engine is empty.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// MNE-001-068 (#306, part 2/4) · A FORTNIGHT RUN FROM THE TERMINAL
//
// create → calculate → approve, driven through the CLI leaves against a
// migrated Postgres. The figures are the engine's (061/063/064/067 on main);
// what this pins is that the terminal reaches them through the same services
// as REST, inside the entity scope, and that a sealed run stays sealed.
// ============================================================

// State payroll tax rates are a GLOBAL catalog; this file seeds one.
apartarCatalogos('mx_isn_tasas_estatales');

let f: Fixture;
let sibling: Fixture;
let email: string;
let periodId: string;
let siblingPeriodId: string;
let employees: string[];
let runId: string;
let inputsFile: string;

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

interface CliResult { exitCode?: number; out: string; err: string; errs: unknown[] }

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

const rowsOf = (r: CliResult): Array<Record<string, unknown>> =>
  (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows;

async function schedule(fx: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
     VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
    [id, fx.tenantId, fx.entityId]
  );
  return id;
}

async function period(fx: Fixture, scheduleId: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1, $2, $3, '2026-07-01', '2026-07-15', '2026-07-15', 2026, 'draft')`,
    [id, fx.tenantId, scheduleId]
  );
  return id;
}

async function employee(scheduleId: string, number: string, sbc: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
       work_state, pay_schedule_id, salary_type, currency_code)
     VALUES ($1, $2, $3, $4, 'Trabajador', $4, '2024-01-01', 'active', 'MX', 'XAXX010101000',
       'XAXX010101HDFXXX01', '12345678901', $5, '01', '02', 'JA', $6, 'salary', 'MXN')`,
    [id, f.tenantId, f.entityId, number, sbc, scheduleId]
  );
  return id;
}

const runStatus = async (id: string): Promise<string> =>
  (await query<{ status: string }>('SELECT status FROM pay_runs WHERE id = $1', [id])).rows[0].status;

const liabilities = async (id: string) =>
  (await query<{ tax_type: string; amount: string }>(
    'SELECT tax_type, amount::text AS amount FROM employer_tax_liabilities WHERE pay_run_id = $1 ORDER BY tax_type',
    [id]
  )).rows;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-068 · pay run from the terminal');
  sibling = await crearEntidadHermana(f, 'MNE-001-068 · sibling');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  await query(
    `INSERT INTO mx_isn_tasas_estatales (estado, vigencia_desde, vigencia_hasta, tasa, regimen, exencion_mensual, fundamento)
     VALUES ('JA', '2026-01-01', NULL, 0.03, 'tasa_plana', NULL, 'Ley de Hacienda del Estado de Jalisco, art. 39')`
  );
  const own = await schedule(f);
  periodId = await period(f, own);
  siblingPeriodId = await period(sibling, await schedule(sibling));
  employees = [await employee(own, 'Q-001', '400.0000'), await employee(own, 'Q-002', '650.0000')];
  inputsFile = join(mkdtempSync(join(tmpdir(), 'mne068-')), 'inputs.json');
  writeFileSync(
    inputsFile,
    JSON.stringify({
      employee_inputs: [
        { employee_id: employees[0], earnings: [{ earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' }] },
        { employee_id: employees[1], earnings: [{ earning_type: 'salary', amount: 9750, cfdi_clave_sat: '001' }] },
      ],
    })
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('pay-run create · calculate · approve from the terminal', () => {
  it('create over a sibling company period answers not found and writes no run', async () => {
    const r = await cli(['create', '--period', siblingPeriodId, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(3);
    const { rows } = await query('SELECT 1 FROM pay_runs WHERE pay_period_id = $1', [siblingPeriodId]);
    expect(rows).toEqual([]);
  });

  it('create writes a draft run over the own period, with the tax year of the period', async () => {
    const r = await cli(['create', '--period', periodId, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const [row] = rowsOf(r);
    runId = String(row.id);
    expect(row.status).toBe('draft');
    expect(row.tax_year).toBe(2026);
  });

  it('calculate writes one paycheck per employee, with the employer IMSS quota, and totals the run', async () => {
    const r = await cli(['calculate', runId, '--file', inputsFile, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const [row] = rowsOf(r);
    expect(row.status).toBe('calculated');
    expect(row.employees).toBe(2);
    const { rows } = await query<{ imss_employer: string; net_pay: string }>(
      'SELECT imss_employer::text AS imss_employer, net_pay::text AS net_pay FROM paychecks WHERE pay_run_id = $1',
      [runId]
    );
    expect(rows).toHaveLength(2);
    for (const p of rows) expect(new Decimal(p.imss_employer).gt(0)).toBe(true);
    const net = rows.reduce((s, p) => s.plus(p.net_pay), new Decimal(0));
    expect(new Decimal(String(row.net_pay)).equals(net)).toBe(true);
  });

  it('approve --dry-run shows the liability and writes nothing', async () => {
    const r = await cli(['approve', runId, '--dry-run', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const [row] = rowsOf(r);
    expect(row.dry_run).toBe(true);
    expect((row.liabilities as unknown[]).length).toBeGreaterThan(0);
    expect(await runStatus(runId)).toBe('calculated');
    expect(await liabilities(runId)).toEqual([]);
  });

  it('approve seals the run, and the employer IMSS liability is the sum of its paychecks', async () => {
    const r = await cli(['approve', runId, '--yes', '--idempotency-key', `k-${runId}`, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(await runStatus(runId)).toBe('approved');
    const { rows } = await query<{ total: string }>(
      'SELECT SUM(imss_employer)::text AS total FROM paychecks WHERE pay_run_id = $1',
      [runId]
    );
    const imss = (await liabilities(runId)).filter((l) => l.tax_type === 'imss_employer');
    expect(imss).toHaveLength(1);
    expect(new Decimal(imss[0].amount).equals(rows[0].total)).toBe(true);
    expect((await liabilities(runId)).map((l) => l.tax_type)).toContain('isn');
  });

  it('a retry with the same key returns the recorded result instead of refusing', async () => {
    const r = await cli(['approve', runId, '--yes', '--idempotency-key', `k-${runId}`, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(rowsOf(r)[0].repeated).toBe(true);
  });

  it('an approved run is not calculated again: blocked, and it stays approved', async () => {
    const r = await cli(['calculate', runId, '--file', inputsFile, '--json']);
    expect(r.exitCode).toBe(5);
    expect(await runStatus(runId)).toBe('approved');
  });
});
