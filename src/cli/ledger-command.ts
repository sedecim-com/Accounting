import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  runLedgerChecks,
  listStaleDrafts,
  LEDGER_CHECK_NAMES,
} from '../services/accounting/ledger-checks.js';
import { getAuxiliaryView } from '../services/reporting/report-service.js';
import {
  getAccountBalanceByPeriod,
  resolveAccount,
} from '../services/accounting/account-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withSelection,
  withStrict,
  resolveActiveEntity,
  usageError,
  exitCodeFor,
  checkExitCode,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine ledger
//
// El mayor como sustantivo de primera clase: verificar su integridad
// (checks nombrados y enumerables, modelo hledger), listar lo que lo
// atora (borradores viejos), y leerlo en las dos formas que un
// contador pide — el auxiliar inicial→movimientos→final (la forma XC
// del SAT) y el saldo descompuesto por periodo.
//
// TODO es lectura y TODO está abierto al agente: el mayor se consulta,
// jamás se escribe desde aquí — escribir es asunto de entry post y de
// nadie más. El saldo descompuesto comparte servicio con `account
// balance show` a propósito: dos puertas, UNA aritmética.
// ============================================================

export interface LedgerCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}

export function registerLedgerCommand(program: Command, deps: LedgerCommandDeps): void {
  const ledger = program
    .command('ledger')
    .alias('mayor')
    .description('The general ledger itself: integrity checks, stale drafts, auxiliaries and balances');

  const note = (m: string) => process.stderr.write(deps.palette.dim(`${m}\n`));

  const run = async (fn: () => Promise<number | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };

  // ---- ledger check ------------------------------------------------
  const check = ledger
    .command('check')
    .alias('verificar')
    .description('Named ledger checks; with no flag runs the blocking ones and exits 4 on findings');
  withOutput(withStrict(withContext(check)));
  check
    .option('--check <names>', `checks to run, comma-separated (available: ${LEDGER_CHECK_NAMES.join(', ')}; empty lists them)`)
    .option('--account <code>', 'scope the balance check to one account')
    .option('--period <name>', 'scope the balance check to one fiscal period');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.action((opts: CommonOpts & { check?: string; account?: string; period?: string; strict?: boolean }) =>
    run(async () => {
      if (opts.check === '') {
        process.stdout.write(`Verificaciones disponibles: ${LEDGER_CHECK_NAMES.join(', ')}\n`);
        return;
      }
      const nombres = opts.check?.split(',').map((c) => c.trim()).filter(Boolean);
      const ctx = await entityOf(opts);
      const findings = await runLedgerChecks(ctx.entityId, nombres, {
        account: opts.account,
        period: opts.period,
      });
      render(findings as unknown as Row[], { ...opts, idField: 'referencia' });
      const blocking = findings.filter((f) => f.severity === 'blocking').length;
      const warning = findings.filter((f) => f.severity === 'warning').length;
      process.stderr.write(
        findings.length === 0
          ? deps.palette.green(`✔ el mayor pasa ${nombres?.length ? nombres.join(', ') : 'las verificaciones bloqueantes'}\n`)
          : deps.palette.yellow(`${blocking} hallazgo(s) bloqueante(s), ${warning} advertencia(s)\n`)
      );
      return checkExitCode({ blocking, warning }, { strict: opts.strict });
    })
  );

  // ---- ledger stale-draft list ------------------------------------
  const staleDraft = ledger
    .command('stale-draft')
    .alias('borrador-viejo')
    .description('Draft journal entries that have sat unposted too long');
  const staleList = staleDraft
    .command('list')
    .alias('listar')
    .description('Drafts older than N days — the number-one blocker of every close checklist');
  withOutput(withSelection(withContext(staleList)));
  staleList
    .option('--days <n>', 'minimum age in days', '30')
    .option('--period <name>', 'only drafts dated into this fiscal period');
  declareRisk(staleList, { risk: 'lectura', agent: true });
  staleList.action((opts: CommonOpts & { days: string; period?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const dias = parseInt(opts.days, 10);
      if (!Number.isFinite(dias) || dias < 0) throw usageError(`--days ilegible: "${opts.days}".`);
      const rows = await listStaleDrafts(ctx.entityId, { days: dias, period: opts.period });
      render(rows as unknown as Row[], { ...opts, idField: 'entry_number' });
      if (rows.length > 0) {
        note(`${rows.length} borrador(es) con más de ${dias} días. Se aplican con entry post, o se retiran.`);
      }
    })
  );

  // ---- ledger auxiliary show --------------------------------------
  const auxiliary = ledger
    .command('auxiliary')
    .alias('auxiliar')
    .description('Account auxiliary: beginning balance, movements, ending — the SAT XC shape');
  const auxShow = auxiliary
    .command('show')
    .alias('ver')
    .description('One account, one period: beginning → every movement → ending');
  withOutput(withSelection(withContext(auxShow)));
  auxShow
    .requiredOption('--account <code>', 'account code')
    .requiredOption('--period <name>', 'fiscal period name (or unambiguous fragment)');
  declareRisk(auxShow, { risk: 'lectura', agent: true });
  auxShow.action((opts: CommonOpts & { account: string; period: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const aux = await getAuxiliaryView(ctx.entityId, opts.account, opts.period, {
        limit: opts.all ? undefined : opts.limit,
        offset: opts.offset,
      });
      note(
        `${aux.account_code} ${aux.account_name} · ${aux.period_name} (${aux.period_status}) · ` +
          `inicial ${aux.inicial}${aux.inicial_confiable ? '' : ' (sin cierre duro: es actividad, no acumulado)'}`
      );
      render(aux.movimientos as unknown as Row[], {
        ...opts,
        total: aux.total_movimientos,
        idField: 'entry_number',
      });
      note(
        `cargos ${aux.cargos} · abonos ${aux.abonos} · final ${aux.final}` +
          (aux.final !== aux.final_calculado
            ? deps.palette.yellow(` (calculado ${aux.final_calculado}: hay deriva — corre ledger check)`)
            : '')
      );
    })
  );

  // ---- ledger balance show ----------------------------------------
  const balance = ledger
    .command('balance')
    .alias('saldo')
    .description('One account balance decomposed by period, with the period status');
  const balShow = balance
    .command('show')
    .alias('ver')
    .description('Beginning, debits, credits and ending per period for one account');
  withOutput(withContext(balShow));
  balShow
    .requiredOption('--account <code>', 'account code or id')
    .option('--as-of <date>', 'only the period containing this date (YYYY-MM-DD)')
    .option('--period <name>', 'only the periods whose name matches')
    .option('--dim <name>', 'per-dimension breakdown (not available: the dimension family does not exist yet)');
  declareRisk(balShow, { risk: 'lectura', agent: true });
  balShow.action((opts: CommonOpts & { account: string; asOf?: string; period?: string; dim?: string }) =>
    run(async () => {
      if (opts.dim) {
        throw usageError('--dim aún no está disponible: las dimensiones no tienen maestro todavía (familia dimension).');
      }
      const ctx = await entityOf(opts);
      const cuenta = await resolveAccount(ctx.entityId, opts.account);
      const rows = await getAccountBalanceByPeriod(ctx.entityId, cuenta.id, {
        period: opts.period,
        asOf: opts.asOf,
      });
      if (rows.some((r) => r.period_status === 'open' || r.period_status === 'soft_close')) {
        note('Nota: beginning_balance solo se siembra en el cierre duro; en periodos abiertos lee la actividad, no el acumulado.');
      }
      render(rows as unknown as Row[], { ...opts, idField: 'period_name' });
    })
  );
}
