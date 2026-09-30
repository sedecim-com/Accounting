import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  SuaMismatchError,
  generateSuaFile,
  recordSuaFiling,
  type HallazgoSua,
} from '../services/payroll/mx/sua-generator.js';
import { t, type TranslationKey } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
  describeCommand,
  emit,
  exitCodeFor,
  legible,
  optionByKey,
  render,
  requireExplicitEntity,
  usageError,
  validationFailed,
  withContext,
  withOutput,
} from './kernel/index.js';
import { describeOption } from './kernel/help.js';

// ============================================================
// mnemosine imss sua export · imss sua exportar — MNE-001-070 (#306, part 4/4)
//
// The month's SUA import file, built by the SAME generator as POST
// /v1/payroll/sua (sua-generator.ts): this leaf adds no peso. The generator
// sums the approved paychecks of the month and checks the employer IMSS and
// INFONAVIT totals against employer_tax_liabilities, the figure the approval
// wrote by another road; if they differ it refuses the file (exit 4) and
// records nothing. A successful export records ONE draft `sua` filing per
// entity and month in tax_form_filings (a re-export refreshes it), and only
// after the file was written; --dry-run builds and checks and records
// nothing. Nothing is sent to the IMSS: a person loads the file into the SUA.
//
// SECURITY: the file carries the NSS, RFC and CURP of the whole roll, which
// is what the IMSS asks for. Hence agent ✗ (catalog: bulk identifiers), a
// file left with mode 0600 even when --yes overwrites an older one, no
// overwrite of an existing file unless --yes (checked by the open itself,
// not before it), and no printing of the roll to an interactive terminal.
// ============================================================

export interface ImssCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface SuaExportOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  period?: string;
  yes?: boolean;
  dryRun?: boolean;
}

/** `--period 2026-07` → year and month; the SUA is monthly, so no month 13. */
export function suaMonth(period: string | undefined): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? '');
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) {
    throw usageError({ key: 'imss.sua.period_invalid', params: { period: period ?? '' } });
  }
  return { year: Number(m[1]), month };
}

const FINDING_KEYS: Record<HallazgoSua['codigo'], TranslationKey> = {
  sin_pasivo_que_cotejar: 'imss.sua.finding.no_liability',
  el_archivo_no_cuadra_con_el_pasivo: 'imss.sua.finding.mismatch',
};

/** One finding in the session's language, from its code and figures. */
export function suaFindingText(h: HallazgoSua): string {
  return t(FINDING_KEYS[h.codigo], {
    concept: h.concepto,
    file: h.file_amount,
    ledger: h.ledger_amount ?? '',
  });
}

/** The finding as JSON: stable identifiers and figures, not prose. */
export function suaFindingRow(h: HallazgoSua): Record<string, string | boolean | null> {
  return {
    code: h.codigo,
    concept: h.concepto,
    file_amount: h.file_amount,
    ledger_amount: h.ledger_amount,
    blocking: h.bloquea,
  };
}

/**
 * Writes the SUA file. Without --yes the open itself refuses an existing
 * file ('wx'), so nothing created between a check and the write is lost; and
 * the mode is forced to 0600 afterwards, because `mode` only applies when the
 * file is created and --yes over an older 0644 file would leave the whole
 * roll world-readable.
 */
export function writeSuaFile(target: string, content: string, overwrite: boolean): void {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  try {
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: overwrite ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw usageError({ key: 'imss.sua.exists', params: { path: target } });
    }
    throw err;
  }
  chmodSync(target, 0o600);
}

/**
 * Without -o the roll's NSS, RFC and CURP would land in the terminal's
 * scrollback: to a TTY the leaf refuses and asks for a file. Pipes and
 * redirects keep the raw stdout path.
 */
export function assertSuaDestination(opts: { output?: string; dryRun?: boolean }, stdoutIsTty: boolean): void {
  if (opts.output === undefined && opts.dryRun !== true && stdoutIsTty) {
    throw usageError({ key: 'imss.sua.tty' });
  }
}

const EXAMPLES = `
Examples:
  # The July file, written where the SUA will import it from.
  mnemosine imss sua export --period 2026-07 -o SUA_2026-07.txt
  # Without -o the file goes to stdout, byte for byte, so it can be diffed.
  mnemosine imss sua export --period 2026-07 > SUA_2026-07.txt
  # What was exported, as JSON, for a script.
  mnemosine imss sua export --period 2026-07 -o SUA_2026-07.txt --json
  # Build and check the month without writing the file or recording it.
  mnemosine imss sua export --period 2026-07 --dry-run
`;

export function registerImssCommand(program: Command, deps: ImssCommandDeps): void {
  const imss = describeCommand(program.command('imss'), 'help.imss.description');
  const sua = describeCommand(imss.command('sua'), 'help.imss.sua.description');
  const exp = describeCommand(sua.command('export').alias('exportar'), 'help.imss.sua.export.description');
  withContext(exp);
  withOutput(exp);
  // `-o` names the EXPORTED file here, not the rendered output: the help says so.
  const out = exp.options.find((o) => o.long === '--output');
  if (out) describeOption(out, 'help.imss.sua.export.option.output');
  optionByKey(exp, '--period <YYYY-MM>', 'help.imss.sua.export.option.period');
  optionByKey(exp, '-y, --yes', 'help.imss.sua.export.option.yes');
  optionByKey(exp, '--dry-run', 'help.imss.sua.export.option.dry_run');
  declareRisk(exp, {
    risk: 'escritura',
    agent: false,
    writes: 'tax_form_filings (one draft sua row per entity and month, refreshed on re-export) and the file named by -o; nothing is sent to the IMSS',
  });
  exp.addHelpText('after', EXAMPLES);
  exp.action(async (opts: SuaExportOpts) => {
    try {
      const { year, month } = suaMonth(opts.period);
      assertSuaDestination(opts, process.stdout.isTTY === true);
      if (opts.output !== undefined && opts.dryRun !== true && existsSync(opts.output) && opts.yes !== true) {
        throw usageError({ key: 'imss.sua.exists', params: { path: opts.output } });
      }
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      let r: Awaited<ReturnType<typeof generateSuaFile>>;
      try {
        r = await generateSuaFile(ctx.tenantId, ctx.entityId, year, month, { record: false });
      } catch (err) {
        if (!(err instanceof SuaMismatchError)) throw err;
        throw validationFailed(
          { key: 'imss.sua.mismatch', params: { findings: err.findings.map(suaFindingText).join(' · ') } },
          { findings: err.findings.map(suaFindingRow) }
        );
      }

      const summary = {
        period: opts.period,
        filename: r.filename,
        employee_count: r.employee_count,
        bytes: Buffer.byteLength(r.content, 'utf8'),
        destination: opts.dryRun === true ? '(dry run)' : (opts.output ?? '(stdout)'),
        findings: r.hallazgos.map(suaFindingRow),
      };
      const { output: _file, ...toStdout } = opts;
      if (opts.dryRun === true) {
        render([summary], { ...toStdout, idField: 'filename' });
      } else if (opts.output !== undefined) {
        writeSuaFile(opts.output, r.content, opts.yes === true);
        render([summary], { ...toStdout, idField: 'filename' });
      } else if (!legible(opts)) {
        render([{ ...summary, content: r.content }], { ...opts, idField: 'filename' });
      } else {
        // The file IS the output: raw, so `diff` compares bytes.
        emit(r.content, opts);
      }
      // Recorded only once the file was delivered: a failed write leaves no
      // draft filing behind that no file backs.
      if (opts.dryRun !== true) await recordSuaFiling(ctx.tenantId, ctx.entityId, year, month, r.filing);
      const p = deps.palette;
      for (const h of r.hallazgos) process.stderr.write(`${p.yellow('⚠')} ${suaFindingText(h)}\n`);
      const done = opts.dryRun === true ? 'imss.sua.dry_run' : 'imss.sua.not_filed';
      process.stderr.write(`${p.dim(t(done, { count: r.employee_count }))}\n`);
      await deps.shutdown(ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
