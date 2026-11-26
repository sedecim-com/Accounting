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
import { describeCommand, exitCodeFor, ExitCode, optionByKey } from './kernel/index.js';
import { t } from '../i18n/index.js';

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
    c.bold(t('platform.compact.title')),
    `  ${t('platform.compact.session', { id: report.sessionId })}${report.title ? c.dim(`  — ${report.title}`) : ''}`,
    `  ${t('platform.compact.transcript', { messages: fmt(report.messages), tokens: fmt(report.totalTokens) })}`,
    `  ${t('platform.compact.keep_tail', { tokens: fmt(report.keepRecentTokens) })}`,
    '',
  ];
  if (!report.plan) {
    out.push(`  ${t('platform.compact.nothing')}`);
  } else {
    const { cutIndex, dropTokens, keepTokens } = report.plan;
    out.push(c.bold(`  ${t('platform.compact.would')}`));
    out.push(`    ${t('platform.compact.summarize', { count: fmt(cutIndex), tokens: fmt(dropTokens) })}`);
    out.push(`    ${t('platform.compact.keep', { count: fmt(report.messages - cutIndex), tokens: fmt(keepTokens) })}`);
  }
  out.push('');
  out.push(c.dim(`  ${t('platform.compact.dry_run_only')}`));
  out.push('');
  return out;
}

export function registerCompactCommand(program: Command, deps: CompactDeps): void {
  const compact = describeCommand(program.command('compact').alias('compactar'), 'help.compact.description');
  optionByKey(compact, '-e, --entity <idOrName>', 'help.compact.option.entity');
  optionByKey(compact, '-t, --tenant <id>', 'help.compact.option.tenant');
  // SIN `-s`. La letra la tiene `--status` en el diccionario único, y esta
  // hoja se la había quedado para otra cosa. Se retira al congelar
  // `--session` en el diccionario (F05b la necesita en tres hojas de cotejo):
  // dejarla obligaría a que `bank match run --session` también llevara `-s`,
  // y entonces la misma letra significaría «estado» en un comando y «sesión»
  // en otro. Es el mismo canje que hizo `close` con `-p` en S0.6, y el
  // catálogo ya escribía esta bandera sin forma corta (fila de `compact`).
  optionByKey(compact, '--session <id>', 'help.compact.option.session');
  optionByKey(compact, '--keep <tokens>', 'help.compact.option.keep', { defaultValue: String(DEFAULT_KEEP_RECENT_TOKENS) });
  optionByKey(compact, '--json', 'help.compact.option.json');
  compact
    .action(
      async (opts: { entity?: string; tenant?: string; session?: string; keep?: string; json?: boolean }) => {
        try {
          bootstrapTenant(opts.tenant);
          const ctx = await resolveEntity(opts.entity);
          const session = opts.session
            ? await getSession(ctx, opts.session)
            : await latestSession(ctx);
          if (!session) {
            console.log(t(opts.session ? 'platform.compact.session_not_found' : 'platform.compact.no_sessions'));
            // Las dos ramas dicen lo mismo con distinto texto: la sesión que
            // se iba a compactar NO ESTÁ. Ese es el 3 del contrato, no el 1
            // genérico — un guion que encadena `compact` necesita distinguir
            // «no había nada que compactar» de «la compactación reventó».
            await deps.shutdown(ExitCode.NOT_FOUND);
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
          await deps.shutdown(exitCodeFor(err));
        }
      }
    );
}
