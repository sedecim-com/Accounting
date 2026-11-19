import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { entityScope } from '../database/scope.js';
import { t } from '../i18n/index.js';
import { recordIncomeTaxInput } from '../services/fiscal/provisional-income-tax-inputs.js';
import { todayFor } from '../services/policy/today.js';
import { isRealCalendarDate } from '../utils/calendar-date.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  describeCommand,
  exitCodeFor,
  gateMutation,
  legible,
  optionByKey,
  render,
  requireExplicitEntity,
  usageError,
  validationFailed,
  withContext,
  withOutput,
} from './kernel/index.js';

// ============================================================
// mnemosine annual figure record · anual cifra registrar — MNE-001-457 (#622)
//
// The accountant attests a figure read off an annual return ALREADY FILED:
// today the profit coefficient, without which the provisional ISR of `filing
// workpaper generate` blocks (ISR-WP-NO-COEFFICIENT). The row keeps the return
// as its source and the user who captured it. Nothing is filed or overwritten:
// the table is append-only (migration 166), so an amendment is a new capture
// and the reader takes the latest. The pending tax losses are MNE-001-420.
//
// EVERY REFUSAL IS THE LEAF'S, IN WORDS, BEFORE ANY QUERY: exit 2 for a flag
// missing or malformed, then exit 4 for a rule of the return itself. Only the
// future-date rule waits for the entity, whose day decides what "today" is.
// `annual` is reused when another leaf already made the family.
// ============================================================

export interface AnnualFigureDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface Opts {
  entity?: string; tenant?: string; user?: string;
  format?: string; json?: boolean; fields?: string | boolean; quiet?: boolean; output?: string;
  kind?: string; value?: string; year?: string; filedOn?: string; source?: string; dryRun?: boolean;
}

/** The persisted kinds (migration 166) this leaf records; an identifier is never respelled. */
const KINDS = ['profit_coefficient'] as const;
/** DECIMAL(19,4): at most fifteen digits before the point and four after. */
const VALUE = /^(\d{1,15})(?:\.(\d{1,4}))?$/;
/** The CHECK of source_fiscal_year in migration 166. */
const FIRST_YEAR = 2000;
const LAST_YEAR = 2200;

interface Capture { kind: (typeof KINDS)[number]; value: string; year: number; filedOn: string; source: string }

/** The flags as a capture, or the refusal of the first one that fails. No query. */
export function parseAnnualFigure(opts: Opts): Capture {
  const kind = KINDS.find((k) => k === opts.kind);
  if (!kind) {
    throw usageError({ key: 'annual.figure.kind_invalid', params: { value: opts.kind ?? '', kinds: KINDS.join(', ') } });
  }
  const digits = VALUE.exec(opts.value ?? '');
  if (!digits) throw usageError({ key: 'annual.figure.value_invalid', params: { value: opts.value ?? '' } });
  // As the column returns it: no leading zeros, four decimals.
  const value = `${digits[1].replace(/^0+(?=\d)/, '')}.${(digits[2] ?? '').padEnd(4, '0')}`;
  const year = /^\d{4}$/.test(opts.year ?? '') ? Number(opts.year) : NaN;
  if (!(year >= FIRST_YEAR && year <= LAST_YEAR)) {
    throw usageError({ key: 'annual.figure.year_invalid', params: { value: opts.year ?? '', min: FIRST_YEAR, max: LAST_YEAR } });
  }
  const filedOn = opts.filedOn ?? '';
  if (!isRealCalendarDate(filedOn)) {
    throw usageError({ key: 'annual.figure.filed_on_invalid', params: { value: filedOn } });
  }
  const source = opts.source?.trim();
  if (!source) throw usageError({ key: 'annual.figure.source_required' });
  if (filedOn <= `${year}-12-31`) {
    throw validationFailed({ key: 'annual.figure.filed_on_not_after_year', params: { value: filedOn, year } });
  }
  return { kind, value, year, filedOn, source };
}

/** The usage text: what the leaf does and its examples, keyed, resolved when the help is shown. */
const helpFooter = (): string => `\n${t('help.annual.figure.record.footer')}\n`;

export function registerAnnualFigureCommand(program: Command, deps: AnnualFigureDeps): void {
  const family =
    program.commands.find((c) => c.name() === 'annual') ??
    describeCommand(program.command('annual').alias('anual'), 'help.annual.description');
  const figure = describeCommand(family.command('figure').alias('cifra'), 'help.annual.figure.description');
  const record = describeCommand(figure.command('record').alias('registrar'), 'help.annual.figure.record.description');
  withContext(record);
  withOutput(record);
  optionByKey(record, '--kind <kind>', 'help.annual.figure.record.option.kind', { params: { kinds: KINDS.join(' | ') } });
  optionByKey(record, '--value <figure>', 'help.annual.figure.record.option.value');
  optionByKey(record, '--year <yyyy>', 'help.annual.figure.record.option.year');
  optionByKey(record, '--filed-on <date>', 'help.annual.figure.record.option.filed_on');
  optionByKey(record, '--source <text>', 'help.annual.figure.record.option.source');
  optionByKey(record, '--dry-run', 'cli.flag.dry_run');
  // Not open to the agent: this table is not a review queue.
  declareRisk(record, { risk: 'escritura', agent: false, writes: 'income_tax_annual_inputs (one row per capture, append-only)' });
  record.addHelpText('after', helpFooter);
  record.action(async (opts: Opts, cmd: Command) => {
    try {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const capture = parseAnnualFigure(opts);
      // Tenant FIRST: entity resolution is bounded by it. A write never guesses the entity.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      const who = await resolveReviewer(ctx.tenantId, opts.user);
      // A return dated after today is not filed yet: the figure with no filed
      // return behind it, which #622 keeps out. The table would let it through.
      const today = await todayFor({ tenantId: ctx.tenantId, entityId: ctx.entityId });
      if (capture.filedOn > today) {
        throw validationFailed({ key: 'annual.figure.filed_on_in_future', params: { value: capture.filedOn, today } });
      }
      const saved = dryRun
        ? null
        : await recordIncomeTaxInput(entityScope(ctx.tenantId, ctx.entityId), {
            kind: capture.kind, value: capture.value, sourceFiscalYear: capture.year,
            sourceFiledOn: capture.filedOn, sourceDocument: capture.source, recordedBy: who.userId,
          });
      render(
        [{
          id: saved?.id ?? '', kind: capture.kind, value: saved?.value ?? capture.value,
          source_fiscal_year: capture.year, source_filed_on: capture.filedOn, source_document: capture.source,
          updated_through: saved?.updatedThrough ?? null, recorded_by: who.email,
          recorded_at: saved?.recordedAt ?? '', dry_run: dryRun,
        }],
        { ...opts, idField: 'id' }
      );
      if (legible(opts)) {
        process.stderr.write(deps.palette.dim(`  ${t(dryRun ? 'annual.figure.dry_run' : 'annual.figure.next')}\n`));
      }
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
