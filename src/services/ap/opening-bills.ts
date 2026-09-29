import Decimal from 'decimal.js';
import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ConflictError } from '../../utils/errors.js';
import { generateEntryNumber, nextEntityNumber } from '../../utils/sequence.js';
import type { OpeningFinding, OpeningPlan } from '../accounting/opening-balance.js';
import { controlDocuments } from '../ar/opening-invoices.js';

// ============================================================
// OPEN PAYABLES OF A MIGRATION (MNE-001-023 · #310, layer 3 of O1)
//
// The mirror of `ar/opening-invoices.ts`. The opening entry already writes
// each open vendor document as its own line on the payable control account;
// here every document of a `cxp` control account becomes a payable bill IN
// THE SAME TRANSACTION, pointing at the opening entry (`journal_entry_id`),
// which already carries its amount. No money is posted twice, and
// `ap reconcile` sees the subledger behind the control balance.
//
// The load refuses, naming the account, whenever the subledger it would
// write could not match what `ap reconcile` and the vendor payments read:
//   - the default `cxp` role points at ANOTHER account: a payment would debit
//     that account while the liability sits here;
//   - a document runs against the account (a debit balance, e.g. an advance
//     to the vendor): it is not a bill, and leaving it out is the delta;
//   - a document in a currency other than the functional one;
//   - the same vendor folio is already a bill of this entity: the liability
//     would be counted twice.
// No adjusting entry is ever posted to make it tie.
//
// What differs from receivables, on purpose:
//   - The vendor's folio is NOT unique across vendors, so it goes to
//     `vendor_invoice_number` and the bill takes the next internal folio of
//     the BILL series; a duplicate is the same folio FOR THE SAME VENDOR.
//   - The bill is born `approved`: approving is what posts a bill, and its
//     liability is already in the ledger through the opening entry.
//
// NOTE: the open balance goes in as subtotal with no tax, as on the AR side:
// the source gives the balance, not its IVA split, so paying a migrated bill
// releases no IVA from `iva_pendiente_acreditar`. Bills have no void path,
// so there is no reversal of the shared opening entry to guard against.
// ============================================================

/** A bill the opening will create, one per open vendor document. */
export interface OpeningBillDraft {
  accountCode: string;
  /** The vendor's own folio, kept in `vendor_invoice_number`. */
  vendorInvoiceNumber: string;
  vendorName: string;
  vendorRfc: string | null;
  date: string;
  dueDate: string;
  amount: string;
  currency: string;
  cfdiUuid: string | null;
  /** The bill of a REVERSED opening that this load takes over (087 reload). */
  replacesId: string | null;
}

/** A bill of the entity that carries a folio a document wants to use. */
export interface ExistingBill {
  id: string;
  vendor_invoice_number: string;
  vendor_name: string;
  vendor_rfc: string | null;
  status: string;
  amount_paid: string;
  /** true when it hangs from an opening entry that was already reversed. */
  from_reversed_opening: boolean;
}

export interface OpeningBillsContext {
  /** Code of the account the default `cxp` role points at, or null. */
  payableRoleCode: string | null;
  functionalCurrency: string;
  existing: readonly ExistingBill[];
}

export interface OpeningBillsPlan {
  drafts: OpeningBillDraft[];
  findings: OpeningFinding[];
}

const block = (rule: string, account: string, message: string): OpeningFinding => ({
  regla: rule,
  severidad: 'bloquea',
  numCta: account,
  mensaje: message,
});

/** Same vendor: by RFC when both sides carry one, else by exact name. */
function sameVendor(rfc: string | null, name: string, e: ExistingBill): boolean {
  if (rfc !== null && e.vendor_rfc !== null && e.vendor_rfc.trim() !== '') {
    return e.vendor_rfc.trim().toUpperCase() === rfc;
  }
  return e.vendor_name.trim().toLowerCase() === name.toLowerCase();
}

/** Pure: which bills the opening would create, and what stops them. */
export function planOpeningBills(
  plan: Pick<OpeningPlan, 'lines' | 'control'>,
  ctx: OpeningBillsContext
): OpeningBillsPlan {
  const docs = controlDocuments(plan, 'cxp');
  const findings: OpeningFinding[] = [];
  const drafts: OpeningBillDraft[] = [];
  if (docs.length === 0) return { drafts, findings };

  const withDocs = [...new Set(docs.map((l) => l.code))];
  if (ctx.payableRoleCode === null) {
    findings.push({
      regla: 'APE-CXP-SIN-ROL',
      severidad: 'aviso',
      numCta: withDocs[0],
      mensaje:
        `Las facturas de proveedores entran al auxiliar, pero ninguna cuenta tiene el rol "cxp": ` +
        `'ap reconcile' no tiene contra qué compararlas y un pago no sabe qué cuenta cargar. ` +
        `Fíjalo con: mnemosine account role set cxp ${withDocs[0]}`,
    });
  }
  for (const code of withDocs) {
    if (ctx.payableRoleCode !== null && ctx.payableRoleCode !== code) {
      findings.push(
        block(
          'APE-CXP-OTRA-CUENTA',
          code,
          `Los documentos de "${code}" entrarían como facturas de proveedor, pero el rol "cxp" apunta ` +
            `a "${ctx.payableRoleCode}": cada pago cargaría "${ctx.payableRoleCode}" mientras el pasivo ` +
            `vive en "${code}", y 'ap reconcile' compararía el auxiliar contra la cuenta equivocada. ` +
            `Apunta el rol a la cuenta de control migrada (mnemosine account role set cxp ${code}) y ` +
            `vuelve a correr la carga.`
        )
      );
    }
  }

  const seen = new Set<string>();
  for (const line of docs) {
    const d = line.doc;
    const amount = new Decimal(d.importe);
    if (amount.isNegative()) {
      findings.push(
        block(
          'APE-CXP-SALDO-DEUDOR',
          line.code,
          `"${d.documento}" de ${d.contraparte} trae ${d.importe}: un saldo a favor frente al ` +
            `proveedor (un anticipo, una nota de crédito) no es una factura por pagar, y dejarlo fuera ` +
            `del auxiliar descuadra 'ap reconcile' por ese importe. Nétalo contra las facturas abiertas ` +
            `del mismo proveedor en el origen.`
        )
      );
      continue;
    }
    const currency = (d.currency ?? ctx.functionalCurrency).trim().toUpperCase();
    if (currency !== ctx.functionalCurrency) {
      findings.push(
        block(
          'APE-CXP-MONEDA',
          line.code,
          `"${d.documento}" está en ${currency} y la entidad lleva sus libros en ` +
            `${ctx.functionalCurrency}. La apertura lo posa en ${ctx.functionalCurrency} y 'ap reconcile' ` +
            `suma el saldo de la factura tal como viene: no se convierte en silencio. Trae su saldo en ` +
            `${ctx.functionalCurrency}.`
        )
      );
      continue;
    }
    const vendorName = d.contraparte.trim();
    const vendorRfc = d.rfc === undefined || d.rfc.trim() === '' ? null : d.rfc.trim().toUpperCase();
    const key = `${vendorRfc ?? vendorName.toLowerCase()}|${d.documento}`;
    const taken = ctx.existing.find(
      (e) => e.vendor_invoice_number === d.documento && sameVendor(vendorRfc, vendorName, e)
    );
    const reusable =
      taken !== undefined &&
      taken.from_reversed_opening &&
      taken.status === 'approved' &&
      new Decimal(taken.amount_paid).isZero();
    if (seen.has(key) || (taken !== undefined && !reusable)) {
      findings.push(
        block(
          'APE-CXP-FOLIO-TOMADO',
          line.code,
          `La factura "${d.documento}" de ${vendorName} ya está registrada en esta entidad: cargarla ` +
            `otra vez contaría dos veces el mismo pasivo. Quítala del auxiliar o corrige el folio.`
        )
      );
      continue;
    }
    seen.add(key);
    drafts.push({
      accountCode: line.code,
      vendorInvoiceNumber: d.documento,
      vendorName,
      vendorRfc,
      date: d.fecha,
      // `due_date` is NOT NULL; the opening already warned (APE-SIN-VENCIMIENTO).
      dueDate: d.vencimiento === undefined || d.vencimiento === '' ? d.fecha : d.vencimiento,
      amount: amount.toFixed(4),
      currency,
      cfdiUuid: d.uuid === undefined || d.uuid === '' ? null : d.uuid,
      replacesId: reusable ? taken.id : null,
    });
  }
  return { drafts, findings };
}

/** Under `apertura_modo_de_carga = borrador` no bill is written; the load says so. */
export function payablesSkippedUnderDraftMode(plan: Pick<OpeningPlan, 'lines' | 'control'>): OpeningBillsPlan {
  const docs = controlDocuments(plan, 'cxp');
  if (docs.length === 0) return { drafts: [], findings: [] };
  return {
    drafts: [],
    findings: [
      {
        regla: 'APE-CXP-BORRADOR',
        severidad: 'aviso',
        numCta: docs[0].code,
        mensaje:
          `La apertura queda en BORRADOR (apertura_modo_de_carga = borrador), así que sus ${docs.length} ` +
          `documento(s) de proveedores NO entran como facturas: una factura colgada de un asiento sin ` +
          `postear se podría pagar antes de que su pasivo esté en el mayor. Al postearla, 'ap reconcile' ` +
          `acusará ese saldo como diferencia. Para traer las facturas, carga la apertura con ` +
          `apertura_modo_de_carga = contabilizar.`,
      },
    ],
  };
}

/** Reads what the pure plan needs. Queries nothing when there is no AP document. */
export async function prepareOpeningBills(
  entityId: string,
  plan: Pick<OpeningPlan, 'lines' | 'control'>
): Promise<OpeningBillsPlan> {
  const folios = controlDocuments(plan, 'cxp').map((l) => l.doc.documento);
  if (folios.length === 0) return { drafts: [], findings: [] };

  const role = await query<{ code: string }>(
    `SELECT a.code
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = 'cxp' AND r.qualifier IS NULL`,
    [entityId]
  );
  const entity = await query<{ functional_currency: string }>(
    `SELECT functional_currency FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const existing = await query<ExistingBill>(
    `SELECT b.id, b.vendor_invoice_number, v.company_name AS vendor_name, v.tax_id AS vendor_rfc,
            b.status, b.amount_paid::text AS amount_paid,
            (je.source_type = 'opening_balance' AND je.reversed_by_entry_id IS NOT NULL)
              IS TRUE AS from_reversed_opening
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
       LEFT JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = b.entity_id
      WHERE b.entity_id = $1 AND b.vendor_invoice_number = ANY($2::text[])`,
    [entityId, folios]
  );
  return planOpeningBills(plan, {
    payableRoleCode: role.rows[0]?.code ?? null,
    functionalCurrency: entity.rows[0]?.functional_currency ?? 'MXN',
    existing: existing.rows,
  });
}

/**
 * Writes the drafts inside the opening's transaction. The vendor is found by
 * RFC, else by exact name, and created only when neither exists.
 */
export async function writeOpeningBills(
  client: pg.PoolClient,
  entityId: string,
  userId: string,
  openingEntryId: string,
  drafts: readonly OpeningBillDraft[]
): Promise<number> {
  const vendors = new Map<string, string>();
  for (const d of drafts) {
    const key = d.vendorRfc ?? `name:${d.vendorName.toLowerCase()}`;
    let vendorId = vendors.get(key);
    if (vendorId === undefined) {
      const found = await client.query<{ id: string }>(
        d.vendorRfc !== null
          ? `SELECT id FROM vendors WHERE entity_id = $1 AND UPPER(tax_id) = $2 ORDER BY created_at LIMIT 1`
          : `SELECT id FROM vendors WHERE entity_id = $1 AND LOWER(company_name) = LOWER($2) ORDER BY created_at LIMIT 1`,
        [entityId, d.vendorRfc ?? d.vendorName]
      );
      vendorId = found.rows[0]?.id;
      if (vendorId === undefined) {
        const count = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM vendors WHERE entity_id = $1`,
          [entityId]
        );
        const created = await client.query<{ id: string }>(
          `INSERT INTO vendors (entity_id, vendor_number, company_name, tax_id, tax_id_type,
                                currency_code, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'Migrated with the opening balance', $7)
           RETURNING id`,
          [entityId, generateEntryNumber('V', Number(count.rows[0].n)), d.vendorName,
           d.vendorRfc, d.vendorRfc === null ? null : 'rfc', d.currency, userId]
        );
        vendorId = created.rows[0].id;
      }
      vendors.set(key, vendorId);
    }

    const values = [vendorId, d.amount, d.currency, d.date, d.dueDate, d.cfdiUuid, openingEntryId, entityId];
    if (d.replacesId !== null) {
      // Guarded: only the untouched bill of a reversed opening is taken over.
      const r = await client.query(
        `UPDATE bills
            SET vendor_id = $1, subtotal = $2, tax_amount = 0, total_amount = $2, amount_due = $2,
                currency_code = $3, bill_date = $4, due_date = $5, cfdi_uuid = $6,
                journal_entry_id = $7, updated_at = NOW()
          WHERE id = $9 AND entity_id = $8 AND status = 'approved' AND amount_paid = 0`,
        [...values, d.replacesId]
      );
      if (r.rowCount !== 1) {
        throw new ConflictError(
          `La factura ${d.vendorInvoiceNumber} de ${d.vendorName} cambió mientras se cargaba la apertura; no se escribió nada.`
        );
      }
      continue;
    }
    const billNumber = await nextEntityNumber(client, entityId, 'bill', 'BILL', d.date);
    await client.query(
      `INSERT INTO bills (vendor_id, subtotal, total_amount, amount_due, currency_code, bill_date,
                          due_date, cfdi_uuid, journal_entry_id, entity_id, bill_number,
                          vendor_invoice_number, status, approved_by, approved_at, description, created_by)
       VALUES ($1, $2, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved', $11, NOW(), $12, $11)`,
      [...values, billNumber, d.vendorInvoiceNumber, userId, `Open at the opening balance · ${d.accountCode}`]
    );
  }
  return drafts.length;
}
