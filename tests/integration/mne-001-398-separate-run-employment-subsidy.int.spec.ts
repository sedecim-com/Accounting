import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createPayRun, calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { previewPayRunEntry } from '../../src/services/payroll/common/gl-posting-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY } from '../../src/services/payroll/mx/employment-subsidy.js';
// The calculators register on import; without it `getRequired('MX','isr')` throws.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// MNE-001-398 (#430) · ONE EMPLOYMENT SUBSIDY PER PAY PERIOD
//
// The subsidy was computed per paycheck from that paycheck's own income, so
// an aguinaldo paid in its own run of a period whose regular fortnight had
// already credited the subsidy received it a second time, and the part over
// its ISR went out as cash, into net pay, the CFDI (OtrosPagos 002) and the
// payroll entry. The owner decided (MNE-001-397) that the subsidy is
// recomputed once on the combined income of the period and the later
// paycheck credits only the difference; the alternative, no subsidy on the
// separate paycheck, is the policy's other value.
//
// December 2026, a quincena paid on the 15th: the subsidy is 264.30. An
// aguinaldo of 4 000.00 is exempt up to 30 UMA (3 519.30), so 480.70 is taxed.
// ============================================================

interface StoredPaycheck {
  id: string;
  gross_earnings: string;
  isr_withheld: string;
  subsidy: string;
  subsidy_cash: string;
  imss_employee: string;
  infonavit_withheld: string;
  net_pay: string;
}

describe('an aguinaldo paid in its own run does not get a second employment subsidy', () => {
  let f: Fixture;
  let scheduleId: string;

  async function newPeriod(start: string, end: string): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [id, f.tenantId, scheduleId, start, end]
    );
    return id;
  }

  async function newEmployee(num: string): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, $4, 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '100.0000', '01', '02', $5, 'salary', 'MXN')`,
      [id, f.tenantId, f.entityId, num, scheduleId]
    );
    return id;
  }

  /** A run over `periodId`, calculated by the real service and then approved. */
  async function approvedRun(
    periodId: string,
    runType: 'regular' | 'bonus',
    employeeId: string,
    earnings: { earning_type: string; amount: number; cfdi_clave_sat?: string }[]
  ): Promise<{ runId: string; paycheck: StoredPaycheck }> {
    const scope = entityScope(f.tenantId, f.entityId);
    const input = {
      tenant_id: f.tenantId, pay_period_id: periodId, run_type: runType, created_by: f.userId,
      employee_inputs: [{ employee_id: employeeId, earnings }],
    };
    const runId = await createPayRun(input, scope);
    await calculatePayRun(runId, input, scope);
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1 AND tenant_id = $2`, [runId, f.tenantId]);
    const { rows } = await query<StoredPaycheck>(
      `SELECT id, gross_earnings::text, isr_withheld::text, subsidio_empleo::text AS subsidy,
              subsidio_entregado_efectivo::text AS subsidy_cash, imss_employee::text,
              infonavit_withheld::text, net_pay::text
         FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
      [runId, f.tenantId]
    );
    return { runId, paycheck: rows[0] };
  }

  const salary = (amount: number) => ({ earning_type: 'salary', amount });
  const yearEndBonus = (amount: number) => ({ earning_type: 'aguinaldo', amount, cfdi_clave_sat: '002' });

  /** The payroll CFDI of one paycheck, with the PAC stubbed out. */
  async function stampedXml(paycheckId: string): Promise<string> {
    const { pacRouter } = await import('../../src/services/integrations/mexico/pac/pac-router.js');
    const cfdi = await import('../../src/services/payroll/mx/cfdi-nomina-generator.js');
    const spy = vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
      fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
      provider_used: 'test', simulado: true,
    });
    try {
      const r = await cfdi.generateAndStampCfdiNomina(
        paycheckId, { tenantId: f.tenantId, userId: f.userId }, entityScope(f.tenantId, f.entityId)
      );
      return r.xml;
    } finally {
      spy.mockRestore();
    }
  }
  const attr = (xml: string, name: string): Decimal =>
    new Decimal(new RegExp(`\\b${name}="([0-9.]+)"`).exec(xml)![1]);

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-398 · subsidy once per period');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
  });

  describe('default: recompute once on the combined income of the period', () => {
    let regular: StoredPaycheck;
    let bonus: { runId: string; paycheck: StoredPaycheck };

    beforeAll(async () => {
      const period = await newPeriod('2026-12-01', '2026-12-15');
      const employee = await newEmployee('MX-398A');
      regular = (await approvedRun(period, 'regular', employee, [salary(1500)])).paycheck;
      bonus = await approvedRun(period, 'bonus', employee, [yearEndBonus(4000)]);
    });

    it('the regular fortnight credits the subsidy of the period', () => {
      expect(regular.subsidy).toBe('264.30');
      expect(Number(regular.subsidy_cash)).toBeGreaterThan(0);
    });

    it('ACCEPTANCE: the aguinaldo run credits no second subsidy and pays none in cash', async () => {
      expect(bonus.paycheck.subsidy).toBe('0.00');
      expect(Number(bonus.paycheck.subsidy_cash)).toBe(0);
      expect(Number(bonus.paycheck.isr_withheld)).toBeGreaterThan(0);
      const { rows } = await query<{ tax_type: string; tax_amount: string; calculation_notes: string }>(
        `SELECT tax_type, tax_amount::text, calculation_notes FROM paycheck_taxes
          WHERE paycheck_id = $1 AND tax_type LIKE 'subsidio%'`,
        [bonus.paycheck.id]
      );
      expect(rows.map((r) => r.tax_type)).toEqual(['subsidio_empleo']);
      expect(Number(rows[0].tax_amount)).toBe(0);
      expect(rows[0].calculation_notes).toMatch(/264\.30/);
    });

    it('net pay is gross less the whole ISR and IMSS: no subsidy is added', () => {
      const p = bonus.paycheck;
      const expected = new Decimal(p.gross_earnings)
        .minus(p.isr_withheld)
        .minus(p.imss_employee)
        .minus(p.infonavit_withheld);
      expect(new Decimal(p.net_pay).toFixed(2)).toBe(expected.toFixed(2));
    });

    it('the payroll entry balances and books the whole ISR as payable, with no subsidy debit', async () => {
      const entry = await previewPayRunEntry(bonus.runId, f.tenantId, f.entityId);
      expect(entry.totalDebits).toBe(entry.totalCredits);
      const isrLine = entry.lines.find((l) => /ISR withheld/.test(l.description));
      expect(isrLine?.credit_amount).toBe(new Decimal(bonus.paycheck.isr_withheld).toFixed(2));
      expect(entry.lines.some((l) => /Subsidio al empleo entregado/.test(l.description))).toBe(false);
    });

    it('the payroll CFDI declares no OtrosPagos 002 and still adds up', async () => {
      const xml = await stampedXml(bonus.paycheck.id);
      expect(xml).not.toMatch(/TipoOtroPago="002"/);
      expect(attr(xml, 'Total').toFixed(2)).toBe(attr(xml, 'SubTotal').minus(attr(xml, 'Descuento')).toFixed(2));
    });
  });

  it('an aguinaldo in the same paycheck as the salary computes the subsidy once, as today', async () => {
    const period = await newPeriod('2026-11-16', '2026-11-30');
    const employee = await newEmployee('MX-398B');
    const { paycheck } = await approvedRun(period, 'regular', employee, [salary(1500), yearEndBonus(4000)]);
    expect(paycheck.subsidy).toBe('264.30');
  });

  it('a later run credits the difference when the first one credited none', async () => {
    // The first run pays only an exempt aguinaldo: no taxable income, no
    // subsidy. The fortnight paid afterwards is the period's only taxable
    // income, so the recomputation gives it the whole subsidy.
    const period = await newPeriod('2026-11-01', '2026-11-15');
    const employee = await newEmployee('MX-398C');
    const first = await approvedRun(period, 'bonus', employee, [yearEndBonus(1000)]);
    expect(first.paycheck.subsidy).toBe('0.00');
    const { runId, paycheck } = await approvedRun(period, 'regular', employee, [salary(1500)]);
    expect(paycheck.subsidy).toBe('264.30');
    const cash = new Decimal(paycheck.subsidy_cash);
    expect(cash.greaterThan(0)).toBe(true);

    // Net pay: gross less the ISR retained (`isr_withheld` holds the ISR before
    // the credit) and the worker's IMSS, plus the subsidy handed over in cash.
    const isrRetained = Decimal.max(0, new Decimal(paycheck.isr_withheld).minus(paycheck.subsidy));
    const net = new Decimal(paycheck.gross_earnings)
      .minus(isrRetained)
      .minus(paycheck.imss_employee)
      .minus(paycheck.infonavit_withheld)
      .plus(cash);
    expect(new Decimal(paycheck.net_pay).toFixed(2)).toBe(net.toFixed(2));

    // The CFDI declares what the columns hold: OtrosPagos 002 with the cash
    // delivered and the subsidy caused, and the nómina complement adds up to
    // the net pay: perceptions + other payments − deductions.
    const xml = await stampedXml(paycheck.id);
    expect(xml).toMatch(new RegExp(`TipoOtroPago="002"[^>]*Importe="${cash.toFixed(2)}"`));
    expect(xml).toMatch(new RegExp(`SubsidioCausado="${paycheck.subsidy}"`));
    expect(attr(xml, 'TotalOtrosPagos').toFixed(2)).toBe(cash.toFixed(2));
    expect(
      attr(xml, 'TotalPercepciones').plus(attr(xml, 'TotalOtrosPagos')).minus(attr(xml, 'TotalDeducciones')).toFixed(2)
    ).toBe(new Decimal(paycheck.net_pay).toFixed(2));

    // The entry balances and debits the subsidy delivered.
    const entry = await previewPayRunEntry(runId, f.tenantId, f.entityId);
    expect(entry.totalDebits).toBe(entry.totalCredits);
    const delivered = entry.lines.find((l) => /Subsidio al empleo entregado/.test(l.description));
    expect(delivered?.debit_amount).toBe(cash.toFixed(2));
  });

  describe('with "none_on_separate_paycheck" the separate paycheck carries none, whatever runs first', () => {
    beforeAll(async () => {
      await resolvePolicy(
        { tenantId: f.tenantId, entityId: f.entityId },
        EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY, 'none_on_separate_paycheck', f.userId, 'MNE-001-398 test'
      );
    });

    it('the aguinaldo run calculated BEFORE the fortnight gets none, and the fortnight keeps its own', async () => {
      const period = await newPeriod('2026-10-01', '2026-10-15');
      const employee = await newEmployee('MX-398D');
      // 480.70 of it is taxed: on its own it would cause the whole 264.30.
      const bonusRun = await approvedRun(period, 'bonus', employee, [yearEndBonus(4000)]);
      expect(bonusRun.paycheck.subsidy).toBe('0.00');
      expect(Number(bonusRun.paycheck.subsidy_cash)).toBe(0);
      const { paycheck } = await approvedRun(period, 'regular', employee, [salary(1500)]);
      expect(paycheck.subsidy).toBe('264.30');
      expect(Number(paycheck.subsidy_cash)).toBeGreaterThan(0);
    });

    it('the aguinaldo run calculated AFTER the fortnight gets none', async () => {
      const period = await newPeriod('2026-10-16', '2026-10-31');
      const employee = await newEmployee('MX-398E');
      const regularRun = await approvedRun(period, 'regular', employee, [salary(1500)]);
      expect(regularRun.paycheck.subsidy).toBe('264.30');
      const { paycheck } = await approvedRun(period, 'bonus', employee, [yearEndBonus(4000)]);
      expect(paycheck.subsidy).toBe('0.00');
      expect(Number(paycheck.subsidy_cash)).toBe(0);
    });
  });
});
