import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { listPaymentsAwaitingRep } from '../../src/services/accounting/rep-expected.js';
import { listPagosSinRep } from '../../src/services/xml-ingestion/rep-pendientes.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment, unapplyVendorPayment } from '../../src/services/payments/payment-service.js';

/**
 * MNE-001-125 (#327): the close checklist without false REP alerts, against
 * real Postgres. Every case builds its own tenant, so each `it` runs alone,
 * and every case checks that the box, `closing explain rep-missing` and the
 * shared list agree.
 */

interface World {
  f: Fixture;
  vendorId: string;
  customerId: string;
}

async function world(name: string): Promise<World> {
  const f = await crearInquilino(`MNE-001-125 ${name}`);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
      payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 125','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [vendorId, f.entityId, `V-125-${vendorId.slice(0, 8)}`, f.userId]
  );
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type,
      payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente 125','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [customerId, f.entityId, `C-125-${customerId.slice(0, 8)}`, f.userId]
  );
  return { f, vendorId, customerId };
}

async function count(w: World): Promise<{ received: number; issued: number }> {
  const { awaiting } = await listPaymentsAwaitingRep(query, w.f.entityId, { periodId: w.f.periodos[8] });
  return {
    received: awaiting.filter((p) => p.direction === 'received').length,
    issued: awaiting.filter((p) => p.direction === 'issued').length,
  };
}

/** The box and its explain output must list the same number of payments. */
async function expectExplainMatchesBox(w: World): Promise<number> {
  const status = await getPeriodCloseStatus(w.f.periodos[8], w.f.entityId);
  const box = status.checklist.find((c) => c.codigo === 'rep-missing');
  const explained = await explainCloseCheck(w.f.entityId, w.f.periodos[8], 'rep-missing');
  const inBox = box?.details ? Number(/^(\d+)/.exec(box.details)![1]) + Number(/, (\d+) cobro/.exec(box.details)![1]) : 0;
  expect(box?.is_complete).toBe(explained.total === 0);
  expect(explained.total).toBe(inBox);
  return explained.total;
}

async function paidBill(w: World, terms: string | null, opts: { apply?: boolean; status?: string } = {}): Promise<void> {
  const { f, vendorId } = w;
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

/**
 * A collected invoice. `cfdiStatus` null = never stamped; otherwise it has a
 * uuid with that status. `mirrorMethod` null = the CFDI is not in the mirror.
 */
async function collectedInvoice(
  w: World,
  cfdiStatus: 'stamped' | 'failed' | 'cancelled' | null,
  mirrorMethod: 'PUE' | 'PPD' | null
): Promise<string> {
  const { f, customerId } = w;
  const invId = uuidv4();
  const cfdiUuid = cfdiStatus ? uuidv4().toUpperCase() : null;
  if (cfdiUuid && mirrorMethod) {
    await query(
      `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
         emisor_rfc, receptor_rfc, subtotal, total, moneda, total_iva_retenido, total_isr_retenido,
         metodo_pago, xml_content, xml_hash, import_source, processing_status)
       VALUES ($1,'cfdi_ingreso',$2,'4.0',$3,'XAXX010101000','ABC010101AA1',1000,1160,'MXN',0,0,
         $4,'<x/>',$2,'manual_upload','completed')`,
      [f.entityId, cfdiUuid, fechaEnPeriodo(), mirrorMethod]
    );
  }
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
      total_amount, amount_due, currency_code, invoice_date, due_date, status, cfdi_uuid, cfdi_status, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$6,'sent',$7,$8,$9)`,
    [invId, f.entityId, `INV-125-${invId.slice(0, 6)}`, customerId, fechaEnPeriodo(), fechaEnPeriodo(9), cfdiUuid, cfdiStatus, f.userId]
  );
  const payId = uuidv4();
  const paymentNumber = `PMT-125-${payId.slice(0, 6)}`;
  await query(
    `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount,
      payment_method, payment_date, status, created_by)
     VALUES ($1,$2,$3,$4,1160,'spei',$5,'completed',$6)`,
    [payId, f.entityId, paymentNumber, customerId, fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied) VALUES ($1,$2,$3,1160)`,
    [uuidv4(), payId, invId]
  );
  return paymentNumber;
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('which payments of the period await a REP (MNE-001-125)', () => {
  it('none of the cases that take no REP is counted, and closing explain lists none', async () => {
    const w = await world('none');
    await paidBill(w, 'PUE');                          // PUE bill: IVA credited at issuance
    await paidBill(w, null, { apply: false });         // unapplied: an advance, not a REP
    await paidBill(w, null, { status: 'reversed' });   // bounced: the IVA went back to 1135
    await collectedInvoice(w, null, null);             // unstamped invoice: no CFDI to relate a REP to
    await collectedInvoice(w, 'stamped', 'PUE');       // stamped PUE invoice
    await collectedInvoice(w, 'failed', 'PPD');        // simulated stamp: a uuid, but no live CFDI
    await collectedInvoice(w, 'cancelled', 'PPD');     // cancelled CFDI keeps its uuid
    expect(await count(w)).toEqual({ received: 0, issued: 0 });
    expect(await expectExplainMatchesBox(w)).toBe(0);
  }, 120_000);

  it('a paid PPD bill and a collected stamped PPD invoice are counted, the same in the box and in explain', async () => {
    const w = await world('counted');
    await paidBill(w, 'PPD');
    await paidBill(w, null);                           // no method stated: the ledger treated it as PPD
    await collectedInvoice(w, 'stamped', 'PPD');
    await collectedInvoice(w, 'stamped', 'PUE');       // false alert that must stay out of explain too
    expect(await count(w)).toEqual({ received: 2, issued: 1 });
    expect(await expectExplainMatchesBox(w)).toBe(3);

    const status = await getPeriodCloseStatus(w.f.periodos[8], w.f.entityId);
    const box = status.checklist.find((c) => c.codigo === 'rep-missing');
    expect(box?.details).toMatch(/^2 pago\(s\) sin REP del proveedor, 1 cobro\(s\)/);
    expect(status.warnings.some((w) => /^1 cobro\(s\) sin REP emitido/.test(w))).toBe(true);
  }, 120_000);

  it('a stamped invoice with no method anywhere follows the ledger (PUE): not counted, but the doubt is said and listed', async () => {
    const w = await world('unknown method');
    const doubtful = await collectedInvoice(w, 'stamped', null);   // stamped through the API: no mirror, no token
    expect(await count(w)).toEqual({ received: 0, issued: 0 });
    expect(await expectExplainMatchesBox(w)).toBe(0);

    const status = await getPeriodCloseStatus(w.f.periodos[8], w.f.entityId);
    expect(status.warnings.some((x) => /cobro\(s\) sin REP emitido/.test(x))).toBe(false);
    expect(status.warnings.find((x) => /sin método de pago conocido/.test(x))).toMatch(/^1 .*PUE/);

    const listed = await listPagosSinRep(w.f.entityId, { direction: 'issued' });
    expect(listed.map((r) => [r.payment_number, r.metodo])).toEqual([[doubtful, 'desconocido']]);
  }, 120_000);

  it("with rep_faltante_recibido='no_vigilar' the supplier side leaves the box and explain alike", async () => {
    const w = await world('no watch');
    await paidBill(w, 'PPD');
    await collectedInvoice(w, 'stamped', 'PPD');
    await resolvePolicy({ tenantId: w.f.tenantId, entityId: w.f.entityId }, 'rep_faltante_recibido', 'no_vigilar', 'victor@test');
    expect(await expectExplainMatchesBox(w)).toBe(1);
    const status = await getPeriodCloseStatus(w.f.periodos[8], w.f.entityId);
    expect(status.warnings.some((x) => /pago\(s\) a proveedor/.test(x))).toBe(false);
    // The list is not a close item: it still names the supplier payment.
    expect(await listPagosSinRep(w.f.entityId, { direction: 'received' })).toHaveLength(1);
  }, 120_000);
});

describe('end to end: a PPD bill paid through the payment service (MNE-001-125)', () => {
  it('the payment moves the IVA 1135 → 1130, the checklist names the missing REP without claiming 1135, and an unapply takes it out', async () => {
    const w = await world('e2e');
    const { f, vendorId } = w;
    const billId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number,
         subtotal, tax_amount, total_amount, amount_due, amount_paid,
         currency_code, bill_date, due_date, status, created_by, terms)
       VALUES ($1,$2,'BILL-125-E2E',$3,'CFDI-125-E2E',1000,160,1160,1160,0,'MXN','2026-08-10','2026-08-10','draft',$4,'PPD')`,
      [billId, f.entityId, vendorId, f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Servicio a credito',1,1000,1000,160,1160)`,
      [uuidv4(), billId, f.cuentas['6100']]
    );
    await approveBill(billId, f.userId, { entityId: f.entityId });
    const period = f.periodos[8];
    expect(await saldoDe(f.cuentas['1135'], period), 'a PPD bill parks its IVA').toBeCloseTo(160, 2);
    expect(await saldoDe(f.cuentas['1130'], period)).toBeCloseTo(0, 2);

    const paid = await recordVendorPayment(
      {
        entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: '2026-08-15',
        paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: '1160.00' }],
      },
      f.userId
    );
    expect(await saldoDe(f.cuentas['1135'], period), 'the payment releases the parked IVA').toBeCloseTo(0, 2);
    expect(await saldoDe(f.cuentas['1130'], period), '…into creditable IVA').toBeCloseTo(160, 2);

    expect(await count(w)).toEqual({ received: 1, issued: 0 });
    expect(await expectExplainMatchesBox(w)).toBe(1);
    const status = await getPeriodCloseStatus(period, f.entityId);
    const supplier = status.warnings.find((x) => /pago\(s\) a proveedor/.test(x));
    expect(supplier).toMatch(/^1 .*acreditamiento del IVA/);
    expect(supplier).not.toMatch(/1135|aparcado/);

    await unapplyVendorPayment(f.entityId, paid.paymentId, { billId, reason: 'Aplicado por error', date: '2026-08-20' }, f.userId);
    const closed = await query<{ unapplied_at: string | null }>(
      `SELECT unapplied_at::text FROM payment_applications WHERE payment_id = $1`, [paid.paymentId]
    );
    expect(closed.rows[0].unapplied_at).not.toBeNull();
    expect(await count(w), 'a closed application settles nothing').toEqual({ received: 0, issued: 0 });
    expect(await expectExplainMatchesBox(w)).toBe(0);
  }, 180_000);
});
