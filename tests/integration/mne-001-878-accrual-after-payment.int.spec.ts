import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { createPayRun, calculatePayRun, approvePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import {
  draftPayRunEntry,
  postPayRunEntry,
  type PayRunEntry,
} from '../../src/services/payroll/common/gl-posting-service.js';
import { approveDraft, canonicalDraftHash, getDraft, resolveReviewer, type DraftPayload } from '../../src/ai/draft-service.js';
import { resolveEntity } from '../../src/ai/context.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';
import { conductClose } from '../../src/services/accounting/closing-conductor.js';
import { planMonthlyProvisions, runMonthlyProvisions } from '../../src/services/accruals/provisions-run.js';
import { drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';

// ============================================================
// MNE-001-878 (#111), part 2 · THE MONTH'S ACCRUAL KNOWS WHAT THE RUN PAID
// OVER THE PROVISION
//
// A run paid before its month's close finds the provision one accrual short:
// the part it could not consume goes to wages, in a line of its own, and the
// close of that month would accrue the same days again. The accrual of a
// period now subtracts, benefit by benefit, what the pay runs of the period
// paid over the provision, never below zero. It measures it from what the
// runs paid (their earning lines) and what their entries debited to the
// provision's account: never from the text of a line.
//
// THE FIGURES ARE WORKED BY HAND. One worker, hired 2024-01-01, 365,000.00 a
// year: 1,000.00 a day, 15 days of the year-end bonus, 16 vacation days.
//
//   eleven closes (334 days)   1,000 × 15 × 334/365                = 13,726.0274
//   December alone             15,000.0000 − 13,726.0274           =  1,273.9726
//   paid on 15 December        15,000.00: 13,726.03 to 2202 (its nearest
//                              cent), 1,273.97 over the provision
//   December, after the run    1,273.9726 − 1,273.97               =      0.0026
//   2202 at the year's end     13,726.0274 − 13,726.03 + 0.0026    =      0.0000
//   the bonus in the year      13,726.0274 + 0.0026 + 1,273.97     = 15,000.0000
// ============================================================

const ELEVEN_CLOSES = '13726.0274';
const DECEMBER_ALONE = '1273.9726';
const OVER = 'Aguinaldo paid over its provision';

type Earning = { earning_type: string; amount: number; cfdi_clave_sat: string };
const salary = (amount: number): Earning => ({ earning_type: 'salary', amount, cfdi_clave_sat: '001' });
const yearEndBonus = (amount: number): Earning => ({ earning_type: 'aguinaldo', amount, cfdi_clave_sat: '002' });
const vacationDays = (amount: number): Earning => ({ earning_type: 'vacaciones', amount, cfdi_clave_sat: '001' });
const premium = (amount: number): Earning => ({ earning_type: 'prima_vacacional', amount, cfdi_clave_sat: '021' });

interface Company {
  f: Fixture;
  employeeId: string;
  periodId: string;
}

/** A company with one worker and the pay period 1 to 15 December, paid on the 15th. */
async function company(f: Fixture, annualSalary = '365000.00'): Promise<Company> {
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
       'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', '1049.3200', $6, '01',
       '02', $4, 'salary', 'MXN')`,
    [employeeId, f.tenantId, f.entityId, scheduleId, `C-${employeeId.slice(0, 8)}`, annualSalary]
  );
  const periodId = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-15', '2026-12-15', 2026, 'draft')`,
    [periodId, f.tenantId, scheduleId]
  );
  return { f, employeeId, periodId };
}

/** The run of 15 December, calculated and approved: the fortnight's salary and a year-end bonus, or the earnings given. */
async function runOfThe15th(c: Company, bonus: number | Earning[]): Promise<string> {
  const earnings = typeof bonus === 'number' ? [salary(15000), yearEndBonus(bonus)] : bonus;
  const input = {
    tenant_id: c.f.tenantId, pay_period_id: c.periodId, run_type: 'regular' as const, created_by: c.f.userId,
    employee_inputs: [{ employee_id: c.employeeId, earnings }],
  };
  const scope = entityScope(c.f.tenantId, c.f.entityId);
  const runId = await createPayRun(input, scope);
  await calculatePayRun(runId, input, scope);
  await approvePayRun(runId, c.f.userId, scope);
  return runId;
}

/** The run of 15 December, posted: its entry and the id of that entry. */
async function payOnThe15th(c: Company, bonus: number | Earning[]): Promise<{ entry: PayRunEntry; entryId: string }> {
  const posted = await postPayRunEntry(await runOfThe15th(c, bonus), c.f.userId, c.f.tenantId, c.f.entityId);
  return { entry: posted.entry, entryId: posted.journalEntryId };
}

/**
 * The run of 15 December through review: drafted, then approved by a person
 * who corrects the draft's lines first (`mnemosine review`, correct and approve).
 */
async function payThroughReview(
  c: Company,
  bonus: number,
  correct: (lines: DraftPayload['lines']) => DraftPayload['lines']
): Promise<void> {
  const { draftId } = await draftPayRunEntry(await runOfThe15th(c, bonus), c.f.tenantId, c.f.entityId);
  const ctx = await resolveEntity(c.f.entityId);
  const draft = await getDraft(ctx, draftId);
  if (!draft) throw new Error('test precondition: the draft exists');
  const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [c.f.userId])).rows[0].email;
  await approveDraft(ctx, draftId, await resolveReviewer(c.f.tenantId, email), 'MNE-001-878 spec', undefined, {
    payload: { ...draft.payload, lines: correct(draft.payload.lines) },
    basedOnHash: canonicalDraftHash(draft.payload, draft.origin ?? null),
  });
}

async function close(c: Company, month: number): Promise<Awaited<ReturnType<typeof runMonthlyProvisions>>> {
  const r = await runMonthlyProvisions(c.f.entityId, c.f.periodos[month], c.f.userId);
  expect(r.errors).toEqual([]);
  return r;
}

async function closeThrough(c: Company, months: number): Promise<void> {
  for (let m = 1; m <= months; m++) await close(c, m);
}

/** Posted balance of the account of a role, credit-positive. */
async function owed(c: Company, role: string): Promise<string> {
  const r = await query<{ balance: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0)::text AS balance
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $2 AND je.entity_id = $1 AND je.status = 'posted'`,
    [c.f.entityId, c.f.roles[role]]
  );
  return new Decimal(r.rows[0].balance).toFixed(4);
}

/** The debits of an entry to an account, by line description. */
function debitsTo(c: Company, entry: PayRunEntry, role: string): Record<string, string> {
  return Object.fromEntries(
    entry.lines
      .filter((l) => l.account_id === c.f.roles[role] && l.debit_amount !== null)
      .map((l) => [l.description.replace(/ for pay run .*/, ''), new Decimal(l.debit_amount as string).toFixed(2)])
  );
}

/** December closed by the conductor, stopped before its second step: what the accrual step says it did. */
async function closeStepDetail(c: Company): Promise<string | undefined> {
  const period = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number, fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number, false AS overdue
       FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1`,
    [c.f.periodos[12]]
  );
  const run = await conductClose(await resolveEntity(c.f.entityId), period.rows[0], { userId: c.f.userId, stopAt: 'amortize-prepaids' });
  return run.steps.find((x) => x.step === 'accrue-benefits')?.detail;
}

async function decemberRow(c: Company): Promise<{ bonus: string; over: string | null } | undefined> {
  const r = await query<{ bonus: string; over: string | null }>(
    `SELECT s.aguinaldo_amount::text AS bonus,
            s.calculation_metadata->'paid_over_provision'->>'aguinaldo' AS over
       FROM benefit_provision_schedules s
       JOIN journal_entries je ON je.id = s.journal_entry_id
      WHERE s.entity_id = $1 AND s.fiscal_period_id = $2
        AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL`,
    [c.f.entityId, c.f.periodos[12]]
  );
  return r.rows[0];
}

let before: Company;
let after: Company;
let late: Company;
let large: Company;
let reworded: Company;
let waiting: Company;
let unconsumed: Company;
let others: Company;
let advance: Company;

beforeAll(async () => {
  const root = await crearInquilino('MNE-001-878 · paid before the close');
  before = await company(root);
  after = await company(await crearEntidadHermana(root, 'MNE-001-878 · paid after the close'));
  late = await company(await crearEntidadHermana(root, 'MNE-001-878 · paid over, after the close'));
  large = await company(await crearEntidadHermana(root, 'MNE-001-878 · paid over the month'));
  reworded = await company(await crearEntidadHermana(root, 'MNE-001-878 · a line reworded in review'));
  waiting = await company(await crearEntidadHermana(root, 'MNE-001-878 · a draft still in review'));
  unconsumed = await company(await crearEntidadHermana(root, 'MNE-001-878 · a provision not consumed'));
  await closeThrough(before, 11);
  await closeThrough(after, 12);
  await closeThrough(large, 11);
  await closeThrough(reworded, 11);
  await closeThrough(waiting, 11);
  await closeThrough(unconsumed, 11);
  others = await company(await crearEntidadHermana(root, 'MNE-001-878 · vacations and premium paid over'));
  // 365.00 a day: every figure of this company is in whole cents.
  advance = await company(await crearEntidadHermana(root, 'MNE-001-878 · the month paid in advance'), '133225.00');
  await closeThrough(others, 11);
  await closeThrough(advance, 11);
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('paid on the 15th against eleven closes', () => {
  let runEntryId: string;
  let decemberEntryId: string;

  it('the run debits 13,726.03 to 2202 and names the 1,273.97 it paid over the provision in a line of its own', async () => {
    const { entry, entryId } = await payOnThe15th(before, 15000);
    runEntryId = entryId;
    expect(debitsTo(before, entry, 'provision_aguinaldo')).toEqual({ 'Aguinaldo paid against its provision': '13726.03' });
    expect(debitsTo(before, entry, 'sueldos_gasto')).toEqual({ 'Gross wages': '15000.00', [OVER]: '1273.97' });
  });

  it('the plan of December subtracts it: 1,273.9726 − 1,273.97 = 0.0026, and says so', async () => {
    const plan = await planMonthlyProvisions(before.f.entityId, before.f.periodos[12]);
    expect(plan.aguinaldo).toBe('0.0026');
    expect(plan.paidOverProvision).toEqual([
      { benefit: 'aguinaldo', excess: '1273.9700', subtracted: '1273.9700', left: '0.0000' },
    ]);
  });

  it('the close of December accrues 0.0026: 2202 ends the year at zero, and the year carries the bonus once', async () => {
    const r = await close(before, 12);
    decemberEntryId = r.journalEntryId as string;
    expect(r.aguinaldo).toBe('0.0026');
    expect(r.paidOverProvision).toEqual([
      { benefit: 'aguinaldo', excess: '1273.9700', subtracted: '1273.9700', left: '0.0000' },
    ]);
    expect(await owed(before, 'provision_aguinaldo')).toBe('0.0000');
    // The schedule row is what was posted, and keeps what was taken off it.
    expect(await decemberRow(before)).toEqual({ bonus: '0.0026', over: '1273.9700' });
    // By the closes 13,726.0274 + 0.0026, by the run 1,273.97: 15,000.00.
    const accrued = await query<{ total: string }>(
      `SELECT SUM(aguinaldo_amount)::text AS total FROM benefit_provision_schedules WHERE entity_id = $1`,
      [before.f.entityId]
    );
    expect(new Decimal(accrued.rows[0].total).plus('1273.97').toFixed(4)).toBe('15000.0000');
  });

  it('a second close of December posts nothing and moves no figure', async () => {
    const again = await close(before, 12);
    expect(again.journalEntryId).toBeNull();
    expect(again.processed).toBe(0);
    expect(await owed(before, 'provision_aguinaldo')).toBe('0.0000');
  });

  it('the accrual reversed and run again gives the same figure', async () => {
    await reverseJournalEntry(decemberEntryId, before.f.userId, { reason: 'MNE-001-878 spec' });
    const r = await close(before, 12);
    decemberEntryId = r.journalEntryId as string;
    expect(r.aguinaldo).toBe('0.0026');
    expect(await owed(before, 'provision_aguinaldo')).toBe('0.0000');
  });

  it('a reversed run no longer counts: December accrues its 1,273.9726 whole', async () => {
    await reverseJournalEntry(runEntryId, before.f.userId, { reason: 'MNE-001-878 spec' });
    await reverseJournalEntry(decemberEntryId, before.f.userId, { reason: 'MNE-001-878 spec' });
    const r = await close(before, 12);
    expect(r.aguinaldo).toBe(DECEMBER_ALONE);
    expect(r.paidOverProvision).toEqual([]);
    // The reversal gave 2202 its 13,726.03 back: the whole year is owed again.
    expect(await owed(before, 'provision_aguinaldo')).toBe('15000.0000');
  });
});

describe('paid on the 15th, booked after the close of December', () => {
  it('the provision holds the month\'s accrual: the run consumes the 15,000.00 and nothing is over', async () => {
    expect(await owed(after, 'provision_aguinaldo')).toBe('15000.0000');
    const { entry } = await payOnThe15th(after, 15000);
    expect(debitsTo(after, entry, 'provision_aguinaldo')).toEqual({ 'Aguinaldo paid against its provision': '15000.00' });
    expect(debitsTo(after, entry, 'sueldos_gasto')).toEqual({ 'Gross wages': '15000.00' });
    expect(await owed(after, 'provision_aguinaldo')).toBe('0.0000');
    const plan = await planMonthlyProvisions(after.f.entityId, after.f.periodos[12]);
    expect(plan.paidOverProvision).toEqual([]);
  });
});

describe('20,000.00 paid on the 15th, booked after the close of December', () => {
  it('5,000.00 is over a provision that held the month: the close reversed and run again accrues December whole', async () => {
    await closeThrough(late, 11);
    const december = await close(late, 12);
    expect(december.aguinaldo).toBe(DECEMBER_ALONE);
    const { entry } = await payOnThe15th(late, 20000);
    expect(debitsTo(late, entry, 'provision_aguinaldo')).toEqual({ 'Aguinaldo paid against its provision': '15000.00' });
    expect(debitsTo(late, entry, 'sueldos_gasto')).toEqual({ 'Gross wages': '15000.00', [OVER]: '5000.00' });

    // Reversed, the accrual leaves 2202 in debit by the 1,273.9726 the run took of it.
    await reverseJournalEntry(december.journalEntryId as string, late.f.userId, { reason: 'MNE-001-878 spec' });
    expect(await owed(late, 'provision_aguinaldo')).toBe(`-${DECEMBER_ALONE}`);
    // Run again it gives the same figure: nothing of the 5,000.00 comes off,
    // because the provision the run measured it against already held December.
    const again = await close(late, 12);
    expect(again.aguinaldo).toBe(DECEMBER_ALONE);
    expect(again.paidOverProvision).toEqual([
      { benefit: 'aguinaldo', excess: '5000.0000', subtracted: '0.0000', left: '5000.0000' },
    ]);
    expect(await owed(late, 'provision_aguinaldo')).toBe('0.0000');
  }, 120_000);
});

describe('paid over the provision by more than the month accrues', () => {
  it('20,000.00 paid: 6,273.97 over, December accrues no more than brings 2202 to zero, and the run names the 5,000.00 left as expense', async () => {
    expect(await owed(large, 'provision_aguinaldo')).toBe(ELEVEN_CLOSES);
    const { entry } = await payOnThe15th(large, 20000);
    expect(debitsTo(large, entry, 'sueldos_gasto')).toEqual({ 'Gross wages': '15000.00', [OVER]: '6273.97' });
    // 13,726.0274 − 13,726.03: the run left 2202 a fraction of a cent in debit.
    expect(await owed(large, 'provision_aguinaldo')).toBe('-0.0026');

    const r = await close(large, 12);
    // The floor is zero for the PROVISION: of December's 1,273.9726, 0.0026
    // brings 2202 back to zero and 1,273.97 comes off; the other 5,000.00
    // paid over the provision is more than the month accrues, and stays expense.
    expect(r.aguinaldo).toBe('0.0026');
    expect(r.paidOverProvision).toEqual([
      { benefit: 'aguinaldo', excess: '6273.9700', subtracted: '1273.9700', left: '5000.0000' },
    ]);
    expect(await decemberRow(large)).toEqual({ bonus: '0.0026', over: '1273.9700' });
    expect(await owed(large, 'provision_aguinaldo')).toBe('0.0000');
  });
});

describe('the excess is measured from facts, not from the text of a line', () => {
  it('a reviewer rewrites the description of the line paid over the provision: December is still 0.0026', async () => {
    await payThroughReview(reworded, 15000, (lines) =>
      lines.map((l) => (l.description === OVER ? { ...l, description: 'Bonus, the part with no provision' } : l)));
    const texts = await query<{ description: string }>(
      `SELECT jel.description FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.source_type = 'pay_run'`,
      [reworded.f.entityId]
    );
    expect(texts.rows.map((r) => r.description)).toContain('Bonus, the part with no provision');
    expect(texts.rows.map((r) => r.description)).not.toContain(OVER);

    // Paid 15,000.00 in earning lines of the benefit, 13,726.03 debited to 2202: 1,273.97 over.
    const r = await close(reworded, 12);
    expect(r.aguinaldo).toBe('0.0026');
    expect(r.paidOverProvision).toEqual([
      { benefit: 'aguinaldo', excess: '1273.9700', subtracted: '1273.9700', left: '0.0000' },
    ]);
    expect(await owed(reworded, 'provision_aguinaldo')).toBe('0.0000');
  }, 120_000);

  it('a reviewer moves the whole bonus to wages while 2202 holds 13,726.0274: only what is over that balance comes off', async () => {
    // The corrected entry debits nothing to 2202, as an entry of before the
    // rule: 15,000.00 paid and not debited, of which the provision still
    // holds 13,726.0274. Over the provision: 1,273.9726, all of December.
    await payThroughReview(unconsumed, 15000, (lines) => {
      const wages = lines.find((l) => l.description?.startsWith('Gross wages'));
      if (!wages) throw new Error('test precondition: the draft has its wages line');
      const rest = lines.filter((l) => l !== wages && l.description !== OVER
        && l.description !== 'Aguinaldo paid against its provision');
      return [{ ...wages, debit: 30000 }, ...rest];
    });
    expect(await owed(unconsumed, 'provision_aguinaldo')).toBe(ELEVEN_CLOSES);
    const r = await close(unconsumed, 12);
    expect(r.aguinaldo).toBe('0.0000');
    expect(r.paidOverProvision).toEqual([
      { benefit: 'aguinaldo', excess: '15000.0000', subtracted: DECEMBER_ALONE, left: ELEVEN_CLOSES },
    ]);
    // The 13,726.0274 stay in 2202 until a person corrects that entry (part 3).
    expect(await owed(unconsumed, 'provision_aguinaldo')).toBe(ELEVEN_CLOSES);
  }, 120_000);

  it('a run whose entry is still a draft in review is not counted: December accrues whole and names the run', async () => {
    const runId = await runOfThe15th(waiting, 15000);
    await draftPayRunEntry(runId, waiting.f.tenantId, waiting.f.entityId);
    const plan = await planMonthlyProvisions(waiting.f.entityId, waiting.f.periodos[12]);
    expect(plan.aguinaldo).toBe(DECEMBER_ALONE);
    expect(plan.paidOverProvision).toEqual([]);
    expect(plan.pendingPayRuns).toEqual([runId]);

    // The close accrues December whole (1,273.9726 + 1,358.9041 + 339.7260) and names the run.
    expect(await closeStepDetail(waiting)).toBe(
      `1 accrued, 0 skipped, 2972.6027 provisioned; 1 pay run(s) of the month still in review, not taken off: ${runId}`
    );
  }, 120_000);
});

// Sixteen vacation days and their premium of 25 %, eleven closes (334 days):
//   vacations   1,000 × 16 × 334/365 = 14,641.0959     December 1,358.9041
//   premium     1,000 ×  4 × 334/365 =  3,660.2740     December   339.7260
describe('vacation days and their premium paid over their provisions', () => {
  it('each provision takes its own excess off its own accrual, and the close says what it did not take off', async () => {
    const { entry } = await payOnThe15th(others, [salary(15000), vacationDays(16000), premium(4000)]);
    // To the nearest cent: 14,641.10 and 3,660.27 consumed, 1,358.90 and 339.73 over.
    expect(debitsTo(others, entry, 'provision_vacaciones')).toEqual({ 'Vacation days paid against their provision': '14641.10' });
    expect(debitsTo(others, entry, 'provision_prima_vacacional')).toEqual({ 'Vacation premium paid against its provision': '3660.27' });
    expect(debitsTo(others, entry, 'sueldos_gasto')).toEqual({
      'Gross wages': '15000.00',
      'Vacation days paid over their provision': '1358.90',
      'Vacation premium paid over its provision': '339.73',
    });

    // Vacations: 2203 is 0.0041 in debit, so of December's 1,358.9041 the
    // 0.0041 brings it to zero and 1,358.90 comes off. Premium: 2204 still
    // holds 0.0040, so 339.73 − 0.0040 = 339.7260 is over it: all of December.
    // The bonus was not paid: its 1,273.9726 accrue whole.
    const plan = await planMonthlyProvisions(others.f.entityId, others.f.periodos[12]);
    expect([plan.aguinaldo, plan.vacaciones, plan.prima_vacacional, plan.total])
      .toEqual([DECEMBER_ALONE, '0.0041', '0.0000', '1273.9767']);
    expect(plan.paidOverProvision).toEqual([
      { benefit: 'vacaciones', excess: '1358.9000', subtracted: '1358.9000', left: '0.0000' },
      { benefit: 'prima_vacacional', excess: '339.7300', subtracted: '339.7260', left: '0.0040' },
    ]);

    expect(await closeStepDetail(others)).toBe(
      '1 accrued, 0 skipped, 1273.9767 provisioned; vacaciones: 1358.9000 taken off, paid over its provision; ' +
        'prima_vacacional: 339.7260 taken off, paid over its provision (0.0040 not taken off)'
    );
    expect(await owed(others, 'provision_vacaciones')).toBe('0.0000');
    expect(await owed(others, 'provision_prima_vacacional')).toBe('0.0040');
    expect(await owed(others, 'provision_aguinaldo')).toBe('15000.0000');
  }, 120_000);
});

// 365.00 a day (133,225.00 a year), eleven closes: bonus 365 × 15 × 334/365 =
// 5,010.00, vacations 365 × 16 × 334/365 = 5,344.00, premium 1,336.00. The
// whole year is 5,475.00, 5,840.00 and 1,460.00: December is 465.00, 496.00
// and 124.00.
describe('the whole year of the three benefits paid on the 15th', () => {
  it('December is wholly paid: no row and no entry are written, the worker is named with the reason, and a second close says the same', async () => {
    const { entry } = await payOnThe15th(advance, [salary(5475), yearEndBonus(5475), vacationDays(5840), premium(1460)]);
    expect(debitsTo(advance, entry, 'sueldos_gasto')).toEqual({
      'Gross wages': '5475.00',
      'Aguinaldo paid over its provision': '465.00',
      'Vacation days paid over their provision': '496.00',
      'Vacation premium paid over its provision': '124.00',
    });

    for (const attempt of ['first', 'second']) {
      const plan = await planMonthlyProvisions(advance.f.entityId, advance.f.periodos[12]);
      expect(plan.rows, attempt).toEqual([]);
      expect(plan.skipped.map((x) => [x.worker.id, x.reason]), attempt).toEqual([[advance.employeeId, 'paid-over-provision']]);
      expect(plan.total, attempt).toBe('0.0000');
      const r = await close(advance, 12);
      expect([r.processed, r.skipped, r.journalEntryId, r.total], attempt).toEqual([0, 1, null, '0.0000']);
      expect(r.paidOverProvision, attempt).toEqual([
        { benefit: 'aguinaldo', excess: '465.0000', subtracted: '465.0000', left: '0.0000' },
        { benefit: 'vacaciones', excess: '496.0000', subtracted: '496.0000', left: '0.0000' },
        { benefit: 'prima_vacacional', excess: '124.0000', subtracted: '124.0000', left: '0.0000' },
      ]);
    }
    expect(await decemberRow(advance)).toBeUndefined();
    // Each provision was consumed whole by the run, and December added nothing.
    for (const role of ['provision_aguinaldo', 'provision_vacaciones', 'provision_prima_vacacional']) {
      expect(await owed(advance, role), role).toBe('0.0000');
    }
  }, 120_000);
});
