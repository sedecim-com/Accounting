import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { getBrackets, applyBrackets } from '../tax-engine/tax-tables.js';

// ============================================================
// MX — ISR (Impuesto Sobre la Renta)
// LISR Art. 96 — monthly / biweekly (quincenal) withholding on wages and salaries
// ============================================================

export class MexicoIsrCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'isr';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency, tax_year } = input;

    if (taxable_wages <= 0) {
      return {
        jurisdiction: this.jurisdiction,
        tax_type: this.taxType,
        tax_amount: 0,
        taxable_wages_used: 0,
        notes: 'Taxable base = 0',
      };
    }

    // Look up Art. 96 tariff for this frequency (monthly or quincenal)
    const freq = pay_frequency === 'quincenal' ? 'quincenal' : 'monthly';
    const brackets = await getBrackets('MX', 'isr', tax_year, null, freq);

    if (brackets.length === 0) {
      throw new Error(`No ISR brackets found for year ${tax_year}, freq ${freq}`);
    }

    const { tax, rate } = applyBrackets(brackets, taxable_wages);

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
      notes: `Art. 96 LISR ${freq}`,
    };
  }
}

// ============================================================
// MX — Subsidio al Empleo (credit against ISR)
// Applies when monthly salary is below threshold (~$10,171 monthly 2026 est.)
// ============================================================

export class MexicoSubsidioEmpleoCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'subsidio_empleo';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency, tax_year } = input;

    // Subsidio is always tabulated monthly; convert period base to monthly equivalent
    const monthlyBase = pay_frequency === 'quincenal' ? taxable_wages * 2 : taxable_wages;

    const brackets = await getBrackets('MX', 'subsidio_empleo', tax_year, null, 'monthly');
    if (brackets.length === 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    let monthlySubsidy = 0;
    for (const b of brackets) {
      const upper = b.bracket_high ?? Infinity;
      if (monthlyBase >= b.bracket_low && monthlyBase <= upper) {
        monthlySubsidy = b.base_tax;
        break;
      }
    }

    // Convert back to period
    const subsidy = pay_frequency === 'quincenal' ? monthlySubsidy / 2 : monthlySubsidy;

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(subsidy * 100) / 100,
      taxable_wages_used: taxable_wages,
      is_credit: true,
      notes: 'Subsidio al empleo (credit against ISR)',
    };
  }
}
