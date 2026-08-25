// ============================================================
// TAX ENGINE INTERFACES
// Strategy + registry pattern — each jurisdiction + tax_type is a plugin.
// ============================================================

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quincenal' | 'annual';
export type FilingStatus = 'single' | 'married_jointly' | 'head_of_household' | 'married_separately';

export interface TaxInput {
  // Wages for this specific pay period
  taxable_wages: number;
  pay_frequency: PayFrequency;
  tax_year: number;

  // YTD info (critical for capped taxes)
  ytd_wages?: number;
  ytd_tax_withheld?: number;

  // Employee profile
  filing_status?: FilingStatus;
  w4_data?: {
    filing_status: FilingStatus;
    multiple_jobs_box?: boolean;        // Box 2c
    dependents_amount?: number;         // Box 3 annual amount
    other_income?: number;              // Box 4a annual
    deductions?: number;                // Box 4b annual
    extra_withholding?: number;         // Box 4c per-paycheck
  };

  // Jurisdiction-specific extras
  state?: string;
  residence_state?: string;
  work_city?: string;
  is_supplemental?: boolean;            // Bonus/commission paid separately

  // MX-specific
  sbc_daily?: number;                   // SBC (Salario Base de Cotizacion — contribution base salary), daily amount
  days_in_period?: number;
  riesgo_puesto?: string;               // IMSS work risk class 01-05

  // Employer experience rate overrides (SUTA etc.)
  experience_rate?: number;
}

export interface TaxOutput {
  tax_amount: number;
  taxable_wages_used: number;
  rate_applied?: number;
  is_credit?: boolean;                  // For subsidio al empleo, EITC
  jurisdiction: string;
  tax_type: string;
  notes?: string;
  breakdown?: Record<string, number>;   // Sub-components (IMSS has 5 ramos)
}

export interface ITaxCalculator {
  jurisdiction: string;                 // 'US-FEDERAL', 'US-CA', 'MX', 'US-NYC'
  taxType: string;                      // 'fit', 'fica_ss', 'fica_medicare', 'isr', 'imss', etc.
  calculate(input: TaxInput): Promise<TaxOutput>;
}
