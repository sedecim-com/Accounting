import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  construirDiot,
  contarHallazgos,
  esEntregable,
  DiotFormatoNoFundamentado,
  LO_QUE_FALTA_CONFIRMAR,
  PAPEL_DE_TRABAJO,
  SERIALIZADOR_SAT,
  type DiotConstruida,
  type Hallazgo,
  type RenglonDiot,
  type SerializadorDiot,
} from '../services/sat/diot/index.js';
import { renderHallazgos } from './e-accounting-command.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  checkExitCode,
  declareRisk,
  exitCodeFor,
  formatMoneyMx,
  needsHuman,
  render,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  withStrict,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine diot — LA DECLARACIÓN QUE SE CAPTURA, NO LA QUE SE ENVÍA
//
// TRES HOJAS DE LAS CUATRO FILAS DE FASE 1 DEL CATÁLOGO
// (docs/cli-command-catalog.md 2040-2043):
//
//   diot generate · diot generar   — arma la DIOT del mes y la enseña
//   diot check    · diot verificar — las invariantes, con nombre y con código 4
//   diot export   · diot exportar  — el papel de trabajo, byte-estable
//
// LA CUARTA, `diot record` · `diot registrar`, NO ESTÁ AQUÍ, y no por falta de
// tiempo: su fila dice que registra el acuse «en el mismo almacén que
// `filing record`», y ese almacén —`tax_form_filings`, 008_payroll.sql:482—
// no tiene columna para el importe pagado ni para la línea de captura, no
// tiene ningún escritor que no sea de nómina, y `filing record` tampoco
// existe todavía. Un `record` que aceptara `--acuse` y lo tirara sería peor
// que su ausencia: el contador se quedaría creyendo que el acuse está
// guardado. Ver el informe de este frente.
//
// ── LO PRIMERO QUE HAY QUE SABER DE ESTE ARCHIVO ──
//
// NADA DE LO QUE SALE DE AQUÍ ESTÁ PRESENTADO. La DIOT se captura o se sube
// en el portal del SAT, por una persona, con su e.firma o su contraseña. Este
// binario no toca el portal, y la fila del catálogo que lo haría
// (`diot export --layout sat`) SE NIEGA a inventar el layout del lote: ver
// `LO_QUE_FALTA_CONFIRMAR` en el serializador. Así que las tres hojas gritan
// lo mismo que las del Anexo 24, con las palabras que les tocan.
//
// ── CUATRO DECISIONES QUE NO SON DE ESTILO ──
//
// LA PRIMERA · `generate` DECLARA `lectura`, Y SU FILA DICE `escritura`.
// La fila supone que generar ARCHIVA algo, como archivan las dos `generate`
// del Anexo 24 en `sat_anexo24_artefactos`. Esa tabla no admite la DIOT: su
// CHECK enumera 'catalogo','balanza','poliza','auxiliar_folios',
// 'auxiliar_cuentas' (062_el_xml_que_se_entrega.sql:39) y no hay tipo para
// esto. Con lo que hay hoy, `diot generate` no escribe una sola fila en
// ninguna tabla. Declararla `escritura` con un `--dry-run` que no evita nada
// sería publicar una compuerta de mentira —el defecto que este repositorio
// lleva un mes cazando—, así que declara lo que hace. El día que una
// migración añada el tipo, esta hoja sube a `escritura` + `draftOnly` y su
// `--dry-run` empieza a significar algo. Está en el informe como
// incumplimiento del catálogo, con su razón.
//
// LA SEGUNDA · `--format` Y `--layout` SON COSAS DISTINTAS Y LA FILA PIDE
// LAS DOS. `--format` es del núcleo y da forma al RECIBO (table|json|csv…).
// `--layout` da forma al ARCHIVO que se exporta, y sólo tiene dos valores:
// `working-paper`, la conciliación por tercero que se coteja contra el mayor
// antes de capturar, y `sat`, el archivo de lote — que hoy se niega. Un solo
// flag para las dos cosas obligaría a que `--format json` significara una
// cosa en `check` y otra en `export`.
//
// LA TERCERA · `export` SIN `-o` ESCRIBE EL ARCHIVO EN stdout, no un recibo.
// Su fila exige que sea BYTE-ESTABLE «para poder diffear contra el envío
// anterior», y eso es exactamente `diot export --period 2026-02 | diff - …`.
// El recibo y los hallazgos salen por stderr, que es donde no ensucian una
// tubería. Con `-o` el archivo va al disco y el recibo pasa a stdout en el
// `--format` que se pida — que es la misma regla que las dos `generate` del
// Anexo 24 adoptaron para su `-o`, y por la misma razón.
//
// LA CUARTA · LOS NOMBRES DE VERIFICACIÓN SON DE ESTA CAPA, A PROPÓSITO Y A
// REGAÑADIENTES. El motor de la DIOT publica CÓDIGOS de hallazgo, no una
// lista de verificaciones como `BALANZA_CHECK_NAMES`. `--check <nombre,…>`
// necesita una lista corta y aprendible, así que aquí se agrupan los
// dieciocho códigos en seis nombres. Que el agrupamiento siga cubriendo TODOS
// los códigos que el motor emite lo vigila una prueba que lee el propio
// código fuente del motor (tests/cli/diot-command.spec.ts): si mañana nace un
// código nuevo y nadie lo clasifica, un `--check` selectivo lo dejaría fuera
// en silencio, que es la forma exacta en que un verde miente.
// ============================================================

export interface DiotCommandDeps {
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
}

const MARK = { bloquea: '✘', avisa: '⚠', limpio: '✔' } as const;

// ------------------------------------------------------------
// LO QUE FALTA PARA PRESENTAR, DICHO SIEMPRE Y CON TODAS SUS LETRAS
// ------------------------------------------------------------

/**
 * El titular. En español porque es la advertencia más importante del tramo:
 * la DIOT tiene fecha límite y un contador que cierre la terminal creyendo
 * que ya presentó descubre el error cuando le llega el requerimiento.
 */
export const TITULAR_NO_PRESENTADA =
  'ESTA DIOT NO SE PRESENTÓ Y ESTE ARCHIVO NO ES LA DECLARACIÓN.';

/**
 * Los pasos que quedan, en el orden en que ocurren. Se exportan para que una
 * prueba los fije: una lista que se acorta sin querer deja al lector creyendo
 * que ya terminó.
 *
 * No mandan a ningún comando de este binario, porque no hay ninguno que
 * presente: `diot export --layout sat` se niega mientras el layout del lote
 * no esté fundamentado, y `diot record` no existe.
 */
export const PASOS_PARA_PRESENTAR_DIOT: readonly string[] = Object.freeze([
  'Coteja el papel de trabajo contra el movimiento del mes de la cuenta de IVA acreditable: ' +
    'si no cuadra al centavo, no captures — «casi cuadra» es un requerimiento dentro de un año.',
  'Captura o carga la declaración TÚ en el portal del SAT. Este binario no entra al portal, ' +
    'no carga la e.firma y no presenta nada.',
  'Guarda el acuse con su número de operación: es la única prueba de que se presentó.',
  'Registra el acuse en el expediente del mes. Ese registro TODAVÍA NO tiene comando ' +
    '(`diot record` no está construido).',
]);

/** El bloque completo, para la salida legible. */
function bloqueNoPresentada(c: Palette): string {
  return [
    '',
    c.yellow(`  ⚠ ${TITULAR_NO_PRESENTADA}`),
    c.dim('    Armar la declaración y presentarla son actos distintos y de manos distintas.'),
    '',
    ...PASOS_PARA_PRESENTAR_DIOT.map((p, i) => c.dim(`    ${i + 1}. ${p}`)),
    '',
  ].join('\n');
}

// ------------------------------------------------------------
// EL MES QUE SE DECLARA
// ------------------------------------------------------------

const MES_RE = /^(\d{4})-(\d{2})$/;

/**
 * `--period` de la DIOT, reducido al año y al mes.
 *
 * Se exige y no se supone, por la misma razón que en el Anexo 24: adivinar
 * «el mes en curso» el día 3 declara el mes equivocado, y el error sólo se ve
 * cuando el SAT cruza la DIOT contra el pago de IVA.
 *
 * NO acepta trimestre ni ejercicio: la DIOT es mensual desde 2016 (LIVA art.
 * 32 fr. VIII) y un rango no tiene dónde ponerse. Y NO acepta el mes 13: ése
 * es de la balanza de cierre del Anexo 24, no de una declaración informativa.
 */
export function mesDeLaDiot(expr: string | undefined): { anio: number; mes: number } {
  if (expr === undefined || expr.trim() === '') {
    throw usageError(
      'La DIOT se declara por mes: indica --period YYYY-MM (por ejemplo --period 2026-02). ' +
        'Sin él no hay periodo que declarar.'
    );
  }
  const m = MES_RE.exec(expr.trim());
  if (!m) {
    throw usageError(
      `--period «${expr}» no es un mes. La DIOT es mensual (LIVA art. 32 fr. VIII), así que ` +
        'aquí sólo vale la forma YYYY-MM (2026-02). Un trimestre o un ejercicio no se declaran.'
    );
  }
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) {
    throw usageError(
      `--period «${expr}»: el mes ha de ir de 01 a 12. El mes 13 es de la balanza de cierre ` +
        'del Anexo 24 (`e-accounting balance generate --closing`); una declaración informativa ' +
        'no tiene mes 13.'
    );
  }
  return { anio, mes };
}

// ------------------------------------------------------------
// LAS VERIFICACIONES, POR NOMBRE
// ------------------------------------------------------------

/**
 * Los seis nombres de `--check`, y qué código de hallazgo cae en cada uno.
 *
 * El orden es el del recorrido de la declaración: primero si el hecho existe,
 * luego cómo se desglosa, luego a quién se le declara. Un nombre por CAUSA y
 * no por gravedad: la severidad la decide la política del panel y puede
 * cambiar sin que cambie de qué habla el hallazgo.
 */
export const CODIGOS_POR_CHECK = Object.freeze({
  /** El suceso del mayor: ¿hay pago, y no se libera más de lo aparcado? */
  'hecho-pagado': Object.freeze(['DIOT-PUE-SIN-PAGO', 'DIOT-TOPE-APARCADO']),
  /** El reparto por tasa: la DIOT declara por casilla, no un total. */
  'desglose-por-tasa': Object.freeze([
    'DIOT-SIN-RENGLONES',
    'DIOT-TASA-MEDIDA',
    'DIOT-TASA-FUERA-DE-CATALOGO',
    'DIOT-IVA-CABECERA',
  ]),
  /** El valor de los actos exentos, que no lleva impuesto y sí lleva base. */
  'base-de-lo-exento': Object.freeze([
    'DIOT-BASE-EXENTA-DESCONOCIDA',
    'DIOT-BASE-EXENTA-OMITIDA',
    'DIOT-BASE-EXENTA-DERIVADA',
    'DIOT-EXENTO-CON-IVA',
  ]),
  /** A quién se le declara: RFC usable, o identificación fiscal del extranjero. */
  'tercero-identificado': Object.freeze([
    'DIOT-SIN-RFC',
    'DIOT-SIN-RFC-DECLARADO-GLOBAL',
    'DIOT-GLOBAL-CON-RFC',
    'DIOT-EXTRANJERO-INCOMPLETO',
    'DIOT-TERCERO-AJENO',
  ]),
  /** 03 servicios, 06 arrendamiento, 85 otros: la columna que nadie captura. */
  'tipo-de-operacion': Object.freeze([
    'DIOT-TIPO-OPERACION-SIN-DECLARAR',
    'DIOT-TIPO-OPERACION-POR-OMISION',
  ]),
  /** Una política del panel con un valor que su propio catálogo no admite. */
  'politica-en-catalogo': Object.freeze(['DIOT-POLITICA-FUERA-DE-CATALOGO']),
} as const);

export type DiotCheckName = keyof typeof CODIGOS_POR_CHECK;

export const DIOT_CHECK_NAMES = Object.freeze(
  Object.keys(CODIGOS_POR_CHECK) as DiotCheckName[]
);

/** Una línea por verificación, para `--check` sin valor. */
export const DESCRIPCION_DEL_CHECK: Readonly<Record<DiotCheckName, string>> = Object.freeze({
  'hecho-pagado':
    'el suceso que la DIOT declara existe en el mayor y no libera más IVA del que hay aparcado',
  'desglose-por-tasa':
    'cada gasto se reparte por tasa (16/8/0/exento) y la suma reproduce el IVA de la cabecera',
  'base-de-lo-exento':
    'los actos exentos declaran su base, que es lo que la DIOT informa aunque no haya impuesto',
  'tercero-identificado':
    'cada tercero llega con RFC usable, o con identificación fiscal, país y nacionalidad si es extranjero',
  'tipo-de-operacion': 'cada tercero trae tipo de operación capturado (03, 06 u 85), no supuesto',
  'politica-en-catalogo':
    'las tres políticas de la DIOT valen algo que su propio catálogo admite',
});

/** El check al que pertenece un código, o undefined si nadie lo clasificó. */
export function checkDelCodigo(codigo: string): DiotCheckName | undefined {
  for (const nombre of DIOT_CHECK_NAMES) {
    if (CODIGOS_POR_CHECK[nombre].includes(codigo)) return nombre;
  }
  return undefined;
}

/**
 * `--check a,b` contra la lista publicada.
 *
 * Un nombre desconocido es error de USO (2), nunca un filtro vacío que sale 0:
 * un `check` que no verificó nada y contesta «limpio» es la manera exacta en
 * que una tubería verde miente. Es la misma puerta que `balance check`.
 */
export function exigirChecksDeDiot(valor: string): DiotCheckName[] {
  const pedidos = valor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const desconocidos = pedidos.filter(
    (p) => !(DIOT_CHECK_NAMES as readonly string[]).includes(p)
  );
  if (desconocidos.length > 0) {
    throw usageError(
      `Verificación(es) desconocida(s): ${desconocidos.join(', ')}. ` +
        `Las disponibles son: ${DIOT_CHECK_NAMES.join(', ')}.`
    );
  }
  if (pedidos.length === 0) {
    throw usageError(
      `--check no nombró ninguna verificación. Las disponibles son: ${DIOT_CHECK_NAMES.join(', ')}.`
    );
  }
  return pedidos as DiotCheckName[];
}

/**
 * Los hallazgos que caen bajo las verificaciones pedidas.
 *
 * UN CÓDIGO SIN CLASIFICAR NUNCA SE FILTRA. Si el motor emite mañana un
 * código que este archivo no conoce, dejarlo fuera de un `--check` selectivo
 * lo escondería; se conserva siempre, y la prueba de cobertura acusa la
 * omisión en el diff en vez de en la declaración de alguien.
 */
export function filtrarPorChecks(
  hallazgos: readonly Hallazgo[],
  pedidos: readonly DiotCheckName[] | undefined
): Hallazgo[] {
  if (pedidos === undefined) return [...hallazgos];
  const permitidos = new Set<string>(pedidos);
  return hallazgos.filter((h) => {
    const nombre = checkDelCodigo(h.codigo);
    return nombre === undefined || permitidos.has(nombre);
  });
}

// ------------------------------------------------------------
// EL LAYOUT DEL ARCHIVO — no confundir con `--format`
// ------------------------------------------------------------

export const LAYOUTS = Object.freeze({
  'working-paper': PAPEL_DE_TRABAJO,
  sat: SERIALIZADOR_SAT,
} as Record<string, SerializadorDiot>);

export const LAYOUT_POR_OMISION = 'working-paper';

/**
 * `--layout`, con el vocabulario que el serializador ya publica.
 *
 * El valor por omisión es el papel de trabajo Y NO EL ARCHIVO DE LA
 * AUTORIDAD, que es lo contrario de lo que un exportador suele hacer. La
 * razón: el único de los dos que existe es el papel de trabajo, y un valor
 * por omisión que siempre falla convierte el comando en una trampa.
 */
export function exigirLayout(valor: string | undefined): SerializadorDiot {
  const clave = (valor ?? LAYOUT_POR_OMISION).trim();
  const elegido = LAYOUTS[clave];
  if (!elegido) {
    throw usageError(
      `--layout «${clave}» no existe. Los layouts son: ${Object.keys(LAYOUTS).join(', ')} ` +
        `(working-paper es la conciliación por tercero que se coteja antes de capturar; ` +
        `sat es el archivo de lote de la autoridad).`
    );
  }
  return elegido;
}

// ------------------------------------------------------------
// LAS FILAS QUE SALEN
// ------------------------------------------------------------

/** Un hallazgo, como fila. `check` es el nombre agrupador; `codigo`, el del motor. */
export function filaDeHallazgo(h: Hallazgo): Row {
  return {
    check: checkDelCodigo(h.codigo) ?? 'sin-clasificar',
    codigo: h.codigo,
    severity: h.severidad === 'bloqueante' ? 'blocking' : 'warning',
    politica: h.politica ?? '',
    referencia: h.documentNumber ?? h.documentId ?? h.vendorId ?? '',
    detalle: h.mensaje,
  };
}

/** Un tercero de la declaración, con sus casillas. El dinero, como cadena. */
export function filaDeTercero(r: RenglonDiot): Row {
  return {
    rfc: r.tercero.rfc ?? '',
    tercero: r.tercero.nombre,
    tipo_tercero: r.tercero.tipoTercero,
    tipo_operacion: r.tercero.tipoOperacion,
    origen_tipo_operacion: r.tercero.procedencia.tipoOperacion,
    id_fiscal_extranjero: r.tercero.idFiscalExtranjero ?? '',
    pais_residencia: r.tercero.paisResidencia ?? '',
    nacionalidad: r.tercero.nacionalidad ?? '',
    base_16: r.desglose.tasa16.base,
    iva_16: r.desglose.tasa16.iva,
    base_8: r.desglose.tasa8.base,
    iva_8: r.desglose.tasa8.iva,
    base_0: r.desglose.tasa0.base,
    base_exento: r.desglose.exento.base,
    otras_tasas: r.desglose.otras.map((o) => `${o.etiqueta}=${o.base}/${o.iva}`).join(';'),
    iva_retenido: r.ivaRetenido,
    documentos: r.documentos.length,
  };
}

/**
 * El recibo de la declaración: UNA fila con todo lo que hace falta para saber
 * qué se armó y si se puede capturar. Los terceros y los hallazgos viajan
 * anidados —como hace el recibo del Anexo 24— para que `--json` no pierda el
 * detalle que la tabla no cabe.
 */
export function reciboDeDiot(d: DiotConstruida, extra: Record<string, unknown> = {}): Row {
  const conteo = contarHallazgos(d.hallazgos);
  return {
    rfc: d.rfc,
    razon_social: d.razonSocial,
    anio: d.periodo.anio,
    mes: String(d.periodo.mes).padStart(2, '0'),
    desde: d.periodo.desde,
    hasta: d.periodo.hasta,
    base: 'operaciones pagadas (LIVA art. 5 frac. III)',
    terceros: d.totales.terceros,
    documentos: d.totales.documentos,
    base_16: d.totales.desglose.tasa16.base,
    iva_16: d.totales.desglose.tasa16.iva,
    base_8: d.totales.desglose.tasa8.base,
    iva_8: d.totales.desglose.tasa8.iva,
    base_0: d.totales.desglose.tasa0.base,
    base_exento: d.totales.desglose.exento.base,
    iva_acreditable_pagado: d.totales.ivaAcreditablePagado,
    iva_retenido: d.totales.ivaRetenido,
    bloqueantes: conteo.bloqueante,
    avisos: conteo.aviso,
    entregable: esEntregable(d),
    presentada: false,
    ...Object.fromEntries(d.politicas.map((p) => [`criterio_${p.clave}`, p.valor])),
    ...Object.fromEntries(
      d.politicas.map((p) => [`criterio_${p.clave}_origen`, p.definida ? 'contestada' : 'omision'])
    ),
    falta_para_presentar: [...PASOS_PARA_PRESENTAR_DIOT],
    ...extra,
    terceros_detalle: d.renglones.map(filaDeTercero),
    hallazgos: d.hallazgos.map(filaDeHallazgo),
  };
}

/** Las líneas de hallazgo, con la forma que `renderHallazgos` del Anexo 24 espera. */
export function lineasDeHallazgos(
  hallazgos: readonly Hallazgo[],
  c: Pick<Palette, 'dim' | 'red' | 'yellow'>
): string[] {
  return renderHallazgos(
    hallazgos.map((h) => ({
      severity: h.severidad === 'bloqueante' ? 'blocking' : 'warning',
      nombre: h.codigo,
      referencia: h.documentNumber ?? h.vendorId ?? '',
      detalle: h.mensaje,
    })),
    c
  );
}

// ------------------------------------------------------------
// EL REGISTRO
// ------------------------------------------------------------

export function registerDiotCommand(program: Command, deps: DiotCommandDeps): void {
  // Sin `.alias()`: `diot` es la misma palabra en los dos idiomas y el
  // registro la conserva sin traducir, como `cfdi`, `rep` y `sat`. Los
  // VERBOS sí llevan su alias español.
  const familia = program
    .command('diot')
    .description(
      'Mexican DIOT: build the month from paid transactions, check it, and export the working paper'
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
  const entidad = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
    return ctx;
  };

  /**
   * ¿Toca la ficha escrita a mano, o cede a `render`? La misma regla que
   * `e-accounting` y `closing`: `--format` nace con valor 'table', así que se
   * compara contra él, y un `--fields` declarado que sólo se leyera en json
   * sería una promesa incumplida.
   *
   * `-o` NO cuenta en `export`: allí nombra el ARCHIVO y no la salida, así que
   * pedir el archivo no debe apagar la ficha legible de la terminal.
   */
  const legible = (opts: CommonOpts, outputEsElArchivo = false): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    (outputEsElArchivo || opts.output === undefined) &&
    opts.fields === undefined;

  /** Lo que la ayuda tiene que decir ANTES de que alguien ejecute el comando. */
  const avisoDeAyuda = (cmd: Command): void => {
    cmd.addHelpText(
      'after',
      '\nThis builds and checks the DIOT. It does NOT file it.\n' +
        'The DIOT is captured or uploaded by a person in the SAT portal; this binary never\n' +
        'reaches the portal and never loads an e.firma. The batch-file layout is not\n' +
        "grounded in this repository, so `diot export --layout sat` refuses instead of\n" +
        'inventing one — run it to see exactly what has to be confirmed.\n'
    );
  };

  /** La cabecera legible, compartida por las tres hojas. */
  const cabecera = (d: DiotConstruida): string => {
    const c = deps.palette;
    const mes = String(d.periodo.mes).padStart(2, '0');
    return (
      `\n${c.bold(`DIOT ${mes}/${d.periodo.anio}`)}  ` +
      c.dim(
        `RFC ${d.rfc} — ${d.razonSocial} · ${d.periodo.desde} → ${d.periodo.hasta} · ` +
          `${d.totales.terceros} tercero(s) · ${d.totales.documentos} documento(s)`
      ) +
      '\n' +
      c.dim('  base: operaciones PAGADAS (LIVA art. 5 frac. III), no devengadas\n') +
      c.dim(
        `  ${d.politicas
          .map((p) => `${p.clave}=${p.valor}${p.definida ? '' : ' (omisión)'}`)
          .join(' · ')}\n`
      )
    );
  };

  /** Los totales por casilla, que es como la declaración se captura. */
  const totales = (d: DiotConstruida): string => {
    const c = deps.palette;
    const t = d.totales.desglose;
    const linea = (etiqueta: string, base: string, iva: string | null): string =>
      `  ${etiqueta.padEnd(22)} base ${formatMoneyMx(base).padStart(16)}` +
      (iva === null ? '' : `   IVA ${formatMoneyMx(iva).padStart(16)}`);
    const filas = [
      linea('16 %', t.tasa16.base, t.tasa16.iva),
      linea('8 % (frontera)', t.tasa8.base, t.tasa8.iva),
      linea('0 %', t.tasa0.base, null),
      linea('exento', t.exento.base, null),
      ...t.otras.map((o) => linea(`otras (${o.etiqueta})`, o.base, o.iva)),
    ];
    return (
      `\n${filas.join('\n')}\n\n` +
      c.bold(
        `  IVA acreditable pagado en el mes  ${formatMoneyMx(d.totales.ivaAcreditablePagado)}\n`
      ) +
      c.dim(`  IVA retenido a terceros           ${formatMoneyMx(d.totales.ivaRetenido)}\n`) +
      c.dim(
        '  Cotéjalo contra el movimiento del mes de la cuenta de IVA acreditable: si no ' +
          'cuadra al centavo, no captures.\n'
      )
    );
  };

  /**
   * EJEMPLOS DE AYUDA. Invocaciones copiables, no plantillas: el censo de
   * superficie exige que cada hoja tenga la suya, y la razón es la de la
   * auditoría de usabilidad — un `--help` que enumera banderas sin enseñar
   * una sola invocación deja al usuario adivinando el orden y el formato.
   */
  const EJEMPLOS = {
    generate: `
Examples:
  # The month, with its breakdown by third party and by rate. Writes nothing.
  mnemosine diot generate --period 2026-07
  # Only the findings that would stop the filing, as JSON for a script.
  mnemosine diot generate --period 2026-07 --json
`,
    check: `
Examples:
  # The invariant the SAT cross-checks by itself: the creditable VAT declared
  # here against what the ledger says was actually paid that month.
  mnemosine diot check --period 2026-07
  # Exit 4 if anything blocks, so a pipeline can stop on it.
  mnemosine diot check --period 2026-07 --strict
`,
    export: `
Examples:
  # The working paper, to review before anything is filed.
  mnemosine diot export --period 2026-07 -o diot-2026-07.txt
`,
  };

  // ==========================================================
  // diot generate · diot generar
  // ==========================================================
  const generar = familia
    .command('generate')
    .alias('generar')
    .description(
      "Build the month's DIOT from paid transactions, broken down by third party and by rate"
    );
  withContext(generar);
  withOutput(generar);
  generar.option('--period <YYYY-MM>', 'month to declare (the DIOT is monthly; no month 13)');
  avisoDeAyuda(generar);
  // LECTURA, y la fila del catálogo dice `escritura`: ver la primera decisión
  // de la cabecera. Con lo que hay hoy esta hoja no escribe una sola fila.
  declareRisk(generar, { risk: 'lectura', agent: true });
  generar.addHelpText('after', EJEMPLOS.generate);
  generar.action((opts: CommonOpts & { period?: string }) =>
    run(async () => {
      // El mes se valida ANTES de tocar la base: un typo en --period no
      // debería costar una conexión ni una resolución de entidad.
      const { anio, mes } = mesDeLaDiot(opts.period);
      const ctx = await entidad(opts);
      const d = await construirDiot({ tenantId: ctx.tenantId, entityId: ctx.entityId, anio, mes });

      const c = deps.palette;
      const out = process.stdout;
      const err = process.stderr;

      if (!legible(opts)) {
        render([reciboDeDiot(d)], { ...opts, idField: 'rfc' });
      } else {
        out.write(cabecera(d));
        out.write(totales(d));
      }

      // Los hallazgos SIEMPRE se dicen, en los dos modos: anidados en el
      // recibo para la máquina, y por stderr para el humano, que es donde
      // viven las notas y donde no ensucian una tubería.
      const lineas = lineasDeHallazgos(d.hallazgos, c);
      if (lineas.length > 0) {
        err.write('\n');
        for (const l of lineas) err.write(`${l}\n`);
      }

      err.write(bloqueNoPresentada(c));

      if (!esEntregable(d)) {
        const conteo = contarHallazgos(d.hallazgos);
        err.write(
          c.red(
            `  ${conteo.bloqueante} hallazgo(s) impiden capturar esta DIOT tal cual. ` +
              'Arréglalos y vuelve a armarla; `diot check --check` lista las verificaciones ' +
              'por nombre para atacarlas de una en una.\n\n'
          )
        );
        return ExitCode.VALIDATION;
      }
      return ExitCode.OK;
    })
  );

  // ==========================================================
  // diot check · diot verificar
  // ==========================================================
  const verificar = familia
    .command('check')
    .alias('verificar')
    .description(
      'Run the DIOT invariants by name: the paid fact, the rate breakdown, the exempt base, the third party and its operation type'
    );
  withContext(verificar);
  withOutput(verificar);
  withStrict(verificar);
  verificar
    .option('--period <YYYY-MM>', 'month to check (the DIOT is monthly; no month 13)')
    .option(
      '--check [names]',
      'comma-separated check names; with no value, prints the available ones'
    );
  verificar.addHelpText(
    'after',
    '\nWhat this does NOT check, and why it is not silently missing:\n' +
      'the cross-check the SAT itself runs — the DIOT total against the VAT return of the\n' +
      'same month — needs a VAT return, and no engine in this repository computes one\n' +
      '(`filing preview` is not built). What IS proven here is stronger than a comparison\n' +
      'against a number nobody computed: the DIOT is built from the two ledger events that\n' +
      'move creditable VAT, so its total is the movement of that account by construction.\n' +
      'Tie it out by hand against the account until `filing preview` exists.\n'
  );
  // LECTURA: no escribe, no archiva y no sale del sistema. IA ✓ sin más.
  declareRisk(verificar, { risk: 'lectura', agent: true });
  verificar.addHelpText('after', EJEMPLOS.check);
  verificar.action(
    (opts: CommonOpts & { period?: string; check?: string | boolean; strict?: boolean }) =>
      run(async () => {
        // `--check` a secas: el registro, SIN tocar la base. Preguntar «¿qué
        // se puede verificar?» no debería costar una conexión (el criterio de
        // `balance check` y de `closing check`).
        if (opts.check === true) {
          render(
            DIOT_CHECK_NAMES.map((n) => ({
              check: n,
              codigos: CODIGOS_POR_CHECK[n].join(','),
              detalle: DESCRIPCION_DEL_CHECK[n],
            })),
            { ...opts, idField: 'check' }
          );
          return ExitCode.OK;
        }
        const pedidos =
          typeof opts.check === 'string' ? exigirChecksDeDiot(opts.check) : undefined;

        const { anio, mes } = mesDeLaDiot(opts.period);
        const ctx = await entidad(opts);
        const d = await construirDiot({ tenantId: ctx.tenantId, entityId: ctx.entityId, anio, mes });

        const hallazgos = filtrarPorChecks(d.hallazgos, pedidos);
        const conteo = contarHallazgos(hallazgos);
        const corridas = pedidos ?? DIOT_CHECK_NAMES;

        const c = deps.palette;
        const out = process.stdout;

        if (!legible(opts)) {
          // Los hallazgos SON las filas: un csv de hallazgos con su tercero y
          // su código es el anexo que un preparador se lleva al cierre. El
          // sobre —periodo, criterios, totales— va por stderr.
          render(hallazgos.map(filaDeHallazgo), { ...opts, idField: 'codigo' });
          process.stderr.write(
            c.dim(
              `${d.rfc} · DIOT ${String(mes).padStart(2, '0')}/${anio} · ` +
                `${d.totales.terceros} tercero(s) · IVA acreditable pagado ` +
                `${d.totales.ivaAcreditablePagado} · verificaciones: ${corridas.join(',')}\n`
            )
          );
        } else {
          out.write(cabecera(d));
          out.write(c.dim(`  verificaciones: ${corridas.join(', ')}\n\n`));
          const lineas = lineasDeHallazgos(hallazgos, c);
          if (lineas.length === 0) {
            out.write(
              `  ${MARK.limpio} sin hallazgos: la DIOT pasa las ${corridas.length} ` +
                'verificación(es) pedidas.\n\n'
            );
          } else {
            for (const l of lineas) out.write(`${l}\n`);
            out.write(
              '\n' +
                c.dim(
                  `  ${conteo.bloqueante} bloqueante(s), ${conteo.aviso} aviso(s). ` +
                    'Un bloqueante impide capturar la declaración.\n\n'
                )
            );
          }
        }

        // El contrato §4, y el 4 NO se inventa aquí: sale del núcleo.
        return checkExitCode(
          { blocking: conteo.bloqueante, warning: conteo.aviso },
          { strict: opts.strict }
        );
      })
  );

  // ==========================================================
  // diot export · diot exportar
  // ==========================================================
  const exportar = familia
    .command('export')
    .alias('exportar')
    .description(
      'Emit the DIOT file, byte-stable for diffing: the working paper today, the SAT batch layout when it is grounded'
    );
  withContext(exportar);
  withOutput(exportar);
  exportar
    .option('--period <YYYY-MM>', 'month to export (the DIOT is monthly; no month 13)')
    .option(
      `--layout <${Object.keys(LAYOUTS).join('|')}>`,
      'file layout: working-paper is the per-third-party reconciliation; sat is the authority batch file',
      LAYOUT_POR_OMISION
    )
    .option('-y, --yes', 'skip the overwrite prompt when -o names an existing file');
  // `-o` aquí nombra el ARCHIVO EXPORTADO, no la salida renderizada. La
  // descripción que inyecta `withOutput` dice lo contrario, y una ayuda que
  // promete algo distinto de lo que el código hace es la clase de mentira que
  // este repositorio ya cazó en `ap reconcile`. Se corrige la DESCRIPCIÓN; la
  // grafía y la forma corta las sigue gobernando el diccionario.
  {
    const opcion = exportar.options.find((o) => o.long === '--output');
    if (opcion) {
      opcion.description =
        'write the exported file to this path (without it, the file goes to stdout so it can be diffed)';
    }
  }
  avisoDeAyuda(exportar);
  // LECTURA: arma la declaración y la escribe DONDE EL USUARIO PIDIÓ. No
  // archiva, no postea y no llega a ninguna autoridad.
  declareRisk(exportar, { risk: 'lectura', agent: true });
  exportar.addHelpText('after', EJEMPLOS.export);
  exportar.action(
    (opts: CommonOpts & { period?: string; layout?: string; yes?: boolean }) =>
      run(async () => {
        const layout = exigirLayout(opts.layout);
        const { anio, mes } = mesDeLaDiot(opts.period);
        const ctx = await entidad(opts);
        const d = await construirDiot({ tenantId: ctx.tenantId, entityId: ctx.entityId, anio, mes });

        const c = deps.palette;
        const err = process.stderr;

        let contenido: string;
        try {
          contenido = layout.serializar(d);
        } catch (e) {
          // El layout del lote no está fundamentado y el serializador se
          // niega. NO es un fallo: los datos están completos y lo que falta
          // es que una persona confirme la forma contra el layout vigente.
          // Por eso 11 (needs human) y no 1 — «el trabajo no falló, está
          // esperando», que es literalmente el caso.
          if (e instanceof DiotFormatoNoFundamentado) {
            throw needsHuman(
              `${e.message}\n\nMientras tanto: \`mnemosine diot export --period ` +
                `${String(anio)}-${String(mes).padStart(2, '0')} --layout working-paper\` ` +
                `produce la conciliación por tercero para capturar en el portal.`,
              { faltan: [...LO_QUE_FALTA_CONFIRMAR] }
            );
          }
          throw e;
        }

        const destino = opts.output ?? '(stdout)';
        if (opts.output !== undefined) {
          escribirArchivo(opts.output, contenido, opts);
        } else {
          // Sin `-o` el ARCHIVO es la salida: se escribe crudo y sin adornos
          // para que `diff` compare bytes contra el envío anterior.
          process.stdout.write(contenido);
        }

        const recibo = reciboDeDiot(d, {
          layout: opts.layout ?? LAYOUT_POR_OMISION,
          archivo_declarable: layout.esArchivoDeclarable,
          destino,
          bytes: Buffer.byteLength(contenido, 'utf8'),
        });
        if (opts.output !== undefined) {
          if (!legible(opts, true)) {
            const { output: _output, ...sinDestino } = opts;
            render([recibo], { ...sinDestino, idField: 'rfc' });
          } else {
            process.stdout.write(cabecera(d));
            process.stdout.write(
              c.dim(
                `  layout ${opts.layout ?? LAYOUT_POR_OMISION} · ` +
                  `${recibo.bytes as number} byte(s) · destino ${destino}\n`
              )
            );
            process.stdout.write(totales(d));
          }
        }

        const lineas = lineasDeHallazgos(d.hallazgos, c);
        if (lineas.length > 0) {
          err.write('\n');
          for (const l of lineas) err.write(`${l}\n`);
        }
        if (!layout.esArchivoDeclarable) {
          err.write(
            '\n' +
              c.yellow(
                `  ⚠ Layout «${opts.layout ?? LAYOUT_POR_OMISION}»: esto es un PAPEL DE TRABAJO. ` +
                  'No se sube al portal del SAT.\n'
              )
          );
        }
        err.write(bloqueNoPresentada(c));

        // Se exportó igualmente —el papel de trabajo existe justo para
        // arreglar esto— pero el código lo dice: 4 es «encontré algo».
        if (!esEntregable(d)) {
          const conteo = contarHallazgos(d.hallazgos);
          err.write(
            c.red(
              `  El archivo se escribió, pero ${conteo.bloqueante} hallazgo(s) impiden ` +
                'capturar la declaración tal cual.\n\n'
            )
          );
          return ExitCode.VALIDATION;
        }
        return ExitCode.OK;
      })
  );
}

/**
 * Escribe el archivo exportado donde se pidió.
 *
 * Crea el directorio si falta —pedir un destino y que falle por una carpeta
 * inexistente es fricción sin ganancia— y se niega a PISAR algo sin `--yes`.
 * No pregunta por TTY: a diferencia del XML del Anexo 24, aquí no hay nada
 * firmado que proteger, así que la negativa con instrucciones es mejor que
 * una pregunta que un guion no puede contestar.
 */
function escribirArchivo(destino: string, contenido: string, opts: { yes?: boolean }): void {
  if (existsSync(destino) && opts.yes !== true) {
    throw usageError(
      `${destino} ya existe y no se sobrescribe sin pedirlo: usa otra ruta, o --yes. ` +
        'Un papel de trabajo revisado y anotado a mano no se reemplaza en silencio.'
    );
  }
  mkdirSync(path.dirname(path.resolve(destino)), { recursive: true });
  writeFileSync(destino, Buffer.from(contenido, 'utf8'));
}
