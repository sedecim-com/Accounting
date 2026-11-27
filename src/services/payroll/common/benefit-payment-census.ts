import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { toCalendarDate } from '../../../utils/calendar-date.js';
import { queryEntryMovementsOnAccount } from '../../reporting/report-service.js';
import {
  ACCRUED_BENEFITS,
  benefitFactsOfRuns,
  chargeToProvision,
  type AccruedBenefit,
} from './benefit-payment.js';

// ============================================================
// THE CENSUS OF BENEFITS PAID TO WAGES WHILE THEIR PROVISION HELD THEM
// (#111, MNE-001-878, part 3)
//
// Before the pay-run entry consumed provisions, a year-end bonus, vacation
// days or a vacation premium paid in a run was debited whole to wages while
// the close had already accrued it: expensed twice, and still owed on the
// books. This names each such payment, with its amount and its month. It
// reads and writes nothing: the correction is a draft a person reviews, and
// it is another part of the task.
//
// A PAYMENT IS IN THE CENSUS BY FACTS, never by the text of a line: a live
// pay-run entry that paid more of a benefit (`paycheck_earnings`) than it
// debited to the benefit's provision account, in a month at whose end that
// provision held a balance. The rows are the ones the accrual reads
// (`benefitFactsOfRuns`). An entry posted since the rule debits what the
// provision holds, so what it leaves in wages is over the provision and the
// census does not name it; if it does appear, a person moved the debit in
// review, or the month was accrued while its entry was still a draft.
//
// HOW MUCH OF IT: what the pay-run entry would have debited had the rule
// been there, replayed oldest first. An entry takes what the provision held
// at the end of its month, less what the earlier entries of the census take,
// and never more than the provision holds today: an entry booked later that
// did consume it leaves less to correct.
// ============================================================

/** A payment the census names: one pay-run entry and one benefit. */
export interface BenefitPaymentFinding {
  runId: string;
  entryId: string;
  entryNumber: string;
  /** YYYY-MM-DD. */
  entryDate: string;
  /** YYYY-MM of the entry. */
  month: string;
  benefit: AccruedBenefit;
  /** The code of the provision account, as the entity's chart has it. */
  provisionAccount: string;
  paid: string;
  debited: string;
  /** What went to wages and the provision held: what a correction would move. */
  expensedWhileHeld: string;
}

/** The census of one entity. */
export interface BenefitPaymentCensus {
  entityId: string;
  findings: BenefitPaymentFinding[];
  /** Per provision with a finding: what it holds today and what the findings add up to. */
  provisions: Array<{ benefit: AccruedBenefit; account: string; heldNow: string; expensedWhileHeld: string }>;
}

/**
 * The replay, pure. `payments` are one benefit's, oldest first: what each
 * left out of its provision and what the provision held at the end of its
 * month. Returns what each would have debited, in cents like the entry.
 */
export function replayAgainstProvision(
  payments: ReadonlyArray<{ notDebited: Decimal.Value; heldAtMonthEnd: Decimal.Value }>,
  heldNow: Decimal.Value
): Decimal[] {
  let taken = new Decimal(0);
  return payments.map((p) => {
    const room = Decimal.min(p.heldAtMonthEnd, heldNow).minus(taken);
    const amount = chargeToProvision(p.notDebited, room);
    taken = taken.plus(amount);
    return amount;
  });
}

/**
 * Read-only. One statement for the facts of the entity's pay runs; when one
 * of them left a benefit out of its provision, one more for the provision
 * accounts and one per provision concerned for its movements (three at
 * most). None per run or per paycheck.
 */
export async function censusBenefitPayments(
  scope: { tenantId: string; entityId: string }
): Promise<BenefitPaymentCensus> {
  const empty: BenefitPaymentCensus = { entityId: scope.entityId, findings: [], provisions: [] };
  const left = (await benefitFactsOfRuns(scope)).filter((f) => f.paid.greaterThan(f.debited));
  if (left.length === 0) return empty;

  const mapped = await query<{ role: string; id: string; code: string }>(
    `SELECT r.role, a.id, a.code
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = ANY($2) AND r.qualifier IS NULL`,
    [scope.entityId, ACCRUED_BENEFITS.map((b) => b.role)]
  );

  const census: BenefitPaymentCensus = { ...empty, findings: [], provisions: [] };
  for (const b of ACCRUED_BENEFITS) {
    const account = mapped.rows.find((r) => r.role === b.role);
    const payments = left.filter((f) => f.benefit === b.benefit);
    // An entity without the role has no provision: nothing was held.
    if (!account || payments.length === 0) continue;

    // Credit-positive: what the provision held on a day is every posted
    // movement to that day, from the report layer.
    const movements = (await queryEntryMovementsOnAccount(scope.entityId, account.id))
      .map((m) => ({ date: toCalendarDate(m.entry_date), credit: new Decimal(m.amount).negated() }));
    const heldOn = (day: string): Decimal =>
      movements.reduce((sum, m) => (m.date <= day ? sum.plus(m.credit) : sum), new Decimal(0));
    const heldNow = movements.reduce((sum, m) => sum.plus(m.credit), new Decimal(0));

    const amounts = replayAgainstProvision(
      payments.map((f) => ({ notDebited: f.paid.minus(f.debited), heldAtMonthEnd: heldOn(f.periodEnd) })),
      heldNow
    );
    let total = new Decimal(0);
    payments.forEach((f, i) => {
      if (amounts[i].isZero()) return;
      total = total.plus(amounts[i]);
      census.findings.push({
        runId: f.runId,
        entryId: f.entryId,
        entryNumber: f.entryNumber,
        entryDate: f.entryDate,
        month: f.entryDate.slice(0, 7),
        benefit: b.benefit,
        provisionAccount: account.code,
        paid: f.paid.toFixed(2),
        debited: f.debited.toFixed(2),
        expensedWhileHeld: amounts[i].toFixed(2),
      });
    });
    if (total.greaterThan(0)) {
      census.provisions.push({
        benefit: b.benefit, account: account.code, heldNow: heldNow.toFixed(4), expensedWhileHeld: total.toFixed(2),
      });
    }
  }
  return census;
}
