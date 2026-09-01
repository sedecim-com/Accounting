import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  listPagosSinRep,
  listRepAparcados,
  reprocesarREPsAparcados,
} from '../services/xml-ingestion/rep-pendientes.js';
import { resolveReviewer } from '../ai/draft-service.js';
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
  const rep = program
    .command('rep')
    .description('Payment receipts (REP): what is missing one, and the parked ones to retry');

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
  const missing = rep
    .command('missing')
    .alias('faltante')
    .description('Payments and collections whose REP has not arrived or been issued');
  const missingList = missing
    .command('list')
    .alias('listar')
    .description('received: paid PPD bills without the supplier REP (VAT parked); issued: our collections without a REP');
  withOutput(withSelection(withContext(missingList)));
  missingList
    .option('--direction <d>', 'received (default) or issued', 'received')
    .option('--min-amount <n>', 'only payments at or above this amount');
  declareRisk(missingList, { risk: 'lectura', agent: true });
  missingList.action((opts: CommonOpts & { direction: string; minAmount?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const minAmount = opts.minAmount === undefined ? undefined : Number(opts.minAmount);
      if (minAmount !== undefined && !Number.isFinite(minAmount)) {
        throw usageError(`--min-amount ilegible: "${opts.minAmount}".`);
      }
      const rows = await listPagosSinRep(ctx.entityId, {
        direction: opts.direction as 'received' | 'issued',
        minAmount,
        limit: opts.all ? undefined : (opts.limit ?? 50),
      });
      render(rows as unknown as Row[], { ...opts, idField: 'payment_number' });
      if (rows.length > 0) {
        note(
          opts.direction === 'issued'
            ? `${rows.length} cobro(s) sin REP emitido: obligación fiscal propia con plazo del SAT.`
            : `${rows.length} pago(s) sin REP del proveedor: su IVA sigue aparcado en 1135 (no acreditable).`
        );
      }
      const desconocidos = rows.filter((r) => r.metodo === 'desconocido').length;
      if (desconocidos > 0) {
        note(
          `${desconocidos} con método de pago desconocido (el CFDI no está en el espejo): se listan con la duda dicha — un PUE no exige REP.`
        );
      }
    })
  );

  // ---- rep reconcile -----------------------------------------------
  const reconcile = rep
    .command('reconcile')
    .alias('conciliar')
    .description('Retry the parked REPs (needs_review): safe to repeat, resolved nodes are skipped');
  withContext(reconcile);
  reconcile
    .option('-n, --limit <n>', 'maximum parked REPs to retry', '50')
    .option('--dry-run', 'list what would be retried, retry nothing');
  // Reprocesar LIGA o CREA pagos por la puerta de pagos: dinero real. El
  // catálogo imaginó borradores; la ligadura de AUD-5 es determinista y no
  // los produce — por eso agent:false, no un draftOnly que mentiría.
  declareRisk(reconcile, {
    risk: 'escritura',
    agent: false,
    writes: 'vendor/customer_payments + pólizas vía la puerta de pagos; pre_registrations',
  });
  reconcile.action((opts: CommonOpts & { limit: string; dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const limit = parseInt(opts.limit, 10);
      if (opts.dryRun) {
        const aparcados = await listRepAparcados(ctx.entityId, limit);
        render(aparcados as unknown as Row[], { ...opts, idField: 'id' });
        note(`${aparcados.length} REP(s) aparcado(s) se reintentarían (dry-run: nada se tocó).`);
        return;
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const r = await reprocesarREPsAparcados(ctx.entityId, reviewer.userId, { limit });
      process.stdout.write(
        `${deps.palette.green('✔')} ${r.reprocesados} reintentado(s): ` +
          `${r.ligados} ligado(s), ${r.siguen_aparcados} siguen aparcado(s), ${r.errores} error(es)\n`
      );
      for (const d of r.detalles.filter((x) => x.resultado !== 'ligado').slice(0, 10)) {
        process.stderr.write(deps.palette.dim(`  · ${d.id}: ${d.motivo?.slice(0, 140) ?? d.resultado}\n`));
      }
      return r.errores > 0 ? 1 : 0;
    })
  );
}
