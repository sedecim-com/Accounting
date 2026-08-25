import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { getTaxParameters } from '../tax-engine/tax-tables.js';

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
    const { tax_year, sbc_daily = 0, days_in_period = 15 } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters('MX', tax_year);
    const uma = parseFloat(String(params.uma_daily || 113.14));
    const rate = parseFloat(String(params.infonavit_employer_rate || 0.05));
    const topeSbc = uma * 25;
    const sbcCapped = Math.min(sbc_daily, topeSbc);

    const amount = sbcCapped * rate * days_in_period;

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(amount * 100) / 100,
      taxable_wages_used: sbcCapped * days_in_period,
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
    const { tax_year, sbc_daily = 0, days_in_period = 15, credit_type, credit_value } = input;
    if (!credit_type || !credit_value || credit_value <= 0 || sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters('MX', tax_year);
    const smg = parseFloat(String(params.salario_minimo_general_diario || 278.80));
    const uma = parseFloat(String(params.uma_daily || 113.14));
    const sbcCapped = Math.min(sbc_daily, uma * 25);

    let amount = 0;
    switch (credit_type) {
      case 'factor':
        amount = sbcCapped * credit_value * days_in_period;
        break;
      case 'vsm':
        amount = smg * credit_value * days_in_period;
        break;
      case 'pesos':
        amount = credit_value * (days_in_period / 30);
        break;
    }

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(amount * 100) / 100,
      taxable_wages_used: sbcCapped * days_in_period,
      notes: `INFONAVIT credit type ${credit_type} value ${credit_value}`,
    };
  }
}
