import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { registerEmployeeCommand } from '../../src/cli/employee-command.js';
import { registerPayRunCommand } from '../../src/cli/pay-run-command.js';
import { registerPayslipCommand } from '../../src/cli/payslip-command.js';
import { registerImssCommand } from '../../src/cli/imss-command.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
// The calculators register on import; without it the MX engine is empty.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// MNE-001-070 (#306, part 4/4) · A FORTNIGHT FROM THE TERMINAL, END TO END
//
// Every step is a CLI leaf against a migrated Postgres: `employee create`,
// `pay-run create|calculate|approve|post`, `payslip list|show` and
// `imss sua export`. What this pins, as the issue's acceptance fixes it: the
// entry balances, and the employer IMSS and INFONAVIT in the month's SUA file
// equal what the approval wrote to employer_tax_liabilities.
// ============================================================

apartarCatalogos('mx_isn_tasas_estatales');

let f: Fixture;
let sibling: Fixture;
let email: string;
let dir: string;
let periodId: string;
let scheduleId: string;
let runId: string;

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

interface CliResult { exitCode?: number; out: string; err: string; errs: unknown[] }

async function cli(argv: string[], entityId = f.entityId): Promise<CliResult> {
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
    const deps = {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errs.push(e); },
    };
    registerEmployeeCommand(p, deps);
    registerPayRunCommand(p, { ...deps, confirm: async () => true });
    registerPayslipCommand(p, deps);
    registerImssCommand(p, deps);
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', entityId, '-t', f.tenantId, '-u', email]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return { exitCode, out: out.join(''), err: err.join(''), errs };
}

async function ok(argv: string[]): Promise<Array<Record<string, unknown>>> {
  const r = await cli([...argv, '--json']);
  expect(r.exitCode, String(r.errs[0])).toBe(0);
  return (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows;
}

async function hire(number: string, sbc: number, nss: string): Promise<string> {
  const file = join(dir, `${number}.json`);
  writeFileSync(file, JSON.stringify({
    employee_number: number, first_name: 'Trabajador', last_name: number,
    rfc: `XAXX0101010${number.slice(-2)}`, curp: `XAXX010101HDFXXX${number.slice(-2)}`, nss,
    sbc, riesgo_puesto: '01', tipo_regimen_sat: '02', work_state: 'JA', salary_type: 'salary',
  }));
  const [row] = await ok(['employee', 'create', '--file', file, '--country', 'MX', '--hire-date', '2024-01-01',
    '--pay-schedule', scheduleId]);
  return String(row.id);
}

const liability = async (taxType: string): Promise<Decimal> =>
  new Decimal((await query<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS s FROM employer_tax_liabilities
      WHERE entity_id = $1 AND tax_type = $2 AND period_end BETWEEN '2026-07-01' AND '2026-07-31'`,
    [f.entityId, taxType]
  )).rows[0].s);

const suaFilings = async (): Promise<number> =>
  Number((await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM tax_form_filings WHERE entity_id = $1 AND form_type = 'sua'`, [f.entityId]
  )).rows[0].n);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-070 · payslip and SUA from the terminal');
  sibling = await crearEntidadHermana(f, 'MNE-001-070 · sibling');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  await query(
    `INSERT INTO mx_isn_tasas_estatales (estado, vigencia_desde, vigencia_hasta, tasa, regimen, exencion_mensual, fundamento)
     VALUES ('JA', '2026-01-01', NULL, 0.03, 'tasa_plana', NULL, 'Ley de Hacienda del Estado de Jalisco, art. 39')`
  );
  scheduleId = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
     VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
    [scheduleId, f.tenantId, f.entityId]
  );
  periodId = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1, $2, $3, '2026-07-01', '2026-07-15', '2026-07-15', 2026, 'draft')`,
    [periodId, f.tenantId, scheduleId]
  );
  dir = mkdtempSync(join(tmpdir(), 'mne070-'));
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a fortnight from the terminal', () => {
  it('hires two employees, runs, approves and posts the fortnight: the entry balances', async () => {
    const a = await hire('P-01', 400, '12345678901');
    const b = await hire('P-02', 650, '10987654321');
    const inputs = join(dir, 'inputs.json');
    writeFileSync(inputs, JSON.stringify([
      { employee_id: a, earnings: [{ earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' }] },
      { employee_id: b, earnings: [{ earning_type: 'salary', amount: 9750, cfdi_clave_sat: '001' }] },
    ]));
    runId = String((await ok(['pay-run', 'create', '--period', periodId]))[0].id);
    await ok(['pay-run', 'calculate', runId, '--file', inputs]);
    await ok(['pay-run', 'approve', runId, '--yes']);
    const [posted] = await ok(['pay-run', 'post', runId, '--post', '--yes']);
    expect(posted.mode).toBe('posted');
    const { rows } = await query<{ status: string; d: string; c: string }>(
      'SELECT status, total_debits::text AS d, total_credits::text AS c FROM journal_entries WHERE id = $1',
      [posted.journal_entry_id]
    );
    expect(rows[0].status).toBe('posted');
    expect(new Decimal(rows[0].d).equals(rows[0].c)).toBe(true);
  });

  it('payslip list shows both paychecks and no tax identifier', async () => {
    const r = await cli(['payslip', 'list', '--run', runId, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const rows = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.map((x) => x.employee)).toEqual(['P-01', 'P-02']);
    expect(r.out).not.toMatch(/XAXX|12345678901/);
    // The list contract reaches the SQL: paging, and the stamp state.
    expect((await ok(['payslip', 'list', '--run', runId, '-n', '1', '--offset', '1'])).map((x) => x.employee)).toEqual(['P-02']);
    expect(await ok(['payslip', 'list', '--run', runId, '--status', 'stamped'])).toHaveLength(0);
    expect(await ok(['payslip', 'list', '--run', runId, '--status', 'pending'])).toHaveLength(2);
    expect((await cli(['payslip', 'list', '--run', 'abc', '--json'])).exitCode).toBe(3);
  });

  it('payslip show masks the identifiers and its lines add up to the gross', async () => {
    const [first] = await ok(['payslip', 'list', '--run', runId]);
    const [slip] = await ok(['payslip', 'show', String(first.id)]);
    expect(slip.nss).toBe('••••901');
    expect(JSON.stringify(slip)).not.toContain('12345678901');
    const earned = (slip.lines as Array<{ kind: string; amount: string }>)
      .filter((l) => l.kind === 'earning')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
    expect(earned.equals(String(slip.gross))).toBe(true);
  });

  it('from the sibling company the paycheck and the run do not exist', async () => {
    const [first] = await ok(['payslip', 'list', '--run', runId]);
    expect((await cli(['payslip', 'show', String(first.id), '--json'], sibling.entityId)).exitCode).toBe(3);
    expect((await cli(['payslip', 'list', '--run', runId, '--json'], sibling.entityId)).exitCode).toBe(3);
  });

  it('the SUA file of July carries the employer IMSS and INFONAVIT the approval wrote', async () => {
    const file = join(dir, 'SUA_2026-07.txt');
    const [row] = await ok(['imss', 'sua', 'export', '--period', '2026-07', '-o', file]);
    expect(row.employee_count).toBe(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Positions after NSS, RFC, CURP and three names (123) + SBC (8) + days (2):
    // IMSS employer and INFONAVIT employer, in cents.
    const cents = (line: string, at: number) => new Decimal(line.slice(at, at + 10)).div(100);
    const lines = readFileSync(file, 'utf8').split('\r\n').filter(Boolean);
    const imss = lines.reduce((s, l) => s.plus(cents(l, 133)), new Decimal(0));
    const infonavit = lines.reduce((s, l) => s.plus(cents(l, 153)), new Decimal(0));
    expect(imss.isZero()).toBe(false);
    expect(imss.equals(await liability('imss_employer'))).toBe(true);
    expect(infonavit.equals(await liability('infonavit_employer'))).toBe(true);
    expect(await suaFilings()).toBe(1);
  });

  it('an existing file is not overwritten without --yes', async () => {
    const file = join(dir, 'SUA_2026-07.txt');
    const r = await cli(['imss', 'sua', 'export', '--period', '2026-07', '-o', file, '--json']);
    expect(r.exitCode).toBe(2);
    expect(await suaFilings()).toBe(1);
  });

  it('re-exporting the month, and a dry run, leave ONE draft filing', async () => {
    const file = join(dir, 'SUA_2026-07.txt');
    const again = await cli(['imss', 'sua', 'export', '--period', '2026-07', '-o', file, '--yes', '--json']);
    expect(again.exitCode, String(again.errs[0])).toBe(0);
    const dry = await cli(['imss', 'sua', 'export', '--period', '2026-07', '--dry-run', '--json']);
    expect(dry.exitCode, String(dry.errs[0])).toBe(0);
    expect(await suaFilings()).toBe(1);
    const { rows } = await query<{ status: string }>(
      `SELECT status FROM tax_form_filings WHERE entity_id = $1 AND form_type = 'sua'`, [f.entityId]
    );
    expect(rows.map((x) => x.status)).toEqual(['draft']);
  });

  it('a failed write records no filing', async () => {
    await query(`DELETE FROM tax_form_filings WHERE entity_id = $1 AND form_type = 'sua'`, [f.entityId]);
    // A directory where the file should go: the write fails with EISDIR.
    const r = await cli(['imss', 'sua', 'export', '--period', '2026-07', '-o', dir, '--yes', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(await suaFilings()).toBe(0);
  });

  it('a liability that does not match the file refuses it: exit 4, no file, no filing', async () => {
    await query(
      `UPDATE employer_tax_liabilities SET amount = amount + 1
        WHERE id = (SELECT id FROM employer_tax_liabilities WHERE entity_id = $1 AND tax_type = 'imss_employer' LIMIT 1)`,
      [f.entityId]
    );
    const file = join(dir, 'mismatch.txt');
    const r = await cli(['imss', 'sua', 'export', '--period', '2026-07', '-o', file, '--json']);
    expect(r.exitCode).toBe(4);
    expect(existsSync(file)).toBe(false);
    expect(await suaFilings()).toBe(0);
    // The refusal is keyed and carries both figures by code, not Spanish prose.
    const e = r.errs[0] as { key?: string; detail?: { findings: Array<Record<string, unknown>> } };
    expect(e.key).toBe('imss.sua.mismatch');
    expect(e.detail?.findings[0]).toMatchObject({ code: 'el_archivo_no_cuadra_con_el_pasivo', concept: 'imss_employer' });
    expect(e.detail?.findings[0].ledger_amount).not.toBe(e.detail?.findings[0].file_amount);
  });
});
