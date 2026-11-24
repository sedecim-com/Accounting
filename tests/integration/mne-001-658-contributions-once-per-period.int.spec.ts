import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { createPayRun, calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { acumularPasivoPatronal } from '../../src/services/payroll/common/employer-liability-service.js';
import { generateSuaFile } from '../../src/services/payroll/mx/sua-generator.js';

// ============================================================
// MNE-001-658 (#601) · THE DAYS OF A PERIOD CONTRIBUTE TO IMSS AND INFONAVIT ONCE
//
// The quotas are owed for the contribution days of the period on the worker's
// SBC (LSS arts. 27 to 29 and 39), never for a payment: the aguinaldo is already
// inside the SBC through its integration (LSS art. 27). Each paycheck charged
// them without looking at the period's other paychecks, so the fortnight plus
// an aguinaldo paid in its own run charged the same fifteen days twice.
//
// THE FIGURES ARE WORKED BY HAND FROM THE LAW. A worker with a daily SBC of
// 330.00 in risk class I, the fortnight of 1 to 15 December 2026 (15 days),
// UMA 117.31, general minimum wage 315.04. The base is 330.00 × 15 = 4 950.00
// (LSS art. 28 caps the SBC at 25 UMA = 2 932.75; 330.00 is under it, and under
// 3 UMA = 351.93, so the quota on the excess of art. 106 fr. II is zero).
//
//   The worker's quota, withheld by the employer (LSS art. 38):
//     cash benefits            art. 107       0.250 %    12.3750
//     pensioners' medical care art. 25        0.375 %    18.5625
//     disability and life      art. 147       0.625 %    30.9375
//     severance and old age    art. 168 II    1.125 %    55.6875
//                                                        117.5625  →   117.56
//   The employer's quota:
//     fixed quota  art. 106 I   20.40 % × 117.31 × 15    358.9686
//     cash benefits            art. 107       0.700 %     34.6500
//     pensioners' medical care art. 25        1.050 %     51.9750
//     disability and life      art. 147       1.750 %     86.6250
//     day care                 art. 211       1.000 %     49.5000
//     work risk, class I       art. 73        0.54355 %   26.905725
//     retirement               art. 168 I     2.000 %     99.0000
//     severance and old age    art. 168 II a) 6.026 %    298.2870
//       (330.00 is 2.81 UMA: the band «2.51 a 3.00 UMA», column 2026 of the
//        transitory article Segundo of the decree of DOF 16-12-2020)
//                                                       1 005.911325 → 1 005.91
//   INFONAVIT, the employer's 5 % (Ley del INFONAVIT art. 29 fr. II, on the
//   base and the cap of the LSS):         5 % × 4 950.00            =   247.50
//   The worker's housing credit, a fixed 1 200.00 a month the employer
//   discounts and pays in (art. 29 fr. III):  1 200.00 × 15 / 30    =   600.00
// ============================================================

const FORTNIGHT = { worker: '117.56', employer: '1005.91', housing: '247.50', credit: '600.00', base: '4950.00' };
const NOTHING = { worker: '0.00', employer: '0.00', housing: '0.00', credit: '0.00', base: '0.00' };

interface Contributions {
  worker: string;
  employer: string;
  housing: string;
  credit: string;
  base: string;
}

describe('the days of a period contribute to IMSS and INFONAVIT once, whatever the number of runs', () => {
  let f: Fixture;
  let scheduleId: string;
  const scope = () => entityScope(f.tenantId, f.entityId);

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
         infonavit_credit_type, infonavit_credit_value,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, $4, 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', $5,
         '330.0000', '01', 'pesos', '1200', '02', $6, 'salary', 'MXN')`,
      [id, f.tenantId, f.entityId, num, num.replace(/\D/g, '').padStart(11, '9'), scheduleId]
    );
    return id;
  }

  const salary = (amount: number) => ({ earning_type: 'salary', amount, cfdi_clave_sat: '001' });
  const yearEndBonus = (amount: number) => ({ earning_type: 'aguinaldo', amount, cfdi_clave_sat: '002' });
  type Earning = ReturnType<typeof salary>;

  const inputOf = (periodId: string, runType: 'regular' | 'bonus', employeeId: string, earnings: Earning[]) => ({
    tenant_id: f.tenantId, pay_period_id: periodId, run_type: runType, created_by: f.userId,
    employee_inputs: [{ employee_id: employeeId, earnings }],
  });

  /** A run over `periodId`, calculated by the real service. */
  async function calculatedRun(
    periodId: string, runType: 'regular' | 'bonus', employeeId: string, earnings: Earning[]
  ): Promise<string> {
    const input = inputOf(periodId, runType, employeeId, earnings);
    const runId = await createPayRun(input, scope());
    await calculatePayRun(runId, input, scope());
    return runId;
  }

  const approve = (runId: string) =>
    query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1 AND tenant_id = $2`, [runId, f.tenantId]);

  const COLUMNS = `COALESCE(SUM(p.imss_employee), 0)::numeric(14,2)::text AS worker,
                   COALESCE(SUM(p.imss_employer), 0)::numeric(14,2)::text AS employer,
                   COALESCE(SUM(p.infonavit_employer), 0)::numeric(14,2)::text AS housing,
                   COALESCE(SUM(p.infonavit_withheld), 0)::numeric(14,2)::text AS credit,
                   COALESCE(SUM(p.taxable_wages_imss), 0)::numeric(14,2)::text AS base`;

  /** What the paycheck of one run charged. */
  const ofRun = async (runId: string): Promise<Contributions> =>
    (await query<Contributions>(
      `SELECT ${COLUMNS} FROM paychecks p WHERE p.pay_run_id = $1 AND p.tenant_id = $2`,
      [runId, f.tenantId]
    )).rows[0];

  /** What every paycheck of the period charged for the employee, together. */
  const ofPeriod = async (periodId: string, employeeId: string): Promise<Contributions> =>
    (await query<Contributions>(
      `SELECT ${COLUMNS} FROM paychecks p JOIN pay_runs pr ON pr.id = p.pay_run_id
        WHERE pr.pay_period_id = $1 AND p.employee_id = $2 AND p.tenant_id = $3`,
      [periodId, employeeId, f.tenantId]
    )).rows[0];

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-658 · contributions once per period');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
  });

  describe('the fortnight, and then an aguinaldo in its own run of the same period', () => {
    let period: string;
    let employee: string;
    let regular: string;
    let bonus: string;

    beforeAll(async () => {
      period = await newPeriod('2026-12-01', '2026-12-15');
      employee = await newEmployee('MX-658-1');
      regular = await calculatedRun(period, 'regular', employee, [salary(4950)]);
      await approve(regular);
      bonus = await calculatedRun(period, 'bonus', employee, [yearEndBonus(4950)]);
      await approve(bonus);
    });

    it('the fortnight charges the quotas of its fifteen days, as worked by hand', async () => {
      expect(await ofRun(regular)).toEqual(FORTNIGHT);
    });

    it('ACCEPTANCE: the aguinaldo run charges none, and the period contributes once', async () => {
      expect(await ofRun(bonus)).toEqual(NOTHING);
      expect(await ofPeriod(period, employee)).toEqual(FORTNIGHT);
    });

    it('each row of the aguinaldo paycheck says what the period already contributed', async () => {
      const { rows } = await query<{ tax: string; amount: string; base: string; notes: string }>(
        `SELECT t.tax_type || ' ' || t.employee_employer AS tax, t.tax_amount::numeric(14,2)::text AS amount,
                t.taxable_wages::numeric(14,2)::text AS base, t.calculation_notes AS notes
           FROM paycheck_taxes t JOIN paychecks p ON p.id = t.paycheck_id
          WHERE p.pay_run_id = $1 AND p.tenant_id = $2 AND t.tax_type IN ('imss', 'infonavit', 'infonavit_credit')
          -- By byte, so the order is the same on every database: a linguistic
          -- collation (en_US, CI's) puts «infonavit_credit EE» before «infonavit ER».
          ORDER BY (t.tax_type || ' ' || t.employee_employer) COLLATE "C"`,
        [bonus, f.tenantId]
      );
      expect(rows.map((r) => [r.tax, r.amount, r.base])).toEqual([
        ['imss EE', '0.00', '0.00'],
        ['imss ER', '0.00', '0.00'],
        ['infonavit ER', '0.00', '0.00'],
        ['infonavit_credit EE', '0.00', '0.00'],
      ]);
      const noteOf = (tax: string) => rows.find((r) => r.tax === tax)!.notes;
      expect(noteOf('imss EE')).toMatch(/already charged 117\.56/);
      expect(noteOf('imss ER')).toMatch(/already charged 1005\.91/);
      expect(noteOf('infonavit ER')).toMatch(/already charged 247\.50/);
      expect(noteOf('infonavit_credit EE')).toMatch(/already charged 600\.00/);
    });

    it('the aguinaldo is paid less its ISR and nothing else', async () => {
      const { rows } = await query<{ gross: string; isr: string; subsidy: string; net: string }>(
        `SELECT gross_earnings::text AS gross, isr_withheld::text AS isr, subsidio_empleo::text AS subsidy,
                net_pay::text AS net
           FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
        [bonus, f.tenantId]
      );
      const retained = Decimal.max(0, new Decimal(rows[0].isr).minus(rows[0].subsidy));
      expect(new Decimal(rows[0].net).toFixed(2)).toBe(new Decimal(rows[0].gross).minus(retained).toFixed(2));
    });

    it('the employer liability of the aguinaldo run does not blame the SBC for its zero quota', async () => {
      const findings = (await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: bonus })).hallazgos;
      expect(findings.map((h) => h.codigo)).not.toContain('imss_patronal_en_cero');
    });

    it('the next fortnight charges its own sixteen days in full, and the SUA file counts each day once', async () => {
      // 16 to 31 December: 330.00 × 16 = 5 280.00. Worker 2.375 % = 125.40;
      // employer 1 005.911325 × 16 / 15 = 1 072.97208 → 1 072.97; INFONAVIT 5 % =
      // 264.00; the credit 1 200.00 × 16 / 30 = 640.00.
      const second = await newPeriod('2026-12-16', '2026-12-31');
      const next = await calculatedRun(second, 'regular', employee, [salary(5280)]);
      await approve(next);
      expect(await ofPeriod(second, employee)).toEqual({
        worker: '125.40', employer: '1072.97', housing: '264.00', credit: '640.00', base: '5280.00',
      });
      // The file is checked against the liability the approved runs recorded.
      for (const payRunId of [regular, next]) await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId });

      // December in the file: 15 + 16 = 31 contribution days, and the quotas
      // of the two fortnights: 1 005.91 + 1 072.97 and 117.56 + 125.40.
      const { content, filing } = await generateSuaFile(f.tenantId, f.entityId, 2026, 12, { record: false });
      expect(filing.totals.imss_employer).toBe(2078.88);
      expect(filing.totals.imss_employee).toBe(242.96);
      expect(filing.totals.infonavit_employer).toBe(511.5);
      const line = content.split('\r\n').find((l) => l.startsWith('99999996581'))!;
      // NSS 11, RFC 13, CURP 18, three names of 27, SBC 8: the days follow.
      expect(line.slice(131, 133)).toBe('31');
    });
  });

  it('the run calculated first carries the days, whatever its kind: the aguinaldo, then the fortnight', async () => {
    const period = await newPeriod('2026-11-16', '2026-11-30');
    const employee = await newEmployee('MX-658-2');
    const bonus = await calculatedRun(period, 'bonus', employee, [yearEndBonus(4950)]);
    const regular = await calculatedRun(period, 'regular', employee, [salary(4950)]);
    expect(await ofRun(bonus)).toEqual(FORTNIGHT);
    expect(await ofRun(regular)).toEqual(NOTHING);
    expect(await ofPeriod(period, employee)).toEqual(FORTNIGHT);
  });

  it('a run calculated again keeps its days: the other run of the period charged none', async () => {
    const period = await newPeriod('2026-11-01', '2026-11-15');
    const employee = await newEmployee('MX-658-3');
    const regular = await calculatedRun(period, 'regular', employee, [salary(4950)]);
    const bonus = await calculatedRun(period, 'bonus', employee, [yearEndBonus(4950)]);
    // MNE-001-657: an unapproved run is rebuilt. The salary is corrected.
    await calculatePayRun(regular, inputOf(period, 'regular', employee, [salary(5000)]), scope());
    expect(await ofRun(regular)).toEqual(FORTNIGHT);
    expect(await ofRun(bonus)).toEqual(NOTHING);
    expect(await ofPeriod(period, employee)).toEqual(FORTNIGHT);
  });

  it('another worker of the same period is not counted: each one contributes their own days', async () => {
    const period = await newPeriod('2026-10-16', '2026-10-31');
    const first = await newEmployee('MX-658-4');
    const second = await newEmployee('MX-658-5');
    await calculatedRun(period, 'regular', first, [salary(5280)]);
    const bonus = await calculatedRun(period, 'bonus', second, [yearEndBonus(4950)]);
    // 16 days, as in the second fortnight of December above.
    expect((await ofRun(bonus)).worker).toBe('125.40');
  });
});
