import { AppError } from '../../../utils/errors.js';
import { bloquean, contarHallazgos } from './hallazgos.js';
import type { DiotConstruida, RenglonDiot } from './modelo.js';

// ============================================================
// F07c · CÓMO SE ESCRIBE LA DIOT, Y POR QUÉ AQUÍ NO SE ESCRIBE ENTERA
//
// La DIOT no es XML. Se presenta por lotes en un archivo de texto con los
// campos separados por barras verticales, y ése es el único punto en el que
// este módulo NO puede fundamentar lo que haría.
//
// LO QUE SÍ ESTÁ FUNDAMENTADO, y por eso se entrega: qué se declara. Que la
// base son operaciones PAGADAS y no devengadas, que va desglosado por tasa,
// que el tercero lleva tipo (04/05/15) y tipo de operación (03/06/85), que el
// extranjero lleva identificación fiscal, país y nacionalidad, y que el IVA
// retenido va aparte. Todo eso está escrito en las columnas que la migración
// 063 creó, en las tres políticas del panel y en la lista de comprobación de
// la casa, y todo eso lo produce `construirDiot` con importes verificados
// contra el mayor.
//
// LO QUE NO: el orden exacto de los campos del registro, cuántos son, si el
// importe va redondeado a pesos o con centavos, si hay registro de cabecera,
// qué campo ocupa el IVA retenido y si las operaciones de la región
// fronteriza y las de importación tienen campo propio. Eso es la FORMA, y la
// fija la autoridad.
//
// ESTE REPOSITORIO YA TUVO UNA VERSIÓN INVENTADA Y LA BORRÓ. `generateDIOT`
// (src/services/mexico/cfdi.ts, eliminado) emitía
// `tipo|rfc|||nombre||||total|impuesto||||||||` — dieciséis barras y ningún
// documento detrás—, y encima agregaba en base devengada. La nota de deuda
// que acompañó su borrado dice literalmente que no debe exponerse un archivo
// de declaración calculado así. Reponer el mismo layout con la aritmética
// arreglada sería reponer el otro medio error: un formato inventado no falla
// al generarse, falla al ser RECHAZADO, y para entonces el plazo corrió.
//
// De modo que hay dos serializadores y sólo uno escribe algo:
//   · PAPEL_DE_TRABAJO  → la conciliación por tercero, legible y cotejable
//                         contra el mayor. Dice de sí mismo que NO es la
//                         declaración, en su primera línea.
//   · SERIALIZADOR_SAT  → se niega, y enumera qué hay que confirmar. El día
//                         que se confirme, se implementa aquí y nada más
//                         cambia: los datos ya están.
// ============================================================

export class DiotNoEntregable extends AppError {
  constructor(mensaje: string, details?: Record<string, unknown>) {
    super(422, 'DIOT_NO_ENTREGABLE', mensaje, undefined, details);
    this.name = 'DiotNoEntregable';
  }
}

export class DiotFormatoNoFundamentado extends AppError {
  constructor(mensaje: string, details?: Record<string, unknown>) {
    super(501, 'DIOT_FORMATO_NO_FUNDAMENTADO', mensaje, undefined, details);
    this.name = 'DiotFormatoNoFundamentado';
  }
}

/**
 * Lo que hace falta saber para escribir el archivo que la autoridad recibe.
 * Es una lista, y no prosa, para que el día que se confirme se pueda tachar
 * punto por punto — y para que una prueba pueda comprobar que el serializador
 * sigue negándose mientras quede alguno.
 */
export const LO_QUE_FALTA_CONFIRMAR: readonly string[] = Object.freeze([
  'El orden y el número exacto de campos de cada registro, contra el layout vigente publicado por el SAT.',
  'Si los importes se declaran redondeados a pesos sin decimales o con centavos, y con qué regla de redondeo.',
  'Si el archivo lleva registro de cabecera (RFC del declarante, periodo, tipo de declaración) o empieza directo por el primer tercero.',
  'Qué campo ocupa el IVA retenido y si se declara junto al tercero o en un registro aparte.',
  'Si las operaciones de la región fronteriza (8 %) y las de importación tienen campo propio o comparten el del 16 %.',
  'El terminador de registro y la codificación del archivo, y si el último campo lleva barra final.',
  'Si un tercero con varias tasas ocupa un registro con todas las casillas o un registro por tasa.',
]);

export interface SerializadorDiot {
  nombre: string;
  extension: string;
  /**
   * true SÓLO si lo que produce es el archivo que la autoridad recibe. El
   * papel de trabajo vale false a propósito: es la diferencia entre un
   * documento que se revisa y uno que se presenta, y confundirlas es
   * exactamente el accidente que este campo existe para evitar.
   */
  esArchivoDeclarable: boolean;
  serializar(diot: DiotConstruida): string;
}

/** Ningún archivo declarable sale con un hallazgo bloqueante encima. */
export function exigirEntregable(diot: DiotConstruida): void {
  const b = bloquean(diot.hallazgos);
  if (b.length === 0) return;
  throw new DiotNoEntregable(
    `La DIOT de ${String(diot.periodo.mes).padStart(2, '0')}/${diot.periodo.anio} tiene ` +
      `${b.length} problema(s) que impiden entregarla:\n` +
      b.map((h) => `  · [${h.codigo}] ${h.mensaje}`).join('\n'),
    { codigos: b.map((h) => h.codigo) }
  );
}

// ------------------------------------------------------------
// EL PAPEL DE TRABAJO
// ------------------------------------------------------------

const SEP = '|';

const COLUMNAS: readonly string[] = Object.freeze([
  'tipo_tercero',
  'tipo_operacion',
  'rfc',
  'id_fiscal_extranjero',
  'pais_residencia',
  'nacionalidad',
  'nombre',
  'base_16',
  'iva_16',
  'base_8',
  'iva_8',
  'base_0',
  'base_exento',
  'iva_retenido',
  'otras_tasas',
  'documentos',
]);

/**
 * Ningún valor puede traer el separador dentro.
 *
 * Es la misma puerta que `exigirValorDeAtributo` en el Anexo 24 y por la
 * misma razón: `company_name` es texto libre de 255 caracteres, y un nombre
 * con una barra vertical no rompe nada visiblemente — corre las columnas una
 * posición y produce un papel que cuadra en los totales y miente en cada
 * fila. Se sustituye por un espacio y se deja constancia en el propio valor.
 */
function saneado(valor: string): string {
  return valor.includes(SEP) || /[\r\n]/.test(valor)
    ? valor.replace(/[|\r\n]+/g, ' ').trim()
    : valor;
}

function fila(r: RenglonDiot): string {
  const t = r.tercero;
  const otras = r.desglose.otras
    .map((o) => `${o.etiqueta}=${o.base}/${o.iva}`)
    .join(';');
  return [
    t.tipoTercero,
    t.tipoOperacion,
    t.rfc ?? '',
    t.idFiscalExtranjero ?? '',
    t.paisResidencia ?? '',
    t.nacionalidad ?? '',
    saneado(t.nombre),
    r.desglose.tasa16.base,
    r.desglose.tasa16.iva,
    r.desglose.tasa8.base,
    r.desglose.tasa8.iva,
    r.desglose.tasa0.base,
    r.desglose.exento.base,
    r.ivaRetenido,
    otras,
    r.documentos.map((d) => saneado(d.billNumber)).join(' '),
  ].join(SEP);
}

/**
 * La conciliación por tercero. NO es la declaración, y lo dice en su primera
 * línea, en español y sin abreviar, porque un archivo de texto separado por
 * barras se parece lo bastante al de la declaración como para que alguien lo
 * suba por error.
 */
export const PAPEL_DE_TRABAJO: SerializadorDiot = {
  nombre: 'papel de trabajo de la DIOT',
  extension: '.txt',
  esArchivoDeclarable: false,
  serializar(diot: DiotConstruida): string {
    const conteo = contarHallazgos(diot.hallazgos);
    const mes = String(diot.periodo.mes).padStart(2, '0');
    const lineas: string[] = [
      '# PAPEL DE TRABAJO DE LA DIOT — ESTO NO ES EL ARCHIVO DE LA DECLARACIÓN.',
      '# No se sube al portal del SAT. Sirve para cotejar contra el mayor antes de capturar.',
      `# Contribuyente: ${saneado(diot.rfc)} — ${saneado(diot.razonSocial)}`,
      `# Periodo: ${mes}/${diot.periodo.anio} (${diot.periodo.desde} a ${diot.periodo.hasta})`,
      `# Base: operaciones PAGADAS (LIVA art. 5 frac. III), no devengadas.`,
      `# Terceros: ${diot.totales.terceros} · documentos: ${diot.totales.documentos}`,
      `# IVA acreditable pagado en el mes: ${diot.totales.ivaAcreditablePagado} ` +
        `(debe cuadrar contra el movimiento de iva_acreditable del periodo)`,
      `# IVA retenido: ${diot.totales.ivaRetenido}`,
      `# Hallazgos: ${conteo.bloqueante} bloqueante(s), ${conteo.aviso} aviso(s)`,
      ...diot.politicas.map(
        (p) => `# Política ${p.clave} = ${p.valor} (${p.definida ? 'contestada' : 'por omisión'})`
      ),
    ];
    if (conteo.bloqueante > 0) {
      lineas.push(
        '# LA DECLARACIÓN NO SE PUEDE ENTREGAR TAL CUAL: hay hallazgos bloqueantes.',
        ...bloquean(diot.hallazgos).map((h) => `#   [${h.codigo}] ${saneado(h.mensaje)}`)
      );
    }
    lineas.push(`# ${COLUMNAS.join(SEP)}`);
    lineas.push(...diot.renglones.map(fila));
    return `${lineas.join('\n')}\n`;
  },
};

/**
 * El archivo que la autoridad recibe. Se niega, con la lista de lo que falta.
 *
 * No es un `TODO`: es el resultado de haber buscado el layout y no poder
 * fundamentarlo. Devolver algo aquí sería devolver un archivo que se descubre
 * mal el día que lo rechazan.
 */
export const SERIALIZADOR_SAT: SerializadorDiot = {
  nombre: 'archivo de lote de la DIOT (SAT)',
  extension: '.txt',
  esArchivoDeclarable: true,
  serializar(diot: DiotConstruida): string {
    exigirEntregable(diot);
    throw new DiotFormatoNoFundamentado(
      `Los datos de la DIOT de ${String(diot.periodo.mes).padStart(2, '0')}/` +
        `${diot.periodo.anio} están completos y verificados (${diot.totales.terceros} tercero(s), ` +
        `${diot.totales.ivaAcreditablePagado} de IVA acreditable pagado), pero el LAYOUT del ` +
        `archivo de lote no está fundamentado en este repositorio y no se inventa: un formato ` +
        `inventado no falla al generarse, falla al ser rechazado por la autoridad, y para ` +
        `entonces el plazo corrió.\n` +
        `Falta confirmar contra el layout vigente:\n` +
        LO_QUE_FALTA_CONFIRMAR.map((x) => `  · ${x}`).join('\n') +
        `\nMientras tanto: PAPEL_DE_TRABAJO produce la conciliación por tercero para capturar ` +
        `en el portal, y presentar la DIOT sigue siendo un acto humano.`,
      { faltan: LO_QUE_FALTA_CONFIRMAR.length }
    );
  },
};
