import type { ITaxCalculator, TaxInput, TaxOutput } from '../../tax-engine/tax-engine.interface.js';
import { getTaxParameters } from '../../tax-engine/tax-tables.js';
import { cappedTaxableWages } from '../../tax-engine/ytd-service.js';

// ============================================================
// FUTA (Federal Unemployment Tax Act)
// 6% gross on first $7,000 per employee per year.
// State credit: 5.4% = 0.6% net when state is in good standing.
// Employer-only tax (no employee portion).
// ============================================================

export class UsFutaCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'futa';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year, ytd_wages = 0 } = input;
    const params = await getTaxParameters('US-FEDERAL', tax_year);
    const wageBase = parseFloat(String(params.futa_wage_base || 7000));
    // Use net rate (0.6%) assuming state credit applies
    const rate = parseFloat(String(params.futa_rate_net || 0.006));

    const taxablePortion = cappedTaxableWages(ytd_wages, taxable_wages, wageBase);
    const tax = taxablePortion * rate;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxablePortion,
      rate_applied: rate,
      notes: `FUTA net 0.6% on first $${wageBase} YTD`,
    };
  }
}
