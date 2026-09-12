import { query } from '../../../../database/connection.js';

// ============================================================
// USA Garnishment Engine (CCPA Title III compliance)
// Priority: federal tax levy > child support > bankruptcy > creditor.
// Caps on disposable earnings:
//   - Child support: 50% (supporting another family) / 55% (arrears >12wk)
//                   60% (not supporting) / 65% (arrears >12wk)
//   - Federal tax levy: exempt amount (IRS Pub 1494 table)
//   - Creditor: lesser of 25% disposable OR excess over 30×FMW/week
// ============================================================

export interface GarnishmentOrder {
  id: string;
  /** The BEHAVIOUR, not the persisted name: see `behaviourOf`. */
  type: 'child_support' | 'tax_levy' | 'creditor' | 'student_loan';
  /** What the order asks for before caps, already resolved from amount_type. */
  desired: number;
  priority: number;
  /** Statutory precedence; lower wins. Priority only breaks ties within it. */
  rank: number;
  supports_second_family?: boolean;
  arrears_over_12_weeks?: boolean;
  exempt_amount?: number; // IRS Pub 1494 for tax levy
}

export interface GarnishmentInput {
  employee_id: string;
  disposable_earnings: number;     // gross - mandatory deductions
  gross_wages: number;
  pay_frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
}

export interface GarnishmentResult {
  total_withheld: number;
  per_order: Array<{ order_id: string; type: string; amount: number; cap_applied: string | null }>;
}

const FMW_PER_HOUR = 7.25; // Federal minimum wage

function weeklyEquivalent(disposable: number, freq: GarnishmentInput['pay_frequency']): number {
  switch (freq) {
    case 'weekly': return disposable;
    case 'biweekly': return disposable / 2;
    case 'semimonthly': return disposable * 24 / 52;
    case 'monthly': return disposable * 12 / 52;
  }
}

function ccpaChildSupportCap(supportsSecond: boolean, arrears12: boolean): number {
  if (supportsSecond) return arrears12 ? 0.55 : 0.50;
  return arrears12 ? 0.65 : 0.60;
}


/**
 * The vocabulary the COLUMN documents, which is the one that is persisted.
 *
 * THE DEFECT THIS CLOSES (T20 · #127): the engine used to branch on its own
 * names —`tax_levy`, and `percentage` for the amount— while the column
 * documented others. Measured on a 25 % order over 2,000 disposable earnings:
 * `child_support` withheld 500 and `pension_alimenticia` withheld **0**;
 * `tax_levy` withheld 1,800 and `tax_levy_federal` withheld **0**. Neither
 * column had a CHECK, so both spellings were storable — and since nothing in
 * `src/` writes this table, whoever files an order follows the column comment,
 * which is precisely the path that withholds nothing.
 */
export type GarnishmentType =
  | 'child_support'
  | 'pension_alimenticia'
  | 'tax_levy_federal'
  | 'tax_levy_state'
  | 'bankruptcy'
  | 'creditor'
  | 'student_loan';

export type AmountType = 'fixed' | 'percent_disposable' | 'percent_gross';

/**
 * How each order type behaves. `pension_alimenticia` is child support under
 * Mexican law, and the two levies share the Pub 1494 exemption path.
 */
function behaviourOf(type: GarnishmentType): 'child_support' | 'tax_levy' | 'creditor' | 'student_loan' {
  switch (type) {
    case 'child_support':
    case 'pension_alimenticia':
      return 'child_support';
    case 'tax_levy_federal':
    case 'tax_levy_state':
      return 'tax_levy';
    case 'creditor':
    case 'bankruptcy':
      return 'creditor';
    case 'student_loan':
      return 'student_loan';
  }
}

/**
 * The order the header of this file promises, and that `ORDER BY priority`
 * alone did NOT deliver: federal tax levy > child support > bankruptcy >
 * creditor. Priority and start date break ties WITHIN a rank, which is what
 * they are for.
 */
const RANK: Record<GarnishmentType, number> = {
  tax_levy_federal: 0,
  tax_levy_state: 1,
  child_support: 2,
  pension_alimenticia: 2,
  bankruptcy: 3,
  creditor: 4,
  student_loan: 5,
};

/**
 * What the order asks for, before any cap.
 *
 * An unknown `amount_type` THROWS. It used to fall through to zero, which on a
 * child-support order is a person not receiving what a court awarded them.
 */
export function desiredAmount(
  amountType: string,
  amountValue: number,
  disposable: number,
  gross: number
): number {
  switch (amountType) {
    case 'fixed': return amountValue;
    case 'percent_disposable': return disposable * (amountValue / 100);
    case 'percent_gross': return gross * (amountValue / 100);
    default:
      throw new Error(
        `Unknown garnishment amount_type «${amountType}»: expected fixed, percent_disposable or ` +
        'percent_gross. It used to withhold zero in silence.'
      );
  }
}

export async function calculateGarnishments(input: GarnishmentInput): Promise<GarnishmentResult> {
  const ordersResult = await query<{
    id: string;
    type: GarnishmentType;
    amount_type: string;
    amount_value: string;
    priority: number;
    supports_second_family: boolean | null;
    arrears_over_12_weeks: boolean | null;
    exempt_amount: string | null;
  }>(
    // El esquema modela el importe como (amount_type, amount_value) y guarda
    // los detalles específicos del embargo estadounidense en `metadata`: los
    // topes de la CCPA (segunda familia, atrasos > 12 semanas, exención) no
    // son atributos universales de un embargo. Se les da alias para no
    // propagar el cambio al cálculo, que es lo delicado de este módulo.
    `SELECT id,
            garnishment_type AS type,
            amount_type,
            amount_value,
            priority,
            (metadata ->> 'supports_second_family')::boolean AS supports_second_family,
            (metadata ->> 'arrears_over_12_weeks')::boolean  AS arrears_over_12_weeks,
            (metadata ->> 'exempt_amount')                    AS exempt_amount
     FROM garnishments
     WHERE employee_id = $1 AND is_active = true
     ORDER BY priority ASC, start_date ASC`,
    [input.employee_id]
  );

  const orders: GarnishmentOrder[] = ordersResult.rows.map((r) => ({
    id: r.id,
    // The behaviour, derived from the persisted type: `pension_alimenticia` is
    // child support and both levies share the Pub 1494 path.
    type: behaviourOf(r.type),
    // What the order asks for, computed ONCE and from the persisted
    // vocabulary. An unknown `amount_type` throws instead of yielding zero.
    desired: desiredAmount(
      r.amount_type,
      parseFloat(r.amount_value),
      input.disposable_earnings,
      input.gross_wages
    ),
    priority: r.priority,
    supports_second_family: r.supports_second_family || false,
    arrears_over_12_weeks: r.arrears_over_12_weeks || false,
    exempt_amount: r.exempt_amount ? parseFloat(r.exempt_amount) : undefined,
    rank: RANK[r.type],
  }));

  // LA PRELACIÓN QUE LA CABECERA PROMETE, y que `ORDER BY priority` no daba:
  // embargo fiscal federal > pensión alimenticia > quiebra > acreedor. La
  // prioridad y la fecha desempatan DENTRO de un rango, que es para lo que
  // sirven — antes decidían el orden entero, así que un acreedor con
  // `priority = 1` se cobraba antes que una pensión alimenticia con 100.
  orders.sort((a, b) => a.rank - b.rank || a.priority - b.priority);

  const weekly = weeklyEquivalent(input.disposable_earnings, input.pay_frequency);
  const fmwThreshold = 30 * FMW_PER_HOUR; // $217.50/week
  const creditorMaxWeekly = Math.max(0, Math.min(weekly * 0.25, weekly - fmwThreshold));

  // Overall CCPA ceiling from child-support orders (tracks highest)
  let csCapPct = 0;
  for (const o of orders) {
    if (o.type === 'child_support') {
      csCapPct = Math.max(csCapPct, ccpaChildSupportCap(!!o.supports_second_family, !!o.arrears_over_12_weeks));
    }
  }
  const childSupportMax = csCapPct > 0 ? input.disposable_earnings * csCapPct : 0;

  let totalWithheld = 0;
  let csWithheld = 0;
  const perOrder: GarnishmentResult['per_order'] = [];

  for (const o of orders) {
    let amount = 0;
    let cap: string | null = null;

    if (o.type === 'child_support') {
      const desired = o.desired;
      const remainingCsCap = Math.max(0, childSupportMax - csWithheld);
      amount = Math.min(desired, remainingCsCap);
      if (amount < desired) cap = `CCPA ${csCapPct * 100}%`;
      csWithheld += amount;
    } else if (o.type === 'tax_levy') {
      const exempt = o.exempt_amount || 0;
      amount = Math.max(0, input.disposable_earnings - exempt);
      cap = exempt > 0 ? 'Pub 1494 exempt' : null;
    } else if (o.type === 'creditor') {
      const desired = o.desired;
      const creditorMaxPeriod = creditorMaxWeekly * (input.disposable_earnings > 0 ? (input.disposable_earnings / weekly) : 0);
      const remainingCreditorCap = Math.max(0, creditorMaxPeriod - (totalWithheld - csWithheld));
      amount = Math.min(desired, remainingCreditorCap);
      if (amount < desired) cap = 'CCPA 25% / 30×FMW';
    } else if (o.type === 'student_loan') {
      // Administrative Wage Garnishment: 15% of disposable
      amount = Math.min(o.desired || input.disposable_earnings * 0.15, input.disposable_earnings * 0.15);
      cap = 'AWG 15%';
    }

    amount = Math.round(amount * 100) / 100;
    totalWithheld += amount;
    perOrder.push({ order_id: o.id, type: o.type, amount, cap_applied: cap });
  }

  return {
    total_withheld: Math.round(totalWithheld * 100) / 100,
    per_order: perOrder,
  };
}
