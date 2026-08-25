import type { ITaxCalculator, TaxInput, TaxOutput } from '../../tax-engine/tax-engine.interface.js';
import { getBrackets, applyBrackets, getTaxParameters, periodsPerYear } from '../../tax-engine/tax-tables.js';

// ============================================================
// State Income Tax Calculators
// Handles three patterns:
//   - No income tax: AK, FL, NH, NV, SD, TN, TX, WA, WY → returns 0
//   - Flat rate:     CO, IL, IN, KY, MI, NC, PA, UT, ...
//   - Progressive:   CA, NY, HI, NJ, OR, ...
// ============================================================

const NO_INCOME_TAX_STATES = new Set(['AK', 'FL', 'NH', 'NV', 'SD', 'TN', 'TX', 'WA', 'WY']);

export class UsStateSitCalculator implements ITaxCalculator {
  jurisdiction: string;
  taxType = 'sit';

  constructor(stateCode: string) {
    this.jurisdiction = `US-${stateCode}`;
  }

  get stateCode(): string {
    return this.jurisdiction.replace('US-', '');
  }

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency, tax_year, w4_data, filing_status } = input;

    if (NO_INCOME_TAX_STATES.has(this.stateCode) || taxable_wages <= 0) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters(this.jurisdiction, tax_year);
    const ppy = periodsPerYear(pay_frequency);

    // Flat-rate states have `flat_rate` param
    if (params.flat_rate !== undefined) {
      const rate = parseFloat(String(params.flat_rate));
      const personalExemption = parseFloat(String(params.personal_exemption || 0));
      const annualWages = Math.max(0, taxable_wages * ppy - personalExemption);
      const annualTax = annualWages * rate;
      const perPeriod = annualTax / ppy;
      return {
        jurisdiction: this.jurisdiction,
        tax_type: this.taxType,
        tax_amount: Math.round(perPeriod * 100) / 100,
        taxable_wages_used: taxable_wages,
        rate_applied: rate,
        notes: `Flat rate ${this.stateCode}`,
      };
    }

    // Progressive: use brackets table
    const fs = w4_data?.filing_status || filing_status || 'single';
    const brackets = await getBrackets(this.jurisdiction, 'sit', tax_year, fs, 'annual');
    if (brackets.length === 0) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const annualWages = taxable_wages * ppy;
    const { tax: annualTax, rate } = applyBrackets(brackets, annualWages);
    const perPeriod = annualTax / ppy;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(perPeriod * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
      notes: `Progressive ${this.stateCode} ${fs}`,
    };
  }
}

// ============================================================
// State Unemployment Tax (SUTA) — employer-only
// Per-tenant experience rate, per-state wage base
// ============================================================

export class UsStateSutaCalculator implements ITaxCalculator {
  jurisdiction: string;
  taxType = 'suta';

  constructor(stateCode: string) {
    this.jurisdiction = `US-${stateCode}`;
  }

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year, ytd_wages = 0, experience_rate } = input;
    const params = await getTaxParameters(this.jurisdiction, tax_year);
    const wageBase = parseFloat(String(params.suta_wage_base || 7000));
    const rate = experience_rate ?? parseFloat(String(params.suta_default_rate || 0.027));

    const remaining = Math.max(0, wageBase - ytd_wages);
    const taxablePortion = Math.min(taxable_wages, remaining);
    const tax = taxablePortion * rate;

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxablePortion,
      rate_applied: rate,
      notes: `SUTA base ${wageBase}`,
    };
  }
}

// ============================================================
// State Disability Insurance (CA, NY, NJ, RI, HI)
// ============================================================

export class UsStateSdiCalculator implements ITaxCalculator {
  jurisdiction: string;
  taxType = 'sdi';

  constructor(stateCode: string) {
    this.jurisdiction = `US-${stateCode}`;
  }

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, tax_year } = input;
    const params = await getTaxParameters(this.jurisdiction, tax_year);
    const rate = parseFloat(String(params.sdi_rate || params.sdi_rate_employee || 0));
    if (rate === 0) {
      return { jurisdiction: this.jurisdiction, tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

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
