import { ValidationError } from '../../../utils/errors.js';
import { serializar, type Atributo, type NodoXml } from './xml.js';
import {
  officialEnumeration,
  OFFICIAL_ENUMERATIONS_XSD,
  type OfficialEnumeration,
} from './official-enumerations.js';

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
// ── CHECKED AGAINST THE OFFICIAL XSD (#397) ─────────────────────────────
//
//   · A file with every evidence node and every payment node this module can
//     emit validates against PolizasPeriodo_1_3.xsd, vendored in `xsd/`
//     (tests/sat/anexo24/official-xsd.spec.ts). That settles the node and
//     attribute names, including the transfer's destination: the schema says
//     `CtaDest` and `BancoDestNal`, not the «CtaDes» and «BancoDesNal» this
//     tranche's brief used.
//   · The XSD found two defects on its first run, both fixed in #397: request
//     numbers were not checked against its patterns, and the pre-CFDI voucher
//     had no RFC.
//   · The closed lists (c_Banco, c_Moneda, c_MetPagos) and the pattern of
//     `CFD_CBB_Serie` are checked against the vendored
//     CatalogosParaEsqContE.xsd (official-enumerations.ts), never copied here
//     (#404). `offListValuesOf*` finds them; the invariants report each one as
//     a blocking finding that names its entry, and the XML is still built so
//     it can be looked at. The builder refuses them only as a last resort,
//     when no one ran those checks, and then it names every entry at once.
//   · The payee is required on all three payment nodes: `Benef` (minLength
//     1) and `RFC` (the RFC pattern) are use="required" on Cheque,
//     Transferencia and OtrMetodoPago alike. OtrMetodoPago used to leave
//     without them when the vendor had no usable name or RFC, and the file
//     failed the XSD (#530). The service now leaves such a node out and names
//     its entry, and `requirePayee` refuses a caller that does not.
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
  /** Counterparty's RFC. Required by both schemas that declare this node (#397). */
  rfc: string;
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
  /**
   * Required, as on Cheque and Transferencia: PolizasPeriodo_1_3.xsd declares
   * `Benef` and `RFC` use="required" on all three payment nodes (#530). A
   * payment without them gets no node; its entry is named instead.
   */
  benef: string;
  rfc: string;
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
 * The two request numbers, as the XSD pins them. PolizasPeriodo, AuxiliarFolios
 * and AuxiliarCtas 1.3 declare the same patterns: an audit order is three
 * letters, seven digits, a slash and two digits; a refund or offset filing is
 * two letters and twelve digits. Any other value makes the whole file invalid.
 */
const AUDIT_ORDER_RE = /^[A-Z]{3}[0-9]{7}\/[0-9]{2}$/;
const FILING_NUMBER_RE = /^[A-Z]{2}[0-9]{12}$/;

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
  if (conOrden && !AUDIT_ORDER_RE.test(orden)) {
    throw new ValidationError(
      `NumOrden «${orden}» no tiene el formato del SAT: tres letras, siete dígitos, una diagonal ` +
        `y dos dígitos (ABC1234567/26). Con otro valor el esquema rechaza el archivo entero.`
    );
  }
  if (!conOrden && !FILING_NUMBER_RE.test(tramite)) {
    throw new ValidationError(
      `NumTramite «${tramite}» no tiene el formato del SAT: dos letras y doce dígitos ` +
        `(DE202600000009). Con otro valor el esquema rechaza el archivo entero.`
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

/**
 * THE PAYEE OF A PAYMENT NODE. `Benef` (minLength 1) and `RFC` (the RFC
 * pattern) are use="required" on Cheque, Transferencia and OtrMetodoPago
 * alike, and a node without them makes the SAT reject the whole file (#530).
 * The service leaves such a node out and names its entry before it gets here;
 * this refusal keeps any other caller from building that file.
 */
function requirePayee(node: string, payment: { benef: string; rfc: string }): void {
  if (payment.benef.trim() === '') {
    throw new ValidationError(
      `${node}/@Benef está vacío. El esquema lo exige en los tres nodos de pago, con al menos un ` +
        `carácter: sin él el SAT rechaza el archivo entero.`
    );
  }
  if (!RFC_RE.test(payment.rfc)) {
    throw new ValidationError(
      `${node}/@RFC = «${payment.rfc}»: el esquema lo exige en los tres nodos de pago con forma de ` +
        `RFC, y el que se emita es el que la autoridad cruza contra las declaraciones del tercero.`
    );
  }
}

/** `CFD_CBB_Serie` in PolizasPeriodo and AuxiliarFolios 1.3: pattern [A-Z]+, length 1 to 10. */
const CFD_CBB_SERIES_RE = /^[A-Z]{1,10}$/;

/**
 * A value the official XSD will refuse: off one of its closed lists, or off
 * the pattern of `CFD_CBB_Serie`. `rule` names the list or the pattern.
 */
export interface OffListValue {
  /** The element, with its prefix: `PLZ:Transferencia`. */
  node: string;
  attribute: string;
  value: string;
  rule: OfficialEnumeration | typeof CFD_CBB_SERIES_RULE;
}

const CFD_CBB_SERIES_RULE = 'CFD_CBB_Serie [A-Z]{1,10}';

function offList(
  node: string,
  attribute: string,
  type: OfficialEnumeration,
  value: string | undefined
): OffListValue[] {
  return value !== undefined && !officialEnumeration(type).has(value)
    ? [{ node, attribute, value, rule: type }]
    : [];
}

/**
 * The values of one voucher node the XSD refuses. The invariants turn them
 * into findings that name the journal entry (`code-in-official-list`); the
 * builders assert them only as a last resort (`assertOnOfficialLists`).
 */
export function offListValuesOfVoucher(
  prefix: string,
  names: Parameters<typeof nodoDeComprobante>[1],
  c: Comprobante
): OffListValue[] {
  switch (c.clase) {
    case 'nacional':
      return offList(`${prefix}:${names.nacional}`, 'Moneda', 'c_Moneda', c.moneda);
    case 'nacional_otro': {
      const node = `${prefix}:${names.nacionalOtro}`;
      const series: OffListValue[] =
        c.serie !== undefined && !CFD_CBB_SERIES_RE.test(c.serie)
          ? [{ node, attribute: 'CFD_CBB_Serie', value: c.serie, rule: CFD_CBB_SERIES_RULE }]
          : [];
      return [...series, ...offList(node, 'Moneda', 'c_Moneda', c.moneda)];
    }
    case 'extranjero':
      return offList(`${prefix}:${names.extranjero}`, 'Moneda', 'c_Moneda', c.moneda);
  }
}

/** The values of one payment node the XSD refuses, bank codes included. */
export function offListValuesOfPayment(p: NodoDePago): OffListValue[] {
  switch (p.clase) {
    case 'cheque': {
      const node = `${PREFIJO_POLIZAS}:Cheque`;
      return [
        ...offList(node, 'BanEmisNal', 'c_Banco', p.banEmisNal),
        ...offList(node, 'Moneda', 'c_Moneda', p.moneda),
      ];
    }
    case 'transferencia': {
      const node = `${PREFIJO_POLIZAS}:Transferencia`;
      return [
        ...offList(node, 'BancoOriNal', 'c_Banco', p.bancoOriNal),
        ...offList(node, 'BancoDestNal', 'c_Banco', p.bancoDestNal),
        ...offList(node, 'Moneda', 'c_Moneda', p.moneda),
      ];
    }
    case 'otro': {
      const node = `${PREFIJO_POLIZAS}:OtrMetodoPago`;
      return [
        ...offList(node, 'MetPagoPol', 'c_MetPagos', p.metPagoPol),
        ...offList(node, 'Moneda', 'c_Moneda', p.moneda),
      ];
    }
  }
}

/** How a finding or an error names one off-list value. */
export function describeOffListValue(v: OffListValue): string {
  const source =
    v.rule === CFD_CBB_SERIES_RULE
      ? `el patrón ${v.rule} del esquema (de 1 a 10 letras mayúsculas sin acento)`
      : `la enumeración ${v.rule} de ${OFFICIAL_ENUMERATIONS_XSD}`;
  return `${v.node}/@${v.attribute} = «${v.value}» no está en ${source}`;
}

/**
 * LAST-RESORT ASSERTION. The invariants report every off-list value as a
 * blocking finding that names its journal entry, and the journal service then
 * builds with `allowOffList` so the accountant can still look at the file.
 * Reaching this throw means a caller skipped those checks and was about to
 * hand over a file the SAT rejects; even then it names every entry at once.
 */
export function assertOnOfficialLists(
  offending: ReadonlyArray<{ numUnIdenPol: string; value: OffListValue }>
): void {
  if (offending.length === 0) return;
  throw new ValidationError(
    `Valores que el esquema del SAT rechaza, y con ellos el archivo entero: ` +
      offending.map((o) => `póliza ${o.numUnIdenPol}: ${describeOffListValue(o.value)}`).join('; ') +
      '.'
  );
}

/** Every off-list value of the journal, with the entry that carries it. */
export function offListValuesOfJournal(
  entries: readonly Poliza[]
): Array<{ numUnIdenPol: string; value: OffListValue }> {
  return entries.flatMap((p) =>
    p.transacciones.flatMap((t) =>
      [
        ...(t.comprobantes ?? []).flatMap((c) =>
          offListValuesOfVoucher(PREFIJO_POLIZAS, COMPROBANTES_DE_POLIZA, c)
        ),
        ...(t.pagos ?? []).flatMap(offListValuesOfPayment),
      ].map((value) => ({ numUnIdenPol: p.numUnIdenPol, value }))
    )
  );
}

/** Options of the journal builder. */
export interface JournalBuildOptions {
  /**
   * true = emit off-list values as they are. Only for a caller that already
   * reported them as blocking findings, so the file is shown and not delivered.
   */
  allowOffList?: boolean;
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
      // PolizasPeriodo and AuxiliarFolios 1.3 both declare RFC required on
      // this node; the generator had no field for it, so every file with a
      // pre-CFDI voucher was invalid. The official XSD found it (#397).
      if (!RFC_RE.test(c.rfc)) {
        throw new ValidationError(
          `${nombre}/@RFC = «${c.rfc}»: el comprobante nacional anterior al CFDI también identifica ` +
            `a la contraparte por su RFC, y el esquema del SAT lo exige.`
        );
      }
      return {
        nombre,
        atributos: [
          ['CFD_CBB_Serie', c.serie],
          ['CFD_CBB_NumFol', c.numFolio],
          ['RFC', c.rfc],
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
      requirePayee(nombre, p);
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
      requirePayee(nombre, p);
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
      requirePayee(nombre, p);
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
export function nodoDePolizas(d: DatosDePolizas, opts: JournalBuildOptions = {}): NodoXml {
  validar(d);
  if (opts.allowOffList !== true) assertOnOfficialLists(offListValuesOfJournal(d.polizas));
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
export function construirPolizasXml(d: DatosDePolizas, opts: JournalBuildOptions = {}): string {
  return serializar(nodoDePolizas(d, opts));
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
