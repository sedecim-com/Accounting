import { stdin } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { revalueForeignBalances, type RevaluationRun } from '../services/accounting/fx-revaluation.js';
import type { Palette } from './palette.js';
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
// (fx_revaluation_runs) refuses a second revaluation of the same period.
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
    difference: l.difference,
  }));
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
        'fx_revaluation_runs holds one row per period: running it again reports the revaluation already posted',
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

      // The plan first, always: a posted entry cannot be looked at before.
      const plan = await revalueForeignBalances(scope, period.id, userId, { dryRun: true });
      if (plan.alreadyRun) {
        err.write(c.dim(`${plan.periodName} was already revalued; nothing was posted again.\n`));
        return ExitCode.OK;
      }
      render(revaluationRows(plan), { ...opts, idField: 'account', numeric: ['difference'] });
      err.write(
        c.dim(
          `${plan.periodName} at ${plan.rates.map((r) => `${r.currency} ${r.tasa} (${r.fuente} ${r.fecha})`).join(', ') || 'no foreign balance'}` +
            ` · gain ${plan.gain} · loss ${plan.loss} · reversed on ${plan.reversalDate}\n`
        )
      );
      if (dryRun) {
        err.write(c.dim('Dry run: the ledger was not touched.\n'));
        return ExitCode.OK;
      }
      if (plan.gain === '0.0000' && plan.loss === '0.0000') {
        err.write(c.dim('Nothing to revalue: the ledger was not touched.\n'));
        return ExitCode.OK;
      }
      if (opts.yes !== true) {
        const yes = await ask(
          `Post the revaluation of ${plan.periodName} (gain ${plan.gain}, loss ${plan.loss}) and its mirror on ` +
            `${plan.reversalDate}? The ledger does not admit undo.`
        );
        if (!yes) {
          throw abortedByUser(
            stdin.isTTY
              ? 'Nothing was posted.'
              : 'Nothing was posted: there is no terminal to confirm on. Add -y, or --dry-run to look first.'
          );
        }
      }
      const done = await revalueForeignBalances(scope, period.id, userId);
      err.write(
        c.green(
          done.entry
            ? `✔ ${done.entry.number} on ${done.closingDate}, reversed by ${done.reversal?.number} on ${done.reversalDate}.\n`
            : `${done.periodName} was already revalued; nothing was posted again.\n`
        )
      );
      return ExitCode.OK;
    })
  );
}
