import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import { getExternalAdapter } from '../services/integrations/accounting/registry.js';
import { createDraft, approveDraft, type Reviewer, type DraftPayload } from './draft-service.js';
import type { AgentContext } from './context.js';

// ============================================================
// ONBOARDING: import a set of books from an external system
// (Contalink, …) to onboard a new client.
//   1. PLAN: remote trial balance at the cutoff → which accounts
//      are missing from the local chart of accounts (type/normal
//      balance inferred from the MX code) and the opening
//      journal entry lines.
//   2. EXECUTE: creates the missing accounts and the opening
//      journal entry as a DRAFT (same single path to the ledger);
//      with postNow it is approved/posted immediately via
//      approveDraft.
//   3. VERIFICATION: external_diff_trial_balance must report 0
//      differences after posting.
// Idempotency: the opening balance carries the deterministic
// reference "onboarding:<provider>:<cutoff>" and is rejected if
// it already exists.
// ============================================================

const BALANCE_TOLERANCE = new Decimal('0.01');

export interface InferredAccount {
  code: string;
  name: string;
  account_type: string;
  normal_balance: 'debit' | 'credit';
  /** false when the first digit does not allow a confident inference. */
  confident: boolean;
}

/**
 * Heuristic over the MX grouping code (first digit):
 * 1 asset, 2 liability, 3 equity, 4 revenue, 5/6 costs and expenses,
 * 7 other (assumed comprehensive financing result → expense).
 */
export function inferAccountType(code: string): Pick<InferredAccount, 'account_type' | 'normal_balance' | 'confident'> {
  const first = code.trim().charAt(0);
  switch (first) {
    case '1': return { account_type: 'asset', normal_balance: 'debit', confident: true };
    case '2': return { account_type: 'liability', normal_balance: 'credit', confident: true };
    case '3': return { account_type: 'equity', normal_balance: 'credit', confident: true };
    case '4': return { account_type: 'revenue', normal_balance: 'credit', confident: true };
    case '5':
    case '6': return { account_type: 'expense', normal_balance: 'debit', confident: true };
    case '7': return { account_type: 'expense', normal_balance: 'debit', confident: false };
    default: return { account_type: 'expense', normal_balance: 'debit', confident: false };
  }
}

export interface OnboardingPlan {
  provider: string;
  startDate: string;
  cutoffDate: string;
  reference: string;
  remoteAccounts: number;
  existingAccounts: number;
  accountsToCreate: InferredAccount[];
  /** Opening lines (debit-positive balance ≠ 0), rounded to 2 decimals. */
  openingLines: Array<{ account_code: string; debit?: number; credit?: number; description: string }>;
  totals: { debits: string; credits: string; imbalance: string };
  /** true if the opening balance requires a balancing account (partial remote trial balance). */
  needsBalancingAccount: boolean;
}

export async function planOnboarding(
  ctx: AgentContext,
  provider: string,
  startDate: string,
  cutoffDate: string
): Promise<OnboardingPlan> {
  const reference = `onboarding:${provider}:${cutoffDate}`;

  // Idempotency: the opening balance can only exist once per provider+cutoff.
  const existing = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM journal_entries
     WHERE entity_id = $1 AND reference = $2 AND status != 'void'`,
    [ctx.entityId, reference]
  );
  if (parseInt(existing.rows[0].n, 10) > 0) {
    throw new Error(
      `An opening journal entry with reference "${reference}" already exists in this entity; ` +
        'void it before re-importing'
    );
  }

  // The posted-entry check above leaves a window: a previous onboard without
  // postNow left a pending draft that, once approved, would collide with a
  // second import. Steer to review instead of allowing a duplicate.
  const pendingDraft = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ai_drafts
     WHERE entity_id = $1 AND draft_type = 'journal_entry'
       AND status = 'pending_review' AND payload->>'reference' = $2`,
    [ctx.entityId, reference]
  );
  if (parseInt(pendingDraft.rows[0].n, 10) > 0) {
    throw new Error(
      `An opening-balance draft with reference "${reference}" is already pending review; ` +
        'approve or reject it with `mnemosine review` before importing again'
    );
  }

  const adapter = getExternalAdapter(provider);
  const remote = await adapter.getTrialBalance(startDate, cutoffDate);

  const local = await query<{ code: string }>(
    `SELECT code FROM accounts WHERE entity_id = $1`,
    [ctx.entityId]
  );
  const localCodes = new Set(local.rows.map((r) => r.code));

  const seen = new Set<string>();
  const accountsToCreate: InferredAccount[] = [];
  const openingLines: OnboardingPlan['openingLines'] = [];
  let debits = new Decimal(0);
  let credits = new Decimal(0);

  for (const row of remote) {
    if (!row.account_code || seen.has(row.account_code)) continue;
    seen.add(row.account_code);

    if (!localCodes.has(row.account_code)) {
      accountsToCreate.push({
        code: row.account_code,
        name: row.account_name || `Account ${row.account_code}`,
        ...inferAccountType(row.account_code),
      });
    }

    const balance = new Decimal(row.ending_balance).toDecimalPlaces(2);
    if (balance.isZero()) continue;
    const description = `Opening balance ${row.account_name || row.account_code}`;
    if (balance.greaterThan(0)) {
      openingLines.push({ account_code: row.account_code, debit: balance.toNumber(), description });
      debits = debits.plus(balance);
    } else {
      openingLines.push({ account_code: row.account_code, credit: balance.abs().toNumber(), description });
      credits = credits.plus(balance.abs());
    }
  }

  const imbalance = debits.minus(credits);
  return {
    provider,
    startDate,
    cutoffDate,
    reference,
    remoteAccounts: remote.length,
    existingAccounts: seen.size - accountsToCreate.length,
    accountsToCreate,
    openingLines,
    totals: { debits: debits.toFixed(2), credits: credits.toFixed(2), imbalance: imbalance.toFixed(2) },
    needsBalancingAccount: imbalance.abs().greaterThan(BALANCE_TOLERANCE),
  };
}

export interface OnboardingResult {
  accountsCreated: number;
  draftId: string;
  entryNumber?: string; // only if postNow
}

export async function executeOnboarding(
  ctx: AgentContext,
  plan: OnboardingPlan,
  reviewer: Reviewer,
  opts: { balanceAccountCode?: string; postNow?: boolean } = {}
): Promise<OnboardingResult> {
  // 1. Missing accounts (action of the human running the wizard, attributed).
  let accountsCreated = 0;
  for (const acct of plan.accountsToCreate) {
    const inserted = await query(
      `INSERT INTO accounts (id, code, name, account_type, normal_balance, entity_id, created_by)
       SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::uuid, $7::uuid
       WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE entity_id = $6::uuid AND code = $2::varchar)`,
      [uuidv4(), acct.code, acct.name, acct.account_type, acct.normal_balance, ctx.entityId, reviewer.userId]
    );
    if (inserted.rowCount === 1) accountsCreated++;
  }

  // 2. Balancing when the remote trial balance does not sum to zero (partial import).
  const lines = [...plan.openingLines];
  const imbalance = new Decimal(plan.totals.imbalance);
  if (imbalance.abs().greaterThan(BALANCE_TOLERANCE)) {
    if (!opts.balanceAccountCode) {
      throw new Error(
        `The opening balance does not balance (difference ${plan.totals.imbalance}); specify the balancing account ` +
          'with --balance-account (e.g. 3200 Retained Earnings)'
      );
    }
    // In a fresh entity the balancing account does not exist either: create it
    // with the type inferred from its code (idempotent via the NOT EXISTS).
    const inferred = inferAccountType(opts.balanceAccountCode);
    const balInsert = await query(
      `INSERT INTO accounts (id, code, name, account_type, normal_balance, entity_id, created_by)
       SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::uuid, $7::uuid
       WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE entity_id = $6::uuid AND code = $2::varchar)`,
      [
        uuidv4(), opts.balanceAccountCode, 'Opening balancing (onboarding)',
        inferred.account_type, inferred.normal_balance, ctx.entityId, reviewer.userId,
      ]
    );
    if (balInsert.rowCount === 1) accountsCreated++;
    // A debit imbalance (debits > credits) is offset with a CREDIT, and vice versa.
    lines.push({
      account_code: opts.balanceAccountCode,
      ...(imbalance.greaterThan(0)
        ? { credit: imbalance.toNumber() }
        : { debit: imbalance.abs().toNumber() }),
      description: `Opening balancing (${plan.provider})`,
    });
  }

  // 3. Opening journal entry through the single path: validated draft → (optional) post.
  const payload: DraftPayload = {
    entry_date: plan.cutoffDate,
    description: `Opening balance from onboarding via ${plan.provider} as of ${plan.cutoffDate}`,
    reference: plan.reference,
    lines,
  };
  const draft = await createDraft(ctx, {
    payload,
    confidence: 1,
    reasoning:
      `Deterministic balance import from ${plan.provider} ` +
      `(trial balance ${plan.startDate}..${plan.cutoffDate}); verify with external_diff_trial_balance after posting`,
    model: 'onboarding-wizard',
  });

  if (!opts.postNow) {
    return { accountsCreated, draftId: draft.id };
  }
  const posted = await approveDraft(ctx, draft.id, reviewer, 'onboarding: opening balance approved in the wizard');
  return { accountsCreated, draftId: draft.id, entryNumber: posted.entryNumber };
}
