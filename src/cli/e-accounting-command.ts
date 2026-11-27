import * as readline from 'node:readline/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  generarCatalogoCuentas,
  bytesDe,
  type ResultadoGeneracionCatalogo,
  type Hallazgo,
} from '../services/sat/anexo24/index.js';
import {
  generarBalanza,
  resolverPeriodoDeBalanza,
  verificarBalanza,
  type BalanzaGenerada,
  type ResultadoDeVerificacion,
} from '../services/sat/anexo24/balanza-service.js';
import {
  BALANZA_CHECK_NAMES,
  type BalanzaCheckName,
  type HallazgoBalanza,
} from '../services/sat/anexo24/balanza-invariantes.js';
import { sealArchivedDocument } from '../services/sat/anexo24/seal.js';
import type { SealableDocument } from '../services/sat/anexo24/original-string.js';
import { getLanguage, t, type TranslationKey } from '../i18n/index.js';
import { describeCommand, describeOption, optionByKey } from './kernel/help.js';
import { confirmarConReintento, noEntendi, yesNoPrompt } from './kernel/confirmacion.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  checkExitCode,
  dateOnly,
  declareRisk,
  exitCodeFor,
  gateMutation,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  withStrict,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';
import { changePolicyHint } from '../services/policy/policy-hint.js';
import { textIn, type KeyedText } from '../utils/errors.js';
import { registerRequestFileLeaves, type RequestFileEngine } from './e-accounting-request-command.js';

// ============================================================
// mnemosine e-accounting · contabilidad-electronica — EL XML QUE SE ENTREGA
//
// CINCO HOJAS, FILAS DE FASE 1 DEL CATÁLOGO (docs/cli-command-catalog.md):
//
//   catalog generate · catalogo generar — el CtaCatalogo 1.3, con su hash
//   balance generate · balanza generar  — la balanza del periodo (N, C o cierre)
//   balance check    · balanza verificar— las invariantes que el SAT rehace
//                      and the official XSD over the same bytes (MNE-001-774)
//   catalog seal · balance seal · sellar — the archived file, sealed with the
//     vault e.firma, ONLY under sellar_con_custodia (EFIRMA-4, #442)
//
// LO QUE NO ESTÁ AQUÍ: a transmission to the SAT. The SAT has no public web
// service to receive these files; the upload is a person's act in the SAT
// portal, and no leaf of this family pretends otherwise. Also missing: `catalog
// match|apply|diff`. Un comando que existe y no hace lo que su fila promete es
// peor que su ausencia.
//
// MNE-001-054 (#328): `voucher generate` and `subledger generate`, the files
// the SAT asks for on request, live in e-accounting-request-command.ts and
// reuse this file's helpers (the `-o` rule, the overwrite prompt, the receipt
// and the unsealed notice), passed in below.
//
// ── LA REGLA DE LA CASA SOBRE LA e.firma GOBIERNA ESTE ARCHIVO ──
//
// La e.firma JAMÁS se pide por chat y este sistema NO sella salvo que el
// despacho lo declare; con el criterio por omisión
// (`efirma_sellado_contabilidad_electronica` = `nunca_sellar_en_el_sistema`)
// el generador produce el XML SIN SELLAR y se detiene ahí. No branch of this
// file reads a private key: the `seal` leaves go through seal.ts, which reads
// it only inside withCredential and refuses before that under any other value.
//
// Por eso las dos hojas de generación GRITAN lo que hicieron y lo que NO:
// «este archivo no va sellado y NADA se presentó ante el SAT», con los pasos
// que faltan enumerados. El peor resultado posible de este tramo no es un XML
// mal formado —eso lo caza el validador—: es un contador que cierre la
// terminal creyendo que ya presentó.
//
// ── TRES DECISIONES QUE NO SON DE ESTILO ──
//
// LA PRIMERA · `-o/--output` AQUÍ NOMBRA EL XML, NO LA TABLA. En el resto del
// binario `-o` desvía la SALIDA RENDERIZADA a un archivo (kernel/output.ts).
// En las dos hojas `generate` nombra el destino del ARCHIVO QUE SE ENTREGA,
// que es lo que su fila del catálogo promete y lo único que alguien querría
// escribir en disco desde aquí. La consecuencia se maneja explícitamente: el
// recibo (una fila, con su hash y su cuenta de hallazgos) sigue saliendo por
// stdout en el formato que se pida, y `opts.output` NO se le pasa a `render`
// —si se le pasara, el sobre JSON pisaría el XML recién escrito—. En
// `balance check`, que no produce XML, `-o` conserva su significado del núcleo.
//
// LA SEGUNDA · LA ÚNICA CONFIRMACIÓN DE ESTE TRAMO ES SOBRESCRIBIR CON `-o`.
// Todo lo demás que estas hojas escriben es idempotente por hash
// (artefactos.ts): regenerar sin cambios devuelve la fila que ya estaba. El
// archivo en disco es la excepción, y en esta casa es la peligrosa: el sellado
// ocurre FUERA del sistema y por otra mano, así que el .XML que hay en esa
// ruta puede ser el que ya se firmó con la e.firma. Reemplazarlo en silencio
// por uno sin sellar es exactamente la confusión que este tramo existe para
// impedir. Con `--yes` no pregunta; sin TTY tampoco pregunta y ABORTA (10),
// que es como debe fallar una compuerta que el agente puede alcanzar.
//
// LA TERCERA · LAS DOS `generate` SON ESCRITURA + IA ✓ CON `draftOnly`, Y ES
// LITERAL. Lo único que escriben es `sat_anexo24_artefactos`: un documento
// archivado con su hash, que nadie ha firmado y que nadie ha transmitido. No
// hay camino desde aquí al mayor, ni a una autoridad, ni a una credencial, por
// ninguna bandera. Lo peor que el agente puede hacer con ellas es dejar un
// archivo que un humano tendrá que mirar antes de firmarlo — que es la misma
// razón por la que `bank statement import` es ✓ (ver su cabecera). The `seal`
// leaves sign in the taxpayer's name, so they are agent ✗; filing with the SAT
// has no leaf at all, because the SAT offers no web service for it.
// ============================================================

export interface EAccountingCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de sobrescritura de `-o`. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seam: the voucher and auxiliary engine (MNE-001-054). */
  requestFileEngine?: RequestFileEngine;
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
}

const MARK = { bloquea: '✘', avisa: '⚠', limpio: '✔' } as const;

// ------------------------------------------------------------
// LO QUE FALTA PARA PRESENTAR, DICHO SIEMPRE Y CON TODAS SUS LETRAS
// ------------------------------------------------------------

// The headline and the steps speak by key (MNE-001-225, I8.7): the person
// reads them in their language, and es-MX, the default, reads them word for
// word as before. The receipt's copy of the steps stays English, for scripts.

/**
 * The steps still to do, in the order they happen. A list that shrinks by
 * accident leaves the reader believing they are done, which is the defect
 * this list exists to prevent, so the test pins it.
 *
 * They name no command of this binary on purpose: the upload has no command
 * (the SAT offers no web service for it), and the seal leaf applies only
 * under sellar_con_custodia, so a step that names it would mislead the firm
 * on the default.
 */
const STEP_KEYS: readonly TranslationKey[] = [
  'fiscal_mx.e_accounting.unsealed.step_review',
  'fiscal_mx.e_accounting.unsealed.step_seal',
  'fiscal_mx.e_accounting.unsealed.step_upload',
  'fiscal_mx.e_accounting.unsealed.step_acknowledgements',
];

/**
 * The steps as the receipt carries them (`falta_para_presentar`, and the
 * request leaves' `still_to_file`): English under every locale, because
 * --json and csv are read by scripts. The table renders them in the user's
 * language through `stepsLabel`.
 */
export const PASOS_PARA_PRESENTAR: readonly string[] = Object.freeze(STEP_KEYS.map((k) => t(k, {}, 'en')));

/** The receipt's `destino` when no file was written: English in the row. */
const TARGET_PLACEHOLDERS: readonly TranslationKey[] = ['e_accounting.target.dry_run', 'e_accounting.target.store'];

/** The table's label of a stored `destino`: a placeholder in the user's language; a path passes through. */
export function targetLabel(value: string): string {
  const key = TARGET_PLACEHOLDERS.find((k) => t(k, {}, 'en') === value);
  return key === undefined ? value : t(key);
}

/** The table's label of the stored step list: the same steps in the user's language. */
export function stepsLabel(value: string): string {
  return value === JSON.stringify(PASOS_PARA_PRESENTAR) ? JSON.stringify(STEP_KEYS.map((k) => t(k))) : value;
}

/** El bloque completo, para la salida legible. */
function bloqueSinSello(c: Palette): string {
  const lineas = [
    '',
    c.yellow(`  ⚠ ${t('fiscal_mx.e_accounting.unsealed.headline')}`),
    c.dim(`    ${t('fiscal_mx.e_accounting.unsealed.two_hands')}`),
    '',
    ...STEP_KEYS.map((k, i) => c.dim(`    ${i + 1}. ${t(k)}`)),
    '',
  ];
  return lineas.join('\n');
}

// ------------------------------------------------------------
// EL MES QUE SE DECLARA
// ------------------------------------------------------------

const MES_RE = /^(\d{4})-(\d{2})$/;

/**
 * `--period` del catálogo de cuentas, reducido al año y al mes que el archivo
 * declara.
 *
 * Se exige y no se supone. El CtaCatalogo lleva `Mes` y `Anio` en su cabecera
 * y no hay omisión razonable: adivinar «el mes en curso» es como alguien
 * archiva enero creyendo que archivó diciembre, y el error sólo se ve cuando
 * la balanza se coteja contra un catálogo del mes equivocado. Es la misma
 * negativa que `resolverPeriodoDeBalanza` ya hace del otro lado de la familia.
 *
 * NO acepta trimestre, ejercicio ni rango: `2026-Q1` y `FY2026` son
 * expresiones válidas del diccionario que este archivo no puede declarar —no
 * hay dónde ponerlas—, así que se rechazan por nombre en vez de colapsarse en
 * un mes cualquiera.
 */
export function mesDelCatalogo(expr: string | undefined): { anio: number; mes: number } {
  if (expr === undefined || expr.trim() === '') {
    throw usageError({ key: 'fiscal_mx.e_accounting.catalog.period_missing' });
  }
  const m = MES_RE.exec(expr.trim());
  if (!m) {
    throw usageError({ key: 'fiscal_mx.e_accounting.catalog.period_not_month', params: { value: expr } });
  }
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) {
    throw usageError({ key: 'fiscal_mx.e_accounting.catalog.month_out_of_range', params: { value: expr } });
  }
  return { anio, mes };
}

/** `--type N|C`, con el vocabulario que la fila del catálogo fija. */
export function exigirTipoDeEnvio(valor: string | undefined): 'N' | 'C' | undefined {
  if (valor === undefined) return undefined;
  const t = valor.trim().toUpperCase();
  if (t === 'N' || t === 'C') return t;
  throw usageError({ key: 'fiscal_mx.e_accounting.balance.type_unknown', params: { value: valor } });
}

/** `--check a,b`, contra la lista publicada. */
export function exigirChecksDeBalanza(valor: string): BalanzaCheckName[] {
  const pedidos = valor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const desconocidos = pedidos.filter(
    (p) => !(BALANZA_CHECK_NAMES as readonly string[]).includes(p)
  );
  if (desconocidos.length > 0) {
    // Un nombre desconocido es error de USO (2), nunca un filtro vacío que
    // sale 0: un `check` que no verificó nada y contesta «limpio» es la
    // manera exacta en que una tubería verde miente.
    throw usageError({
      key: 'fiscal_mx.e_accounting.balance.check_unknown',
      params: { count: desconocidos.length, unknown: desconocidos.join(', '), available: BALANZA_CHECK_NAMES.join(', ') },
    });
  }
  if (pedidos.length === 0) {
    throw usageError({
      key: 'fiscal_mx.e_accounting.balance.check_empty',
      params: { available: BALANZA_CHECK_NAMES.join(', ') },
    });
  }
  return pedidos as BalanzaCheckName[];
}

// ------------------------------------------------------------
// LAS FILAS QUE SALEN
// ------------------------------------------------------------

/** Un hallazgo del catálogo, como fila: la regla, su peso y SU CUENTA. */
export function filaDeHallazgoDeCatalogo(h: Hallazgo): Row {
  return {
    regla: h.regla,
    severity: h.severidad === 'bloquea' ? 'blocking' : 'warning',
    procedencia: h.procedencia,
    referencia: h.numCta ?? '',
    detalle: h.mensaje,
  };
}

/**
 * What a chart, balance or request-file finding reads as on screen: by key,
 * in the reader's language, when it has one (#608); its prose otherwise. The rows
 * keep the text the finding was built with, English for a keyed one like the
 * rest of the receipt. A keyed cause inside one renders in the same language
 * (MNE-001-775).
 */
function findingText(prose: string, messageKey: KeyedText | undefined): string {
  return messageKey === undefined ? prose : textIn(messageKey, getLanguage());
}

/** Un hallazgo de la balanza, como fila. `referencia` es el NumCta. */
export function filaDeHallazgoDeBalanza(h: HallazgoBalanza): Row {
  return {
    check: h.check,
    severity: h.severity,
    referencia: h.referencia,
    detalle: h.detalle,
  };
}

/**
 * El recibo del catálogo: UNA fila con todo lo que hace falta para saber qué
 * se generó y si se puede entregar. Los hallazgos viajan anidados —como
 * `closing preview` hace con su listeza— para que `--json` no pierda el
 * detalle que la tabla no cabe.
 */
export function reciboDeCatalogo(r: ResultadoGeneracionCatalogo, destino: string): Row {
  return {
    hash: r.hash ?? '',
    rfc: r.rfc,
    anio: r.anio,
    mes: String(r.mes).padStart(2, '0'),
    cuentas: r.filas.length,
    omitidas: r.omitidas.length,
    sin_agrupador: r.sinAgrupador.length,
    bytes: r.bytes,
    entregable: r.puedeEntregarse,
    sellado: r.sellado,
    archivado: r.artefacto === null ? 'no' : r.artefacto.yaExistia ? 'ya-existia' : 'nuevo',
    artefacto: r.artefacto?.id ?? '',
    destino,
    criterio_niveles: r.politicas.niveles,
    criterio_sin_agrupador: r.politicas.sinAgrupador,
    criterio_sellado: r.politicas.sellado,
    nota_sellado: r.notaDeSellado,
    falta_para_presentar: [...PASOS_PARA_PRESENTAR],
    hallazgos: r.hallazgos.map(filaDeHallazgoDeCatalogo),
  };
}

/** El recibo de la balanza. Misma forma que el del catálogo, a propósito. */
export function reciboDeBalanza(b: BalanzaGenerada, destino: string): Row {
  return {
    hash: b.hash,
    archivo: b.nombre,
    rfc: b.meta.rfc,
    anio: b.meta.anio,
    mes: b.meta.mes,
    tipo_envio: b.meta.tipo_envio,
    cierre: b.meta.cierre,
    periodo: b.meta.period_name,
    desde: dateOnly(b.meta.desde),
    hasta: dateOnly(b.meta.hasta),
    cuentas: b.meta.cuentas,
    bytes: b.bytes,
    sellada: b.meta.sellada,
    // Un SaldoIni que todavía puede cambiar es una balanza que mañana sería
    // otra: se publica en la fila, no sólo en la prosa.
    saldo_inicial_origen: b.inicial.origen,
    saldo_inicial_firme: b.inicial.firme,
    archivado: b.artefacto === null ? 'no' : b.artefacto.yaExistia ? 'ya-existia' : 'nuevo',
    artefacto: b.artefacto?.id ?? '',
    destino,
    criterio_niveles: b.meta.criterio_niveles,
    criterio_sellado: b.meta.criterio_sellado,
    falta_para_presentar: [...PASOS_PARA_PRESENTAR],
    hallazgos: b.hallazgos.map(filaDeHallazgoDeBalanza),
  };
}

/** Las líneas legibles de una lista de hallazgos, con su marca y su cuenta. */
export function renderHallazgos(
  hallazgos: readonly { severity: string; nombre: string; referencia: string; detalle: string }[],
  c: Pick<Palette, 'dim' | 'red' | 'yellow'>
): string[] {
  if (hallazgos.length === 0) return [];
  const ancho = Math.max(...hallazgos.map((h) => h.nombre.length));
  const anchoRef = Math.max(...hallazgos.map((h) => h.referencia.length));
  return hallazgos.map((h) => {
    const bloquea = h.severity === 'blocking';
    const marca = bloquea ? MARK.bloquea : MARK.avisa;
    const peso = bloquea ? '[blocking]' : '[warning] ';
    const linea = `  ${marca} ${h.nombre.padEnd(ancho)}  ${h.referencia.padEnd(anchoRef)}  ${peso}  ${h.detalle}`;
    return bloquea ? c.red(linea) : c.yellow(linea);
  });
}

// ------------------------------------------------------------
// EL REGISTRO
// ------------------------------------------------------------

export function registerEAccountingCommand(
  program: Command,
  deps: EAccountingCommandDeps
): void {
  const familia = describeCommand(
    program.command('e-accounting').alias('contabilidad-electronica'),
    'help.e_accounting.description'
  );

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // Tenant PRIMERO, como en toda la familia: bajo RLS una conexión sin
  // app.current_tenant ve cero filas en legal_entities.
  const entidadDeLectura = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
    return ctx;
  };

  const entidadDeEscritura = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  /**
   * La gramática de «sí» es UNA en todo el CLI y entiende los dos idiomas:
   * sale del núcleo (`confirmarConReintento`), nunca de un predicado local.
   * Sin TTY no pregunta y contesta que no: una stdin cerrada jamás es
   * consentimiento.
   */
  const preguntar = async (pregunta: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(pregunta);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        deps.palette.cyan(yesNoPrompt(pregunta))
      );
      if (veredicto.incomprendida !== undefined) {
        process.stderr.write(`${t('bank.confirm.taken_as_no', { reason: noEntendi(veredicto.incomprendida) })}\n`);
      }
      return veredicto.si;
    } finally {
      rl.close();
    }
  };

  /**
   * ¿Toca la ficha escrita a mano, o cede a `render`? La misma regla que
   * `closing` y `depreciation`: `--format` nace con valor 'table', así que se
   * compara contra él, y un `--fields` declarado que sólo se leyera en json
   * sería una promesa incumplida.
   *
   * `-o` NO cuenta en las dos `generate`: allí nombra el XML y no la salida,
   * así que pedir el archivo no debe apagar la ficha legible de la terminal.
   */
  const legible = (opts: CommonOpts, outputEsElXml = false): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    (outputEsElXml || opts.output === undefined) &&
    opts.fields === undefined;

  /**
   * En las dos `generate`, `-o` nombra el XML y no la salida renderizada
   * (primera decisión de la cabecera). La descripción que inyecta `withOutput`
   * dice lo contrario, y una ayuda que promete algo distinto de lo que el
   * código hace es la clase de mentira que este repositorio ya cazó en
   * `ap reconcile`. Se corrige la DESCRIPCIÓN de esta hoja; la grafía y la
   * forma corta las sigue gobernando el diccionario y no se tocan.
   */
  const outputNombraElXml = (cmd: Command, key: TranslationKey): void => {
    const opcion = cmd.options.find((o) => o.long === '--output');
    if (opcion) describeOption(opcion, key);
  };

  /**
   * Lo que la ayuda tiene que decir ANTES de que alguien ejecute el comando.
   * El aviso en tiempo de ejecución ya está, pero quien lee `--help` está
   * decidiendo si esto presenta por él, y ésa es la pregunta que hay que
   * contestar antes y no después.
   */
  const avisoDeAyuda = (cmd: Command): void => {
    cmd.addHelpText(
      'after',
      '\nThis builds the file. It does NOT seal it and does NOT file it.\n' +
        'The XML comes out with no Sello, noCertificado or Certificado.\n' +
        'generate never loads a private key. Sealing is yours, or `seal` under\n' +
        'sellar_con_custodia; uploading\n' +
        'through the Buzón Tributario in the SAT portal is always yours.\n'
    );
  };

  /**
   * EJEMPLOS DE AYUDA. Invocaciones copiables, no plantillas: cada una parsea
   * contra el commander embarcado (lo comprueba tests/cli/ejemplos-de-ayuda.spec.ts)
   * y sus valores salen del vocabulario cerrado que el propio marcador deletrea.
   * Van aparte de `avisoDeAyuda`, que dice lo que el comando NO hace; esto dice
   * cómo se teclea.
   */
  const EJEMPLOS = {
    catalogGenerate: `
Examples:
  # See the verdict before anything is archived: it builds the CtaCatalogo and
  # names the accounts that would block it, writing nothing.
  mnemosine e-accounting catalog generate --period 2026-07 --dry-run
  # The real run, with a copy of the XML next to the archived one.
  mnemosine e-accounting catalog generate --period 2026-07 -o catalogo-2026-07.xml --yes
`,
    balanceGenerate: `
Examples:
  # The monthly balance, shown and checked before it is archived.
  mnemosine e-accounting balance generate --period 2026-07 --dry-run
  # An amended filing: type C needs the date the balance it replaces was modified.
  mnemosine e-accounting balance generate --period 2026-07 --type C --modified 2026-09-15 --yes
  # The year-end balance, filed as month 13. With --closing the period names the
  # FISCAL YEAR: it declares the closing adjustments, not December again.
  mnemosine e-accounting balance generate --period 2026 --closing --yes
`,
    catalogSeal: `
Examples:
  # Seal the catalog you generated and reviewed for July, and keep a copy of it.
  # Only under efirma_sellado_contabilidad_electronica = sellar_con_custodia.
  mnemosine e-accounting catalog seal --period 2026-07 -o catalogo-2026-07-sellado.xml
`,
    balanceSeal: `
Examples:
  # Seal the archived July balance. Nothing is filed: upload it in the SAT portal.
  mnemosine e-accounting balance seal --period 2026-07
  # The year-end balance (month 13) of fiscal year 2026.
  mnemosine e-accounting balance seal --period 2026 --closing
`,
    balanceCheck: `
Examples:
  # Re-run what the authority re-runs over the month, before you seal anything.
  mnemosine e-accounting balance check --period 2026-07
  # The year-end balance, with warnings made blocking so cron stops on them (exit 4).
  mnemosine e-accounting balance check --period 2026 --closing --strict
`,
  };

  /** El recibo por stdout, SIN `output`: ese destino ya lo ocupa el XML. */
  const emitirRecibo = (fila: Row, opts: CommonOpts): void => {
    const { output: _output, ...sinDestino } = opts;
    render([fila], {
      ...sinDestino,
      idField: 'hash',
      labelled: { destino: targetLabel, falta_para_presentar: stepsLabel, still_to_file: stepsLabel },
    });
  };

  /**
   * Escribe el XML donde se pidió.
   *
   * Crea el directorio si falta —pedir un destino y que falle por una carpeta
   * inexistente es fricción sin ganancia— y sólo pregunta cuando va a PISAR
   * algo: ver la segunda decisión de la cabecera. Los bytes salen de
   * `bytesDe`, que son exactamente los que se hashearon: si el disco y el
   * hash pudieran discrepar, el hash no serviría para nada.
   */
  const escribirXml = async (
    destino: string,
    xml: string,
    opts: { yes?: boolean }
  ): Promise<void> => {
    if (existsSync(destino) && opts.yes !== true) {
      const si = await preguntar(t('fiscal_mx.e_accounting.output.overwrite_question', { target: destino }));
      if (!si) {
        throw abortedByUser({ key: 'fiscal_mx.e_accounting.output.kept', params: { target: destino } });
      }
    }
    const carpeta = path.dirname(path.resolve(destino));
    mkdirSync(carpeta, { recursive: true });
    writeFileSync(destino, bytesDe(xml));
  };

  // ==========================================================
  // catalog · catalogo
  // ==========================================================
  const catalogo = describeCommand(familia.command('catalog').alias('catalogo'), 'help.e_accounting.catalog.description');

  // ---- catalog generate ------------------------------------
  const generarCatalogo = describeCommand(
    catalogo.command('generate').alias('generar'),
    'help.e_accounting.catalog.generate.description'
  );
  withContext(generarCatalogo);
  withOutput(generarCatalogo);
  optionByKey(generarCatalogo, '--period <YYYY-MM>', 'help.e_accounting.catalog.generate.option.period');
  optionByKey(generarCatalogo, '--dry-run', 'help.e_accounting.catalog.generate.option.dry_run');
  optionByKey(generarCatalogo, '-y, --yes', 'help.e_accounting.catalog.generate.option.yes');
  outputNombraElXml(generarCatalogo, 'help.e_accounting.catalog.generate.option.output');
  avisoDeAyuda(generarCatalogo);
  generarCatalogo.addHelpText('after', EJEMPLOS.catalogGenerate);
  // ESCRITURA + IA ✓ con `draftOnly`, y aquí es literal: lo único que escribe
  // es `sat_anexo24_artefactos`, un documento archivado por su hash que nadie
  // ha firmado ni transmitido. Ver la tercera decisión de la cabecera.
  declareRisk(generarCatalogo, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes:
      'sat_anexo24_artefactos (the archived XML with its hash, UNSEALED); no journal entry, ' +
      'nothing sent to the authority',
  });
  generarCatalogo.action(
    (opts: CommonOpts & { period?: string; dryRun?: boolean; yes?: boolean }, cmd: Command) =>
      run(async () => {
        const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
        // El mes se valida ANTES de tocar la base: un typo en --period no
        // debería costar una conexión ni una resolución de entidad.
        const { anio, mes } = mesDelCatalogo(opts.period);
        const ctx = await entidadDeEscritura(opts);
        const revisor = await resolveReviewer(ctx.tenantId, opts.user);

        const r = await generarCatalogoCuentas(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          { entityId: ctx.entityId, anio, mes, userId: revisor.userId, dryRun }
        );

        // English in the receipt; `targetLabel` renders it for a person.
        const destino = dryRun
          ? t('e_accounting.target.dry_run', {}, 'en')
          : (opts.output ?? t('e_accounting.target.store', {}, 'en'));
        // Sólo se escribe lo que SE PUEDE ENTREGAR. Dejar en disco un XML que
        // el propio generador declara no entregable es sembrar el archivo que
        // alguien firmará por equivocación dentro de tres semanas.
        if (opts.output !== undefined && !dryRun && r.xml !== null && r.puedeEntregarse) {
          await escribirXml(opts.output, r.xml, opts);
        }

        const c = deps.palette;
        const out = process.stdout;
        const err = process.stderr;

        if (!legible(opts, true)) {
          emitirRecibo(reciboDeCatalogo(r, destino), opts);
        } else {
          out.write(
            `\n${c.bold(`CtaCatalogo ${String(mes).padStart(2, '0')}/${anio}`)}  ` +
              `${c.dim(t('fiscal_mx.e_accounting.catalog.summary', { rfc: r.rfc, accounts: r.filas.length, bytes: r.bytes }))}\n`
          );
          out.write(
            c.dim(
              `  ${t('fiscal_mx.e_accounting.catalog.policies', {
                levels: r.politicas.niveles,
                ungrouped: r.politicas.sinAgrupador,
                sealing: r.politicas.sellado,
              })}\n`
            )
          );
          if (r.hash !== null) out.write(c.dim(`  sha256 ${r.hash}\n`));
          out.write(c.dim(`  ${t('e_accounting.target.label', { target: targetLabel(destino) })}\n`));
          if (r.omitidas.length > 0) {
            out.write(c.dim(`  ${t('fiscal_mx.e_accounting.catalog.omitted', { count: r.omitidas.length })}\n`));
          }
        }

        // Los hallazgos SIEMPRE se dicen, en los dos modos: en el legible como
        // lista, en el de máquina anidados en el recibo (arriba) y aquí por
        // stderr, que es donde viven las notas y donde no ensucian un pipe.
        const lineas = renderHallazgos(
          r.hallazgos.map((h) => ({
            severity: h.severidad === 'bloquea' ? 'blocking' : 'warning',
            nombre: h.regla,
            referencia: h.numCta ?? '',
            detalle: findingText(h.mensaje, h.messageKey),
          })),
          c
        );
        if (lineas.length > 0) {
          err.write('\n');
          for (const l of lineas) err.write(`${l}\n`);
        }

        if (!r.puedeEntregarse) {
          // No hay archivo. Se dice por qué y se sale 4: un 0 aquí sería la
          // clase de verde que hace que nadie mire la salida.
          const ungrouped = r.sinAgrupador.length > 0 && r.politicas.sinAgrupador === 'bloquear';
          err.write(
            '\n' +
              c.red(
                `  ${t('fiscal_mx.e_accounting.catalog.not_deliverable', {
                  reason: ungrouped ? 'ungrouped' : 'findings',
                  count: r.sinAgrupador.length,
                  policy: 'anexo24_cuenta_sin_agrupador',
                  value: 'bloquear',
                  hint: changePolicyHint('anexo24_cuenta_sin_agrupador'),
                })}`
              ) +
              '\n\n'
          );
          return ExitCode.VALIDATION;
        }

        err.write(bloqueSinSello(c));
        if (r.politicas.sellado !== 'nunca_sellar_en_el_sistema') {
          err.write(c.yellow(`    ${r.notaDeSellado}\n\n`));
        }
        if (dryRun) {
          err.write(c.dim(`  ${t('e_accounting.dry_run.done')}\n\n`));
        } else if (r.artefacto?.yaExistia === true) {
          err.write(c.dim(`  ${t('e_accounting.archive.already_there')}\n\n`));
        }
        return ExitCode.OK;
      })
  );

  // ==========================================================
  // balance · balanza
  // ==========================================================
  const balanza = describeCommand(familia.command('balance').alias('balanza'), 'help.e_accounting.balance.description');

  /** La cabecera común de las dos hojas de balanza. */
  const cabeceraDeBalanza = (
    meta: { rfc: string; mes: string; anio: number; tipo_envio: string; cierre: boolean;
      period_name: string; desde: string; hasta: string; cuentas: number;
      criterio_niveles: string; criterio_sellado: string },
    inicial: { origen: string; firme: boolean }
  ): string => {
    const c = deps.palette;
    return (
      `\n${c.bold(t('fiscal_mx.e_accounting.balance.title', { month: meta.mes, year: meta.anio }))}  ` +
      c.dim(
        t('fiscal_mx.e_accounting.balance.header', {
          rfc: meta.rfc,
          closing: meta.cierre ? 'yes' : 'no',
          type: meta.tipo_envio,
          period: meta.period_name,
          from: dateOnly(meta.desde),
          to: dateOnly(meta.hasta),
          accounts: meta.cuentas,
        })
      ) +
      '\n' +
      c.dim(
        `  ${t('fiscal_mx.e_accounting.balance.header_policies', {
          levels: meta.criterio_niveles,
          sealing: meta.criterio_sellado,
          origin: inicial.origen,
          firm: inicial.firme ? 'yes' : 'no',
        })}`
      ) +
      '\n'
    );
  };

  // ---- balance generate ------------------------------------
  const generarBalanzaHoja = describeCommand(
    balanza.command('generate').alias('generar'),
    'help.e_accounting.balance.generate.description'
  );
  withContext(generarBalanzaHoja);
  withOutput(generarBalanzaHoja);
  optionByKey(generarBalanzaHoja, '--period <expr>', 'help.e_accounting.balance.generate.option.period');
  optionByKey(generarBalanzaHoja, '--type <N|C>', 'help.e_accounting.balance.generate.option.type', {
    defaultValue: 'N',
  });
  optionByKey(generarBalanzaHoja, '--closing', 'help.e_accounting.balance.generate.option.closing');
  optionByKey(generarBalanzaHoja, '--modified <date>', 'help.e_accounting.balance.generate.option.modified');
  optionByKey(generarBalanzaHoja, '--dry-run', 'help.e_accounting.balance.generate.option.dry_run');
  optionByKey(generarBalanzaHoja, '-y, --yes', 'help.e_accounting.balance.generate.option.yes');
  outputNombraElXml(generarBalanzaHoja, 'help.e_accounting.balance.generate.option.output');
  avisoDeAyuda(generarBalanzaHoja);
  generarBalanzaHoja.addHelpText('after', EJEMPLOS.balanceGenerate);
  // ESCRITURA + IA ✓ con `draftOnly`, por lo mismo que su hermana.
  declareRisk(generarBalanzaHoja, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes:
      'sat_anexo24_artefactos (the archived XML with its hash, UNSEALED); no journal entry, ' +
      'nothing sent to the authority',
  });
  generarBalanzaHoja.action(
    (
      opts: CommonOpts & {
        period?: string;
        type?: string;
        closing?: boolean;
        modified?: string;
        dryRun?: boolean;
        yes?: boolean;
      },
      cmd: Command
    ) =>
      run(async () => {
        const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
        const tipo = exigirTipoDeEnvio(opts.type);
        const ctx = await entidadDeEscritura(opts);
        const revisor = await resolveReviewer(ctx.tenantId, opts.user);

        const b = await generarBalanza(ctx.entityId, {
          ...(opts.period !== undefined ? { periodo: opts.period } : {}),
          ...(tipo !== undefined ? { tipo } : {}),
          ...(opts.closing === true ? { cierre: true } : {}),
          ...(opts.modified !== undefined ? { fechaModBal: opts.modified } : {}),
          generadoPor: revisor.userId,
          dryRun,
        });

        // English in the receipt; `targetLabel` renders it for a person.
        const destino = dryRun
          ? t('e_accounting.target.dry_run', {}, 'en')
          : (opts.output ?? t('e_accounting.target.store', {}, 'en'));
        if (opts.output !== undefined && !dryRun) {
          await escribirXml(opts.output, b.xml, opts);
        }

        const c = deps.palette;
        const out = process.stdout;
        const err = process.stderr;

        if (!legible(opts, true)) {
          emitirRecibo(reciboDeBalanza(b, destino), opts);
        } else {
          out.write(cabeceraDeBalanza(b.meta, b.inicial));
          out.write(c.dim(`  ${t('fiscal_mx.e_accounting.balance.suggested_file', { file: b.nombre, bytes: b.bytes })}\n`));
          out.write(c.dim(`  sha256 ${b.hash}\n`));
          out.write(c.dim(`  ${t('e_accounting.target.label', { target: targetLabel(destino) })}\n`));
        }

        const lineas = renderHallazgos(
          b.hallazgos.map((h) => ({
            severity: h.severity,
            nombre: h.check,
            referencia: h.referencia,
            detalle: h.detalle,
          })),
          c
        );
        if (lineas.length > 0) {
          err.write('\n');
          for (const l of lineas) err.write(`${l}\n`);
        }
        if (!b.inicial.firme) {
          err.write(c.yellow(`\n  ⚠ ${b.inicial.note}\n`));
        }

        err.write(bloqueSinSello(c));
        if (b.meta.criterio_sellado !== 'nunca_sellar_en_el_sistema') {
          err.write(
            c.yellow(
              `    ${t('e_accounting.sealing.declared', { policy: b.meta.criterio_sellado })} ` +
                `${t('fiscal_mx.e_accounting.balance.seal_hint', { command: '`e-accounting balance seal`' })}\n\n`
            )
          );
        }
        if (dryRun) {
          err.write(c.dim(`  ${t('e_accounting.dry_run.done')}\n\n`));
        } else if (b.artefacto?.yaExistia === true) {
          err.write(c.dim(`  ${t('e_accounting.archive.already_there')}\n\n`));
        }
        // Las bloqueantes no llegan hasta aquí: `generarBalanza` se niega y
        // lanza (422 → 4). Lo que sobrevive son avisos, y un aviso no impide
        // entregar. `balance check --strict` es donde se endurecen.
        return ExitCode.OK;
      })
  );

  // ---- balance check ---------------------------------------
  const verificar = describeCommand(
    balanza.command('check').alias('verificar'),
    'help.e_accounting.balance.check.description'
  );
  withContext(verificar);
  withOutput(verificar);
  withStrict(verificar);
  optionByKey(verificar, '--period <expr>', 'help.e_accounting.balance.check.option.period');
  // `--closing` también aquí, aunque su fila sólo liste cuatro banderas: una
  // balanza de cierre que se puede GENERAR y no se puede VERIFICAR es un
  // archivo que sólo se revisa cuando la autoridad lo rechaza.
  optionByKey(verificar, '--closing', 'help.e_accounting.balance.check.option.closing');
  optionByKey(verificar, '--check [names]', 'help.e_accounting.balance.check.option.check');
  // --type/--modified as in `generate`: an amended balance (C with FechaModBal)
  // is other bytes, and whether it was sealed is asked of those bytes.
  optionByKey(verificar, '--type <N|C>', 'help.e_accounting.balance.check.option.type', { defaultValue: 'N' });
  optionByKey(verificar, '--modified <date>', 'help.e_accounting.balance.check.option.modified');
  // LECTURA: no escribe, no genera y no archiva. IA ✓ sin más condiciones.
  declareRisk(verificar, { risk: 'lectura', agent: true });
  verificar.addHelpText('after', EJEMPLOS.balanceCheck);
  verificar.action(
    (
      opts: CommonOpts & {
        period?: string;
        closing?: boolean;
        type?: string;
        modified?: string;
        check?: string | boolean;
        strict?: boolean;
      }
    ) =>
      run(async () => {
        // `--check` a secas: el registro, SIN tocar la base. Preguntar «¿qué se
        // puede verificar?» no debería costar una conexión (el criterio de
        // `closing check` y de `bank statement check`).
        if (opts.check === true) {
          render(
            BALANZA_CHECK_NAMES.map((n) => ({ check: n })),
            { ...opts, idField: 'check' }
          );
          return ExitCode.OK;
        }
        const pedidos =
          typeof opts.check === 'string' ? exigirChecksDeBalanza(opts.check) : undefined;

        const envelopeType = exigirTipoDeEnvio(opts.type);
        const ctx = await entidadDeLectura(opts);
        const r: ResultadoDeVerificacion = await verificarBalanza(ctx.entityId, {
          ...(opts.period !== undefined ? { periodo: opts.period } : {}),
          ...(opts.closing === true ? { cierre: true } : {}),
          ...(envelopeType !== undefined ? { tipo: envelopeType } : {}),
          ...(opts.modified !== undefined ? { fechaModBal: opts.modified } : {}),
          ...(pedidos !== undefined ? { checks: pedidos } : {}),
        });

        const c = deps.palette;
        const out = process.stdout;

        if (!legible(opts)) {
          // Los hallazgos SON las filas: un csv de hallazgos con su cuenta y
          // su diferencia es el anexo que un preparador se lleva al cierre.
          // El sobre de la balanza —criterios, periodo, saldo inicial— va por
          // stderr, que es donde viven las notas.
          render(r.hallazgos.map(filaDeHallazgoDeBalanza), { ...opts, idField: 'check' });
          process.stderr.write(
            c.dim(
              `${t('fiscal_mx.e_accounting.balance.check_envelope', {
                rfc: r.meta.rfc,
                month: r.meta.mes,
                year: r.meta.anio,
                period: r.meta.period_name,
                accounts: r.meta.cuentas,
                checks: r.checks.join(','),
              })}\n`
            )
          );
        } else {
          out.write(cabeceraDeBalanza(r.meta, r.inicial));
          out.write(
            c.dim(
              `  ${t('fiscal_mx.e_accounting.balance.check_catalog', {
                found: r.catalogo === null ? 'no' : 'yes',
                source:
                  r.catalogo === null
                    ? ''
                    : `${r.catalogo.origen}${r.catalogo.referencia ? ` (${r.catalogo.referencia.slice(0, 12)})` : ''}`,
              })}\n`
            )
          );
          out.write(c.dim(`  ${t('fiscal_mx.e_accounting.balance.checks_run', { checks: r.checks.join(', ') })}\n\n`));
          const lineas = renderHallazgos(
            r.hallazgos.map((h) => ({
              severity: h.severity,
              nombre: h.check,
              referencia: h.referencia,
              detalle: findingText(h.detalle, h.messageKey),
            })),
            c
          );
          if (lineas.length === 0) {
            out.write(
              `  ${MARK.limpio} ${t('fiscal_mx.e_accounting.balance.check_clean', { count: r.checks.length })}\n\n`
            );
          } else {
            for (const l of lineas) out.write(`${l}\n`);
            out.write(
              '\n' +
                c.dim(
                  `  ${t('fiscal_mx.e_accounting.balance.check_summary', {
                    blocking: r.conteo.blocking,
                    warning: r.conteo.warning,
                  })}\n\n`
                )
            );
          }
        }

        // El contrato §4, y el 4 NO se inventa aquí: sale del núcleo.
        return checkExitCode(r.conteo, { strict: opts.strict });
      })
  );

  // ==========================================================
  // catalog seal · balance seal (EFIRMA-4, #442)
  //
  // Their own verb, not a `--seal` on `generate`: `generate` is agent ✓ with
  // draftOnly, and a seal is the taxpayer's signature (agent ✗). Permission
  // never depends on the value of a flag. What is sealed is the ARCHIVED file
  // the accountant generated and reviewed; nothing is filed with the SAT.
  // ==========================================================
  const sealLeaf = (parent: Command, document: SealableDocument): void => {
    const leaf = describeCommand(
      parent.command('seal').alias('sellar'),
      document === 'catalogo'
        ? 'help.e_accounting.catalog.seal.description'
        : 'help.e_accounting.balance.seal.description'
    );
    withContext(leaf);
    optionByKey(
      leaf,
      '--period <expr>',
      document === 'catalogo' ? 'help.e_accounting.catalog.seal.option.period' : 'help.e_accounting.seal.option.period'
    );
    if (document === 'balanza') {
      optionByKey(leaf, '--type <N|C>', 'help.e_accounting.seal.option.type');
      optionByKey(leaf, '--closing', 'help.e_accounting.seal.option.closing');
    }
    // `-o` names the sealed XML here, as in `generate`; the receipt still goes to stdout.
    withOutput(leaf);
    const outputOption = leaf.options.find((o) => o.long === '--output');
    if (outputOption) describeOption(outputOption, 'help.e_accounting.seal.option.output');
    leaf.addHelpText('after', document === 'catalogo' ? EJEMPLOS.catalogSeal : EJEMPLOS.balanceSeal);
    declareRisk(leaf, {
      risk: 'escritura',
      agent: false,
      writes:
        'sat_anexo24_artefactos (the sealed copy, sellado = true) and fiscal_credential_access_log ' +
        '(purpose seal_anexo24); nothing is sent to the SAT',
    });
    leaf.action(
      (opts: CommonOpts & { period?: string; type?: string; closing?: boolean; yes?: boolean }) =>
        run(async () => {
          const envelopeType = document === 'balanza' ? exigirTipoDeEnvio(opts.type) : undefined;
          const catalogMonth = document === 'catalogo' ? mesDelCatalogo(opts.period) : undefined;
          const ctx = await entidadDeEscritura(opts);
          const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
          const period =
            catalogMonth ??
            (await resolverPeriodoDeBalanza(ctx.entityId, {
              ...(opts.period !== undefined ? { periodo: opts.period } : {}),
              ...(opts.closing === true ? { cierre: true } : {}),
            }));

          const sealed = await sealArchivedDocument({
            tenantId: ctx.tenantId,
            entityId: ctx.entityId,
            document,
            year: period.anio,
            month: Number(period.mes),
            envelopeType: envelopeType ?? 'N',
            actor: reviewer.email,
            userId: reviewer.userId,
          });
          if (opts.output !== undefined) await escribirXml(opts.output, sealed.xml, opts);

          emitirRecibo(
            {
              hash: sealed.artifact.hash_sha256,
              artefacto: sealed.artifact.id,
              sealed_from: sealed.sealedFrom,
              // The hash `generate` printed: the accountant checks it is the file they reviewed.
              sealed_from_hash: sealed.sourceHash,
              certificate_number: sealed.certificateNumber,
              bytes: sealed.artifact.bytes,
              destino: opts.output ?? '',
              filed_with_sat: false,
            },
            opts
          );
          const c = deps.palette;
          process.stderr.write(
            `\n  ${t('anexo24.seal.done', { certificate: sealed.certificateNumber })}\n` +
              c.yellow(`  ⚠ ${t('anexo24.seal.nothing_filed')}`) +
              '\n\n'
          );
          return ExitCode.OK;
        })
    );
  };
  sealLeaf(catalogo, 'catalogo');
  sealLeaf(balanza, 'balanza');

  registerRequestFileLeaves(familia, {
    palette: deps.palette,
    run,
    scopeForWrite: entidadDeEscritura,
    writeXml: escribirXml,
    emitReceipt: emitirRecibo,
    readable: (opts) => legible(opts, true),
    unsealedNotice: bloqueSinSello,
    findingLines: renderHallazgos,
    findingText,
    stepsToFile: PASOS_PARA_PRESENTAR,
    helpNotice: avisoDeAyuda,
    ...(deps.requestFileEngine !== undefined ? { engine: deps.requestFileEngine } : {}),
  });
}
