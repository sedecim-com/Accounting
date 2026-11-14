import { describe, it, expect } from 'vitest';
import '../../../src/api/rest/routes/payroll.js';
import { taxRegistry } from '../../../src/services/payroll/tax-engine/tax-registry.js';

// ============================================================
// #586 · THE REST ROUTES REACH THE CALCULATORS WITHOUT src/index.ts
//
// The registration moved from the REST entry point to the service that
// calculates. This file loads only the payroll router, in its own module
// graph, so a calculation through REST cannot depend on the entry point
// remembering a side-effect import. src/index.ts reaches the registry only
// through this router, so this is also what the REST server registers.
// ============================================================

describe('tax calculators under the REST payroll router (#586)', () => {
  it('loading the payroll router registers the Mexican calculators', () => {
    for (const tax of [
      'isr', 'subsidio_empleo', 'imss_employee', 'imss_employer', 'infonavit_employer', 'infonavit_credit',
    ]) {
      expect(taxRegistry.get('MX', tax)).not.toBeNull();
    }
  });
});
