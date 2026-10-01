import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { t } from '../i18n/index.js';
import {
  generateFilingWorkpaper,
  type FilingForm,
  type FilingWorkpaper,
} from '../services/fiscal/filing-workpaper.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
  emit,
  describeCommand,
  optionByKey,
  exitCodeFor,
  render,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine filing workpaper generate · declaracion papel-trabajo generar
//
// The month's workpaper (#308, MNE-001-060): the definitive IVA and the
// provisional ISR of a persona moral, each line in two columns (`cents`, the
// ledger traceable; `whole`, the pesos to capture) with the pólizas behind it.
//
// READ ONLY, AND NOTHING IS FILED: the command computes a paper a person
// reviews and declares in the SAT portal. It writes no row; `-o` writes a
// local file.
//
// `filing` is shared with the other filing leaves: the family is reused when
// it already exists, so this file does not own it.
// ============================================================

export interface FilingWorkpaperDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface Opts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  period?: string;
  form?: string;
  ptuPaid?: string;
  priorProvisional?: string;
}

/** Entries a table cell lists before it says how many more there are. */
const ENTRIES_IN_A_CELL = 8;

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `--period YYYY-MM`: the filing is monthly, so no other shape is accepted. */
export function parsePeriod(expr: string | undefined): { year: number; month: number } {
  const m = PERIOD.exec((expr ?? '').trim());
  if (!m) throw usageError({ key: 'filing.workpaper.period_invalid', params: { value: expr ?? '' } });
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** `--form iva|isr|all`: all by default. */
export function parseForms(expr: string | undefined): FilingForm[] {
  const v = (expr ?? 'all').trim().toLowerCase();
  if (v === 'all') return ['iva', 'isr'];
  if (v === 'iva' || v === 'isr') return [v];
  throw usageError({ key: 'filing.workpaper.form_invalid', params: { value: expr ?? '' } });
}

/** Entry numbers of a cell, capped in the TABLE only: `--json` keeps every entry. */
function entriesCell(numbers: string[], cap: number | undefined): string {
  if (cap === undefined || numbers.length <= cap) return numbers.join(' ');
  return `${numbers.slice(0, cap).join(' ')} ${t('filing.workpaper.more_entries', { count: numbers.length - cap })}`;
}

/**
 * One row per line: both columns, and the pólizas it rests on by number. The
 * `line` column is `<form>.<key>` and is unique across forms, so `--quiet`
 * prints an id that names one line (a bare key repeats across the two forms).
 */
export function workpaperRows(wp: FilingWorkpaper, cap?: number): Row[] {
  return wp.sections.flatMap((s) => [
    ...s.lines.map((l) => ({
      line: `${s.form}.${l.key}`,
      cents: l.cents,
      whole: l.whole,
      source:
        l.source.kind === 'accounts' ? l.source.accounts.join('+')
        : l.source.kind === 'documents' ? `documents(${l.source.accounts.join('+')})`
        : l.source.ref ? `${l.source.kind}:${l.source.ref}` : l.source.kind,
      entries: entriesCell(l.source.entries.map((e) => e.entryNumber), cap),
    })),
    ...(s.resultCents === null
      ? [{ line: `${s.form}.blocked`, cents: '', whole: '', source: s.blockedBy.join(' '), entries: '' }]
      : [{ line: `${s.form}.result`, cents: s.resultCents, whole: s.resultWhole ?? '', source: 'derived', entries: '' }]),
  ]);
}

/** The usage text: the intro and the examples, keyed, resolved when the help is shown. */
const helpFooter = (): string => `\n${t('help.filing.workpaper.generate.footer')}\n`;

export function registerFilingWorkpaperCommand(program: Command, deps: FilingWorkpaperDeps): void {
  const family =
    program.commands.find((c) => c.name() === 'filing') ??
    describeCommand(program.command('filing').alias('declaracion'), 'help.filing.description');
  const workpaper = describeCommand(
    family.command('workpaper').alias('papel-trabajo'),
    'help.filing.workpaper.description'
  );
  const generate = describeCommand(
    workpaper.command('generate').alias('generar'),
    'help.filing.workpaper.generate.description'
  );
  withContext(generate);
  withOutput(generate);
  optionByKey(generate, '--period <YYYY-MM>', 'help.filing.workpaper.generate.option.period');
  optionByKey(generate, '--form <iva|isr|all>', 'help.filing.workpaper.generate.option.form', { defaultValue: 'all' });
  optionByKey(generate, '--ptu-paid <amount>', 'help.filing.workpaper.generate.option.ptu_paid');
  optionByKey(generate, '--prior-provisional <amount>', 'help.filing.workpaper.generate.option.prior_provisional');
  declareRisk(generate, { risk: 'lectura', agent: true });
  generate.addHelpText('after', helpFooter);
  generate.action(async (opts: Opts) => {
    try {
      const { year, month } = parsePeriod(opts.period);
      const forms = parseForms(opts.form);
      bootstrapTenant(opts.tenant);
      const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
      const wp = await generateFilingWorkpaper({
        tenantId: ctx.tenantId, entityId: ctx.entityId, year, month, forms,
        ptuPaidInYear: opts.ptuPaid, priorProvisionalPayments: opts.priorProvisional,
      });
      if (opts.json || opts.format === 'json') {
        emit(JSON.stringify(wp, null, 2) + '\n', opts);
      } else {
        const tableCell = (opts.format ?? 'table') === 'table' && !opts.quiet;
        render(workpaperRows(wp, tableCell ? ENTRIES_IN_A_CELL : undefined), { ...opts, idField: 'line' });
      }
      for (const s of wp.sections) {
        for (const h of s.findings) {
          process.stderr.write(`${h.severidad === 'bloqueante' ? deps.palette.red(t('filing.workpaper.label_blocks')) : t('filing.workpaper.label_warning')} [${s.form}] ${h.codigo}: ${h.mensaje}\n`);
        }
      }
      process.stderr.write(deps.palette.dim(`${t('filing.workpaper.not_a_filing')}\n`));
      await deps.shutdown(wp.sections.some((s) => s.blockedBy.length > 0) ? ExitCode.VALIDATION : ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
