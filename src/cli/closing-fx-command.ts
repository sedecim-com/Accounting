import { stdin } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { revalueForeignBalances, type RevaluationRun } from '../services/accounting/fx-revaluation.js';
import type { Palette } from './palette.js';
import { t } from '../i18n/index.js';
import {
  abortedByUser,
  argumentByKey,
  declareRisk,
  describeCommand,
  gateMutation,
  render,
  requireExplicitEntity,
  withContext,
  withOutput,
  ExitCode,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine closing fx revalue · cierre-proceso cambio revaluar (#305)
//
// The closing revaluation of foreign balances (NIF B-15), over
// `revalueForeignBalances`. IRREVERSIBLE and human-only: it posts an adjusting
// entry and its day-1 mirror to the ledger of migration 041. --dry-run
// computes everything the post needs (the rate, the next open period) and
// writes nothing. The idempotency key is unnecessary: the run's own marker
// (fx_revaluation_runs) subtracts what earlier runs of the period posted, so
// running it again posts only what moved since, or nothing.
//
// STDOUT carries one document: the plan on a dry run, the posted lines (with
// the entry and its mirror) on a live one. The plan a live run asks about goes
// to stderr, and the gain and loss confirmed travel into the post, which
// refuses (FX_REVALUATION_PLAN_CHANGED) if its recomputation differs.
// ============================================================

interface Opts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const EXAMPLES = `
Examples:
  # What August's revaluation would post, at the rate of August 31st, writing nothing.
  mnemosine closing fx revalue 2026-08 --dry-run
  # Post it: one adjusting entry on August 31st and its mirror on September 1st.
  mnemosine closing fx revalue 2026-08 --yes
`;

export function revaluationRows(run: RevaluationRun): Row[] {
  return run.lines.map((l) => ({
    account: l.accountCode,
    currency: l.currency,
    foreign_balance: l.foreignBalance,
    book_balance: l.bookBalance,
    rate: l.rate,
    revalued_balance: l.revaluedBalance,
    already_posted: l.alreadyPosted,
    difference: l.difference,
  }));
}

/** The posted lines, each carrying the entry and the mirror that hold it. */
export function postedRows(run: RevaluationRun): Row[] {
  return revaluationRows(run)
    .filter((r) => Number(r.difference) !== 0)
    .map((r) => ({
      ...r,
      sequence: run.sequence,
      entry_number: run.entry?.number ?? null,
      entry_id: run.entry?.id ?? null,
      reversal_number: run.reversal?.number ?? null,
      reversal_id: run.reversal?.id ?? null,
    }));
}

function summary(run: RevaluationRun): string {
  const rates =
    run.rates.map((r) => `${r.currency} ${r.tasa} (${r.fuente} ${r.fecha})`).join(', ') ||
    t('closing.fx.revalue.no_foreign_balance');
  return t('closing.fx.revalue.summary', {
    period: run.periodName,
    rates,
    gain: run.gain,
    loss: run.loss,
    reversalDate: run.reversalDate ?? '',
  });
}

export function registerClosingFx(
  closing: Command,
  deps: { palette: Palette; home?: string },
  run: (fn: () => Promise<ExitCodeValue | void>) => Promise<void>,
  ask: (question: string) => Promise<boolean>
): void {
  const fx = describeCommand(closing.command('fx').alias('cambio'), 'help.closing.fx.description');
  const revalue = describeCommand(fx.command('revalue').alias('revaluar'), 'help.closing.fx.revalue.description');
  argumentByKey(revalue, '<period>', 'help.closing.fx.revalue.argument.period');
  withContext(revalue);
  withOutput(revalue);
  declareRisk(revalue, {
    risk: 'irreversible',
    agent: false,
    writes: 'journal_entries + journal_entry_lines (the adjusting entry and its day-1 mirror), fx_revaluation_runs',
    llave: {
      innecesaria:
        'fx_revaluation_runs subtracts what earlier runs of the period posted: running it again posts only what moved since, or nothing',
    },
  });
  revalue.addHelpText('after', EXAMPLES);
  revalue.action((periodArg: string, opts: Opts) =>
    run(async () => {
      const { dryRun } = gateMutation(revalue, opts as unknown as Record<string, unknown>);
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      const period = await resolvePeriod(ctx.entityId, periodArg);
      const userId = (await resolveReviewer(ctx.tenantId, opts.user)).userId;
      const scope = { tenantId: ctx.tenantId, entityId: ctx.entityId };
      const c = deps.palette;
      const err = process.stderr;
      const table = { idField: 'account', numeric: ['difference'] };

      // The plan first, always: a posted entry cannot be looked at before.
      const plan = await revalueForeignBalances(scope, period.id, userId, { dryRun: true });
      if (plan.alreadyRun) {
        err.write(
          c.dim(`${t('closing.fx.revalue.already_run', { period: plan.periodName, sequence: plan.alreadyRun.sequence })}\n`)
        );
        return ExitCode.OK;
      }
      const nothing = plan.gain === '0.0000' && plan.loss === '0.0000';
      if (dryRun || nothing) {
        render(revaluationRows(plan), { ...opts, ...table });
        err.write(c.dim(`${summary(plan)}\n`));
        if (plan.sequence !== null && plan.sequence > 1) {
          err.write(c.dim(`${t('closing.fx.revalue.supplement', { sequence: plan.sequence })}\n`));
        }
        err.write(c.dim(`${t(dryRun ? 'closing.fx.revalue.dry_run' : 'closing.fx.revalue.nothing')}\n`));
        return ExitCode.OK;
      }
      if (opts.yes !== true) {
        // The plan the question is about, on stderr: stdout keeps one document.
        render(revaluationRows(plan), { ...table, stdout: err });
        err.write(c.dim(`${summary(plan)}\n`));
        if (plan.sequence !== null && plan.sequence > 1) {
          err.write(c.dim(`${t('closing.fx.revalue.supplement', { sequence: plan.sequence })}\n`));
        }
        const yes = await ask(
          t('closing.fx.revalue.confirm', {
            period: plan.periodName,
            gain: plan.gain,
            loss: plan.loss,
            reversalDate: plan.reversalDate ?? '',
          })
        );
        if (!yes) {
          throw abortedByUser({
            key: stdin.isTTY ? 'closing.fx.revalue.aborted' : 'closing.fx.revalue.aborted_no_tty',
          });
        }
      }
      const done = await revalueForeignBalances(scope, period.id, userId, {
        expect: { gain: plan.gain, loss: plan.loss },
      });
      if (!done.entry) {
        // Another run posted the same revaluation between the plan and now.
        err.write(c.dim(`${t('closing.fx.revalue.already_run', { period: done.periodName, sequence: done.alreadyRun?.sequence ?? 1 })}\n`));
        return ExitCode.OK;
      }
      render(postedRows(done), { ...opts, ...table });
      err.write(
        c.green(
          `${t('closing.fx.revalue.posted', {
            entry: done.entry.number,
            closingDate: done.closingDate,
            reversal: done.reversal?.number ?? '',
            reversalDate: done.reversalDate ?? '',
          })}\n`
        )
      );
      return ExitCode.OK;
    })
  );
}
