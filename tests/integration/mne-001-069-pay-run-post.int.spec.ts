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
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { approveDraft, resolveReviewer } from '../../src/ai/draft-service.js';
import { resolveEntity } from '../../src/ai/context.js';
import { registerPayRunCommand } from '../../src/cli/pay-run-command.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
// The calculators register on import; without it the MX engine is empty.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// MNE-001-069 (#306, part 3/4) · THE ENTRY OF A RUN FROM THE TERMINAL
//
// `pay-run post` against a migrated Postgres, over runs created, calculated
// and approved through the CLI (MNE-001-068). What this pins, as the catalog
// row fixes it: by default the entry is a DRAFT for `mnemosine review`, and
// `--post` is the escape that posts it; the entry balances; and one run has
// one entry, whichever road it took.
// ============================================================

// State payroll tax rates are a GLOBAL catalog; this file seeds one.
apartarCatalogos('mx_isn_tasas_estatales');

let f: Fixture;
let sibling: Fixture;
let email: string;
let periodId: string;
let employees: string[];
let inputsFile: string;

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

interface CliResult { exitCode?: number; out: string; err: string; errs: unknown[] }

async function cli(argv: string[], entityId = f.entityId, confirm = true): Promise<CliResult> {
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
      confirm: async () => confirm,
    });
    await p.parseAsync(['node', 'mnemosine', 'pay-run', ...argv, '-e', entityId, '-t', f.tenantId, '-u', email]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return { exitCode, out: out.join(''), err: err.join(''), errs };
}

const rowOf = (r: CliResult): Record<string, unknown> =>
  (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];

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

/** A run created and calculated through the CLI; approved too unless told otherwise. */
async function calculatedRun(approve = true): Promise<string> {
  const created = await cli(['create', '--period', periodId, '--json']);
  expect(created.exitCode, String(created.errs[0])).toBe(0);
  const id = String(rowOf(created).id);
  const calc = await cli(['calculate', id, '--file', inputsFile, '--json']);
  expect(calc.exitCode, String(calc.errs[0])).toBe(0);
  if (approve) {
    const ok = await cli(['approve', id, '--yes', '--json']);
    expect(ok.exitCode, String(ok.errs[0])).toBe(0);
  }
  return id;
}

const draftsOf = async (runId: string) =>
  (await query<{ id: string; status: string; ai_model: string }>(
    `SELECT id, status, ai_model FROM ai_drafts WHERE entity_id = $1 AND payload->>'reference' = $2`,
    [f.entityId, `pay-run:${runId}`]
  )).rows;

const entriesOf = async (runId: string) =>
  (await query<{ id: string; status: string; total_debits: string; total_credits: string }>(
    `SELECT id, status, total_debits::text AS total_debits, total_credits::text AS total_credits
       FROM journal_entries WHERE entity_id = $1 AND source_type = 'pay_run' AND source_id = $2`,
    [f.entityId, runId]
  )).rows;

const linkOf = async (runId: string): Promise<string | null> =>
  (await query<{ journal_entry_id: string | null }>('SELECT journal_entry_id FROM pay_runs WHERE id = $1', [runId]))
    .rows[0].journal_entry_id;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-069 · pay run entry from the terminal');
  sibling = await crearEntidadHermana(f, 'MNE-001-069 · sibling');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  await query(
    `INSERT INTO mx_isn_tasas_estatales (estado, vigencia_desde, vigencia_hasta, tasa, regimen, exencion_mensual, fundamento)
     VALUES ('JA', '2026-01-01', NULL, 0.03, 'tasa_plana', NULL, 'Ley de Hacienda del Estado de Jalisco, art. 39')`
  );
  const scheduleId = uuidv4();
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
  employees = [await employee(scheduleId, 'P-001', '400.0000'), await employee(scheduleId, 'P-002', '650.0000')];
  inputsFile = join(mkdtempSync(join(tmpdir(), 'mne069-')), 'inputs.json');
  writeFileSync(
    inputsFile,
    JSON.stringify([
      { employee_id: employees[0], earnings: [{ earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' }] },
      { employee_id: employees[1], earnings: [{ earning_type: 'salary', amount: 9750, cfdi_clave_sat: '001' }] },
    ])
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('pay-run post: a draft for review by default', () => {
  let runId: string;

  it('a run that is only calculated is blocked, and nothing is written', async () => {
    runId = await calculatedRun(false);
    const r = await cli(['post', runId, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(5);
    expect(await draftsOf(runId)).toEqual([]);
    expect(await entriesOf(runId)).toEqual([]);
  });

  it('--dry-run shows a balanced entry and writes nothing', async () => {
    await cli(['approve', runId, '--yes', '--json']);
    const r = await cli(['post', runId, '--dry-run', '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const row = rowOf(r);
    expect(row.mode).toBe('dry_run');
    expect(row.total_debits).toBe(row.total_credits);
    expect(await draftsOf(runId)).toEqual([]);
    expect(await entriesOf(runId)).toEqual([]);
  });

  it('from the sibling company the run does not exist', async () => {
    const r = await cli(['post', runId, '--json'], sibling.entityId);
    expect(r.exitCode, String(r.errs[0])).toBe(3);
    expect(await draftsOf(runId)).toEqual([]);
  });

  it('without --post the entry is a pending draft, and the ledger is untouched', async () => {
    const r = await cli(['post', runId, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const row = rowOf(r);
    expect(row.mode).toBe('draft');
    const drafts = await draftsOf(runId);
    expect(drafts).toEqual([{ id: row.draft_id, status: 'pending_review', ai_model: 'mnemosine/payroll' }]);
    expect(await entriesOf(runId)).toEqual([]);
    expect(await linkOf(runId)).toBeNull();
    // The gross wages line is the run's gross, to the cent.
    const { rows } = await query<{ total_gross: string }>('SELECT total_gross::text FROM pay_runs WHERE id = $1', [runId]);
    const lines = row.lines as Array<{ debit: string | null; description: string }>;
    const wages = lines.find((l) => l.description.startsWith('Gross wages'));
    expect(new Decimal(String(wages?.debit)).equals(rows[0].total_gross)).toBe(true);
  });

  it('while the draft waits, neither another draft nor --post can book the run again', async () => {
    expect((await cli(['post', runId, '--json'])).exitCode).toBe(5);
    expect((await cli(['post', runId, '--post', '--yes', '--json'])).exitCode).toBe(5);
    expect(await draftsOf(runId)).toHaveLength(1);
    expect(await entriesOf(runId)).toEqual([]);
  });

  it('approved in review it posts balanced, and the run cannot be posted again', async () => {
    const [draft] = await draftsOf(runId);
    const ctx = await resolveEntity(f.entityId);
    const reviewer = await resolveReviewer(f.tenantId, email);
    const posted = await approveDraft(ctx, draft.id, reviewer, 'MNE-001-069 test');
    const { rows } = await query<{ status: string; total_debits: string; total_credits: string }>(
      'SELECT status, total_debits::text AS total_debits, total_credits::text AS total_credits FROM journal_entries WHERE id = $1',
      [posted.entryId]
    );
    expect(rows[0].status).toBe('posted');
    expect(new Decimal(rows[0].total_debits).equals(rows[0].total_credits)).toBe(true);
    expect((await cli(['post', runId, '--post', '--yes', '--json'])).exitCode).toBe(5);
  });
});

describe('pay-run post --post: the escape', () => {
  let runId: string;

  it('a no at the prompt posts nothing', async () => {
    runId = await calculatedRun();
    const r = await cli(['post', runId, '--post', '--json'], f.entityId, false);
    expect(r.exitCode).toBe(10);
    expect(await entriesOf(runId)).toEqual([]);
  });

  it('posts one balanced entry, links it to the run, and leaves no draft', async () => {
    const r = await cli(['post', runId, '--post', '--yes', '--idempotency-key', `p-${runId}`, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    const row = rowOf(r);
    expect(row.mode).toBe('posted');
    const entries = await entriesOf(runId);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('posted');
    expect(new Decimal(entries[0].total_debits).equals(entries[0].total_credits)).toBe(true);
    expect(await linkOf(runId)).toBe(entries[0].id);
    expect(row.journal_entry_id).toBe(entries[0].id);
    expect(await draftsOf(runId)).toEqual([]);
  });

  it('a retry with the same key returns the recorded result, and there is still one entry', async () => {
    const r = await cli(['post', runId, '--post', '--yes', '--idempotency-key', `p-${runId}`, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(0);
    expect(rowOf(r).repeated).toBe(true);
    expect(await entriesOf(runId)).toHaveLength(1);
  });

  it('without the key a second post is blocked by state, not written twice', async () => {
    expect((await cli(['post', runId, '--post', '--yes', '--json'])).exitCode).toBe(5);
    expect((await cli(['post', runId, '--json'])).exitCode).toBe(5);
    expect(await entriesOf(runId)).toHaveLength(1);
    expect(await draftsOf(runId)).toEqual([]);
  });
});
