import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createPayRun, calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { previewPayRunEntry } from '../../src/services/payroll/common/gl-posting-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { EMPLOYMENT_SUBSIDY_EXCESS_LAW } from '../../src/services/payroll/mx/employment-subsidy.js';

// ============================================================
// #600 · THE PAYCHECK AND THE ENTRY FOLLOW THE LAW OF THE PAYMENT DATE
// (part 2 of 3)
//
// When the employment subsidy of a paycheck is larger than its ISR, the row of
// `employment_subsidy.excess_over_isr_paid_share` in force on the PAYMENT date
// says what happens to the difference: paid until 30 April 2024 the employer
// hands it to the worker in cash; paid from 1 May 2024 nothing is handed over,
// net pay does not grow and the entry books nothing for it. The two rule rows
// are the ones migration 329 loads; this spec adds none of them.
//
// SYNTHETIC FIGURES. The ISR tariff and the amount of the subsidy are built
// for the test, in 2024: ISR is 0 up to 50.00 a fortnight and 5.00 plus 10 %
// above; the subsidy is 10 % of a monthly UMA of 2 026.70, 100.00 a fortnight,
// under a monthly income cap of 10 000.00. Before May 2024 the AMOUNT of the
// subsidy was a bracket table, which this repository does not load: what is
// pinned here is what happens to the excess, not that amount.
// ============================================================

apartarCatalogos('tax_tables', 'legal_parameters');

interface StoredPaycheck {
  id: string;
  isr: string;
  subsidy: string;
  cash: string;
  net: string;
  detail: Record<string, unknown>;
}

describe('the employment subsidy in excess of the ISR follows the law of the payment date', () => {
  let f: Fixture;
  let scheduleId: string;
  let account: Record<string, string>;
  let employeeNumber = 0;
  /** The run of T6, and the entry it must have under either value of the panel key. */
  let mayRun: string;
  const mayEntry = (): string[] =>
    [`${account.wages_expense}: 100.00 / -`, `${account.cash_payroll}: - / 100.00`].sort();

  async function newPeriod(start: string, payDate: string): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'draft')`,
      [id, f.tenantId, scheduleId, start, payDate, Number(payDate.slice(0, 4))]
    );
    return id;
  }

  /** A worker with no SBC: no IMSS, so net pay is gross, ISR and subsidy alone. */
  async function newEmployee(sbc: string | null = null): Promise<string> {
    const id = uuidv4();
    employeeNumber += 1;
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, $4, 'Worker', 'Synthetic',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         $5, '01', '02', $6, 'salary', 'MXN')`,
      [id, f.tenantId, f.entityId, `MX-440-${employeeNumber}`, sbc, scheduleId]
    );
    return id;
  }

  /** A regular run calculated by the real service and approved: one paycheck per gross amount. */
  async function approvedRun(
    periodId: string,
    workers: { employeeId: string; gross: number }[]
  ): Promise<{ runId: string; paychecks: StoredPaycheck[] }> {
    const scope = entityScope(f.tenantId, f.entityId);
    const input = {
      tenant_id: f.tenantId, pay_period_id: periodId, run_type: 'regular' as const, created_by: f.userId,
      employee_inputs: workers.map((w) => ({
        employee_id: w.employeeId,
        earnings: [{ earning_type: 'salary', amount: w.gross }],
      })),
    };
    const runId = await createPayRun(input, scope);
    await calculatePayRun(runId, input, scope);
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1 AND tenant_id = $2`, [runId, f.tenantId]);
    const paychecks: StoredPaycheck[] = [];
    for (const w of workers) {
      const { rows } = await query<StoredPaycheck>(
        `SELECT id, isr_withheld::text AS isr, subsidio_empleo::text AS subsidy,
                subsidio_entregado_efectivo::text AS cash, net_pay::text AS net,
                calculation_details AS detail
           FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2 AND employee_id = $3`,
        [runId, f.tenantId, w.employeeId]
      );
      paychecks.push(rows[0]);
    }
    return { runId, paychecks };
  }

  async function subsidyRows(paycheckId: string): Promise<{ tax_type: string; amount: string; notes: string }[]> {
    const { rows } = await query<{ tax_type: string; amount: string; notes: string }>(
      `SELECT tax_type, tax_amount::text AS amount, calculation_notes AS notes
         FROM paycheck_taxes WHERE paycheck_id = $1 AND tax_type LIKE 'subsidio%' ORDER BY tax_type`,
      [paycheckId]
    );
    return rows;
  }

  /** The entry as `account code: debit / credit`, in a fixed order. */
  async function entryLines(runId: string): Promise<string[]> {
    const entry = await previewPayRunEntry(runId, f.tenantId, f.entityId);
    expect(entry.totalDebits).toBe(entry.totalCredits);
    return entry.lines.map((l) => `${l.account_code}: ${l.debit_amount ?? '-'} / ${l.credit_amount ?? '-'}`).sort();
  }

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-440 · subsidy excess by payment date');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
    const mapping = await query<{ bucket: string; code: string }>(
      `SELECT m.bucket, a.code FROM payroll_account_mapping m
         JOIN accounts a ON a.id = m.account_id AND a.entity_id = m.entity_id
        WHERE m.entity_id = $1`,
      [f.entityId]
    );
    account = Object.fromEntries(mapping.rows.map((r) => [r.bucket, r.code]));

    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2024-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    await query(
      `INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency,
         bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from)
       VALUES
         ('MX','isr',2024,NULL,'quincenal',1, 0.01, 50.00, 0, 0, '2024-01-01'),
         ('MX','isr',2024,NULL,'quincenal',2, 50.01, NULL, 0.10, 5.00, '2024-01-01')`
    );
    await query(
      `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
       VALUES
         ('MX', 'uma.monthly', '2024-01-01', '2026.7000', 'MXN', 'https://example.invalid/synthetic', 'synthetic'),
         ('MX', 'employment_subsidy.uma_monthly_rate', '2024-01-01', '0.1000', 'rate', 'https://example.invalid/synthetic', 'synthetic'),
         ('MX', 'employment_subsidy.monthly_income_cap', '2024-01-01', '10000.0000', 'MXN', 'https://example.invalid/synthetic', 'synthetic')`
    );
  });

  it('T5 · paid on 30 April 2024, the excess is handed over in cash and the entry debits it', async () => {
    const period = await newPeriod('2024-04-16', '2024-04-30');
    const { runId, paychecks } = await approvedRun(period, [{ employeeId: await newEmployee(), gross: 100 }]);
    const [p] = paychecks;
    expect(p.isr).toBe('10.00');
    expect(p.subsidy).toBe('100.00');
    expect(Number(p.cash)).toBe(90);
    expect(p.net).toBe('190.00');
    expect((await subsidyRows(p.id)).map((r) => `${r.tax_type} ${Number(r.amount)}`)).toEqual([
      'subsidio_empleo 10',
      'subsidio_entregado_efectivo 90',
    ]);
    expect(await entryLines(runId)).toEqual(
      [
        `${account.wages_expense}: 100.00 / -`,
        `${account.isr_payable}: 90.00 / -`,
        `${account.cash_payroll}: - / 190.00`,
      ].sort()
    );
  });

  it('T6 · the same fortnight paid on 1 May 2024 hands over nothing and books nothing for the excess', async () => {
    const period = await newPeriod('2024-05-01', '2024-05-01');
    const { runId, paychecks } = await approvedRun(period, [{ employeeId: await newEmployee(), gross: 100 }]);
    const [p] = paychecks;
    expect(p.isr).toBe('10.00');
    // The subsidy caused stays whole: a second paycheck of the period reads it.
    expect(p.subsidy).toBe('100.00');
    expect(Number(p.cash)).toBe(0);
    expect(p.net).toBe('100.00');

    const rows = await subsidyRows(p.id);
    expect(rows.map((r) => `${r.tax_type} ${Number(r.amount)}`)).toEqual(['subsidio_empleo 10']);
    expect(rows[0].notes).toMatch(/90\.00/);
    expect(rows[0].notes).toMatch(/DOF 01-05-2024/);

    // The paycheck records which law it applied.
    expect(Number(p.detail.employment_subsidy_excess_not_paid)).toBe(90);
    expect(p.detail.employment_subsidy_excess_rule).toMatchObject({
      paid_share: 0,
      effective_from: '2024-05-01',
      source_url: 'https://dof.gob.mx/nota_detalle.php?codigo=5725287&fecha=01/05/2024',
    });

    // No ISR line and no subsidy line. The other value of the panel key is
    // the last test of the file: a decision is resolved once.
    mayRun = runId;
    expect(await entryLines(runId)).toEqual(mayEntry());
  });

  it('T7 · the excess of one worker does not reduce the ISR withheld from another', async () => {
    const period = await newPeriod('2024-05-16', '2024-05-31');
    const { runId, paychecks } = await approvedRun(period, [
      { employeeId: await newEmployee(), gross: 100 },
      { employeeId: await newEmployee(), gross: 2000 },
    ]);
    // Worker 1: ISR 10.00 under a subsidy of 100.00; the 90.00 are not money.
    // Worker 2: ISR 5.00 + 10 % × (2 000.00 − 50.00) = 200.00, less his own
    // subsidy of 100.00 = 100.00 withheld and owed to the tax authority.
    expect(paychecks.map((p) => [p.isr, p.subsidy, Number(p.cash), p.net])).toEqual([
      ['10.00', '100.00', 0, '100.00'],
      ['200.00', '100.00', 0, '1900.00'],
    ]);
    expect(await entryLines(runId)).toEqual(
      [
        `${account.wages_expense}: 2100.00 / -`,
        `${account.isr_payable}: - / 100.00`,
        `${account.cash_payroll}: - / 2000.00`,
      ].sort()
    );
  });

  it('T8 · a paycheck stored with the cash under a 2026 date still posts as it was paid', async () => {
    // What the code wrote before this rule: a fortnight of 1 500.00 paid in
    // March 2026 (ISR 77.28, subsidy 264.30) with its 187.02 handed over.
    const period = await newPeriod('2026-03-01', '2026-03-15');
    const { runId, paychecks } = await approvedRun(period, [{ employeeId: await newEmployee('100.0000'), gross: 1500 }]);
    const [p] = paychecks;
    expect([p.isr, p.subsidy, Number(p.cash)]).toEqual(['77.28', '264.30', 0]);
    const before = await entryLines(runId);
    expect(before.some((l) => l.startsWith(`${account.isr_payable}:`))).toBe(false);

    await query(
      `UPDATE paychecks SET subsidio_entregado_efectivo = 187.02, net_pay = net_pay + 187.02
        WHERE id = $1 AND tenant_id = $2`,
      [p.id, f.tenantId]
    );
    await query(
      `UPDATE pay_runs SET total_net_pay = total_net_pay + 187.02 WHERE id = $1 AND tenant_id = $2`,
      [runId, f.tenantId]
    );
    const after = await entryLines(runId);
    expect(after).toContain(`${account.isr_payable}: 187.02 / -`);
  });

  it('T9 · without the row of 1 May 2024 a May paycheck pays the cash again: the date is in the table', async () => {
    const deleted = await query(
      `DELETE FROM legal_parameters WHERE jurisdiction = 'MX' AND key = $1 AND effective_from = '2024-05-01'`,
      [EMPLOYMENT_SUBSIDY_EXCESS_LAW]
    );
    expect(deleted.rowCount).toBe(1);
    const period = await newPeriod('2024-06-01', '2024-06-15');
    const { paychecks } = await approvedRun(period, [{ employeeId: await newEmployee(), gross: 100 }]);
    const [p] = paychecks;
    expect(Number(p.cash)).toBe(90);
    expect(p.net).toBe('190.00');
    expect(p.detail.employment_subsidy_excess_rule).toMatchObject({ paid_share: 1, effective_from: '2014-01-01' });
  });

  it('T6 · the entry of 1 May 2024 is the same when the panel key says "gasto_del_patron"', async () => {
    // The key governs cash that was handed over, and none was: no line on the
    // ISR payable account and none on the subsidy expense account.
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'subsidio_al_empleo_entregado_registro', 'gasto_del_patron', f.userId, 'MNE-001-440 test'
    );
    const lines = await entryLines(mayRun);
    expect(lines).toEqual(mayEntry());
    expect(lines.some((l) => l.startsWith(`${account.subsidio_empleo_expense}:`))).toBe(false);
  });
});
