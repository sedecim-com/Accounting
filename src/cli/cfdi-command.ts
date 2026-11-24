import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { PreRegistrationService } from '../services/xml-ingestion/pre-registration-service.js';
import { listRepAparcados } from '../services/xml-ingestion/rep-pendientes.js';
import { AppError } from '../utils/errors.js';
import { t } from '../i18n/index.js';
import readline from 'node:readline/promises';
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
  emit,
  legible,
  withContext,
  withOutput,
  withSelection,
  withTime,
  resolveActiveEntity,
  requireExplicitEntity,
  describeCommand,
  argumentByKey,
  optionByKey,
  notFound,
  usageError,
  abortedByUser,
  blockedByState,
  needsHuman,
  exitCodeFor,
  type Row,
} from './kernel/index.js';
import { confirmarConReintento, noEntendi, yesNoPrompt } from './kernel/confirmacion.js';

// ============================================================
// mnemosine cfdi
//
// El ESPEJO desde la terminal: los CFDI tal como llegaron, con su
// dirección (emitido/recibido/ajeno derivada contra el RFC de la
// entidad), su estatus ante el SAT — el de verdad, del servicio público
// de consulta, no un «Vigente» simulado — y el rastro del clasificador
// que la 015 prometió y F02 empezó a escribir.
//
// Two leaves write. `cfdi status sync` writes only the sat_* cache of the
// document: the SAT query is anonymous and public, with no e.firma and no
// PAC. `cfdi post` books a CFDI the entity issued to receivables, with no
// model (MNE-001-418). Stamping and cancelling do not live here yet.
// ============================================================

export interface CfdiCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Test seams of `cfdi post`: the confirmation prompt and the parked REPs. */
  confirm?: (question: string) => Promise<boolean>;
  parkedReceipts?: typeof listRepAparcados;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The door answers 422 for every refusal; the terminal tells a wait and a state from a validation. */
const REFUSAL_EXIT: Record<string, typeof needsHuman> = {
  ISSUED_CFDI_DRAFT_IN_REVIEW: needsHuman,
  CFDI_REQUIERE_DECISION: needsHuman,
  ISSUED_CFDI_NOT_OPEN: blockedByState,
  CFDI_ALREADY_INVOICED: blockedByState,
  ISSUED_CFDI_SUBSTITUTES_INVOICE: blockedByState,
};

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
  post: `
Examples:
  # The invoice and the entry it would write, writing nothing.
  mnemosine cfdi post 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --dry-run
  # Post it, with 4200 as the revenue account of every concept not coded on its own.
  mnemosine cfdi post 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --account 4200 --yes
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
  const cfdi = describeCommand(program.command('cfdi'), 'help.cfdi.description');

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
  const list = describeCommand(cfdi.command('list').alias('listar'), 'help.cfdi.list.description');
  withOutput(withSelection(withTime(withContext(list))));
  optionByKey(list, '--direction <d>', 'help.cfdi.list.option.direction');
  optionByKey(list, '--type <t>', 'help.cfdi.list.option.type');
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
  const show = describeCommand(cfdi.command('show').alias('ver'), 'help.cfdi.show.description');
  argumentByKey(show, '<uuid>', 'help.cfdi.show.argument.uuid');
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
        // Por `emit` y no por stdout: es un DATO, y con `-o` el archivo
        // prometido tiene que existir y contener el XML, no quedarse sin
        // crear mientras los bytes se van por la terminal.
        emit(doc.xml_content, opts);
        return;
      }
      const { xml_content, lineas, ...cabecera } = doc;

      // DOS TABLAS PARA UN HUMANO, UN SOLO DOCUMENTO PARA UNA MÁQUINA (#90).
      //
      // El comprobante y sus conceptos se leen mejor en dos tablas, y así se
      // imprimen. Pero para cualquier destino de MÁQUINA —`--json`, `-o`, un
      // formato pedido— dos renders son dos sobres `{schema,count,rows}`
      // concatenados, y eso no es un JSON: es un archivo que el parser de quien
      // lo pidió rechaza. Antes esto no se veía porque el segundo render
      // BORRABA al primero —el archivo era JSON válido por accidente, con la
      // mitad del documento perdida—; al hacer que `-o` acumule, el accidente
      // se acabó y el defecto quedó a la vista.
      //
      // Así que en modo máquina se compone UN documento con los conceptos
      // anidados, que es además lo que `entry show` ya hacía con sus renglones.
      if (!legible(opts)) {
        render([{ ...cabecera, lineas }], { ...opts, idField: 'cfdi_uuid' });
        return;
      }
      render([cabecera], { ...opts, idField: 'cfdi_uuid' });
      note(t('fiscal_mx.cfdi.show.lines', { count: lineas.length }));
      render(lineas, { ...opts, idField: 'line_number' });
    })
  );

  // ---- cfdi status -------------------------------------------------
  const status = describeCommand(cfdi.command('status').alias('estatus'), 'help.cfdi.status.description');

  const statusShow = describeCommand(status.command('show').alias('ver'), 'help.cfdi.status.show.description');
  argumentByKey(statusShow, '<uuid>', 'help.cfdi.status.show.argument.uuid');
  withOutput(withContext(statusShow));
  optionByKey(statusShow, '--refresh', 'help.cfdi.status.show.option.refresh');
  declareRisk(statusShow, { risk: 'lectura', agent: true });
  statusShow.addHelpText('after', EJEMPLOS.statusShow);
  statusShow.action((uuid: string, opts: CommonOpts & { refresh?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const doc = await query<{ id: string }>(
        `SELECT id FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`,
        [ctx.entityId, uuid]
      );
      if (doc.rows.length === 0) throw notFound({ key: 'fiscal_mx.cfdi.status.not_in_mirror', params: { uuid } });
      if (opts.refresh) {
        const checked = await new SATValidationService().validateAndUpdate(doc.rows[0].id);
        if (checked?.status === 'cancelled') note(t('cfdi.status.bills_marked', { count: checked.billsMarked ?? 0 }));
      }
      const fila = await query<Record<string, unknown>>(
        `SELECT cfdi_uuid, sat_validation_status, sat_estado, sat_efecto_cancelacion,
                sat_fecha_cancelacion::text AS sat_fecha_cancelacion,
                sat_validated_at::text AS sat_validated_at
           FROM xml_documents WHERE id = $1`,
        [doc.rows[0].id]
      );
      if (!opts.refresh && fila.rows[0].sat_validated_at === null) {
        note(t('fiscal_mx.cfdi.status.never_checked'));
      }
      render(fila.rows, { ...opts, idField: 'cfdi_uuid' });
    })
  );

  const statusSync = describeCommand(status.command('sync').alias('sincronizar'), 'help.cfdi.status.sync.description');
  withContext(statusSync);
  optionByKey(statusSync, '-n, --limit <n>', 'help.cfdi.status.sync.option.limit', { defaultValue: '100' });
  optionByKey(statusSync, '--stale-hours <h>', 'help.cfdi.status.sync.option.stale_hours', { defaultValue: '24' });
  // Clase EXTERNO (la del catálogo): un barrido que llama afuera N veces.
  // Sin --live se queda en el informe de lo que consultaría; el kernel
  // inyecta --live/--dry-run/-y y gateMutation exige la confirmación.
  declareRisk(statusSync, {
    risk: 'externo',
    agent: false,
    llave: { sinLlave: { key: 'fiscal_mx.cfdi.sync.retry_reconsults' } },
    writes: 'xml_documents (sat_* cache)',
  });
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
          `${t('fiscal_mx.cfdi.sync.pending', { count: Number(pendientes.rows[0].n), mode: dryRun ? 'dry_run' : 'not_live' })}\n`
        );
        return;
      }
      const r = await revalidateEntityCfdis(
        { entityId: ctx.entityId },
        { limit: parseInt(opts.limit, 10), staleHours: parseInt(opts.staleHours, 10) }
      );
      const tally = t('fiscal_mx.cfdi.sync.done', {
        checked: r.consultados,
        valid: r.vigentes,
        cancelled: r.cancelados,
        not_found: r.no_encontrados,
        errors: r.errores,
      });
      process.stdout.write(`${deps.palette.green('✔')} ${tally}\n`);
      if (r.cancelados > 0) {
        process.stderr.write(deps.palette.yellow(
          `⚠ ${t('fiscal_mx.cfdi.sync.cancelled_warning', { count: r.cancelados })}\n`
        ));
        process.stderr.write(`${t('cfdi.status.bills_marked', { count: r.bills_marked })}\n`);
      }
      return r.errores > 0 ? 1 : 0;
    })
  );

  // ---- cfdi explain ------------------------------------------------
  const explain = describeCommand(cfdi.command('explain').alias('explicar'), 'help.cfdi.explain.description');
  argumentByKey(explain, '<uuid>', 'help.cfdi.explain.argument.uuid');
  withOutput(withContext(explain));
  declareRisk(explain, { risk: 'lectura', agent: true });
  explain.addHelpText('after', EJEMPLOS.explain);
  explain.action((uuid: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const rastro = await getClassificationTrail(ctx.entityId, uuid);
      note(
        t('fiscal_mx.cfdi.explain.header', {
          uuid: rastro.cfdi_uuid,
          type: rastro.tipo_comprobante,
          direction: rastro.direction,
          case: rastro.case_id ?? '—',
          status: rastro.status,
        }) + (rastro.journal_entry_id ? ` · ${t('fiscal_mx.cfdi.explain.entry', { entry: rastro.journal_entry_id })}` : '')
      );
      const decisiones = (rastro.decisions as Array<Record<string, unknown>>).map((d) => ({
        id: d.id, severity: d.severity, question: d.question,
      }));
      if (decisiones.length > 0) {
        render(decisiones, { ...opts, idField: 'id' });
      } else {
        note(t('fiscal_mx.cfdi.explain.no_decisions'));
      }
      if (opts.json) {
        render([rastro as unknown as Row], { json: true });
      }
    })
  );

  // ---- cfdi post ---------------------------------------------------
  // MNE-001-418 (#620): the hand door of an issued CFDI, postIssuedCfdiByHand. It asks no model.
  const post = describeCommand(cfdi.command('post').alias('contabilizar'), 'help.cfdi.post.description');
  argumentByKey(post, '<uuid>', 'help.cfdi.post.argument.uuid');
  withContext(post);
  optionByKey(post, '--account <code>', 'help.cfdi.post.option.account');
  optionByKey(post, '--json', 'help.cfdi.post.option.json');
  declareRisk(post, {
    risk: 'irreversible',
    agent: false,
    llave: { innecesaria: t('fiscal_mx.cfdi.post.key_unneeded') },
    writes: 'invoices + invoice_lines + journal_entries + account_balances + pre_registrations + xml_documents',
  });
  post.addHelpText('after', EJEMPLOS.post);
  post.action((uuid: string, opts: CommonOpts & { account?: string; yes?: boolean; user?: string }) =>
    run(async () => {
      if (!UUID_RE.test(uuid)) throw usageError({ key: 'cfdi.post.bad_uuid', params: { uuid } });
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity(
        { entity: opts.entity },
        { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
      );
      const { dryRun } = gateMutation(post, opts as unknown as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const doc = await getCfdiByUuid(ctx.entityId, uuid);
      const revenueAccountId = opts.account ? (await resolveAccount(ctx.entityId, opts.account)).id : undefined;
      const method = doc.metodo_pago === 'PPD' ? 'PPD' : 'PUE';

      if (!dryRun && !opts.yes) {
        const question = t('cfdi.post.confirm', {
          uuid: doc.cfdi_uuid, rfc: doc.receptor_rfc, total: doc.total, currency: doc.moneda, method: doc.metodo_pago ?? 'none',
        });
        if (deps.confirm) {
          if (!(await deps.confirm(question))) throw abortedByUser();
        } else if (!process.stdin.isTTY) {
          throw abortedByUser({ key: 'cfdi.post.no_terminal', params: { question } });
        } else {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const verdict = await confirmarConReintento((q) => rl.question(q).catch(() => null), yesNoPrompt(question))
            .finally(() => rl.close());
          if (!verdict.si) throw abortedByUser(verdict.incomprendida !== undefined ? noEntendi(verdict.incomprendida) : undefined);
        }
      }

      const r = await new PreRegistrationService()
        .postIssuedCfdiByHand({ entityId: ctx.entityId, cfdiUuid: uuid, userId: reviewer.userId, revenueAccountId, dryRun })
        .catch((err: unknown) => {
          const refusal = err instanceof AppError ? REFUSAL_EXIT[err.code] : undefined;
          throw refusal ? refusal((err as AppError).messageKey ?? (err as AppError).message) : err;
        });
      for (const warning of r.warnings) process.stderr.write(deps.palette.yellow(`⚠ ${warning}\n`));
      if (opts.json) {
        render(
          [{
            invoice_number: r.invoice.number, status: r.invoice.status, amount_due: r.invoice.amountDue,
            entry_number: r.entry.number, dry_run: r.dryRun,
          }],
          { json: true }
        );
        return;
      }
      const said = { uuid: doc.cfdi_uuid, rfc: doc.receptor_rfc, invoice: r.invoice.number, entry: r.entry.number, due: r.invoice.amountDue };
      process.stdout.write(
        dryRun ? `${deps.palette.bold(t('cfdi.post.would_post', said))}\n` : `${deps.palette.green('✔')} ${t('cfdi.post.posted', said)}\n`
      );
      render(
        r.lines.map((l) => ({ account: l.accountCode, name: l.accountName, debit: l.debit ?? '', credit: l.credit ?? '' })),
        { format: 'table', numeric: ['debit', 'credit'] }
      );
      // MNE-001-522 (#670, decision 4): what a line held before migration 334 uncoded it, never posted.
      for (const ref of r.references) {
        note(t('cfdi.post.previous_account', { line: ref.line, code: ref.accountCode, name: ref.accountName }));
      }
      if (dryRun) {
        note(t('cfdi.post.nothing_written', { id: r.preRegistrationId }));
        return;
      }
      const parked = method === 'PPD' && (await (deps.parkedReceipts ?? listRepAparcados)(ctx.entityId, 1)).length > 0;
      note(t('cfdi.post.next', { method, parked: parked ? 'yes' : 'no', invoice: r.invoice.number }));
    })
  );
}
