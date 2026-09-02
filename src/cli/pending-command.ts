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
import { getPolicySpec } from '../services/policy/pending-catalog.js';
import { previewFor } from '../services/policy/policy-preview.js';
import { exitCodeFor, notFound } from './kernel/index.js';

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

const WRAP_WIDTH = 72;

/**
 * Wraps `text` to WRAP_WIDTH columns: `head` opens the first line, `hang`
 * carries every continuation. Returns RAW strings — the caller paints them,
 * because not every wrapped line on these screens is dim (the question is
 * not) and a wrapper that also chose the color could only serve one of them.
 *
 * This is the core `field` used to be. It was extracted the day the same
 * screen turned out to print THREE long things unwrapped, not one.
 */
function wrapLines(head: string, hang: string, text: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && `${current} ${word}`.length > WRAP_WIDTH) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.map((l, i) => (i === 0 ? head : hang) + l);
}

/**
 * A labelled paragraph, wrapped with a hanging indent under its label.
 *
 * The catalog's prose runs to whole paragraphs — `whyAsking` for
 * `catalogo_entidad_no_mexicana` is four hundred characters — and a
 * four-hundred-character line reflowed by the terminal restarts at column
 * zero, which loses the indentation that says "this belongs to that key".
 * The wizard already wraps for the same reason (`wrap` in
 * `cli/init/s4-policies.ts`); this is the second copy, and it applies to
 * EVERY long field on BOTH screens that show a decision — the `pending -v`
 * listing and the `pending define <key>` prompt.
 *
 * That last clause used to be a lie this comment told. It claimed `impact`
 * was covered while the `define` prompt printed it raw, and "every long
 * field" while the QUESTION and the OPTION LABELS — the two lines the
 * accountant actually reads to decide — were never wrapped at all.
 * Measured against the catalog, none of the three is a corner case:
 *   · impact:   21 of 21 over WRAP_WIDTH, longest 406
 *   · question: 13 of 21 over WRAP_WIDTH, longest 98
 *   · options:  19 of 55 over the usable width, longest 97
 *
 * One declared exception, and it is not laziness: the `preview` lines
 * arrive from `policy-preview.ts` ALREADY laid out — bullets and aligned
 * amounts — and re-flowing them would destroy the alignment that makes
 * them readable. They are composed short for exactly that reason.
 */
function field(label: string, text: string, c: Palette, indent = '   '): string[] {
  const head = `${indent}${label}: `;
  return wrapLines(head, ' '.repeat(head.length), text).map((l) => c.dim(l));
}

/**
 * The explanatory layer of ONE decision: why the system is asking, what it
 * will do with the answer, what skipping actually costs, and what the
 * question looks like against this company's OWN data.
 *
 * The catalog has carried those three fields (`whyAsking`, `whatIDo`,
 * `ifSkipped`) and `previewFor` has existed all along, and both were spent
 * in a single place — `init`, on day one, when `xml_documents` is empty and
 * every preview degrades to silence by design. They belong wherever someone
 * is actually deciding, which is `pending -v` and the `pending define`
 * prompt; hence one function used by both instead of a second copy that
 * drifts.
 *
 * `preview` arrives already resolved: see `renderPolicies`.
 */
export function renderExplanation(
  key: string,
  c: Palette,
  preview: string[] = [],
  indent = '   '
): string[] {
  const spec = getPolicySpec(key);
  const out: string[] = [];
  if (spec?.whyAsking) out.push(...field('why I ask', spec.whyAsking, c, indent));
  if (spec?.whatIDo) out.push(...field('what I do', spec.whatIDo, c, indent));
  if (spec?.ifSkipped) out.push(...field('if you skip it', spec.ifSkipped, c, indent));
  // Silence, not a placeholder: with no history there is nothing useful to
  // say, and `policy-preview.ts` returns [] rather than invent an example.
  if (preview.length > 0) {
    out.push(c.dim(`${indent}in your data:`));
    for (const line of preview) out.push(c.dim(`${indent}  ${line}`));
  }
  return out;
}

/**
 * Renders the policy decisions still to be defined.
 *
 * `previews` arrives ALREADY RESOLVED rather than being fetched here, and
 * the function stays synchronous. Each preview is a database query; making
 * this formatter async would bury a round-trip inside a pure string
 * builder, force every caller to await it, and serialize what `renderAll`
 * can fire in parallel. Keeping it out also means the explanatory layer is
 * testable without a database.
 *
 * A key absent from `previews`, or present with no lines, prints NOTHING —
 * no header, no placeholder. That is `policy-preview.ts`'s own rule: with
 * no history there is nothing useful to say, and an invented example is
 * worse than silence.
 */
export function renderPolicies(
  rows: PolicyRow[],
  c: Palette,
  opts: { verbose?: boolean; previews?: Record<string, string[]> } = {}
): string[] {
  if (rows.length === 0) return [c.dim('No pending definitions.')];
  const out: string[] = [];
  for (const p of rows) {
    const icon = CATEGORY_ICON[p.category] ?? '·';
    const using = p.default_value
      ? c.dim(` — operating with: ${p.default_value}`)
      : c.dim(' — no default');
    out.push(`${icon} ${c.bold(p.key)}${using}`);
    // The header line above is deliberately NOT wrapped: key plus default
    // value reaches 60 characters on the longest policy in the catalog.
    out.push(...wrapLines('   ', '   ', p.question));
    if (opts.verbose) {
      // The explanatory wording lives in the CATALOG, not in the row: the
      // database keeps the STATE, and a text copied at seed time goes stale
      // the moment the catalog is reworded. Same rule as the wizard.
      out.push(...field('impact', p.impact, c));
      out.push(...renderExplanation(p.key, c, opts.previews?.[p.key] ?? []));
      if (p.default_rationale) out.push(...field('why that default', p.default_rationale, c));
      // Continuations hang at a FIXED indent, not under the value: values
      // run to 22 characters, and hanging under them would push the line
      // back out of the column we just defended.
      for (const o of p.options) {
        out.push(...wrapLines('     · ', '       ', `${o.value} — ${o.label}`).map((l) => c.dim(l)));
      }
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
    // Only verbose asks for previews: each one is a query against this
    // entity's own history, and the short listing shows none of them.
    let previews: Record<string, string[]> | undefined;
    if (opts.verbose) {
      const resolved = await Promise.all(
        policies.map(
          async (p) =>
            [
              p.key,
              await previewFor(p.key, {
                entityId: ctx.entityId,
                tenantId: ctx.tenantId,
                currency: ctx.currency,
              }),
            ] as const
        )
      );
      previews = Object.fromEntries(resolved);
    }

    out.push('');
    out.push(c.bold(`To define (${policies.length})`) + c.dim(' — operating with defaults meanwhile'));
    out.push(...renderPolicies(policies, c, { ...opts, previews }));
    out.push(c.dim('  →  mnemosine pending define <key> <value>'));
  }
  return out;
}

export function registerPendingCommands(program: Command, deps: PendingCommandDeps): void {
  // `colorErr` stays in the deps shape (mnemosine passes it to every
  // registrar) but has no reader here any more: the one stderr line it
  // painted is now a CliError, and `reportError` owns that ink.
  const { color: c, shutdown, reportError, ask } = deps;

  const cmd = program
    .command('pending')
    .alias('pendientes')
    .description('What you need to do: work to resolve and policy decisions to define')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-v, --verbose', 'Explain each decision: why I ask, what I do, what skipping costs, and what your own data says')
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
        await shutdown(exitCodeFor(err));
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
          // A key that does not exist is NOT_FOUND (3) by the exit-code
          // contract, and the remedy travels inside the message because
          // `reportError` prints a CliError already redacted. Throwing also
          // narrows `p` for the rest of the block, which is what the `p!`
          // assertions below were paying for.
          throw notFound(
            `There is no pending decision with key "${key}". ` +
              'List the open ones with: mnemosine pending'
          );
        }

        let chosen = value;
        if (!chosen) {
          console.log('');
          for (const l of wrapLines('', '', p.question)) console.log(c.bold(l));
          for (const l of field('impact', p.impact, c, '')) console.log(l);
          // The moment of the decision deserves the same explanation the
          // listing gives — and the preview against this entity's own data,
          // which is the whole reason `previewFor` exists.
          const preview = await previewFor(key, {
            entityId: ctx.entityId,
            tenantId: ctx.tenantId,
            currency: ctx.currency,
          });
          for (const l of renderExplanation(key, c, preview, '')) console.log(l);
          p.options.forEach((o, i) => {
            const head = `  ${i + 1}) `;
            for (const l of wrapLines(head, ' '.repeat(head.length), `${o.value} — ${o.label}`)) {
              console.log(l);
            }
          });
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
            Number.isInteger(idx) && idx >= 1 && idx <= p.options.length
              ? p.options[idx - 1].value
              : answer;
        }

        await resolvePolicy({ tenantId: ctx.tenantId }, key, chosen, reviewer.email, optOf<string>(opts, command, 'note'));
        const remaining = (await listPending({ tenantId: ctx.tenantId })).length;
        console.log(`✔ ${c.bold(key)} = ${chosen}`);
        console.log(c.dim(`${plural(remaining, 'definition', 'definitions')} still pending.`));
        await shutdown(0);
      } catch (err) {
        rl?.close();
        reportError(err);
        await shutdown(exitCodeFor(err));
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
        await shutdown(exitCodeFor(err));
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
        await shutdown(exitCodeFor(err));
      }
    });
}

/** Singular alias: another module of the project imports this name. */
export const registerPendingCommand = registerPendingCommands;
