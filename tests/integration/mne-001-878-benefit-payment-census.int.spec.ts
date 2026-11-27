import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { createPayRun, calculatePayRun, approvePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { draftPayRunEntry, postPayRunEntry } from '../../src/services/payroll/common/gl-posting-service.js';
import { censusBenefitPayments } from '../../src/services/payroll/common/benefit-payment-census.js';
import { runMonthlyProvisions } from '../../src/services/accruals/provisions-run.js';
import { drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { approveDraft, canonicalDraftHash, getDraft, resolveReviewer } from '../../src/ai/draft-service.js';
import { resolveEntity } from '../../src/ai/context.js';
import { queryAccountBalance } from '../../src/services/reporting/report-service.js';

// ============================================================
// MNE-001-878 (#111), part 3 · THE CENSUS OF BENEFITS PAID TO WAGES WHILE
// THEIR PROVISION HELD THEM
//
// An entry of before the rule debited the whole gross to wages. Here it is
// made the one way the system still can: a person corrects the run's draft in
// review and moves the provision's debit to wages. The census must name it
// from what the run paid and what its entry debited, with its month and the
// amount a correction would move, and write nothing.
//
// THE FIGURES ARE WORKED BY HAND. One worker, hired 2024-01-01, 1,000.00 a
// day, sixteen vacation days in 2026 and a premium of 25 %: four days a year.
//
//   six closes (181 days)     1,000 × 4 × 181/365 = 1,983.5616
//   seven closes (212 days)   1,000 × 4 × 212/365 = 2,323.2877
// ============================================================

const SIX_CLOSES = '1983.5616';
const SEVEN_CLOSES = '2323.2877';

interface Company {
  f: Fixture;
  employeeId: string;
  scheduleId: string;
}

async function company(f: Fixture): Promise<Company> {
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
  const scheduleId = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
     VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
    [scheduleId, f.tenantId, f.entityId]
  );
  const employeeId = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, status, country_code, rfc, curp, nss, sbc, annual_salary, riesgo_puesto,
       tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
     VALUES ($1, $2, $3, $5, 'Trabajador', 'De Prueba', '2024-01-01', 'active', 'MX',
       'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', '1049.3200', '365000.00', '01',
       '02', $4, 'salary', 'MXN')`,
    [employeeId, f.tenantId, f.entityId, scheduleId, `P-${employeeId.slice(0, 8)}`]
  );
  return { f, employeeId, scheduleId };
}

/** A run of the first fortnight of a month, paid on the 15th: salary and a vacation premium. Approved. */
async function runOfThe15th(c: Company, month: string, premium: number): Promise<string> {
  const periodId = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
    [periodId, c.f.tenantId, c.scheduleId, `2026-${month}-01`, `2026-${month}-15`]
  );
  const input = {
    tenant_id: c.f.tenantId, pay_period_id: periodId, run_type: 'regular' as const, created_by: c.f.userId,
    employee_inputs: [{
      employee_id: c.employeeId,
      earnings: [
        { earning_type: 'salary', amount: 15000, cfdi_clave_sat: '001' },
        { earning_type: 'prima_vacacional', amount: premium, cfdi_clave_sat: '021' },
      ],
    }],
  };
  const scope = entityScope(c.f.tenantId, c.f.entityId);
  const runId = await createPayRun(input, scope);
  await calculatePayRun(runId, input, scope);
  await approvePayRun(runId, c.f.userId, scope);
  return runId;
}

/**
 * The run booked as before the rule: its draft corrected in review so that
 * the whole gross is wages and the provision is not debited. Returns the entry.
 */
async function bookedAsBeforeTheRule(c: Company, month: string, premium: number): Promise<{ runId: string; entryId: string }> {
  const runId = await runOfThe15th(c, month, premium);
  const { draftId } = await draftPayRunEntry(runId, c.f.tenantId, c.f.entityId);
  const ctx = await resolveEntity(c.f.entityId);
  const draft = await getDraft(ctx, draftId);
  if (!draft) throw new Error('test precondition: the draft exists');
  const provision = c.f.roles.provision_prima_vacacional;
  const code = (await query<{ code: string }>('SELECT code FROM accounts WHERE id = $1', [provision])).rows[0].code;
  const wages = draft.payload.lines.find((l) => l.description?.startsWith('Gross wages'));
  if (!wages) throw new Error('test precondition: the draft has its wages line');
  const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [c.f.userId])).rows[0].email;
  const posted = await approveDraft(ctx, draftId, await resolveReviewer(c.f.tenantId, email), 'MNE-001-878 spec', undefined, {
    payload: {
      ...draft.payload,
      lines: [
        { ...wages, debit: 15000 + premium },
        // Found by account, as the census finds it: the line the rule wrote to the provision goes.
        ...draft.payload.lines.filter((l) => l !== wages && l.account_code !== code),
      ],
    },
    basedOnHash: canonicalDraftHash(draft.payload, draft.origin ?? null),
  });
  return { runId, entryId: posted.entryId };
}

async function closeMonths(c: Company, from: number, to: number): Promise<void> {
  for (let m = from; m <= to; m++) {
    expect((await runMonthlyProvisions(c.f.entityId, c.f.periodos[m], c.f.userId)).errors).toEqual([]);
  }
}

/** What 2204 holds, credit-positive, from the report layer. */
const held = async (c: Company): Promise<string> =>
  (await queryAccountBalance(c.f.entityId, c.f.roles.provision_prima_vacacional)).negated().toFixed(4);

const census = (c: Company) => censusBenefitPayments({ tenantId: c.f.tenantId, entityId: c.f.entityId });

/** What the census says of each payment, as the report prints it. */
const named = async (c: Company): Promise<string[]> =>
  (await census(c)).findings.map((x) =>
    `${x.month} ${x.benefit} ${x.provisionAccount} paid ${x.paid} debited ${x.debited} expensed while held ${x.expensedWhileHeld}`);

async function written(c: Company): Promise<string> {
  const r = await query<{ entries: string; lines: string; drafts: string }>(
    `SELECT (SELECT count(*) FROM journal_entries WHERE entity_id = $1)::text AS entries,
            (SELECT count(*) FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
              WHERE e.entity_id = $1)::text AS lines,
            (SELECT count(*) FROM ai_drafts WHERE entity_id = $1)::text AS drafts`,
    [c.f.entityId]
  );
  return JSON.stringify(r.rows[0]);
}

let past: Company;
let clean: Company;
let july: { runId: string; entryId: string };
let august: { runId: string; entryId: string };

beforeAll(async () => {
  const root = await crearInquilino('MNE-001-878 · entries of before the rule');
  past = await company(root);
  clean = await company(await crearEntidadHermana(root, 'MNE-001-878 · entries of the rule only'));
  await closeMonths(past, 1, 6);
  await closeMonths(clean, 1, 6);
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('two runs booked whole to wages while 2204 held the premium', () => {
  it('names each with its month and what a correction would move, the second only for what the first leaves', async () => {
    // July: 1,500.00 paid, nothing debited, and 2204 holds 1,983.5616.
    expect(await held(past)).toBe(SIX_CLOSES);
    july = await bookedAsBeforeTheRule(past, '07', 1500);
    expect(await held(past)).toBe(SIX_CLOSES);
    // The close of July accrues the month whole: what the run paid was not over a provision that held it.
    await closeMonths(past, 7, 7);
    // August: 1,000.00 paid, nothing debited. 2204 holds 2,323.2877 at the end of both months.
    august = await bookedAsBeforeTheRule(past, '08', 1000);

    const result = await census(past);
    expect(result.findings.map((x) => [x.entryId, x.runId, x.entryDate])).toEqual([
      [july.entryId, july.runId, '2026-07-15'],
      [august.entryId, august.runId, '2026-08-15'],
    ]);
    // July takes its 1,500.00; August finds 2,323.2877 − 1,500.00 = 823.2877, 823.29 in cents.
    expect(await named(past)).toEqual([
      '2026-07 prima_vacacional 2204 paid 1500.00 debited 0.00 expensed while held 1500.00',
      '2026-08 prima_vacacional 2204 paid 1000.00 debited 0.00 expensed while held 823.29',
    ]);
    expect(result.provisions).toEqual([
      { benefit: 'prima_vacacional', account: '2204', heldNow: SEVEN_CLOSES, expensedWhileHeld: '2323.29' },
    ]);
  }, 120_000);

  it('writes nothing: the entries, their lines and the drafts are the ones there were', async () => {
    const before = await written(past);
    await census(past);
    await census(past);
    expect(await written(past)).toBe(before);
  });

  it('a later run that consumed 2,000.00 leaves 323.29 to correct, on the oldest entry', async () => {
    const run = await runOfThe15th(past, '09', 2000);
    await postPayRunEntry(run, past.f.userId, past.f.tenantId, past.f.entityId);
    // 2,323.2877 − 2,000.00 = 323.2877 held today. The September run debited
    // what it paid, so the census does not name it.
    expect(await named(past)).toEqual([
      '2026-07 prima_vacacional 2204 paid 1500.00 debited 0.00 expensed while held 323.29',
    ]);
    expect((await census(past)).provisions).toEqual([
      { benefit: 'prima_vacacional', account: '2204', heldNow: '323.2877', expensedWhileHeld: '323.29' },
    ]);
  }, 120_000);

  it('a reversed run is as if it had not paid: August takes the 323.29', async () => {
    await reverseJournalEntry(july.entryId, past.f.userId, { reason: 'MNE-001-878 spec' });
    expect(await named(past)).toEqual([
      '2026-08 prima_vacacional 2204 paid 1000.00 debited 0.00 expensed while held 323.29',
    ]);
  });
});

describe('an entity whose entries all follow the rule', () => {
  it('a run that paid over its provision is not named: 2,500.00 against 1,983.5616 left nothing held', async () => {
    const run = await runOfThe15th(clean, '07', 2500);
    const { entry } = await postPayRunEntry(run, clean.f.userId, clean.f.tenantId, clean.f.entityId);
    // 1,983.56 to 2204 and 516.44 over it: 2204 holds 0.0016.
    expect(entry.lines.filter((l) => l.account_id === clean.f.roles.provision_prima_vacacional).map((l) => l.debit_amount))
      .toEqual(['1983.56']);
    expect(await census(clean)).toEqual({ entityId: clean.f.entityId, findings: [], provisions: [] });
    // And the other company's entries are not this one's.
    expect((await census(past)).findings.every((x) => x.entryId === august.entryId)).toBe(true);
  }, 120_000);
});
