import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  generateFilingWorkpaper,
  type FilingForm,
  type FilingWorkpaper,
} from '../services/fiscal/filing-workpaper.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
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

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `--period YYYY-MM`: the filing is monthly, so no other shape is accepted. */
export function parsePeriod(expr: string | undefined): { year: number; month: number } {
  const m = PERIOD.exec((expr ?? '').trim());
  if (!m) throw usageError(`--period "${expr ?? ''}" is not a month: use YYYY-MM (for example 2026-05).`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** `--form iva|isr|all`: all by default. */
export function parseForms(expr: string | undefined): FilingForm[] {
  const v = (expr ?? 'all').trim().toLowerCase();
  if (v === 'all') return ['iva', 'isr'];
  if (v === 'iva' || v === 'isr') return [v];
  throw usageError(`--form "${expr ?? ''}" is not known: use iva, isr or all.`);
}

/** One row per line: both columns, and the pólizas it rests on by number. */
export function workpaperRows(wp: FilingWorkpaper): Row[] {
  return wp.sections.flatMap((s) => [
    ...s.lines.map((l) => ({
      form: s.form,
      line: l.key,
      cents: l.cents,
      whole: l.whole,
      source: l.source.kind === 'accounts' ? l.source.accounts.join('+') : l.source.kind,
      entries: l.source.entries.map((e) => e.entryNumber).join(' '),
    })),
    ...(s.resultCents === null
      ? [{ form: s.form, line: 'BLOCKED', cents: '', whole: '', source: s.blockedBy.join(' '), entries: '' }]
      : [{ form: s.form, line: 'result', cents: s.resultCents, whole: s.resultWhole ?? '', source: 'derived', entries: '' }]),
  ]);
}

const EXAMPLES = `
Examples:
  # The month's IVA and ISR with their two columns and the entries behind each line.
  mnemosine filing workpaper generate --period 2026-05
  # Only the IVA, the whole paper (with the entries) as JSON to a file.
  mnemosine filing workpaper generate --period 2026-05 --form iva --json -o papel-2026-05.json
  # The ISR with the PTU paid in the year and the provisional payments already made.
  mnemosine filing workpaper generate --period 2026-05 --form isr --ptu-paid 24000 --prior-provisional 15000.40
`;

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
  generate.addHelpText(
    'after',
    '\nThis computes the paper. It does NOT file anything: a person reviews it and declares in the SAT portal.\n' + EXAMPLES
  );
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
        const text = JSON.stringify(wp, null, 2) + '\n';
        if (opts.output) writeFileSync(opts.output, text);
        else process.stdout.write(text);
      } else {
        render(workpaperRows(wp), { ...opts, idField: 'line' });
      }
      for (const s of wp.sections) {
        for (const h of s.findings) {
          process.stderr.write(`${h.severidad === 'bloqueante' ? deps.palette.red('BLOCKS') : 'warning'} [${s.form}] ${h.codigo}: ${h.mensaje}\n`);
        }
      }
      process.stderr.write(deps.palette.dim('This paper is not a filing: nothing was sent to the SAT.\n'));
      await deps.shutdown(wp.sections.some((s) => s.blockedBy.length > 0) ? ExitCode.VALIDATION : ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
