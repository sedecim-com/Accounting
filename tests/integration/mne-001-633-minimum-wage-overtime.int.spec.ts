import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import pg from 'pg';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { setEntityMinimumWageZone } from '../../src/services/payroll/mx/minimum-wage-zone.js';

// ============================================================
// OVERTIME OF A MINIMUM-WAGE WORKER IS EXEMPT IN FULL (#196, MNE-001-633)
//
// LISR art. 93 fr. I gives 50 % up to 5 UMA a week to «los demás
// trabajadores» (migration 164 quotes that sentence); the corpus summary
// (`normas/fiscal-mx.md:97`) records the 100 % of the minimum-wage worker.
// The worker earns the minimum when the contractual daily wage (annual_salary
// / 365, as the finiquito reads it) is at most the daily minimum of their zone
// on the payment date: the employee's zone, else the entity's, else general.
//
// Against a migrated database. 2026 figures (tax_parameters, migration 074):
// general minimum 315.04, border 440.87, UMA 117.31 from February. A July
// quincena paid on the 15th: 15/7 weeks, 9 × 15/7 = 19.29 hours, cap
// 5 × 117.31 × 15/7 = 1 256.89. Double-paid hour = daily / 8 × 2.
//
//   general minimum, 315.04 a day: salary 15 × 315.04 = 4 725.60;
//     19 h × 315.04 / 8 × 2 = 1 496.44 of overtime.
//     develop: 50 % = 748.22 exempt, ISR base 5 473.82. By hand: 1 496.44
//     exempt, base 4 725.60.
//   border minimum, 440.87 a day: salary 15 × 440.87 = 6 613.05;
//     19 h × 440.87 / 8 × 2 = 2 094.13 of overtime.
//     50 % = 1 047.07 exempt, base 6 613.05 + 1 047.06 = 7 660.11. In the
//     border zone, by hand: 2 094.13 exempt, base 6 613.05.
//   one cent above the general minimum, 315.05 a day: salary 4 725.75; the
//     same 1 496.44 of overtime stays at 50 %: base 4 725.75 + 748.22 = 5 473.97.
// ============================================================

/** 365 days of the contractual daily wage: the divisor `salarioDiarioDesdeSueldoAnual` uses. */
const annualOf = (daily: string): string => new Decimal(daily).times(365).toFixed(2);

describe('the overtime of a worker who earns the minimum wage of their zone is exempt in full', () => {
  let f: Fixture;
  let scheduleId: string;

  async function employee(number: string, daily: string | null, zone: 'northern_border' | null = null): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code, annual_salary, minimum_wage_zone)
       VALUES ($1, $2, $3, $4, 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '470.0000', '01', '02', $5, 'salary', 'MXN', $6, $7)`,
      [id, f.tenantId, f.entityId, number, scheduleId, daily === null ? null : annualOf(daily), zone]
    );
    return id;
  }

  /** A fresh quincena of 2026 paid on its last day, and a regular run in it. */
  async function runIn(month: number, half: 1 | 2 = 1): Promise<string> {
    const mm = String(month).padStart(2, '0');
    const [start, end] = half === 1 ? [`2026-${mm}-01`, `2026-${mm}-15`] : [`2026-${mm}-16`, `2026-${mm}-30`];
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId, start, end]
    );
    const runId = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'regular', 'calculating', 2026, $4)`,
      [runId, f.tenantId, periodId, f.userId]
    );
    return runId;
  }

  /** «ISR base / exempt overtime» of one paycheck with a salary and 19 overtime hours. */
  async function paycheck(employeeId: string, salary: number, overtime: number, run: string): Promise<string> {
    const r = await calculatePaycheck({
      tenant_id: f.tenantId,
      pay_run_id: run,
      employee_id: employeeId,
      earnings: [
        { earning_type: 'salary', amount: salary, cfdi_clave_sat: '001' },
        { earning_type: 'overtime', amount: overtime, hours: 19, cfdi_clave_sat: '019' },
      ],
    });
    const { rows } = await query<{ base: string; exempt: string }>(
      `SELECT p.taxable_wages_isr::text AS base, pe.isr_exempt_amount::text AS exempt
         FROM paychecks p JOIN paycheck_earnings pe ON pe.paycheck_id = p.id
        WHERE p.id = $1 AND p.tenant_id = $2 AND pe.earning_type = 'overtime'`,
      [r.paycheck_id, f.tenantId]
    );
    return `${rows[0].base} / ${rows[0].exempt}`;
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

  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-633 · minimum-wage overtime');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
  });

  it('ACCEPTANCE: the general minimum (entity zone never declared): 1 496.44 of overtime is all exempt', async () => {
    expect(await paycheck(await employee('MX-633-01', '315.04'), 4725.6, 1496.44, await runIn(3))).toBe('4725.60 / 1496.44');
  });

  it('ACCEPTANCE: the border minimum, the employee\'s own zone: 2 094.13 of overtime is all exempt', async () => {
    expect(await paycheck(await employee('MX-633-02', '440.87', 'northern_border'), 6613.05, 2094.13, await runIn(4))).toBe(
      '6613.05 / 2094.13'
    );
  });

  it('one cent above the minimum keeps the 50 % of everyone else: 748.22', async () => {
    expect(await paycheck(await employee('MX-633-03', '315.05'), 4725.75, 1496.44, await runIn(5))).toBe('5473.97 / 748.22');
  });

  it('without a contractual wage (annual_salary) the worker cannot be told to earn the minimum: 50 %', async () => {
    expect(await paycheck(await employee('MX-633-04', null), 4725.6, 1496.44, await runIn(6))).toBe('5473.82 / 748.22');
  });

  it('the border minimum in a general-zone entity is above the minimum: 50 %; declared border, 100 %', async () => {
    const worker = await employee('MX-633-05', '440.87');
    expect(await paycheck(worker, 6613.05, 2094.13, await runIn(7))).toBe('7660.11 / 1047.07');
    await setEntityMinimumWageZone(f.entityId, f.tenantId, 'northern_border', { userId: f.userId, tenantId: f.tenantId });
    const august = await runIn(8);
    expect(await paycheck(worker, 6613.05, 2094.13, august)).toBe('6613.05 / 2094.13');
  });

  it('cost: a worker above every zone\'s minimum sends no statement more; a minimum-wage worker, one', async () => {
    await setEntityMinimumWageZone(f.entityId, f.tenantId, 'general', { userId: f.userId, tenantId: f.tenantId });
    const above = await employee('MX-633-06', '500.00');
    const minimum = await employee('MX-633-07', '315.04');
    // One paycheck first, so that what the process reads once is already read.
    await paycheck(await employee('MX-633-08', '500.00'), 7500, 1496.44, await runIn(10));
    const runA = await runIn(9);
    const runB = await runIn(9, 2);
    const rich = await statementsOf(() => paycheck(above, 7500, 1496.44, runA));
    const poor = await statementsOf(() => paycheck(minimum, 4725.6, 1496.44, runB));
    // Measured on develop 5cbcf91c: 95 and 103 (the low wage also reads the
    // employment subsidy). The minimum-wage worker adds the read of the zone.
    expect({ rich, poor }).toEqual({ rich: 95, poor: 104 });
  });
});
