import { describe, it, expect, beforeAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { MexicoImssEmployerCalculator } from '../../src/services/payroll/mx/imss-calculator.js';
import {
  OLD_AGE_BAND_EDGE_POLICY,
  OLD_AGE_MINIMUM_WAGE_AREA_POLICY,
  readOldAgeBandEdge,
  readOldAgeMinimumWageArea,
} from '../../src/services/payroll/mx/old-age-band.js';
import { setEntityMinimumWageZone } from '../../src/services/payroll/mx/minimum-wage-zone.js';

// ============================================================
// MNE-001-513 (#661) · THE EMPLOYER OLD-AGE QUOTA READS THE TABLE OF 330
//
// The unit spec types the rates again; this one goes through the rows the
// migrations loaded: the 64 cells of 330 in `legal_parameters`, and the UMA
// (117.31) and general minimum wage (315.04) of March 2026 in
// `tax_parameters`. The edge rule is read from the entity's policy panel, as
// `calculatePaycheck` reads it.
// ============================================================

describe('the employer old-age quota of a quincena of March 2026, from the migrated tables', () => {
  let f: Fixture;

  const oldAge = async (sbc: number): Promise<string> => {
    const edge = await readOldAgeBandEdge({ tenantId: f.tenantId, entityId: f.entityId });
    const area = await readOldAgeMinimumWageArea({ tenantId: f.tenantId, entityId: f.entityId });
    const out = await new MexicoImssEmployerCalculator().calculate({
      pay_frequency: 'quincenal', tax_year: 2026, taxable_wages: 0, sbc_daily: sbc,
      period_start: '2026-03-01', period_end: '2026-03-15', imss_old_age_band_edge: edge,
      imss_minimum_wage_area: area,
    });
    return (out.breakdown?.cesantia_vejez ?? NaN).toFixed(2);
  };

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-513 · old-age quota by SBC band');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  });

  it('SBC 400.00 pays 6.361 % and 1,000.00 pays 7.513 %, not the flat 3.150 %', async () => {
    expect(await oldAge(400)).toBe('381.66'); // flat: 189.00
    expect(await oldAge(1000)).toBe('1126.95'); // flat: 472.50
  });

  it('an SBC of 3.0006 UMA pays the next band by default, and its own once the entity answers truncation', async () => {
    expect(await oldAge(352)).toBe('335.86');
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      OLD_AGE_BAND_EDGE_POLICY, 'truncated_to_hundredths', f.userId, 'MNE-001-513 test'
    );
    expect(await oldAge(352)).toBe('318.17');
  });

  // MNE-001-578 (#196): the «1.00 SM» band uses the minimum of the employer
  // registration's area. Declared at the border (440.87), SBC 400.00 is under
  // one minimum and pays 3.150 %: 400.00 × 3.150 % × 15 = 189.00. The policy
  // general_zone takes 315.04 for everyone again: 381.66.
  it('a border registration pays the «1.00 SM» band below 440.87, and general_zone takes it back', async () => {
    await setEntityMinimumWageZone(f.entityId, f.tenantId, 'northern_border', { userId: f.userId, tenantId: f.tenantId });
    expect(await oldAge(400)).toBe('189.00');
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      OLD_AGE_MINIMUM_WAGE_AREA_POLICY, 'general_zone', f.userId, 'MNE-001-578 test'
    );
    expect(await oldAge(400)).toBe('381.66');
  });
});
