import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import Decimal from 'decimal.js';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createPayRun, calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { getPaycheck } from '../../src/services/payroll/common/paycheck-read-service.js';
import { previewPayRunEntry } from '../../src/services/payroll/common/gl-posting-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { minimumWageIsrText } from '../../src/cli/payslip-command.js';

// ============================================================
// MNE-001-923 (#1076) · NO ISR IS WITHHELD FROM WHO ONLY EARNS THE MINIMUM WAGE
//
// LISR art. 96, first paragraph: «No se efectuará retención a las personas que
// en el mes únicamente perciban un salario mínimo general correspondiente al
// área geográfica del contribuyente.» The tariff was applied to every base.
//
// THE FIGURES ARE WORKED BY HAND. Fortnights of 2026 paid on their last day;
// minimum wage 315.04 (general) and 440.87 (border), UMA 117.31; quincenal
// tariff, bracket 3 (3 537.16 – 6 216.15; 207.75 plus 10.88 %), bracket 4
// (6 216.16 – 7 225.95; 499.20 plus 16 %), bracket 2 (416.71 – 3 537.15; 7.95
// plus 6.4 %). Subsidy 15.02 % × 3 566.22 = 535.65 a month, × 15 / 30.4 =
// 264.30, for a monthly income (the fortnight × 2) of at most 11 492.66.
//
//   4 725.60 = 15 × 315.04:  207.75 + 1 188.44 × 0.1088 = 337.0523 → 337.05,
//     less 264.30 = 72.75 withheld on develop; by the law, 0.00.
//   4 725.61: 337.05 again, 72.75 withheld: one cent over is over.
//   4 725.60 + a bonus of 1 100.00 = 5 825.60 (× 2 is over the cap: no subsidy):
//     the whole base, 207.75 + 2 288.44 × 0.1088 = 456.732 → 456.73;
//     the excess alone, 7.95 + 683.29 × 0.064 = 51.68.
//   border, 6 613.05 = 15 × 440.87: 499.20 + 396.89 × 0.16 = 562.70 on develop
//     (no subsidy); by the law, 0.00.
//   16 to 31 July, paid by the day: 16 × 315.04 = 5 040.64 → 0.00; one cent
//     more, 207.75 + 1 503.49 × 0.1088 = 371.33, less 264.30 = 107.03.
//   IMSS of the worker, SBC 330.57 × 15 × 2.375 % = 117.77 (not this task's).
// ============================================================

interface Paycheck {
  id: string;
  runId: string;
  isr: string;
  subsidy: string;
  net: string;
  details: Record<string, unknown>;
}
type Earning = { earning_type: string; amount: number; cfdi_clave_sat: string };

describe('who only earns the minimum wage of their area suffers no ISR withholding (LISR art. 96)', () => {
  const salary = (amount: number): Earning => ({ earning_type: 'salary', amount, cfdi_clave_sat: '001' });
  const bonus = (amount: number): Earning => ({ earning_type: 'bonus', amount, cfdi_clave_sat: '038' });
  const annualOf = (daily: string): string => new Decimal(daily).times(365).toFixed(2);
  let f: Fixture;
  let serial = 0;
  interface Worker { id: string; f: Fixture; scheduleId: string }

  async function company(name: string): Promise<Fixture> {
    const fx = await crearInquilino(name);
    await seedPolicies({ tenantId: fx.tenantId, entityId: fx.entityId });
    return fx;
  }

  /**
   * A worker paid `daily` a day by contract (null: no annual salary loaded), SBC 330.57, on a
   * fortnightly calendar of their own: a calendar holds each period once.
   */
  async function worker(daily: string | null, zone: 'northern_border' | null = null, at: Fixture = f): Promise<Worker> {
    const [id, scheduleId] = [uuidv4(), uuidv4()];
    serial += 1;
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
       VALUES ($1, $2, $3, $4, 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, at.tenantId, at.entityId, `Quincenal ${serial}`]
    );
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code, annual_salary, minimum_wage_zone)
       VALUES ($1, $2, $3, $4, 'Trabajador', 'De Prueba', '2024-01-01', 'active', 'MX', 'XAXX010101000',
         'XAXX010101HDFXXX01', $5, '330.5700', '01', '02', $6, 'salary', 'MXN', $7, $8)`,
      [id, at.tenantId, at.entityId, `MX-923-${serial}`, String(serial).padStart(11, '7'), scheduleId,
        daily === null ? null : annualOf(daily), zone]
    );
    return { id, f: at, scheduleId };
  }

  /** One paycheck through the services of `pay-run create` and `pay-run calculate`; `apartIn` pays a bonus run in that period. */
  async function paid(
    w: Worker, earnings: Earning[], [start, end]: [string, string] = ['2026-11-01', '2026-11-15'], apartIn?: string
  ): Promise<Paycheck & { periodId: string }> {
    const periodId = apartIn ?? uuidv4();
    if (!apartIn) {
      await query(
        `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
         VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
        [periodId, w.f.tenantId, w.scheduleId, start, end]
      );
    }
    const input = {
      tenant_id: w.f.tenantId, pay_period_id: periodId, run_type: apartIn ? ('bonus' as const) : ('regular' as const),
      created_by: w.f.userId, employee_inputs: [{ employee_id: w.id, earnings }],
    };
    const scope = entityScope(w.f.tenantId, w.f.entityId);
    const runId = await createPayRun(input, scope);
    await calculatePayRun(runId, input, scope);
    const { rows } = await query<Paycheck>(
      `SELECT id, pay_run_id AS "runId", isr_withheld::numeric(14,2)::text AS isr, subsidio_empleo::numeric(14,2)::text AS subsidy,
              net_pay::numeric(14,2)::text AS net, calculation_details AS details
         FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
      [runId, w.f.tenantId]
    );
    return { ...rows[0], periodId };
  }

  const taxRows = async (paycheckId: string): Promise<Record<string, { amount: string; notes: string }>> => {
    const { rows } = await query<{ tax_type: string; amount: string; notes: string }>(
      `SELECT tax_type, tax_amount::numeric(14,2)::text AS amount, calculation_notes AS notes
         FROM paycheck_taxes WHERE paycheck_id = $1 AND employee_employer = 'EE'`,
      [paycheckId]
    );
    return Object.fromEntries(rows.map((r) => [r.tax_type, { amount: r.amount, notes: r.notes }]));
  };

  /** The payroll CFDI of one paycheck of an approved run, with the PAC stubbed out. */
  async function stampedXml(paycheckId: string): Promise<string> {
    await query(
      `UPDATE pay_runs SET status = 'approved'
        WHERE tenant_id = $2 AND id = (SELECT pay_run_id FROM paychecks WHERE id = $1 AND tenant_id = $2)`,
      [paycheckId, f.tenantId]
    );
    const { pacRouter } = await import('../../src/services/integrations/mexico/pac/pac-router.js');
    const cfdi = await import('../../src/services/payroll/mx/cfdi-nomina-generator.js');
    vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '', fecha_timbrado: new Date(),
      no_certificado_sat: '0000', sello_sat: '', provider_used: 'test', simulado: true,
    });
    const r = await cfdi.generateAndStampCfdiNomina(
      paycheckId, { tenantId: f.tenantId, userId: f.userId }, entityScope(f.tenantId, f.entityId)
    );
    return r.xml;
  }

  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    f = await company('MNE-001-923 · minimum wage, no ISR');
    await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
  });

  it('ACCEPTANCE: 4 725.60 in 1–15 November, general zone: 0.00 withheld, and the receipt says why', async () => {
    const p = await paid(await worker('315.04'), [salary(4725.6)]);
    // develop: isr 337.05 and net 4 535.08 (72.75 withheld).
    expect({ isr: p.isr, subsidy: p.subsidy, net: p.net }).toEqual({ isr: '0.00', subsidy: '264.30', net: '4607.83' });
    expect(p.details.minimum_wage_isr_exemption).toEqual({
      treatment: 'not_withheld', policy: null, zone: 'general', zone_declared_by: null, daily_minimum: '315.04',
      days: 15, minimum_of_period: '4725.60', taxable_of_period: '4725.60', tariff_isr_not_withheld: '337.05',
    });
    const rows = await taxRows(p.id);
    // The ISR row stays, with nothing withheld and the article; the subsidy caused has nothing to be credited against.
    expect(rows.isr.amount).toBe('0.00');
    expect(rows.isr.notes).toContain('LISR art. 96, first paragraph');
    expect(rows.isr.notes).toContain('337.05');
    expect(rows.subsidio_empleo.amount).toBe('0.00');
    expect(rows).not.toHaveProperty('subsidio_entregado_efectivo');
    expect(p.details.employment_subsidy_excess_not_paid).toBe('264.3000');
    // `payslip show` says it by key, in both languages.
    const detail = await getPaycheck(p.id, entityScope(f.tenantId, f.entityId));
    expect(minimumWageIsrText(detail, 'en')).toBe(
      'No ISR is withheld: the worker earns only the minimum wage of the area (zone general), LISR art. 96, first ' +
        'paragraph. ISR base of the period 4725.60; minimum wage of the period 4725.60 (15 days at 315.04).'
    );
    expect(minimumWageIsrText(detail, 'es')).toContain('artículo 96, primer párrafo, de la LISR');

    // The payroll CFDI: no ISR deduction, and OtroPago 002 with the subsidy caused and nothing handed over.
    const xml = await stampedXml(p.id);
    expect(xml).not.toContain('TipoDeduccion="002"');
    expect(xml).not.toContain('TotalImpuestosRetenidos');
    expect(xml).toContain('<nomina12:Deducciones TotalOtrasDeducciones="117.77">');
    expect(xml).toMatch(/TipoOtroPago="002"[^>]*Importe="0\.00">\s*<nomina12:SubsidioAlEmpleo SubsidioCausado="264\.30"/);
    expect(xml).toContain('Total="4607.83"');

    // The entry of the run balances and owes no ISR: the wages are the net pay plus the worker's IMSS.
    const entry = await previewPayRunEntry(p.runId, f.tenantId, f.entityId);
    expect(entry.totalDebits).toBe(entry.totalCredits);
    expect(entry.lines.filter((l) => /ISR/.test(l.description))).toEqual([]);
    expect(entry.lines.some((l) => l.credit_amount !== null && Number(l.credit_amount) === 4607.83)).toBe(true);
  });

  it('ACCEPTANCE: one cent more, 4 725.61, is withheld by the tariff: 337.05 less 264.30', async () => {
    const p = await paid(await worker('315.04'), [salary(4725.61)]);
    expect({ isr: p.isr, subsidy: p.subsidy, net: p.net }).toEqual({ isr: '337.05', subsidy: '264.30', net: '4535.09' });
    expect(p.details.minimum_wage_isr_exemption).toMatchObject({
      treatment: 'tariff_on_whole_base', policy: 'only_minimum_wage_paid', minimum_of_period: '4725.60',
    });
  });

  it('a worker above the minimum (12 500.00 a fortnight) keeps the figure, reads no zone of their own and records nothing', async () => {
    const above = await worker('833.33');
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    const p = await paid(above, [salary(12500)]);
    const zoneReads = spy.mock.calls.filter(([q]) => JSON.stringify(q).includes('minimum_wage_zone')).length;
    // 916.20 + (12 500.00 − 8 651.41) × 0.2136 = 1 738.26. The one zone read is the
    // entity's, which the old-age band of the employer's IMSS quota already made.
    expect({ isr: p.isr, zoneReads }).toEqual({ isr: '1738.26', zoneReads: 1 });
    expect(p.details).not.toHaveProperty('minimum_wage_isr_exemption');
  });

  it('cost: the minimum-wage worker reads their zone once more, and the panel key only when the base is over the minimum', async () => {
    const reads = async (amount: number): Promise<{ zone: number; key: number }> => {
      const w = await worker('315.04');
      const spy = vi.spyOn(pg.Client.prototype, 'query');
      await paid(w, [salary(amount)]);
      const sent = spy.mock.calls.map(([q, values]) => JSON.stringify([q, values]));
      spy.mockRestore();
      return {
        zone: sent.filter((s) => s.includes('minimum_wage_zone')).length,
        key: sent.filter((s) => s.includes('"minimum_wage_isr_exemption"')).length,
      };
    };
    expect(await reads(4725.6)).toEqual({ zone: 2, key: 0 });
    expect(await reads(4725.61)).toEqual({ zone: 2, key: 1 });
  });

  it('the default key: with a taxed bonus the tariff applies to the whole base, 456.73', async () => {
    const p = await paid(await worker('315.04'), [salary(4725.6), bonus(1100)]);
    expect({ isr: p.isr, subsidy: p.subsidy }).toEqual({ isr: '456.73', subsidy: '0.00' });
    expect((await taxRows(p.id)).isr.notes).toContain('[only_minimum_wage_paid]');
  });

  it('minimum_wage_part_never_taxed: the tariff applies to the excess alone, 51.68', async () => {
    const other = await company('MNE-001-923 · the minimum part is never taxed');
    await resolvePolicy(
      { tenantId: other.tenantId, entityId: other.entityId }, 'minimum_wage_isr_exemption',
      'minimum_wage_part_never_taxed', other.userId, 'MNE-001-923 test'
    );
    const w = await worker('315.04', null, other);
    const p = await paid(w, [salary(4725.6), bonus(1100)]);
    expect({ isr: p.isr, subsidy: p.subsidy }).toEqual({ isr: '51.68', subsidy: '0.00' });
    expect(p.details.minimum_wage_isr_exemption).toMatchObject({
      treatment: 'tariff_on_excess', policy: 'minimum_wage_part_never_taxed', taxable_of_period: '5825.60',
    });
    // Alone, the minimum wage is not withheld under either answer.
    expect((await paid(w, [salary(4725.6)], ['2026-10-01', '2026-10-15'])).isr).toBe('0.00');
  });

  it('the border zone of the employee: 6 613.05 is not withheld (562.70 on develop); in the general zone it is', async () => {
    const border = await paid(await worker('440.87', 'northern_border'), [salary(6613.05)]);
    expect(border.isr).toBe('0.00');
    expect(border.details.minimum_wage_isr_exemption).toMatchObject({
      zone: 'northern_border', zone_declared_by: 'employee', daily_minimum: '440.87', minimum_of_period: '6613.05',
    });
    expect((await paid(await worker('440.87'), [salary(6613.05)])).isr).toBe('562.70');
  });

  it('16 to 28 February measures the 15 days of the tariff; 16 to 31 July, its 16 calendar days', async () => {
    const february = await paid(await worker('315.04'), [salary(4725.6)], ['2026-02-16', '2026-02-28']);
    expect(february.isr).toBe('0.00');
    expect(february.details.minimum_wage_isr_exemption).toMatchObject({ days: 15, minimum_of_period: '4725.60' });

    const july = await paid(await worker('315.04'), [salary(5040.64)], ['2026-07-16', '2026-07-31']);
    expect(july.isr).toBe('0.00');
    expect(july.details.minimum_wage_isr_exemption).toMatchObject({ days: 16, minimum_of_period: '5040.64' });
    const over = await paid(await worker('315.04'), [salary(5040.65)], ['2026-08-16', '2026-08-31']);
    expect({ isr: over.isr, subsidy: over.subsidy }).toEqual({ isr: '371.33', subsidy: '264.30' });
  });

  it('without the contractual wage (annual_salary) the worker cannot be told to earn the minimum: the tariff, as before', async () => {
    const p = await paid(await worker(null), [salary(4725.6)]);
    expect(p.isr).toBe('337.05');
    expect(p.details).not.toHaveProperty('minimum_wage_isr_exemption');
  });

  it('a second run of the period: the bonus paid apart is another taxed earning, and the tariff takes the whole base', async () => {
    const w = await worker('315.04');
    const first = await paid(w, [salary(4725.6)], ['2026-09-01', '2026-09-15']);
    expect(first.isr).toBe('0.00');
    const apart = await paid(w, [bonus(1100)], undefined, first.periodId);
    // The period's base is 5 825.60: 456.73, less the 0.00 the fortnight caused.
    expect(apart.isr).toBe('456.73');
    expect(apart.details.minimum_wage_isr_exemption).toMatchObject({
      treatment: 'tariff_on_whole_base', taxable_of_period: '5825.60',
    });
  });
});
