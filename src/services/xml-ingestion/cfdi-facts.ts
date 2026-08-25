import Decimal from 'decimal.js';
import type { CFDIParsed } from './cfdi-parser.js';

// ============================================================
// CFDI FACTS
// Normalizes a parsed CFDI into the facts that determine its
// accounting treatment. Kept separate from the taxonomy so the
// rules stay declarative and auditable.
// ============================================================

/** SAT c_TipoRelacion catalog — determines the intent of an egreso CFDI. */
export const TIPO_RELACION = {
  NOTA_CREDITO: '01',
  NOTA_DEBITO: '02',
  DEVOLUCION: '03',
  SUSTITUCION: '04',
  TRASLADOS_FACTURADOS: '05',
  FACTURA_POR_TRASLADOS: '06',
  APLICACION_ANTICIPO: '07',
} as const;

export interface DoctoRelacionado {
  uuid: string;
  impSaldoAnt: number;
  impPagado: number;
  impSaldoInsoluto: number;
  numParcialidad?: number;
  monedaDR?: string;
  equivalenciaDR?: number;
}

export interface CfdiFacts {
  // Identity
  uuid: string;
  tipo: 'I' | 'E' | 'T' | 'N' | 'P' | 'R' | string;
  /** emitido = the entity is the issuer. recibido = it is the receiver. */
  direction: 'emitido' | 'recibido' | 'ajeno';
  emisorRfc: string;
  receptorRfc: string;
  emisorNombre: string;
  fecha: Date;

  // Payment
  metodoPago?: 'PUE' | 'PPD' | string;
  formaPago?: string;
  /** Payment method 01 = cash: relevant for deductibility. */
  pagadoEnEfectivo: boolean;

  // Currency
  moneda: string;
  tipoCambio: number;
  esMonedaExtranjera: boolean;

  // Amounts
  subtotal: number;
  descuento: number;
  total: number;

  // Taxes (broken down)
  ivaTrasladado16: number;
  ivaTrasladado8: number;
  ivaTasaCero: number;
  /** Amount of EXEMPT items: does not generate creditable VAT. */
  importeExento: number;
  iepsTrasladado: number;
  isrRetenido: number;
  ivaRetenido: number;
  impuestosLocalesTrasladados: number;
  impuestosLocalesRetenidos: number;

  // Complements and relations
  complementos: string[];
  docsRelacionados: DoctoRelacionado[];
  tipoRelacion?: string;
  uuidsRelacionados: string[];

  // Other
  usoCfdi?: string;
  /** Items with key 84111506 (advance payment) or an advance-payment description. */
  esAnticipo: boolean;
  clavesProdServ: string[];
  conceptosDescripcion: string;
}

const CLAVE_ANTICIPO = '84111506';
const FORMA_PAGO_EFECTIVO = '01';

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalizes a SAT key to its fixed width. The parser runs with
 * parseAttributeValue: true, so "002" arrives as the number 2 and "01"
 * as 1: comparing against '002' directly ALWAYS fails. That bug makes
 * the per-item tax breakdown silently return zeros.
 */
function clave(v: unknown, width: number): string {
  if (v === undefined || v === null || v === '') return '';
  return String(v).padStart(width, '0');
}
const impuestoClave = (v: unknown) => clave(v, 3);
const objetoImpClave = (v: unknown) => clave(v, 2);

/**
 * Extracts the facts. `entityRfc` decides the direction: it is the piece
 * missing from today's pipeline, which makes an issued CFDI get recorded
 * as an expense (turning sales into purchases).
 */
export function extractFacts(cfdi: CFDIParsed, entityRfc: string): CfdiFacts {
  const rfc = entityRfc.toUpperCase();
  const emisor = (cfdi.emisor.rfc || '').toUpperCase();
  const receptor = (cfdi.receptor.rfc || '').toUpperCase();

  const direction: CfdiFacts['direction'] =
    emisor === rfc ? 'emitido' : receptor === rfc ? 'recibido' : 'ajeno';

  const tax = breakdownTaxes(cfdi);
  const pagos = extractPagos(cfdi);
  const rel = extractRelacionados(cfdi);

  return {
    uuid: cfdi.timbreFiscalDigital?.uuid ?? '',
    tipo: cfdi.tipoDeComprobante,
    direction,
    emisorRfc: emisor,
    receptorRfc: receptor,
    emisorNombre: cfdi.emisor.nombre ?? '',
    fecha: cfdi.fecha,

    metodoPago: cfdi.metodoPago,
    formaPago: clave(cfdi.formaPago, 2) || undefined,
    pagadoEnEfectivo: clave(cfdi.formaPago, 2) === FORMA_PAGO_EFECTIVO,

    moneda: cfdi.moneda,
    tipoCambio: num(cfdi.tipoCambio) || 1,
    esMonedaExtranjera: cfdi.moneda !== 'MXN' && cfdi.moneda !== 'XXX',

    subtotal: num(cfdi.subTotal),
    descuento: num(cfdi.descuento),
    total: num(cfdi.total),

    ...tax,

    complementos: cfdi.complementos.map((c) => c.type),
    docsRelacionados: pagos,
    tipoRelacion: rel.tipoRelacion,
    uuidsRelacionados: rel.uuids,

    usoCfdi: cfdi.receptor.usoCFDI,
    esAnticipo: detectAnticipo(cfdi),
    clavesProdServ: cfdi.conceptos.map((c) => c.claveProdServ).filter(Boolean),
    conceptosDescripcion: cfdi.conceptos.map((c) => c.descripcion).join(' | ').slice(0, 500),
  };
}

/**
 * Tax breakdown by rate and type. Distinguishes EXEMPT from 0% rate:
 * for accounting they are not the same — exempt items are not subject to
 * the tax and generate no creditable VAT, while the 0% rate is subject to
 * it and does allow crediting. Also splits out IEPS (003), which the
 * previous breakdown ignored.
 */
function breakdownTaxes(cfdi: CFDIParsed) {
  let iva16 = new Decimal(0);
  let iva8 = new Decimal(0);
  let iva0 = new Decimal(0);
  let exento = new Decimal(0);
  let ieps = new Decimal(0);
  let isrRet = new Decimal(0);
  let ivaRet = new Decimal(0);

  for (const c of cfdi.conceptos) {
    // ObjetoImp 01 = not subject to tax, 02 = subject, 03 = subject but not obligated
    // An item with no transferred taxes and a nonzero amount is exempt/not subject.
    const traslados = c.impuestos?.traslados ?? [];
    const tieneIva = traslados.some((t) => impuestoClave(t.impuesto) === '002');
    if (!tieneIva && objetoImpClave(c.objetoImp) === '01') {
      exento = exento.plus(num(c.importe));
    }

    for (const t of traslados) {
      const importe = new Decimal(num(t.importe));
      const tasa = Math.round(num(t.tasaOCuota) * 100);
      const imp = impuestoClave(t.impuesto);
      if (imp === '002') {
        if (tasa === 16) iva16 = iva16.plus(importe);
        else if (tasa === 8) iva8 = iva8.plus(importe);
        else if (tasa === 0) {
          // Real 0% rate: the tax amount is 0, what matters is the BASE
          iva0 = iva0.plus(num(t.base));
        }
      } else if (imp === '003') {
        ieps = ieps.plus(importe);
      }
    }
    for (const r of c.impuestos?.retenciones ?? []) {
      const importe = new Decimal(num(r.importe));
      const impR = impuestoClave(r.impuesto);
      if (impR === '001') isrRet = isrRet.plus(importe);
      if (impR === '002') ivaRet = ivaRet.plus(importe);
    }
  }

  // Fallback to the global Impuestos node: some CFDIs have no per-item breakdown.
  if (iva16.isZero() && iva8.isZero()) {
    const globalTraslado = num(cfdi.impuestos.totalImpuestosTrasladados);
    if (globalTraslado > 0) iva16 = new Decimal(globalTraslado);
  }
  if (isrRet.isZero() && ivaRet.isZero()) {
    const globalRet = num(cfdi.impuestos.totalImpuestosRetenidos);
    if (globalRet > 0) isrRet = new Decimal(globalRet); // no breakdown: assume ISR
  }

  const locales = extractImpuestosLocales(cfdi);

  return {
    ivaTrasladado16: iva16.toNumber(),
    ivaTrasladado8: iva8.toNumber(),
    ivaTasaCero: iva0.toNumber(),
    importeExento: exento.toNumber(),
    iepsTrasladado: ieps.toNumber(),
    isrRetenido: isrRet.toNumber(),
    ivaRetenido: ivaRet.toNumber(),
    impuestosLocalesTrasladados: locales.trasladados,
    impuestosLocalesRetenidos: locales.retenidos,
  };
}

/**
 * Local taxes (lodging ISH, state payroll taxes) live in their own
 * complement, NOT in the Impuestos node: if they are not read, the CFDI
 * total does not match the sum of its parts and the journal entry does
 * not balance.
 */
function extractImpuestosLocales(cfdi: CFDIParsed): { trasladados: number; retenidos: number } {
  const c = cfdi.complementos.find((x) => x.type === 'ImpuestosLocales');
  if (!c) return { trasladados: 0, retenidos: 0 };
  const d = c.data as Record<string, unknown>;
  return {
    trasladados: num(d.TotaldeTraslados ?? d.totaldeTraslados),
    retenidos: num(d.TotaldeRetenciones ?? d.totaldeRetenciones),
  };
}

/** DoctoRelacionado from the Pagos complement: which invoice and how much was applied. */
function extractPagos(cfdi: CFDIParsed): DoctoRelacionado[] {
  const c = cfdi.complementos.find((x) => x.type === 'Pagos');
  if (!c) return [];
  const data = c.data as Record<string, unknown>;
  const pagoNode = data.Pago ?? data.pago;
  const pagos = Array.isArray(pagoNode) ? pagoNode : pagoNode ? [pagoNode] : [];

  const out: DoctoRelacionado[] = [];
  for (const p of pagos as Array<Record<string, unknown>>) {
    const drNode = p.DoctoRelacionado ?? p.doctoRelacionado;
    const drs = Array.isArray(drNode) ? drNode : drNode ? [drNode] : [];
    for (const dr of drs as Array<Record<string, unknown>>) {
      out.push({
        uuid: String(dr['@_IdDocumento'] ?? dr.IdDocumento ?? ''),
        impSaldoAnt: num(dr['@_ImpSaldoAnt'] ?? dr.ImpSaldoAnt),
        impPagado: num(dr['@_ImpPagado'] ?? dr.ImpPagado),
        impSaldoInsoluto: num(dr['@_ImpSaldoInsoluto'] ?? dr.ImpSaldoInsoluto),
        numParcialidad: num(dr['@_NumParcialidad'] ?? dr.NumParcialidad) || undefined,
        monedaDR: (dr['@_MonedaDR'] ?? dr.MonedaDR) as string | undefined,
        equivalenciaDR: num(dr['@_EquivalenciaDR'] ?? dr.EquivalenciaDR) || undefined,
      });
    }
  }
  return out;
}

/**
 * CfdiRelacionados: the TipoRelacion changes the meaning of an egreso
 * (07 = advance payment application, 03 = return, 04 = substitution). It
 * comes from the parser because it is a sibling of Comprobante, not a
 * complement.
 */
function extractRelacionados(cfdi: CFDIParsed): { tipoRelacion?: string; uuids: string[] } {
  const rel = cfdi.cfdiRelacionados;
  if (!rel) return { uuids: [] };
  return { tipoRelacion: rel.tipoRelacion || undefined, uuids: rel.uuids };
}

function detectAnticipo(cfdi: CFDIParsed): boolean {
  if (cfdi.conceptos.some((c) => c.claveProdServ === CLAVE_ANTICIPO)) return true;
  // Matches the Spanish word "anticipo" in real invoice data — do not translate.
  const desc = cfdi.conceptos.map((c) => c.descripcion ?? '').join(' ').toLowerCase();
  return /\banticipo\b/.test(desc);
}
