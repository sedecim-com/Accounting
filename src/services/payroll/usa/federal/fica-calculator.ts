import type { ITaxCalculator, TaxInput, TaxOutput } from '../../tax-engine/tax-engine.interface.js';
import { getTaxParameters } from '../../tax-engine/tax-tables.js';
import { cappedTaxableWages } from '../../tax-engine/ytd-service.js';

// ============================================================
// FICA — Social Security + Medicare
// SS: 6.2% EE + 6.2% ER on wages up to SS wage base (e.g., $168,600 in 2026 est.)
// Medicare: 1.45% EE + 1.45% ER uncapped + 0.9% EE Additional Medicare over $200k single
// ============================================================

export class UsFicaSocialSecurityCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'fica_ss';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year, ytd_wages = 0 } = input;
    const params = await getTaxParameters('US-FEDERAL', tax_year);
    const wageBase = parseFloat(String(params.ss_wage_base || 168600));
    const rate = parseFloat(String(params.ss_rate_employee || 0.062));

    const taxablePortion = cappedTaxableWages(ytd_wages, taxable_wages, wageBase);
    const tax = taxablePortion * rate;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxablePortion,
      rate_applied: rate,
      notes: `SS wage base ${wageBase}, YTD ${ytd_wages.toFixed(2)}`,
    };
  }
}

export class UsFicaMedicareCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'fica_medicare';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year } = input;
    const params = await getTaxParameters('US-FEDERAL', tax_year);
    const rate = parseFloat(String(params.medicare_rate_employee || 0.0145));
    const tax = taxable_wages * rate;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
    };
  }
}

// Employee-only — additional 0.9% over threshold (by filing status)
export class UsAdditionalMedicareCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'additional_medicare';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year, ytd_wages = 0, filing_status, w4_data } = input;
    const params = await getTaxParameters('US-FEDERAL', tax_year);
    const rate = parseFloat(String(params.additional_medicare_rate || 0.009));
    // Employer uses $200k threshold regardless of filing status (IRS rule)
    const threshold = parseFloat(String(params.additional_medicare_threshold_single || 200000));

    const fs = w4_data?.filing_status || filing_status || 'single';
    void fs; // employer uses $200k flat threshold — informational only

    const ytdPlus = ytd_wages + taxable_wages;
    if (ytdPlus <= threshold) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0, rate_applied: rate };
    }

    const overBefore = Math.max(0, ytd_wages - threshold);
    const overAfter = Math.max(0, ytdPlus - threshold);
    const taxablePortion = overAfter - overBefore;
    const tax = taxablePortion * rate;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxablePortion,
      rate_applied: rate,
      notes: `Addl Medicare 0.9% over $${threshold} (employer withholds)`,
    };
  }
}

// Employer-side SS + Medicare (same rates, no additional 0.9%)
export class UsFicaSocialSecurityEmployerCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'fica_ss_employer';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year, ytd_wages = 0 } = input;
    const params = await getTaxParameters('US-FEDERAL', tax_year);
    const wageBase = parseFloat(String(params.ss_wage_base || 168600));
    const rate = parseFloat(String(params.ss_rate_employer || 0.062));
    const taxablePortion = cappedTaxableWages(ytd_wages, taxable_wages, wageBase);
    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(taxablePortion * rate * 100) / 100,
      taxable_wages_used: taxablePortion,
      rate_applied: rate,
    };
  }
}

export class UsFicaMedicareEmployerCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'fica_medicare_employer';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year } = input;
    const params = await getTaxParameters('US-FEDERAL', tax_year);
    const rate = parseFloat(String(params.medicare_rate_employer || 0.0145));
    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(taxable_wages * rate * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
    };
  }
}
