import Decimal from 'decimal.js';
import type pg from 'pg';
import { MINIMUM_WAGE_ZONES } from '../../../database/enums.js';
import { AccountingError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import type { PayFrequency } from '../tax-engine/tax-engine.interface.js';
import { getTaxParameters } from '../tax-engine/tax-tables.js';
import { DAYS_PER_MONTH, subsidyDaysInPeriod } from './employment-subsidy.js';
import { salarioDiarioDesdeSueldoAnual } from './finiquito-math.js';
import { dailyMinimumWageFor, minimumWageZoneOf, type MinimumWageZone, type ZoneOf } from './minimum-wage-zone.js';

// ============================================================
// MX · THE WORKER WHO EARNS THE MINIMUM WAGE OF THEIR AREA
// (#196, MNE-001-633 · #1076, MNE-001-923)
//
// ONE TEST, SEVERAL READERS. Who earns the minimum wage is asked by the
// overtime exemption (LISR art. 93 fr. I, isr-exemption.ts) and by the ISR
// withholding below; the worker's IMSS quota (LSS art. 36, MNE-001-924) asks
// it next. They share `earnsTheMinimumWage`, so they cannot disagree.
//
// LISR ART. 96, FIRST PARAGRAPH: no withholding is made from the persons who
// in the month earn only one general minimum wage of their geographic area.
// Text read on 2026-11-27 in the LISR published by the Chamber of Deputies
// (last reform DOF 01-04-2024); the manual src/ai/docs/payroll.md carries the
// paragraph verbatim, with its source. The tariff used to be applied to every
// base: in 2026 a fortnight of 4 725.60 in the general zone had 72.75
// withheld, and one of 6 613.05 at the border 562.70.
//
// HOW A PAY PERIOD READS IT.
//   · WHO: the contractual daily wage is at most the daily minimum of the
//     worker's zone on the payment date (`earnsTheMinimumWage`).
//   · ONLY: the ISR base of the worker's paychecks of the period is at
//     most the minimum wage of the period. Exempt earnings are outside the
//     base, so this worker's overtime (fr. I) does not break it.
//   · THE MINIMUM OF THE PERIOD: the daily minimum × its days, the calendar
//     days of the period and never fewer than the days the tariff applied to
//     it is built on (7, 15, a month of 30.4). A fixed fortnight of 15 days is
//     not taxed because February is short (16 to 28: 15 days), and a worker
//     paid by the day is not taxed because July is long (16 to 31: 16 days).
//   · THE DATE is the payment date, the date of the act for ISR (#242): the
//     minimum in force that day measures the whole period.
//   · ANOTHER TAXED EARNING (the base is over the minimum) is an
//     accounting-treatment fork, the policy `minimum_wage_isr_exemption`
//     (AGENTS.md invariant 6, ADR-0006): `only_minimum_wage_paid` (default)
//     applies the tariff to the whole base, the reading that can only
//     withhold more; `minimum_wage_part_never_taxed` applies it to the excess.
// ============================================================

/** What the test needs to know of one worker on one payment date. */
export interface MinimumWageContext {
  tenantId: string;
  entityId: string;
  employeeId: string;
  /** 'YYYY-MM-DD': the payment date. */
  payDate: string;
  /** Calendar days of the pay period, inclusive. */
  periodDays: number;
  /** `employees.annual_salary`, the contractual wage. Absent = unknown. */
  annualSalary?: string | null;
}

/** The minimum wage a worker earns: its zone, who declared it and the daily figure. */
export interface MinimumWageEarned {
  zone: MinimumWageZone;
  declaredBy: ZoneOf['declaredBy'];
  daily: string;
}

// One answer per context object: the overtime exemption and the ISR
// withholding of the same paycheck ask with the same context, and the zone is
// read once.
const answered = new WeakMap<object, Promise<MinimumWageEarned | null>>();

/**
 * Whether the worker earns the minimum wage of their zone on the payment date,
 * and which minimum: the contractual daily wage (`annual_salary` / 365, as the
 * settlement reads it) is at most the daily minimum of the employee's zone,
 * else the entity's, else the general one undeclared (MNE-001-376). Each
 * unknown answers null, and null is the treatment of everyone else, which
 * over-withholds and never under-withholds: no annual salary, or a zone whose
 * minimum is not loaded for the year.
 *
 * The zone is read only when the wage is at most some zone's minimum, so a
 * worker above every minimum costs no statement.
 *
 * @param params the `tax_parameters` in force on `who.payDate`.
 */
export function earnsTheMinimumWage(
  who: Pick<MinimumWageContext, 'tenantId' | 'entityId' | 'employeeId' | 'annualSalary'>,
  params: Record<string, unknown>
): Promise<MinimumWageEarned | null> {
  let answer = answered.get(who);
  if (!answer) {
    answer = minimumWageEarnedBy(who, params);
    answered.set(who, answer);
  }
  return answer;
}

async function minimumWageEarnedBy(
  who: Pick<MinimumWageContext, 'tenantId' | 'entityId' | 'employeeId' | 'annualSalary'>,
  params: Record<string, unknown>
): Promise<MinimumWageEarned | null> {
  if (!who.annualSalary) return null;
  const daily = new Decimal(salarioDiarioDesdeSueldoAnual(who.annualSalary));
  const minimumIfEarned = (zone: MinimumWageZone): string | null => {
    const minimum = dailyMinimumWageFor(params, zone);
    return minimum !== undefined && daily.lte(minimum) ? minimum : null;
  };
  if (!MINIMUM_WAGE_ZONES.some(minimumIfEarned)) return null;
  const { zone, declaredBy } = await minimumWageZoneOf({ tenantId: who.tenantId, entityId: who.entityId }, who.employeeId);
  const minimum = minimumIfEarned(zone);
  return minimum === null ? null : { zone, declaredBy, daily: minimum };
}

/**
 * The minimum wage of a pay period: the daily minimum × the calendar days of
 * the period, never fewer than the days of the tariff applied to it. To the
 * cent, down: a cent over the product is over the minimum.
 */
export function minimumWageOfPeriod(
  daily: Decimal.Value,
  frequency: PayFrequency,
  calendarDays: number
): { days: Decimal; amount: Decimal } {
  const days = Decimal.max(calendarDays, subsidyDaysInPeriod(frequency) ?? DAYS_PER_MONTH);
  return { days, amount: new Decimal(daily).times(days).toDecimalPlaces(2, Decimal.ROUND_DOWN) };
}

/** The policy. Its values are persisted: never rename them. */
export const MINIMUM_WAGE_ISR_POLICY = 'minimum_wage_isr_exemption';
export const MINIMUM_WAGE_ISR_POLICIES = ['only_minimum_wage_paid', 'minimum_wage_part_never_taxed'] as const;

/**
 * The key of `paychecks.calculation_details` under which the paycheck of a
 * minimum-wage worker records how art. 96 was read. `payslip show` reads it.
 * Persisted, like the treatments: never rename them.
 */
export const MINIMUM_WAGE_ISR_DETAIL = 'minimum_wage_isr_exemption';
export const MINIMUM_WAGE_ISR_TREATMENTS = ['not_withheld', 'tariff_on_whole_base', 'tariff_on_excess'] as const;

/** How the ISR of a minimum-wage worker's paycheck is withheld, and the measure behind it. */
export interface MinimumWageIsr {
  treatment: (typeof MINIMUM_WAGE_ISR_TREATMENTS)[number];
  /** The panel's answer; null when it was not read (the base is within the minimum). */
  policy: (typeof MINIMUM_WAGE_ISR_POLICIES)[number] | null;
  earned: MinimumWageEarned;
  days: Decimal;
  /** The minimum wage of the period. */
  minimum: Decimal;
  /** The ISR base of the worker's paychecks of the period, this one included. */
  taxableOfPeriod: Decimal;
}

/**
 * LISR art. 96, first paragraph, for one paycheck. Null for whoever does not
 * earn the minimum wage of their zone (or cannot be told to): the tariff
 * applies as it always did, and nothing is recorded.
 *
 * The panel key is read only when the base is over the minimum: within it
 * both answers withhold nothing.
 */
export async function minimumWageIsr(args: {
  who: MinimumWageContext;
  frequency: PayFrequency;
  taxableOfPeriod: Decimal;
  client?: pg.PoolClient;
}): Promise<MinimumWageIsr | null> {
  const { who, taxableOfPeriod } = args;
  if (!who.annualSalary || !taxableOfPeriod.greaterThan(0)) return null;
  const params = await getTaxParameters('MX', Number(who.payDate.slice(0, 4)), who.payDate);
  const earned = await earnsTheMinimumWage(who, params);
  if (!earned) return null;
  const { days, amount: minimum } = minimumWageOfPeriod(earned.daily, args.frequency, who.periodDays);
  const measure = { earned, days, minimum, taxableOfPeriod };
  if (taxableOfPeriod.lte(minimum)) return { ...measure, treatment: 'not_withheld', policy: null };
  const answer = await getPolicy({ tenantId: who.tenantId, entityId: who.entityId }, MINIMUM_WAGE_ISR_POLICY, args.client);
  const policy = MINIMUM_WAGE_ISR_POLICIES.find((p) => p === answer.value);
  if (!policy) {
    throw new AccountingError('MINIMUM_WAGE_ISR_EXEMPTION_UNKNOWN', {
      key: 'error.POLICY_VALUE_UNKNOWN.payroll_reader',
      params: { policy: MINIMUM_WAGE_ISR_POLICY, value: answer.value, known: MINIMUM_WAGE_ISR_POLICIES.join(', ') },
    });
  }
  return { ...measure, policy, treatment: policy === 'only_minimum_wage_paid' ? 'tariff_on_whole_base' : 'tariff_on_excess' };
}

/**
 * The part of an ISR base the tariff is applied to. Only `tariff_on_excess`
 * changes it: the minimum wage of the period is taken out once, so what other
 * paychecks of the period already counted of it (`countedElsewhere`, their
 * base) is not taken out again.
 */
export function baseForTariff(m: MinimumWageIsr | null, base: Decimal.Value, countedElsewhere: Decimal.Value = 0): number {
  if (m?.treatment !== 'tariff_on_excess') return new Decimal(base).toNumber();
  const minimumLeft = Decimal.max(0, m.minimum.minus(countedElsewhere));
  return Decimal.max(0, new Decimal(base).minus(minimumLeft)).toNumber();
}

/** What the paycheck stores under MINIMUM_WAGE_ISR_DETAIL. `tariffIsr`: what the tariff gives on this paycheck. */
export function minimumWageIsrDetail(m: MinimumWageIsr, tariffIsr: Decimal.Value): Record<string, string | number | null> {
  return {
    treatment: m.treatment,
    policy: m.policy,
    zone: m.earned.zone,
    zone_declared_by: m.earned.declaredBy,
    daily_minimum: new Decimal(m.earned.daily).toFixed(2),
    days: m.days.toNumber(),
    minimum_of_period: m.minimum.toFixed(2),
    taxable_of_period: m.taxableOfPeriod.toFixed(2),
    ...(m.treatment === 'not_withheld' ? { tariff_isr_not_withheld: new Decimal(tariffIsr).toFixed(2) } : {}),
  };
}

/** The note of the ISR row of `paycheck_taxes`: a stored value, in English. */
export function minimumWageIsrNote(m: MinimumWageIsr, tariffIsr: Decimal.Value): string {
  const measure =
    `ISR base of the period ${m.taxableOfPeriod.toFixed(2)}, minimum wage of the period ${m.minimum.toFixed(2)} ` +
    `(${m.days.toString()} days at ${new Decimal(m.earned.daily).toFixed(2)}, zone ${m.earned.zone})`;
  if (m.treatment === 'not_withheld') {
    return (
      'not withheld, LISR art. 96, first paragraph: the worker earns only the minimum wage of the area · ' +
      `${measure} · the tariff gives ${new Decimal(tariffIsr).toFixed(2)}`
    );
  }
  const reading =
    m.treatment === 'tariff_on_excess'
      ? 'the minimum wage of the worker is not taxed and the tariff applies to the excess'
      : 'the worker earns the minimum wage and another taxed earning, so the tariff applies to the whole base';
  return `LISR art. 96, first paragraph: ${reading} · ${measure} [${m.policy}]`;
}
