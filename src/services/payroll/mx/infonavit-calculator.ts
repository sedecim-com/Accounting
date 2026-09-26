import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { contributionMonths, getTaxParameters, requiredParameter } from '../tax-engine/tax-tables.js';

// ============================================================
// MX — INFONAVIT
// Two components:
//   1. Employer contribution: 5% of SBC (capped at 25 UMA)
//   2. Employee credit discount (if has active credit):
//      - 'factor': rate of SBC * days
//      - 'vsm':    fixed amount in VSM units (general minimum wage) * days
//      - 'pesos':  fixed amount in pesos * period_months
// ============================================================

interface EmployeeCreditInput {
  credit_type?: 'factor' | 'vsm' | 'pesos';
  credit_value?: number;
}

// Employer 5% (every pay period)
export class MexicoInfonavitEmployerCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'infonavit_employer';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { sbc_daily = 0 } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    let amount = 0;
    let taxableUsed = 0;
    let rate = 0;
    // Each month's days with that month's UMA (#242): see `contributionMonths`.
    for (const { tax_year, date, days } of contributionMonths(input, 15)) {
      const params = await getTaxParameters('MX', tax_year, date);
      const uma = requiredParameter(params, 'uma_daily', 'MX', tax_year);
      rate = requiredParameter(params, 'infonavit_employer_rate', 'MX', tax_year);
      const sbcCapped = Math.min(sbc_daily, uma * 25);
      amount += sbcCapped * rate * days;
      taxableUsed += sbcCapped * days;
    }

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(amount * 100) / 100,
      taxable_wages_used: taxableUsed,
      rate_applied: rate,
      notes: `Employer contribution 5% on SBC capped at 25 UMA`,
    };
  }
}

// Employee credit discount (only if employee has active credit)
export class MexicoInfonavitCreditCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'infonavit_credit';

  async calculate(input: TaxInput & EmployeeCreditInput): Promise<TaxOutput> {
    const { sbc_daily = 0, credit_type, credit_value } = input;
    if (!credit_type || !credit_value || credit_value <= 0 || sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    let amount = 0;
    let taxableUsed = 0;
    // Each month's days with that month's UMA and minimum wage (#242).
    for (const { tax_year, date, days } of contributionMonths(input, 15)) {
      const params = await getTaxParameters('MX', tax_year, date);
      const smg = requiredParameter(params, 'salario_minimo_general_diario', 'MX', tax_year);
      const uma = requiredParameter(params, 'uma_daily', 'MX', tax_year);
      const sbcCapped = Math.min(sbc_daily, uma * 25);
      taxableUsed += sbcCapped * days;

      switch (credit_type) {
        case 'factor':
          amount += sbcCapped * credit_value * days;
          break;
        case 'vsm':
          amount += smg * credit_value * days;
          break;
        case 'pesos':
          amount += credit_value * (days / 30);
          break;
      }
    }

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(amount * 100) / 100,
      taxable_wages_used: taxableUsed,
      notes: `INFONAVIT credit type ${credit_type} value ${credit_value}`,
    };
  }
}
