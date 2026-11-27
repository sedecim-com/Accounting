import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { getPolicy, reopenPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { createPayRun, calculatePayRun, approvePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import {
  draftPayRunEntry,
  postPayRunEntry,
  previewPayRunEntry,
  type PayRunEntry,
} from '../../src/services/payroll/common/gl-posting-service.js';
import { runMonthlyProvisions } from '../../src/services/accruals/provisions-run.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveDraft, resolveReviewer } from '../../src/ai/draft-service.js';
import { resolveEntity } from '../../src/ai/context.js';

// ============================================================
// MNE-001-878 (#111) · A BENEFIT PAID IN A PAY RUN CONSUMES ITS PROVISION
//
// The close accrues aguinaldo, vacations and vacation premium to 6116 against
// 2202, 2203 and 2204 (NIF D-3). The pay-run entry debited the whole gross to
// 6110, so the benefit was expensed twice and the liability never cleared.
// The panel key `benefit_payment_against_provision` (default
// `consume_provision`) decides it.
//
// THE FIGURES ARE WORKED BY HAND. One worker, hired 2024-01-01, annual salary
// 365,000.00: 1,000.00 a day (÷ 365). 2026 is the third year of service: 16
// vacation days (LFT art. 76), 15 days of aguinaldo, a premium of 25 %.
//
//   a full year of closes          aguinaldo  1,000 × 15 × 365/365 = 15,000.0000
//   eleven closes (334 days)       aguinaldo  1,000 × 15 × 334/365 = 13,726.0274
//                                  vacations  1,000 × 16 × 334/365 = 14,641.0959
//                                  premium    1,000 ×  4 × 334/365 =  3,660.2740
//
// The accrual posts four decimals and the pay-run entry posts cents (the
// review road rounds every draft line to cents), so a provision gives what it
// holds to its nearest cent: 13,726.0274 gives 13,726.03.
// ============================================================

const FULL_YEAR_BONUS = '15000.0000';
const ELEVEN = { aguinaldo: '13726.0274', vacations: '14641.0959', premium: '3660.2740' } as const;

const KEY = 'benefit_payment_against_provision';

type Earning = { earning_type: string; amount: number; cfdi_clave_sat: string };
const salary = (amount: number): Earning => ({ earning_type: 'salary', amount, cfdi_clave_sat: '001' });
const yearEndBonus = (amount: number): Earning => ({ earning_type: 'aguinaldo', amount, cfdi_clave_sat: '002' });
const premium = (amount: number): Earning => ({ earning_type: 'prima_vacacional', amount, cfdi_clave_sat: '021' });
const vacationDays = (amount: number): Earning => ({ earning_type: 'pto', amount, cfdi_clave_sat: '001' });

interface Company {
  f: Fixture;
  employeeId: string;
  /** Opens a pay period, paid on its last day. */
  period: (start: string, end: string) => Promise<string>;
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
    // The employee number is unique in the tenant, and the three companies share one.
    [employeeId, f.tenantId, f.entityId, scheduleId, `B-${employeeId.slice(0, 8)}`]
  );
  const period = async (start: string, end: string): Promise<string> => {
    const id = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [id, f.tenantId, scheduleId, start, end]
    );
    return id;
  };
  return { f, employeeId, period };
}

/** A run calculated and approved by the services the CLI calls. */
async function approvedRun(
  c: Company,
  periodId: string,
  runType: 'regular' | 'bonus' | 'off_cycle',
  earnings: Earning[]
): Promise<string> {
  const input = {
    tenant_id: c.f.tenantId, pay_period_id: periodId, run_type: runType, created_by: c.f.userId,
    employee_inputs: [{ employee_id: c.employeeId, earnings }],
  };
  const scope = entityScope(c.f.tenantId, c.f.entityId);
  const runId = await createPayRun(input, scope);
  await calculatePayRun(runId, input, scope);
  await approvePayRun(runId, c.f.userId, scope);
  return runId;
}

async function accrue(c: Company, months: number): Promise<void> {
  for (let m = 1; m <= months; m++) {
    const r = await runMonthlyProvisions(c.f.entityId, c.f.periodos[m], c.f.userId);
    expect(r.errors).toEqual([]);
  }
}

/** Posted balance of an account, credit-positive, every posted entry. */
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

const expensed = async (c: Company, role: string): Promise<string> =>
  new Decimal(await owed(c, role)).negated().toFixed(4);

/** What an entry debits to the wages account and to each provision, by role. */
function charged(c: Company, entry: PayRunEntry): Record<string, string> {
  const roleOf = new Map(
    ['sueldos_gasto', 'provision_aguinaldo', 'provision_vacaciones', 'provision_prima_vacacional']
      .map((role) => [c.f.roles[role], role])
  );
  const out: Record<string, string> = {};
  for (const l of entry.lines) {
    const role = roleOf.get(l.account_id);
    if (role && l.debit_amount !== null) out[role] = new Decimal(l.debit_amount).toFixed(4);
  }
  return out;
}

const preview = (c: Company, runId: string): Promise<PayRunEntry> =>
  previewPayRunEntry(runId, c.f.tenantId, c.f.entityId);

/** The firm's answer; a second answer reopens the first, as `pending` does. */
async function answer(c: Company, value: string): Promise<void> {
  const ctx = { tenantId: c.f.tenantId, entityId: c.f.entityId };
  if ((await getPolicy(ctx, KEY)).defined) await reopenPolicy(ctx, KEY);
  await resolvePolicy(ctx, KEY, value, c.f.userId, 'MNE-001-878 spec');
}

/** Every statement sent to Postgres while `fn` runs. */
async function statementsOf(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

let full: Company;
let eleven: Company;
let none: Company;

beforeAll(async () => {
  const root = await crearInquilino('MNE-001-878 · a full year accrued');
  full = await company(root);
  eleven = await company(await crearEntidadHermana(root, 'MNE-001-878 · eleven closes'));
  none = await company(await crearEntidadHermana(root, 'MNE-001-878 · does not accrue'));
  await accrue(full, 12);
  await accrue(eleven, 11);
}, 300_000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the case of the acceptance: twelve closes, then the December run pays the aguinaldo', () => {
  it('twelve closes leave 15,000.00 in 2202 and nothing in 6110', async () => {
    expect(await owed(full, 'provision_aguinaldo')).toBe(FULL_YEAR_BONUS);
    expect(await expensed(full, 'sueldos_gasto')).toBe('0.0000');
  });

  it('the run debits 2202 for the 15,000.00 paid and 6110 only for the salary: 2202 ends at 0.00', async () => {
    const runId = await approvedRun(full, await full.period('2026-12-16', '2026-12-31'), 'regular',
      [salary(15000), yearEndBonus(15000)]);
    const { entry } = await postPayRunEntry(runId, full.f.userId, full.f.tenantId, full.f.entityId);

    // Gross 30,000.00: the aguinaldo against its provision, the salary to expense.
    expect(charged(full, entry)).toEqual({ provision_aguinaldo: '15000.0000', sueldos_gasto: '15000.0000' });
    expect(entry.totalDebits).toBe(entry.totalCredits);
    expect(await owed(full, 'provision_aguinaldo')).toBe('0.0000');
    // The year carries the aguinaldo once (in 6116, by the closes): 6110 holds
    // the fortnight's salary alone. On the code before this task it held 30,000.00.
    expect(await expensed(full, 'sueldos_gasto')).toBe('15000.0000');
    // Vacations and premium were not paid: their provisions stay whole.
    expect(await owed(full, 'provision_vacaciones')).toBe('16000.0000');
    expect(await owed(full, 'provision_prima_vacacional')).toBe('4000.0000');
  });
});

describe('eleven closes, then runs paid on 15 December', () => {
  let main: string;
  let firstPremium: string;
  let secondPremium: string;
  let salaryOnly: string;
  let draftId: string;

  beforeAll(async () => {
    const period = await eleven.period('2026-12-01', '2026-12-15');
    // Aguinaldo over its provision, vacation days under theirs.
    main = await approvedRun(eleven, period, 'regular', [salary(15000), yearEndBonus(15000), vacationDays(2000)]);
    firstPremium = await approvedRun(eleven, period, 'bonus', [premium(3000)]);
    secondPremium = await approvedRun(eleven, period, 'off_cycle', [premium(1000)]);
    salaryOnly = await approvedRun(eleven, await eleven.period('2026-12-16', '2026-12-31'), 'regular', [salary(15000)]);
  }, 120_000);

  it('the provisions hold what eleven months of days give', async () => {
    expect(await owed(eleven, 'provision_aguinaldo')).toBe(ELEVEN.aguinaldo);
    expect(await owed(eleven, 'provision_vacaciones')).toBe(ELEVEN.vacations);
    expect(await owed(eleven, 'provision_prima_vacacional')).toBe(ELEVEN.premium);
  });

  it('expense_on_payment is refused while the provision of a benefit the run pays carries a balance', async () => {
    await answer(eleven, 'expense_on_payment');
    const refused = await preview(eleven, main).then(() => null, (e: unknown) => e as { code?: string; messageKey?: { key: string; params: Record<string, unknown> } });
    await answer(eleven, 'consume_provision');
    expect(refused?.code).toBe('BENEFIT_PAYMENT_EXPENSED_WHILE_ACCRUED');
    expect(refused?.messageKey?.key).toBe('payroll.benefit_payment.expensed_while_accrued');
    expect(refused?.messageKey?.params).toMatchObject({ key: KEY, account: '2202', balance: '13726.03' });
  });

  it('a draft holds what it will consume: the next run consumes only what is left, and expenses the rest', async () => {
    const drafted = await draftPayRunEntry(firstPremium, eleven.f.tenantId, eleven.f.entityId);
    draftId = drafted.draftId;
    expect(charged(eleven, drafted.entry)).toEqual({ provision_prima_vacacional: '3000.0000' });
    // Nothing is posted yet: the ledger still shows 3,660.2740.
    expect(await owed(eleven, 'provision_prima_vacacional')).toBe(ELEVEN.premium);
    // 3,660.2740 − 3,000.00 held = 660.2740, 660.27 in cents, for the second
    // premium of 1,000.00; the other 339.73 is expense.
    expect(charged(eleven, await preview(eleven, secondPremium)))
      .toEqual({ provision_prima_vacacional: '660.2700', sueldos_gasto: '339.7300' });
  });

  it('the excess over the provision goes to expense, and what is not paid stays in the provision', async () => {
    const { entry } = await postPayRunEntry(main, eleven.f.userId, eleven.f.tenantId, eleven.f.entityId);
    // Gross 32,000.00. Aguinaldo 15,000.00 against 13,726.03: 1,273.97 over.
    // Vacation days 2,000.00 against 14,641.0959. Expense: 15,000 + 1,273.97.
    expect(charged(eleven, entry)).toEqual({
      provision_aguinaldo: '13726.0300',
      provision_vacaciones: '2000.0000',
      sueldos_gasto: '16273.9700',
    });
    expect(entry.totalDebits).toBe(entry.totalCredits);
    // 13,726.0274 − 13,726.03: the fraction of a cent joins the next accrual.
    expect(await owed(eleven, 'provision_aguinaldo')).toBe('-0.0026');
    expect(await owed(eleven, 'provision_vacaciones')).toBe('12641.0959'); // 14,641.0959 − 2,000
  });

  it('the draft approved in review posts its debit to 2204', async () => {
    const ctx = await resolveEntity(eleven.f.entityId);
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [eleven.f.userId])).rows[0].email;
    await approveDraft(ctx, draftId, await resolveReviewer(eleven.f.tenantId, email), 'MNE-001-878 spec');
    expect(await owed(eleven, 'provision_prima_vacacional')).toBe('660.2740');
  });

  it('a run that pays no benefit costs one statement more, and one that pays them five more than that', async () => {
    // The attestations of the entries posted above run on their own connections.
    await drainAttestations(5000);
    const plain = await statementsOf(() => preview(eleven, salaryOnly));
    const paying = await statementsOf(() => preview(eleven, secondPremium));
    // The panel key, the provision accounts under lock, the two balances
    // (everything posted, and to the pay date) and what pending drafts hold.
    expect(paying - plain).toBe(5);
    expect(charged(eleven, await preview(eleven, salaryOnly))).toEqual({ sueldos_gasto: '15000.0000' });
  });
});

describe('an entity that does not accrue', () => {
  let runId: string;

  beforeAll(async () => {
    runId = await approvedRun(none, await none.period('2026-12-01', '2026-12-15'), 'regular',
      [salary(15000), yearEndBonus(15000)]);
  }, 120_000);

  it('by default the whole gross is expense: there is no provision to consume', async () => {
    expect(charged(none, await preview(none, runId))).toEqual({ sueldos_gasto: '30000.0000' });
  });

  it('expense_on_payment is accepted, and gives the same entry', async () => {
    await answer(none, 'expense_on_payment');
    expect(charged(none, await preview(none, runId))).toEqual({ sueldos_gasto: '30000.0000' });
  });
});
