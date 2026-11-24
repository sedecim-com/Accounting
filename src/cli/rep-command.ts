import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  listPagosSinRep,
  listRepAparcados,
  reprocesarREPsAparcados,
} from '../services/xml-ingestion/rep-pendientes.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { t } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withSelection,
  resolveActiveEntity,
  usageError,
  exitCodeFor,
  type Row,
  optionByKey,
  describeCommand,
} from './kernel/index.js';

// ============================================================
// mnemosine rep
//
// El complemento de pago desde la terminal: lo que ESPERA un REP (los
// pagos sobre PPD sin comprobante — recibidos, con el IVA aparcado en
// 1135; emitidos, con obligación fiscal propia) y el REPROCESO de los
// REP que llegaron y quedaron aparcados pidiendo decisión. «Nada lo
// reintenta solo» decía la ligadura — desde F02, esto lo reintenta.
//
// `rep reconcile` NO es invocable por el agente: reprocesar liga o CREA
// pagos por la puerta de pagos — dinero de verdad, acto humano. Emitir
// y corregir REPs (stamp/correct) siguen fuera: dependen del PAC (§5).
// ============================================================

export interface RepCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /**
   * Test seam of the three reads and the retry: the real functions unless a
   * test passes doubles, as `CfdiCommandDeps.parkedReceipts` does.
   */
  receipts?: {
    missing: typeof listPagosSinRep;
    parked: typeof listRepAparcados;
    retry: typeof reprocesarREPsAparcados;
  };
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}

export function registerRepCommand(program: Command, deps: RepCommandDeps): void {
  const receipts = deps.receipts ?? {
    missing: listPagosSinRep,
    parked: listRepAparcados,
    retry: reprocesarREPsAparcados,
  };
  const rep = describeCommand(program.command('rep'), 'help.rep.description');

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

  // ---- rep missing list --------------------------------------------
  const missing = describeCommand(rep.command('missing').alias('faltante'), 'help.rep.missing.description');
  const missingList = describeCommand(missing.command('list').alias('listar'), 'help.rep.missing.list.description');
  withOutput(withSelection(withContext(missingList)));
  optionByKey(missingList, '--direction <d>', 'help.rep.missing.list.option.direction', { defaultValue: 'received' });
  optionByKey(missingList, '--min-amount <n>', 'help.rep.missing.list.option.min_amount');
  declareRisk(missingList, { risk: 'lectura', agent: true });
  missingList.action((opts: CommonOpts & { direction: string; minAmount?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const minAmount = opts.minAmount === undefined ? undefined : Number(opts.minAmount);
      if (minAmount !== undefined && !Number.isFinite(minAmount)) {
        throw usageError({ key: 'fiscal_mx.rep.missing.min_amount_unreadable', params: { value: String(opts.minAmount) } });
      }
      const rows = await receipts.missing(ctx.entityId, {
        direction: opts.direction as 'received' | 'issued',
        minAmount,
        limit: opts.all ? undefined : (opts.limit ?? 50),
      });
      render(rows as unknown as Row[], { ...opts, idField: 'payment_number' });
      if (rows.length > 0) {
        note(
          t(opts.direction === 'issued' ? 'fiscal_mx.rep.missing.issued' : 'fiscal_mx.rep.missing.received', {
            count: rows.length,
          })
        );
      }
      const desconocidos = rows.filter((r) => r.metodo === 'desconocido').length;
      if (desconocidos > 0) {
        note(
          t('fiscal_mx.rep.missing.unknown_method', {
            count: desconocidos,
            method: opts.direction === 'issued' ? 'PUE' : 'PPD',
          })
        );
      }
    })
  );

  // ---- rep reconcile -----------------------------------------------
  const reconcile = describeCommand(rep.command('reconcile').alias('conciliar'), 'help.rep.reconcile.description');
  withContext(reconcile);
  optionByKey(reconcile, '-n, --limit <n>', 'help.rep.reconcile.option.limit', { defaultValue: '50' });
  optionByKey(reconcile, '--dry-run', 'help.rep.reconcile.option.dry_run');
  // Reprocesar LIGA o CREA pagos por la puerta de pagos: dinero real. El
  // catálogo imaginó borradores; la ligadura de AUD-5 es determinista y no
  // los produce — por eso agent:false, no un draftOnly que mentiría.
  declareRisk(reconcile, {
    risk: 'escritura',
    agent: false,
    writes: 'vendor/customer_payments + journal entries through the payments door; pre_registrations',
  });
  reconcile.action((opts: CommonOpts & { limit: string; dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const limit = parseInt(opts.limit, 10);
      if (opts.dryRun) {
        const aparcados = await receipts.parked(ctx.entityId, limit);
        render(aparcados as unknown as Row[], { ...opts, idField: 'id' });
        note(t('fiscal_mx.rep.reconcile.would_retry', { count: aparcados.length }));
        return;
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const r = await receipts.retry(ctx.entityId, reviewer.userId, { limit });
      const tally = t('fiscal_mx.rep.reconcile.done', {
        retried: r.reprocesados,
        linked: r.ligados,
        parked: r.siguen_aparcados,
        errors: r.errores,
      });
      process.stdout.write(`${deps.palette.green('✔')} ${tally}\n`);
      for (const d of r.detalles.filter((x) => x.resultado !== 'ligado').slice(0, 10)) {
        process.stderr.write(deps.palette.dim(`  · ${d.id}: ${d.motivo?.slice(0, 140) ?? d.resultado}\n`));
      }
      return r.errores > 0 ? 1 : 0;
    })
  );
}
