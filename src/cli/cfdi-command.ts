import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  listCfdis,
  getCfdiByUuid,
  getClassificationTrail,
} from '../services/xml-ingestion/cfdi-query-service.js';
import { SATValidationService } from '../services/xml-ingestion/sat-validation.js';
import { revalidateEntityCfdis } from '../services/sat/cfdi-status.js';
import { query } from '../database/connection.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withContext,
  withOutput,
  withSelection,
  withTime,
  resolveActiveEntity,
  notFound,
  exitCodeFor,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine cfdi
//
// El ESPEJO desde la terminal: los CFDI tal como llegaron, con su
// dirección (emitido/recibido/ajeno derivada contra el RFC de la
// entidad), su estatus ante el SAT — el de verdad, del servicio público
// de consulta, no un «Vigente» simulado — y el rastro del clasificador
// que la 015 prometió y F02 empezó a escribir.
//
// Todo lectura salvo el refresco del estatus, que solo escribe la CACHÉ
// sat_* del documento: la consulta al SAT es anónima y pública, no toca
// e.firma ni PAC. Timbrar y cancelar NO viven aquí todavía: dependen del
// XML de emisión real y de la decisión de PAC (§5).
// ============================================================

export interface CfdiCommandDeps {
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
  status?: string[];
  since?: string;
  until?: string;
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// El acotado por fecha de `cfdi list` se hace con --since/--until: son las
// dos que la consulta lee de verdad.
//
// `cfdi status sync` sale a la red. Sin `--live` habla con el endpoint de
// pruebas, así que el ejemplo que consulta al SAT de verdad la escribe.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  list: `
Examples:
  # Everything this entity issued during July 2026.
  mnemosine cfdi list --direction emitido --since 2026-07-01 --until 2026-07-31
  # Received payment receipts (REP) only, as CSV.
  mnemosine cfdi list --direction recibido --type cfdi_pago --format csv
`,
  show: `
Examples:
  # Header, lines, taxes and the SAT status held in the mirror.
  mnemosine cfdi show 3F2504E0-4F89-11D3-9A0C-0305E82C3301
  # The exact bytes as they arrived, to verify the seal outside this system.
  mnemosine cfdi show 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --format xml
`,
  statusShow: `
Examples:
  # What the SAT last answered about this CFDI, from the cache.
  mnemosine cfdi status show 3F2504E0-4F89-11D3-9A0C-0305E82C3301
  # Ask the SAT now and update the cache with the answer.
  mnemosine cfdi status show 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --refresh
`,
  statusSync: `
Examples:
  # Which CFDIs would be consulted, calling nothing at all.
  mnemosine cfdi status sync --dry-run
  # Really consult the SAT for the 50 stalest; --live is what leaves the sandbox.
  mnemosine cfdi status sync --limit 50 --stale-hours 24 --live --yes
`,
  explain: `
Examples:
  # Why the classifier recorded it the way it did: case, facts and decisions.
  mnemosine cfdi explain 3F2504E0-4F89-11D3-9A0C-0305E82C3301
  # The same, as JSON, to attach to the working paper.
  mnemosine cfdi explain 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --json
`,
} as const;

export function registerCfdiCommand(program: Command, deps: CfdiCommandDeps): void {
  const cfdi = program
    .command('cfdi')
    .description('The CFDI mirror: list, inspect, SAT status and the classifier trail');

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

  // ---- cfdi list ---------------------------------------------------
  const list = cfdi
    .command('list')
    .alias('listar')
    .description('The mirror, filtered by direction, type, status and date');
  withOutput(withSelection(withTime(withContext(list))));
  list
    .option('--direction <d>', 'emitido, recibido o ajeno (derivada contra el RFC de la entidad)')
    .option('--type <t>', 'document_type (cfdi_ingreso, cfdi_egreso, cfdi_pago…)');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action((opts: CommonOpts & { direction?: string; type?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const { rows, total } = await listCfdis(ctx.entityId, {
        direction: opts.direction,
        type: opts.type,
        status: opts.status?.[0],
        since: opts.since,
        until: opts.until,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });
      render(rows as unknown as Row[], { ...opts, total, idField: 'cfdi_uuid' });
    })
  );

  // ---- cfdi show ---------------------------------------------------
  const show = cfdi
    .command('show')
    .alias('ver')
    .argument('<uuid>', 'CFDI UUID (timbre fiscal)')
    .description('One CFDI: header, lines, taxes and SAT status; --format xml prints the exact bytes');
  withOutput(withContext(show));
  // El SÉPTIMO formato, declarado donde el usuario lo lee. `withOutput` deletrea
  // los seis del kernel y esta hoja acepta uno más —`--format xml` imprime los
  // bytes tal como llegaron, para verificar el sello fuera de este sistema—, y
  // hasta ahora sólo lo decía la descripción en prosa. La superficie declarada
  // tiene que casar con la real: el guardián de ejemplos lo cazó comparando el
  // valor de una invocación contra el vocabulario del propio marcador.
  const formato = show.options.find((o) => o.long === '--format');
  if (formato) formato.flags = formato.flags.replace('|md>', '|md|xml>');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((uuid: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const doc = await getCfdiByUuid(ctx.entityId, uuid);
      if (opts.format === 'xml') {
        // Los bytes EXACTOS como llegaron: para verificar sellos o
        // re-procesar afuera, cualquier re-serialización es una mentira.
        process.stdout.write(doc.xml_content);
        return;
      }
      const { xml_content, lineas, ...cabecera } = doc;
      render([cabecera], { ...opts, idField: 'cfdi_uuid' });
      note(`${lineas.length} concepto(s):`);
      render(lineas, { ...opts, idField: 'line_number' });
    })
  );

  // ---- cfdi status -------------------------------------------------
  const status = cfdi
    .command('status')
    .alias('estatus')
    .description('SAT status of the mirror (public ConsultaCFDIService; no e.firma involved)');

  const statusShow = status
    .command('show')
    .alias('ver')
    .argument('<uuid>', 'CFDI UUID')
    .description('Estado, EsCancelable and EstatusCancelacion as the SAT last answered');
  withOutput(withContext(statusShow));
  statusShow.option('--refresh', 'consulta al SAT ahora y actualiza la caché sat_* del documento');
  declareRisk(statusShow, { risk: 'lectura', agent: true });
  statusShow.addHelpText('after', EJEMPLOS.statusShow);
  statusShow.action((uuid: string, opts: CommonOpts & { refresh?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const doc = await query<{ id: string }>(
        `SELECT id FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`,
        [ctx.entityId, uuid]
      );
      if (doc.rows.length === 0) throw notFound(`CFDI ${uuid} no está en el espejo de esta entidad.`);
      if (opts.refresh) {
        await new SATValidationService().validateAndUpdate(doc.rows[0].id);
      }
      const fila = await query<Record<string, unknown>>(
        `SELECT cfdi_uuid, sat_validation_status, sat_estado, sat_efecto_cancelacion,
                sat_fecha_cancelacion::text AS sat_fecha_cancelacion,
                sat_validated_at::text AS sat_validated_at
           FROM xml_documents WHERE id = $1`,
        [doc.rows[0].id]
      );
      if (!opts.refresh && fila.rows[0].sat_validated_at === null) {
        note('Nunca consultado: corre con --refresh para preguntarle al SAT ahora.');
      }
      render(fila.rows, { ...opts, idField: 'cfdi_uuid' });
    })
  );

  const statusSync = status
    .command('sync')
    .alias('sincronizar')
    .description('Re-check the whole mirror against the SAT: stale or never-consulted first');
  withContext(statusSync);
  statusSync
    .option('-n, --limit <n>', 'maximum CFDIs to consult in this run', '100')
    .option('--stale-hours <h>', 'a consultation older than this is stale', '24');
  // Clase EXTERNO (la del catálogo): un barrido que llama afuera N veces.
  // Sin --live se queda en el informe de lo que consultaría; el kernel
  // inyecta --live/--dry-run/-y y gateMutation exige la confirmación.
  declareRisk(statusSync, { risk: 'externo', agent: false, writes: 'xml_documents (caché sat_*)' });
  statusSync.addHelpText('after', EJEMPLOS.statusSync);
  statusSync.action((opts: CommonOpts & { limit: string; staleHours: string; live?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const { dryRun } = gateMutation(statusSync, opts as unknown as Record<string, unknown>);
      if (dryRun || !opts.live) {
        const pendientes = await query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM xml_documents
            WHERE entity_id = $1
              AND (sat_validated_at IS NULL OR sat_validated_at < NOW() - ($2 || ' hours')::interval)`,
          [ctx.entityId, opts.staleHours]
        );
        process.stdout.write(
          `${pendientes.rows[0].n} CFDI(s) por consultar al SAT` +
            (dryRun ? ' (dry-run: nada se consultó)\n' : '. Corre con --live para consultarlos de verdad.\n')
        );
        return;
      }
      const r = await revalidateEntityCfdis(
        { entityId: ctx.entityId },
        { limit: parseInt(opts.limit, 10), staleHours: parseInt(opts.staleHours, 10) }
      );
      process.stdout.write(
        `${deps.palette.green('✔')} ${r.consultados} consultado(s): ` +
          `${r.vigentes} vigente(s), ${r.cancelados} cancelado(s), ` +
          `${r.no_encontrados} no encontrado(s), ${r.errores} error(es)\n`
      );
      if (r.cancelados > 0) {
        process.stderr.write(deps.palette.yellow(
          `⚠ ${r.cancelados} CFDI cancelado(s) por el emisor: revisa su efecto contable con cfdi list --json\n`
        ));
      }
      return r.errores > 0 ? 1 : 0;
    })
  );

  // ---- cfdi explain ------------------------------------------------
  const explain = cfdi
    .command('explain')
    .alias('explicar')
    .argument('<uuid>', 'CFDI UUID')
    .description('WHY it was recorded the way it was: case, facts and decisions the classifier left');
  withOutput(withContext(explain));
  declareRisk(explain, { risk: 'lectura', agent: true });
  explain.addHelpText('after', EJEMPLOS.explain);
  explain.action((uuid: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const rastro = await getClassificationTrail(ctx.entityId, uuid);
      note(
        `${rastro.cfdi_uuid} · tipo ${rastro.tipo_comprobante} · ${rastro.direction} · ` +
          `caso ${rastro.case_id ?? '—'} · ${rastro.status}` +
          (rastro.journal_entry_id ? ` · asiento ${rastro.journal_entry_id}` : '')
      );
      const decisiones = (rastro.decisions as Array<Record<string, unknown>>).map((d) => ({
        id: d.id, severity: d.severity, question: d.question,
      }));
      if (decisiones.length > 0) {
        render(decisiones, { ...opts, idField: 'id' });
      } else {
        note('Sin decisiones pendientes: el caso se resolvió solo con las políticas del panel.');
      }
      if (opts.json) {
        render([rastro as unknown as Row], { json: true });
      }
    })
  );
}
