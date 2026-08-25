import { query } from '../database/connection.js';
import { getPeriodCloseStatus } from '../services/accounting/period-close.js';
import type { AgentContext } from './context.js';

// ============================================================
// MONTH-END CLOSE ASSISTANT
// The accounting engine already knows HOW to close a period
// (period-close.ts: checklist, blocking issues, soft/hard).
// What was missing is the layer that answers "which period do I
// close now, and what is missing for it" — plus the AI-specific
// blockers the engine cannot know about: drafts waiting for
// review and questions blocking classification.
// ============================================================

export interface ClosablePeriod {
  id: string;
  period_name: string;
  period_number: number;
  start_date: string;
  end_date: string;
  status: string;
  year_number: number;
  /** true = its end date already passed: it is due to be closed. */
  overdue: boolean;
}

/** AI-side blockers: the engine does not see drafts or questions. */
export interface AiBlockers {
  pendingDrafts: number;
  pendingQuestions: number;
  pendingExternalOps: number;
}

export interface CloseReadiness {
  period: ClosablePeriod;
  canClose: boolean;
  blockingIssues: string[];
  warnings: string[];
  checklist: Array<{ item: string; is_complete: boolean; details?: string }>;
  ai: AiBlockers;
}

/**
 * Periods that are candidates to close: open, ordered oldest first.
 * A period cannot be closed while an earlier one is still open, so the
 * order is also the order in which they must be worked.
 */
export async function listClosablePeriods(ctx: AgentContext): Promise<ClosablePeriod[]> {
  const r = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number,
            fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number,
            (fp.end_date < CURRENT_DATE) AS overdue
     FROM fiscal_periods fp
     JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
     WHERE fp.entity_id = $1 AND fp.status IN ('open', 'soft_close')
     ORDER BY fp.start_date ASC`,
    [ctx.entityId]
  );
  return r.rows;
}

/** The oldest open period: the one that must be closed first. */
export async function nextPeriodToClose(ctx: AgentContext): Promise<ClosablePeriod | null> {
  const periods = await listClosablePeriods(ctx);
  return periods.find((p) => p.overdue) ?? periods[0] ?? null;
}

/**
 * Blockers the accounting engine cannot see: work sitting in the AI
 * queues. Closing a period with drafts pending would silently leave those
 * entries out of the closed period.
 */
export async function getAiBlockers(ctx: AgentContext, period: ClosablePeriod): Promise<AiBlockers> {
  const r = await query<{ drafts: string; questions: string; ops: string }>(
    `SELECT
       (SELECT count(*)::text FROM ai_drafts
         WHERE entity_id = $1 AND status = 'pending_review'
           AND (payload->>'entry_date')::date BETWEEN $2::date AND $3::date) AS drafts,
       (SELECT count(*)::text FROM ai_questions
         WHERE entity_id = $1 AND status = 'pending') AS questions,
       (SELECT count(*)::text FROM ai_external_ops
         WHERE entity_id = $1 AND status = 'pending') AS ops`,
    [ctx.entityId, period.start_date, period.end_date]
  );
  return {
    pendingDrafts: parseInt(r.rows[0].drafts, 10),
    pendingQuestions: parseInt(r.rows[0].questions, 10),
    pendingExternalOps: parseInt(r.rows[0].ops, 10),
  };
}

/**
 * Full readiness: the engine's checklist plus the AI blockers. Drafts
 * dated inside the period BLOCK the close (they belong in it); questions
 * and queued writes only warn (they may be unrelated to this period).
 */
export async function getCloseReadiness(
  ctx: AgentContext,
  period: ClosablePeriod
): Promise<CloseReadiness> {
  const [engine, ai] = await Promise.all([
    getPeriodCloseStatus(period.id, ctx.entityId),
    getAiBlockers(ctx, period),
  ]);

  const blockingIssues = [...engine.blocking_issues];
  const warnings = [...engine.warnings];

  if (ai.pendingDrafts > 0) {
    blockingIssues.push(
      `${ai.pendingDrafts} AI draft(s) dated inside this period are still pending review ` +
        `— approve or reject them first (mnemosine review)`
    );
  }
  if (ai.pendingQuestions > 0) {
    warnings.push(
      `${ai.pendingQuestions} unanswered question(s) may be blocking classifications (mnemosine questions)`
    );
  }
  if (ai.pendingExternalOps > 0) {
    warnings.push(
      `${ai.pendingExternalOps} write(s) queued to external systems have not been executed (mnemosine outbox)`
    );
  }

  return {
    period,
    canClose: blockingIssues.length === 0,
    blockingIssues,
    warnings,
    checklist: engine.checklist,
    ai,
  };
}
