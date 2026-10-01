import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  importSatChart,
  renderSatChartImportReport,
} from '../services/accounting/sat-chart-import.js';
import {
  checkOpeningBalance,
  importOpeningBalance,
  renderOpeningBalanceReport,
  type OpeningDocument,
} from '../services/accounting/opening-balance.js';
import { renderBalanceComparison } from '../services/accounting/opening-balance-check.js';
import { t } from '../i18n/index.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  declareRisk,
  exitCodeFor,
  gateMutation,
  describeCommand,
  optionByKey,
  requireExplicitEntity,
  resolveActiveEntity,
  legible,
  render,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// MIGRATING FROM THE ANEXO 24 (MNE-001-018 · #220): the terminal door to the
// two O1 layers (`importSatChart`, `importOpeningBalance`) and to the penny
// check, which until now only the plan's criterion could call.
//
// The owner decided (2026-09-26, option b) that the opening load POSTS:
// `irreversible`, agent closed, `--dry-run` first and `--yes` to apply. Under
// `apertura_modo_de_carga = borrador` (MNE-001-099) the same leaf leaves a
// draft instead: the service reads the key, this file only words the question.
// The preview is the SAME service call with `dryRun: true`: nothing here
// re-derives what would be written.
// ============================================================

const EXAMPLES = {
  chartImport: `
Examples:
  # See what would be created, writing nothing.
  mnemosine chart import ./migration/catalogo.xml --entity "Sintetica SA" --dry-run
  mnemosine chart import ./migration/catalogo.xml --entity "Sintetica SA" --yes
`,
  openingImport: `
Examples:
  # ALWAYS this one first: the opening is posted and the ledger cannot be undone.
  mnemosine opening-balance import ./migration/balanza-2025-12.xml --subledger ./migration/open-docs.json --dry-run
  mnemosine opening-balance import ./migration/balanza-2025-12.xml --subledger ./migration/open-docs.json --yes
`,
  openingCheck: `
Examples:
  # Exits 0 when the ledger equals the source to the peso, 4 when it does not.
  mnemosine opening-balance check ./migration/balanza-2025-12.xml
`,
};

export interface Anexo24MigrationDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Test seam: answers the confirmation. */
  confirm?: (question: string) => Promise<boolean>;
}

interface Opts {
  entity?: string;
  tenant?: string;
  user?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  format?: string;
  reason?: string;
  partial?: boolean;
  subledger?: string;
}

export function registerAnexo24MigrationCommands(program: Command, deps: Anexo24MigrationDeps): void {
  const run = async (fn: () => Promise<ExitCodeValue>): Promise<void> => {
    try {
      await deps.shutdown(await fn());
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // Tenant FIRST: under RLS a connection without it sees no legal entity.
  const entityForWrite = async (opts: Opts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  const readFile = (file: string): string => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      throw usageError({ key: 'migration.file_unreadable', params: { file } });
    }
  };

  // A human reads the report as text; a machine gets the whole report as ONE
  // nested document, through the kernel's --format/--json/-o contract.
  const print = (opts: Opts, report: object, text: string): void => {
    if (legible(opts)) stdout.write(`${text}\n`);
    else render([report as Row], { ...opts, idField: 'entityId' });
  };

  /** Asks unless --yes; without a terminal, it is a no. */
  const confirmOrAbort = async (opts: Opts, command: string, question: string): Promise<void> => {
    if (opts.yes === true) return;
    let ok = false;
    if (deps.confirm) {
      ok = await deps.confirm(question);
    } else if (stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const v = await confirmarConReintento(
          (p) => rl.question(p).catch(() => null),
          deps.palette.cyan(`${question} [y/N] `)
        );
        if (v.incomprendida !== undefined) {
          process.stderr.write(
            `${t('bank.confirm.taken_as_no', { reason: noEntendi(v.incomprendida) })}\n`
          );
        }
        ok = v.si;
      } finally {
        rl.close();
      }
    }
    if (!ok) {
      throw abortedByUser(
        stdin.isTTY || deps.confirm
          ? { key: 'no_changes_ledger_untouched' }
          : { key: 'no_changes_no_terminal', params: { command } }
      );
    }
  };

  /** Preview with the service itself; print; apply only once confirmed. */
  const twoSteps = async <R extends object>(
    opts: Opts,
    dryRun: boolean,
    command: string,
    step: {
      preview: () => Promise<R>;
      apply: () => Promise<R>;
      writable: (r: R) => boolean;
      written: (r: R) => boolean;
      text: (r: R) => string;
      question: (r: R) => string;
    }
  ): Promise<ExitCodeValue> => {
    const preview = await step.preview();
    const writable = step.writable(preview);
    if (dryRun || !writable) {
      print(opts, preview, step.text(preview));
      return writable ? ExitCode.OK : ExitCode.VALIDATION;
    }
    process.stderr.write(`${step.text(preview)}\n`);
    await confirmOrAbort(opts, command, step.question(preview));
    const done = await step.apply();
    print(opts, done, step.text(done));
    return step.written(done) ? ExitCode.OK : ExitCode.VALIDATION;
  };

  // ---- chart import ------------------------------------------------------
  // Help by key (#314): help.chart.* and help.opening_balance.*.
  const chart = describeCommand(program.command('chart').alias('catalogo'), 'help.chart.description');
  const chartImport = describeCommand(
    chart.command('import <file>').alias('importar'),
    'help.chart.import.description'
  );
  withContext(chartImport);
  optionByKey(chartImport, '--partial', 'help.chart.import.option.partial');
  optionByKey(chartImport, '--reason <text>', 'help.chart.import.option.reason');
  optionByKey(chartImport, '--dry-run', 'cli.flag.dry_run');
  optionByKey(chartImport, '-y, --yes', 'cli.flag.yes');
  withOutput(chartImport);
  chartImport.addHelpText('after', EXAMPLES.chartImport);
  // Creating accounts is a write, not a posting: a wrong account is archived.
  // The agent is still closed, as the catalog row says.
  declareRisk(chartImport, { risk: 'escritura', agent: false, writes: 'accounts' });
  chartImport.action((file: string, opts: Opts, cmd: Command) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as Record<string, unknown>);
      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const base = {
        entityId: ctx.entityId,
        xml: readFile(file),
        userId: reviewer.userId,
        parcial: opts.partial === true,
        reason: opts.reason ?? null,
      };
      return twoSteps(opts, dryRun, 'chart import', {
        preview: () => importSatChart(ctx, { ...base, dryRun: true }),
        apply: () => importSatChart(ctx, base),
        writable: (r) => r.puedeImportarse && (r.completa || opts.partial === true),
        written: (r) => r.escrito,
        text: renderSatChartImportReport,
        question: (r) => t('migration.chart.confirm', { count: r.aCrear.length, entity: ctx.entityName }),
      });
    })
  );

  // ---- opening-balance import | check ------------------------------------
  const opening = describeCommand(
    program.command('opening-balance').alias('saldo-inicial'),
    'help.opening_balance.description'
  );

  const openingImport = describeCommand(
    opening.command('import <file>').alias('importar'),
    'help.opening_balance.import.description'
  );
  withContext(openingImport);
  optionByKey(openingImport, '--subledger <file>', 'help.opening_balance.import.option.subledger');
  optionByKey(openingImport, '--reason <text>', 'help.opening_balance.import.option.reason');
  withOutput(openingImport);
  openingImport.addHelpText('after', EXAMPLES.openingImport);
  // IRREVERSIBLE: it posts to the ledger of 041, where an entry is corrected
  // by reversal, never edited. The kernel injects --dry-run, --yes and
  // --idempotency-key, and refuses to start if the agent is ever let in.
  declareRisk(openingImport, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries + journal_entry_lines (ONE opening entry, posted; ' +
      'a locked draft when the panel key for the opening load mode says so); with --subledger ' +
      'and a posted opening, also invoices + customers and bills + vendors for its open documents',
    llave: {
      innecesaria:
        'the ledger refuses a second live opening for the same entity and date ' +
        '(the partial unique index of migrations 081 and 087): a retry is reported, never posted',
    },
  });
  openingImport.action((file: string, opts: Opts, cmd: Command) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as Record<string, unknown>);
      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      let openDocuments: OpeningDocument[] | undefined;
      if (opts.subledger !== undefined) {
        const parsed: unknown = JSON.parse(readFile(opts.subledger));
        if (!Array.isArray(parsed)) {
          throw usageError({ key: 'migration.subledger_not_array' });
        }
        openDocuments = parsed as OpeningDocument[];
      }
      const base = {
        entityId: ctx.entityId,
        xml: readFile(file),
        userId: reviewer.userId,
        documentos: openDocuments,
        reason: opts.reason ?? null,
      };
      return twoSteps(opts, dryRun, 'opening-balance import', {
        preview: () => importOpeningBalance(ctx, { ...base, dryRun: true }),
        apply: () => importOpeningBalance(ctx, base),
        writable: (r) => r.puedeCargarse,
        written: (r) => r.escrito,
        text: renderOpeningBalanceReport,
        question: (r) =>
          t(r.loadMode === 'draft' ? 'migration.opening.confirm_draft' : 'migration.opening.confirm', {
            year: r.ejercicio,
            date: r.fecha,
            debit: r.totalDebe,
            credit: r.totalHaber,
          }),
      });
    })
  );

  const openingCheck = describeCommand(
    opening.command('check <file>').alias('verificar'),
    'help.opening_balance.check.description'
  );
  withContext(openingCheck);
  withOutput(openingCheck);
  openingCheck.addHelpText('after', EXAMPLES.openingCheck);
  declareRisk(openingCheck, { risk: 'lectura', agent: true });
  openingCheck.action((file: string, opts: Opts) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
      const report = await checkOpeningBalance(ctx, { entityId: ctx.entityId, xml: readFile(file) });
      print(
        opts,
        report,
        t('migration.check.as_of', {
          date: report.asOf,
          comparison: renderBalanceComparison(report.comparison),
        })
      );
      return report.comparison.iguales ? ExitCode.OK : ExitCode.VALIDATION;
    })
  );
}
