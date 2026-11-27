import Decimal from 'decimal.js';
import type pg from 'pg';
import { AccountingError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import { query } from '../../../database/connection.js';
import { queryAccumulatedBalances } from '../../reporting/report-service.js';
import { PAYROLL_DRAFT_PRODUCER, payRunReference } from './pay-run-entry-link.js';

// ============================================================
// A BENEFIT PAID IN A PAY RUN CONSUMES ITS PROVISION (#111, MNE-001-878)
//
// The close accrues the year-end bonus, vacations and the vacation premium to
// expense against a provision each (provisions-run.ts, NIF D-3). The pay-run entry
// debited the whole gross to wages, so the benefit was expensed twice and the
// provision never cleared. Whether the payment settles the provision is the
// policy `benefit_payment_against_provision` (ADR-0006):
//
//   · consume_provision (default): what the run pays of each benefit is
//     debited to its provision up to what the provision holds; only the
//     excess is wages expense, and what is not paid stays in the provision.
//   · expense_on_payment: the whole gross is wages expense, as before. It is
//     for a firm that does not accrue, and the ledger judges that: the run is
//     refused while the provision of a benefit it pays carries a balance.
//
// A benefit is read from the earning type of the paycheck line. The types of
// the year-end bonus and of the vacation premium are the ones the ISR
// exemption already reads; vacation days have two (the list below), and
// count only when the run itemizes them: days paid inside `salary` cannot be
// told from salary, and stay expense.
//
// WHAT THE PROVISION COULD NOT TAKE goes to wages in a line of its own. A run
// paid before its month's close finds the provision one accrual short, and
// the close would accrue the same days again, so the accrual of a period
// takes it off (provisions-run.ts, `paidOverProvision`). The accrual does NOT
// read that line: its description is a label for the reader, and a label can
// be reworded in review. It measures the excess from facts: what the runs of
// the period paid in earning lines of the benefit, less what their entries
// debited to the benefit's provision account (`paidOverProvisionsIn`).
// ============================================================

/** The policy. Its values are persisted: never rename them. */
export const BENEFIT_PAYMENT_POLICY = 'benefit_payment_against_provision';

export type BenefitPayment = 'consume_provision' | 'expense_on_payment';

const KNOWN_TREATMENTS: readonly BenefitPayment[] = ['consume_provision', 'expense_on_payment'];

/** The three benefits the close accrues, as the schedule of the accrual names them. */
export type AccruedBenefit = 'aguinaldo' | 'vacaciones' | 'prima_vacacional';

/**
 * ONE LIST, ONE PLACE: each accrued benefit, the role of its provision, the
 * earning types that pay it and the two lines the pay-run entry writes for
 * it. The role and the earning types are persisted (`account_roles`,
 * `paycheck_earnings`): never rename one. The two line texts are labels.
 */
export const ACCRUED_BENEFITS: ReadonlyArray<{
  benefit: AccruedBenefit;
  role: string;
  earningTypes: readonly string[];
  charged: string;
  over: string;
}> = [
  {
    benefit: 'aguinaldo', role: 'provision_aguinaldo', earningTypes: ['aguinaldo'],
    charged: 'Aguinaldo paid against its provision', over: 'Aguinaldo paid over its provision',
  },
  {
    benefit: 'vacaciones', role: 'provision_vacaciones', earningTypes: ['pto', 'vacaciones'],
    charged: 'Vacation days paid against their provision', over: 'Vacation days paid over their provision',
  },
  {
    benefit: 'prima_vacacional', role: 'provision_prima_vacacional', earningTypes: ['prima_vacacional'],
    charged: 'Vacation premium paid against its provision', over: 'Vacation premium paid over its provision',
  },
];

/** The role of the provision of a benefit. */
export function provisionRole(benefit: AccruedBenefit): string {
  return (ACCRUED_BENEFITS.find((b) => b.benefit === benefit) as (typeof ACCRUED_BENEFITS)[number]).role;
}

/**
 * A debit of the pay-run entry for a benefit paid, in cents like the rest of
 * the entry: to the provision, or to wages for what the provision could not
 * take (`accountId` null: the builder knows the wages account).
 */
export interface ProvisionCharge {
  accountId: string | null;
  accountCode: string | null;
  amount: Decimal;
  description: string;
}

/** Closed on declaring, like `readSeparatePaymentIsr`. */
export async function readBenefitPayment(
  ctx: { tenantId: string; entityId?: string },
  client?: pg.PoolClient
): Promise<BenefitPayment> {
  const policy = await getPolicy(ctx, BENEFIT_PAYMENT_POLICY, client);
  const treatment = KNOWN_TREATMENTS.find((t) => t === policy.value);
  if (!treatment) {
    throw new AccountingError(
      'BENEFIT_PAYMENT_UNKNOWN',
      `The policy ${BENEFIT_PAYMENT_POLICY} is "${policy.value}" and this reader only knows ` +
        `${KNOWN_TREATMENTS.join(', ')}. Correct it in mnemosine pending.`
    );
  }
  return treatment;
}

/**
 * What of a benefit paid its provision takes: never more than was paid, never
 * more than the provision holds, never below zero. In cents: the entry posts
 * cents on both roads, and the provision accrues with four decimals, so what
 * it holds is taken to its nearest cent. The fraction of a cent left, of
 * either sign, stays in the account and joins the next accrual.
 */
export function chargeToProvision(paid: Decimal.Value, held: Decimal.Value): Decimal {
  return Decimal.min(Decimal.max(0, paid), inCents(held));
}

/** What a provision holds, to its nearest cent and never below zero. */
function inCents(held: Decimal.Value): Decimal {
  return Decimal.max(0, new Decimal(held).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
}

/**
 * The debits of a run's entry for the benefits it pays, read on the caller's
 * connection and under its lock. One statement when the run pays no benefit;
 * five more when it does, none of them per paycheck.
 *
 * A provision holds, for this run, the LESSER of its posted balance at the
 * end of the pay date's fiscal period and of everything posted (a run booked
 * late must not take what a later entry already took), less what pay-run
 * drafts awaiting review will debit to it: a draft's lines are fixed when it
 * is written, so two drafts must not both count on the same balance. The
 * month is the unit, as it is for the accrual: a run booked after its
 * month's close finds that month's accrual in the provision, and one booked
 * before it leaves the difference in a line the close subtracts. The account
 * rows are locked (`accounts` is not written on the posting path), so two
 * runs paying the same benefit read the balance one after the other.
 */
export async function provisionChargesOfRun(
  client: pg.PoolClient,
  run: { payRunId: string; tenantId: string; entityId: string; payDate: string }
): Promise<ProvisionCharge[]> {
  const paid = await client.query<{ earning_type: string; amount: string }>(
    `SELECT pe.earning_type, SUM(pe.amount)::text AS amount
       FROM paychecks p
       JOIN paycheck_earnings pe ON pe.paycheck_id = p.id
      WHERE p.pay_run_id = $1 AND p.tenant_id = $2 AND pe.earning_type = ANY($3)
      GROUP BY pe.earning_type
     HAVING SUM(pe.amount) > 0`,
    [run.payRunId, run.tenantId, ACCRUED_BENEFITS.flatMap((b) => b.earningTypes)]
  );
  const paidOf = new Map<AccruedBenefit, Decimal>();
  for (const b of ACCRUED_BENEFITS) {
    const rows = paid.rows.filter((r) => b.earningTypes.includes(r.earning_type));
    if (rows.length > 0) paidOf.set(b.benefit, rows.reduce((sum, r) => sum.plus(r.amount), new Decimal(0)));
  }
  const benefits = ACCRUED_BENEFITS.filter((b) => paidOf.has(b.benefit));
  if (benefits.length === 0) return [];

  const treatment = await readBenefitPayment({ tenantId: run.tenantId, entityId: run.entityId }, client);

  // By role, as the accrual resolves them. An entity without the role (it is
  // seeded for Mexican entities only) has no provision to consume.
  const mapped = await client.query<{ role: string; id: string; code: string; period_end: string | null }>(
    `SELECT r.role, a.id, a.code,
            (SELECT MAX(fp.end_date)::text FROM fiscal_periods fp
              WHERE fp.entity_id = $1 AND $3::date BETWEEN fp.start_date AND fp.end_date) AS period_end
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = ANY($2) AND r.qualifier IS NULL
      ORDER BY a.id
        FOR UPDATE OF a`,
    [run.entityId, benefits.map((b) => b.role), run.payDate]
  );
  if (mapped.rows.length === 0) return [];
  const accountOf = new Map(mapped.rows.map((r) => [r.role, r]));
  const accountIds = [...new Set(mapped.rows.map((r) => r.id))];

  // Credit-positive, from the report layer (the one place that sums the ledger).
  const balances = async (date?: string): Promise<Map<string, Decimal>> => {
    const rows = await queryAccumulatedBalances(
      run.entityId,
      { ...(date ? { date } : {}), inclusive: true },
      { ignoreClosingPolicy: true, accountIds, client }
    );
    return new Map(rows.map((r) => [r.account_id, new Decimal(r.balance).negated()]));
  };
  const posted = await balances();

  if (treatment === 'expense_on_payment') {
    // The first in the order of the list, so the refusal names the same account every time.
    const accrued = benefits
      .map((b) => accountOf.get(b.role))
      .find((a) => a !== undefined && inCents(posted.get(a.id) ?? 0).greaterThan(0));
    if (accrued) {
      throw new AccountingError('BENEFIT_PAYMENT_EXPENSED_WHILE_ACCRUED', {
        key: 'payroll.benefit_payment.expensed_while_accrued',
        params: {
          key: BENEFIT_PAYMENT_POLICY,
          account: accrued.code,
          balance: inCents(posted.get(accrued.id) ?? 0).toFixed(2),
        },
      });
    }
    return [];
  }

  const atPeriodEnd = await balances(mapped.rows[0].period_end ?? run.payDate);
  const drafts = await client.query<{ code: string; amount: string }>(
    `SELECT l->>'account_code' AS code, SUM((l->>'debit')::numeric)::text AS amount
       FROM ai_drafts d
      CROSS JOIN LATERAL jsonb_array_elements(d.payload->'lines') l
      WHERE d.tenant_id = $1 AND d.entity_id = $2 AND d.ai_model = $3 AND d.status = 'pending_review'
        AND l->>'account_code' = ANY($4) AND l ? 'debit'
      GROUP BY 1`,
    [run.tenantId, run.entityId, PAYROLL_DRAFT_PRODUCER, mapped.rows.map((r) => r.code)]
  );
  const inDrafts = new Map(drafts.rows.map((r) => [r.code, r.amount]));

  // Per ACCOUNT, not per role: a firm may map two benefits to one provision.
  const held = new Map<string, Decimal>();
  for (const a of mapped.rows) {
    const balance = Decimal.min(posted.get(a.id) ?? 0, atPeriodEnd.get(a.id) ?? 0);
    held.set(a.id, balance.minus(inDrafts.get(a.code) ?? 0));
  }
  const charges: ProvisionCharge[] = [];
  for (const b of benefits) {
    const account = accountOf.get(b.role);
    if (!account) continue;
    const paidHere = paidOf.get(b.benefit) as Decimal;
    const amount = chargeToProvision(paidHere, held.get(account.id) as Decimal);
    held.set(account.id, (held.get(account.id) as Decimal).minus(amount));
    if (amount.greaterThan(0)) {
      charges.push({ accountId: account.id, accountCode: account.code, amount, description: b.charged });
    }
    if (paidHere.greaterThan(amount)) {
      charges.push({ accountId: null, accountCode: null, amount: paidHere.minus(amount), description: b.over });
    }
  }
  return charges;
}

/** What one live pay-run entry paid of a benefit, and what it debited to that benefit's provision. */
export interface BenefitFactsOfRun {
  runId: string;
  entryId: string;
  entryNumber: string;
  /** YYYY-MM-DD. */
  entryDate: string;
  /** The last day of the entry's fiscal period, YYYY-MM-DD. */
  periodEnd: string;
  benefit: AccruedBenefit;
  paid: Decimal;
  debited: Decimal;
}

/**
 * THE FACTS OF EACH PAY RUN ABOUT THE BENEFITS IT PAID, one row per run and
 * benefit: what it paid in earning lines of the benefit's types
 * (`paycheck_earnings`) and what its entry debited to the account of the
 * benefit's provision, net of any credit. A run counts through
 * `pay_runs.journal_entry_id`, the link both roads of `pay-run post` write,
 * and only while its entry is posted and not reversed. Never from the text
 * of a line. The accrual of a period and the census of past payments read
 * the same rows, so they cannot disagree on what a run did.
 *
 * One statement, bounded by tenant and entity (`pay_runs` has no entity of
 * its own and no index on its entry: the tenant is what bounds it), and by
 * the window when one is given. The amounts of the ledger lines are read,
 * not summed in SQL: at most three per run. Oldest entry first.
 */
export async function benefitFactsOfRuns(
  scope: { tenantId: string; entityId: string },
  window?: { from: Date | string; to: Date | string }
): Promise<BenefitFactsOfRun[]> {
  const rows = await query<{
    run_id: string; entry_id: string; entry_number: string; entry_date: string; period_end: string;
    kind: 'paid' | 'debited'; key: string; amount: string;
  }>(
    `WITH runs AS (
       SELECT pr.id AS run_id, pr.tenant_id, je.id AS entry_id, je.entry_number,
              je.entry_date::text AS entry_date, fp.end_date::text AS period_end
         FROM journal_entries je
         JOIN pay_runs pr ON pr.journal_entry_id = je.id AND pr.tenant_id = $2
         JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
          AND ($5::date IS NULL OR je.entry_date BETWEEN $5::date AND $6::date)
     )
     SELECT runs.run_id, runs.entry_id, runs.entry_number, runs.entry_date, runs.period_end,
            'paid' AS kind, pe.earning_type AS key, SUM(pe.amount)::text AS amount
       FROM runs
       JOIN paychecks p ON p.pay_run_id = runs.run_id AND p.tenant_id = runs.tenant_id
       JOIN paycheck_earnings pe ON pe.paycheck_id = p.id AND pe.earning_type = ANY($3)
      GROUP BY runs.run_id, runs.entry_id, runs.entry_number, runs.entry_date, runs.period_end, pe.earning_type
     UNION ALL
     SELECT runs.run_id, runs.entry_id, runs.entry_number, runs.entry_date, runs.period_end,
            'debited', r.role, (COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))::text
       FROM runs
       JOIN journal_entry_lines jel ON jel.journal_entry_id = runs.entry_id
       JOIN account_roles r ON r.account_id = jel.account_id AND r.entity_id = $1
                           AND r.role = ANY($4) AND r.qualifier IS NULL`,
    [
      scope.entityId, scope.tenantId, ACCRUED_BENEFITS.flatMap((b) => b.earningTypes),
      ACCRUED_BENEFITS.map((b) => b.role), window?.from ?? null, window?.to ?? null,
    ]
  );
  const facts = new Map<string, BenefitFactsOfRun>();
  for (const r of rows.rows) {
    const b = ACCRUED_BENEFITS.find((x) => (r.kind === 'paid' ? x.earningTypes.includes(r.key) : x.role === r.key));
    if (!b) continue;
    const key = `${r.entry_id}:${b.benefit}`;
    const fact = facts.get(key) ?? {
      runId: r.run_id, entryId: r.entry_id, entryNumber: r.entry_number, entryDate: r.entry_date,
      periodEnd: r.period_end, benefit: b.benefit, paid: new Decimal(0), debited: new Decimal(0),
    };
    if (r.kind === 'paid') fact.paid = fact.paid.plus(r.amount);
    else fact.debited = fact.debited.plus(r.amount);
    facts.set(key, fact);
  }
  // By date, then by number: plain code-unit order, the same on every database.
  return [...facts.values()].sort((a, b) =>
    a.entryDate === b.entryDate ? (a.entryNumber < b.entryNumber ? -1 : 1) : a.entryDate < b.entryDate ? -1 : 1
  );
}

/** What the pay runs of a period paid over each provision, and the runs it could not measure. */
export interface PaidOverProvisions {
  over: Map<AccruedBenefit, Decimal>;
  /** Runs of the period that pay an accrued benefit and whose entry is a draft awaiting review. */
  pendingRuns: string[];
}

/**
 * WHAT THE PAY RUNS OF A PERIOD PAID OVER EACH PROVISION, FROM FACTS THAT
 * CANNOT BE REWORDED. For the entity and the period, per benefit: what the
 * runs paid in earning lines of the benefit's types (`paycheck_earnings`),
 * less what the entries of those same runs debited to the account of the
 * benefit's provision, net of any credit. A run counts through
 * `pay_runs.journal_entry_id`, the link both roads of `pay-run post` write,
 * and only while its entry is posted and not reversed: a reversed run is as
 * if it had not paid.
 *
 * A RUN WHOSE ENTRY IS STILL A DRAFT IN REVIEW IS NOT COUNTED, AND IS NAMED.
 * Its draft may be approved, corrected or rejected, so taking its excess off
 * now could under-accrue the month with nothing to say so. The accrual runs
 * in full for it and the caller names the run: over-accrued and said is the
 * side that can be seen and corrected (approve the draft, reverse the
 * accrual, run it again).
 *
 * Two statements for the period, none per run or per paycheck, both bounded
 * by tenant and entity (`pay_runs` has no entity of its own and no index on
 * its entry: the tenant is what bounds it). The amounts of the ledger lines
 * are read, not summed in SQL: at most three per run.
 */
export async function paidOverProvisionsIn(
  scope: { tenantId: string; entityId: string },
  from: Date | string,
  to: Date | string
): Promise<PaidOverProvisions> {
  const { tenantId, entityId } = scope;
  const earningTypes = ACCRUED_BENEFITS.flatMap((b) => b.earningTypes);
  const over = new Map<AccruedBenefit, Decimal>();
  for (const f of await benefitFactsOfRuns(scope, { from, to })) {
    over.set(f.benefit, (over.get(f.benefit) ?? new Decimal(0)).plus(f.paid).minus(f.debited));
  }
  for (const [benefit, net] of over) if (!net.greaterThan(0)) over.delete(benefit);

  // The draft of a run is the payroll engine's own, named by its producer and
  // by the run's reference, as `pay-run post` finds it: never by a line's text.
  const pending = await query<{ run_id: string }>(
    `SELECT DISTINCT pr.id AS run_id
       FROM ai_drafts d
       JOIN pay_runs pr ON pr.tenant_id = $7 AND d.payload->>'reference' = $6 || pr.id::text
       JOIN paychecks p ON p.pay_run_id = pr.id AND p.tenant_id = pr.tenant_id
       JOIN paycheck_earnings pe ON pe.paycheck_id = p.id AND pe.earning_type = ANY($5)
      WHERE d.tenant_id = $7 AND d.entity_id = $1 AND d.ai_model = $2 AND d.status = 'pending_review'
        AND (d.payload->>'entry_date')::date BETWEEN $3 AND $4
      ORDER BY pr.id`,
    [entityId, PAYROLL_DRAFT_PRODUCER, from, to, earningTypes, payRunReference(''), tenantId]
  );
  return { over, pendingRuns: pending.rows.map((r) => r.run_id) };
}
