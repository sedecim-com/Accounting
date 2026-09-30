import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { ValidationError } from '../../../utils/errors.js';
import { legalParameterAt } from '../../jurisdiction/legal-parameters.js';
import { getPolicy } from '../../policy/policy-service.js';
import { getTaxParameters, requiredParameter } from '../tax-engine/tax-tables.js';

// ============================================================
// THE EXEMPT PART OF AN EARNING (LISR art. 93 · #297, MNE-001-062)
//
// `taxableIsr` used to treat each earning as all or nothing: taxable unless
// flagged `is_taxable_isr: false`. The aguinaldo is neither. Art. 93 fr. XIV
// exempts the year-end bonus up to 30 daily UMA per calendar year and taxes
// the rest, so a December aguinaldo was over-withheld on the one payslip the
// worker reads most closely.
//
// Each earning now carries both parts. The same fraction exempts the vacation
// premium up to 15 UMA a year, a cap of its own (MNE-001-063). Overtime
// (fr. I, MNE-001-110) has a cap of another shape, per week of the period and
// not per year: see `overtimeParts` below.
//
// WHERE EACH NUMBER COMES FROM.
//   · The cap, in UMA, is law with a validity date: `legal_parameters`, keys
//     YEAR_END_BONUS_EXEMPT_CAP_KEY (migration 094) and
//     VACATION_PREMIUM_EXEMPT_CAP_KEY (migration 106). No constant here.
//   · The DAILY UMA comes from `tax_parameters` (`uma_daily`) on the PAYMENT
//     date, the date the law fixes for ISR (#242): the same row the IMSS
//     engine reads. The employment subsidy (#298) reads the MONTHLY UMA from
//     `legal_parameters` (`uma.monthly`, migration 095), so a payslip reads
//     the UMA from two tables that hold the same published figures.
//     `legal_parameters` has no migrated `uma.daily`, only the demo seed's.
// Both fail closed: a missing cap or UMA throws, never exempts nothing or
// everything in silence.
// ============================================================

/** The art. 93 fr. XIV cap for the aguinaldo, in daily UMA per calendar year. */
export const YEAR_END_BONUS_EXEMPT_CAP_KEY = 'income_tax.exempt_cap.aguinaldo_uma';

/** The art. 93 fr. XIV cap for the vacation premium, in daily UMA per calendar year. */
export const VACATION_PREMIUM_EXEMPT_CAP_KEY = 'income_tax.exempt_cap.vacation_premium_uma';

/**
 * The earning types with a cap of their own (see migration 008), and the key
 * of that cap. Each type has its own room: "por cada uno de los conceptos".
 */
const EXEMPT_CAP_BY_EARNING_TYPE: Readonly<Record<string, string>> = {
  aguinaldo: YEAR_END_BONUS_EXEMPT_CAP_KEY,
  prima_vacacional: VACATION_PREMIUM_EXEMPT_CAP_KEY,
};

/** The two parts of one earning for ISR. They always add up to its amount. */
export interface IsrParts {
  exempt: Decimal;
  taxable: Decimal;
}

/** What `isrPartsOf` needs to read of an earning. */
export interface IsrEarning {
  earning_type: string;
  amount: number;
  /** Hours paid; for overtime, checked against the LFT weekly limit. */
  hours?: number;
  is_taxable_isr?: boolean;
}

/** Who is paid and when: the calendar year and the prior use of the cap hang from it. */
export interface IsrExemptionContext {
  tenantId: string;
  employeeId: string;
  /** The run being calculated: its own earlier paychecks do not count as used. */
  payRunId: string;
  /** 'YYYY-MM-DD': the payment date, the date of the act for ISR. */
  payDate: string;
  /** The run's entity: the overtime policy is answered per entity. */
  entityId: string;
  /** Calendar days of the pay period, inclusive: the weeks of service of fr. I. */
  periodDays: number;
}

/** LISR art. 93 fr. I: the exempt share of overtime pay (0.5). */
export const OVERTIME_EXEMPT_SHARE_KEY = 'income_tax.exempt_share.overtime';
/** LISR art. 93 fr. I: the overtime cap, in daily UMA per week of service. */
export const OVERTIME_EXEMPT_CAP_KEY = 'income_tax.exempt_cap.overtime_uma_per_week';
/** LFT art. 66: the double-paid overtime hours a week; dated by the reform of DOF 01-05-2026. */
export const OVERTIME_WEEKLY_HOURS_KEY = 'labor.overtime.double_hours_per_week';
/** The panel key: whether the firm applies the fr. I exemption at all. */
export const OVERTIME_POLICY_KEY = 'overtime_isr_exemption';
export const OVERTIME_POLICIES = ['exempt_by_law', 'taxed_in_full'] as const;

/**
 * Splits an amount against the exemption room still available.
 *
 * The exempt part is never negative: a negative line (a correction) is all
 * taxable, and a room already used up exempts nothing.
 */
export function splitAgainstCap(amount: Decimal.Value, room: Decimal.Value): IsrParts {
  const a = new Decimal(amount);
  const exempt = Decimal.max(0, Decimal.min(a, room));
  return { exempt, taxable: a.minus(exempt) };
}

/**
 * The exempt and taxable part of each earning, in the same order.
 *
 * @param mx the Mexican context, or null outside Mexico: then only the
 *   all-or-nothing flag applies, as before.
 *
 * The law is read ONLY when an earning with a cap is present: a regular
 * payslip costs no query and cannot fail on a cap it does not use.
 */
export async function isrPartsOf(
  earnings: readonly IsrEarning[],
  mx: IsrExemptionContext | null
): Promise<IsrParts[]> {
  const rooms = new Map<string, Decimal>();
  const parts: IsrParts[] = [];
  let overtime: OvertimeLaw | null = null;
  for (const e of earnings) {
    const capKey = Object.hasOwn(EXEMPT_CAP_BY_EARNING_TYPE, e.earning_type)
      ? EXEMPT_CAP_BY_EARNING_TYPE[e.earning_type]
      : null;
    if (e.is_taxable_isr === false) {
      parts.push({ exempt: new Decimal(e.amount), taxable: new Decimal(0) });
    } else if (mx && capKey) {
      const room = rooms.get(e.earning_type) ?? (await exemptRoom(mx, e.earning_type, capKey));
      const p = splitAgainstCap(e.amount, room);
      rooms.set(e.earning_type, room.minus(p.exempt));
      parts.push(p);
    } else if (mx && e.earning_type === 'overtime') {
      overtime ??= await overtimeLaw(mx);
      const p = overtimeParts(e, overtime);
      overtime.room = overtime.room.minus(p.exempt);
      parts.push(p);
    } else {
      parts.push({ exempt: new Decimal(0), taxable: new Decimal(e.amount) });
    }
  }
  return parts;
}

/** What fr. I needs for one paycheck; `room` is what is left of the period's cap. */
interface OvertimeLaw {
  policy: (typeof OVERTIME_POLICIES)[number];
  share: Decimal;
  room: Decimal;
  maxHours: Decimal;
}

// ── LISR ART. 93 FR. I · OVERTIME (MNE-001-110) ──
//
// "El 50% de las remuneraciones por concepto de tiempo extraordinario [...]
// que no exceda el límite previsto en la legislación laboral y sin que esta
// exención exceda del equivalente de cinco veces el salario mínimo general
// [...] por cada semana de servicios." Text verified on 2026-09-30 against
// the LISR published by the Chamber of Deputies (last reform DOF
// 01-04-2024); the minimum wage as a unit reads as the UMA since the
// desindexation decree (DOF 27-01-2016).
//
// An `overtime` earning is the DOUBLE-paid hours, within the LFT limit. The
// triple-paid ones (LFT art. 68) go as another earning type, which is taxed
// whole like any earning without a cap. A line that says it paid more hours
// than the limit fails closed: exempting half of triple pay is the one error
// here that under-withholds.
//
// The weeks of service are the period's calendar days / 7: a weekly payroll
// gets 5 UMA, a 15-day one 5 × 15/7 UMA. The first sentence of fr. I (100 %
// exempt for minimum-wage workers) is not applied: the schema holds neither
// the worker's contractual daily wage nor the wage zone, so they get the 50 %
// of everyone else, which over-withholds and never under-withholds.
async function overtimeLaw(mx: IsrExemptionContext): Promise<OvertimeLaw> {
  const answer = await getPolicy({ tenantId: mx.tenantId, entityId: mx.entityId }, OVERTIME_POLICY_KEY);
  const policy = OVERTIME_POLICIES.find((p) => p === answer.value);
  if (!policy) {
    throw new ValidationError(
      `The policy ${OVERTIME_POLICY_KEY} is "${answer.value}"; this reader knows ${OVERTIME_POLICIES.join(', ')}.`
    );
  }
  if (policy === 'taxed_in_full') {
    return { policy, share: new Decimal(0), room: new Decimal(0), maxHours: new Decimal(Infinity) };
  }
  const year = Number(mx.payDate.slice(0, 4));
  const share = await legalParameterAt('MX', OVERTIME_EXEMPT_SHARE_KEY, mx.payDate);
  const cap = await legalParameterAt('MX', OVERTIME_EXEMPT_CAP_KEY, mx.payDate);
  const hours = await legalParameterAt('MX', OVERTIME_WEEKLY_HOURS_KEY, mx.payDate);
  const params = await getTaxParameters('MX', year, mx.payDate);
  const uma = requiredParameter(params, 'uma_daily', 'MX', year);
  const weeks = new Decimal(mx.periodDays).dividedBy(7);
  return {
    policy,
    share: new Decimal(share.value),
    room: new Decimal(cap.value).times(String(uma)).times(weeks).toDecimalPlaces(2),
    maxHours: new Decimal(hours.value).times(weeks),
  };
}

/** One overtime line against the law: its exempt share, capped by what is left of the period's room. */
function overtimeParts(e: IsrEarning, law: OvertimeLaw): IsrParts {
  if (law.policy === 'exempt_by_law' && e.hours !== undefined && law.maxHours.lessThan(e.hours)) {
    throw new ValidationError(
      `An overtime line pays ${e.hours} hours and the labour limit for this period is ` +
        `${law.maxHours.toDecimalPlaces(2).toString()} (LFT art. 66): put the hours beyond it, paid triple, ` +
        'in an earning of their own, which is taxed whole (LISR art. 93 fr. I).',
      'hours'
    );
  }
  return splitAgainstCap(e.amount, Decimal.min(law.room, new Decimal(e.amount).times(law.share).toDecimalPlaces(2)));
}

/** An earning row as stored: its flag, and the parts written since migration 094. */
export interface StoredIsrEarning {
  amount: string;
  is_taxable_isr: boolean;
  isr_exempt_amount: string | null;
  isr_taxable_amount: string | null;
}

/**
 * The parts a stored earning DECLARES, on the payroll CFDI (MNE-001-063).
 *
 * The ones the ISR was computed with, read back from the row. A row written
 * before migration 094 has none, and was taxed by its all-or-nothing flag:
 * that flag, and not a figure invented now, is what it declares.
 */
export function storedIsrParts(row: StoredIsrEarning): IsrParts {
  if (row.isr_exempt_amount !== null && row.isr_taxable_amount !== null) {
    return { exempt: new Decimal(row.isr_exempt_amount), taxable: new Decimal(row.isr_taxable_amount) };
  }
  return row.is_taxable_isr
    ? { exempt: new Decimal(0), taxable: new Decimal(row.amount) }
    : { exempt: new Decimal(row.amount), taxable: new Decimal(0) };
}

/** The exemption of one earning type still available to this employee on the payment date. */
async function exemptRoom(mx: IsrExemptionContext, earningType: string, capKey: string): Promise<Decimal> {
  const year = Number(mx.payDate.slice(0, 4));
  const cap = await legalParameterAt('MX', capKey, mx.payDate);
  const params = await getTaxParameters('MX', year, mx.payDate);
  const uma = requiredParameter(params, 'uma_daily', 'MX', year);
  const capMxn = new Decimal(cap.value).times(String(uma)).toDecimalPlaces(2);

  // "DURING A CALENDAR YEAR" (fr. XIV): an aguinaldo (or a vacation premium)
  // paid in two instalments shares one cap, and only earnings of the same type
  // consume it. What earlier paychecks of the year exempted is read from
  // what they stored, in runs that count for the year-to-date (the same
  // statuses `getEmployeeYtd` uses). Rows written before migration 094 have
  // no exempt part: they were taxed whole, so they used none of the cap.
  //
  // Scope: the tenant and the employee. The employee was already checked
  // against the run's entity by the caller, and an employee has one entity.
  const r = await query<{ used: string }>(
    `SELECT COALESCE(SUM(pe.isr_exempt_amount), 0) AS used
       FROM paycheck_earnings pe
       JOIN paychecks p ON p.id = pe.paycheck_id
       JOIN pay_runs pr ON pr.id = p.pay_run_id
       JOIN pay_periods pp ON pp.id = pr.pay_period_id
      WHERE p.tenant_id = $1
        AND p.employee_id = $2
        AND pe.earning_type = $6
        AND pr.status IN ('calculated', 'approved', 'paid')
        AND pp.pay_date >= make_date($3, 1, 1)
        AND pp.pay_date <= $4::date
        AND pr.id <> $5`,
    [mx.tenantId, mx.employeeId, year, mx.payDate, mx.payRunId, earningType]
  );
  return capMxn.minus(r.rows[0]?.used ?? 0);
}
