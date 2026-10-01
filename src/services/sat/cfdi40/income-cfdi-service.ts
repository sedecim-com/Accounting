import { query } from '../../../database/connection.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { buildValidatedIncomeCfdi, type IncomeCfdiInput } from './income-cfdi.js';

// ============================================================
// Reads what the CFDI needs and hands it to the builder (#105 · MNE-001-295).
// Every read is bound to the entity: the invoice, its lines, the issuer and the
// customer all come through `entity_id`, so an id from a sibling company finds
// nothing (TEN-10).
// ============================================================

/** `YYYY-MM-DDThh:mm:ss` on the wall clock of Mexico City, the CFDI Fecha. */
export function cfdiTimestamp(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

interface InvoiceRow {
  invoice_number: string;
  currency_code: string;
  exchange_rate: string;
  subtotal: string;
  total_amount: string;
  e_rfc: string | null;
  e_name: string;
  e_regime: string | null;
  e_postal: string | null;
  e_id_type: string;
  c_rfc: string | null;
  c_id_type: string | null;
  c_name: string | null;
  c_regime: string | null;
  c_postal: string | null;
  c_uso: string | null;
}

export async function loadIncomeCfdiInput(
  invoiceId: string,
  entityId: string,
  at: Date = new Date()
): Promise<IncomeCfdiInput> {
  const { rows } = await query<InvoiceRow>(
    `SELECT i.invoice_number, i.currency_code, i.exchange_rate::text, i.subtotal::text, i.total_amount::text,
            e.tax_id AS e_rfc, e.name AS e_name, e.tax_regime AS e_regime, e.tax_postal_code AS e_postal,
            e.tax_id_type AS e_id_type,
            c.tax_id AS c_rfc, c.tax_id_type AS c_id_type,
            COALESCE(NULLIF(c.company_name, ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '')) AS c_name,
            c.tax_regime AS c_regime, c.tax_postal_code AS c_postal, c.uso_cfdi AS c_uso
       FROM invoices i
       JOIN legal_entities e ON e.id = i.entity_id
       JOIN customers c ON c.id = i.customer_id AND c.entity_id = i.entity_id
      WHERE i.id = $1 AND i.entity_id = $2`,
    [invoiceId, entityId]
  );
  const r = rows[0];
  if (!r) throw new NotFoundError('Invoice', invoiceId);
  if (r.e_id_type !== 'rfc') throw new ValidationError('A CFDI is issued by an entity with an RFC');
  if (r.c_id_type !== null && r.c_id_type !== 'rfc') {
    throw new ValidationError('A CFDI for a customer without an RFC (foreign receiver) is not supported yet');
  }

  const lines = await query<{
    line_number: number; description: string | null; quantity: string; unit_price: string;
    tax_code: string | null; tax_rate: string | null; cfdi_product_code: string | null; cfdi_unit_code: string | null;
  }>(
    `SELECT il.line_number, il.description, il.quantity::text, il.unit_price::text, il.tax_code,
            il.tax_rate::text, il.cfdi_product_code, il.cfdi_unit_code
       FROM invoice_lines il
      WHERE il.invoice_id = $1
      ORDER BY il.line_number`,
    [invoiceId]
  );

  return {
    issuedAt: cfdiTimestamp(at),
    invoice: {
      invoiceNumber: r.invoice_number,
      currencyCode: r.currency_code,
      exchangeRate: r.exchange_rate,
      subtotal: r.subtotal,
      totalAmount: r.total_amount,
    },
    issuer: { rfc: r.e_rfc, name: r.e_name, taxRegime: r.e_regime, postalCode: r.e_postal },
    receiver: { rfc: r.c_rfc, name: r.c_name, taxRegime: r.c_regime, postalCode: r.c_postal, cfdiUse: r.c_uso },
    lines: lines.rows.map((l) => ({
      lineNumber: l.line_number,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      taxCode: l.tax_code,
      taxRate: l.tax_rate,
      productCode: l.cfdi_product_code,
      unitCode: l.cfdi_unit_code,
    })),
  };
}

/** The unsealed, XSD-valid CFDI 4.0 ingreso for an invoice of the entity. */
export async function buildInvoiceCfdiXml(invoiceId: string, entityId: string, at?: Date): Promise<string> {
  return buildValidatedIncomeCfdi(await loadIncomeCfdiInput(invoiceId, entityId, at));
}
