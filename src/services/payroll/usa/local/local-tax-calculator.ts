import type { ITaxCalculator, TaxInput, TaxOutput } from '../../tax-engine/tax-engine.interface.js';
import { getTaxParameters, getBrackets, applyBrackets, periodsPerYear } from '../../tax-engine/tax-tables.js';

// ============================================================
// USA Local Income Tax Calculators
// NYC: 3.078% – 3.876% progressive, residents only
// Yonkers: 1.61135% resident / 0.5% non-resident surcharge on NY SIT
// Philadelphia: 3.75% resident / 3.44% non-resident flat
// SF Payroll Expense: no individual SIT; payroll expense tax on employer
// ============================================================

/**
 * Generic locality calculator — driven by tax_parameters rows.
 * Jurisdiction format: 'US-<ST>-<CITY>' e.g. 'US-NY-NYC', 'US-PA-PHI'
 */
export class UsLocalTaxCalculator implements ITaxCalculator {
  jurisdiction: string;
  taxType = 'local';
  private isResidentOnly: boolean;

  constructor(jurisdiction: string, opts: { residentOnly?: boolean } = {}) {
    this.jurisdiction = jurisdiction;
    this.isResidentOnly = opts.residentOnly || false;
  }

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency, tax_year, w4_data, filing_status, residence_state } = input;
    if (taxable_wages <= 0) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    // Determine resident vs non-resident
    const stateFromJuris = this.jurisdiction.split('-')[1];
    const isResident = residence_state === stateFromJuris;
    if (this.isResidentOnly && !isResident) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters(this.jurisdiction, tax_year);
    const ppy = periodsPerYear(pay_frequency);

    // Resident vs non-resident flat rate (Philly pattern)
    const residentRate = params.resident_rate ? parseFloat(String(params.resident_rate)) : null;
    const nonResidentRate = params.non_resident_rate ? parseFloat(String(params.non_resident_rate)) : null;
    if (residentRate !== null || nonResidentRate !== null) {
      const rate = isResident ? (residentRate ?? 0) : (nonResidentRate ?? 0);
      const tax = taxable_wages * rate;
      return {
        jurisdiction: this.jurisdiction,
        tax_type: this.taxType,
        tax_amount: Math.round(tax * 100) / 100,
        taxable_wages_used: taxable_wages,
        rate_applied: rate,
        notes: `${isResident ? 'Resident' : 'Non-resident'} flat ${this.jurisdiction}`,
      };
    }

    // Progressive (NYC pattern)
    const fs = w4_data?.filing_status || filing_status || 'single';
    const brackets = await getBrackets(this.jurisdiction, 'local', tax_year, fs, 'annual');
    if (brackets.length === 0) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }
    const annualWages = taxable_wages * ppy;
    const { tax: annualTax, rate } = applyBrackets(brackets, annualWages);
    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round((annualTax / ppy) * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
      notes: `Progressive ${this.jurisdiction} ${fs}`,
    };
  }
}

// Known localities — each registers a calculator; parameters/brackets live in tax_parameters / tax_tables.
export const US_LOCALITIES: Array<{ code: string; residentOnly?: boolean }> = [
  { code: 'US-NY-NYC', residentOnly: true },   // NYC PIT residents only
  { code: 'US-NY-YON' },                        // Yonkers — resident/non-resident both
  { code: 'US-PA-PHI' },                        // Philadelphia wage tax
  { code: 'US-CA-SF' },                         // SF — employer payroll expense (handled separately)
];
