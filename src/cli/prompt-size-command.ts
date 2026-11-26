import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { buildSystemBlocks } from '../ai/system-prompt.js';
import { buildTools } from '../ai/tools/index.js';
import { docsIndex } from '../ai/tools/docs-tools.js';
import { describeCommand, exitCodeFor, optionByKey } from './kernel/index.js';
import { t } from '../i18n/index.js';

// ============================================================
// mnemosine prompt-size (OFFLINE — zero API calls)
// Fixed-budget breakdown of everything the agent ships to the
// model on turn one: system blocks (split into role / docs
// index / chart of accounts / volatile) and every tool schema.
// Detects regressions ("a tool schema that got fat") and shows
// which layer sits before the prompt-cache breakpoint (cached)
// versus after it (re-billed every call).
// Token counts are the standard chars/4 approximation: good
// enough for budget comparisons, no tokenizer dependency.
// ============================================================

const TOP_TOOLS = 10;

export interface PromptSections {
  /** Role instructions (stable, before the cache breakpoint). */
  role: string;
  /** Docs index portion of the stable block. */
  docsIndex: string;
  /** Chart-of-accounts portion of the stable block (header included). */
  chartOfAccounts: string;
  /** Entity metadata + today's date — AFTER the breakpoint, never cached. */
  volatile: string;
}

/** Structural shape of a betaZodTool as serialized on the wire. */
export interface ToolLike {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface SizeEntry {
  label: string;
  chars: number;
  tokens: number;
  cached: boolean;
}

export interface PromptBudget {
  sections: SizeEntry[];
  /** Per-tool wire size (name + description + JSON schema), sorted desc. */
  tools: Array<{ name: string; chars: number; tokens: number }>;
  toolsTotal: { chars: number; tokens: number };
  cached: { chars: number; tokens: number };
  uncached: { chars: number; tokens: number };
  total: { chars: number; tokens: number };
}

const approxTokens = (chars: number): number => Math.ceil(chars / 4);

/** The section labels the budget carries in English (--json keeps them); the table reads them back by key. */
const SECTIONS = ['role', 'docs', 'chart', 'volatile'] as const;
const english = (k: (typeof SECTIONS)[number]): string => t(`platform.prompt_size.section.${k}`, {}, 'en');
const spoken = (v: string): string => {
  const k = SECTIONS.find((s) => english(s) === v);
  return k ? t(`platform.prompt_size.section.${k}`) : v;
};

/**
 * Pure accounting over already-built blocks and tools. Tool schemas count as
 * CACHED: they serialize before the system blocks, so the cache breakpoint on
 * the stable block covers them; only the volatile block is re-billed.
 */
export function computePromptBudget(blocks: PromptSections, tools: ToolLike[]): PromptBudget {
  const sections: SizeEntry[] = [
    { label: english('role'), chars: blocks.role.length, tokens: approxTokens(blocks.role.length), cached: true },
    { label: english('docs'), chars: blocks.docsIndex.length, tokens: approxTokens(blocks.docsIndex.length), cached: true },
    { label: english('chart'), chars: blocks.chartOfAccounts.length, tokens: approxTokens(blocks.chartOfAccounts.length), cached: true },
    { label: english('volatile'), chars: blocks.volatile.length, tokens: approxTokens(blocks.volatile.length), cached: false },
  ];

  const toolSizes = tools
    .map((tool) => {
      const chars = JSON.stringify({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.input_schema ?? {},
      }).length;
      return { name: tool.name, chars, tokens: approxTokens(chars) };
    })
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));

  const toolsChars = toolSizes.reduce((sum, tool) => sum + tool.chars, 0);
  const cachedChars = sections.filter((s) => s.cached).reduce((sum, s) => sum + s.chars, 0) + toolsChars;
  const uncachedChars = sections.filter((s) => !s.cached).reduce((sum, s) => sum + s.chars, 0);

  return {
    sections,
    tools: toolSizes,
    toolsTotal: { chars: toolsChars, tokens: approxTokens(toolsChars) },
    cached: { chars: cachedChars, tokens: approxTokens(cachedChars) },
    uncached: { chars: uncachedChars, tokens: approxTokens(uncachedChars) },
    total: { chars: cachedChars + uncachedChars, tokens: approxTokens(cachedChars + uncachedChars) },
  };
}

export interface PromptSizeDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const row = (label: string, chars: number, tokens: number): string =>
  `  ${label.padEnd(34)} ${fmt(chars).padStart(9)} ch  ~${fmt(tokens).padStart(7)} tok`;

/** Renders the budget as plain lines. Pure formatting — no I/O. */
export function formatPromptBudget(budget: PromptBudget, c: PromptSizeDeps['palette']): string[] {
  const out: string[] = ['', c.bold(t('platform.prompt_size.title')), ''];
  const cached = c.dim(`  ${t('platform.prompt_size.cached')}`);
  const count = budget.tools.length;

  out.push(c.bold(t('platform.prompt_size.system_blocks')));
  for (const s of budget.sections) {
    out.push(row(spoken(s.label), s.chars, s.tokens) + (s.cached ? cached : `  ${t('platform.prompt_size.uncached')}`));
  }

  out.push('');
  out.push(c.bold(t('platform.prompt_size.tools_title', { shown: Math.min(TOP_TOOLS, count), count })));
  for (const tool of budget.tools.slice(0, TOP_TOOLS)) {
    out.push(row(tool.name, tool.chars, tool.tokens));
  }
  if (count > TOP_TOOLS) {
    out.push(c.dim(`  ${t('platform.prompt_size.more_tools', { count: count - TOP_TOOLS })}`));
  }
  out.push(row(t('platform.prompt_size.all_tools', { count }), budget.toolsTotal.chars, budget.toolsTotal.tokens) + cached);

  out.push('');
  // `Total` and `TOTAL` are the same word in both languages, so they stay fixed text.
  out.push(c.bold('Total'));
  out.push(row(t('platform.prompt_size.cached_prefix'), budget.cached.chars, budget.cached.tokens));
  out.push(row(t('platform.prompt_size.uncached_total'), budget.uncached.chars, budget.uncached.tokens));
  out.push(c.bold(row('TOTAL', budget.total.chars, budget.total.tokens)));
  out.push('');
  return out;
}

/**
 * Splits the stable system block into role / docs index / chart of accounts
 * using the docs index text as the anchor (it is embedded verbatim in the
 * role template). Falls back to attributing everything to `role` if the
 * anchor is missing — the totals stay exact either way.
 */
export function splitStableBlock(stableText: string): Pick<PromptSections, 'role' | 'docsIndex' | 'chartOfAccounts'> {
  const docs = docsIndex();
  const at = docs.length > 0 ? stableText.indexOf(docs) : -1;
  if (at === -1) {
    return { role: stableText, docsIndex: '', chartOfAccounts: '' };
  }
  return {
    role: stableText.slice(0, at),
    docsIndex: docs,
    chartOfAccounts: stableText.slice(at + docs.length),
  };
}

export function registerPromptSizeCommand(program: Command, deps: PromptSizeDeps): void {
  const promptSize = describeCommand(program.command('prompt-size').alias('tamano-prompt'), 'help.prompt_size.description');
  optionByKey(promptSize, '-e, --entity <idOrName>', 'help.prompt_size.option.entity');
  optionByKey(promptSize, '-t, --tenant <id>', 'help.prompt_size.option.tenant');
  optionByKey(promptSize, '--json', 'help.prompt_size.option.json');
  promptSize
    .action(async (opts: { entity?: string; tenant?: string; json?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        // Reads the DB (chart of accounts) but NEVER calls a model.
        const blocks = await buildSystemBlocks(ctx);
        const stable = splitStableBlock(blocks[0]?.text ?? '');
        const volatile = blocks[1]?.text ?? '';
        const tools = buildTools(ctx, { model: 'offline-inspect' }) as unknown as ToolLike[];

        const budget = computePromptBudget({ ...stable, volatile }, tools);
        if (opts.json) {
          console.log(JSON.stringify(budget, null, 2));
        } else {
          for (const line of formatPromptBudget(budget, deps.palette)) console.log(line);
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
