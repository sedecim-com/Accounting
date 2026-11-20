import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { seedLegalParameters } from '../../src/services/jurisdiction/legal-parameters-seed.js';
import { legalParameterAt } from '../../src/services/jurisdiction/legal-parameters.js';
import { calculateFiniquito } from '../../src/services/payroll/mx/finiquito-calculator.js';
import {
  calculateSeparationIsr,
  SEPARATION_EXEMPT_CAP_KEY,
  SEPARATION_ISR_USMO_COMPARISON_POLICY,
  type SeparationIsrInput,
} from '../../src/services/payroll/mx/separation-isr.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { setEntityMinimumWageZone } from '../../src/services/payroll/mx/minimum-wage-zone.js';

/**
 * MNE-001-375 · #194, part A: the exemption of LISR art. 93 fr. XIII against
 * Postgres. The 90 UMA come from the law seed (`seedLegalParameters`), the UMA
 * of the termination date from `tax_parameters` as migrated (073: 113.14 in
 * January 2026, 117.31 from 1 February), and the premium from the settlement
 * itself. Figures by hand in the plan on #194.
 */
apartarCatalogos('legal_parameters');

let f: Fixture;
let g: Fixture; // its own tenant: it answers the comparison key with taxable_payments
const VETERAN = randomUUID();

beforeAll(async () => {
  await seedLegalParameters();
  f = await crearInquilino('MNE-001-375 separation exemption');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  // Fifteen years on 30-jun-2026, daily wage 365 000 / 365 = 1 000.00.
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, annual_salary, status)
     VALUES ($1,$2,$3,$4,'Synthetic','Veteran','2011-03-01','MX','AAAA010101AAA', 365000, 'active')`,
    [VETERAN, f.tenantId, f.entityId, `E-${VETERAN.slice(0, 8)}`]
  );
  g = await crearInquilino('MNE-001-579 comparison by taxable part');
  await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
  await resolvePolicy(
    { tenantId: g.tenantId, entityId: g.entityId },
    SEPARATION_ISR_USMO_COMPARISON_POLICY,
    'taxable_payments',
    g.userId
  );
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('the separation exemption, against the law as loaded', () => {
  it('the 90 UMA are a dated law row, in UMA, with its source', async () => {
    const row = await legalParameterAt('MX', SEPARATION_EXEMPT_CAP_KEY, '2026-06-30');
    expect(row.value).toBe('90.0000');
    expect(row.unit).toBe('UMA');
    expect(row.effectiveFrom).toBe('2016-01-28');
  });

  it('fifteen years, daily wage 1 000, dismissed: the premium is all exempt and nothing is withheld', async () => {
    const r = await calculateFiniquito(
      {
        employee_id: VETERAN,
        termination_date: '2026-06-30',
        last_paid_through: '2026-06-15',
        termination_reason: 'despido',
      },
      { tenantId: f.tenantId, entityId: f.entityId }
    );
    // 180 × 630.08 = 113 414.40; 90 × 117.31 × 15 = 158 368.50.
    expect(r.seniority_premium_amount).toBe('113414.4000');
    expect(r.separation_isr).toMatchObject({
      payments: '113414.4000',
      exemption_years_of_service: 15,
      uma_daily: '117.3100',
      exempt_cap: '158368.5000',
      exempt: '113414.4000',
      taxable: '0.0000',
      route: 'exempt',
      withholding: '0.0000',
    });
    // The gross settlement does not move: T4b's 138 025.36, to four decimals.
    expect(r.total).toBe('138025.3589');
  });

  it('a January termination reads the UMA still in force, 113.14', async () => {
    const r = await calculateSeparationIsr({
      payments: '113414.4000',
      hireDate: '2011-01-15',
      terminationDate: '2026-01-15',
      usmo: '30000.0000',
      usmoIsrSubsidy: 'gross_of_tariff',
      panel: { tenantId: f.tenantId, entityId: f.entityId },
    });
    // 90 × 113.14 × 15 = 152 739.00
    expect(r.uma_daily).toBe('113.1400');
    expect(r.exempt_cap).toBe('152739.0000');
    expect(r.route).toBe('exempt');
  });

  // MNE-001-377 (#196): the separation ISR exempts the premium AFTER the zone
  // cap. At the northern border it is 180 × 881.74 = 158 713.20, above the
  // 158 368.50 exempt: 344.70 taxable, withheld from MNE-001-579 on.
  it('a border entity: the capped premium of 158 713.20 leaves 344.70 taxable, withheld at the USMO rate (51.93, as 579\'s unit case)', async () => {
    await setEntityMinimumWageZone(f.entityId, f.tenantId, 'northern_border', { userId: f.userId, tenantId: f.tenantId });
    const r = await calculateFiniquito(
      { employee_id: VETERAN, termination_date: '2026-06-30', last_paid_through: '2026-06-15', termination_reason: 'despido' },
      { tenantId: f.tenantId, entityId: f.entityId }
    );
    expect(r.seniority_premium_amount).toBe('158713.2000');
    expect(r.separation_isr).toMatchObject({
      payments: '158713.2000', exempt_cap: '158368.5000', exempt: '158368.5000',
      taxable: '344.7000', route: 'effective_rate', withholding: '51.9300',
    });
  });
});

/**
 * MNE-001-579 · #194, part B: the withholding of LISR art. 96 (the paragraph
 * on the payments of art. 95) against the 2026 tables as migrated: the monthly
 * tariff of 073 and the subsidy of 095. Fifteen years on 30-jun-2026, so the
 * exempt cap is 158 368.50 and the payments below leave the taxable parts the
 * plan works by hand.
 */
describe('the separation withholding, against the 2026 tables', () => {
  const base = (over: Partial<SeparationIsrInput>): SeparationIsrInput => ({
    payments: '358368.5000', // 200 000.00 taxable
    hireDate: '2011-03-01',
    terminationDate: '2026-06-30',
    usmo: '9000.0000',
    usmoIsrSubsidy: 'gross_of_tariff',
    panel: { tenantId: f.tenantId, entityId: f.entityId },
    ...over,
  });

  it('USMO 9 000, 200 000 taxed, gross of the tariff: ISR 620.22, rate 6.8913 %, 13 782.67', async () => {
    const r = await calculateSeparationIsr(base({}));
    expect(r).toMatchObject({
      taxable: '200000.0000',
      route: 'effective_rate',
      isr_of_usmo: '620.2200',
      rate_percent: '6.8913',
      withholding: '13782.6700',
    });
    // The two mutants of #194 die here: the tariff applied to the 200 000
    // itself gives 56 770.26, and the quincenal tariff for the ISR of the
    // USMO another figure; only the monthly ISR of the USMO gives 13 782.67.
    expect(r.withholding).not.toBe('56770.2600');
  });

  it('the same case net of the subsidy: 535.65, rate 0.9397 %, 1 879.33', async () => {
    const r = await calculateSeparationIsr(base({ usmoIsrSubsidy: 'net_of_subsidy' }));
    expect(r).toMatchObject({
      employment_subsidy_of_usmo: '535.6500',
      rate_percent: '0.9397',
      withholding: '1879.3300',
    });
  });

  it('taxable 5 000 of 163 368.50: at the rate by default (344.57), by the tariff if the firm compares the taxable part (282.17)', async () => {
    const byTotal = await calculateSeparationIsr(base({ payments: '163368.5000' }));
    expect(byTotal).toMatchObject({ route: 'effective_rate', usmo_comparison: 'total_payments', withholding: '344.5700' });
    const byTaxable = await calculateSeparationIsr(
      base({ payments: '163368.5000', panel: { tenantId: g.tenantId, entityId: g.entityId } })
    );
    expect(byTaxable).toMatchObject({ route: 'tariff', usmo_comparison: 'taxable_payments', withholding: '282.1700' });
  });

  it('a total of 8 000 below the USMO goes by the monthly tariff: 511.42', async () => {
    const r = await calculateSeparationIsr(base({ payments: '8000.0000', hireDate: '2026-01-10' }));
    expect(r).toMatchObject({ route: 'tariff', taxable: '8000.0000', withholding: '511.4200' });
  });
});
