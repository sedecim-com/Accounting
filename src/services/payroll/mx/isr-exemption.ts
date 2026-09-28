import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { legalParameterAt } from '../../jurisdiction/legal-parameters.js';
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
// Each earning now carries both parts. What this module does NOT cover yet:
// the vacation premium (15 UMA, MNE-001-063) and overtime (fr. I, waiting on
// decision MNE-001-109). Both enter here as more earning types.
//
// WHERE EACH NUMBER COMES FROM.
//   · The cap, in UMA, is law with a validity date: `legal_parameters`, key
//     YEAR_END_BONUS_EXEMPT_CAP_KEY, seeded by migration 094. No constant here.
//   · The UMA is the one the rest of the payslip uses: `tax_parameters`
//     (`uma_daily`) on the PAYMENT date, the date the law fixes for ISR
//     (#242). The IMSS engine reads the same row, so one payslip cannot mix
//     two UMAs.
// Both fail closed: a missing cap or UMA throws, never exempts nothing or
// everything in silence.
// ============================================================

/** The art. 93 fr. XIV cap for the aguinaldo, in daily UMA per calendar year. */
export const YEAR_END_BONUS_EXEMPT_CAP_KEY = 'income_tax.exempt_cap.aguinaldo_uma';

/** The earning type that identifies the aguinaldo (see migration 008). */
const YEAR_END_BONUS = 'aguinaldo';

/** The two parts of one earning for ISR. They always add up to its amount. */
export interface IsrParts {
  exempt: Decimal;
  taxable: Decimal;
}

/** What `isrPartsOf` needs to read of an earning. */
export interface IsrEarning {
  earning_type: string;
  amount: number;
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
}

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
 * The law is read ONLY when an aguinaldo is present: a regular payslip costs
 * no query and cannot fail on a cap it does not use.
 */
export async function isrPartsOf(
  earnings: readonly IsrEarning[],
  mx: IsrExemptionContext | null
): Promise<IsrParts[]> {
  let room: Decimal | null = null;
  const parts: IsrParts[] = [];
  for (const e of earnings) {
    if (e.is_taxable_isr === false) {
      parts.push({ exempt: new Decimal(e.amount), taxable: new Decimal(0) });
    } else if (mx && e.earning_type === YEAR_END_BONUS) {
      room ??= await yearEndBonusRoom(mx);
      const p = splitAgainstCap(e.amount, room);
      room = room.minus(p.exempt);
      parts.push(p);
    } else {
      parts.push({ exempt: new Decimal(0), taxable: new Decimal(e.amount) });
    }
  }
  return parts;
}

/** The aguinaldo exemption still available to this employee on the payment date. */
async function yearEndBonusRoom(mx: IsrExemptionContext): Promise<Decimal> {
  const year = Number(mx.payDate.slice(0, 4));
  const cap = await legalParameterAt('MX', YEAR_END_BONUS_EXEMPT_CAP_KEY, mx.payDate);
  const params = await getTaxParameters('MX', year, mx.payDate);
  const uma = requiredParameter(params, 'uma_daily', 'MX', year);
  const capMxn = new Decimal(cap.value).times(String(uma)).toDecimalPlaces(2);

  // "DURING A CALENDAR YEAR" (fr. XIV): an aguinaldo paid in two instalments
  // shares one cap. What earlier paychecks of the year exempted is read from
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
        AND pe.earning_type = 'aguinaldo'
        AND pr.status IN ('calculated', 'approved', 'paid')
        AND pp.pay_date >= make_date($3, 1, 1)
        AND pp.pay_date <= $4::date
        AND pr.id <> $5`,
    [mx.tenantId, mx.employeeId, year, mx.payDate, mx.payRunId]
  );
  return capMxn.minus(r.rows[0]?.used ?? 0);
}
