import { ValidationError } from '../../../utils/errors.js';
import { serializar, type Atributo, type NodoXml } from './xml.js';

// ============================================================
// F07d · EL XML DE LAS PÓLIZAS DEL PERIODO — Polizas 1.3
//
// `e-accounting voucher generate` · `contabilidad-electronica poliza generar`.
//
// ── EL CONSTRUCTOR ES EL DE F07b, Y ESO ES EL PUNTO ─────────────────────
//
// Aquí NO se serializa nada. Todo sale por `serializar` (xml.ts), que es la
// única puerta del constructor del Anexo 24: el escapado es estructural, cada
// valor de atributo pasa por `exigirValorDeAtributo` —que rechaza el salto de
// línea, el carácter de control y el number— y los atributos viajan como
// LISTA ORDENADA de pares, que es lo que sostiene «bytes idénticos para
// entradas idénticas».
//
// Escribir un segundo constructor de XML era la tentación obvia: las pólizas
// son un esquema distinto, con nodos anidados a tres niveles y nodos de pago
// que la balanza no tiene. Y sería exactamente la copia que este proyecto
// persigue. La evidencia de por qué está en la cabecera de xml.ts: en el
// generador de nómina, que sí usa plantilla, `escapeXml` cubre seis
// interpolaciones y no cubre otras seis. Un segundo constructor no hereda las
// tres comprobaciones medidas de aquél, y el día que un concepto de póliza
// traiga un `&` —«Aceros & Cía», que es un nombre de proveedor, no un caso de
// laboratorio— el archivo saldría roto por el camino nuevo mientras el viejo
// sigue verde.
//
// Lo que sí vive aquí es LA FORMA del archivo: qué nodos hay, en qué orden,
// qué atributos lleva cada uno y qué combinaciones se niegan antes de
// construir nada.
//
// ── LO QUE NO PUDE VERIFICAR, DICHO EN VEZ DE AFIRMADO ──────────────────
//
// No hay un solo `.xsd` en este repositorio y esta máquina no tiene red, así
// que rige la misma regla que F07b se puso: lo que no se puede fundamentar NO
// SE INVENTA, y lo que se emite se dice de dónde sale.
//
//   · Los nombres de nodo y de atributo de abajo son los de la estructura que
//     el Anexo 24 publica para PolizasPeriodo 1.3 y los que implementa
//     cualquier herramienta que hoy presente el archivo. NO están cotejados
//     contra el XSD oficial.
//   · En particular, el encargo de este tramo nombra el destino de una
//     transferencia como «CtaDes» y «BancoDesNal», y aquí se emite `CtaDest`
//     y `BancoDestNal`. Es una discrepancia real y se deja escrita: si el XSD
//     dice lo otro, son dos literales de este archivo y una prueba. Emitir un
//     atributo con el nombre equivocado invalida el archivo entero, así que
//     esto es lo primero que hay que cotejar el día que se traiga el esquema.
//   · `Sello`, `noCertificado` y `Certificado` EXISTEN en el esquema y este
//     módulo NO los emite ni tiene por dónde: no hay una sola rama que cargue
//     una llave privada, y no debe haberla. La e.firma es el contribuyente
//     firmando, no el software.
// ============================================================

export const NS_POLIZAS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo';
export const PREFIJO_POLIZAS = 'PLZ';
export const UBICACION_XSD_POLIZAS = `${NS_POLIZAS}/PolizasPeriodo_1_3.xsd`;
export const VERSION_POLIZAS = '1.3';

/** Sin `export`: `validador.ts` ya publica esta constante. Ver balanza-xml.ts. */
const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';

/**
 * POR QUÉ LAS PÓLIZAS LLEVAN `TipoSolicitud` Y LA BALANZA NO.
 *
 * La balanza y el catálogo se presentan; las pólizas NO se presentan nunca de
 * oficio. Se entregan cuando la autoridad las pide, y el archivo tiene que
 * decir POR QUÉ se está entregando:
 *
 *   AF · acto de fiscalización      → lleva número de orden
 *   FC · fiscalización compulsa     → lleva número de orden
 *   DE · devolución                 → lleva número de trámite
 *   CO · compensación               → lleva número de trámite
 *
 * No hay valor por omisión y no puede haberlo: enviar unas pólizas diciendo
 * que responden a una devolución cuando responden a una auditoría es una
 * afirmación falsa ante la autoridad, y de las que se comprueban solas.
 */
export type TipoSolicitud = 'AF' | 'FC' | 'DE' | 'CO';

export const TIPOS_DE_SOLICITUD: readonly TipoSolicitud[] = ['AF', 'FC', 'DE', 'CO'];

/** Los dos que van con número de ORDEN; los otros dos, con número de TRÁMITE. */
const CON_NUM_ORDEN: readonly TipoSolicitud[] = ['AF', 'FC'];

export interface Solicitud {
  tipo: TipoSolicitud;
  /** Obligatorio, y sólo válido, con AF o FC. */
  numOrden?: string;
  /** Obligatorio, y sólo válido, con DE o CO. */
  numTramite?: string;
}

// ── LOS NODOS DE EVIDENCIA ──────────────────────────────────────────────
//
// Qué documento respalda el movimiento. Los tres son el MISMO dato con tres
// procedencias, y por eso comparten tipo: un CFDI nacional identificado por
// UUID, un comprobante nacional anterior al CFDI identificado por serie y
// folio, y una factura extranjera identificada por su número.

export interface ComprobanteNacional {
  clase: 'nacional';
  /** UUID del CFDI. */
  uuid: string;
  /** RFC de la contraparte: quien lo expidió o a quien se le expidió. */
  rfc: string;
  /** Total del comprobante, YA formateado con `importeAnexo24`. */
  montoTotal: string;
  moneda?: string;
  tipCamb?: string;
}

export interface ComprobanteNacionalOtro {
  clase: 'nacional_otro';
  serie?: string;
  numFolio: string;
  montoTotal: string;
  moneda?: string;
  tipCamb?: string;
}

export interface ComprobanteExtranjero {
  clase: 'extranjero';
  numFactExt: string;
  /** Identificador fiscal del extranjero. Opcional: no todos lo tienen. */
  taxId?: string;
  montoTotal: string;
  moneda?: string;
  tipCamb?: string;
}

export type Comprobante = ComprobanteNacional | ComprobanteNacionalOtro | ComprobanteExtranjero;

// ── LOS NODOS DE PAGO ───────────────────────────────────────────────────
//
// EL RASTRO. Es lo que distingue una póliza del Anexo 24 de un asiento
// cualquiera: cuando la póliza mueve dinero, tiene que decir de qué cuenta
// salió, de qué banco, a qué cuenta fue, a qué banco, cuándo, a nombre de
// quién y con qué RFC. Es lo que permite a la autoridad seguir una deducción
// hasta el banco, y es exactamente el dato que este sistema no tenía dónde
// guardar hasta la migración 064.

export interface PagoConCheque {
  clase: 'cheque';
  /** El número del cheque. `vendor_payments.check_number`, por fin escrito. */
  num: string;
  /** Clave c_Banco del banco EMISOR nacional. */
  banEmisNal?: string;
  /** Nombre del banco emisor extranjero. Excluyente con el anterior. */
  banEmisExt?: string;
  /** Cuenta de la que salió el dinero. */
  ctaOri: string;
  /** YYYY-MM-DD. */
  fecha: string;
  /** Beneficiario: a nombre de quién se expidió. */
  benef: string;
  /** RFC del beneficiario. */
  rfc: string;
  monto: string;
  moneda?: string;
  tipCamb?: string;
}

export interface PagoPorTransferencia {
  clase: 'transferencia';
  ctaOri?: string;
  /** Clave c_Banco del banco de ORIGEN. Sale de bank_accounts.sat_bank_code. */
  bancoOriNal?: string;
  bancoOriExt?: string;
  /** La cuenta que RECIBIÓ el dinero. Es el dato obligatorio del nodo. */
  ctaDest: string;
  bancoDestNal?: string;
  bancoDestExt?: string;
  fecha: string;
  benef: string;
  rfc: string;
  monto: string;
  moneda?: string;
  tipCamb?: string;
}

export interface PagoPorOtroMetodo {
  clase: 'otro';
  /** Método con el que se pagó, en las grafías del catálogo del SAT. */
  metPagoPol: string;
  fecha: string;
  benef?: string;
  rfc?: string;
  monto: string;
  moneda?: string;
  tipCamb?: string;
}

export type NodoDePago = PagoConCheque | PagoPorTransferencia | PagoPorOtroMetodo;

// ── LA TRANSACCIÓN Y LA PÓLIZA ──────────────────────────────────────────

export interface Transaccion {
  /** El mismo NumCta que declara el catálogo de cuentas. */
  numCta: string;
  desCta: string;
  concepto: string;
  /** Ya formateados con `importeAnexo24`: dos decimales, cadena. */
  debe: string;
  haber: string;
  comprobantes?: readonly Comprobante[];
  pagos?: readonly NodoDePago[];
}

export interface Poliza {
  /** Identificador único de la póliza: `journal_entries.entry_number`. */
  numUnIdenPol: string;
  /** YYYY-MM-DD. */
  fecha: string;
  concepto: string;
  transacciones: readonly Transaccion[];
}

export interface DatosDePolizas {
  rfc: string;
  anio: number;
  /** '01'..'13'. */
  mes: string;
  solicitud: Solicitud;
  /** Ya ordenadas: el orden de las pólizas es parte de los bytes. */
  polizas: readonly Poliza[];
}

// ── LAS COMPROBACIONES DE FORMA ─────────────────────────────────────────

/** El RFC de una persona moral son 12 caracteres y el de una física 13. */
const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Dos decimales exactos, con signo o sin él. Lo que `importeAnexo24` produce. */
const IMPORTE_RE = /^-?\d+\.\d{2}$/;

/**
 * La cabecera de solicitud, que es COMPARTIDA con los dos auxiliares.
 *
 * Los tres esquemas que se piden a requerimiento —pólizas, auxiliar de folios
 * y auxiliar de cuentas— llevan la MISMA cabecera de solicitud, con las mismas
 * dos exclusiones. Se comprueba una vez y se usa tres, que es lo que «si
 * comparte estructura, compártela de verdad» quiere decir: no tres copias de
 * la misma regla que mañana divergen.
 */
export function atributosDeSolicitud(s: Solicitud): Atributo[] {
  if (!TIPOS_DE_SOLICITUD.includes(s.tipo)) {
    throw new ValidationError(
      `TipoSolicitud «${String(s.tipo)}» no existe. El Anexo 24 admite AF (acto de fiscalización), ` +
        `FC (fiscalización compulsa), DE (devolución) y CO (compensación). No hay valor por omisión: ` +
        `las pólizas no se presentan de oficio, se entregan a requerimiento, y el archivo dice a cuál responde.`
    );
  }
  const conOrden = CON_NUM_ORDEN.includes(s.tipo);
  const orden = (s.numOrden ?? '').trim();
  const tramite = (s.numTramite ?? '').trim();

  if (conOrden && orden === '') {
    throw new ValidationError(
      `TipoSolicitud «${s.tipo}» exige NumOrden: es el número de la orden de la revisión que pidió ` +
        `estas pólizas. Sin él la autoridad no puede atar el archivo al acto que lo motivó.`
    );
  }
  if (conOrden && tramite !== '') {
    throw new ValidationError(
      `TipoSolicitud «${s.tipo}» lleva NumOrden, no NumTramite. Declarar los dos dice que el archivo ` +
        `responde a la vez a una revisión y a un trámite de devolución o compensación.`
    );
  }
  if (!conOrden && tramite === '') {
    throw new ValidationError(
      `TipoSolicitud «${s.tipo}» exige NumTramite: es el número del trámite de devolución o ` +
        `compensación al que estas pólizas dan soporte.`
    );
  }
  if (!conOrden && orden !== '') {
    throw new ValidationError(
      `TipoSolicitud «${s.tipo}» lleva NumTramite, no NumOrden.`
    );
  }

  return [
    ['TipoSolicitud', s.tipo],
    ['NumOrden', conOrden ? orden : undefined],
    ['NumTramite', conOrden ? undefined : tramite],
  ];
}

/**
 * RFC, Mes y Anio: la otra mitad compartida por los tres esquemas.
 *
 * `mes13` existe porque el mes 13 —los ajustes de cierre— es una póliza como
 * cualquier otra y el auxiliar de cuentas también lo cubre, mientras que el
 * catálogo de cuentas de F07b lo rechaza explícitamente. Que la regla dependa
 * del esquema y no del calendario es justo lo que hay que escribir una vez.
 */
export function atributosDeCabecera(
  rfc: string,
  anio: number,
  mes: string,
  opciones: { mes13: boolean }
): Atributo[] {
  if (!RFC_RE.test(rfc)) {
    throw new ValidationError(
      `«${rfc}» no tiene forma de RFC. Los archivos del Anexo 24 los entrega un contribuyente ` +
        `mexicano ante el SAT; una entidad identificada con EIN u otro número no puede entregarlos.`
    );
  }
  const tope = opciones.mes13 ? /^(0[1-9]|1[0-3])$/ : /^(0[1-9]|1[0-2])$/;
  if (!tope.test(mes)) {
    throw new ValidationError(
      `Mes «${mes}» no es válido: se admite '01'..'12'` +
        (opciones.mes13 ? ` y '13' para los ajustes de cierre.` : '.')
    );
  }
  if (!Number.isInteger(anio) || anio < 2015 || anio > 2099) {
    throw new ValidationError(
      `Anio ${String(anio)} está fuera de rango: la contabilidad electrónica arranca en 2015.`
    );
  }
  return [
    ['RFC', rfc],
    ['Mes', mes],
    ['Anio', String(anio)],
  ];
}

/** Un importe que ya pasó por `importeAnexo24`, o el porqué de que no valga. */
function exigirImporte(donde: string, atributo: string, valor: string): string {
  if (!IMPORTE_RE.test(valor)) {
    throw new ValidationError(
      `${donde}/@${atributo} = «${valor}»: el Anexo 24 declara importes con DOS decimales exactos. ` +
        `Fórmatelo con importeAnexo24() antes de construir el nodo — el residuo del redondeo viaja ` +
        `con él y quien construye tiene que poder verlo.`
    );
  }
  return valor;
}

function exigirFecha(donde: string, atributo: string, valor: string): string {
  if (!FECHA_RE.test(valor)) {
    throw new ValidationError(`${donde}/@${atributo} = «${valor}» no tiene forma YYYY-MM-DD.`);
  }
  return valor;
}

// ── LOS ÁRBOLES ─────────────────────────────────────────────────────────

/**
 * Un nodo de comprobante, con el PREFIJO y el NOMBRE de elemento como
 * parámetros.
 *
 * Aquí está la mitad compartida de verdad con el auxiliar de folios: el dato
 * es el mismo —un CFDI con su UUID, su RFC y su monto— y lo único que cambia
 * entre los dos esquemas es cómo se llama el elemento (`CompNal` en pólizas,
 * `ComprNal` en el auxiliar de folios) y su prefijo. Duplicar la construcción
 * para cambiar dos cadenas es como se consigue que dentro de un año uno de los
 * dos emita `Moneda` y el otro no.
 */
export function nodoDeComprobante(
  prefijo: string,
  nombres: { nacional: string; nacionalOtro: string; extranjero: string },
  c: Comprobante
): NodoXml {
  switch (c.clase) {
    case 'nacional': {
      const nombre = `${prefijo}:${nombres.nacional}`;
      if (!RFC_RE.test(c.rfc)) {
        throw new ValidationError(
          `${nombre}/@RFC = «${c.rfc}»: el comprobante nacional identifica a la contraparte por su ` +
            `RFC, y el que se emita es el que la autoridad cruza contra las declaraciones del tercero.`
        );
      }
      return {
        nombre,
        atributos: [
          ['UUID_CFDI', c.uuid],
          ['RFC', c.rfc],
          ['MontoTotal', exigirImporte(nombre, 'MontoTotal', c.montoTotal)],
          ['Moneda', c.moneda],
          ['TipCamb', c.tipCamb],
        ],
      };
    }
    case 'nacional_otro': {
      const nombre = `${prefijo}:${nombres.nacionalOtro}`;
      return {
        nombre,
        atributos: [
          ['CFD_CBB_Serie', c.serie],
          ['CFD_CBB_NumFol', c.numFolio],
          ['MontoTotal', exigirImporte(nombre, 'MontoTotal', c.montoTotal)],
          ['Moneda', c.moneda],
          ['TipCamb', c.tipCamb],
        ],
      };
    }
    case 'extranjero': {
      const nombre = `${prefijo}:${nombres.extranjero}`;
      return {
        nombre,
        atributos: [
          ['NumFactExt', c.numFactExt],
          ['TaxID', c.taxId],
          ['MontoTotal', exigirImporte(nombre, 'MontoTotal', c.montoTotal)],
          ['Moneda', c.moneda],
          ['TipCamb', c.tipCamb],
        ],
      };
    }
  }
}

/** Los nombres de elemento del comprobante EN EL ESQUEMA DE PÓLIZAS. */
export const COMPROBANTES_DE_POLIZA = {
  nacional: 'CompNal',
  nacionalOtro: 'CompNalOtr',
  extranjero: 'CompExt',
} as const;

function nodoDePago(p: NodoDePago): NodoXml {
  switch (p.clase) {
    case 'cheque': {
      const nombre = `${PREFIJO_POLIZAS}:Cheque`;
      exigirBancoUnico(nombre, p.banEmisNal, p.banEmisExt, 'emisor');
      return {
        nombre,
        atributos: [
          ['Num', p.num],
          ['BanEmisNal', p.banEmisNal],
          ['BanEmisExt', p.banEmisExt],
          ['CtaOri', p.ctaOri],
          ['Fecha', exigirFecha(nombre, 'Fecha', p.fecha)],
          ['Benef', p.benef],
          ['RFC', p.rfc],
          ['Monto', exigirImporte(nombre, 'Monto', p.monto)],
          ['Moneda', p.moneda],
          ['TipCamb', p.tipCamb],
        ],
      };
    }
    case 'transferencia': {
      const nombre = `${PREFIJO_POLIZAS}:Transferencia`;
      exigirBancoUnico(nombre, p.bancoOriNal, p.bancoOriExt, 'de origen');
      exigirBancoUnico(nombre, p.bancoDestNal, p.bancoDestExt, 'de destino');
      if (p.ctaDest.trim() === '') {
        throw new ValidationError(
          `${nombre}/@CtaDest está vacío. La cuenta que RECIBIÓ el dinero es lo obligatorio de este ` +
            `nodo: sin ella el rastro se corta justo donde la autoridad lo sigue.`
        );
      }
      return {
        nombre,
        atributos: [
          ['CtaOri', p.ctaOri],
          ['BancoOriNal', p.bancoOriNal],
          ['BancoOriExt', p.bancoOriExt],
          ['CtaDest', p.ctaDest],
          ['BancoDestNal', p.bancoDestNal],
          ['BancoDestExt', p.bancoDestExt],
          ['Fecha', exigirFecha(nombre, 'Fecha', p.fecha)],
          ['Benef', p.benef],
          ['RFC', p.rfc],
          ['Monto', exigirImporte(nombre, 'Monto', p.monto)],
          ['Moneda', p.moneda],
          ['TipCamb', p.tipCamb],
        ],
      };
    }
    case 'otro': {
      const nombre = `${PREFIJO_POLIZAS}:OtrMetodoPago`;
      return {
        nombre,
        atributos: [
          ['MetPagoPol', p.metPagoPol],
          ['Fecha', exigirFecha(nombre, 'Fecha', p.fecha)],
          ['Benef', p.benef],
          ['RFC', p.rfc],
          ['Monto', exigirImporte(nombre, 'Monto', p.monto)],
          ['Moneda', p.moneda],
          ['TipCamb', p.tipCamb],
        ],
      };
    }
  }
}

/** Nacional o extranjero, no los dos: el mismo criterio que el CHECK de la 064. */
function exigirBancoUnico(
  nodo: string,
  nacional: string | undefined,
  extranjero: string | undefined,
  papel: string
): void {
  if ((nacional ?? '') !== '' && (extranjero ?? '') !== '') {
    throw new ValidationError(
      `${nodo}: el banco ${papel} se declara con la CLAVE del c_Banco si es nacional o con el NOMBRE ` +
        `si es extranjero, y aquí vienen los dos («${nacional ?? ''}» y «${extranjero ?? ''}»). ` +
        `Son dos afirmaciones incompatibles sobre el mismo movimiento.`
    );
  }
}

function nodoDeTransaccion(t: Transaccion): NodoXml {
  const nombre = `${PREFIJO_POLIZAS}:Transaccion`;
  // Los hijos van en el orden del esquema y CONTIGUOS por tipo. `serializar`
  // lo comprueba y se niega si no lo están —agrupar por nombre alteraría la
  // secuencia en silencio—, pero el orden correcto se decide aquí: es una
  // propiedad del esquema de pólizas, no del serializador.
  const comprobantes = t.comprobantes ?? [];
  const hijos: NodoXml[] = [
    ...comprobantes
      .filter((c) => c.clase === 'nacional')
      .map((c) => nodoDeComprobante(PREFIJO_POLIZAS, COMPROBANTES_DE_POLIZA, c)),
    ...comprobantes
      .filter((c) => c.clase === 'nacional_otro')
      .map((c) => nodoDeComprobante(PREFIJO_POLIZAS, COMPROBANTES_DE_POLIZA, c)),
    ...comprobantes
      .filter((c) => c.clase === 'extranjero')
      .map((c) => nodoDeComprobante(PREFIJO_POLIZAS, COMPROBANTES_DE_POLIZA, c)),
    ...(t.pagos ?? []).filter((p) => p.clase === 'cheque').map(nodoDePago),
    ...(t.pagos ?? []).filter((p) => p.clase === 'transferencia').map(nodoDePago),
    ...(t.pagos ?? []).filter((p) => p.clase === 'otro').map(nodoDePago),
  ];

  return {
    nombre,
    atributos: [
      ['NumCta', t.numCta],
      ['DesCta', t.desCta],
      ['Concepto', t.concepto],
      ['Debe', exigirImporte(nombre, 'Debe', t.debe)],
      ['Haber', exigirImporte(nombre, 'Haber', t.haber)],
    ],
    ...(hijos.length > 0 ? { hijos } : {}),
  };
}

function validar(d: DatosDePolizas): void {
  if (d.polizas.length === 0) {
    // Igual que la balanza vacía de F07b: un archivo con cero pólizas no es un
    // error de formato, es una afirmación —«en ese periodo no hubo
    // contabilidad»— que se acepta y que nadie quiso hacer.
    throw new ValidationError(
      `El periodo ${d.mes}/${d.anio} no tiene ninguna póliza que entregar. Un archivo con cero nodos ` +
        `Poliza afirma ante la autoridad que en ese periodo no se registró un solo asiento.`
    );
  }
  const repetidas = [
    ...new Set(
      d.polizas
        .map((p) => p.numUnIdenPol)
        .filter((n, i, todas) => todas.indexOf(n) !== i)
    ),
  ];
  if (repetidas.length > 0) {
    throw new ValidationError(
      `NumUnIdenPol repetido: ${repetidas.join(', ')}. Es el identificador ÚNICO de la póliza y es ` +
        `por donde el auxiliar de folios apunta a ella: duplicarlo hace ambigua toda referencia.`
    );
  }
  for (const p of d.polizas) {
    if (p.transacciones.length === 0) {
      throw new ValidationError(
        `La póliza ${p.numUnIdenPol} no tiene ninguna transacción. Una póliza sin renglones no ` +
          `registra nada y el esquema exige al menos uno.`
      );
    }
  }
}

/** El árbol, separado de la serialización para poder inspeccionarlo. */
export function nodoDePolizas(d: DatosDePolizas): NodoXml {
  validar(d);
  return {
    nombre: `${PREFIJO_POLIZAS}:Polizas`,
    atributos: [
      ['xmlns:xsi', NS_XSI],
      [`xmlns:${PREFIJO_POLIZAS}`, NS_POLIZAS],
      ['xsi:schemaLocation', `${NS_POLIZAS} ${UBICACION_XSD_POLIZAS}`],
      ['Version', VERSION_POLIZAS],
      ...atributosDeCabecera(d.rfc, d.anio, d.mes, { mes13: true }),
      ...atributosDeSolicitud(d.solicitud),
    ],
    hijos: d.polizas.map((p) => ({
      nombre: `${PREFIJO_POLIZAS}:Poliza`,
      atributos: [
        ['NumUnIdenPol', p.numUnIdenPol],
        ['Fecha', exigirFecha(`${PREFIJO_POLIZAS}:Poliza`, 'Fecha', p.fecha)],
        ['Concepto', p.concepto],
      ] as Atributo[],
      hijos: p.transacciones.map(nodoDeTransaccion),
    })),
  };
}

/** El XML. Sin fecha de generación ni nada que cambie entre dos corridas. */
export function construirPolizasXml(d: DatosDePolizas): string {
  return serializar(nodoDePolizas(d));
}

/**
 * Nombre con el que se entrega el archivo: RFC + Anio + Mes + «PL».
 *
 * «PL» de pólizas, como «B» es de balanza y «CT» de catálogo. NO VERIFICADO
 * contra la guía oficial, igual que sus dos hermanos de F07b.
 */
export function nombreDelArchivoDePolizas(d: Pick<DatosDePolizas, 'rfc' | 'anio' | 'mes'>): string {
  return `${d.rfc}${d.anio}${d.mes}PL.XML`;
}
