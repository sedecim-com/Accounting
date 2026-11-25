import type { Command } from 'commander';
import { t } from '../i18n/index.js';
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
  describeCommand,
  optionByKey,
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

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// `--period` de esta familia es el NOMBRE del periodo fiscal (o un fragmento
// suyo), no el selector de `report`: los nombres se acuñan en inglés
// ("July 2026", fiscal-calendar-service.ts). El auxiliar es la forma que pide
// el XC del Anexo 24, y por eso su ejemplo lo saca en CSV.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  check: `
Examples:
  # The blocking checks; exit 4 if anything is found.
  mnemosine ledger check
  # One named check, scoped to a single account and period.
  mnemosine ledger check --check balance --account 1120 --period 2026-07
  # Every check, with warnings blocking too.
  mnemosine ledger check --check balance,audit-trail,continuity,year-sweep --strict
`,
  staleDraftList: `
Examples:
  # Drafts sitting unposted for more than 30 days.
  mnemosine ledger stale-draft list
  # Older than a week and dated into one period, as CSV.
  mnemosine ledger stale-draft list --days 7 --period 2026-07 --format csv
`,
  auxiliaryShow: `
Examples:
  # One account, one period: beginning balance, every movement, ending balance.
  mnemosine ledger auxiliary show --account 1120 --period 2026-07
  # The payables account in the same shape, as CSV for the auditor.
  mnemosine ledger auxiliary show --account 2110 --period 2026-07 --format csv
`,
  balanceShow: `
Examples:
  # One account decomposed by period, with each period's status.
  mnemosine ledger balance show --account 1111
  # Only the period that contains a date.
  mnemosine ledger balance show --account 1111 --as-of 2026-07-31
`,
} as const;

export function registerLedgerCommand(program: Command, deps: LedgerCommandDeps): void {
  const ledger = describeCommand(program.command('ledger').alias('mayor'), 'help.ledger.description');

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
  const check = describeCommand(ledger.command('check').alias('verificar'), 'help.ledger.check.description');
  withOutput(withStrict(withContext(check)));
  optionByKey(check, '--check <names>', 'help.ledger.check.option.check', {
    params: { checks: LEDGER_CHECK_NAMES.join(', ') },
  });
  optionByKey(check, '--account <code>', 'help.ledger.check.option.account');
  optionByKey(check, '--period <expr>', 'help.ledger.check.option.period');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.addHelpText('after', EJEMPLOS.check);
  check.action((opts: CommonOpts & { check?: string; account?: string; period?: string; strict?: boolean }) =>
    run(async () => {
      if (opts.check === '') {
        process.stdout.write(`${t('ledger.account.map.check.available', { checks: LEDGER_CHECK_NAMES.join(', ') })}\n`);
        return;
      }
      const nombres = opts.check?.split(',').map((c) => c.trim()).filter(Boolean);
      const ctx = await entityOf(opts);
      const findings = await runLedgerChecks(ctx.entityId, nombres, {
        account: opts.account,
        period: opts.period,
      });
      // A finding with a catalogue key is painted in the reader's language here, at the edge.
      const shown = findings.map(({ detail_key, detail_params, ...f }) =>
        detail_key ? { ...f, detalle: t(detail_key, detail_params) } : f
      );
      render(shown, { ...opts, idField: 'referencia' });
      const blocking = findings.filter((f) => f.severity === 'blocking').length;
      const warning = findings.filter((f) => f.severity === 'warning').length;
      process.stderr.write(
        findings.length === 0
          ? deps.palette.green(
              `${t('ledger.ledger.check.passes', {
                checks: nombres?.length ? nombres.join(', ') : t('ledger.ledger.check.blocking_checks'),
              })}\n`
            )
          : deps.palette.yellow(`${t('ledger.ledger.check.findings', { blocking, warning })}\n`)
      );
      return checkExitCode({ blocking, warning }, { strict: opts.strict });
    })
  );

  // ---- ledger stale-draft list ------------------------------------
  const staleDraft = describeCommand(
    ledger.command('stale-draft').alias('borrador-viejo'),
    'help.ledger.stale_draft.description'
  );
  const staleList = describeCommand(
    staleDraft.command('list').alias('listar'),
    'help.ledger.stale_draft.list.description'
  );
  withOutput(withSelection(withContext(staleList)));
  optionByKey(staleList, '--days <n>', 'help.ledger.stale_draft.list.option.days', { defaultValue: '30' });
  optionByKey(staleList, '--period <expr>', 'help.ledger.stale_draft.list.option.period');
  declareRisk(staleList, { risk: 'lectura', agent: true });
  staleList.addHelpText('after', EJEMPLOS.staleDraftList);
  staleList.action((opts: CommonOpts & { days: string; period?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const dias = parseInt(opts.days, 10);
      if (!Number.isFinite(dias) || dias < 0) throw usageError({ key: 'ledger.ledger.stale_draft.days_unreadable', params: { value: opts.days } });
      const rows = await listStaleDrafts(ctx.entityId, { days: dias, period: opts.period });
      render(rows as unknown as Row[], { ...opts, idField: 'entry_number' });
      if (rows.length > 0) {
        note(t('ledger.ledger.stale_draft.found', { count: rows.length, days: dias }));
      }
    })
  );

  // ---- ledger auxiliary show --------------------------------------
  const auxiliary = describeCommand(ledger.command('auxiliary').alias('auxiliar'), 'help.ledger.auxiliary.description');
  const auxShow = describeCommand(auxiliary.command('show').alias('ver'), 'help.ledger.auxiliary.show.description');
  withOutput(withSelection(withContext(auxShow)));
  optionByKey(auxShow, '--account <code>', 'help.ledger.auxiliary.show.option.account', { mandatory: true });
  optionByKey(auxShow, '--period <expr>', 'help.ledger.auxiliary.show.option.period', { mandatory: true });
  declareRisk(auxShow, { risk: 'lectura', agent: true });
  auxShow.addHelpText('after', EJEMPLOS.auxiliaryShow);
  auxShow.action((opts: CommonOpts & { account: string; period: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const aux = await getAuxiliaryView(ctx.entityId, opts.account, opts.period, {
        limit: opts.all ? undefined : opts.limit,
        offset: opts.offset,
      });
      // Quien firma el Anexo 24 necesita saber POR QUÉ el inicial no es de
      // fiar, y el motivo está siempre en el periodo anterior: es de ahí de
      // donde el cierre duro arrastra el acumulado.
      const sinArrastre = aux.periodo_anterior
        ? t('ledger.ledger.auxiliary.no_carry', {
            period: aux.periodo_anterior.period_name,
            status: aux.periodo_anterior.status,
          })
        : t('ledger.ledger.auxiliary.no_previous');
      note(
        t('ledger.ledger.auxiliary.heading', {
          code: aux.account_code,
          name: aux.account_name,
          period: aux.period_name,
          status: aux.period_status,
          beginning: aux.inicial,
          unreliable: aux.inicial_confiable ? '' : ` (${sinArrastre})`,
        })
      );
      render(aux.movimientos as unknown as Row[], {
        ...opts,
        total: aux.total_movimientos,
        idField: 'entry_number',
      });
      note(
        t('ledger.ledger.auxiliary.totals', { debits: aux.cargos, credits: aux.abonos, ending: aux.final }) +
          (aux.final !== aux.final_calculado
            ? deps.palette.yellow(t('ledger.ledger.auxiliary.drift', { computed: aux.final_calculado }))
            : '')
      );
    })
  );

  // ---- ledger balance show ----------------------------------------
  const balance = describeCommand(ledger.command('balance').alias('saldo'), 'help.ledger.balance.description');
  const balShow = describeCommand(balance.command('show').alias('ver'), 'help.ledger.balance.show.description');
  withOutput(withContext(balShow));
  optionByKey(balShow, '--account <code>', 'help.ledger.balance.show.option.account', { mandatory: true });
  optionByKey(balShow, '--as-of <date>', 'help.ledger.balance.show.option.as_of');
  optionByKey(balShow, '--period <expr>', 'help.ledger.balance.show.option.period');
  optionByKey(balShow, '--dim <name>', 'help.ledger.balance.show.option.dim');
  declareRisk(balShow, { risk: 'lectura', agent: true });
  balShow.addHelpText('after', EJEMPLOS.balanceShow);
  balShow.action((opts: CommonOpts & { account: string; asOf?: string; period?: string; dim?: string }) =>
    run(async () => {
      if (opts.dim) {
        throw usageError({ key: 'ledger.ledger.balance.dim_unavailable' });
      }
      const ctx = await entityOf(opts);
      const cuenta = await resolveAccount(ctx.entityId, opts.account);
      const rows = await getAccountBalanceByPeriod(ctx.entityId, cuenta.id, {
        period: opts.period,
        asOf: opts.asOf,
      });
      if (rows.some((r) => r.period_status === 'open' || r.period_status === 'soft_close')) {
        note(t('ledger.account.balance.open_period_note'));
      }
      render(rows as unknown as Row[], { ...opts, idField: 'period_name' });
    })
  );
}
