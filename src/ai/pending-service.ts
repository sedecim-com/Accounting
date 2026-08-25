import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';

// ============================================================
// PENDING WORK BOARD
// Everything waiting on a human, in a single query. Pending
// work lives in four different tables and until now you had to
// remember three commands to see it; this turns it into a
// single question: "what do I need to do?".
// ============================================================

export interface PendingItem {
  kind: 'draft' | 'question' | 'external_op' | 'credential_expiry' | 'period_close';
  count: number;
  /** Display-ready phrase, in the accountant's language. */
  summary: string;
  /** Exact command that resolves this pending item. */
  command: string | null;
  /** true = not work, but a warning with a deadline. */
  warning?: boolean;
  /** Detail of the first few items, for context without another command. */
  examples?: string[];
}

export interface PendingBoard {
  items: PendingItem[];
  /** Sum of actionable work (excludes warnings). */
  totalWork: number;
}

const EXAMPLE_LIMIT = 3;

/** Pluralize without awkward strings: "1 draft" / "3 drafts". */
function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`;
}

export async function getPendingBoard(ctx: AgentContext): Promise<PendingBoard> {
  // One query per source, in parallel: the board must be instantaneous.
  const [drafts, questions, ops, creds, periods] = await Promise.all([
    pendingDrafts(ctx),
    pendingQuestions(ctx),
    pendingExternalOps(ctx),
    expiringCredentials(ctx),
    openPeriodsPastEnd(ctx),
  ]);

  const items = [drafts, questions, ops, periods, creds].filter(
    (i): i is PendingItem => i !== null
  );
  const totalWork = items.filter((i) => !i.warning).reduce((s, i) => s + i.count, 0);
  return { items, totalWork };
}

async function pendingDrafts(ctx: AgentContext): Promise<PendingItem | null> {
  const r = await query<{ description: string; total: string }>(
    `SELECT payload->>'description' AS description,
            (payload->>'entry_date') AS total
     FROM ai_drafts
     WHERE entity_id = $1 AND status = 'pending_review'
     ORDER BY created_at ASC`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return null;
  return {
    kind: 'draft',
    count: r.rows.length,
    summary: `${plural(r.rows.length, 'draft awaits', 'drafts await')} your approval`,
    command: 'mnemosine review',
    examples: r.rows.slice(0, EXAMPLE_LIMIT).map((d) => `${d.total} · ${d.description}`),
  };
}

async function pendingQuestions(ctx: AgentContext): Promise<PendingItem | null> {
  const r = await query<{ question: string }>(
    `SELECT question FROM ai_questions
     WHERE entity_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return null;
  return {
    kind: 'question',
    count: r.rows.length,
    summary: `${plural(r.rows.length, 'unanswered question', 'unanswered questions')} from the AI`,
    command: 'mnemosine questions',
    examples: r.rows.slice(0, EXAMPLE_LIMIT).map((q) => q.question),
  };
}

async function pendingExternalOps(ctx: AgentContext): Promise<PendingItem | null> {
  const r = await query<{ provider: string; operation: string }>(
    `SELECT provider, operation FROM ai_external_ops
     WHERE entity_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return null;
  const providers = [...new Set(r.rows.map((o) => o.provider))].join(', ');
  return {
    kind: 'external_op',
    count: r.rows.length,
    summary: `${plural(r.rows.length, 'queued write', 'queued writes')} to ${providers}`,
    command: 'mnemosine outbox',
    examples: r.rows.slice(0, EXAMPLE_LIMIT).map((o) => `${o.provider}: ${o.operation}`),
  };
}

/** A warning, not work: the e.firma expires and must be renewed at the SAT. */
async function expiringCredentials(ctx: AgentContext): Promise<PendingItem | null> {
  const r = await query<{ credential_type: string; days: string }>(
    `SELECT credential_type,
            FLOOR(EXTRACT(EPOCH FROM (valid_to - NOW())) / 86400)::text AS days
     FROM fiscal_credentials
     WHERE entity_id = $1 AND status = 'active' AND valid_to < NOW() + INTERVAL '60 days'
     ORDER BY valid_to ASC`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return null;
  const soonest = r.rows[0];
  const days = parseInt(soonest.days, 10);
  const label = soonest.credential_type === 'efirma' ? 'e.firma' : 'CSD';
  return {
    kind: 'credential_expiry',
    count: r.rows.length,
    warning: true,
    summary:
      days <= 0
        ? `your ${label} has ALREADY EXPIRED — renew it at the SAT`
        : `your ${label} expires in ${plural(days, 'day', 'days')}`,
    command: 'mnemosine sat cred status',
  };
}

/**
 * Periods whose end date has passed and are still open: the closing reminder
 * an accountant expects from the system, not from their memory.
 */
async function openPeriodsPastEnd(ctx: AgentContext): Promise<PendingItem | null> {
  const r = await query<{ period_name: string; end_date: string }>(
    `SELECT period_name, end_date::text
     FROM fiscal_periods
     WHERE entity_id = $1 AND status = 'open' AND end_date < CURRENT_DATE
     ORDER BY end_date ASC`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return null;
  return {
    kind: 'period_close',
    count: r.rows.length,
    summary: `${plural(r.rows.length, 'ended period remains', 'ended periods remain')} unclosed`,
    command: 'mnemosine close',
    examples: r.rows.slice(0, EXAMPLE_LIMIT).map((p) => `${p.period_name} (ended ${p.end_date})`),
  };
}
