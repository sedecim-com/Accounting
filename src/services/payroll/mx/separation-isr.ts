import Decimal from 'decimal.js';
import {
  legalParameterAt,
  LegalParameterUnavailableError,
  type LegalParameterInForce,
} from '../../jurisdiction/legal-parameters.js';
import { getTaxParameters, requiredParameter } from '../tax-engine/tax-tables.js';
import { aFechaUtc } from './finiquito-math.js';
import { separationExemption, separationYearsOfService } from './separation-isr-math.js';

// ============================================================
// THE SEPARATION ISR OF THE SETTLEMENT · PART A, THE EXEMPTION
// (MNE-001-375 · #194)
//
// The shell of `separation-isr-math.ts`: it reads the law (the 90 UMA of
// LISR art. 93 fr. XIII and the UMA of the termination date) and says what of
// the separation payments is exempt and what is taxed.
//
// THE ACT DATE IS THE TERMINATION DATE. ISR goes by the payment date, but a
// settlement has none; the termination date is the one `calculateFiniquito`
// already reads the tariff year and the minimum wage with. A termination in
// January reads the UMA of the year before, which is still in force.
//
// WHAT IS NOT HERE YET. The withholding on a taxable part (LISR art. 96, the
// paragraph on payments of art. 95: the rate ISR(USMO) / USMO, or the monthly
// tariff when the payments are below the USMO) is MNE-001-579. Until then a
// taxable part is NAMED, never printed as a zero withholding.
// ============================================================

/** LISR art. 93 fr. XIII: the separation cap, in daily UMA per year of service. */
export const SEPARATION_EXEMPT_CAP_KEY = 'income_tax.exempt_cap.separation_uma_per_year_of_service';

export type SeparationIsrRoute = 'none' | 'exempt' | 'not_calculated';

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
}

const ZERO = '0.0000';

export async function calculateSeparationIsr(input: SeparationIsrInput): Promise<SeparationIsr> {
  const years = separationYearsOfService(input.hireDate, input.terminationDate);
  const blank = { exemption_years_of_service: years, uma_daily: null, exempt_cap: null };

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
    // inventing an exemption or refusing the whole settlement.
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
  const basis =
    `LISR art. 93 fr. XIII: ${cap.value} UMA × ${uma.toFixed(2)} × ${years} year(s) = ${x.cap} exempt`;

  if (new Decimal(x.taxable).isZero()) {
    return { ...law, payments: input.payments, route: 'exempt', withholding: ZERO, note: `${basis}; nothing is taxed.` };
  }
  return {
    ...law, payments: input.payments, route: 'not_calculated', withholding: null,
    note:
      `${basis}; NOT WITHHELD: the taxable part of ${x.taxable} goes at the rate of the last ordinary ` +
      'monthly salary (LISR art. 96), which arrives with MNE-001-579.',
  };
}
