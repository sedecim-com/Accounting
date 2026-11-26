import Decimal from 'decimal.js';
import type pg from 'pg';
import { getPolicy } from '../../policy/policy-service.js';
import { AccountingError } from '../../../utils/errors.js';

// ============================================================
// MX · THE ISR OF A PAYMENT MADE APART (#601, MNE-001-739)
//
// A year-end bonus paid in its own run, in a period whose salary another
// paycheck already paid: its ISR was computed on its own base alone, with the
// period's tariff, as if it were all the worker earned in the period. How it is
// computed is an accounting-treatment fork (the restriction of #601), so it is
// the policy `separate_payment_isr` (AGENTS.md invariant 6, ADR-0006):
//
//   · period_accumulated_base (default): the period's tariff on the ISR base
//     of the worker's paychecks of the period together, less the ISR those
//     paychecks already caused, never below zero. The tariff of LISR art. 96
//     is the one published for the period (isr-calculator.ts), so it is
//     applied to the period's income. It never withholds less than the next
//     option, because the marginal rate of the tariff rises with the income.
//   · regulation_optional_procedure: the optional procedure of RLISR art. 174
//     for extraordinary payments. ITS TEXT IS NOT IN THE REPOSITORY (the
//     research note on Mexican tax law, fiscal-mx.md, says the RLISR was not
//     opened), so its arithmetic is not written from memory: the separate
//     paycheck is refused, by key, until the text is in the corpus. A
//     paycheck that is not separate keeps its own base.
//   · own_paycheck_base: as before, this paycheck's base alone.
//
// The key is read when the paycheck shares its period with another paycheck
// of the worker, or is itself separate: the condition the subsidy key of the
// same situation is read under. A paycheck alone in its period that is not
// separate does not read it, and its figure is what it was.
// ============================================================

/** The policy. Its values are persisted: never rename them. */
export const SEPARATE_PAYMENT_ISR_POLICY = 'separate_payment_isr';

export type SeparatePaymentIsr = 'period_accumulated_base' | 'regulation_optional_procedure' | 'own_paycheck_base';

const KNOWN_TREATMENTS: readonly SeparatePaymentIsr[] = [
  'period_accumulated_base',
  'regulation_optional_procedure',
  'own_paycheck_base',
];

/**
 * The key of `paychecks.calculation_details` under which a paycheck that read
 * the policy records the treatment and the figures. Persisted: never rename it.
 */
export const SEPARATE_PAYMENT_ISR_DETAIL = 'separate_payment_isr';

/** The treatment, and whether the firm answered it or the default stands. */
export interface SeparatePaymentIsrPolicy {
  treatment: SeparatePaymentIsr;
  answeredByFirm: boolean;
}

/** Closed on declaring, like `readEmploymentSubsidySeparateRun`. */
export async function readSeparatePaymentIsr(
  ctx: { tenantId: string; entityId?: string },
  client?: pg.PoolClient
): Promise<SeparatePaymentIsrPolicy> {
  const policy = await getPolicy(ctx, SEPARATE_PAYMENT_ISR_POLICY, client);
  const treatment = KNOWN_TREATMENTS.find((t) => t === policy.value);
  if (!treatment) {
    throw new AccountingError(
      'SEPARATE_PAYMENT_ISR_UNKNOWN',
      `The policy ${SEPARATE_PAYMENT_ISR_POLICY} is "${policy.value}" and this reader only knows ` +
        `${KNOWN_TREATMENTS.join(', ')}. Correct it in mnemosine pending.`
    );
  }
  return { treatment, answeredByFirm: policy.defined };
}

/**
 * The ISR a paycheck causes, given the other paychecks of its period.
 *
 * @param ownBase the tariff ISR on this paycheck's base alone.
 * @param onCombinedBase the tariff ISR on the base of the period's paychecks
 *   together; needed only by `period_accumulated_base` when others exist.
 * @param alreadyCaused the ISR the other paychecks of the period caused.
 */
export function isrOfPaycheckInPeriod(args: {
  treatment: SeparatePaymentIsr;
  separate: boolean;
  otherPaychecks: number;
  ownBase: Decimal.Value;
  onCombinedBase: Decimal.Value | null;
  alreadyCaused: Decimal.Value;
}): Decimal {
  const own = new Decimal(args.ownBase);
  if (args.treatment === 'regulation_optional_procedure') {
    if (!args.separate) return own;
    throw new AccountingError('SEPARATE_PAYMENT_ISR_PROCEDURE_NOT_IN_CORPUS', {
      key: 'payroll.separate_payment_isr.regulation_procedure_not_in_corpus',
      params: { key: SEPARATE_PAYMENT_ISR_POLICY },
    });
  }
  if (args.treatment === 'own_paycheck_base' || args.otherPaychecks === 0 || args.onCombinedBase === null) return own;
  return Decimal.max(0, new Decimal(args.onCombinedBase).minus(args.alreadyCaused));
}
