import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../../src/services/xml-ingestion/received-credit-note.js';

// ============================================================
// MNE-001-492 (#693, part 2/3), PR 1 · THE READERS OF A PARKED PUE
//
// No door parks a PUE's VAT yet, so every bill here is seeded by hand: a
// received bill of 1,160.00 (1,000.00 + 160.00) dated 2026-03-12.
//
//   waiting  · PUE on 1135, unpaid at 03-31, paid 2026-04-08
//   partial  · PUE on 1135, 580.00 paid on 2026-03-20
//   settled  · PUE on 1135, paid in full on 2026-03-25
//   credited · PUE on 1135, credited in full by a note's entry on 2026-04-10
//   legacy   · PUE on 1130, unpaid
//   ppd      · PPD on 1135, unpaid
//   cheque   · PUE on 1135, paid in full by a cheque signed 2026-03-22 that the
//              bank has not cashed (MNE-001-559): it has paid nothing yet
// ============================================================

const WAITS = 'DIOT-PUE-ESPERA-PAGO';
type Diot = Awaited<ReturnType<typeof construirDiot>>;

let f: Fixture;
let vendorId: string;
const bills: Record<string, string> = {};
let marchBeforeApril: Diot, march: Diot, april: Diot;

const diot = (month: number) => construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month });
const vatOf = (d: Diot, billId: string) =>
  d.renglones.flatMap((r) => r.documentos).find((doc) => doc.billId === billId)?.desglose.tasa16.iva;
const codesOf = (d: Diot, billId: string) => d.hallazgos.filter((h) => h.documentId === billId).map((h) => h.codigo);

async function pay(billId: string, amount: string, date: string): Promise<void> {
  await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: date, paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: amount }],
    },
    f.userId
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-492 received PUE readers');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-492', 'Servicios Integrales SA', 'SIN060101AB1', 'rfc', 'MXN', $3)`,
    [vendorId, f.entityId, f.userId]
  );
  const seed = async (method: 'PUE' | 'PPD', vatCode: '1130' | '1135') =>
    (await seedBill(f, { vendorId, method, vatCode, date: '2026-03-12' })).id;
  for (const name of ['waiting', 'partial', 'settled', 'credited']) bills[name] = await seed('PUE', '1135');
  bills.legacy = await seed('PUE', '1130');
  bills.ppd = await seed('PPD', '1135');
  bills.cheque = await seed('PUE', '1135');

  await pay(bills.partial, '580.00', '2026-03-20');
  await pay(bills.settled, '1160.00', '2026-03-25');
  await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: '2026-03-22',
      paymentMethod: 'check', checkNumber: 'CH-492',
      applications: [{ documentId: bills.cheque, amountApplied: '1160.00' }],
    },
    f.userId
  );
  marchBeforeApril = await diot(3);

  await pay(bills.waiting, '1160.00', '2026-04-08');
  // The entry a received credit note posts (MNE-001-555): the bill as its source, its VAT out of 1135.
  await createJournalEntry(
    f.entityId, '2026-04-10', JournalEntryType.AUTO_BILL, 'Credit note on the whole bill',
    [
      { account_id: f.cuentas['2110'], debit_amount: '1160.00', credit_amount: null, description: 'Vendors' },
      { account_id: f.cuentas['1135'], debit_amount: null, credit_amount: '160.00', description: 'VAT' },
      { account_id: f.cuentas['6100'], debit_amount: null, credit_amount: '1000.00', description: 'Expense' },
    ],
    f.userId,
    { autoPost: true, sourceType: VENDOR_CREDIT_NOTE_SOURCE, sourceId: bills.credited }
  );
  [march, april] = [await diot(3), await diot(4)];
}, 300_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a PUE whose VAT waits in 1135 at the end of its month', () => {
  it('T6 · March leaves it out, built before or after its April payment, and a notice says its VAT waits', () => {
    for (const built of [marchBeforeApril, march]) {
      expect(vatOf(built, bills.waiting)).toBeUndefined();
      expect(codesOf(built, bills.waiting)).toEqual([WAITS]);
    }
    const notice = march.hallazgos.find((h) => h.documentId === bills.waiting);
    expect(notice?.severidad).toBe('aviso');
    expect(notice?.mensaje).toMatch(/espera/);
    expect(notice?.mensaje).toMatch(/2\.7\.1\.39/);
    expect(notice?.mensaje).toMatch(/17/);
    expect(vatOf(april, bills.waiting)).toBe('160.0000');
    expect(codesOf(april, bills.waiting)).toEqual([]);
  });

  it('paid in part, March declares what it paid and the notice names what is applied', () => {
    expect(vatOf(march, bills.partial)).toBe('80.0000');
    expect(march.hallazgos.find((h) => h.documentId === bills.partial && h.codigo === WAITS)?.mensaje).toMatch(/580\.00/);
  });

  it('the notice is only for a parked PUE that is not paid in full', () => {
    expect(vatOf(march, bills.settled)).toBe('160.0000');
    expect(codesOf(march, bills.settled)).toEqual([]);
    expect(codesOf(march, bills.legacy)).toEqual(['DIOT-PUE-SIN-PAGO']);
    expect(codesOf(march, bills.ppd)).toEqual([]);
  });

  it('T8 · credited in full by a note in April, it has no row in March or in April', () => {
    expect(vatOf(marchBeforeApril, bills.credited)).toBeUndefined();
    expect(vatOf(march, bills.credited)).toBeUndefined();
    expect(vatOf(april, bills.credited)).toBeUndefined();
    // It was unpaid when March ended, and March says so whenever it is built.
    expect(codesOf(march, bills.credited)).toEqual([WAITS]);
  });
});

describe('a PUE paid by a cheque the bank has not cashed (MNE-001-559)', () => {
  it('counts as unpaid: March declares none of its VAT and both notices say why', () => {
    expect(vatOf(march, bills.cheque)).toBeUndefined();
    expect(codesOf(march, bills.cheque)).toContain(WAITS);
    expect(codesOf(march, bills.cheque)).toContain('DIOT-CHEQUE-NOT-CASHED');
  });
});
