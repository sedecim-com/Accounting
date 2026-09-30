import type { Command } from 'commander';
import { resolveReviewer } from '../ai/draft-service.js';
import { t } from '../i18n/index.js';
import { ValidationError } from '../utils/errors.js';
import {
  generarAuxiliar,
  generarPolizas,
  type AuxiliarGenerado,
  type ClaseDeAuxiliar,
  type MetaDePolizas,
  type PolizasGeneradas,
} from '../services/sat/anexo24/polizas-service.js';
import {
  atributosDeSolicitud,
  TIPOS_DE_SOLICITUD,
  type Solicitud,
  type TipoSolicitud,
} from '../services/sat/anexo24/polizas-xml.js';
import type { HallazgoPoliza } from '../services/sat/anexo24/polizas-invariantes.js';
import type { ArtefactoArchivado } from '../services/sat/anexo24/artefactos.js';
import type { renderHallazgos } from './e-accounting-command.js';
import { describeOption } from './kernel/help.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  dateOnly,
  declareRisk,
  describeCommand,
  gateMutation,
  optionByKey,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine e-accounting voucher generate · subledger generate — MNE-001-054 (#328)
//
// The two Anexo 24 files the SAT asks for ON REQUEST (an audit, a compulsory
// check, a refund or an offset), never every month: the period's vouchers
// (PolizasPeriodo 1.3) and one of the two auxiliaries (AuxiliarFolios or
// AuxiliarCtas 1.3). The engine was written in F07c+d
// (src/services/sat/anexo24/polizas-service.ts); these leaves only call it.
//
// THE UUID BLOCK IS LIFTED, not worked around. The catalog row said
// `voucher generate` was blocked by `cfdi link add`: with no UUID on the entry
// there is no CompNal. Since #318 (PR #365) approving a received CFDI creates
// the bill with its `cfdi_uuid` and posts with `source_type 'bill'`, and the
// engine resolves the voucher's CFDI through that link (`soporteDe`). A manual
// entry with no source document carries no CompNal, which the XSD allows; a
// CFDI whose counterparty RFC is unusable is left out and NAMED by voucher
// number (`comprobante-sin-rfc-usable`).
//
// CONTRACT: the files these leaves write are SAT deliverables
// (catalog-info.yaml, `sat-anexo24`); their shape is the official XSD.
//
// Everything else follows the sibling leaves in e-accounting-command.ts, whose
// helpers are passed in: `-o` names the XML, overwriting it asks, the receipt
// goes to stdout without `output`, and the file comes out UNSEALED and the
// leaf says so. Writing is limited to `sat_anexo24_artefactos`, so both leaves
// are `escritura` with the agent allowed and `draftOnly`.
// ============================================================

export interface RequestFileOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  period?: string;
  closing?: boolean;
  requestType?: string;
  orderNumber?: string;
  procedureNumber?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** What the sibling leaves already own and these two reuse as is. */
export interface RequestFileHelpers {
  palette: Palette;
  run: (fn: () => Promise<ExitCodeValue | void>) => Promise<void>;
  scopeForWrite: (opts: RequestFileOpts) => Promise<{ tenantId: string; entityId: string }>;
  writeXml: (target: string, xml: string, opts: { yes?: boolean }) => Promise<void>;
  emitReceipt: (row: Row, opts: RequestFileOpts) => void;
  readable: (opts: RequestFileOpts) => boolean;
  unsealedNotice: (c: Palette) => string;
  findingLines: typeof renderHallazgos;
  stepsToFile: readonly string[];
  /** The help text that says, before anyone runs it, that nothing is sealed or filed. */
  helpNotice: (cmd: Command) => void;
  /** Test seam: the engine, replaced by a double in the unit spec. */
  engine?: RequestFileEngine;
}

/** The two engine calls these leaves make. */
export interface RequestFileEngine {
  vouchers: typeof generarPolizas;
  subledger: typeof generarAuxiliar;
}

/**
 * `--request-type`, `--order-number` and `--procedure-number`, checked BEFORE
 * the database is touched.
 *
 * The rules are the builder's own (`atributosDeSolicitud`): calling it here
 * instead of copying it keeps one version of which type takes which number and
 * what each number looks like. Its refusal is a usage error (2) at the
 * terminal, because the value came from a flag.
 */
export function requestFromFlags(opts: RequestFileOpts): Solicitud {
  const raw = (opts.requestType ?? '').trim().toUpperCase();
  if (raw === '') {
    throw usageError({ key: 'e_accounting.request.type_missing', params: { types: TIPOS_DE_SOLICITUD.join(', ') } });
  }
  const request: Solicitud = {
    tipo: raw as TipoSolicitud,
    ...(opts.orderNumber !== undefined ? { numOrden: opts.orderNumber.trim() } : {}),
    ...(opts.procedureNumber !== undefined ? { numTramite: opts.procedureNumber.trim() } : {}),
  };
  try {
    atributosDeSolicitud(request);
  } catch (err) {
    if (err instanceof ValidationError) throw usageError(err.message);
    throw err;
  }
  return request;
}

/** The month the file declares is asked for, never guessed. */
export function requirePeriod(opts: RequestFileOpts): void {
  if ((opts.period ?? '').trim() === '' && opts.closing !== true) {
    throw usageError({ key: 'e_accounting.period.missing' });
  }
}

const KINDS: readonly ClaseDeAuxiliar[] = ['folios', 'accounts'];

/** `--kind folios|accounts`, with no default: the wrong auxiliary does not answer a request. */
export function subledgerKindOf(value: string | undefined): ClaseDeAuxiliar {
  const kind = (value ?? '').trim().toLowerCase();
  if (kind === '') throw usageError({ key: 'e_accounting.subledger.kind_missing' });
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw usageError({ key: 'e_accounting.subledger.kind_unknown', params: { value: value ?? '' } });
  }
  return kind as ClaseDeAuxiliar;
}

function findingRow(h: HallazgoPoliza): Row {
  return { check: h.check, severity: h.severity, voucher: h.referencia, detail: h.detalle };
}

function commonReceipt(
  meta: MetaDePolizas,
  request: Solicitud,
  file: Pick<PolizasGeneradas, 'hash' | 'nombre' | 'bytes'>,
  artifact: ArtefactoArchivado | null,
  target: string,
  steps: readonly string[]
): Row {
  return {
    hash: file.hash,
    file: file.nombre,
    rfc: meta.rfc,
    year: meta.anio,
    month: meta.mes,
    period: meta.period_name,
    from: dateOnly(meta.desde),
    to: dateOnly(meta.hasta),
    request_type: request.tipo,
    order_number: request.numOrden ?? '',
    procedure_number: request.numTramite ?? '',
    bytes: file.bytes,
    sealed: meta.sellada,
    sealing_policy: meta.criterio_sellado,
    archived: artifact === null ? 'no' : artifact.yaExistia ? 'already-there' : 'new',
    artifact: artifact?.id ?? '',
    target,
    still_to_file: [...steps],
  };
}

/** The receipt of `voucher generate`: one row, findings nested. */
export function voucherReceipt(
  p: PolizasGeneradas,
  request: Solicitud,
  target: string,
  steps: readonly string[]
): Row {
  return {
    ...commonReceipt(p.meta, request, p, p.artefacto, target, steps),
    vouchers: p.meta.polizas,
    transactions: p.meta.transacciones,
    with_payment_trace: p.meta.con_rastro,
    banks_seeded: p.meta.bancos_sembrados,
    debit: p.totales.debe,
    credit: p.totales.haber,
    deliverable: p.puedeEntregarse,
    findings: p.hallazgos.map(findingRow),
  };
}

/** The receipt of `subledger generate`. */
export function subledgerReceipt(
  a: AuxiliarGenerado,
  request: Solicitud,
  target: string,
  steps: readonly string[]
): Row {
  return {
    ...commonReceipt(a.meta, request, a, a.artefacto, target, steps),
    kind: a.clase,
    vouchers: a.meta.polizas,
    lines: a.meta.transacciones,
  };
}

const EXAMPLES = {
  voucher: `
Examples:
  # See the verdict first: which vouchers lack a payment trace, nothing archived.
  mnemosine e-accounting voucher generate --period 2026-07 --request-type AF --order-number ABC1234567/26 --dry-run
  # A refund request: DE and CO carry the procedure number, not an order number.
  mnemosine e-accounting voucher generate --period 2026-07 --request-type DE --procedure-number DE202600000009 -o polizas-2026-07.xml --yes
`,
  subledger: `
Examples:
  # The voucher-folio auxiliary for an audit order, shown before it is archived.
  mnemosine e-accounting subledger generate --period 2026-07 --kind folios --request-type AF --order-number ABC1234567/26 --dry-run
  # The account and sub-account auxiliary for an offset request, written to disk.
  mnemosine e-accounting subledger generate --period 2026-07 --kind accounts --request-type CO --procedure-number CO202600000011 -o auxiliar-2026-07.xml --yes
`,
};

const RISK = {
  risk: 'escritura',
  agent: true,
  draftOnly: true,
  writes:
    'sat_anexo24_artefactos (the XML archived with its hash, UNSEALED); no journal entry, nothing ' +
    'sent to the authority',
} as const;

/** The flags both leaves share, in the order the help lists them. */
function requestFlags(cmd: Command, leaf: 'voucher' | 'subledger'): void {
  withContext(cmd);
  withOutput(cmd);
  // Here `-o` names the XML, as in the sibling generate leaves; its help says
  // so through a key instead of prose written over the kernel's description.
  const output = cmd.options.find((o) => o.long === '--output');
  if (output) describeOption(output, 'help.e_accounting.request.option.output');
  optionByKey(cmd, '--period <expr>', 'help.e_accounting.request.option.period');
  optionByKey(
    cmd,
    '--closing',
    leaf === 'voucher' ? 'help.e_accounting.voucher.option.closing' : 'help.e_accounting.subledger.option.closing'
  );
  optionByKey(cmd, '--request-type <AF|FC|DE|CO>', 'help.e_accounting.request.option.request_type');
  optionByKey(cmd, '--order-number <number>', 'help.e_accounting.request.option.order_number');
  optionByKey(cmd, '--procedure-number <number>', 'help.e_accounting.request.option.procedure_number');
}

export function registerRequestFileLeaves(family: Command, h: RequestFileHelpers): void {
  const c = h.palette;
  const engine: RequestFileEngine = h.engine ?? { vouchers: generarPolizas, subledger: generarAuxiliar };
  const targetOf = (opts: RequestFileOpts, dryRun: boolean): string =>
    dryRun
      ? t('e_accounting.target.dry_run')
      : (opts.output ?? t('e_accounting.target.store'));

  /** What every generate leaf says at the end: unsealed, and what the dry run did. */
  const closing = (dryRun: boolean, alreadyThere: boolean, policy: string): void => {
    const err = process.stderr;
    err.write(h.unsealedNotice(c));
    if (policy !== 'nunca_sellar_en_el_sistema') {
      err.write(c.yellow(`    ${t('e_accounting.sealing.declared', { policy })}\n\n`));
    }
    if (dryRun) err.write(c.dim(`  ${t('e_accounting.dry_run.done')}\n\n`));
    else if (alreadyThere) err.write(c.dim(`  ${t('e_accounting.archive.already_there')}\n\n`));
  };

  const header = (title: string, meta: MetaDePolizas, request: Solicitud, hash: string, target: string): void => {
    const out = process.stdout;
    out.write(`\n${c.bold(title)}  ${c.dim(`RFC ${meta.rfc} · ${meta.period_name} ${dateOnly(meta.desde)} → ${dateOnly(meta.hasta)}`)}\n`);
    const number = request.numOrden ?? request.numTramite ?? '';
    out.write(c.dim(`  TipoSolicitud ${request.tipo} · ${number}\n`));
    out.write(c.dim(`  sha256 ${hash}\n`));
    out.write(c.dim(`  ${t('e_accounting.target.label', { target })}\n`));
  };

  // ---- voucher generate · poliza generar ---------------------
  const voucher = describeCommand(
    family.command('voucher').alias('poliza'),
    'help.e_accounting.voucher.description'
  );
  const voucherGenerate = describeCommand(
    voucher.command('generate').alias('generar'),
    'help.e_accounting.voucher.generate.description'
  );
  requestFlags(voucherGenerate, 'voucher');
  optionByKey(voucherGenerate, '--validate-uuids', 'help.e_accounting.voucher.option.validate_uuids');
  optionByKey(voucherGenerate, '--dry-run', 'help.e_accounting.request.option.dry_run');
  optionByKey(voucherGenerate, '-y, --yes', 'help.e_accounting.request.option.yes');
  h.helpNotice(voucherGenerate);
  voucherGenerate.addHelpText('after', EXAMPLES.voucher);
  declareRisk(voucherGenerate, { ...RISK });
  voucherGenerate.action((opts: RequestFileOpts & { validateUuids?: boolean }, cmd: Command) =>
    h.run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const request = requestFromFlags(opts);
      requirePeriod(opts);
      const scope = await h.scopeForWrite(opts);
      const reviewer = await resolveReviewer(scope.tenantId, opts.user);

      const p = await engine.vouchers(scope.entityId, {
        ...(opts.period !== undefined ? { periodo: opts.period } : {}),
        ...(opts.closing === true ? { cierre: true } : {}),
        solicitud: request,
        validarUuids: opts.validateUuids === true,
        generadoPor: reviewer.userId,
        dryRun,
      });

      const target = targetOf(opts, dryRun);
      // Only a deliverable file reaches the disk: a blocked one written there
      // is the file someone seals by mistake three weeks later.
      if (opts.output !== undefined && !dryRun && p.puedeEntregarse) {
        await h.writeXml(opts.output, p.xml, opts);
      }

      if (!h.readable(opts)) {
        h.emitReceipt(voucherReceipt(p, request, target, h.stepsToFile), opts);
      } else {
        header(t('e_accounting.voucher.title', { month: p.meta.mes, year: p.meta.anio }), p.meta, request, p.hash, target);
        process.stdout.write(
          c.dim(
            `  ${t('e_accounting.voucher.summary', {
              vouchers: p.meta.polizas,
              traced: p.meta.con_rastro,
              debit: p.totales.debe,
              credit: p.totales.haber,
            })}\n`
          )
        );
      }

      const lines = h.findingLines(
        p.hallazgos.map((x) => ({ severity: x.severity, nombre: x.check, referencia: x.referencia, detalle: x.detalle })),
        c
      );
      if (lines.length > 0) process.stderr.write(`\n${lines.join('\n')}\n`);

      if (!p.puedeEntregarse) {
        process.stderr.write(
          `\n${c.red(`  ${t('e_accounting.voucher.blocked', { blocking: p.conteo.blocking })}`)}\n\n`
        );
        return ExitCode.VALIDATION;
      }
      closing(dryRun, p.artefacto?.yaExistia === true, p.meta.criterio_sellado);
      return ExitCode.OK;
    })
  );

  // ---- subledger generate · auxiliar generar -----------------
  const subledger = describeCommand(
    family.command('subledger').alias('auxiliar'),
    'help.e_accounting.subledger.description'
  );
  const subledgerGenerate = describeCommand(
    subledger.command('generate').alias('generar'),
    'help.e_accounting.subledger.generate.description'
  );
  requestFlags(subledgerGenerate, 'subledger');
  optionByKey(subledgerGenerate, '--kind <folios|accounts>', 'help.e_accounting.subledger.option.kind');
  optionByKey(subledgerGenerate, '--dry-run', 'help.e_accounting.request.option.dry_run');
  optionByKey(subledgerGenerate, '-y, --yes', 'help.e_accounting.request.option.yes');
  h.helpNotice(subledgerGenerate);
  subledgerGenerate.addHelpText('after', EXAMPLES.subledger);
  declareRisk(subledgerGenerate, { ...RISK });
  subledgerGenerate.action((opts: RequestFileOpts & { kind?: string }, cmd: Command) =>
    h.run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const kind = subledgerKindOf(opts.kind);
      const request = requestFromFlags(opts);
      requirePeriod(opts);
      const scope = await h.scopeForWrite(opts);
      const reviewer = await resolveReviewer(scope.tenantId, opts.user);

      const a = await engine.subledger(scope.entityId, kind, {
        ...(opts.period !== undefined ? { periodo: opts.period } : {}),
        ...(opts.closing === true ? { cierre: true } : {}),
        solicitud: request,
        generadoPor: reviewer.userId,
        dryRun,
      });

      const target = targetOf(opts, dryRun);
      if (opts.output !== undefined && !dryRun) await h.writeXml(opts.output, a.xml, opts);

      if (!h.readable(opts)) {
        h.emitReceipt(subledgerReceipt(a, request, target, h.stepsToFile), opts);
      } else {
        header(
          t(kind === 'folios' ? 'e_accounting.subledger.title_folios' : 'e_accounting.subledger.title_accounts', {
            month: a.meta.mes,
            year: a.meta.anio,
          }),
          a.meta,
          request,
          a.hash,
          target
        );
        process.stdout.write(
          c.dim(`  ${t('e_accounting.subledger.summary', { vouchers: a.meta.polizas, lines: a.meta.transacciones })}\n`)
        );
      }
      closing(dryRun, a.artefacto?.yaExistia === true, a.meta.criterio_sellado);
      return ExitCode.OK;
    })
  );
}
