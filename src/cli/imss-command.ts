import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { generateSuaFile } from '../services/payroll/mx/sua-generator.js';
import { t } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
  describeCommand,
  exitCodeFor,
  legible,
  optionByKey,
  render,
  requireExplicitEntity,
  usageError,
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
// records nothing. Each successful export records a draft `sua` row in
// tax_form_filings, as the REST route does. Nothing is sent to the IMSS: a
// person loads the file into the SUA.
//
// SECURITY: the file carries the NSS, RFC and CURP of the whole roll, which
// is what the IMSS asks for. Hence agent ✗ (catalog: bulk identifiers), a
// file written with mode 0600, and no overwrite of an existing file unless
// --yes.
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

const EXAMPLES = `
Examples:
  # The July file, written where the SUA will import it from.
  mnemosine imss sua export --period 2026-07 -o SUA_2026-07.txt
  # Without -o the file goes to stdout, byte for byte, so it can be diffed.
  mnemosine imss sua export --period 2026-07 > SUA_2026-07.txt
  # What was exported, as JSON, for a script.
  mnemosine imss sua export --period 2026-07 -o SUA_2026-07.txt --json
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
  declareRisk(exp, {
    risk: 'escritura',
    agent: false,
    writes: 'tax_form_filings (one draft sua row per export) and the file named by -o; nothing is sent to the IMSS',
  });
  exp.addHelpText('after', EXAMPLES);
  exp.action(async (opts: SuaExportOpts) => {
    try {
      const { year, month } = suaMonth(opts.period);
      if (opts.output !== undefined && existsSync(opts.output) && opts.yes !== true) {
        throw usageError({ key: 'imss.sua.exists', params: { path: opts.output } });
      }
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      const r = await generateSuaFile(ctx.tenantId, ctx.entityId, year, month);

      const summary = {
        period: opts.period,
        filename: r.filename,
        employee_count: r.employee_count,
        bytes: Buffer.byteLength(r.content, 'utf8'),
        destination: opts.output ?? '(stdout)',
        findings: r.hallazgos.map((h) => h.detalle),
      };
      if (opts.output !== undefined) {
        mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        writeFileSync(opts.output, r.content, { encoding: 'utf8', mode: 0o600 });
        const { output: _file, ...toStdout } = opts;
        render([summary], { ...toStdout, idField: 'filename' });
      } else if (!legible(opts)) {
        render([{ ...summary, content: r.content }], { ...opts, idField: 'filename' });
      } else {
        // The file IS the output: raw, so `diff` compares bytes.
        process.stdout.write(r.content);
      }
      const p = deps.palette;
      for (const h of r.hallazgos) process.stderr.write(`${p.yellow('⚠')} ${h.detalle}\n`);
      process.stderr.write(`${p.dim(t('imss.sua.not_filed', { count: r.employee_count }))}\n`);
      await deps.shutdown(ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
