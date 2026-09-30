import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { seedLegalParameters } from '../../src/services/jurisdiction/legal-parameters-seed.js';
import { cashLimitFinding } from '../../src/services/ap/cash-deductibility.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';

/**
 * MNE-001-345 · LISR art. 27 fr. III outside the ingestion: a bill paid in cash
 * above the limit in force ON THE PAYMENT DATE is signalled at `bill approve`
 * (from its CFDI's FormaPago) and at the payment (`--method cash`). The limit
 * comes from legal_parameters, never from a constant.
 */

import { apartarCatalogos } from './helpers/catalogos-globales.js';

apartarCatalogos('legal_parameters');

let f: Fixture;
const DAY = '2026-08-15';
const FUTURE_KEY = 'income_tax.cash_payment_deduction_limit';

beforeAll(async () => {
  await seedLegalParameters();
  f = await crearInquilino('MNE-001-345');
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function draftBill(fx: Fixture, total: string, cfdiUuid: string | null = null, currency = 'MXN') {
  const billId = uuidv4();
  const vendorId = uuidv4();
  const tag = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 345','CCC030303CC3','rfc',$4,$5)`,
    [vendorId, fx.entityId, `V-${tag}`, currency, fx.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, cfdi_uuid)
     VALUES ($1,$2,$3,$4,$5,$6,0,$6,$6,0,$7,$8,$8,'draft',$9,$10)`,
    [billId, fx.entityId, `BILL-${tag}`, vendorId, `INV-${tag}`, total, currency, DAY, fx.userId, cfdiUuid]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,$4,$4,0,$4)`,
    [uuidv4(), billId, fx.cuentas['6100'], total]
  );
  return { billId, vendorId };
}

async function xmlWithPaymentForm(fx: Fixture, uuid: string, paymentForm: string, total: string) {
  await query(
    `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, moneda, forma_pago, metodo_pago,
       xml_content, xml_hash, import_source, processing_status)
     VALUES ($1,'cfdi_ingreso',$2,'4.0',$3,'CCC030303CC3','XAXX010101000',$4,$4,'MXN',$5,'PUE',
       '<x/>',$2,'manual_upload','completed')`,
    [fx.entityId, uuid, DAY, total, paymentForm]
  );
}

async function approvedBill(fx: Fixture, total: string) {
  const b = await draftBill(fx, total);
  await approveBill(b.billId, fx.userId, { entityId: fx.entityId });
  return b;
}

function pay(fx: Fixture, b: { billId: string; vendorId: string }, amount: string, method: string, date = DAY) {
  return recordVendorPayment(
    {
      entityId: fx.entityId, counterpartyId: b.vendorId, paymentAmount: amount, paymentDate: date,
      paymentMethod: method, applications: [{ documentId: b.billId, amountApplied: amount }],
    },
    fx.userId
  );
}

describe('payment --method cash', () => {
  it('signals a cash payment above the limit in force on the payment date and leaves the entry alone', async () => {
    const b = await approvedBill(f, '2500.00');
    const r = await pay(f, b, '2500.00', 'cash');
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings![0]).toMatchObject({ code: 'cash_over_limit_not_deductible', amount: '2500.00', limit: '2000.00', onDate: DAY });
    expect(r.journalEntry).not.toBeNull();
  });

  it('does not signal the limit itself, a smaller cash payment, or a transfer of any size', async () => {
    const exact = await pay(f, await approvedBill(f, '2000.00'), '2000.00', 'cash');
    expect(exact.deductibilityFindings, 'the law says exceeds: exactly the limit is deductible').toEqual([]);
    const spei = await pay(f, await approvedBill(f, '9000.00'), '9000.00', 'spei');
    expect(spei.deductibilityFindings).toEqual([]);
  });

  it('reads the limit by the PAYMENT date: a later vigencia changes the answer', async () => {
    await query(
      `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
       VALUES ('MX',$1,'2026-09-01','10000.0000','MXN','https://example.test/fixture','test vigencia')`,
      [FUTURE_KEY]
    );
    try {
      const later = await pay(f, await approvedBill(f, '5000.00'), '5000.00', 'cash', '2026-09-10');
      expect(later.deductibilityFindings, '5,000 is under the 2026-09 limit of 10,000').toEqual([]);
      const before = await pay(f, await approvedBill(f, '5000.00'), '5000.00', 'cash', DAY);
      expect(before.deductibilityFindings).toHaveLength(1);
    } finally {
      await query(`DELETE FROM legal_parameters WHERE key = $1 AND effective_from = '2026-09-01'`, [FUTURE_KEY]);
    }
  });

  it('fails closed when no vigencia covers the payment date', async () => {
    // Direct call: a 2010 payment would be stopped earlier by the closed period.
    await expect(
      withTransaction((client) =>
        cashLimitFinding(client, { entityId: f.entityId, billNumber: 'B-1', amount: '5000.00', currency: 'MXN', onDate: '2010-01-01' })
      )
    ).rejects.toMatchObject({ gap: 'not_yet_in_force' });
  });
});

describe('bill approve', () => {
  it('signals a bill whose CFDI says cash (FormaPago 01) above the limit', async () => {
    const uuid = uuidv4();
    await xmlWithPaymentForm(f, uuid, '01', '4000.00');
    const b = await draftBill(f, '4000.00', uuid);
    const r = await approveBill(b.billId, f.userId, { entityId: f.entityId });
    expect(r.deductibilityFindings).toHaveLength(1);
    expect(r.deductibilityFindings[0]).toMatchObject({ amount: '4000.00', limit: '2000.00', onDate: DAY });
    expect(r.entry).not.toBeNull();
  });

  it('does not judge an entity under US law', async () => {
    const us = await crearInquilino('MNE-001-345 US', { pais: 'US' });
    const uuid = uuidv4();
    await xmlWithPaymentForm(us, uuid, '01', '4000.00');
    const b = await draftBill(us, '4000.00', uuid, 'USD');
    const r = await approveBill(b.billId, us.userId, { entityId: us.entityId });
    expect(r.deductibilityFindings).toEqual([]);
  });

  it('is silent for a transfer CFDI, for cash under the limit and for a bill with no CFDI', async () => {
    const t = uuidv4();
    await xmlWithPaymentForm(f, t, '03', '4000.00');
    const transfer = await approveBill((await draftBill(f, '4000.00', t)).billId, f.userId, { entityId: f.entityId });
    expect(transfer.deductibilityFindings).toEqual([]);
    const c = uuidv4();
    await xmlWithPaymentForm(f, c, '01', '1500.00');
    const small = await approveBill((await draftBill(f, '1500.00', c)).billId, f.userId, { entityId: f.entityId });
    expect(small.deductibilityFindings).toEqual([]);
    const none = await approveBill((await draftBill(f, '4000.00')).billId, f.userId, { entityId: f.entityId });
    expect(none.deductibilityFindings).toEqual([]);
  });
});
