import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../src/database/connection.js';
import { createJournalEntry } from '../../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../../src/types/index.js';
import type { Fixture } from './tenant-fixture.js';

export interface SeededBill {
  vendorId: string;
  method: 'PUE' | 'PPD';
  /** The account the entry debits the VAT to: creditable (1130) or pending (1135). */
  vatCode: '1130' | '1135';
  date: string;
  subtotal?: string;
  vat?: string;
}

/**
 * A received bill written by hand, as iva-ppd-reclass.int.spec.ts seeds its
 * legacy bill: the CFDI row that says its method, the bill with one line at
 * 16 %, its pre-registration and a posted entry against 2110.
 *
 * NOTE: for the bills no door writes: a received bill against vendors whose
 * VAT went to 1130 is what the doors posted before cash-basis VAT (a PPD) and
 * before MNE-001-492 (a PUE). Seeded, such a bill does not depend on the door.
 */
export async function seedBill(f: Fixture, bill: SeededBill): Promise<{ id: string; uuid: string; entryId: string }> {
  const [id, xmlId, uuid] = [uuidv4(), uuidv4(), uuidv4().toUpperCase()];
  const subtotal = bill.subtotal ?? '1000.00';
  const vat = bill.vat ?? '160.00';
  const total = (Number(subtotal) + Number(vat)).toFixed(2);
  const number = `BILL-${uuid.slice(0, 8)}`;
  await query(
    `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc, receptor_rfc,
                                import_source, subtotal, total, metodo_pago, xml_content, xml_hash, processing_status)
     VALUES ($1, $2, 'cfdi_ingreso', $3, '4.0', $4, 'SIN060101AB1', 'XAXX010101000', 'manual_upload', $5, $6, $7, '<xml/>', $8, 'completed')`,
    [xmlId, f.entityId, uuid, bill.date, subtotal, total, bill.method, uuidv4().replace(/-/g, '')]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, cfdi_uuid, subtotal, tax_amount,
                        total_amount, amount_due, currency_code, bill_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $8, 'MXN', $9, $9, 'posted', $10)`,
    [id, f.entityId, number, bill.vendorId, uuid, subtotal, vat, total, bill.date, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (bill_id, line_number, account_id, description, unit_price, line_amount, tax_amount,
                             total_amount, tax_rate, tipo_factor, valor_actos)
     VALUES ($1, 1, $2, 'Expense', $3, $3, $4, $5, 16, 'tasa', $3)`,
    [id, f.cuentas['6100'], subtotal, vat, total]
  );
  await query(
    `INSERT INTO pre_registrations (id, entity_id, xml_document_id, source_type, document_type, vendor_id, bill_id,
                                    external_reference, document_date, subtotal, tax_amount, total_amount, lines, status, created_by)
     VALUES ($1, $2, $3, 'xml_cfdi', 'bill', $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, 'completed', $11)`,
    [uuidv4(), f.entityId, xmlId, bill.vendorId, id, uuid, bill.date, subtotal, vat, total, f.userId]
  );
  const entry = await createJournalEntry(
    f.entityId, bill.date, JournalEntryType.AUTO_BILL, `Bill ${number} (seeded)`,
    [
      { account_id: f.cuentas['6100'], debit_amount: subtotal, credit_amount: null, description: 'Expense' },
      { account_id: f.cuentas[bill.vatCode], debit_amount: vat, credit_amount: null, description: 'VAT' },
      { account_id: f.cuentas['2110'], debit_amount: null, credit_amount: total, description: 'Vendors' },
    ],
    f.userId,
    { autoPost: true, sourceType: 'bill', sourceId: id }
  );
  await query(`UPDATE bills SET journal_entry_id = $1 WHERE id = $2 AND entity_id = $3`, [entry.id, id, f.entityId]);
  return { id, uuid, entryId: entry.id };
}
