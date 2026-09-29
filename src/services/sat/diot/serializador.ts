import { AppError } from '../../../utils/errors.js';
import { bloquean, contarHallazgos } from './hallazgos.js';
import type { DiotConstruida, RenglonDiot } from './modelo.js';
import { layoutForYear, SAT_BATCH_LAYOUTS, SAT_SOURCE, serializeSatBatch } from './sat-batch.js';

// ============================================================
// F07c · CÓMO SE ESCRIBE LA DIOT
//
// Two serializers behind one interface:
//   · PAPEL_DE_TRABAJO  → the per-third-party reconciliation, readable and
//                         checked against the ledger. Its first line says it
//                         is NOT the declaration.
//   · SERIALIZADOR_SAT  → the batch file the SAT receives (MNE-001-055,
//                         #307). The layout lives in sat-batch.ts, grounded
//                         in the SAT instructivo cited there with the date it
//                         was consulted.
//
// THIS REPOSITORY ONCE SHIPPED AN INVENTED LAYOUT AND DELETED IT.
// `generateDIOT` (src/services/mexico/cfdi.ts, removed) wrote
// `tipo|rfc|||nombre||||total|impuesto||||||||` with no document behind it.
// An invented format does not fail when generated; it fails when REJECTED,
// after the deadline. That is why the SAT serializer still refuses a period
// whose layout is not grounded (DiotFormatoNoFundamentado) and every third
// party the grounded layout cannot express (DiotNoEntregable).
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
 * The file the authority receives. It generates; it never files — presenting
 * the DIOT is a human act in the SAT portal.
 *
 * Refuses, in this order: blocking findings (exigirEntregable), a period with
 * no grounded layout, and third parties the layout cannot express — all of
 * them named at once.
 */
export const SERIALIZADOR_SAT: SerializadorDiot = {
  nombre: 'archivo de lote de la DIOT (SAT)',
  extension: '.txt',
  esArchivoDeclarable: true,
  serializar(diot: DiotConstruida): string {
    exigirEntregable(diot);
    const periodo = `${String(diot.periodo.mes).padStart(2, '0')}/${diot.periodo.anio}`;
    if (layoutForYear(diot.periodo.anio) === null) {
      throw new DiotFormatoNoFundamentado(
        `La DIOT de ${periodo} se presenta con el layout del ejercicio 2024 y anteriores, que ` +
          `este repositorio no implementa: sólo está fundamentado el de 2025 en adelante ` +
          `(${SAT_SOURCE.url}, consultado el ${SAT_SOURCE.consulted}). No se escribe con la ` +
          `forma nueva un periodo que la autoridad valida con la vieja.`,
        { primer_ejercicio: SAT_BATCH_LAYOUTS[SAT_BATCH_LAYOUTS.length - 1].firstYear }
      );
    }
    if (diot.renglones.length === 0) {
      throw new DiotNoEntregable(
        `La DIOT de ${periodo} no tiene terceros que declarar: un archivo de lote vacío no es ` +
          `una declaración, y no se escribe.`,
        { terceros: 0 }
      );
    }
    const proportion =
      diot.politicas.find((p) => p.clave === 'diot_iva_acreditable_proporcion')?.valor ??
      'solo_gravadas';
    const { file, refusals } = serializeSatBatch(diot, { proportion });
    if (refusals.length > 0) {
      throw new DiotNoEntregable(
        `La DIOT de ${periodo} no cabe en el layout del SAT tal cual:\n` +
          refusals.map((r) => `  · ${r.message}`).join('\n'),
        { vendors: refusals.map((r) => r.vendorId).filter((v) => v !== '') }
      );
    }
    return file;
  },
};
