import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { query } from '../../database/connection.js';
import type { AgentContext } from '../context.js';
import type { ToolDeps } from './observer.js';

// ============================================================
// STATUS TOOL — the diagnostic backbone of guidance.
// One call answers "where is this company in its lifecycle?",
// so the agent can LEAD ("you are at step 2; run X") instead of
// asking the user to self-diagnose with a menu of questions.
// ============================================================

/**
 * Lifecycle stages, in order. The first unmet requirement wins:
 * a company with no chart of accounts is 'no_catalog' even if it
 * also lacks periods and balances.
 */
export type EntityStage =
  | 'no_catalog'          // 0 accounts: run mnemosine init (or onboard)
  | 'no_fiscal_year'      // accounts but no postable periods AND nothing ever posted
  | 'no_opening_balance'  // structure ready, nothing posted yet
  | 'operating';          // has posted entries (even if every period is now closed)

export interface EntityStatus {
  entity: {
    name: string;
    rfc: string;
    country: string;
    currency: string;
    accounting_standard: string;
  };
  stage: EntityStage;
  /** What the stage means and the exact next step, ready to relay. */
  next_step: string;
  accounts: number;
  /** Periods that accept postings: open, future or soft_close (warning only). */
  postable_periods: number;
  posted_entries: number;
  /** True only if a posted opening entry exists (reference 'onboarding:…'). */
  has_opening_balance: boolean;
  pending: { drafts: number; questions: number; external_ops: number };
  customers: number;
  vendors: number;
  fiscal_credentials_active: number;
  external_accounting_configured: boolean;
}

const NEXT_STEP: Record<EntityStage, string> = {
  no_catalog:
    'The entity has no chart of accounts. If migrating from another system with an API (e.g. Contalink): ' +
    '`mnemosine onboard --provider contalink --cutoff <YYYY-MM-DD> --dry-run` creates the accounts AND the ' +
    'opening balance in one step. Otherwise `mnemosine init` (section identity is done; the human can also ' +
    'seed accounts via the REST API) — or give me the trial balance and I will tell you which accounts to create.',
  no_fiscal_year:
    'There is a chart of accounts but no postable fiscal periods, so nothing can be posted. ' +
    'Run `mnemosine init --section identity`: it creates the current fiscal year with 12 monthly periods.',
  no_opening_balance:
    'Structure is ready (accounts + periods) but nothing has been posted. If migrating: ' +
    '`mnemosine onboard --provider <x> --cutoff <date>` imports the opening balance; or give me the ' +
    'closing trial balance of the previous system and I will draft the opening entry for `mnemosine review`.',
  operating:
    'The company is operating. Daily flow: `mnemosine ingest *.xml` for CFDIs, then `mnemosine review` ' +
    'for my drafts, `mnemosine questions` for my questions, `mnemosine close` at month end.',
};

/**
 * The static map covers the base case per stage; two situations need the
 * counts to avoid steering the user into a hole:
 * - no_opening_balance with drafts pending: the opening balance is (very
 *   likely) already drafted — a second onboard/draft would duplicate it.
 * - operating with zero postable periods: history exists but every period
 *   is closed; prescribing the setup wizard here would be a misdiagnosis.
 */
function nextStep(stage: EntityStage, c: { periods: number; drafts: number }): string {
  if (stage === 'no_opening_balance' && c.drafts > 0) {
    return (
      `Structure is ready and ${c.drafts} draft(s) are ALREADY pending review — most likely the ` +
      'opening balance. Inspect them with list_drafts and have the human run `mnemosine review` to ' +
      'approve or reject. Do NOT run onboard or draft the opening balance again while one is pending.'
    );
  }
  if (stage === 'operating' && c.periods === 0) {
    return (
      'The company has posted history but NO postable fiscal periods (all closed). Nothing can be ' +
      'posted until one exists: `mnemosine init --section identity` creates the current calendar year ' +
      'if it is missing; if the current year exists but is fully closed, reopen a period or create ' +
      'the next fiscal year via the REST API.'
    );
  }
  return NEXT_STEP[stage];
}

export async function getEntityStatus(ctx: AgentContext): Promise<EntityStatus> {
  // One round-trip: every count scoped to the entity. Scalar subqueries keep
  // it a single network hop — this tool must be cheap enough to call FIRST
  // on every setup-ish request.
  const r = await query<{
    accounts: string; periods: string; posted: string; opening: string;
    drafts: string; questions: string; ops: string;
    customers: string; vendors: string; creds: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM accounts WHERE entity_id = $1 AND is_active) AS accounts,
       (SELECT count(*)::text FROM fiscal_periods
         WHERE entity_id = $1 AND status IN ('open','future','soft_close')) AS periods,
       (SELECT count(*)::text FROM journal_entries
         WHERE entity_id = $1 AND status = 'posted') AS posted,
       (SELECT EXISTS(SELECT 1 FROM journal_entries
         WHERE entity_id = $1 AND status = 'posted'
           AND reference LIKE 'onboarding:%')::text) AS opening,
       (SELECT count(*)::text FROM ai_drafts
         WHERE entity_id = $1 AND status = 'pending_review') AS drafts,
       (SELECT count(*)::text FROM ai_questions
         WHERE entity_id = $1 AND status = 'pending') AS questions,
       (SELECT count(*)::text FROM ai_external_ops
         WHERE entity_id = $1 AND status = 'pending') AS ops,
       (SELECT count(*)::text FROM customers WHERE entity_id = $1 AND is_active) AS customers,
       (SELECT count(*)::text FROM vendors WHERE entity_id = $1 AND is_active) AS vendors,
       (SELECT count(*)::text FROM fiscal_credentials
         WHERE entity_id = $1 AND status = 'active') AS creds`,
    [ctx.entityId]
  );
  const row = r.rows[0];
  const n = (k: keyof typeof row) => parseInt(row[k], 10);

  const accounts = n('accounts');
  const periods = n('periods');
  const posted = n('posted');

  // Guard: posted history means the company IS operating even if every
  // period is closed today — the cascade must never regress it to a
  // setup stage (that would prescribe re-creating what already exists).
  const stage: EntityStage =
    accounts === 0 ? 'no_catalog'
    : periods === 0 && posted === 0 ? 'no_fiscal_year'
    : posted === 0 ? 'no_opening_balance'
    : 'operating';

  const drafts = n('drafts');

  return {
    entity: {
      name: ctx.entityName,
      rfc: ctx.taxId,
      country: ctx.country,
      currency: ctx.currency,
      accounting_standard: ctx.accountingStandard,
    },
    stage,
    next_step: nextStep(stage, { periods, drafts }),
    accounts,
    postable_periods: periods,
    posted_entries: posted,
    has_opening_balance: row.opening === 'true',
    pending: { drafts, questions: n('questions'), external_ops: n('ops') },
    customers: n('customers'),
    vendors: n('vendors'),
    fiscal_credentials_active: n('creds'),
    external_accounting_configured: !!process.env.CONTALINK_API_KEY,
  };
}

export function buildStatusTools(ctx: AgentContext, deps: ToolDeps) {
  const statusTool = betaZodTool({
    name: 'get_entity_status',
    description:
      "The company's lifecycle diagnosis in ONE call: stage (no_catalog | no_fiscal_year | " +
      'no_opening_balance | operating), counts (accounts, periods, posted entries, customers, ' +
      'vendors, pending work) and the recommended next step. On any setup, onboarding, migration ' +
      'or "where do I start" request the order is always: read the "playbooks" doc (once per ' +
      'conversation), then call this tool BEFORE answering — diagnose with this instead of ' +
      'asking the user.',
    inputSchema: z.object({}),
    run: async () => {
      deps.observe?.('get_entity_status', {});
      return JSON.stringify(await getEntityStatus(ctx));
    },
  });
  return [statusTool];
}
