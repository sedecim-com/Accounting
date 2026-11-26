import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Decimal from 'decimal.js';
import type { Command } from 'commander';
import { confirmarConReintento, yesNoPrompt } from './kernel/confirmacion.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { t } from '../i18n/index.js';
import { calcularAmortizacion } from '../services/accruals/amortization-math.js';
import {
  criteriosDeAnticipo,
  medianocheLocal,
  registrarPagoAnticipado,
  revisionDeAmortizacionAlCierre,
} from '../services/accruals/prepaid-service.js';
import { runMonthlyDeferredRevenue } from '../services/accruals/amortization-run.js';
import { exigirFecha, exigirImporte, exigirOrigen, exigirPeriodo } from './prepaid-command.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  argumentByKey,
  declareRisk,
  describeCommand,
  exitCodeFor,
  gateMutation,
  optionByKey,
  render,
  requireExplicitEntity,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
} from './kernel/index.js';

// ============================================================
// mnemosine deferred-revenue, with its Spanish alias (MNE-001-299, #111)
//
// Revenue billed or collected before the service is rendered is a contract
// liability (NIF D-1), and this family gives it the calendar `prepaid` gives a
// prepaid expense: the same register (migration 347, kind deferred_revenue),
// the same arithmetic and the same run. `create` ADOPTS a credit already on
// the contract liability (its role's account, 2158), as `prepaid
// create` adopts a debit on 1160; it never posts it. `run` recognizes a
// period: DR liability / CR revenue, no IVA (caused at collection, LIVA art.
// 1o.-B).
// ============================================================

// Copyable invocations, by key: each one parses against this command tree.
const examples = (key: 'help.deferred_revenue.create.footer' | 'help.deferred_revenue.run.footer'): string => `\n${t(key)}\n`;

export interface DeferredRevenueCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Test seam: answers the confirmation of `deferred-revenue run`. */
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  json?: boolean;
  fields?: string;
}

export function registerDeferredRevenueCommand(program: Command, deps: DeferredRevenueCommandDeps): void {
  const family = describeCommand(
    program.command('deferred-revenue').alias('ingreso-diferido'),
    'help.deferred_revenue.description'
  );

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      await deps.shutdown((await fn()) ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };
  const entityForWrite = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };
  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const verdict = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        deps.palette.cyan(yesNoPrompt(question))
      );
      return verdict.si;
    } finally {
      rl.close();
    }
  };

  // ---- deferred-revenue create ------------------------------------------
  const create = describeCommand(family.command('create').alias('crear'), 'help.deferred_revenue.create.description');
  argumentByKey(create, '<description>', 'help.deferred_revenue.create.argument.description');
  withContext(create);
  withOutput(create);
  optionByKey(create, '--amount <amount>', 'help.deferred_revenue.create.option.amount');
  optionByKey(create, '--start <date>', 'help.deferred_revenue.create.option.start');
  optionByKey(create, '--end <date>', 'help.deferred_revenue.create.option.end');
  optionByKey(create, '--origin <cfdi|manual|saldo_preexistente>', 'help.deferred_revenue.create.option.origin');
  optionByKey(create, '--source-entry <id>', 'help.deferred_revenue.create.option.source_entry');
  optionByKey(create, '--reference <text>', 'help.deferred_revenue.create.option.reference');
  optionByKey(create, '--dry-run', 'help.deferred_revenue.create.option.dry_run');
  // A master-data write the agent may not make: the register is no review queue.
  declareRisk(create, {
    risk: 'escritura',
    agent: false,
    writes: 'prepaid_expenses (kind deferred_revenue, the schedule header); no journal entry — the credit is already in the ledger',
  });
  create.addHelpText('after', () => examples('help.deferred_revenue.create.footer'));
  create.action(
    (
      description: string,
      opts: CommonOpts & { amount?: string; start?: string; end?: string; origin?: string; sourceEntry?: string; reference?: string; dryRun?: boolean },
      cmd: Command
    ) =>
      run(async () => {
        const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
        const missing = [
          opts.amount ? null : '--amount',
          opts.start ? null : '--start',
          opts.end ? null : '--end',
          opts.origin ? null : '--origin',
        ].filter((f): f is string => f !== null);
        if (missing.length > 0) {
          throw usageError({ key: 'deferred_revenue.create.flags_missing', params: { flags: missing.join(', ') } });
        }
        const amount = exigirImporte('--amount', opts.amount as string);
        const start = exigirFecha('--start', opts.start as string);
        const end = exigirFecha('--end', opts.end as string);
        const origin = exigirOrigen(opts.origin);
        if (origin === 'cfdi' && opts.sourceEntry === undefined) {
          throw usageError({ key: 'deferred_revenue.create.cfdi_needs_source_entry' });
        }
        const ctx = await entityForWrite(opts);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const err = process.stderr;

        if (dryRun) {
          const criteria = await criteriosDeAnticipo(ctx.tenantId, ctx.entityId, 'deferred_revenue');
          const rows = calcularAmortizacion({
            importe: amount,
            inicio: medianocheLocal(start),
            fin: medianocheLocal(end),
            convencion: criteria.convencion,
          });
          render(
            rows.map((r) => ({
              period: r.period_number,
              month: `${r.period_start_date.getFullYear()}-${String(r.period_start_date.getMonth() + 1).padStart(2, '0')}`,
              days: r.days_covered,
              revenue: r.amortization_amount,
              liability_left: r.remaining_balance,
            })),
            { ...opts, idField: 'period', numeric: ['period', 'days', 'revenue', 'liability_left'] }
          );
          err.write(
            deps.palette.dim(
              `${t('deferred_revenue.create.dry_run_done', { count: rows.length, amount: new Decimal(amount).toFixed(2), convention: criteria.convencion })}\n`
            )
          );
          return ExitCode.OK;
        }

        const created = await registrarPagoAnticipado({
          entityId: ctx.entityId,
          kind: 'deferred_revenue',
          descripcion: description,
          importe: amount,
          inicio: start,
          fin: end,
          origen: origin,
          createdBy: reviewer.userId,
          referencia: opts.reference,
          sourceJournalEntryId: opts.sourceEntry,
        });
        render(
          [
            {
              id: created.anticipo.id,
              description: created.anticipo.description,
              total_amount: created.anticipo.total_amount,
              coverage_start: created.anticipo.coverage_start_date,
              coverage_end: created.anticipo.coverage_end_date,
              convention: created.anticipo.amortization_convention,
              periods: created.calendario.length,
              origin: created.anticipo.origin,
            },
          ],
          { ...opts, idField: 'id', numeric: ['total_amount', 'periods'] }
        );
        err.write(deps.palette.green(`✔ ${t('deferred_revenue.create.done', { count: created.calendario.length })}\n`));
        return ExitCode.OK;
      })
  );

  // ---- deferred-revenue run ---------------------------------------------
  const runLeaf = describeCommand(family.command('run').alias('ejecutar'), 'help.deferred_revenue.run.description');
  withContext(runLeaf);
  withOutput(runLeaf);
  optionByKey(runLeaf, '--period <expr>', 'help.deferred_revenue.run.option.period');
  // IRREVERSIBLE: it posts to the ledger of 041. The engine refuses a second
  // live row for the same schedule and period (059's UNIQUE, the brake read
  // with the list), so a retry posts nothing: a key would be a fourth guard.
  declareRisk(runLeaf, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries + journal_entry_lines (one adjusting entry per deferred-revenue schedule), ' +
      'prepaid_amortization_schedules, prepaid_expenses',
    llave: { innecesaria: t('deferred_revenue.run.key_unneeded') },
  });
  runLeaf.addHelpText('after', () => examples('help.deferred_revenue.run.footer'));
  runLeaf.action((opts: CommonOpts & { period?: string; dryRun?: boolean; yes?: boolean }, cmd: Command) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const period = await resolvePeriod(ctx.entityId, exigirPeriodo(opts.period));
      const review = await revisionDeAmortizacionAlCierre(ctx.entityId, period.id, 'deferred_revenue');
      const err = process.stderr;
      render(
        review.pendientes.map((p) => ({ id: p.id, description: p.description, liability_left: p.remaining_amount })),
        { ...opts, idField: 'id', numeric: ['liability_left'] }
      );
      if (review.pendientes.length === 0) {
        err.write(deps.palette.dim(`${t('deferred_revenue.run.nothing', { period: review.periodo })}\n`));
        return ExitCode.OK;
      }
      if (dryRun) {
        err.write(deps.palette.dim(`${t('deferred_revenue.run.dry_run_done', { count: review.pendientes.length, period: review.periodo })}\n`));
        return ExitCode.OK;
      }
      if (opts.yes !== true) {
        const ok = await ask(t('deferred_revenue.run.confirm', { count: review.pendientes.length, period: review.periodo }));
        if (!ok) throw abortedByUser({ key: 'deferred_revenue.run.aborted' });
      }
      const result = await runMonthlyDeferredRevenue(ctx.entityId, period.id, reviewer.userId);
      for (const e of result.errors) err.write(deps.palette.yellow(`  ⚠ ${e}\n`));
      err.write(
        deps.palette.green(
          `✔ ${t('deferred_revenue.run.done', { count: result.processed, period: review.periodo, total: result.total })}\n`
        )
      );
      return result.errors.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
    })
  );
}
