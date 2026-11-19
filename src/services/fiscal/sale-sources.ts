import Decimal from 'decimal.js';
import type pg from 'pg';
import type { CFDIParsed } from '../xml-ingestion/cfdi-parser.js';
import { clasificarRenglon, vatLinesOfCfdi, type RenglonDeGasto } from '../sat/diot/index.js';
import type { AdvanceTreatment } from '../payments/customer-advance.js';

// ============================================================
// THE RATES OF A SALE: ONE READER (MNE-001-458..462, #623)
//
// The IVA workpaper splits a collected sale by rate (MNE-001-058), and the
// excess of a collection left on account takes the rate of the invoice it
// collects (MNE-001-462). Both read an invoice's rates here, so what the
// paper calls a 16 % sale is what a collection's excess calls one.
// ============================================================

const q4 = (d: Decimal.Value): string => new Decimal(d).toFixed(4);

/** What a sale is split by: its CFDI when it was born from one, its lines otherwise. */
export interface SaleSource {
  lines: RenglonDeGasto[];
  /** Base "no objeto" of the whole document, in its currency. Only a CFDI says it. */
  notSubject: string;
  /** True when the lines came from the CFDI, false when from invoice_lines. */
  fromCfdi: boolean;
}

/**
 * The CFDI's own split. `tax_breakdown` is the Comprobante/Impuestos summary
 * stored at ingestion: one Traslado per tax, factor and rate, with its Base.
 * Each VAT one becomes one line (`vatLinesOfCfdi`), the reading the bills get.
 * What the subtotal carries beyond the bases the CFDI taxes or exempts is
 * "no objeto" (ObjetoImp 01): such a concept appears in no Traslado at all.
 */
export function saleFromCfdi(
  taxes: Partial<CFDIParsed['impuestos']>,
  subtotal: string,
  discount: string
): SaleSource {
  const vat = (taxes.traslados ?? []).filter((t) => String(t.impuesto ?? '').padStart(3, '0') === '002');
  const lines = vatLinesOfCfdi(taxes);
  // A Traslado without its Base leaves the rest unknown, and an unknown rest
  // is not "no objeto": the exempt line without a base already blocks.
  const known = vat.every((t) => t.base != null);
  const bases = vat.reduce((acc, t) => acc.plus(t.base ?? 0), new Decimal(0));
  const rest = known ? new Decimal(subtotal).minus(discount).minus(bases) : new Decimal(0);
  return { lines, notSubject: q4(rest.greaterThan('0.01') ? rest : 0), fromCfdi: true };
}

export async function saleSources(
  client: pg.PoolClient,
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, SaleSource>> {
  const bySale = new Map<string, SaleSource>();
  if (ids.length === 0) return bySale;
  const cfdi = await client.query<{
    invoice_id: string; tax_breakdown: Partial<CFDIParsed['impuestos']>; subtotal: string; discount: string;
  }>(
    `SELECT p.result_id AS invoice_id, p.tax_breakdown, x.subtotal::text, COALESCE(x.descuento, 0)::text AS discount
       FROM pre_registrations p
       JOIN xml_documents x ON x.id = p.xml_document_id AND x.entity_id = p.entity_id
      WHERE p.entity_id = $1 AND p.result_type = 'invoice' AND p.result_id = ANY($2::uuid[])
        AND p.tax_breakdown IS NOT NULL`,
    [entityId, [...ids]]
  );
  for (const r of cfdi.rows) bySale.set(r.invoice_id, saleFromCfdi(r.tax_breakdown, r.subtotal, r.discount));

  const manual = ids.filter((id) => !bySale.has(id));
  if (manual.length === 0) return bySale;
  const { rows } = await client.query<{
    invoice_id: string; tax_rate: string | null; tax_code: string | null; line_amount: string; tax_amount: string;
  }>(
    `SELECT il.invoice_id, il.tax_rate::text, il.tax_code, il.line_amount::text, il.tax_amount::text
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.entity_id = $1 AND il.invoice_id = ANY($2::uuid[])
      ORDER BY il.invoice_id, il.line_number`,
    [entityId, manual]
  );
  for (const r of rows) {
    const sale = bySale.get(r.invoice_id) ?? { lines: [], notSubject: q4(0), fromCfdi: false };
    // A manual invoice line has no tipo_factor column: `tax_code = 'exento'`
    // is the only way it says so. Its base is its own amount.
    const exempt = (r.tax_code ?? '').trim().toLowerCase() === 'exento';
    sale.lines.push({
      tipoFactor: exempt ? 'exento' : 'tasa',
      tasa: exempt ? null : r.tax_rate,
      valorActos: r.line_amount,
      importe: r.line_amount,
      iva: r.tax_amount,
    });
    bySale.set(r.invoice_id, sale);
  }
  return bySale;
}

/**
 * MNE-001-462 · The treatment the excess of a collection takes from the sale
 * it collects, and what was assumed to take it.
 *
 * One treatment is that one. Several are a missing fact, the rate of the
 * excess, and a missing fact takes the assumption that cannot understate the
 * tax, as a missing MetodoPago does (`iva-cash-basis.ts`): the highest rate
 * that carries IVA, or, when none does, exempt, which credits the least under
 * LIVA art. 5 fr. V (#623, answer 2 of 16 Nov 2026). A rate outside 16 and 8
 * that carries IVA is no treatment an advance takes, so it reads as the
 * general rate (LIVA art. 1), said as the highest. Null when the sale says
 * nothing: no line with an amount and no base outside the object of IVA.
 */
export interface SaleTreatment {
  treatment: AdvanceTreatment;
  /** Null when the sale has one treatment; otherwise what the rule assumed. */
  assumed: 'highest' | 'exempt' | null;
}

export function treatmentOfSale(sale: Pick<SaleSource, 'lines' | 'notSubject'>): SaleTreatment | null {
  const found = new Set<AdvanceTreatment | 'other'>();
  for (const line of sale.lines) {
    if (new Decimal(line.importe || '0').isZero() && new Decimal(line.iva || '0').isZero()) continue;
    const box = clasificarRenglon(line).clave;
    found.add(box === 'tasa16' ? '16' : box === 'tasa8' ? '8' : box === 'tasa0' ? '0' : box === 'exento' ? 'exempt' : 'other');
  }
  if (new Decimal(sale.notSubject).greaterThan(0)) found.add('not-subject');
  if (found.size === 0) return null;
  const [only] = [...found];
  if (found.size === 1 && only !== 'other') return { treatment: only, assumed: null };
  if (found.has('16') || found.has('other')) return { treatment: '16', assumed: 'highest' };
  if (found.has('8')) return { treatment: '8', assumed: 'highest' };
  return { treatment: 'exempt', assumed: 'exempt' };
}

/**
 * MNE-001-462 · The treatment of the sales a collection applies to, read
 * with `saleSources` as the IVA paper reads them. A sale with no line and no
 * CFDI is read from its header, as one line whose rate is measured against
 * its subtotal and IVA (`clasificarRenglon`). Entity-scoped in the SQL.
 */
export async function treatmentOfSales(
  client: pg.PoolClient,
  entityId: string,
  invoiceIds: readonly string[]
): Promise<SaleTreatment> {
  const sources = await saleSources(client, entityId, invoiceIds);
  const missing = invoiceIds.filter((id) => !sources.has(id));
  const headers = missing.length === 0 ? [] : (await client.query<{ subtotal: string; tax_amount: string }>(
    `SELECT subtotal::text, tax_amount::text FROM invoices WHERE entity_id = $1 AND id = ANY($2::uuid[])`,
    [entityId, missing]
  )).rows;
  const lines: RenglonDeGasto[] = [
    ...[...sources.values()].flatMap((s) => s.lines),
    ...headers.map((h) => ({ tipoFactor: 'tasa' as const, tasa: null, valorActos: h.subtotal, importe: h.subtotal, iva: h.tax_amount })),
  ];
  const notSubject = [...sources.values()].reduce((s, x) => s.plus(x.notSubject), new Decimal(0));
  // A sale that says nothing carries no IVA a line can show: 0 %, as the paper boxes it.
  return treatmentOfSale({ lines, notSubject: notSubject.toFixed(4) }) ?? { treatment: '0', assumed: null };
}
