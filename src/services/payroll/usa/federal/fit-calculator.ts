import type { ITaxCalculator, TaxInput, TaxOutput } from '../../tax-engine/tax-engine.interface.js';
import { getBrackets, applyBrackets, periodsPerYear } from '../../tax-engine/tax-tables.js';

// ============================================================
// US Federal Income Tax — IRS Publication 15-T
// Percentage Method for automated payroll systems (post-2020 W-4).
// ============================================================

export class UsFederalFitCalculator implements ITaxCalculator {
  jurisdiction = 'US-FEDERAL';
  taxType = 'fit';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency, tax_year, w4_data, is_supplemental } = input;
    if (taxable_wages <= 0) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    // Supplemental wages (bonus paid separately): flat 22% (or 37% over $1M YTD)
    if (is_supplemental) {
      const ytdSupp = input.ytd_wages || 0;
      const rate = ytdSupp + taxable_wages > 1_000_000 ? 0.37 : 0.22;
      return {
        jurisdiction: this.jurisdiction,
        tax_type: this.taxType,
        tax_amount: Math.round(taxable_wages * rate * 100) / 100,
        taxable_wages_used: taxable_wages,
        rate_applied: rate,
        notes: `Supplemental flat ${rate * 100}%`,
      };
    }

    const filingStatus = w4_data?.filing_status || input.filing_status || 'single';
    const ppy = periodsPerYear(pay_frequency);

    // Annualize
    let annualWages = taxable_wages * ppy;

    // Multiple jobs (Step 2c) — no adjustment (annual tables have built-in MFJ setup)
    // Dependents (Step 3), other income (Step 4a), deductions (Step 4b) are annual amounts
    const otherIncome = w4_data?.other_income || 0;
    const deductions = w4_data?.deductions || 0;
    const dependentsCredit = w4_data?.dependents_amount || 0;

    annualWages = annualWages + otherIncome - deductions;
    if (annualWages < 0) annualWages = 0;

    const brackets = await getBrackets(this.jurisdiction, 'fit', tax_year, filingStatus, 'annual');
    const { tax: annualTax, rate } = applyBrackets(brackets, annualWages);

    const taxAfterCredits = Math.max(0, annualTax - dependentsCredit);
    const perPeriodTax = taxAfterCredits / ppy;

    // Extra withholding (Step 4c) is per-period
    const extra = w4_data?.extra_withholding || 0;
    const total = perPeriodTax + extra;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(total * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
      notes: `Pub 15-T ${filingStatus} annualized ${annualWages.toFixed(2)}`,
    };
  }
}
