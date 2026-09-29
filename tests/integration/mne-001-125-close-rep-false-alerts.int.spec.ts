import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { countPaymentsAwaitingRep } from '../../src/services/accounting/rep-expected.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * MNE-001-125 (#327): the close checklist without false REP alerts, against
 * real Postgres. Each case builds one payment and asks whether the period
 * counts it as awaiting a REP.
 */

let f: Fixture;
let vendorId: string;
let customerId: string;
const count = () => countPaymentsAwaitingRep(query, f.entityId, f.periodos[8]);

async function paidBill(terms: string | null, opts: { apply?: boolean; status?: string } = {}): Promise<void> {
  const billId = uuidv4();
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
      total_amount, amount_due, currency_code, bill_date, due_date, status, terms, created_by)
     VALUES ($1,$2,$3,$4,500,80,580,580,'MXN',$5,$6,'approved',$7,$8)`,
    [billId, f.entityId, `BILL-125-${billId.slice(0, 6)}`, vendorId, fechaEnPeriodo(), fechaEnPeriodo(9), terms, f.userId]
  );
  const payId = uuidv4();
  await query(
    `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
      payment_method, payment_date, status, reversed_at, created_by)
     VALUES ($1,$2,$3,$4,580,'spei',$5,$6::text,CASE WHEN $6::text = 'reversed' THEN NOW() END,$7)`,
    [payId, f.entityId, `VPMT-125-${payId.slice(0, 6)}`, vendorId, fechaEnPeriodo(), opts.status ?? 'completed', f.userId]
  );
  if (opts.apply === false) return;
  await query(
    `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied) VALUES ($1,$2,$3,580)`,
    [uuidv4(), payId, billId]
  );
}

async function collectedInvoice(cfdiMethod: 'PUE' | 'PPD' | null): Promise<void> {
  const invId = uuidv4();
  const cfdiUuid = cfdiMethod ? uuidv4().toUpperCase() : null;
  if (cfdiUuid) {
    await query(
      `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
         emisor_rfc, receptor_rfc, subtotal, total, moneda, total_iva_retenido, total_isr_retenido,
         metodo_pago, xml_content, xml_hash, import_source, processing_status)
       VALUES ($1,'cfdi_ingreso',$2,'4.0',$3,'XAXX010101000','ABC010101AA1',1000,1160,'MXN',0,0,
         $4,'<x/>',$2,'manual_upload','completed')`,
      [f.entityId, cfdiUuid, fechaEnPeriodo(), cfdiMethod]
    );
  }
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
      total_amount, amount_due, currency_code, invoice_date, due_date, status, cfdi_uuid, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$6,'sent',$7,$8)`,
    [invId, f.entityId, `INV-125-${invId.slice(0, 6)}`, customerId, fechaEnPeriodo(), fechaEnPeriodo(9), cfdiUuid, f.userId]
  );
  const payId = uuidv4();
  await query(
    `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount,
      payment_method, payment_date, status, created_by)
     VALUES ($1,$2,$3,$4,1160,'spei',$5,'completed',$6)`,
    [payId, f.entityId, `PMT-125-${payId.slice(0, 6)}`, customerId, fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied) VALUES ($1,$2,$3,1160)`,
    [uuidv4(), payId, invId]
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-125 REP false alerts');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
      payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 125','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [vendorId, f.entityId, `V-125-${vendorId.slice(0, 8)}`, f.userId]
  );
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type,
      payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente 125','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [customerId, f.entityId, `C-125-${customerId.slice(0, 8)}`, f.userId]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('which payments of the period await a REP (MNE-001-125)', () => {
  it('none of the cases that take no REP is counted', async () => {
    await paidBill('PUE');                               // PUE bill: IVA went to 1130 at issuance
    await paidBill(null, { apply: false });              // unapplied: an advance, not a REP
    await paidBill(null, { status: 'reversed' });        // bounced: the IVA went back to 1135
    await collectedInvoice(null);                        // unstamped invoice: no CFDI to relate a REP to
    await collectedInvoice('PUE');                       // stamped PUE invoice
    expect(await count()).toEqual({ received: 0, issued: 0 });
  });

  it('a paid PPD bill and a collected stamped PPD invoice are counted', async () => {
    await paidBill('PPD');
    await paidBill(null);                                // no method stated: the ledger treated it as PPD
    await collectedInvoice('PPD');
    expect(await count()).toEqual({ received: 2, issued: 1 });
  });

  it('the checklist says the payment already moved the IVA to 1130, never that it sits in 1135', async () => {
    const status = await getPeriodCloseStatus(f.periodos[8], f.entityId);
    const repMissing = status.checklist.find((c) => c.codigo === 'rep-missing');
    expect(repMissing?.is_complete).toBe(false);
    expect(repMissing?.details).toMatch(/^2 pago\(s\) sin REP del proveedor, 1 cobro\(s\)/);
    const supplier = status.warnings.find((w) => /pago\(s\) a proveedor/.test(w));
    expect(supplier).toMatch(/^2 .*1130/);
    expect(supplier).not.toMatch(/1135/);
    expect(status.warnings.some((w) => /^1 cobro\(s\) sin REP emitido/.test(w))).toBe(true);
  });
});
