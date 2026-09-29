import type pg from 'pg';
import { ConflictError } from '../../../utils/errors.js';
import { entityScope } from '../../../database/scope.js';
import { alcanceDeCorrida } from './alcance-nomina.js';

// ============================================================
// ONE PAY RUN, ONE LEDGER ENTRY, WHICHEVER ROAD IT TOOK (MNE-001-069, #306)
//
// A run's entry reaches the ledger either directly (`pay-run post --post`,
// REST `post-to-gl`) or as a draft approved in `mnemosine review`. Both roads
// must leave the same trace: entry_type PAYROLL, source `pay_run`/<run id>,
// reference `pay-run:<run id>`, and `pay_runs.journal_entry_id` filled. What
// both need to agree on lives here, so `draft-service` can close the link at
// approval (as it already closes a bill's or an invoice's) without importing
// the posting service that imports it.
// ============================================================

/** What `ai_drafts.ai_model` says produced a run's draft. The agent cannot set it. */
export const PAYROLL_DRAFT_PRODUCER = 'mnemosine/payroll';

/** The reference that ties an entry, and its draft, to its run. */
export function payRunReference(payRunId: string): string {
  return `pay-run:${payRunId}`;
}

const REFERENCE_RE = /^pay-run:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The run a draft books, or null when it is not a run's draft. Both the
 * producer and the reference must say so: a reference alone is free text any
 * AI-authored draft can carry.
 */
export function payRunOfDraft(draft: { ai_model: string; payload: { reference?: string } }): string | null {
  if (draft.ai_model !== PAYROLL_DRAFT_PRODUCER) return null;
  const m = REFERENCE_RE.exec(draft.payload.reference ?? '');
  return m ? m[1] : null;
}

/**
 * Links the run to its entry inside the caller's transaction. Scoped to the
 * tenant AND the entity in the same statement (AGENTS.md invariant 3), and
 * only while the run has no entry: a second link rolls the caller back.
 */
export async function linkPayRunEntry(
  client: pg.PoolClient,
  link: { payRunId: string; tenantId: string; entityId: string; journalEntryId: string }
): Promise<void> {
  const scope = alcanceDeCorrida(entityScope(link.tenantId, link.entityId), 'pay_runs.pay_period_id', 3);
  const linked = await client.query(
    `UPDATE pay_runs SET journal_entry_id = $1
      WHERE id = $2 AND ${scope.sql} AND journal_entry_id IS NULL`,
    [link.journalEntryId, link.payRunId, ...scope.valores]
  );
  if (linked.rowCount !== 1) {
    throw new ConflictError(
      `Pay run ${link.payRunId} already has an entry, or is not in this entity; nothing was written`
    );
  }
}
