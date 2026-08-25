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
  type: 'child_support' | 'tax_levy' | 'creditor' | 'bankruptcy' | 'student_loan';
  amount_per_period?: number;
  percentage?: number;
  priority: number;
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

export async function calculateGarnishments(input: GarnishmentInput): Promise<GarnishmentResult> {
  const ordersResult = await query<{
    id: string;
    type: 'child_support' | 'tax_levy' | 'creditor' | 'bankruptcy' | 'student_loan';
    amount_per_period: string | null;
    percentage: string | null;
    priority: number;
    supports_second_family: boolean | null;
    arrears_over_12_weeks: boolean | null;
    exempt_amount: string | null;
  }>(
    `SELECT id, type, amount_per_period, percentage, priority,
            supports_second_family, arrears_over_12_weeks, exempt_amount
     FROM garnishments
     WHERE employee_id = $1 AND status = 'active'
     ORDER BY priority ASC, created_at ASC`,
    [input.employee_id]
  );

  const orders: GarnishmentOrder[] = ordersResult.rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount_per_period: r.amount_per_period ? parseFloat(r.amount_per_period) : undefined,
    percentage: r.percentage ? parseFloat(r.percentage) : undefined,
    priority: r.priority,
    supports_second_family: r.supports_second_family || false,
    arrears_over_12_weeks: r.arrears_over_12_weeks || false,
    exempt_amount: r.exempt_amount ? parseFloat(r.exempt_amount) : undefined,
  }));

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
      const desired = o.percentage
        ? input.disposable_earnings * (o.percentage / 100)
        : (o.amount_per_period || 0);
      const remainingCsCap = Math.max(0, childSupportMax - csWithheld);
      amount = Math.min(desired, remainingCsCap);
      if (amount < desired) cap = `CCPA ${csCapPct * 100}%`;
      csWithheld += amount;
    } else if (o.type === 'tax_levy') {
      const exempt = o.exempt_amount || 0;
      amount = Math.max(0, input.disposable_earnings - exempt);
      cap = exempt > 0 ? 'Pub 1494 exempt' : null;
    } else if (o.type === 'creditor' || o.type === 'bankruptcy') {
      const desired = o.percentage
        ? input.disposable_earnings * (o.percentage / 100)
        : (o.amount_per_period || 0);
      const creditorMaxPeriod = creditorMaxWeekly * (input.disposable_earnings > 0 ? (input.disposable_earnings / weekly) : 0);
      const remainingCreditorCap = Math.max(0, creditorMaxPeriod - (totalWithheld - csWithheld));
      amount = Math.min(desired, remainingCreditorCap);
      if (amount < desired) cap = 'CCPA 25% / 30×FMW';
    } else if (o.type === 'student_loan') {
      // Administrative Wage Garnishment: 15% of disposable
      amount = Math.min(o.amount_per_period || input.disposable_earnings * 0.15, input.disposable_earnings * 0.15);
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
