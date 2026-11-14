import { XMLBuilder } from 'fast-xml-parser';
import Decimal from 'decimal.js';
import { ValidationError } from '../../../utils/errors.js';
import { validateAgainstCfdi40Xsd, type Cfdi40Verdict } from './official-xsd.js';

// ============================================================
// CFDI 4.0 TIPO I (ingreso) FROM AN INVOICE (#105 · MNE-001-295)
//
// Until now POST /v1/invoices/:id/cfdi/stamp sent the PAC a Comprobante of four
// attributes (Folio, Total, SubTotal, Moneda). This module builds the whole
// document: Comprobante, Emisor, Receptor, Conceptos and Impuestos, from the
// invoice, its lines, the issuing entity and the customer.
//
// What it does NOT do, on purpose: it does not seal. cfdv40.xsd makes Sello,
// NoCertificado and Certificado required, and they only exist once the CSD has
// signed the cadena original (MNE-001-296). `buildIncomeCfdiXml` therefore
// returns the document WITHOUT them, and `validateUnsealedCfdi` checks it
// against the official XSD with inert stand-ins for those three attributes, so
// every other rule of the schema is enforced today. Nothing here may be handed
// to a PAC as-is.
//
// Design choices (each stated in the PR):
//   · The XML is built with XMLBuilder, so escaping is structural, as in the
//     Anexo 24 builders; there is no template string to forget an escape in.
//   · It fails closed. A missing RFC, regime, postal code, UsoCFDI, SAT product
//     or unit code is a ValidationError that lists EVERY gap, not a default
//     invented on the taxpayer's behalf.
//   · Money is recomputed with the SAT's rounding (half up, 2 decimals per
//     concept, tax on the rounded base) and must equal what the invoice booked:
//     a CFDI whose Total differs from the receivable would be a second,
//     different document for the same sale.
//   · Line tax follows the convention the IVA workpaper already reads:
//     tax_code 'exento' = Exento; tax_rate null = not subject (ObjetoImp 01);
//     any rate, 0 included = Tasa.
// ============================================================

export interface CfdiIssuer {
  rfc: string | null;
  name: string | null;
  /** c_RegimenFiscal */
  taxRegime: string | null;
  /** The CFDI LugarExpedicion, 5 digits. */
  postalCode: string | null;
}

export interface CfdiReceiver {
  rfc: string | null;
  name: string | null;
  taxRegime: string | null;
  /** Postal code of the receiver's fiscal address. */
  postalCode: string | null;
  /** c_UsoCFDI */
  cfdiUse: string | null;
}

export interface CfdiInvoiceLine {
  lineNumber: number;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxCode: string | null;
  taxRate: string | null;
  /** c_ClaveProdServ */
  productCode: string | null;
  /** c_ClaveUnidad */
  unitCode: string | null;
}

export interface CfdiInvoice {
  invoiceNumber: string;
  currencyCode: string;
  exchangeRate: string;
  /** What the invoice booked; the recomputed document must equal them. */
  subtotal: string;
  totalAmount: string;
}

export interface IncomeCfdiInput {
  /** Emission moment in the issuer's local time, `YYYY-MM-DDThh:mm:ss`. */
  issuedAt: string;
  invoice: CfdiInvoice;
  issuer: CfdiIssuer;
  receiver: CfdiReceiver;
  lines: readonly CfdiInvoiceLine[];
}

const CFDI_NS = 'http://www.sat.gob.mx/cfd/4';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = `${CFDI_NS} http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd`;
const IVA = '002';
/** Until the receipts are known the honest answer is «paid later» (PPD) with «por definir» (99). */
const PAYMENT_METHOD = 'PPD';
const PAYMENT_FORM = '99';

const SERIALIZER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  // Explicit though it is the default: it makes escaping structural.
  processEntities: true,
});

const money = (d: Decimal): string => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const rounded = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

function gaps(input: IncomeCfdiInput): string[] {
  const missing: string[] = [];
  const need = (value: string | null | undefined, label: string): void => {
    if (value === null || value === undefined || value.trim() === '') missing.push(label);
  };
  need(input.issuer.rfc, 'issuer.rfc');
  need(input.issuer.name, 'issuer.name');
  need(input.issuer.taxRegime, 'issuer.tax_regime');
  need(input.issuer.postalCode, 'issuer.tax_postal_code');
  need(input.receiver.rfc, 'receiver.rfc');
  need(input.receiver.name, 'receiver.name');
  need(input.receiver.taxRegime, 'receiver.tax_regime');
  need(input.receiver.postalCode, 'receiver.tax_postal_code');
  need(input.receiver.cfdiUse, 'receiver.uso_cfdi');
  for (const line of input.lines) {
    need(line.description, `line ${line.lineNumber}.description`);
    need(line.productCode, `line ${line.lineNumber}.cfdi_product_code`);
    need(line.unitCode, `line ${line.lineNumber}.cfdi_unit_code`);
  }
  return missing;
}

interface Concept {
  line: CfdiInvoiceLine;
  quantity: Decimal;
  unitPrice: Decimal;
  amount: Decimal;
  /** null = not subject to the tax (ObjetoImp 01). */
  tax: { exempt: boolean; rate: Decimal | null; amount: Decimal } | null;
}

function concept(line: CfdiInvoiceLine): Concept {
  const quantity = new Decimal(line.quantity);
  const unitPrice = new Decimal(line.unitPrice);
  const amount = rounded(quantity.times(unitPrice));
  if ((line.taxCode ?? '').trim().toLowerCase() === 'exento') {
    return { line, quantity, unitPrice, amount, tax: { exempt: true, rate: null, amount: new Decimal(0) } };
  }
  if (line.taxRate === null) return { line, quantity, unitPrice, amount, tax: null };
  const rate = new Decimal(line.taxRate).dividedBy(100);
  return { line, quantity, unitPrice, amount, tax: { exempt: false, rate, amount: rounded(amount.times(rate)) } };
}

const rateText = (rate: Decimal): string => rate.toFixed(6);

function conceptNode(c: Concept): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@_ClaveProdServ': c.line.productCode,
    '@_Cantidad': c.quantity.toFixed(),
    '@_ClaveUnidad': c.line.unitCode,
    '@_Descripcion': c.line.description,
    '@_ValorUnitario': c.unitPrice.toFixed(Math.max(2, c.unitPrice.decimalPlaces())),
    '@_Importe': money(c.amount),
    '@_ObjetoImp': c.tax === null ? '01' : '02',
  };
  if (c.tax !== null) {
    const transfer = c.tax.exempt
      ? { '@_Base': money(c.amount), '@_Impuesto': IVA, '@_TipoFactor': 'Exento' }
      : {
          '@_Base': money(c.amount),
          '@_Impuesto': IVA,
          '@_TipoFactor': 'Tasa',
          '@_TasaOCuota': rateText(c.tax.rate as Decimal),
          '@_Importe': money(c.tax.amount),
        };
    node['cfdi:Impuestos'] = { 'cfdi:Traslados': { 'cfdi:Traslado': [transfer] } };
  }
  return node;
}

function taxesNode(concepts: readonly Concept[]): Record<string, unknown> | null {
  const groups = new Map<string, { exempt: boolean; rate: Decimal | null; base: Decimal; amount: Decimal }>();
  for (const c of concepts) {
    if (c.tax === null) continue;
    const key = c.tax.exempt ? 'Exento' : `Tasa|${rateText(c.tax.rate as Decimal)}`;
    const g = groups.get(key) ?? { exempt: c.tax.exempt, rate: c.tax.rate, base: new Decimal(0), amount: new Decimal(0) };
    g.base = g.base.plus(c.amount);
    g.amount = g.amount.plus(c.tax.amount);
    groups.set(key, g);
  }
  if (groups.size === 0) return null;
  const transfers = [...groups.values()].map((g) =>
    g.exempt
      ? { '@_Base': money(g.base), '@_Impuesto': IVA, '@_TipoFactor': 'Exento' }
      : {
          '@_Base': money(g.base),
          '@_Impuesto': IVA,
          '@_TipoFactor': 'Tasa',
          '@_TasaOCuota': rateText(g.rate as Decimal),
          '@_Importe': money(g.amount),
        }
  );
  const node: Record<string, unknown> = {};
  const taxed = [...groups.values()].filter((g) => !g.exempt);
  if (taxed.length > 0) {
    node['@_TotalImpuestosTrasladados'] = money(taxed.reduce((acc, g) => acc.plus(g.amount), new Decimal(0)));
  }
  node['cfdi:Traslados'] = { 'cfdi:Traslado': transfers };
  return node;
}

/**
 * The unsealed CFDI 4.0 ingreso document for an invoice. Throws a
 * ValidationError naming every missing datum, or when the recomputed SubTotal
 * or Total differ from the invoice's.
 */
export function buildIncomeCfdiXml(input: IncomeCfdiInput): string {
  if (input.lines.length === 0) throw new ValidationError('A CFDI needs at least one concept');
  const missing = gaps(input);
  if (missing.length > 0) {
    throw new ValidationError(`The CFDI cannot be built: missing ${missing.join(', ')}`, undefined, { missing });
  }

  const concepts = input.lines.map(concept);
  const subtotal = concepts.reduce((acc, c) => acc.plus(c.amount), new Decimal(0));
  const taxes = concepts.reduce((acc, c) => acc.plus(c.tax?.amount ?? 0), new Decimal(0));
  const total = subtotal.plus(taxes);
  if (!rounded(subtotal).equals(rounded(new Decimal(input.invoice.subtotal))) ||
      !rounded(total).equals(rounded(new Decimal(input.invoice.totalAmount)))) {
    throw new ValidationError(
      `The CFDI does not match the invoice: lines give SubTotal ${money(subtotal)} and Total ${money(total)}, ` +
        `the invoice says ${money(new Decimal(input.invoice.subtotal))} and ${money(new Decimal(input.invoice.totalAmount))}`,
      undefined,
      { subtotal: money(subtotal), total: money(total) }
    );
  }

  const isMxn = input.invoice.currencyCode === 'MXN';
  const voucher: Record<string, unknown> = {
    '@_xmlns:cfdi': CFDI_NS,
    '@_xmlns:xsi': XSI_NS,
    '@_xsi:schemaLocation': SCHEMA_LOCATION,
    '@_Version': '4.0',
    '@_Folio': input.invoice.invoiceNumber,
    '@_Fecha': input.issuedAt,
    '@_FormaPago': PAYMENT_FORM,
    '@_SubTotal': money(subtotal),
    '@_Moneda': input.invoice.currencyCode,
    ...(isMxn ? {} : { '@_TipoCambio': new Decimal(input.invoice.exchangeRate).toFixed() }),
    '@_Total': money(total),
    '@_TipoDeComprobante': 'I',
    '@_Exportacion': '01',
    '@_MetodoPago': PAYMENT_METHOD,
    '@_LugarExpedicion': input.issuer.postalCode,
    'cfdi:Emisor': {
      '@_Rfc': input.issuer.rfc,
      '@_Nombre': input.issuer.name,
      '@_RegimenFiscal': input.issuer.taxRegime,
    },
    'cfdi:Receptor': {
      '@_Rfc': input.receiver.rfc,
      '@_Nombre': input.receiver.name,
      '@_DomicilioFiscalReceptor': input.receiver.postalCode,
      '@_RegimenFiscalReceptor': input.receiver.taxRegime,
      '@_UsoCFDI': input.receiver.cfdiUse,
    },
    'cfdi:Conceptos': { 'cfdi:Concepto': concepts.map(conceptNode) },
  };
  const taxBlock = taxesNode(concepts);
  if (taxBlock !== null) voucher['cfdi:Impuestos'] = taxBlock;

  return `<?xml version="1.0" encoding="UTF-8"?>\n${SERIALIZER.build({ 'cfdi:Comprobante': voucher })}`;
}

/**
 * Validates an unsealed document against the official XSD by giving Sello,
 * NoCertificado and Certificado inert stand-ins (the schema requires them and
 * the CSD has not signed yet). The stand-ins are only in the copy that is
 * checked, never in the document returned by the builder.
 */
export function validateUnsealedCfdi(xml: string): Cfdi40Verdict {
  const standIns = ' Sello="AA==" NoCertificado="00000000000000000000" Certificado="AA=="';
  return validateAgainstCfdi40Xsd(xml.replace('<cfdi:Comprobante', `<cfdi:Comprobante${standIns}`));
}

/** Builds and validates in one step; an XSD violation is a ValidationError. */
export function buildValidatedIncomeCfdi(input: IncomeCfdiInput): string {
  const xml = buildIncomeCfdiXml(input);
  const verdict = validateUnsealedCfdi(xml);
  if (!verdict.valid) {
    throw new ValidationError(`The CFDI does not validate against the SAT's XSD: ${verdict.errors.join('; ')}`, undefined, {
      errors: verdict.errors,
    });
  }
  return xml;
}
