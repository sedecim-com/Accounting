import { ValidationError } from '../../../utils/errors.js';
import { importesDeclarados, type CuentaDeBalanza } from './balanza-invariantes.js';
import { serializar, type Atributo, type NodoXml } from './xml.js';

// ============================================================
// F07b · EL XML DE LA BalanzaComprobacion 1.3
//
// LA SERIALIZACIÓN NO SE ESCRIBE AQUÍ. Va por `serializar` (xml.ts), que es la
// única puerta del constructor: el escapado es estructural, los valores pasan
// por `exigirValorDeAtributo` y los atributos viajan como LISTA ORDENADA, que
// es lo que sostiene el requisito literal del catálogo de comandos —bytes
// idénticos para entradas idénticas—, porque así es como un humano compara la
// presentación de este mes contra la del anterior.
//
// Lo que sí vive aquí es la FORMA DE LA BALANZA: qué atributos lleva el nodo
// raíz, en qué orden, y qué combinaciones se niegan antes de construir nada.
//
// EL ARCHIVO SALE **SIN SELLAR**, SIEMPRE. Los atributos Sello, noCertificado
// y Certificado existen en el esquema y este módulo no los emite ni tiene por
// dónde: no hay una sola rama que cargue una llave privada, y no debe haberla.
// La e.firma es el contribuyente firmando, no el software. Construir el
// archivo y firmarlo son actos distintos y de manos distintas.
//
// LO QUE NO PUDE VERIFICAR, dicho en vez de afirmado:
//   · El esquema NO se validó contra el XSD oficial: no hay ni un `.xsd` en el
//     repositorio, ninguna librería aquí valida contra esquema, y esta máquina
//     no tiene red. Lo de abajo es lo que el generador EMITE.
//   · `NumOrden` y `NumTramite` NO se emiten. Los recuerdo en los esquemas que
//     el SAT pide a requerimiento —auxiliares y pólizas— y no me consta que la
//     Balanza los admita. Emitir un atributo que el XSD no declara invalida el
//     archivo entero; omitir uno opcional, no. El día que se traiga el XSD, es
//     una línea en `raiz`.
// ============================================================

/** N normal, C complementaria. Es el atributo TipoEnvio del nodo raíz. */
export type TipoEnvio = 'N' | 'C';

export const NS_BALANZA = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';
export const PREFIJO_BALANZA = 'BCE';
export const UBICACION_XSD_BALANZA =
  'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd';
// Sin `export`: `validador.ts` ya publica esta misma constante, y dos
// exportaciones del mismo nombre chocarían el día que el barril reexporte los
// dos módulos.
const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';
export const VERSION_BALANZA = '1.3';

/** El RFC de una persona moral son 12 caracteres y el de una física 13. */
const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mes «13» es la BALANZA DE CIERRE del ejercicio, no un mes del calendario.
 * Es lo ÚNICO que la distingue dentro del archivo: mismo esquema, mismo
 * TipoEnvio, misma estructura. Lo que cambia está fuera, en qué movimiento
 * declara: los ajustes con los que se cierra el ejercicio.
 */
export const MES_DE_CIERRE = '13';

/** Rango de ejercicios que el esquema admite en Anio. NO VERIFICADO. */
export const ANIO_MINIMO = 2015;
export const ANIO_MAXIMO = 2099;

export interface DatosDeBalanza {
  /** RFC del contribuyente. Sale de legal_entities.tax_id con tax_id_type 'rfc'. */
  rfc: string;
  anio: number;
  /** '01'..'12' para un mes, '13' para la balanza de cierre. */
  mes: string;
  tipoEnvio: TipoEnvio;
  /** Obligatoria, y sólo válida, cuando TipoEnvio es 'C'. YYYY-MM-DD. */
  fechaModBal?: string;
  /** Ya ordenadas por NumCta: el orden de las filas es parte de los bytes. */
  cuentas: readonly CuentaDeBalanza[];
}

function validar(d: DatosDeBalanza): void {
  if (!RFC_RE.test(d.rfc)) {
    throw new ValidationError(
      `«${d.rfc}» no tiene forma de RFC. La balanza del Anexo 24 la presenta un contribuyente ` +
        `mexicano ante el SAT; una entidad identificada con EIN u otro número no puede presentarla.`
    );
  }
  if (!/^(0[1-9]|1[0-3])$/.test(d.mes)) {
    throw new ValidationError(
      `Mes «${d.mes}» no es válido: el Anexo 24 admite '01'..'12' y '13' para la balanza de cierre.`
    );
  }
  if (!Number.isInteger(d.anio) || d.anio < ANIO_MINIMO || d.anio > ANIO_MAXIMO) {
    throw new ValidationError(
      `Anio ${d.anio} está fuera del rango que el esquema admite (${ANIO_MINIMO}..${ANIO_MAXIMO}).`
    );
  }
  // FechaModBal es la fecha en que se modificó la balanza. Sin ella, una
  // complementaria no dice QUÉ presentación corrige.
  if (d.tipoEnvio === 'C' && d.fechaModBal === undefined) {
    throw new ValidationError(
      `Una balanza complementaria (TipoEnvio 'C') necesita FechaModBal: es la fecha de la ` +
        `modificación, y sin ella la autoridad no sabe qué presentación se está corrigiendo.`
    );
  }
  if (d.tipoEnvio === 'N' && d.fechaModBal !== undefined) {
    throw new ValidationError(
      `FechaModBal sólo va en una balanza complementaria; ésta es normal (TipoEnvio 'N'). ` +
        `Presentar una normal con fecha de modificación declara dos cosas que se contradicen.`
    );
  }
  if (d.fechaModBal !== undefined && !FECHA_RE.test(d.fechaModBal)) {
    throw new ValidationError(`FechaModBal «${d.fechaModBal}» no tiene forma YYYY-MM-DD.`);
  }
  if (d.cuentas.length === 0) {
    // El esquema pide al menos un nodo Ctas. Y una balanza vacía que se
    // presenta es peor que un error: se acepta, y declara que no hubo nada.
    throw new ValidationError(
      `La balanza ${d.mes}/${d.anio} no tiene ninguna cuenta que declarar. Un archivo con cero ` +
        `nodos Ctas afirma ante la autoridad que en ese periodo no hubo contabilidad.`
    );
  }
  const repetidas = [
    ...new Set(d.cuentas.map((c) => c.num_cta).filter((n, i, todas) => todas.indexOf(n) !== i)),
  ];
  if (repetidas.length > 0) {
    throw new ValidationError(
      `NumCta repetido en la balanza: ${repetidas.join(', ')}. Dos nodos Ctas con el mismo número ` +
        `declaran dos saldos para una sola cuenta, y la autoridad se queda con uno de los dos.`
    );
  }
}

/** El árbol de la balanza. Separado de la serialización para poder inspeccionarlo. */
export function nodoDeBalanza(d: DatosDeBalanza): NodoXml {
  validar(d);

  const raiz: Atributo[] = [
    ['xmlns:xsi', NS_XSI],
    [`xmlns:${PREFIJO_BALANZA}`, NS_BALANZA],
    ['xsi:schemaLocation', `${NS_BALANZA} ${UBICACION_XSD_BALANZA}`],
    ['Version', VERSION_BALANZA],
    ['RFC', d.rfc],
    ['Mes', d.mes],
    ['Anio', String(d.anio)],
    ['TipoEnvio', d.tipoEnvio],
    ['FechaModBal', d.fechaModBal],
  ];

  return {
    nombre: `${PREFIJO_BALANZA}:Balanza`,
    atributos: raiz,
    hijos: d.cuentas.map((c) => {
      const i = importesDeclarados(c);
      return {
        nombre: `${PREFIJO_BALANZA}:Ctas`,
        atributos: [
          ['NumCta', c.num_cta],
          ['SaldoIni', i.SaldoIni],
          ['Debe', i.Debe],
          ['Haber', i.Haber],
          ['SaldoFin', i.SaldoFin],
        ] as Atributo[],
      };
    }),
  };
}

/**
 * El XML. Sin fecha de generación, sin identificadores internos y sin nada que
 * cambie entre dos corridas con los mismos datos.
 */
export function construirBalanzaXml(d: DatosDeBalanza): string {
  return serializar(nodoDeBalanza(d));
}

/**
 * Nombre con el que se entrega el archivo: RFC + Anio + Mes + «B» + tipo.
 * «B» de balanza; el catálogo usa «CT». NO VERIFICADO contra la guía oficial.
 */
export function nombreDelArchivo(
  d: Pick<DatosDeBalanza, 'rfc' | 'anio' | 'mes' | 'tipoEnvio'>
): string {
  return `${d.rfc}${d.anio}${d.mes}B${d.tipoEnvio}.XML`;
}
