import Decimal from 'decimal.js';
import type pg from 'pg';
import { query } from '../../../database/connection.js';
import { getPolicy } from '../../policy/policy-service.js';
import { AccountingError } from '../../../utils/errors.js';
import type { PayFrequency } from '../tax-engine/tax-engine.interface.js';

// ============================================================
// MX · THE 2026 EMPLOYMENT SUBSIDY: A SHARE OF THE UMA, ROUNDED BY POLICY
//
// Since the decree of 1 May 2024 the subsidy is no longer a bracket table: it
// is ONE monthly amount, a percentage of the monthly UMA, for whoever earns
// no more than a monthly cap. Migration 009 seeded the repealed table and the
// calculator kept reading it (#298). For 2026 (DOF 31-12-2025) the amount is
// 15.59 % of the 2025 UMA in January — the 2026 UMA only takes effect on
// February 1st — and 15.02 % of the 2026 UMA from then on. A pay period
// shorter than a month receives the monthly amount / 30.4 × its days.
//
// The law is read from `legal_parameters` by the calculator; this module holds
// the arithmetic and the one thing the decree leaves open, which is how to
// round. That is not chosen here: it is the policy `subsidio_al_empleo_redondeo`
// (AGENTS.md invariant 6), decided by the owner on 2026-09-26 (MNE-001-004).
//
//   · producto_al_centavo (default): one rounding to the cent, half up, of
//     the monthly product; the period is the ROUNDED monthly × days / 30.4,
//     rounded again to the cent. 535.65 / 264.30 / 123.34 from February,
//     536.21 / 264.58 / 123.47 in January.
//   · diario_al_centavo: the daily amount (rounded monthly / 30.4) is rounded
//     to the cent before multiplying by the days. Only January changes: the
//     quincena is 264.60.
//
// Both derive the period from the ALREADY-ROUNDED monthly amount, so the
// figure a worker sees for the month and the one the quincena is cut from
// are the same number. Rejected (#298): 536.22, which no rounding produces
// from the UMA in force, and truncation, which has no source.
// ============================================================

/** The policy that decides the rounding. Its values are persisted: never rename them. */
export const EMPLOYMENT_SUBSIDY_ROUNDING_POLICY = 'subsidio_al_empleo_redondeo';

export type EmploymentSubsidyRounding = 'producto_al_centavo' | 'diario_al_centavo';

const KNOWN_ROUNDINGS: readonly EmploymentSubsidyRounding[] = ['producto_al_centavo', 'diario_al_centavo'];

/** The decree's divisor: a month is 30.4 days, the same one the Anexo 8 uses. */
const DAYS_PER_MONTH = new Decimal('30.4');

function toCent(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * How many days of subsidy a pay period carries, or `null` for a whole month.
 *
 * Seven and fifteen are the days the Anexo 8 tariffs of the same periods are
 * built on, so the subsidy and the ISR it is credited against speak of the
 * same period. A fortnight of 14 days, a US `semimonthly` or an annual
 * payment has no ISR tariff (`tarifaDelPeriodo`) and gets no guessed subsidy.
 */
export function subsidyDaysInPeriod(freq: PayFrequency): number | null {
  switch (freq) {
    case 'weekly': return 7;
    case 'quincenal': return 15;
    case 'monthly': return null;
    default:
      throw new Error(
        `No hay regla del subsidio al empleo para el periodo «${freq}»: el decreto prorratea por ` +
          'días entre 30.4, y sólo la semana (7), la quincena (15) y el mes tienen tarifa del art. 96 ' +
          'con la que acreditarlo. Configura la nómina como semanal, quincenal o mensual.'
      );
  }
}

export interface EmploymentSubsidyFigures {
  /** The monthly amount, rounded to the cent. */
  monthly: Decimal;
  /** What this pay period receives, derived from `monthly`. */
  period: Decimal;
}

/**
 * The subsidy of one pay period, from the monthly UMA and the rate in force.
 *
 * @param days the period's days, or `null` for a monthly payment.
 */
export function employmentSubsidyForPeriod(args: {
  umaMonthly: Decimal.Value;
  rate: Decimal.Value;
  days: number | null;
  rounding: EmploymentSubsidyRounding;
}): EmploymentSubsidyFigures {
  const monthly = toCent(new Decimal(args.umaMonthly).times(args.rate));
  if (args.days === null) return { monthly, period: monthly };
  const period =
    args.rounding === 'diario_al_centavo'
      ? toCent(monthly.dividedBy(DAYS_PER_MONTH)).times(args.days)
      : toCent(monthly.times(args.days).dividedBy(DAYS_PER_MONTH));
  return { monthly, period };
}

/**
 * Reads the rounding policy of the entity.
 *
 * CLOSED ON DECLARING, like `leerRegistroDelSubsidio`: a value this reader
 * does not know is named instead of falling back to the first option — a
 * third value in the catalog has to reach this function on purpose.
 */
export async function readEmploymentSubsidyRounding(
  ctx: { tenantId: string; entityId?: string },
  client?: pg.PoolClient
): Promise<EmploymentSubsidyRounding> {
  const policy = await getPolicy(ctx, EMPLOYMENT_SUBSIDY_ROUNDING_POLICY, client);
  const value = KNOWN_ROUNDINGS.find((r) => r === policy.value);
  if (!value) {
    throw new AccountingError(
      'EMPLOYMENT_SUBSIDY_ROUNDING_UNKNOWN',
      `La política ${EMPLOYMENT_SUBSIDY_ROUNDING_POLICY} vale "${policy.value}" y este lector sólo ` +
        `entiende ${KNOWN_ROUNDINGS.join(', ')}. Corrígela en mnemosine pending.`
    );
  }
  return value;
}

// ============================================================
// ONE SUBSIDY PER PAY PERIOD, WHATEVER THE NUMBER OF RUNS (#430, MNE-001-398)
//
// The subsidy was computed per paycheck from that paycheck's own income, so
// an aguinaldo paid in its own run of a period whose regular fortnight had
// already credited it received it again, and the part over its ISR went out
// as cash. What a paycheck gets when its period has more than one is the
// policy `employment_subsidy_separate_run` (AGENTS.md invariant 6), decided
// by the owner in MNE-001-397:
//
//   · recompute_on_combined_income (default): the subsidy is computed once on
//     the income of every paycheck of the period together, and the later
//     paycheck causes only what the earlier ones did not. A negative
//     difference (the combined income is over the cap, so the subsidy already
//     caused was not due) is credited as 0 and not recovered; whether to
//     recover it is a question to the owner on #430.
//   · none_on_separate_paycheck: the SEPARATE paycheck carries no subsidy and
//     the regular one keeps its own. Separate means what the paycheck is, not
//     when it was calculated: a paycheck of a run that is not `regular`, or
//     one that pays only aguinaldo.
//
// Every other run of the same pay period counts (regular, bonus, off_cycle,
// correction, final), with the statuses the overtime and aguinaldo caps read:
// the subsidy is per period, not per kind of payment.
// ============================================================

/** The policy that decides the subsidy of a later paycheck of the period. Its values are persisted. */
export const EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY = 'employment_subsidy_separate_run';

export type EmploymentSubsidySeparateRun = 'recompute_on_combined_income' | 'none_on_separate_paycheck';

const KNOWN_SEPARATE_RUN_TREATMENTS: readonly EmploymentSubsidySeparateRun[] = [
  'recompute_on_combined_income',
  'none_on_separate_paycheck',
];

/** Closed on declaring, like `readEmploymentSubsidyRounding`. */
export async function readEmploymentSubsidySeparateRun(
  ctx: { tenantId: string; entityId?: string },
  client?: pg.PoolClient
): Promise<EmploymentSubsidySeparateRun> {
  const policy = await getPolicy(ctx, EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY, client);
  const value = KNOWN_SEPARATE_RUN_TREATMENTS.find((t) => t === policy.value);
  if (!value) {
    throw new AccountingError(
      'EMPLOYMENT_SUBSIDY_SEPARATE_RUN_UNKNOWN',
      `La política ${EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY} vale "${policy.value}" y este lector sólo ` +
        `entiende ${KNOWN_SEPARATE_RUN_TREATMENTS.join(', ')}. Corrígela en mnemosine pending.`
    );
  }
  return value;
}

/** What the employee's OTHER paychecks of the same pay period already carry. */
export interface SubsidyOfOtherRuns {
  paychecks: number;
  /** Their ISR base (`paychecks.taxable_wages_isr`). */
  taxableIsr: Decimal;
  /** The subsidy they caused: credited against their ISR plus delivered in cash. */
  subsidy: Decimal;
}

/**
 * Reads the employee's paychecks of the other runs of the same pay period.
 * The run being calculated is left out, and only runs that count are read.
 *
 * Scope: tenant and employee in the SQL; the period is the run's own, which
 * the caller resolved inside the tenant and the entity.
 */
export async function subsidyOfOtherRunsInPeriod(ctx: {
  tenantId: string;
  employeeId: string;
  payRunId: string;
  payPeriodId: string;
}): Promise<SubsidyOfOtherRuns> {
  const r = await query<{ paychecks: number; taxable: string; subsidy: string }>(
    `SELECT COUNT(*)::int AS paychecks,
            COALESCE(SUM(p.taxable_wages_isr), 0) AS taxable,
            COALESCE(SUM(p.subsidio_empleo), 0) AS subsidy
       FROM paychecks p
       JOIN pay_runs pr ON pr.id = p.pay_run_id AND pr.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1
        AND p.employee_id = $2
        AND pr.pay_period_id = $3
        AND pr.id <> $4
        AND pr.status IN ('calculated', 'approved', 'paid')`,
    [ctx.tenantId, ctx.employeeId, ctx.payPeriodId, ctx.payRunId]
  );
  const row = r.rows[0];
  return {
    paychecks: row?.paychecks ?? 0,
    taxableIsr: new Decimal(row?.taxable ?? 0),
    subsidy: new Decimal(row?.subsidy ?? 0),
  };
}

/** The earning type of the aguinaldo (LFT art. 87) as payroll captures it. */
const YEAR_END_BONUS_EARNING = 'aguinaldo';

/**
 * Whether a paycheck is the "separate" one of its period: its run is not the
 * regular one, or everything it pays is aguinaldo. It is read from what the
 * paycheck is, so the answer does not depend on which run was calculated first.
 */
export function isSeparatePaycheck(runType: string, earnings: readonly { earning_type: string }[]): boolean {
  if (runType !== 'regular') return true;
  return earnings.length > 0 && earnings.every((e) => e.earning_type === YEAR_END_BONUS_EARNING);
}

/**
 * The subsidy a paycheck causes, given what the other paychecks of its period
 * already caused.
 *
 * @param own the subsidy on this paycheck's own income.
 * @param onCombinedIncome the subsidy of the period computed on the income of
 *   all its paychecks together; used only by `recompute_on_combined_income`.
 */
export function subsidyOfPaycheckInPeriod(args: {
  treatment: EmploymentSubsidySeparateRun;
  separate: boolean;
  own: Decimal.Value;
  onCombinedIncome: Decimal.Value;
  alreadyCaused: Decimal.Value;
}): Decimal {
  const recompute = args.treatment === 'recompute_on_combined_income';
  if (!recompute && args.separate) return new Decimal(0);
  // Under "none" the regular paycheck keeps its own subsidy; the separate
  // paychecks carry none, so `alreadyCaused` only stops a second REGULAR
  // paycheck of the period from getting it twice.
  const difference = new Decimal(recompute ? args.onCombinedIncome : args.own).minus(args.alreadyCaused);
  return difference.greaterThan(0) ? difference : new Decimal(0);
}
