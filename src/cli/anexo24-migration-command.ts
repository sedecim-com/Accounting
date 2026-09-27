import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { checkOpeningBalance } from '../services/accounting/opening-balance.js';
import { renderBalanceComparison } from '../services/accounting/opening-balance-check.js';
import { t } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
  exitCodeFor,
  legible,
  render,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// MIGRATING FROM THE ANEXO 24 (MNE-001-018 · #220): the terminal door to the
// penny check, which until now only the plan's criterion could call. The two
// import leaves (`chart import`, `opening-balance import`) are part 2/2.
// ============================================================

const EXAMPLES = {
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
}

interface Opts {
  entity?: string;
  tenant?: string;
  json?: boolean;
  format?: string;
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

  // ---- opening-balance check ---------------------------------------------
  const opening = program
    .command('opening-balance')
    .alias('saldo-inicial')
    .description('Opening balances migrated from the Anexo 24 trial balance of the previous system');

  const openingCheck = opening
    .command('check <file>')
    .alias('verificar')
    .description(
      'Compare the source trial balance against the ledger on the opening day, to the peso; exits 4 if they differ'
    );
  withContext(openingCheck);
  withOutput(openingCheck);
  openingCheck.addHelpText('after', EXAMPLES.openingCheck);
  declareRisk(openingCheck, { risk: 'lectura', agent: true });
  openingCheck.action((file: string, opts: Opts) =>
    run(async () => {
      // Tenant FIRST: under RLS a connection without it sees no legal entity.
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
