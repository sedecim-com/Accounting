import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createPayRun, calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';

// ============================================================
// MNE-001-739 (#601) · THE ISR OF A PAYMENT MADE APART IS THE PANEL'S ANSWER
//
// An aguinaldo paid in its own run of a fortnight whose salary was already
// paid: the code computed its ISR on its own base alone, as if it were all the
// worker earned in the period. How it is computed is the key
// `separate_payment_isr` (AGENTS.md invariant 6, ADR-0006).
//
// THE FIGURES ARE WORKED BY HAND. One worker, 1 to 15 December 2026, paid on
// the 15th. The quincenal tariff of 2026 is the one migration 073 derives from
// the monthly tariff of Anexo 8 (the daily tariff × 15); UMA 117.31.
//
//   Fortnight, salary 10 000.00, bracket 6 (8 651.41 – 17 448.75; 916.20 plus
//   21.36 % on the excess): 916.20 + 1 348.59 × 0.2136 = 1 204.258824 → 1 204.26
//
//   Aguinaldo 10 000.00, exempt 30 UMA = 3 519.30 (LISR art. 93 fr. XIV), so
//   6 480.70 is taxed:
//     on its own base, bracket 4 (6 216.16 – 7 225.95; 499.20 plus 16 %):
//       499.20 + 264.54 × 0.16 = 541.5264                                → 541.53
//     on the period's accumulated base, 16 480.70 in bracket 6:
//       916.20 + 7 829.29 × 0.2136 = 2 588.536344 → 2 588.54, less the
//       1 204.26 the fortnight caused                                    = 1 384.28
//     the other order: the aguinaldo first carries 541.53, and the fortnight
//       2 588.54 − 541.53                                                = 2 047.01
//
//   The subsidy is zero throughout: a monthly income of 20 000.00 and of
//   12 961.40 is over the cap of 11 492.66, so every figure is ISR alone.
// ============================================================

const FORTNIGHT_ISR = '1204.26';
const BONUS_ALONE_ISR = '541.53';
const BONUS_ACCUMULATED_ISR = '1384.28';
const PERIOD_ISR = '2588.54';

interface Paycheck {
  isr: string;
  subsidy: string;
  details: Record<string, unknown>;
}

describe('the ISR of a payment made apart follows the panel key separate_payment_isr', () => {
  const salary = (amount: number) => ({ earning_type: 'salary', amount, cfdi_clave_sat: '001' });
  const yearEndBonus = (amount: number) => ({ earning_type: 'aguinaldo', amount, cfdi_clave_sat: '002' });
  type Earning = ReturnType<typeof salary>;

  /** One company of its own: the key is answered per entity. */
  async function company(name: string): Promise<{ f: Fixture; scheduleId: string }> {
    const f = await crearInquilino(name);
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    const scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    return { f, scheduleId };
  }

  async function newPeriod(f: Fixture, scheduleId: string, start: string, end: string): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [id, f.tenantId, scheduleId, start, end]
    );
    return id;
  }

  async function newEmployee(f: Fixture, scheduleId: string, num: string): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, $4, 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', $5,
         '330.0000', '01', '02', $6, 'salary', 'MXN')`,
      [id, f.tenantId, f.entityId, num, num.replace(/\D/g, '').padStart(11, '7'), scheduleId]
    );
    return id;
  }

  const inputOf = (f: Fixture, periodId: string, runType: 'regular' | 'bonus', employeeId: string, earnings: Earning[]) => ({
    tenant_id: f.tenantId, pay_period_id: periodId, run_type: runType, created_by: f.userId,
    employee_inputs: [{ employee_id: employeeId, earnings }],
  });

  async function calculatedRun(
    f: Fixture, periodId: string, runType: 'regular' | 'bonus', employeeId: string, earnings: Earning[]
  ): Promise<string> {
    const input = inputOf(f, periodId, runType, employeeId, earnings);
    const scope = entityScope(f.tenantId, f.entityId);
    const runId = await createPayRun(input, scope);
    await calculatePayRun(runId, input, scope);
    return runId;
  }

  const paycheckOf = async (f: Fixture, runId: string): Promise<Paycheck> =>
    (await query<Paycheck>(
      `SELECT isr_withheld::numeric(14,2)::text AS isr, subsidio_empleo::numeric(14,2)::text AS subsidy,
              calculation_details AS details
         FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
      [runId, f.tenantId]
    )).rows[0];

  const isrRowNote = async (f: Fixture, runId: string): Promise<string> =>
    (await query<{ notes: string }>(
      `SELECT t.calculation_notes AS notes FROM paycheck_taxes t JOIN paychecks p ON p.id = t.paycheck_id
        WHERE p.pay_run_id = $1 AND p.tenant_id = $2 AND t.tax_type = 'isr'`,
      [runId, f.tenantId]
    )).rows[0].notes;

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

  afterEach(() => vi.restoreAllMocks());

  describe('nobody answered the key: the period\'s accumulated base', () => {
    let f: Fixture;
    let scheduleId: string;
    let regular: string;
    let bonus: string;

    beforeAll(async () => {
      ({ f, scheduleId } = await company('MNE-001-739 · default'));
      const period = await newPeriod(f, scheduleId, '2026-12-01', '2026-12-15');
      const employee = await newEmployee(f, scheduleId, 'MX-739-1');
      regular = await calculatedRun(f, period, 'regular', employee, [salary(10000)]);
      bonus = await calculatedRun(f, period, 'bonus', employee, [yearEndBonus(10000)]);
    });

    it('the fortnight, the only paycheck of its period when it was calculated, withholds what it did before', async () => {
      const p = await paycheckOf(f, regular);
      expect(p.isr).toBe(FORTNIGHT_ISR);
      expect(p.subsidy).toBe('0.00');
      expect(p.details).not.toHaveProperty('separate_payment_isr');
    });

    it('ACCEPTANCE: the aguinaldo in its own run withholds on the period\'s base, less what the fortnight caused', async () => {
      const p = await paycheckOf(f, bonus);
      expect(p.subsidy).toBe('0.00');
      expect(p.isr).toBe(BONUS_ACCUMULATED_ISR);
    });

    it('the paycheck records which treatment it used, and the figures it used', async () => {
      const p = await paycheckOf(f, bonus);
      expect(p.details.separate_payment_isr).toEqual({
        treatment: 'period_accumulated_base',
        answered_by_firm: false,
        separate: true,
        other_paychecks: 1,
        other_taxable_isr: '10000.00',
        other_isr: FORTNIGHT_ISR,
        isr_of_period: PERIOD_ISR,
        isr_on_own_base: BONUS_ALONE_ISR,
      });
      expect(await isrRowNote(f, bonus)).toMatch(/\[period_accumulated_base\]/);
    });

    it('the other order gives the period the same ISR: the aguinaldo first, then the fortnight', async () => {
      const period = await newPeriod(f, scheduleId, '2026-11-16', '2026-11-30');
      const employee = await newEmployee(f, scheduleId, 'MX-739-2');
      const first = await calculatedRun(f, period, 'bonus', employee, [yearEndBonus(10000)]);
      const second = await calculatedRun(f, period, 'regular', employee, [salary(10000)]);
      expect((await paycheckOf(f, first)).isr).toBe(BONUS_ALONE_ISR);
      expect((await paycheckOf(f, second)).isr).toBe('2047.01');
    });

    it('cost: an ordinary paycheck alone in its period sends no statement more; the aguinaldo one, one', async () => {
      const period = await newPeriod(f, scheduleId, '2026-10-01', '2026-10-15');
      const employee = await newEmployee(f, scheduleId, 'MX-739-3');
      const scope = entityScope(f.tenantId, f.entityId);
      const regularInput = inputOf(f, period, 'regular', employee, [salary(10000)]);
      const regularRun = await createPayRun(regularInput, scope);
      const ordinary = await statementsOf(() => calculatePayRun(regularRun, regularInput, scope));
      const bonusInput = inputOf(f, period, 'bonus', employee, [yearEndBonus(10000)]);
      const bonusRun = await createPayRun(bonusInput, scope);
      const apart = await statementsOf(() => calculatePayRun(bonusRun, bonusInput, scope));
      // Round trips to Postgres, measured on develop ac9ff0be: 81 and 97. The
      // key adds one read to the paycheck that shares its period; the
      // ordinary one is untouched.
      expect({ ordinary, apart }).toEqual({ ordinary: 81, apart: 98 });
    });
  });

  it('with "own_paycheck_base" the aguinaldo withholds on its own base, as before, and says so', async () => {
    const { f, scheduleId } = await company('MNE-001-739 · own base');
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId }, 'separate_payment_isr', 'own_paycheck_base', f.userId, 'MNE-001-739 test'
    );
    const period = await newPeriod(f, scheduleId, '2026-12-01', '2026-12-15');
    const employee = await newEmployee(f, scheduleId, 'MX-739-4');
    await calculatedRun(f, period, 'regular', employee, [salary(10000)]);
    const bonus = await calculatedRun(f, period, 'bonus', employee, [yearEndBonus(10000)]);
    const p = await paycheckOf(f, bonus);
    expect(p.isr).toBe(BONUS_ALONE_ISR);
    expect(p.details.separate_payment_isr).toMatchObject({ treatment: 'own_paycheck_base', answered_by_firm: true });
  });

  it('with "regulation_optional_procedure" the aguinaldo run is refused by key, and nothing is written', async () => {
    const { f, scheduleId } = await company('MNE-001-739 · regulation');
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId }, 'separate_payment_isr', 'regulation_optional_procedure',
      f.userId, 'MNE-001-739 test'
    );
    const period = await newPeriod(f, scheduleId, '2026-12-01', '2026-12-15');
    const employee = await newEmployee(f, scheduleId, 'MX-739-5');
    // The regular paycheck is not the separate one: it keeps its own base.
    const regular = await calculatedRun(f, period, 'regular', employee, [salary(10000)]);
    expect((await paycheckOf(f, regular)).isr).toBe(FORTNIGHT_ISR);

    const input = inputOf(f, period, 'bonus', employee, [yearEndBonus(10000)]);
    const scope = entityScope(f.tenantId, f.entityId);
    const runId = await createPayRun(input, scope);
    await expect(calculatePayRun(runId, input, scope)).rejects.toMatchObject({
      messageKey: { key: 'payroll.separate_payment_isr.regulation_procedure_not_in_corpus' },
    });
    const { rows } = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
      [runId, f.tenantId]
    );
    expect(rows[0].n).toBe(0);
  });
});
