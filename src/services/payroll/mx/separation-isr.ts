import Decimal from 'decimal.js';
import { AccountingError } from '../../../utils/errors.js';
import {
  legalParameterAt,
  LegalParameterUnavailableError,
  type LegalParameterInForce,
} from '../../jurisdiction/legal-parameters.js';
import { getPolicy, type PolicyContext } from '../../policy/policy-service.js';
import { getTaxParameters, requiredParameter } from '../tax-engine/tax-tables.js';
import { readEmploymentSubsidyRounding } from './employment-subsidy.js';
import type { UsmoIsrSubsidy } from './finiquito-calculator.js';
import { aFechaUtc } from './finiquito-math.js';
import { MexicoIsrCalculator, MexicoSubsidioEmpleoCalculator } from './isr-calculator.js';
import {
  separationExemption,
  separationRoute,
  separationYearsOfService,
  withholdingAtUsmoRate,
  type UsmoComparison,
} from './separation-isr-math.js';

export type { UsmoComparison } from './separation-isr-math.js';

// ============================================================
// THE SEPARATION ISR OF THE SETTLEMENT (#194)
// Part A, the exemption (MNE-001-375); part B, the withholding (MNE-001-579).
//
// The shell of `separation-isr-math.ts`. It reads the law (the 90 UMA of
// LISR art. 93 fr. XIII, the UMA, the monthly tariff and, net of subsidy, the
// subsidy) and the panel (`separation_isr_usmo_comparison`), and returns what
// of the separation payments is exempt, what is taxed, and what is withheld.
//
// THE ACT DATE IS THE TERMINATION DATE. ISR goes by the payment date, but a
// settlement has none; the termination date is the one `calculateFiniquito`
// already reads the tariff year and the minimum wage with. A termination in
// January reads the UMA of the year before, which is still in force.
//
// THE TARIFF IS THE MONTHLY ONE, ALWAYS. LISR art. 96 builds the rate on the
// ISR of the last ordinary MONTHLY salary, and its tariff route applies «la
// tarifa establecida en este artículo», the monthly one. The period's tariff
// of the ordinary payslip is the error #194 names: it over-withholds. So the
// frequency below is a literal, never the employee's pay frequency.
//
// ONLY THE ISR OF THE USMO IS NET OF THE SUBSIDY, and only under
// `net_of_subsidy`. The tariff route applies the tariff to the taxable part
// gross: the subsidy belongs to the month's ordinary income, which the
// payroll run credits, and crediting it here again would count it twice.
// ============================================================

/** LISR art. 93 fr. XIII: the separation cap, in daily UMA per year of service. */
export const SEPARATION_EXEMPT_CAP_KEY = 'income_tax.exempt_cap.separation_uma_per_year_of_service';

/** The policy that decides what is compared with the USMO. Its values are persisted. */
export const SEPARATION_ISR_USMO_COMPARISON_POLICY = 'separation_isr_usmo_comparison';

const KNOWN_COMPARISONS: readonly UsmoComparison[] = ['total_payments', 'taxable_payments'];

/** Reads `separation_isr_usmo_comparison` for the entity. Closed on declaring, like `readUsmoIsrSubsidy`. */
export async function readSeparationIsrUsmoComparison(ctx: PolicyContext): Promise<UsmoComparison> {
  const { value } = await getPolicy(ctx, SEPARATION_ISR_USMO_COMPARISON_POLICY);
  const known = KNOWN_COMPARISONS.find((v) => v === value);
  if (!known) {
    throw new AccountingError(
      'POLICY_VALUE_UNKNOWN',
      `${SEPARATION_ISR_USMO_COMPARISON_POLICY} = "${value}" is not a value this system knows ` +
        `(${KNOWN_COMPARISONS.join(', ')}); nothing was calculated. Correct it with mnemosine pending.`
    );
  }
  return known;
}

export type SeparationIsrRoute = 'none' | 'exempt' | 'tariff' | 'effective_rate' | 'not_calculated';

/** The settlement's `separation_isr` block. Amounts are four-decimal strings. */
export interface SeparationIsr {
  /** What was paid for separation (today the seniority premium); null if it could not be calculated. */
  payments: string | null;
  /** fr. XIII years: completed, plus one for more than six months. */
  exemption_years_of_service: number;
  uma_daily: string | null;
  /** 90 × UMA × years, to the cent. */
  exempt_cap: string | null;
  exempt: string | null;
  taxable: string | null;
  route: SeparationIsrRoute;
  /** The last ordinary monthly salary the route was decided against. */
  usmo: string | null;
  usmo_comparison: UsmoComparison | null;
  /** The ISR of the USMO by the monthly tariff (effective_rate only). */
  isr_of_usmo: string | null;
  /** The monthly subsidy of the USMO, under `net_of_subsidy` only. */
  employment_subsidy_of_usmo: string | null;
  /** (ISR − subsidy) / USMO × 100, four decimals, display only (effective_rate only). */
  rate_percent: string | null;
  /** The ISR withheld for separation, or null when it was not calculated. */
  withholding: string | null;
  note: string;
}

export interface SeparationIsrInput {
  /** The separation payments; null when the premium itself was not calculated. */
  payments: string | null;
  hireDate: string | Date;
  /** 'YYYY-MM-DD'. */
  terminationDate: string;
  /** The USMO of the settlement's `basis` (daily wage × `usmo_days_per_month`). */
  usmo: string;
  usmoIsrSubsidy: UsmoIsrSubsidy;
  /** The employee's entity: where the comparison key and the subsidy rounding are read. */
  panel: PolicyContext;
}

const ZERO = '0.0000';

const NO_RATE = {
  usmo: null,
  usmo_comparison: null,
  isr_of_usmo: null,
  employment_subsidy_of_usmo: null,
  rate_percent: null,
} as const;

/** The ISR of a monthly income by the monthly tariff, to the cent (MexicoIsrCalculator rounds it). */
async function monthlyIsr(amount: string, day: string, year: number): Promise<Decimal> {
  const out = await new MexicoIsrCalculator().calculate({
    taxable_wages: Number(amount),
    pay_frequency: 'monthly',
    tax_year: year,
    pay_date: day,
  });
  return new Decimal(out.tax_amount);
}

export async function calculateSeparationIsr(input: SeparationIsrInput): Promise<SeparationIsr> {
  const years = separationYearsOfService(input.hireDate, input.terminationDate);
  const blank = { ...NO_RATE, exemption_years_of_service: years, uma_daily: null, exempt_cap: null };

  if (input.payments === null) {
    return {
      ...blank, payments: null, exempt: null, taxable: null, route: 'not_calculated', withholding: null,
      note: 'NOT CALCULATED: the seniority premium was not calculated, so neither is its separation ISR.',
    };
  }
  // No separation payment: no law to read, nothing to withhold.
  if (new Decimal(input.payments).lessThanOrEqualTo(0)) {
    return {
      ...blank, payments: input.payments, exempt: ZERO, taxable: ZERO, route: 'none', withholding: ZERO,
      note: 'No separation payment (seniority premium or indemnity): nothing to exempt or withhold.',
    };
  }

  const day = input.terminationDate;
  let cap: LegalParameterInForce;
  try {
    cap = await legalParameterAt('MX', SEPARATION_EXEMPT_CAP_KEY, day);
  } catch (err) {
    // THE ROW IS SEEDED, NOT MIGRATED (`seedLegalParameters`). An install
    // that has not run the law seed has no 90 UMA; the settlement still
    // answers its gross figures, and says which row is missing instead of
    // inventing an exemption, a withholding, or refusing the whole settlement.
    if (!(err instanceof LegalParameterUnavailableError)) throw err;
    return {
      ...blank, payments: input.payments, exempt: null, taxable: null, route: 'not_calculated', withholding: null,
      note:
        `NOT CALCULATED: the legal parameter ${SEPARATION_EXEMPT_CAP_KEY} is not available on ${day} ` +
        `(${err.gap}), so the exemption of LISR art. 93 fr. XIII cannot be applied. Load the law seed.`,
    };
  }
  if (cap.unit !== 'UMA') {
    throw new Error(
      `${SEPARATION_EXEMPT_CAP_KEY} is in "${cap.unit}" and LISR art. 93 fr. XIII counts it in UMA: ` +
        '90 pesos are not 90 UMA, and nothing was calculated.'
    );
  }
  const year = aFechaUtc(day).getUTCFullYear();
  const uma = new Decimal(requiredParameter(await getTaxParameters('MX', year, day), 'uma_daily', 'MX', year));
  const x = separationExemption({
    payments: input.payments,
    years,
    umaDaily: uma.toString(),
    capUmaPerYear: cap.value,
  });
  const law = { ...blank, uma_daily: uma.toFixed(4), exempt_cap: x.cap, exempt: x.exempt, taxable: x.taxable };
  const exemption =
    `LISR art. 93 fr. XIII: ${cap.value} UMA × ${uma.toFixed(2)} × ${years} year(s) = ${x.cap} exempt`;

  if (new Decimal(x.taxable).isZero()) {
    return { ...law, payments: input.payments, route: 'exempt', withholding: ZERO, note: `${exemption}; nothing is taxed.` };
  }

  // ── PART B · THE WITHHOLDING OF LISR ART. 96 (MNE-001-579) ──
  const comparison = await readSeparationIsrUsmoComparison(input.panel);
  const route = separationRoute({ payments: input.payments, taxable: x.taxable, usmo: input.usmo, comparison });
  const compared = comparison === 'total_payments' ? `the total paid, ${input.payments}` : `the taxable part, ${x.taxable}`;
  const decided = { ...law, payments: input.payments, usmo: input.usmo, usmo_comparison: comparison };

  if (route === 'tariff') {
    const isr = await monthlyIsr(x.taxable, day, year);
    return {
      ...decided, route, withholding: isr.toFixed(4),
      note:
        `${exemption}; ${compared} is below the USMO ${input.usmo}, so LISR art. 96 applies the monthly ` +
        `tariff to the taxable ${x.taxable}: ${isr.toFixed(2)} withheld.`,
    };
  }
  if (route !== 'effective_rate') {
    return {
      ...decided, route: 'not_calculated', withholding: null,
      note:
        `${exemption}; NOT CALCULATED: the USMO is ${input.usmo}, and the rate of LISR art. 96 divides by it. ` +
        'A settlement without a daily wage has no last ordinary monthly salary.',
    };
  }

  const isrOfUsmo = await monthlyIsr(input.usmo, day, year);
  let subsidy: Decimal | null = null;
  if (input.usmoIsrSubsidy === 'net_of_subsidy') {
    const out = await new MexicoSubsidioEmpleoCalculator().calculate({
      taxable_wages: Number(input.usmo),
      pay_frequency: 'monthly',
      tax_year: year,
      pay_date: day,
      employment_subsidy_rounding: await readEmploymentSubsidyRounding(input.panel),
    });
    subsidy = new Decimal(out.tax_amount);
  }
  const w = withholdingAtUsmoRate({
    taxable: x.taxable,
    usmo: input.usmo,
    isrOfUsmo: isrOfUsmo.toString(),
    subsidyOfUsmo: subsidy === null ? null : subsidy.toString(),
  });
  return {
    ...decided,
    route,
    isr_of_usmo: isrOfUsmo.toFixed(4),
    employment_subsidy_of_usmo: subsidy === null ? null : subsidy.toFixed(4),
    rate_percent: w.ratePercent,
    withholding: w.withholding,
    note:
      `${exemption}; ${compared} is not below the USMO ${input.usmo}, so LISR art. 96 withholds the ` +
      `taxable ${x.taxable} at the ISR of the USMO by the monthly tariff (${isrOfUsmo.toFixed(2)}` +
      (subsidy === null ? ', gross of the tariff' : `, less the subsidy ${subsidy.toFixed(2)}`) +
      `) divided by the USMO: ${w.ratePercent} %, ${new Decimal(w.withholding).toFixed(2)} withheld.`,
  };
}
