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
// Each earning now carries both parts. The same fraction exempts the vacation
// premium up to 15 UMA a year, a cap of its own (MNE-001-063). What this
// module does NOT cover yet: overtime (fr. I, waiting on decision
// MNE-001-109), which enters here as one more earning type.
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
 * The law is read ONLY when an earning with a cap is present: a regular
 * payslip costs no query and cannot fail on a cap it does not use.
 */
export async function isrPartsOf(
  earnings: readonly IsrEarning[],
  mx: IsrExemptionContext | null
): Promise<IsrParts[]> {
  const rooms = new Map<string, Decimal>();
  const parts: IsrParts[] = [];
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
    } else {
      parts.push({ exempt: new Decimal(0), taxable: new Decimal(e.amount) });
    }
  }
  return parts;
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
