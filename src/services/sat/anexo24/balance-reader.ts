import Decimal from 'decimal.js';
import { XMLValidator } from 'fast-xml-parser';
import { ValidationError } from '../../../utils/errors.js';
import {
  anexo24Parser,
  esObjeto,
  readAttribute,
  scalarText,
  type CatalogReadFinding,
} from './catalog-reader.js';
import { NS_BALANZA, VERSION_BALANZA } from './balanza-xml.js';

// ============================================================
// O1 · EL LECTOR DE LA BalanzaComprobacion — LA SEGUNDA CAPA
//
// La capa 1 leyó el CtaCatalogo y dejó las cuentas creadas. Éste lee el otro
// archivo del Anexo 24, el que trae DINERO, y es el espejo de `balanza-xml.ts`
// exactamente igual que `catalog-reader.ts` lo es de `catalogo-cuentas.ts`:
// cinco atributos por fila —NumCta, SaldoIni, Debe, Haber, SaldoFin— y una
// cabecera de seis. Si el escritor y el lector no coincidieran, el sistema no
// podría releer la balanza que él mismo entrega, que es la comprobación que
// cierra este tramo.
//
// ── LO QUE ESTE ARCHIVO **NO** TRAE, Y CAMBIA TODO ──────────────────────
//
// LA BALANZA NO DECLARA `Natur`. El catálogo sí; la balanza no. Y sin
// naturaleza un SaldoFin de «8300.00» no dice si la cuenta debe u ostenta:
// el Anexo 24 declara cada saldo EN SU PROPIA NATURALEZA, de modo que el
// mismo 8 300 es un cargo en una cuenta deudora y un abono en una acreedora.
// Por eso este lector NO convierte a la convención del mayor: devuelve las
// cifras TAL COMO EL ARCHIVO LAS DECLARA, y la conversión vive en
// `opening-balance.ts`, que es quien tiene delante la naturaleza de cada
// cuenta —la que el catálogo dejó escrita en `accounts.normal_balance`—.
// Adivinarla aquí, por el rango del código o por el signo, invertiría el
// saldo de una cuenta entera: el descuadre valdría el DOBLE del saldo.
//
// LO ÚNICO QUE SÍ SE PUEDE COMPROBAR SIN NATURALEZA es que alguna de las dos
// naturalezas posibles cuadre. La autoridad rehace
//
//     deudora:   SaldoIni + Debe − Haber = SaldoFin
//     acreedora: SaldoIni − Debe + Haber = SaldoFin
//
// y si NINGUNA de las dos da el SaldoFin declarado, la fila está mal bajo
// cualquier hipótesis y no hace falta saber cuál es la buena para decirlo.
// Ese es `LEC-BAL-RECALCULO`, y es la comprobación más valiosa de este
// archivo: caza el descuadre en el ORIGEN, antes de que se convierta en un
// asiento de apertura que no cuadra y en una noche buscando el peso.
//
// ── QUÉ LANZA Y QUÉ ANOTA ───────────────────────────────────────────────
//
// La misma disciplina que la capa 1, por la misma razón: LANZA sólo cuando no
// hay balanza que leer —XML mal formado, raíz que no es `Balanza`, cabecera
// sin RFC—, y ANOTA todo lo demás con su número de fila para que un archivo de
// ochocientas cuentas no exija ochocientas corridas.
// ============================================================

/** Un defecto de una FILA de la balanza. Es el mismo tipo que usa la capa 1. */
export type BalanceReadFinding = CatalogReadFinding;

/** Una fila `Ctas` de la balanza, con sus cuatro columnas TAL COMO VIENEN. */
export interface BalanceFileRow {
  /** Posición del nodo en el archivo, empezando en 1. */
  fila: number;
  numCta: string;
  /**
   * Las cuatro columnas, en la convención del ARCHIVO (cada saldo en su
   * naturaleza) y como CADENA. Nunca `number`: la coma flotante de JavaScript
   * convierte 1120.10 en 1120.0999999 y el centavo se pierde antes de llegar
   * al mayor, donde ya nadie lo busca.
   */
  saldoIni: string;
  debe: string;
  haber: string;
  saldoFin: string;
}

export interface BalanceFileHeader {
  version: string;
  rfc: string;
  /** '01'..'12', o '13' si es la balanza de cierre del ejercicio. */
  mes: string;
  anio: string;
  /** 'N' normal, 'C' complementaria. Vacío si el archivo no lo declara. */
  tipoEnvio: string;
  fechaModBal: string | null;
}

export interface BalanceFileRead {
  header: BalanceFileHeader;
  /** Sólo las filas con las cinco casillas legibles. */
  rows: readonly BalanceFileRow[];
  /** Cuántos nodos `Ctas` traía el archivo, defectuosos incluidos. */
  rowsLeidas: number;
  findings: readonly BalanceReadFinding[];
  /** false en cuanto hay un hallazgo que bloquea. */
  puedeImportarse: boolean;
}

const ANALIZADOR = anexo24Parser('Ctas');

/**
 * Un importe decimal con signo. `Number("1,120.00")` da NaN y
 * `parseFloat("1120x")` da 1120: los dos convierten un archivo mal exportado
 * en una cifra que parece buena.
 */
const IMPORTE = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * La escala del mayor, que es la que puede GUARDAR lo que se lea. El Anexo 24
 * declara dos decimales y `journal_entry_lines.debit_amount` es DECIMAL(19,4):
 * un archivo con más de cuatro no se redondea en silencio, porque redondear
 * ochocientas cuentas es cómo se pierde el peso que esta capa promete.
 */
export const ESCALA_DEL_MAYOR = 4;

/**
 * Los enteros que caben en DECIMAL(19,4): 19 dígitos en total, cuatro de ellos
 * decimales. Se exporta con la escala porque quien valide un importe fuera de
 * este lector necesita las DOS mitades del mismo límite.
 */
export const ENTEROS_DEL_MAYOR = 19 - ESCALA_DEL_MAYOR;

/** Cada columna con su nombre de atributo, para leerlas de una pasada. */
const COLUMNAS = ['SaldoIni', 'Debe', 'Haber', 'SaldoFin'] as const;
type Columna = (typeof COLUMNAS)[number];

interface ImportesDeLaFila {
  SaldoIni: string;
  Debe: string;
  Haber: string;
  SaldoFin: string;
}

/**
 * Lee una BalanzaComprobacion 1.3 y devuelve sus filas, su cabecera y sus
 * defectos.
 *
 * Función PURA: recibe el texto, no abre archivos ni toca la base. Es lo que
 * permite fijar en una prueba el archivo exacto que produce cada hallazgo y
 * lo que deja probar la ida y vuelta contra `construirBalanzaXml` sin
 * levantar un Postgres.
 */
export function readBalanzaComprobacion(xml: string): BalanceFileRead {
  const veredicto: unknown = XMLValidator.validate(xml);
  if (veredicto !== true) {
    const err = esObjeto(veredicto) ? veredicto['err'] : undefined;
    const detalle = esObjeto(err)
      ? `${scalarText(err['msg'], 'error desconocido')} (línea ${scalarText(err['line'], '?')})`
      : JSON.stringify(veredicto);
    throw new ValidationError(
      `El archivo no es XML bien formado, así que no hay balanza que leer: ${detalle}. ` +
        `Vuelve a exportarlo desde el sistema de origen.`
    );
  }

  const crudo: unknown = ANALIZADOR.parse(xml) as unknown;
  const bruto: unknown = esObjeto(crudo) ? crudo['Balanza'] : undefined;
  // `<Balanza/>` sin un solo atributo se analiza como CADENA VACÍA, no como
  // objeto. Se trata como una raíz sin nada dentro en vez de como «no es una
  // balanza»: lo es, y lo que le falta —el RFC— lo dice el mensaje de abajo,
  // que es el que manda a quien lo lee al sitio correcto.
  const raiz = esObjeto(bruto) ? bruto : bruto === '' ? {} : undefined;
  if (raiz === undefined) {
    // Nombrar lo que SÍ trae. El error más común de esta puerta es entregar el
    // CATÁLOGO en vez de la balanza —los dos salen del mismo menú del sistema
    // de origen, con el mismo RFC en el nombre del archivo—, y «falta Balanza»
    // no ayuda a nadie a darse cuenta.
    const nombres = esObjeto(crudo)
      ? Object.keys(crudo).filter((k) => !k.startsWith('?') && !k.startsWith('#'))
      : [];
    throw new ValidationError(
      `El archivo no es una balanza de comprobación del Anexo 24: su raíz ${
        nombres.length > 0 ? `es <${nombres.join('>, <')}>` : 'no tiene elementos'
      } y se esperaba <Balanza>. ` +
        (nombres.includes('Catalogo')
          ? `Eso es el CATÁLOGO DE CUENTAS: cárgalo con la importación del catálogo, que es la capa ` +
            `anterior, y trae aquí la balanza —el archivo cuyo nombre lleva una B antes del tipo de envío.`
          : `La BalanzaComprobacion y el CtaCatalogo son archivos distintos; esta puerta lee el primero.`)
    );
  }

  const findings: BalanceReadFinding[] = [];

  // ── LA CABECERA ───────────────────────────────────────────────────────
  //
  // Sin RFC no se puede comprobar que la balanza sea de esta entidad. Cargar
  // la apertura de otro contribuyente no se descubre al cargarla: se descubre
  // meses después, cuando los saldos no coinciden con nada.
  const rfc = readAttribute(raiz, 'RFC', undefined, undefined, findings);
  if (!rfc.presente || rfc.valor === '') {
    throw new ValidationError(
      `La balanza no declara RFC en su nodo raíz. Sin él no se puede comprobar que el archivo sea ` +
        `de esta entidad, y cargar los saldos de otro contribuyente es la equivocación más cara de ` +
        `una migración: se detecta meses después y hay que deshacerla cuenta por cuenta.`
    );
  }
  const version = readAttribute(raiz, 'Version', undefined, undefined, findings);
  const mes = readAttribute(raiz, 'Mes', undefined, undefined, findings);
  const anio = readAttribute(raiz, 'Anio', undefined, undefined, findings);
  const tipoEnvio = readAttribute(raiz, 'TipoEnvio', undefined, undefined, findings);
  const fechaModBal = readAttribute(raiz, 'FechaModBal', undefined, undefined, findings);

  if (version.valor !== VERSION_BALANZA) {
    findings.push({
      regla: 'LEC-BAL-VERSION',
      severidad: 'aviso',
      campo: 'Version',
      mensaje:
        `El archivo declara Version="${version.valor}" y este lector está escrito contra la ` +
        `${VERSION_BALANZA}, que es la vigente. Se lee de todas formas —las cinco casillas del nodo ` +
        `Ctas no han cambiado— y se dice para que nadie dé por verificado lo que no se verificó.`,
    });
  }
  if (!/^(0[1-9]|1[0-3])$/.test(mes.valor)) {
    findings.push({
      regla: 'LEC-BAL-MES',
      severidad: 'bloquea',
      campo: 'Mes',
      mensaje:
        `Mes "${mes.valor}" no es válido: el Anexo 24 admite '01'..'12' y '13' para la balanza de ` +
        `cierre. El mes decide a qué corte pertenecen estos saldos, y una apertura cargada del corte ` +
        `equivocado deja sin representar los movimientos de todo un ejercicio.`,
    });
  }
  if (!/^[0-9]{4}$/.test(anio.valor)) {
    findings.push({
      regla: 'LEC-BAL-ANIO',
      severidad: 'bloquea',
      campo: 'Anio',
      mensaje:
        `Anio "${anio.valor}" no es un ejercicio de cuatro dígitos. Sin ejercicio no se sabe qué ` +
        `apertura es ésta.`,
    });
  }
  if (tipoEnvio.valor !== '' && tipoEnvio.valor !== 'N' && tipoEnvio.valor !== 'C') {
    findings.push({
      regla: 'LEC-BAL-TIPO-ENVIO',
      severidad: 'aviso',
      campo: 'TipoEnvio',
      mensaje:
        `TipoEnvio "${tipoEnvio.valor}" no es 'N' ni 'C'. Se lee igual —el tipo de envío no cambia ` +
        `ni una cifra— y se dice porque un archivo que no se identifica como normal ni como ` +
        `complementaria salió de un exportador que no está siguiendo el esquema.`,
    });
  }
  if (!xml.includes(NS_BALANZA)) {
    findings.push({
      regla: 'LEC-BAL-SIN-ESPACIO-DE-NOMBRES',
      severidad: 'aviso',
      mensaje:
        `El archivo no declara el espacio de nombres ${NS_BALANZA}. Tiene la forma de una ` +
        `BalanzaComprobacion y se lee como tal, pero no se identifica como una: revisa de dónde salió.`,
    });
  }

  // ── LAS FILAS ─────────────────────────────────────────────────────────
  const nodos = raiz['Ctas'];
  const lista = Array.isArray(nodos) ? nodos : [];
  if (lista.length === 0) {
    findings.push({
      regla: 'LEC-BAL-VACIA',
      severidad: 'bloquea',
      mensaje:
        `La balanza no declara ni una cuenta. Una apertura sin cuentas no crea ningún asiento y deja ` +
        `la entidad exactamente igual, así que se rehúsa en vez de informar de un éxito sin efecto.`,
    });
  }

  const rows: BalanceFileRow[] = [];
  const vistas = new Map<string, number>();

  for (let i = 0; i < lista.length; i++) {
    const fila = i + 1;
    const nodo: unknown = lista[i];
    if (!esObjeto(nodo)) continue;

    const numCta = readAttribute(nodo, 'NumCta', fila, undefined, findings);
    const codigo = numCta.valor === '' ? undefined : numCta.valor;
    let completa = true;

    if (codigo === undefined) {
      findings.push({
        regla: 'LEC-BAL-NUMCTA-AUSENTE',
        severidad: 'bloquea',
        fila,
        campo: 'NumCta',
        mensaje:
          `La fila ${fila} no trae NumCta. Es el número con el que este saldo apunta a una cuenta del ` +
          `catálogo: sin él el importe no tiene dónde posarse.`,
      });
      completa = false;
    } else {
      const anterior = vistas.get(codigo);
      if (anterior !== undefined) {
        findings.push({
          regla: 'LEC-BAL-NUMCTA-DUPLICADO',
          severidad: 'bloquea',
          fila,
          campo: 'NumCta',
          numCta: codigo,
          mensaje:
            `NumCta "${codigo}" aparece en la fila ${fila} y ya estaba en la ${anterior}. Dos filas ` +
            `declaran dos saldos para una sola cuenta: quedarse con una es elegir a ojo cuál es el ` +
            `saldo de apertura, y sumarlas es inventarse uno tercero.`,
        });
        completa = false;
      } else {
        vistas.set(codigo, fila);
      }
    }

    const importes: Partial<ImportesDeLaFila> = {};
    for (const columna of COLUMNAS) {
      const leido = readAttribute(nodo, columna, fila, codigo, findings);
      const valor = leerImporte(leido.valor, columna, fila, codigo, findings);
      if (valor === null) completa = false;
      else importes[columna] = valor;
    }

    if (!completa || codigo === undefined) continue;
    const cuatro = importes as ImportesDeLaFila;

    // ── EL RECÁLCULO QUE NO NECESITA CONOCER LA NATURALEZA ──────────────
    if (!cuadraEnAlgunaNaturaleza(cuatro)) {
      const ini = new Decimal(cuatro.SaldoIni);
      const debe = new Decimal(cuatro.Debe);
      const haber = new Decimal(cuatro.Haber);
      findings.push({
        regla: 'LEC-BAL-RECALCULO',
        severidad: 'bloquea',
        fila,
        numCta: codigo,
        mensaje:
          `La cuenta "${codigo}" (fila ${fila}) no cuadra bajo NINGUNA naturaleza: como deudora ` +
          `${cuatro.SaldoIni} + ${cuatro.Debe} − ${cuatro.Haber} da ${ini.plus(debe).minus(haber).toString()}, ` +
          `como acreedora da ${ini.minus(debe).plus(haber).toString()}, y el archivo declara SaldoFin ` +
          `${cuatro.SaldoFin}. Es un descuadre DEL ORIGEN: la autoridad rehace esta misma resta, así ` +
          `que el archivo tampoco le habría pasado a ella. Corrígelo allá antes de migrar; cargado ` +
          `aquí, el asiento de apertura no cuadraría y la diferencia sería imposible de rastrear.`,
      });
      continue;
    }

    rows.push({
      fila,
      numCta: codigo,
      saldoIni: cuatro.SaldoIni,
      debe: cuatro.Debe,
      haber: cuatro.Haber,
      saldoFin: cuatro.SaldoFin,
    });
  }

  return {
    header: {
      version: version.valor,
      rfc: rfc.valor.toUpperCase(),
      mes: mes.valor,
      anio: anio.valor,
      tipoEnvio: tipoEnvio.valor,
      fechaModBal: fechaModBal.presente && fechaModBal.valor !== '' ? fechaModBal.valor : null,
    },
    rows,
    rowsLeidas: lista.length,
    findings,
    puedeImportarse: findings.every((f) => f.severidad !== 'bloquea'),
  };
}

/**
 * Un importe de una columna, o `null` si no se puede leer como dinero.
 *
 * La cifra se devuelve TAL CUAL viene, sin reformatear: «1120.10» y «1120.1»
 * valen lo mismo y el llamador los va a comparar con `Decimal`, no como texto.
 * Reformatear aquí escondería de qué archivo salió cada cifra.
 */
function leerImporte(
  crudo: string,
  campo: Columna,
  fila: number,
  numCta: string | undefined,
  findings: BalanceReadFinding[]
): string | null {
  const donde = `la fila ${fila}${numCta === undefined ? '' : ` (NumCta "${numCta}")`}`;
  if (crudo === '') {
    findings.push({
      regla: 'LEC-BAL-IMPORTE-AUSENTE',
      severidad: 'bloquea',
      fila,
      campo,
      ...(numCta === undefined ? {} : { numCta }),
      mensaje:
        `${campo} falta en ${donde}. Las cuatro columnas son obligatorias en el nodo Ctas: un hueco ` +
        `no es un cero —un cero declara que la cuenta no se movió— y suponerlo cambia el saldo que se ` +
        `va a cargar.`,
    });
    return null;
  }
  if (!IMPORTE.test(crudo)) {
    findings.push({
      regla: 'LEC-BAL-IMPORTE-NO-NUMERICO',
      severidad: 'bloquea',
      fila,
      campo,
      ...(numCta === undefined ? {} : { numCta }),
      mensaje:
        `${campo}="${crudo}" en ${donde} no es un importe decimal. Un separador de miles, un signo de ` +
        `moneda o un paréntesis de negativo pasan por un exportador y se convierten en NaN o en una ` +
        `cifra truncada; aquí se rehúsan con nombre en vez de posarse en el mayor.`,
    });
    return null;
  }
  const decimales = crudo.includes('.') ? crudo.length - crudo.indexOf('.') - 1 : 0;
  if (decimales > ESCALA_DEL_MAYOR) {
    findings.push({
      regla: 'LEC-BAL-ESCALA',
      severidad: 'bloquea',
      fila,
      campo,
      ...(numCta === undefined ? {} : { numCta }),
      mensaje:
        `${campo}="${crudo}" en ${donde} trae ${decimales} decimales y el mayor guarda ${ESCALA_DEL_MAYOR} ` +
        `(DECIMAL(19,4)). No se redondea en silencio: redondear cada una de ochocientas cuentas es ` +
        `exactamente cómo se pierde el peso que esta carga promete cuadrar. Vuelve a exportar la ` +
        `balanza con la escala del Anexo 24, que son dos decimales.`,
    });
    return null;
  }
  return crudo;
}

/**
 * ¿Cuadra la fila como deudora o como acreedora?
 *
 * Las dos restas son la MISMA vista desde su eje, y por eso una fila correcta
 * cuadra en una de las dos siempre. Cuando Debe y Haber son ambos cero las dos
 * coinciden, que es el caso de la cuenta que no se movió: cuadra por las dos y
 * no dice nada de su naturaleza, que es justo lo que hay que no afirmar.
 */
export function cuadraEnAlgunaNaturaleza(i: ImportesDeLaFila): boolean {
  const ini = new Decimal(i.SaldoIni);
  const debe = new Decimal(i.Debe);
  const haber = new Decimal(i.Haber);
  const fin = new Decimal(i.SaldoFin);
  return ini.plus(debe).minus(haber).equals(fin) || ini.minus(debe).plus(haber).equals(fin);
}
