import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import {
  summarizeUsage,
  type UsageGroupBy,
  type UsageSummary,
} from '../ai/usage-ledger.js';

// ============================================================
// mnemosine usage
// Token and estimated-cost report over the ai_usage ledger.
// Costs come from the local price table (an ESTIMATE for
// budgeting, not billing); rows whose model the table does not
// know are shown as unpriced instead of silently dropped.
// ============================================================

const GROUP_CHOICES: UsageGroupBy[] = ['model', 'provider', 'day', 'session'];

const RELATIVE_RE = /^(\d+)d$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Largest accepted relative window (~10 years). Anything bigger is a typo. */
const MAX_SINCE_DAYS = 3650;

/**
 * Parses --since: "7d"/"30d" (relative days) or "YYYY-MM-DD".
 * `now` is injectable for tests. Returns undefined when the flag is absent.
 * Day counts are capped at 3650 (~10 years): an absurd or overflowing
 * count would otherwise produce an Invalid Date that crashes deep inside
 * query parameter serialization instead of failing here with a clear error.
 */
export function parseSince(value: string | undefined, now: Date = new Date()): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const days = Number(rel[1]);
    if (!Number.isSafeInteger(days) || days > MAX_SINCE_DAYS) {
      throw new Error(`Invalid --since value "${value}": relative windows are capped at ${MAX_SINCE_DAYS}d.`);
    }
    const parsed = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --since value "${value}": the resulting date is out of range.`);
    }
    return parsed;
  }
  if (DATE_RE.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`Invalid --since value "${value}". Use Nd (e.g. 7d, 30d) or YYYY-MM-DD.`);
}

export function parseGroupBy(value: string | undefined): UsageGroupBy {
  if (!value) return 'model';
  const normalized = value.trim().toLowerCase() as UsageGroupBy;
  if (!GROUP_CHOICES.includes(normalized)) {
    throw new Error(`Invalid --by value "${value}". Use one of: ${GROUP_CHOICES.join(', ')}.`);
  }
  return normalized;
}

export interface UsagePalette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;

const KEY_WIDTH = 30;
const NUM_WIDTH = 11;

function line(key: string, cells: string[], bold?: (s: string) => string): string {
  const row = `  ${key.padEnd(KEY_WIDTH)}${cells.map((c) => c.padStart(NUM_WIDTH)).join('')}`;
  return bold ? bold(row) : row;
}

/** Renders the summary as aligned plain lines. Pure formatting — no I/O. */
export function formatUsageTable(
  summary: UsageSummary,
  groupBy: UsageGroupBy,
  c: UsagePalette
): string[] {
  const out: string[] = ['', c.bold(`Usage by ${groupBy} (costs are local estimates, not billing)`), ''];

  if (summary.rows.length === 0) {
    out.push(c.dim('  No usage recorded for this entity in the selected window.'));
    out.push('');
    return out;
  }

  out.push(line(groupBy.toUpperCase(), ['TURNS', 'INPUT', 'OUTPUT', 'CACHE RD', 'CACHE WR', 'EST. USD'], c.bold));
  for (const r of summary.rows) {
    const key = groupBy === 'model' && r.provider ? `${r.key} (${r.provider})` : r.key;
    const cost = r.unpricedTurns === r.turns ? c.dim('unpriced') : fmtUsd(r.costUsd);
    out.push(
      line(key.length > KEY_WIDTH ? `${key.slice(0, KEY_WIDTH - 1)}…` : key, [
        fmt(r.turns), fmt(r.inputTokens), fmt(r.outputTokens),
        fmt(r.cacheReadTokens), fmt(r.cacheWriteTokens), cost,
      ])
    );
  }

  out.push('');
  out.push(
    line('TOTAL', [
      fmt(summary.totals.turns), fmt(summary.totals.inputTokens), fmt(summary.totals.outputTokens),
      fmt(summary.totals.cacheReadTokens), fmt(summary.totals.cacheWriteTokens), fmtUsd(summary.totals.costUsd),
    ], c.bold)
  );
  if (summary.totals.unpricedTurns > 0) {
    out.push(
      c.dim(
        `  ${summary.totals.unpricedTurns} turn(s) on models missing from the local price table: ` +
          'tokens counted, cost excluded from the total.'
      )
    );
  }
  out.push('');
  return out;
}

export interface UsageCommandDeps {
  palette: UsagePalette;
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

export function registerUsageCommand(program: Command, deps: UsageCommandDeps): void {
  program
    .command('usage')
    .alias('uso')
    .description('Token usage and estimated cost from the local ledger (no API calls)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--since <window>', 'Window: Nd (e.g. 7d, 30d) or YYYY-MM-DD')
    .option('--by <dimension>', `Group by: ${GROUP_CHOICES.join(', ')}`, 'model')
    .option('--json', 'JSON output')
    .action(async (opts: { entity?: string; tenant?: string; since?: string; by?: string; json?: boolean }) => {
      try {
        const groupBy = parseGroupBy(opts.by);
        const since = parseSince(opts.since);
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const summary = await summarizeUsage(ctx, { since, groupBy });
        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          for (const l of formatUsageTable(summary, groupBy, deps.palette)) console.log(l);
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
