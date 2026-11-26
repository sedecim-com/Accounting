import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { entityScope } from '../database/scope.js';
import { t } from '../i18n/index.js';
import { proposePtuAtClose, type PtuFigures } from '../services/accruals/ptu.js';
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
  withContext,
  withOutput,
} from './kernel/index.js';

// ============================================================
// mnemosine ptu close — MNE-001-298 (#111, option (b)); its alias below
//
// The accountant types the three figures of LISR art. 9 from the annual
// computation, with their source; the leaf proposes the PTU of the year as a
// draft in period 13 (src/services/accruals/ptu.ts) and posts nothing. Every
// flag is refused here, in words, before any query.
// ============================================================

export interface PtuDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface Opts {
  entity?: string; tenant?: string; user?: string;
  format?: string; json?: boolean; fields?: string | boolean; quiet?: boolean; output?: string;
  year?: string; accumulableIncome?: string; authorizedDeductions?: string; nonDeductibleExemptPay?: string;
  source?: string; dryRun?: boolean;
}

/** DECIMAL(19,4): at most fifteen digits before the point and four after. */
const FIGURE = /^(\d{1,15})(?:\.(\d{1,4}))?$/;
const FIRST_YEAR = 2000;
const LAST_YEAR = 2200;

function figure(flag: string, value: string | undefined): string {
  const digits = FIGURE.exec(value ?? '');
  if (!digits) throw usageError({ key: 'ptu.close.figure_invalid', params: { flag, value: value ?? '' } });
  return `${digits[1].replace(/^0+(?=\d)/, '')}.${(digits[2] ?? '').padEnd(4, '0')}`;
}

/** The flags as the year and its figures, or the refusal of the first one that fails. No query. */
export function parsePtuClose(opts: Opts): { year: number; figures: PtuFigures } {
  const year = /^\d{4}$/.test(opts.year ?? '') ? Number(opts.year) : NaN;
  if (!(year >= FIRST_YEAR && year <= LAST_YEAR)) {
    throw usageError({ key: 'ptu.close.year_invalid', params: { value: opts.year ?? '', min: FIRST_YEAR, max: LAST_YEAR } });
  }
  const accumulableIncome = figure('--accumulable-income', opts.accumulableIncome);
  const authorizedDeductions = figure('--authorized-deductions', opts.authorizedDeductions);
  const nonDeductibleExemptPay = figure('--non-deductible-exempt-pay', opts.nonDeductibleExemptPay);
  const source = opts.source?.trim();
  if (!source) throw usageError({ key: 'ptu.close.source_required' });
  return { year, figures: { accumulableIncome, authorizedDeductions, nonDeductibleExemptPay, source } };
}

export function registerPtuCommand(program: Command, deps: PtuDeps): void {
  const family =
    program.commands.find((c) => c.name() === 'ptu') ?? describeCommand(program.command('ptu'), 'help.ptu.description');
  const close = describeCommand(family.command('close').alias('cerrar'), 'help.ptu.close.description');
  withContext(close);
  withOutput(close);
  optionByKey(close, '--year <yyyy>', 'help.ptu.close.option.year');
  optionByKey(close, '--accumulable-income <amount>', 'help.ptu.close.option.accumulable_income');
  optionByKey(close, '--authorized-deductions <amount>', 'help.ptu.close.option.authorized_deductions');
  optionByKey(close, '--non-deductible-exempt-pay <amount>', 'help.ptu.close.option.non_deductible_exempt_pay');
  optionByKey(close, '--source <text>', 'help.ptu.close.option.source');
  optionByKey(close, '--dry-run', 'cli.flag.dry_run');
  // The figures are the accountant's attestation, so the agent does not type them.
  declareRisk(close, { risk: 'escritura', agent: false, writes: 'journal_entries (one draft per entity and year) + journal_entry_lines' });
  close.addHelpText('after', () => `\n${t('help.ptu.close.footer')}\n`);
  close.action(async (opts: Opts, cmd: Command) => {
    try {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const { year, figures } = parsePtuClose(opts);
      // Tenant FIRST: entity resolution is bounded by it. A write never guesses the entity.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      const who = await resolveReviewer(ctx.tenantId, opts.user);
      const r = await proposePtuAtClose(entityScope(ctx.tenantId, ctx.entityId), { year, figures, userId: who.userId, dryRun });
      const c = r.calculation;
      render(
        [{
          year, outcome: r.outcome, entry_number: r.entry?.number ?? null, entry_status: r.entry?.status ?? null,
          accumulable_income: c.figures.accumulable_income, authorized_deductions: c.figures.authorized_deductions,
          non_deductible_exempt_pay: c.figures.non_deductible_exempt_pay, source: c.figures.source,
          base: c.base, rate: c.rate.value, rate_effective_from: c.rate.effective_from, ptu: c.ptu,
          provisioned: c.provisioned, adjustment: c.adjustment, provision_cap: c.provision_cap,
          findings: r.findings.map((f) => f.code),
        }],
        { ...opts, idField: 'entry_number' }
      );
      if (legible(opts)) {
        for (const f of r.findings) process.stderr.write(deps.palette.yellow(`  ${t(f.text.key, f.text.params)}\n`));
        const next = r.outcome === 'proposed' ? t('ptu.close.proposed', { entry: r.entry?.number ?? '' })
          : r.outcome === 'exists' ? t('ptu.close.exists', { year, entry: r.entry?.number ?? '', status: r.entry?.status ?? '' })
          : t(r.outcome === 'dry_run' ? 'ptu.close.dry_run' : 'ptu.close.nothing_to_propose');
        process.stderr.write(deps.palette.dim(`  ${next}\n`));
      }
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
