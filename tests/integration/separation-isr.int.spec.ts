import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { seedLegalParameters } from '../../src/services/jurisdiction/legal-parameters-seed.js';
import { legalParameterAt } from '../../src/services/jurisdiction/legal-parameters.js';
import { calculateFiniquito } from '../../src/services/payroll/mx/finiquito-calculator.js';
import {
  calculateSeparationIsr,
  SEPARATION_EXEMPT_CAP_KEY,
} from '../../src/services/payroll/mx/separation-isr.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';

/**
 * MNE-001-375 · #194, part A: the exemption of LISR art. 93 fr. XIII against
 * Postgres. The 90 UMA come from the law seed (`seedLegalParameters`), the UMA
 * of the termination date from `tax_parameters` as migrated (073: 113.14 in
 * January 2026, 117.31 from 1 February), and the premium from the settlement
 * itself. Figures by hand in the plan on #194.
 */
apartarCatalogos('legal_parameters');

let f: Fixture;
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
    });
    // 90 × 113.14 × 15 = 152 739.00
    expect(r.uma_daily).toBe('113.1400');
    expect(r.exempt_cap).toBe('152739.0000');
    expect(r.route).toBe('exempt');
  });
});
