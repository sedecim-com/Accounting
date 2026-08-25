import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import {
  getSession,
  getSessionMessages,
  latestSession,
  type MessageRow,
} from '../ai/session-store.js';
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateViewTokens,
  planCompaction,
  type CompactableMessage,
  type CompactionPlan,
} from '../ai/compaction.js';

// ============================================================
// mnemosine compact (OFFLINE — zero API calls)
// Dry-run compaction report over a PERSISTED session transcript:
// what a live /compact would drop and keep, with the same
// cut-point rules (tool pairs never split, intact recent tail).
// Live compaction only makes sense inside chat — it rewrites the
// model's in-flight view, which exists only there — so this
// command reports and points the operator at /compact in chat.
// The Postgres transcript itself is NEVER modified.
// ============================================================

/**
 * Projects persisted transcript rows into the neutral compaction shape.
 * 'tool' rows carry both the call (tool_calls) and its result preview, so
 * they close their own pair: opensToolUse stays false and the planner's
 * isToolResult rule keeps assistant→tool sequences together.
 */
export function transcriptView(rows: MessageRow[]): CompactableMessage[] {
  return rows.map((row) => {
    const text = [row.content, row.tool_calls ? JSON.stringify(row.tool_calls) : '']
      .filter(Boolean)
      .join('\n');
    return {
      role: row.role,
      chars: text.length,
      opensToolUse: false,
      isToolResult: row.role === 'tool',
      text,
    };
  });
}

export interface CompactReport {
  sessionId: string;
  title: string | null;
  messages: number;
  totalTokens: number;
  keepRecentTokens: number;
  /** null = nothing to compact under the current options. */
  plan: CompactionPlan | null;
}

/** Pure planning over an already-loaded transcript. */
export function computeCompactReport(
  sessionId: string,
  title: string | null,
  view: CompactableMessage[],
  keepRecentTokens: number
): CompactReport {
  return {
    sessionId,
    title,
    messages: view.length,
    totalTokens: estimateViewTokens(view),
    keepRecentTokens,
    plan: planCompaction(view, { keepRecentTokens }),
  };
}

export interface CompactDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Renders the report as plain lines. Pure formatting — no I/O. */
export function formatCompactReport(report: CompactReport, c: CompactDeps['palette']): string[] {
  const out: string[] = [
    '',
    c.bold('Compaction dry-run (offline estimate, ~4 chars/token)'),
    `  session   ${report.sessionId}${report.title ? c.dim(`  — ${report.title}`) : ''}`,
    `  transcript ${fmt(report.messages)} messages, ~${fmt(report.totalTokens)} tokens`,
    `  keep tail  ~${fmt(report.keepRecentTokens)} tokens (intact)`,
    '',
  ];
  if (!report.plan) {
    out.push('  Nothing to compact: the transcript fits within the recent-tail budget.');
  } else {
    out.push(c.bold('  A live /compact would:'));
    out.push(
      `    summarize ${fmt(report.plan.cutIndex)} older messages (~${fmt(report.plan.dropTokens)} tokens)`
    );
    out.push(`    keep ${fmt(report.messages - report.plan.cutIndex)} recent messages (~${fmt(report.plan.keepTokens)} tokens)`);
  }
  out.push('');
  out.push(
    c.dim(
      '  Dry-run only: compaction rewrites the MODEL\'S in-flight view, so it runs inside chat ' +
        '(/compact). The Postgres transcript is never modified.'
    )
  );
  out.push('');
  return out;
}

export function registerCompactCommand(program: Command, deps: CompactDeps): void {
  program
    .command('compact')
    .alias('compactar')
    .description('Dry-run compaction report for a session transcript (no API calls)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('-s, --session <id>', 'Session id (default: the most recent session)')
    .option('--keep <tokens>', 'Recent tail to keep intact, in tokens', String(DEFAULT_KEEP_RECENT_TOKENS))
    .option('--json', 'JSON output')
    .action(
      async (opts: { entity?: string; tenant?: string; session?: string; keep?: string; json?: boolean }) => {
        try {
          bootstrapTenant(opts.tenant);
          const ctx = await resolveEntity(opts.entity);
          const session = opts.session
            ? await getSession(ctx, opts.session)
            : await latestSession(ctx);
          if (!session) {
            console.log(opts.session ? 'Session not found for this entity.' : 'No sessions yet for this entity.');
            await deps.shutdown(1);
            return;
          }
          const keepParsed = Number.parseInt(opts.keep ?? '', 10);
          const keep = Number.isFinite(keepParsed) && keepParsed > 0 ? keepParsed : DEFAULT_KEEP_RECENT_TOKENS;
          const rows = await getSessionMessages(session.id);
          const report = computeCompactReport(session.id, session.title, transcriptView(rows), keep);
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            for (const line of formatCompactReport(report, deps.palette)) console.log(line);
          }
          await deps.shutdown(0);
        } catch (err) {
          deps.reportError(err);
          await deps.shutdown(1);
        }
      }
    );
}
