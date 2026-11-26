import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import {
  summarizeUsage,
  type UsageGroupBy,
  type UsageSummary,
} from '../ai/usage-ledger.js';
import { PRECIOS_VIGENTES_A } from '../ai/providers/prices.js';
import { describeCommand, exitCodeFor, optionByKey, usageError } from './kernel/index.js';
import { t } from '../i18n/index.js';

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
      throw usageError({ key: 'platform.usage.since_capped', params: { value, max: MAX_SINCE_DAYS } });
    }
    const parsed = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    if (Number.isNaN(parsed.getTime())) {
      throw usageError({ key: 'platform.usage.since_out_of_range', params: { value } });
    }
    return parsed;
  }
  if (DATE_RE.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw usageError({ key: 'platform.usage.since_invalid', params: { value } });
}

export function parseGroupBy(value: string | undefined): UsageGroupBy {
  if (!value) return 'model';
  const normalized = value.trim().toLowerCase() as UsageGroupBy;
  if (!GROUP_CHOICES.includes(normalized)) {
    throw usageError({ key: 'platform.usage.by_invalid', params: { value, choices: GROUP_CHOICES.join(', ') } });
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
const COLUMNS = ['turns', 'input', 'output', 'cache_read', 'cache_write', 'cost'] as const;

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
  const out: string[] = [
    '',
    c.bold(t('platform.usage.title', { groupBy })),
    // La fecha de corte de los precios viaja con cada reporte (S1): un
    // estimado con tabla vieja debe leerse como lo que es.
    c.dim(`  ${t('platform.usage.prices_as_of', { date: PRECIOS_VIGENTES_A })}`),
    '',
  ];

  if (summary.rows.length === 0) {
    out.push(c.dim(`  ${t('platform.usage.empty')}`));
    out.push('');
    return out;
  }

  out.push(line(groupBy.toUpperCase(), COLUMNS.map((k) => t(`platform.usage.column.${k}`)), c.bold));
  for (const r of summary.rows) {
    const key = groupBy === 'model' && r.provider ? `${r.key} (${r.provider})` : r.key;
    const cost = r.unpricedTurns === r.turns ? c.dim(t('platform.usage.unpriced')) : fmtUsd(r.costUsd);
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
    out.push(c.dim(`  ${t('platform.usage.unpriced_turns', { count: summary.totals.unpricedTurns })}`));
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
  const usage = describeCommand(program.command('usage').alias('uso'), 'help.usage.description');
  optionByKey(usage, '-e, --entity <idOrName>', 'help.usage.option.entity');
  optionByKey(usage, '-t, --tenant <id>', 'help.usage.option.tenant');
  optionByKey(usage, '--since <window>', 'help.usage.option.since');
  optionByKey(usage, '--by <dimension>', 'help.usage.option.by', {
    params: { choices: GROUP_CHOICES.join(', ') },
    defaultValue: 'model',
  });
  optionByKey(usage, '--json', 'help.usage.option.json');
  usage
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
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
