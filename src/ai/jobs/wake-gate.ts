import { query } from '../../database/connection.js';
import type { AgentContext } from '../context.js';
import type { JobKind } from './job-store.js';

// ============================================================
// WAKE-GATE (item 18)
// A deterministic pre-check that decides whether a scheduled job
// should wake the LLM at all. SQL ONLY — no model call ever
// happens here. When there is no work, the runner records the
// run as 'skipped_no_work' and the token cost of the cycle is ~0.
// Detection stays deterministic and auditable: the exact counts
// (and a few ids) that woke the agent land in ai_job_runs.detail
// AND seed the agent prompt.
// ============================================================

export interface GateResult {
  hasWork: boolean;
  /** Small parsed summary (counts + a few ids) that seeds the agent prompt. */
  context: string;
  /** Machine-readable counts for ai_job_runs.detail. */
  counts: Record<string, number>;
  /** A few example identifiers so the agent starts anchored on real rows. */
  sampleIds: string[];
}

const SAMPLE_LIMIT = 5;

/**
 * Deterministic work detection for one job kind. Every query is scoped
 * to the entity (and RLS scopes the tenant underneath).
 */
export async function checkForWork(ctx: AgentContext, kind: JobKind): Promise<GateResult> {
  switch (kind) {
    case 'close_verification':
      return checkCloseVerification(ctx);
    case 'cfdi_reconciliation':
      return checkCfdiReconciliation(ctx);
    case 'ar_reminders':
      return checkArReminders(ctx);
    default: {
      const never: never = kind;
      throw new Error(`Unknown job kind: ${String(never)}`);
    }
  }
}

/**
 * Suppression predicate shared by the gates: a source row for which a
 * staged AI draft is ALREADY sitting in pending_review must not wake the
 * agent again — it would only re-draft the same work and burn tokens
 * until a human reviews the first draft. Drafts carry their source in
 * payload->>'reference' (the ingest/job prompts instruct the agent to
 * copy the identifier verbatim), so the match is a literal substring
 * (position(), never LIKE — no wildcard surprises from data). A false
 * suppression is cheap: the wake just waits until the pending draft is
 * approved or rejected, at which point the row surfaces again.
 */
const pendingDraftSuppression = (sourceExpr: string): string =>
  `NOT EXISTS (
     SELECT 1 FROM ai_drafts d
     WHERE d.entity_id = $1
       AND d.status = 'pending_review'
       AND position(${sourceExpr} IN COALESCE(d.payload->>'reference', '')) > 0
   )`;

/**
 * Close verification wakes on either signal:
 *  · unbalanced non-posted journal entries (posted rows are protected by
 *    the CHECK constraint; drafts/pending ones are where imbalances hide),
 *    EXCEPT entries that already have a pending staged draft referencing
 *    their entry_number (see pendingDraftSuppression);
 *  · fiscal periods whose end date passed and are still open/soft_close
 *    (no draft suppression here: closing a period is not a draftable
 *    journal entry, so no payload reference can exist for it).
 * Counts come from count(*) — the LIMIT only caps the sample identifiers,
 * so the reported totals are real, never sample-capped.
 */
async function checkCloseVerification(ctx: AgentContext): Promise<GateResult> {
  const unbalancedWhere = `entity_id = $1
       AND status IN ('draft', 'pending_approval')
       AND total_debits <> total_credits
       AND ${pendingDraftSuppression('journal_entries.entry_number')}`;
  const unbalancedCount = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM journal_entries
     WHERE ${unbalancedWhere}`,
    [ctx.entityId]
  );
  const unbalanced = await query<{ id: string; entry_number: string }>(
    `SELECT id, entry_number FROM journal_entries
     WHERE ${unbalancedWhere}
     ORDER BY entry_date ASC
     LIMIT ${SAMPLE_LIMIT}`,
    [ctx.entityId]
  );
  const overdueWhere = `entity_id = $1
       AND status IN ('open', 'soft_close')
       AND end_date < CURRENT_DATE`;
  const overdueCount = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM fiscal_periods
     WHERE ${overdueWhere}`,
    [ctx.entityId]
  );
  const overdue = await query<{ id: string; period_name: string }>(
    `SELECT id, period_name FROM fiscal_periods
     WHERE ${overdueWhere}
     ORDER BY start_date ASC
     LIMIT ${SAMPLE_LIMIT}`,
    [ctx.entityId]
  );

  const counts = {
    unbalanced_entries: parseInt(unbalancedCount.rows[0]?.total ?? '0', 10),
    overdue_open_periods: parseInt(overdueCount.rows[0]?.total ?? '0', 10),
  };
  const hasWork = counts.unbalanced_entries > 0 || counts.overdue_open_periods > 0;
  const parts: string[] = [];
  if (counts.unbalanced_entries > 0) {
    parts.push(
      `${counts.unbalanced_entries} unbalanced non-posted journal entries ` +
        `(e.g. ${unbalanced.rows.map((r) => r.entry_number).join(', ')})`
    );
  }
  if (counts.overdue_open_periods > 0) {
    parts.push(
      `${counts.overdue_open_periods} fiscal periods past their end date still open ` +
        `(e.g. ${overdue.rows.map((r) => r.period_name).join(', ')})`
    );
  }
  return {
    hasWork,
    context: hasWork ? parts.join('; ') : 'No unbalanced entries and no overdue open periods.',
    counts,
    sampleIds: [
      ...unbalanced.rows.map((r) => r.id),
      ...overdue.rows.map((r) => r.id),
    ],
  };
}

/**
 * CFDI reconciliation wakes when registered xml_documents have no journal
 * entry yet: their pre_registration either does not exist or has a NULL
 * journal_entry_id (and is not already parked as duplicate/rejected).
 * Two exclusions keep empty-work wakes (and duplicate drafts) out:
 *  · documents the pipeline has terminally excluded — processing_status
 *    'rejected' or 'error' can never reconcile (005_xml_ingestion.sql;
 *    'completed' is what reconciliation itself sets);
 *  · documents whose CFDI UUID already appears in the reference of a
 *    staged draft in pending_review (the ingest prompt puts the UUID in
 *    the draft reference verbatim) — waking again before a human reviews
 *    that draft would only stage the same entry twice.
 */
async function checkCfdiReconciliation(ctx: AgentContext): Promise<GateResult> {
  const pendingWhere = `xd.entity_id = $1
       AND xd.processing_status NOT IN ('rejected', 'error')
       AND (pr.id IS NULL OR (pr.journal_entry_id IS NULL
            AND pr.status NOT IN ('duplicate', 'rejected')))
       AND ${pendingDraftSuppression('xd.cfdi_uuid')}`;
  const pending = await query<{ total: string }>(
    `SELECT count(*)::text AS total
     FROM xml_documents xd
     LEFT JOIN pre_registrations pr ON pr.xml_document_id = xd.id
     WHERE ${pendingWhere}`,
    [ctx.entityId]
  );
  const sample = await query<{ id: string; cfdi_uuid: string }>(
    `SELECT xd.id, xd.cfdi_uuid
     FROM xml_documents xd
     LEFT JOIN pre_registrations pr ON pr.xml_document_id = xd.id
     WHERE ${pendingWhere}
     ORDER BY xd.created_at ASC
     LIMIT ${SAMPLE_LIMIT}`,
    [ctx.entityId]
  );

  const total = parseInt(pending.rows[0]?.total ?? '0', 10);
  const uuids = sample.rows.map((r) => r.cfdi_uuid);
  return {
    hasWork: total > 0,
    context:
      total > 0
        ? `${total} CFDI XML documents without a matching journal entry` +
          (uuids.length > 0 ? ` (e.g. UUIDs ${uuids.join(', ')})` : '')
        : 'Every registered CFDI already has a journal entry.',
    counts: { unreconciled_cfdis: total },
    sampleIds: sample.rows.map((r) => r.id),
  };
}

/**
 * AR reminders wake on overdue receivable invoices with an open balance.
 * No pending-draft suppression here: the staged output of this job is an
 * ask_user question listing customers to contact (plus occasional
 * adjustment drafts with no fixed per-invoice reference convention), so
 * there is no deterministic draft-reference join for an invoice — and an
 * overdue balance stays real work until it is actually paid.
 */
async function checkArReminders(ctx: AgentContext): Promise<GateResult> {
  const overdue = await query<{ total: string; amount: string }>(
    `SELECT count(*)::text AS total, COALESCE(SUM(amount_due), 0)::text AS amount
     FROM invoices
     WHERE entity_id = $1
       AND due_date < CURRENT_DATE
       AND amount_due > 0
       AND status IN ('pending', 'sent', 'viewed', 'partially_paid', 'overdue')`,
    [ctx.entityId]
  );
  const sample = await query<{ id: string; invoice_number: string }>(
    `SELECT id, invoice_number
     FROM invoices
     WHERE entity_id = $1
       AND due_date < CURRENT_DATE
       AND amount_due > 0
       AND status IN ('pending', 'sent', 'viewed', 'partially_paid', 'overdue')
     ORDER BY due_date ASC
     LIMIT ${SAMPLE_LIMIT}`,
    [ctx.entityId]
  );

  const total = parseInt(overdue.rows[0]?.total ?? '0', 10);
  const amount = overdue.rows[0]?.amount ?? '0';
  return {
    hasWork: total > 0,
    context:
      total > 0
        ? `${total} overdue AR invoices with open balance (total due ${amount} ${ctx.currency}; ` +
          `oldest: ${sample.rows.map((r) => r.invoice_number).join(', ')})`
        : 'No overdue AR invoices with an open balance.',
    counts: { overdue_invoices: total },
    sampleIds: sample.rows.map((r) => r.id),
  };
}
