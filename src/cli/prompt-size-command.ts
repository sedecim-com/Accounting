import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { buildSystemBlocks } from '../ai/system-prompt.js';
import { buildTools } from '../ai/tools/index.js';
import { docsIndex } from '../ai/tools/docs-tools.js';

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

/**
 * Pure accounting over already-built blocks and tools. Tool schemas count as
 * CACHED: they serialize before the system blocks, so the cache breakpoint on
 * the stable block covers them; only the volatile block is re-billed.
 */
export function computePromptBudget(blocks: PromptSections, tools: ToolLike[]): PromptBudget {
  const sections: SizeEntry[] = [
    { label: 'role instructions (stable)', chars: blocks.role.length, tokens: approxTokens(blocks.role.length), cached: true },
    { label: 'docs index (stable)', chars: blocks.docsIndex.length, tokens: approxTokens(blocks.docsIndex.length), cached: true },
    { label: 'chart of accounts (stable)', chars: blocks.chartOfAccounts.length, tokens: approxTokens(blocks.chartOfAccounts.length), cached: true },
    { label: 'volatile block (entity + date)', chars: blocks.volatile.length, tokens: approxTokens(blocks.volatile.length), cached: false },
  ];

  const toolSizes = tools
    .map((t) => {
      const chars = JSON.stringify({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.input_schema ?? {},
      }).length;
      return { name: t.name, chars, tokens: approxTokens(chars) };
    })
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));

  const toolsChars = toolSizes.reduce((sum, t) => sum + t.chars, 0);
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
  const out: string[] = ['', c.bold('Prompt budget (offline estimate, ~4 chars/token)'), ''];

  out.push(c.bold('System blocks'));
  for (const s of budget.sections) {
    out.push(row(s.label, s.chars, s.tokens) + (s.cached ? c.dim('  [cached]') : '  [uncached]'));
  }

  out.push('');
  out.push(c.bold(`Tool schemas (top ${Math.min(TOP_TOOLS, budget.tools.length)} of ${budget.tools.length}, largest first)`));
  for (const t of budget.tools.slice(0, TOP_TOOLS)) {
    out.push(row(t.name, t.chars, t.tokens));
  }
  if (budget.tools.length > TOP_TOOLS) {
    out.push(c.dim(`  … ${budget.tools.length - TOP_TOOLS} more tools`));
  }
  out.push(row(`all tools (${budget.tools.length})`, budget.toolsTotal.chars, budget.toolsTotal.tokens) + c.dim('  [cached]'));

  out.push('');
  out.push(c.bold('Total'));
  out.push(row('cached prefix (tools + stable)', budget.cached.chars, budget.cached.tokens));
  out.push(row('uncached (volatile)', budget.uncached.chars, budget.uncached.tokens));
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
  program
    .command('prompt-size')
    .alias('tamano-prompt')
    .description('Offline breakdown of the system prompt and tool schemas (no API calls)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--json', 'JSON output')
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
        await deps.shutdown(1);
      }
    });
}
