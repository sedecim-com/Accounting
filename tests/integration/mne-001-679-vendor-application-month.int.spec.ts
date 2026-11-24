import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordVendorPayment, applyVendorPayment } from '../../src/services/payments/payment-service.js';
import { conciliarCheque } from '../../src/services/banking/treasury-posting.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { construirDiot } from '../../src/services/sat/diot/diot-service.js';

/**
 * MNE-001-679 (#787, part 3/3) · THE DIOT AND THE IVA WORKPAPER COUNT A VENDOR
 * APPLICATION IN THE MONTH OF ITS STORED DAY.
 *
 * Cash paid to a vendor on account and applied to its bill later credits the
 * bill's VAT the day it is applied (LIVA art. 5o. fr. III and 1o.-B). Since
 * MNE-001-678 that day is stored (`payment_applications.applied_on`) and dates
 * the entry; here the DIOT (LIVA art. 32 fr. VIII) and the workpaper read it,
 * so the three land in one month and `IVA-WP-CREDITABLE-VS-LEDGER` is silent.
 *
 * Every bill is 1,000.00 + 160.00 = 1,160.00 with its VAT parked in 1135,
 * dated 2026-03-10; every payment is dated 2026-03-20, 1,160.00 unless told.
 * The figures are worked by hand in each case. All data is synthetic.
 */

let f: Fixture;
let bank: string;
let vendorId: string;
const BILLED = '2026-03-10';
const PAID = '2026-03-20';
const CASHED = '2026-04-03';

/** A Mexican entity of its own, with one vendor and one MXN account: the helpers below read the three. */
async function entity(name: string): Promise<void> {
  f = await crearInquilino(name);
  await seedPolicies({ tenantId: f.tenantId });
  bank = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Cheques','Banco',$3,'MXN','checking')`,
    [bank, f.entityId, f.roles.banco]
  );
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-679', 'Synthetic Late Vendor SA', 'SIN060101AB1', 'rfc', 'MXN', $3)`,
    [vendorId, f.entityId, f.userId]
  );
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** A posted bill of 1,000.00 + 160.00 dated `day`, its VAT parked in 1135. */
async function bill(method: 'PPD' | 'PUE' = 'PPD', day = BILLED): Promise<string> {
  return (await seedBill(f, { vendorId, method, vatCode: '1135', date: day })).id;
}

/** `amount` paid on 2026-03-20: on account, or against `billId` when one is given. */
async function pay(method: 'spei' | 'check', billId?: string, amount = '1160.00'): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: PAID,
      paymentMethod: method, bankAccountId: bank,
      ...(method === 'check' ? { checkNumber: uuidv4().slice(0, 6) } : {}),
      ...(billId
        ? { applications: [{ documentId: billId, amountApplied: amount }] }
        : { applications: [], onAccount: true }),
    },
    f.userId
  );
  return r.paymentId;
}

/** The payment's own entry. */
async function ownEntry(paymentId: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT journal_entry_id AS id FROM vendor_payments WHERE id = $1 AND entity_id = $2`, [paymentId, f.entityId]
  );
  return r.rows[0].id;
}

/** `payment apply --date`: the id of the application's entry. */
async function apply(paymentId: string, billId: string, date: string, amount = '1160.00'): Promise<string> {
  const r = await applyVendorPayment(f.entityId, paymentId, [{ documentId: billId, amountApplied: amount }], f.userId, { date });
  if (!r.journalEntry) throw new Error('the application posted no entry');
  return r.journalEntry.id;
}

/** The bank's charge of 2026-04-03 and the cashing recorded against it: the cashing entry's id, if it posted one. */
async function cash(paymentId: string): Promise<string | null> {
  const tx = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1,$2,$3::date,-1160,'debit','cheque',false)`,
    [tx, bank, CASHED]
  );
  return (await conciliarCheque(f.entityId, paymentId, { transactionId: tx, userId: f.userId })).entryId;
}

/** What one month's paper and DIOT say of one bill. */
async function month(m: number, billId: string) {
  const scope = { tenantId: f.tenantId, entityId: f.entityId };
  const wp = await buildIvaWorkpaper({ ...scope, year: 2026, month: m });
  const diot = await construirDiot({ ...scope, anio: 2026, mes: m });
  const inPaper = wp.contributions.creditable.find((c) => c.documentId === billId);
  const inDiot = diot.renglones.flatMap((r) => r.documentos).find((d) => d.billId === billId);
  return {
    paper: inPaper ? `${inPaper.breakdown.tasa16.base} / ${inPaper.breakdown.tasa16.iva}` : null,
    diot: inDiot ? `${inDiot.desglose.tasa16.base} / ${inDiot.desglose.tasa16.iva}` : null,
    entries: inPaper?.entryIds ?? [],
    tieOut: wp.findings.filter((h) => h.codigo === 'IVA-WP-CREDITABLE-VS-LEDGER').map((h) => h.mensaje),
    notices: (code: string) => diot.hallazgos.filter((h) => h.codigo === code && h.documentId === billId).map((h) => h.mensaje),
  };
}
const NOTHING = { paper: null, diot: null };
const WHOLE = { paper: '1000.0000 / 160.0000', diot: '1000.0000 / 160.0000' };
// 580.00 of 1,160.00 is half the bill: 1,000.00 × 580 / 1,160 = 500.00 and 160.00 × 580 / 1,160 = 80.00.
const HALF = { paper: '500.0000 / 80.0000', diot: '500.0000 / 80.0000' };
const figures = (x: { paper: string | null; diot: string | null }) => ({ paper: x.paper, diot: x.diot });

describe('a vendor application counts in the month of its stored day', () => {
  // The paper's tie-out reads the whole entity's 1130: every case here leaves the ledger and the paper agreeing.
  beforeAll(() => entity('MNE-001-679 vendor application month'), 240_000);

  it('T1 · the issue\'s example: paid on March 20th, applied on May 10th, declared in May and traced to the application\'s entry', async () => {
    const billId = await bill();
    const applied = await apply(await pay('spei'), billId, '2026-05-10');

    const [march, april, may] = [await month(3, billId), await month(4, billId), await month(5, billId)];
    expect([figures(march), figures(april)]).toEqual([NOTHING, NOTHING]);
    expect(figures(may)).toEqual(WHOLE);
    expect(may.entries).toEqual([applied]);
    expect([march.tieOut, april.tieOut, may.tieOut], 'the ledger debits 1130 in May only, and so does the paper').toEqual([[], [], []]);
  }, 180_000);

  it('T2 · two applications of one payment, April 10th and May 10th: 500.00 / 80.00 in each month, each traced to its own entry', async () => {
    const billId = await bill();
    const paymentId = await pay('spei');
    const first = await apply(paymentId, billId, '2026-04-10', '580.00');
    const second = await apply(paymentId, billId, '2026-05-10', '580.00');

    const [march, april, may] = [await month(3, billId), await month(4, billId), await month(5, billId)];
    expect(figures(march)).toEqual(NOTHING);
    expect([figures(april), april.entries]).toEqual([HALF, [first]]);
    expect([figures(may), may.entries]).toEqual([HALF, [second]]);
    expect([march.tieOut, april.tieOut, may.tieOut]).toEqual([[], [], []]);
  }, 180_000);

  it('T3 · half paid with the payment in March and half from cash on account in May: each month traces only the entry that credited it', async () => {
    const billId = await bill();
    const direct = await pay('spei', billId, '580.00');
    const applied = await apply(await pay('spei', undefined, '580.00'), billId, '2026-05-10', '580.00');

    const [march, may] = [await month(3, billId), await month(5, billId)];
    expect([figures(march), march.entries], 'not the entry of the cash still on account in March').toEqual([HALF, [await ownEntry(direct)]]);
    expect([figures(may), may.entries]).toEqual([HALF, [applied]]);
    expect([march.tieOut, may.tieOut]).toEqual([[], []]);
  }, 180_000);

  it('T4 · a cheque the bank cashed on April 3rd, applied on May 10th: May declares it, on the later of the two days', async () => {
    const billId = await bill();
    const paymentId = await pay('check');
    expect(await cash(paymentId), 'on account, the cheque holds no VAT: its cashing posts nothing').toBeNull();
    const applied = await apply(paymentId, billId, '2026-05-10');

    const [april, may] = [await month(4, billId), await month(5, billId)];
    expect(figures(april)).toEqual(NOTHING);
    expect([figures(may), may.entries]).toEqual([WHOLE, [applied]]);
    expect([april.tieOut, may.tieOut]).toEqual([[], []]);
  }, 180_000);

  it('T5 · a cheque applied on March 25th, before the bank cashed it: April declares it on the cashing day, as it did', async () => {
    const billId = await bill();
    const paymentId = await pay('check');
    await apply(paymentId, billId, '2026-03-25');
    const cashing = await cash(paymentId);

    const [march, april, may] = [await month(3, billId), await month(4, billId), await month(5, billId)];
    expect([figures(march), figures(may)]).toEqual([NOTHING, NOTHING]);
    expect([figures(april), april.entries]).toEqual([WHOLE, [cashing]]);
    expect([march.tieOut, april.tieOut, may.tieOut]).toEqual([[], [], []]);
  }, 180_000);

  it('T6 · a cheque nobody cashed counts in no month, whatever day it was applied on', async () => {
    const billId = await bill();
    await apply(await pay('check'), billId, '2026-04-15');

    for (const m of [3, 4, 5]) {
      const r = await month(m, billId);
      expect(figures(r), `month ${m}`).toEqual(NOTHING);
      expect(r.tieOut, `month ${m}`).toEqual([]);
    }
  }, 180_000);

  it('T7 · a PUE whose VAT waits for its payment: March says nothing was applied by its end, and May declares it', async () => {
    const billId = await bill('PUE');
    await apply(await pay('spei'), billId, '2026-05-10');

    const march = await month(3, billId);
    expect(figures(march)).toEqual(NOTHING);
    const waits = march.notices('DIOT-PUE-ESPERA-PAGO');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain('tiene aplicado 0.0000 de 1160.0000');
    const may = await month(5, billId);
    expect(figures(may)).toEqual(WHOLE);
    expect([march.tieOut, may.tieOut]).toEqual([[], []]);
  }, 180_000);
});

describe('a row with no stored day reads its payment\'s date, so no month already shown moves', () => {
  beforeAll(() => entity('MNE-001-679 rows before the stored day'), 240_000);

  /** The row as every writer left it before MNE-001-678. */
  const forget = (paymentId: string) =>
    query(`UPDATE payment_applications SET applied_on = NULL WHERE payment_id = $1`, [paymentId]);

  it('T8 · `payment create` against its bill: March declares it with the day stored and with none', async () => {
    const billId = await bill();
    const paymentId = await pay('spei', billId);

    const stored = await month(3, billId);
    await forget(paymentId);
    const none = await month(3, billId);
    for (const r of [stored, none]) {
      expect(figures(r)).toEqual(WHOLE);
      expect(r.entries).toEqual([await ownEntry(paymentId)]);
      expect(r.tieOut).toEqual([]);
    }
  }, 180_000);

  it('T9 · a late application whose row stored no day stays in its payment\'s month, as both papers showed it', async () => {
    const billId = await bill();
    const paymentId = await pay('spei');
    await apply(paymentId, billId, '2026-05-10');
    await forget(paymentId);

    const [march, may] = [await month(3, billId), await month(5, billId)];
    expect([figures(march), march.entries]).toEqual([WHOLE, [await ownEntry(paymentId)]]);
    expect(figures(may)).toEqual(NOTHING);
    // The ledger debited 1130 in May: the tie-out names the 160.00 in both months, as it did before the day was stored.
    expect([march.tieOut.length, may.tieOut.length]).toEqual([1, 1]);
  }, 180_000);
});
