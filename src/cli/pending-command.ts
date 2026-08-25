import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { resolveEntity, type AgentContext } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { getPendingBoard, type PendingBoard } from '../ai/pending-service.js';
import {
  seedPolicies,
  listPolicies,
  listPending,
  resolvePolicy,
  dismissPolicy,
  reopenPolicy,
  type PolicyRow,
} from '../services/policy/policy-service.js';

// ============================================================
// `mnemosine pending` COMMAND
// A single question: "what do I need to do?". It joins two
// distinct things:
//   1. WORK: what awaits action (drafts, questions, notices),
//      each with the command that resolves it.
//   2. DEFINITIONS: policy decisions the system cannot make on
//      its own. While open, we operate with the declared
//      default and they stay visible here.
// ============================================================

export interface PendingCommandDeps {
  color: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  colorErr: { dim: (s: string) => string; red: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
  ask: (rl: readline.Interface, prompt: string) => Promise<string | null>;
}

type Palette = PendingCommandDeps['color'];

/**
 * Reads an option from the subcommand or, failing that, from its parent.
 * Commander v15 assigns an option declared on BOTH levels to the parent,
 * so a subcommand's own `opts` arrives empty — regardless of where the
 * user typed the flag. Reading both levels makes
 * `pending --entity X definir k v` and `pending definir k v --entity X`
 * behave the same.
 */
function optOf<T>(
  opts: Record<string, unknown>,
  command: unknown,
  key: string
): T | undefined {
  if (opts[key] !== undefined) return opts[key] as T;
  const parent = (command as { parent?: { opts?: () => Record<string, unknown> } })?.parent;
  return parent?.opts?.()[key] as T | undefined;
}


/** Pluralize: "1 thing" / "4 things". */
function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`;
}

// ─── Work board ───

/**
 * Renders the pending work. It distinguishes "there is work" from
 * "warnings only": a credential about to expire is not a task to resolve
 * today, and mixing them makes the counter ignore both.
 */
export function renderBoard(board: PendingBoard, entityName: string, c: Palette): string[] {
  const out: string[] = [];
  if (board.items.length === 0) {
    out.push(c.bold(`${entityName}: `) + 'Nothing pending. All caught up.');
    return out;
  }

  const header =
    board.totalWork > 0
      ? `${plural(board.totalWork, 'thing to resolve', 'things to resolve')}`
      : 'warnings only';
  out.push(c.bold(`${entityName}: `) + header);

  for (const item of board.items) {
    const icon = item.warning ? '⚠' : '·';
    out.push(`${icon} ${item.summary}${item.command ? c.dim(`  →  ${item.command}`) : ''}`);
    for (const ex of item.examples ?? []) {
      out.push(c.dim(`    · ${ex}`));
    }
  }
  return out;
}

// ─── Definitions agenda ───

const CATEGORY_ICON: Record<string, string> = {
  contable: '📊', fiscal: '⚖', seguridad: '🔒', operativa: '⚙', comercial: '💼',
};

/** Renders the policy decisions still to be defined. */
export function renderPolicies(
  rows: PolicyRow[],
  c: Palette,
  opts: { verbose?: boolean } = {}
): string[] {
  if (rows.length === 0) return [c.dim('No pending definitions.')];
  const out: string[] = [];
  for (const p of rows) {
    const icon = CATEGORY_ICON[p.category] ?? '·';
    const using = p.default_value
      ? c.dim(` — operating with: ${p.default_value}`)
      : c.dim(' — no default');
    out.push(`${icon} ${c.bold(p.key)}${using}`);
    out.push(`   ${p.question}`);
    if (opts.verbose) {
      out.push(c.dim(`   impact: ${p.impact}`));
      if (p.default_rationale) out.push(c.dim(`   why that default: ${p.default_rationale}`));
      for (const o of p.options) out.push(c.dim(`     · ${o.value} — ${o.label}`));
    }
  }
  return out;
}

/** Full view: work + definitions. Shared with the chat. */
export async function renderAll(
  ctx: AgentContext,
  c: Palette,
  opts: { verbose?: boolean } = {}
): Promise<string[]> {
  const out: string[] = [];
  const [board] = await Promise.all([getPendingBoard(ctx), seedPolicies({ tenantId: ctx.tenantId })]);
  const policies = await listPending({ tenantId: ctx.tenantId });

  out.push(...renderBoard(board, ctx.entityName, c));

  if (policies.length > 0) {
    out.push('');
    out.push(c.bold(`To define (${policies.length})`) + c.dim(' — operating with defaults meanwhile'));
    out.push(...renderPolicies(policies, c, opts));
    out.push(c.dim('  →  mnemosine pending define <key> <value>'));
  }
  return out;
}

export function registerPendingCommands(program: Command, deps: PendingCommandDeps): void {
  const { color: c, colorErr: ce, shutdown, reportError, ask } = deps;

  const cmd = program
    .command('pending')
    .alias('pendientes')
    .description('What you need to do: work to resolve and policy decisions to define')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-v, --verbose', 'Show impact, options and rationale of each default')
    .option('-a, --all', 'Include definitions already resolved and dismissed')
    .action(async (opts: { entity?: string; verbose?: boolean; all?: boolean }) => {
      try {
        const ctx = await resolveEntity(opts.entity);
        console.log('');
        for (const line of await renderAll(ctx, c, { verbose: opts.verbose })) {
          console.log(line);
        }

        if (opts.all) {
          const closed = (await listPolicies({ tenantId: ctx.tenantId })).filter(
            (r) => r.status !== 'pending'
          );
          if (closed.length > 0) {
            console.log(c.bold('\nAlready defined'));
            for (const p of closed) {
              const icon = p.status === 'resolved' ? '✔' : '✘';
              const date = p.resolved_at ? new Date(p.resolved_at).toISOString().split('T')[0] : '';
              console.log(
                `${icon} ${c.bold(p.key)} = ${p.resolved_value ?? '(dismissed)'}` +
                  c.dim(` · ${p.resolved_by ?? ''} · ${date}`)
              );
              if (p.resolution_notes) console.log(c.dim(`   ${p.resolution_notes}`));
            }
          }
        }
        console.log('');
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(1);
      }
    });

  cmd
    .command('define')
    .aliases(['definir'])
    .description('Defines a pending decision (the value takes effect immediately)')
    .argument('<key>', 'Decision key (see: mnemosine pending)')
    .argument('[value]', 'Chosen value; if omitted, asked interactively')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-u, --user <email>', 'Who defines it')
    .option('-n, --note <text>', 'Note or rationale')
    .action(async (key: string, value: string | undefined, opts: { entity?: string; user?: string; note?: string }, command: unknown) => {
      let rl: readline.Interface | undefined;
      try {
        const ctx = await resolveEntity(optOf<string>(opts, command, 'entity'));
        const reviewer = await resolveReviewer(ctx.tenantId, optOf<string>(opts, command, 'user'));
        await seedPolicies({ tenantId: ctx.tenantId });

        const pending = await listPending({ tenantId: ctx.tenantId });
        const p = pending.find((x) => x.key === key);
        if (!p) {
          console.error(ce.red(`\nThere is no pending decision with key "${key}".`));
          console.error(c.dim('List the open ones with: mnemosine pending'));
          await shutdown(1);
        }

        let chosen = value;
        if (!chosen) {
          console.log(`\n${c.bold(p!.question)}`);
          console.log(c.dim(`impact: ${p!.impact}`));
          p!.options.forEach((o, i) => console.log(`  ${i + 1}) ${o.value} — ${o.label}`));
          console.log(c.dim('  (number, free-form value, or empty to cancel)'));
          rl = readline.createInterface({ input: stdin, output: stdout });
          const raw = await ask(rl, c.cyan('value> '));
          rl.close();
          const answer = (raw ?? '').trim();
          if (!answer) {
            console.log(c.dim('Cancelled; still pending.'));
            await shutdown(0);
          }
          const idx = Number(answer);
          chosen =
            Number.isInteger(idx) && idx >= 1 && idx <= p!.options.length
              ? p!.options[idx - 1].value
              : answer;
        }

        await resolvePolicy({ tenantId: ctx.tenantId }, key, chosen!, reviewer.email, optOf<string>(opts, command, 'note'));
        const remaining = (await listPending({ tenantId: ctx.tenantId })).length;
        console.log(`✔ ${c.bold(key)} = ${chosen}`);
        console.log(c.dim(`${plural(remaining, 'definition', 'definitions')} still pending.`));
        await shutdown(0);
      } catch (err) {
        rl?.close();
        reportError(err);
        await shutdown(1);
      }
    });

  cmd
    .command('dismiss')
    .aliases(['descartar'])
    .description('Marks a definition as not applicable (leaves the agenda)')
    .argument('<key>')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-u, --user <email>', 'Who dismisses it')
    .option('-n, --note <text>', 'Why it does not apply')
    .action(async (key: string, opts: { entity?: string; user?: string; note?: string }, command: unknown) => {
      try {
        const ctx = await resolveEntity(optOf<string>(opts, command, 'entity'));
        const reviewer = await resolveReviewer(ctx.tenantId, optOf<string>(opts, command, 'user'));
        await dismissPolicy({ tenantId: ctx.tenantId }, key, reviewer.email, optOf<string>(opts, command, 'note'));
        console.log(`✘ ${key} dismissed.`);
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(1);
      }
    });

  cmd
    .command('reopen')
    .aliases(['reabrir'])
    .description('Reopens an already resolved definition (the policy changed)')
    .argument('<key>')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .action(async (key: string, opts: { entity?: string }, command: unknown) => {
      try {
        const ctx = await resolveEntity(optOf<string>(opts, command, 'entity'));
        await reopenPolicy({ tenantId: ctx.tenantId }, key);
        console.log(`↻ ${key} is pending again.`);
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(1);
      }
    });
}

/** Singular alias: another module of the project imports this name. */
export const registerPendingCommand = registerPendingCommands;
