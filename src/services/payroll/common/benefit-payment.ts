import Decimal from 'decimal.js';
import type pg from 'pg';
import { AccountingError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import { queryAccumulatedBalances } from '../../reporting/report-service.js';
import { ROL_AGUINALDO, ROL_PRIMA, ROL_VACACIONES } from '../../accruals/provisions-run.js';
import { PAYROLL_DRAFT_PRODUCER } from './pay-run-entry-link.js';

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
// exemption already reads; vacation days are `pto`, and only when the run
// itemizes them: days paid inside `salary` cannot be told from salary, and
// stay expense.
// ============================================================

/** The policy. Its values are persisted: never rename them. */
export const BENEFIT_PAYMENT_POLICY = 'benefit_payment_against_provision';

export type BenefitPayment = 'consume_provision' | 'expense_on_payment';

const KNOWN_TREATMENTS: readonly BenefitPayment[] = ['consume_provision', 'expense_on_payment'];

/** The earning types that pay an accrued benefit: the role of its provision, and its entry line. */
const BENEFITS: ReadonlyArray<{ earningType: string; role: string; description: string }> = [
  { earningType: 'aguinaldo', role: ROL_AGUINALDO, description: 'Aguinaldo paid against its provision' },
  { earningType: 'pto', role: ROL_VACACIONES, description: 'Vacation days paid against their provision' },
  { earningType: 'prima_vacacional', role: ROL_PRIMA, description: 'Vacation premium paid against its provision' },
];

/** A debit of the pay-run entry to a provision, in cents like the rest of the entry. */
export interface ProvisionCharge {
  accountId: string;
  accountCode: string;
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
 * The debits to provisions of a run's entry, read on the caller's connection
 * and under its lock. One statement when the run pays no benefit; five more
 * when it does, none of them per paycheck.
 *
 * A provision holds, for this run, the LESSER of its posted balance on the
 * pay date and of everything posted (a run booked late must not take what a
 * later entry already took), less what pay-run drafts awaiting review will
 * debit to it: a draft's lines are fixed when it is written, so two drafts
 * must not both count on the same balance. The account rows are locked
 * (`accounts` is not written on the posting path), so two runs paying the
 * same benefit read the balance one after the other.
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
    [run.payRunId, run.tenantId, BENEFITS.map((b) => b.earningType)]
  );
  const paidOf = new Map(paid.rows.map((r) => [r.earning_type, r.amount]));
  const benefits = BENEFITS.filter((b) => paidOf.has(b.earningType));
  if (benefits.length === 0) return [];

  const treatment = await readBenefitPayment({ tenantId: run.tenantId, entityId: run.entityId }, client);

  // By role, as the accrual resolves them. An entity without the role (it is
  // seeded for Mexican entities only) has no provision to consume.
  const mapped = await client.query<{ role: string; id: string; code: string }>(
    `SELECT r.role, a.id, a.code
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = ANY($2) AND r.qualifier IS NULL
      ORDER BY a.id
        FOR UPDATE OF a`,
    [run.entityId, benefits.map((b) => b.role)]
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
    // The first in the order of BENEFITS, so the refusal names the same account every time.
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

  const onPayDate = await balances(run.payDate);
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
    const balance = Decimal.min(posted.get(a.id) ?? 0, onPayDate.get(a.id) ?? 0);
    held.set(a.id, balance.minus(inDrafts.get(a.code) ?? 0));
  }
  const charges: ProvisionCharge[] = [];
  for (const b of benefits) {
    const account = accountOf.get(b.role);
    if (!account) continue;
    const amount = chargeToProvision(paidOf.get(b.earningType) as string, held.get(account.id) as Decimal);
    if (amount.isZero()) continue;
    held.set(account.id, (held.get(account.id) as Decimal).minus(amount));
    charges.push({ accountId: account.id, accountCode: account.code, amount, description: b.description });
  }
  return charges;
}
