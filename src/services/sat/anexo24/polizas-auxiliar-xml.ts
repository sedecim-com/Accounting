import { ValidationError } from '../../../utils/errors.js';
import { serializar, type Atributo, type NodoXml } from './xml.js';
import {
  atributosDeCabecera,
  atributosDeSolicitud,
  nodoDeComprobante,
  type Comprobante,
  type Solicitud,
} from './polizas-xml.js';

// ============================================================
// F07d · LOS DOS AUXILIARES — RepAuxFol 1.3 y AuxiliarCtas 1.3
//
// `e-accounting subledger generate --kind folios|accounts`
// · `contabilidad-electronica auxiliar generar`
//
// LA FILA DEL CATÁLOGO, LEÍDA LITERAL (docs/cli-command-catalog.md:2067):
//
//   «Genera el auxiliar de folios de comprobantes o el auxiliar de cuenta y
//    subcuenta, que el SAT pide sólo a requerimiento»
//   Flags: `--period`, `--kind folios|accounts`, `--dry-run`, `-o/--output`.
//
// Son DOS archivos y DOS esquemas, no uno con una bandera: el de folios lista
// los comprobantes que respaldan cada póliza; el de cuentas lista el
// movimiento de cada cuenta con su saldo inicial y final. La bandera elige
// cuál, y por eso `--kind` no tiene valor por omisión — entregar el auxiliar
// equivocado a un requerimiento es no contestarlo.
//
// ── QUÉ SE COMPARTE CON LAS PÓLIZAS, Y QUÉ NO ───────────────────────────
//
// El encargo dice: «si comparte estructura con las pólizas, compártela de
// verdad». Comparte, y se comparte:
//
//   · LA CABECERA DE SOLICITUD. Los tres esquemas se entregan a requerimiento
//     y los tres llevan TipoSolicitud con la misma exclusión entre NumOrden y
//     NumTramite. Vive una sola vez, en `atributosDeSolicitud`.
//   · LA CABECERA DE IDENTIFICACIÓN. RFC, Mes y Anio, con la misma validación
//     y el mismo mes 13. `atributosDeCabecera`.
//   · EL NODO DE COMPROBANTE. Un CFDI nacional con su UUID, su RFC y su monto
//     es el MISMO dato en la póliza y en el auxiliar de folios. Lo único que
//     cambia es el nombre del elemento —`CompNal` allí, `ComprNal` aquí— y por
//     eso `nodoDeComprobante` lo recibe como parámetro en vez de existir dos
//     veces. Duplicarlo para cambiar una letra es como se consigue que dentro
//     de un año uno de los dos emita `Moneda` y el otro no.
//   · EL SERIALIZADOR, que es el de F07b y sigue siendo el único.
//
// Lo que NO se comparte es la FORMA: el auxiliar de folios anida
// póliza→comprobante sin renglones contables en medio, y el de cuentas anida
// cuenta→movimiento, que no se parece a nada de lo anterior. Forzar un molde
// común entre los dos habría sido la copia disfrazada de abstracción.
//
// ── LO QUE NO PUDE VERIFICAR ────────────────────────────────────────────
//
// Lo mismo que en pólizas y por la misma razón: no hay un `.xsd` en este
// repositorio. Los nombres de nodo y de atributo son los de la estructura
// publicada del Anexo 24; el prefijo `RepAuxFol` es el habitual y no el
// obligatorio. Ninguno de los dos archivos se sella aquí.
// ============================================================

const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';

// ── AUXILIAR DE FOLIOS ──────────────────────────────────────────────────

export const NS_AUX_FOLIOS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarFolios';
export const PREFIJO_AUX_FOLIOS = 'RepAuxFol';
export const UBICACION_XSD_AUX_FOLIOS = `${NS_AUX_FOLIOS}/AuxiliarFolios_1_3.xsd`;
export const VERSION_AUX_FOLIOS = '1.3';

/** Los nombres del comprobante EN EL AUXILIAR DE FOLIOS: `Compr`, no `Comp`. */
export const COMPROBANTES_DE_FOLIOS = {
  nacional: 'ComprNal',
  nacionalOtro: 'ComprNalOtr',
  extranjero: 'ComprExt',
} as const;

/** Una póliza con los comprobantes que la respaldan. */
export interface DetalleDeFolios {
  numUnIdenPol: string;
  /** YYYY-MM-DD. */
  fecha: string;
  comprobantes: readonly Comprobante[];
}

export interface DatosDeAuxiliarFolios {
  rfc: string;
  anio: number;
  mes: string;
  solicitud: Solicitud;
  detalles: readonly DetalleDeFolios[];
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function nodoDeAuxiliarFolios(d: DatosDeAuxiliarFolios): NodoXml {
  if (d.detalles.length === 0) {
    throw new ValidationError(
      `El auxiliar de folios de ${d.mes}/${d.anio} no tiene ninguna póliza con comprobante. Un ` +
        `archivo vacío contesta al requerimiento diciendo que ninguna póliza del periodo tiene ` +
        `comprobante fiscal detrás, que es una afirmación sobre los libros y no un formato.`
    );
  }
  // Una póliza sin comprobantes NO va: el auxiliar de folios existe para
  // relacionar folios, y un DetAuxFol vacío ocupa sitio sin decir nada. Quien
  // llama filtra; aquí se comprueba, porque el filtro que se olvida produce un
  // archivo que el validador del SAT rechaza por nodo incompleto.
  for (const det of d.detalles) {
    if (det.comprobantes.length === 0) {
      throw new ValidationError(
        `La póliza ${det.numUnIdenPol} entra al auxiliar de folios sin ningún comprobante. El nodo ` +
          `DetAuxFol existe para listar folios: vacío no relaciona nada.`
      );
    }
    if (!FECHA_RE.test(det.fecha)) {
      throw new ValidationError(
        `DetAuxFol/@Fecha = «${det.fecha}» en ${det.numUnIdenPol} no tiene forma YYYY-MM-DD.`
      );
    }
  }

  return {
    nombre: `${PREFIJO_AUX_FOLIOS}:RepAuxFol`,
    atributos: [
      ['xmlns:xsi', NS_XSI],
      [`xmlns:${PREFIJO_AUX_FOLIOS}`, NS_AUX_FOLIOS],
      ['xsi:schemaLocation', `${NS_AUX_FOLIOS} ${UBICACION_XSD_AUX_FOLIOS}`],
      ['Version', VERSION_AUX_FOLIOS],
      ...atributosDeCabecera(d.rfc, d.anio, d.mes, { mes13: true }),
      ...atributosDeSolicitud(d.solicitud),
    ],
    hijos: d.detalles.map((det) => ({
      nombre: `${PREFIJO_AUX_FOLIOS}:DetAuxFol`,
      atributos: [
        ['NumUnIdenPol', det.numUnIdenPol],
        ['Fecha', det.fecha],
      ] as Atributo[],
      hijos: [
        ...det.comprobantes
          .filter((c) => c.clase === 'nacional')
          .map((c) => nodoDeComprobante(PREFIJO_AUX_FOLIOS, COMPROBANTES_DE_FOLIOS, c)),
        ...det.comprobantes
          .filter((c) => c.clase === 'nacional_otro')
          .map((c) => nodoDeComprobante(PREFIJO_AUX_FOLIOS, COMPROBANTES_DE_FOLIOS, c)),
        ...det.comprobantes
          .filter((c) => c.clase === 'extranjero')
          .map((c) => nodoDeComprobante(PREFIJO_AUX_FOLIOS, COMPROBANTES_DE_FOLIOS, c)),
      ],
    })),
  };
}

export function construirAuxiliarFoliosXml(d: DatosDeAuxiliarFolios): string {
  return serializar(nodoDeAuxiliarFolios(d));
}

// ── AUXILIAR DE CUENTA Y SUBCUENTA ──────────────────────────────────────

export const NS_AUX_CTAS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/AuxiliarCtas';
export const PREFIJO_AUX_CTAS = 'AuxiliarCtas';
export const UBICACION_XSD_AUX_CTAS = `${NS_AUX_CTAS}/AuxiliarCtas_1_3.xsd`;
export const VERSION_AUX_CTAS = '1.3';

/** Un renglón del movimiento de una cuenta. */
export interface MovimientoAuxiliar {
  /** YYYY-MM-DD. */
  fecha: string;
  /** El NumUnIdenPol de la póliza que lo produjo: la liga con el otro archivo. */
  numUnIdenPol: string;
  concepto: string;
  /** Ya formateados con `importeAnexo24`. */
  debe: string;
  haber: string;
}

export interface CuentaAuxiliar {
  numCta: string;
  desCta: string;
  /** Con el SIGNO que el Anexo 24 declara, ya resuelto por quien construye. */
  saldoIni: string;
  saldoFin: string;
  movimientos: readonly MovimientoAuxiliar[];
}

export interface DatosDeAuxiliarCuentas {
  rfc: string;
  anio: number;
  mes: string;
  solicitud: Solicitud;
  cuentas: readonly CuentaAuxiliar[];
}

const IMPORTE_RE = /^-?\d+\.\d{2}$/;

function exigirImporte(donde: string, atributo: string, valor: string): string {
  if (!IMPORTE_RE.test(valor)) {
    throw new ValidationError(
      `${donde}/@${atributo} = «${valor}»: el Anexo 24 declara importes con DOS decimales exactos. ` +
        `Fórmatelo con importeAnexo24() antes de construir el nodo.`
    );
  }
  return valor;
}

export function nodoDeAuxiliarCuentas(d: DatosDeAuxiliarCuentas): NodoXml {
  if (d.cuentas.length === 0) {
    throw new ValidationError(
      `El auxiliar de cuentas de ${d.mes}/${d.anio} no declara ninguna cuenta. Contestar así a un ` +
        `requerimiento afirma que en el periodo no se movió ninguna cuenta.`
    );
  }
  const repetidas = [
    ...new Set(d.cuentas.map((c) => c.numCta).filter((n, i, t) => t.indexOf(n) !== i)),
  ];
  if (repetidas.length > 0) {
    throw new ValidationError(
      `NumCta repetido en el auxiliar de cuentas: ${repetidas.join(', ')}. Dos nodos Cuenta con el ` +
        `mismo número declaran dos saldos para una sola cuenta.`
    );
  }

  return {
    nombre: `${PREFIJO_AUX_CTAS}:AuxiliarCtas`,
    atributos: [
      ['xmlns:xsi', NS_XSI],
      [`xmlns:${PREFIJO_AUX_CTAS}`, NS_AUX_CTAS],
      ['xsi:schemaLocation', `${NS_AUX_CTAS} ${UBICACION_XSD_AUX_CTAS}`],
      ['Version', VERSION_AUX_CTAS],
      ...atributosDeCabecera(d.rfc, d.anio, d.mes, { mes13: true }),
      ...atributosDeSolicitud(d.solicitud),
    ],
    hijos: d.cuentas.map((c) => {
      const cuenta = `${PREFIJO_AUX_CTAS}:Cuenta`;
      return {
        nombre: cuenta,
        atributos: [
          ['NumCta', c.numCta],
          ['DesCta', c.desCta],
          ['SaldoIni', exigirImporte(cuenta, 'SaldoIni', c.saldoIni)],
          ['SaldoFin', exigirImporte(cuenta, 'SaldoFin', c.saldoFin)],
        ] as Atributo[],
        hijos: c.movimientos.map((m) => {
          const det = `${PREFIJO_AUX_CTAS}:DetalleAux`;
          if (!FECHA_RE.test(m.fecha)) {
            throw new ValidationError(
              `${det}/@Fecha = «${m.fecha}» en la cuenta ${c.numCta} no tiene forma YYYY-MM-DD.`
            );
          }
          return {
            nombre: det,
            atributos: [
              ['Fecha', m.fecha],
              ['NumUnIdenPol', m.numUnIdenPol],
              ['Concepto', m.concepto],
              ['Debe', exigirImporte(det, 'Debe', m.debe)],
              ['Haber', exigirImporte(det, 'Haber', m.haber)],
            ] as Atributo[],
          };
        }),
      };
    }),
  };
}

export function construirAuxiliarCuentasXml(d: DatosDeAuxiliarCuentas): string {
  return serializar(nodoDeAuxiliarCuentas(d));
}

/**
 * Nombre del archivo: RFC + Anio + Mes + «XF» (folios) o «XC» (cuentas).
 * NO VERIFICADO contra la guía oficial, igual que sus hermanos de F07b.
 */
export function nombreDelArchivoAuxiliar(
  d: { rfc: string; anio: number; mes: string },
  clase: 'folios' | 'accounts'
): string {
  return `${d.rfc}${d.anio}${d.mes}${clase === 'folios' ? 'XF' : 'XC'}.XML`;
}
