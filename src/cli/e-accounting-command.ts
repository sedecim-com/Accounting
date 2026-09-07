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
  verificarBalanza,
  type BalanzaGenerada,
  type ResultadoDeVerificacion,
} from '../services/sat/anexo24/balanza-service.js';
import {
  BALANZA_CHECK_NAMES,
  type BalanzaCheckName,
  type HallazgoBalanza,
} from '../services/sat/anexo24/balanza-invariantes.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
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

// ============================================================
// mnemosine e-accounting · contabilidad-electronica — EL XML QUE SE ENTREGA
//
// TRES HOJAS, LAS TRES FILAS DE FASE 1 DEL CATÁLOGO (docs/cli-command-catalog.md
// 2060, 2063, 2064) Y NI UNA MÁS:
//
//   catalog generate · catalogo generar — el CtaCatalogo 1.3, con su hash
//   balance generate · balanza generar  — la balanza del periodo (N, C o cierre)
//   balance check    · balanza verificar— las invariantes que el SAT rehace
//
// LO QUE NO ESTÁ AQUÍ, Y NO POR FALTA DE TIEMPO: `catalog file` y
// `balance file`, que FIRMAN con la e.firma y TRANSMITEN al SAT; `catalog
// match|apply|diff`; `voucher generate` (a las pólizas les falta sustrato: el
// número de cheque no lo escribe nadie y la cuenta destino no existe en el
// esquema); `subledger generate`. Un comando que existe y no hace lo que su
// fila promete es peor que su ausencia.
//
// ── LA REGLA DE LA CASA SOBRE LA e.firma GOBIERNA ESTE ARCHIVO ──
//
// La e.firma JAMÁS se pide por chat y este sistema NO sella salvo que el
// despacho lo declare; con el criterio por omisión
// (`efirma_sellado_contabilidad_electronica` = `nunca_sellar_en_el_sistema`)
// el generador produce el XML SIN SELLAR y se detiene ahí. No hay en ninguna
// rama de este archivo una lectura de llave privada, y no debe haberla.
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
// razón por la que `bank statement import` es ✓ (ver su cabecera). Las filas
// que SÍ salen del sistema, `catalog file` y `balance file`, son irreversibles
// y IA ✗, y no están en este tramo.
// ============================================================

export interface EAccountingCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de sobrescritura de `-o`. */
  confirm?: (question: string) => Promise<boolean>;
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

/**
 * El titular. En español porque es la advertencia más importante del tramo y
 * la lee un despacho mexicano; las descripciones de commander siguen en
 * inglés, como manda la casa.
 */
export const TITULAR_SIN_SELLO =
  'ESTE ARCHIVO NO VA SELLADO Y NO SE PRESENTÓ NADA ANTE EL SAT.';

/**
 * Los pasos que quedan, en el orden en que ocurren. Se exportan para que la
 * prueba los fije: una lista que se acorta sin querer deja al lector creyendo
 * que ya terminó, que es el defecto que esta lista existe para impedir.
 *
 * No nombran ningún comando de este binario a propósito: `catalog file` y
 * `balance file` —las dos hojas que firman y transmiten— NO están construidas,
 * y mandar a alguien a un comando que no existe es la misma mentira en otra
 * forma.
 */
export const PASOS_PARA_PRESENTAR: readonly string[] = Object.freeze([
  'Revisa el XML: es el documento que vas a declarar, y una vez sellado ya no se toca.',
  'Séllalo con la e.firma del contribuyente FUERA de este sistema. Este binario no ' +
    'carga llaves privadas y nunca te va a pedir la e.firma por chat.',
  'Compríimelo y transmítelo tú por el Buzón Tributario (Contabilidad electrónica).',
  'Guarda el acuse de recepción y, después, el de aceptación o rechazo: es la única ' +
    'prueba de que se presentó.',
]);

/** El bloque completo, para la salida legible. */
function bloqueSinSello(c: Palette): string {
  const lineas = [
    '',
    c.yellow(`  ⚠ ${TITULAR_SIN_SELLO}`),
    c.dim('    Construir el archivo y firmarlo son actos distintos y de manos distintas.'),
    '',
    ...PASOS_PARA_PRESENTAR.map((p, i) => c.dim(`    ${i + 1}. ${p}`)),
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
    throw usageError(
      'El catálogo de cuentas se presenta por mes: indica --period YYYY-MM (por ejemplo ' +
        '--period 2026-02). Sin él no hay Mes ni Anio que declarar en la cabecera.'
    );
  }
  const m = MES_RE.exec(expr.trim());
  if (!m) {
    throw usageError(
      `--period «${expr}» no es un mes. El CtaCatalogo declara UN mes de UN ejercicio, así que ` +
        'aquí sólo vale la forma YYYY-MM (2026-02). Un trimestre, un ejercicio o un rango no ' +
        'tienen dónde ponerse en el archivo.'
    );
  }
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) {
    throw usageError(
      `--period «${expr}»: el mes ha de ir de 01 a 12. El 13 es de la balanza de cierre ` +
        '(`balance generate --closing`), no del catálogo de cuentas.'
    );
  }
  return { anio, mes };
}

/** `--type N|C`, con el vocabulario que la fila del catálogo fija. */
export function exigirTipoDeEnvio(valor: string | undefined): 'N' | 'C' | undefined {
  if (valor === undefined) return undefined;
  const t = valor.trim().toUpperCase();
  if (t === 'N' || t === 'C') return t;
  throw usageError(
    `--type «${valor}» no existe: N es la balanza normal y C la complementaria. ` +
      'La de cierre no es un tipo, es --closing (va con Mes 13).'
  );
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
    throw usageError(
      `Verificación(es) desconocida(s): ${desconocidos.join(', ')}. ` +
        `Las disponibles son: ${BALANZA_CHECK_NAMES.join(', ')}.`
    );
  }
  if (pedidos.length === 0) {
    throw usageError(
      `--check no nombró ninguna verificación. Las disponibles son: ${BALANZA_CHECK_NAMES.join(', ')}.`
    );
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
  const familia = program
    .command('e-accounting')
    .alias('contabilidad-electronica')
    .description('Mexican e-accounting (Anexo 24): build the XML the SAT expects, and check it');

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
        deps.palette.cyan(`${pregunta} [y/N] `)
      );
      if (veredicto.incomprendida !== undefined) {
        process.stderr.write(`${noEntendi(veredicto.incomprendida)}; lo tomo como no.\n`);
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
  const outputNombraElXml = (cmd: Command, que: string): void => {
    const opcion = cmd.options.find((o) => o.long === '--output');
    if (opcion) {
      opcion.description = `write the ${que} XML to this path (the artifact store keeps its own copy)`;
    }
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
        'The XML comes out with no Sello, noCertificado or Certificado: sealing with the\n' +
        "e.firma and transmitting through the Buzón Tributario are your acts, outside this\n" +
        'system. This binary never asks for an e.firma and never loads a private key.\n'
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
    render([fila], { ...sinDestino, idField: 'hash' });
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
      const si = await preguntar(
        `${destino} ya existe. Si ese archivo ya está sellado, sobrescribirlo lo deja sin sello. ` +
          '¿Lo reemplazo?'
      );
      if (!si) {
        throw abortedByUser(
          `No se escribió nada: ${destino} se conserva tal cual. Usa otra ruta, o --yes si de ` +
            'verdad quieres reemplazarlo.'
        );
      }
    }
    const carpeta = path.dirname(path.resolve(destino));
    mkdirSync(carpeta, { recursive: true });
    writeFileSync(destino, bytesDe(xml));
  };

  // ==========================================================
  // catalog · catalogo
  // ==========================================================
  const catalogo = familia
    .command('catalog')
    .alias('catalogo')
    .description('The chart of accounts as the SAT wants it: CtaCatalogo 1.3');

  // ---- catalog generate ------------------------------------
  const generarCatalogo = catalogo
    .command('generate')
    .alias('generar')
    .description(
      'Build and archive the CtaCatalogo 1.3 XML (NumCta, Desc, SubCtaDe, Nivel, Natur, CodAgrup) with its hash'
    );
  withContext(generarCatalogo);
  withOutput(generarCatalogo);
  generarCatalogo
    .option('--period <YYYY-MM>', 'month the catalog declares (Mes and Anio of its header)')
    .option('--dry-run', 'build it and show the verdict; archive nothing and write no file')
    .option('-y, --yes', 'skip the overwrite prompt when -o names an existing file');
  outputNombraElXml(generarCatalogo, 'CtaCatalogo');
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
      'sat_anexo24_artefactos (el XML archivado con su hash, SIN SELLAR); ninguna póliza, ' +
      'ningún envío a la autoridad',
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

        const destino = dryRun
          ? '(ensayo: no se escribió nada)'
          : (opts.output ?? '(almacén de artefactos)');
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
              `${c.dim(`RFC ${r.rfc} · ${r.filas.length} cuenta(s) · ${r.bytes} byte(s)`)}\n`
          );
          out.write(
            c.dim(
              `  niveles ${r.politicas.niveles} · sin agrupador ${r.politicas.sinAgrupador} · ` +
                `sellado ${r.politicas.sellado}\n`
            )
          );
          if (r.hash !== null) out.write(c.dim(`  sha256 ${r.hash}\n`));
          out.write(c.dim(`  destino ${destino}\n`));
          if (r.omitidas.length > 0) {
            out.write(c.dim(`  ${r.omitidas.length} cuenta(s) fuera del archivo\n`));
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
            detalle: h.mensaje,
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
          err.write(
            '\n' +
              c.red(
                '  No se generó ningún archivo entregable. ' +
                  (r.sinAgrupador.length > 0 && r.politicas.sinAgrupador === 'bloquear'
                    ? `${r.sinAgrupador.length} cuenta(s) del alcance no tienen código agrupador y ` +
                      "la política `anexo24_cuenta_sin_agrupador` está en 'bloquear'. " +
                      'Asígnalos, o cambia la política con ' +
                      '`mnemosine pending resolve anexo24_cuenta_sin_agrupador`.'
                    : 'Resuelve los hallazgos bloqueantes de arriba y vuelve a generar.')
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
          err.write(c.dim('  --dry-run: no se archivó nada y no se escribió ningún archivo.\n\n'));
        } else if (r.artefacto?.yaExistia === true) {
          err.write(
            c.dim(
              '  Estos mismos bytes ya estaban archivados: no se creó una versión nueva. ' +
                'El generador es determinista, que es lo que hace comparable un mes con otro.\n\n'
            )
          );
        }
        return ExitCode.OK;
      })
  );

  // ==========================================================
  // balance · balanza
  // ==========================================================
  const balanza = familia
    .command('balance')
    .alias('balanza')
    .description('The trial balance the SAT expects: BCE 1.3, normal, amended or year-end');

  /** La cabecera común de las dos hojas de balanza. */
  const cabeceraDeBalanza = (
    meta: { rfc: string; mes: string; anio: number; tipo_envio: string; cierre: boolean;
      period_name: string; desde: string; hasta: string; cuentas: number;
      criterio_niveles: string; criterio_sellado: string },
    inicial: { origen: string; firme: boolean }
  ): string => {
    const c = deps.palette;
    return (
      `\n${c.bold(`Balanza ${meta.mes}/${meta.anio}`)}  ` +
      c.dim(
        `RFC ${meta.rfc} · TipoEnvio ${meta.tipo_envio}${meta.cierre ? ' · cierre (Mes 13)' : ''} · ` +
          `${meta.period_name} ${dateOnly(meta.desde)} → ${dateOnly(meta.hasta)} · ` +
          `${meta.cuentas} cuenta(s)`
      ) +
      '\n' +
      c.dim(
        `  niveles ${meta.criterio_niveles} · sellado ${meta.criterio_sellado} · ` +
          `SaldoIni del ${inicial.origen}, ` +
          (inicial.firme ? 'firme' : 'TODAVÍA PUEDE CAMBIAR (el periodo anterior sigue abierto)')
      ) +
      '\n'
    );
  };

  // ---- balance generate ------------------------------------
  const generarBalanzaHoja = balanza
    .command('generate')
    .alias('generar')
    .description(
      "Build and archive the period's trial balance XML (SaldoIni, Debe, Haber, SaldoFin) with its hash"
    );
  withContext(generarBalanzaHoja);
  withOutput(generarBalanzaHoja);
  generarBalanzaHoja
    .option('--period <expr>', 'period to declare: 2026-02, its name, or the fiscal period id')
    .option('--type <N|C>', "envelope type: N normal, C amended (needs --modified)", 'N')
    .option('--closing', "the year-end balance, filed as month 13 — not December again")
    .option('--modified <date>', 'date the balance being amended was modified (FechaModBal); required with --type C')
    .option('--dry-run', 'build it and show the verdict; archive nothing and write no file')
    .option('-y, --yes', 'skip the overwrite prompt when -o names an existing file');
  outputNombraElXml(generarBalanzaHoja, 'Balanza');
  avisoDeAyuda(generarBalanzaHoja);
  generarBalanzaHoja.addHelpText('after', EJEMPLOS.balanceGenerate);
  // ESCRITURA + IA ✓ con `draftOnly`, por lo mismo que su hermana.
  declareRisk(generarBalanzaHoja, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes:
      'sat_anexo24_artefactos (el XML archivado con su hash, SIN SELLAR); ninguna póliza, ' +
      'ningún envío a la autoridad',
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

        const destino = dryRun
          ? '(ensayo: no se escribió nada)'
          : (opts.output ?? '(almacén de artefactos)');
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
          out.write(c.dim(`  archivo sugerido ${b.nombre} · ${b.bytes} byte(s)\n`));
          out.write(c.dim(`  sha256 ${b.hash}\n`));
          out.write(c.dim(`  destino ${destino}\n`));
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
              `    El despacho tiene declarado '${b.meta.criterio_sellado}' en ` +
                '`efirma_sellado_contabilidad_electronica`, y este tramo no sella: el archivo ' +
                'sale sin Sello, noCertificado ni Certificado.\n\n'
            )
          );
        }
        if (dryRun) {
          err.write(c.dim('  --dry-run: no se archivó nada y no se escribió ningún archivo.\n\n'));
        } else if (b.artefacto?.yaExistia === true) {
          err.write(
            c.dim(
              '  Estos mismos bytes ya estaban archivados: no se creó una versión nueva. ' +
                'El generador es determinista, que es lo que hace comparable un mes con otro.\n\n'
            )
          );
        }
        // Las bloqueantes no llegan hasta aquí: `generarBalanza` se niega y
        // lanza (422 → 4). Lo que sobrevive son avisos, y un aviso no impide
        // entregar. `balance check --strict` es donde se endurecen.
        return ExitCode.OK;
      })
  );

  // ---- balance check ---------------------------------------
  const verificar = balanza
    .command('check')
    .alias('verificar')
    .description(
      'Run the invariants the SAT re-runs: SaldoIni + Debe − Haber = SaldoFin honouring Natur, and every account in the catalog'
    );
  withContext(verificar);
  withOutput(verificar);
  withStrict(verificar);
  verificar
    .option('--period <expr>', 'period to check: 2026-02, its name, or the fiscal period id')
    // `--closing` también aquí, aunque su fila sólo liste cuatro banderas: una
    // balanza de cierre que se puede GENERAR y no se puede VERIFICAR es un
    // archivo que sólo se revisa cuando la autoridad lo rechaza.
    .option('--closing', 'check the year-end balance (month 13) instead of a month')
    .option(
      '--check [names]',
      'comma-separated check names; with no value, prints the available ones'
    );
  // LECTURA: no escribe, no genera y no archiva. IA ✓ sin más condiciones.
  declareRisk(verificar, { risk: 'lectura', agent: true });
  verificar.addHelpText('after', EJEMPLOS.balanceCheck);
  verificar.action(
    (
      opts: CommonOpts & {
        period?: string;
        closing?: boolean;
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

        const ctx = await entidadDeLectura(opts);
        const r: ResultadoDeVerificacion = await verificarBalanza(ctx.entityId, {
          ...(opts.period !== undefined ? { periodo: opts.period } : {}),
          ...(opts.closing === true ? { cierre: true } : {}),
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
              `${r.meta.rfc} · balanza ${r.meta.mes}/${r.meta.anio} · ${r.meta.period_name} · ` +
                `${r.meta.cuentas} cuenta(s) · verificaciones: ${r.checks.join(',')}\n`
            )
          );
        } else {
          out.write(cabeceraDeBalanza(r.meta, r.inicial));
          out.write(
            c.dim(
              `  catálogo de cotejo: ${
                r.catalogo === null
                  ? 'ninguno'
                  : `${r.catalogo.origen}${r.catalogo.referencia ? ` (${r.catalogo.referencia.slice(0, 12)})` : ''}`
              }\n`
            )
          );
          out.write(c.dim(`  verificaciones: ${r.checks.join(', ')}\n\n`));
          const lineas = renderHallazgos(
            r.hallazgos.map((h) => ({
              severity: h.severity,
              nombre: h.check,
              referencia: h.referencia,
              detalle: h.detalle,
            })),
            c
          );
          if (lineas.length === 0) {
            out.write(
              `  ${MARK.limpio} sin hallazgos: la balanza pasa las ${r.checks.length} ` +
                'verificación(es) pedidas.\n\n'
            );
          } else {
            for (const l of lineas) out.write(`${l}\n`);
            out.write(
              '\n' +
                c.dim(
                  `  ${r.conteo.blocking} bloqueante(s), ${r.conteo.warning} aviso(s). ` +
                    'Un bloqueante impide generar el archivo.\n\n'
                )
            );
          }
        }

        // El contrato §4, y el 4 NO se inventa aquí: sale del núcleo.
        return checkExitCode(r.conteo, { strict: opts.strict });
      })
  );
}
