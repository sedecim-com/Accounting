import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase, getClient } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import {
  applyVendorPayment, recordVendorPayment, reverseVendorPayment, unapplyVendorPayment,
} from '../../src/services/payments/payment-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../../src/services/xml-ingestion/received-credit-note.js';
import { PreRegistrationService, registrarFacturaDeBorradorAprobado, type ApprovedLine } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { conciliarCheque } from '../../src/services/banking/treasury-posting.js';

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
//
// PR 2 · THE DOORS PARK IT (second tenant, at the end): the fixture CFDI posted
// by `bill inbox run`'s service, typed bills approved with `bill approve`'s,
// and drafts approved through the door the agent's drafts go through.
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

  await pay(bills.partial, '580.00', '2026-03-20');
  await pay(bills.settled, '1160.00', '2026-03-25');
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

// ============================================================
// PR 2 · EVERY DOOR PARKS A RECEIVED PUE'S VAT IN 1135, AND ITS PAYMENT RELEASES IT
//
//   whole   · from its CFDI, 2026-03-12, paid in full on 2026-04-08
//   halves  · from its CFDI, 2026-03-12, 580.00 on 03-20 and 580.00 on 04-08
//   zero    · from its CFDI at 0 %, 2026-03-12, unpaid
//   typed   · typed PUE bills of 2026-05-12: applied from a payment on account,
//             unapplied, reversed, and paid by a cheque cashed in June
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8');
const CONCEPT_VAT = '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>';

describe('PR 2 · a received PUE posted by any door', () => {
  let g: Fixture;
  let gVendor: string;
  let bank: string;
  const svc = new PreRegistrationService();
  const doc: Record<string, { id: string; entry: string }> = {};
  const pays: Record<string, string> = {};
  let marchBefore: Diot, gMarch: Diot, gApril: Diot;
  let wpMarch: IvaWorkpaper, wpApril: IvaWorkpaper;

  const gDiot = (month: number) => construirDiot({ tenantId: g.tenantId, entityId: g.entityId, anio: 2026, mes: month });
  const fact = (d: Diot, billId: string) => d.renglones.flatMap((r) => r.documentos).find((x) => x.billId === billId);
  const xml = (rate: '16' | '0' = '16') => {
    const uuid = uuidv4().toUpperCase();
    const out = FIXTURE.replace('D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E', uuid).replace('Folio="1001"', `Folio="${uuid.slice(0, 8)}"`)
      .replace('ObjetoImp="02"/>', `ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${CONCEPT_VAT}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`)
      .replaceAll('2026-08-15', '2026-03-12');
    return rate === '16' ? out : out.replaceAll('TasaOCuota="0.160000" Importe="160.00"', 'TasaOCuota="0.000000" Importe="0.00"')
      .replace('Total="1160.00"', 'Total="1000.00"').replace('TotalImpuestosTrasladados="160.00"', 'TotalImpuestosTrasladados="0.00"');
  };
  const upload = (content: string) => svc.processXMLUpload(g.entityId, content, 'manual_upload', g.userId);
  async function fromCfdi(rate: '16' | '0' = '16') {
    const bill = (await svc.processToAccounting((await upload(xml(rate))).preRegistration, g.userId)).bill as { id: string };
    const { rows } = await query<{ entry: string }>(`SELECT journal_entry_id::text AS entry FROM bills WHERE id = $1`, [bill.id]);
    return { id: bill.id, entry: rows[0].entry };
  }
  async function typed() {
    const id = uuidv4();
    const tag = id.slice(0, 8);
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount, total_amount,
         amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
       VALUES ($1,$2,$3,$4,$5,1000,160,1160,1160,0,'MXN','2026-05-12','2026-05-12','draft',$6,'PUE')`,
      [id, g.entityId, `BILL-${tag}`, gVendor, `CFDI-${tag}`, g.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Servicio',1,1000,1000,160,1160)`,
      [uuidv4(), id, g.cuentas['6100']]
    );
    return { id, entry: (await approveBill(id, g.userId, { entityId: g.entityId })).entry!.id };
  }
  async function payG(billId: string | null, amount: string, date: string, method = 'spei') {
    return recordVendorPayment(
      { entityId: g.entityId, counterpartyId: gVendor, paymentAmount: amount, paymentDate: date, paymentMethod: method,
        ...(method === 'check' ? { bankAccountId: bank, checkNumber: uuidv4().slice(0, 6) } : {}),
        ...(billId ? { applications: [{ documentId: billId, amountApplied: amount }] } : { applications: [], onAccount: true }) },
      g.userId
    );
  }
  /** An entry's lines, or only its lines on 1130 and 1135, as `code debit/credit`. */
  async function linesOf(entryId: string, vatOnly = true): Promise<string[]> {
    const { rows } = await query<{ line: string }>(
      `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::numeric(19,2) || '/' || COALESCE(l.credit_amount, 0)::numeric(19,2) AS line
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = $1 AND (NOT $2 OR a.code IN ('1130', '1135')) ORDER BY a.code`,
      [entryId, vatOnly]
    );
    return rows.map((r) => r.line);
  }
  /** The approval of a draft of the fixture CFDI with these lines, rolled back: its error, if any. */
  async function approveDraft(approvedLines: ApprovedLine[]): Promise<unknown> {
    const up = await upload(xml());
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await registrarFacturaDeBorradorAprobado(client, {
        tenantId: g.tenantId, entityId: g.entityId, preRegistrationId: String(up.preRegistration.id),
        approvedLines, approvedDescription: 'Approved draft', userId: g.userId,
        accountIdByCode: new Map(Object.entries(g.cuentas)),
      });
      return undefined;
    } catch (e) {
      return e;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  beforeAll(async () => {
    g = await crearInquilino('MNE-001-492 received PUE doors');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    gVendor = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
       VALUES ($1, $2, 'V-492', 'Servicios Integrales SA', 'SIN060101AB1', 'rfc', 'MXN', $3, $4)`,
      [gVendor, g.entityId, g.userId, g.cuentas['6100']]
    );
    bank = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1,$2,'Cheques','Banco',$3,'MXN','checking')`,
      [bank, g.entityId, g.roles.banco]
    );
    doc.whole = await fromCfdi();
    doc.halves = await fromCfdi();
    doc.zero = await fromCfdi('0');
    pays.half1 = (await payG(doc.halves.id, '580.00', '2026-03-20')).journalEntry!.id;
    marchBefore = await gDiot(3);
    pays.whole = (await payG(doc.whole.id, '1160.00', '2026-04-08')).journalEntry!.id;
    pays.half2 = (await payG(doc.halves.id, '580.00', '2026-04-08')).journalEntry!.id;
    [gMarch, gApril] = [await gDiot(3), await gDiot(4)];
    wpMarch = await buildIvaWorkpaper({ tenantId: g.tenantId, entityId: g.entityId, year: 2026, month: 3 });
    wpApril = await buildIvaWorkpaper({ tenantId: g.tenantId, entityId: g.entityId, year: 2026, month: 4 });
  }, 300_000);

  it('T1 · from its CFDI and typed, the bill debits its VAT to 1135, saying it waits for the payment', async () => {
    doc.typed = await typed();
    for (const d of [doc.whole, doc.typed]) {
      expect(await linesOf(d.entry, false)).toEqual(['1135 160.00/0.00', '2110 0.00/1160.00', '6100 1000.00/0.00']);
      const { rows } = await query<{ text: string }>(
        `SELECT l.description AS text FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_entry_id = $1 AND a.code = '1135'`, [d.entry]
      );
      expect(rows[0].text).toMatch(/on payment/);
      expect(rows[0].text).not.toMatch(/on issuance/);
    }
  });

  it('T2 · paid in full on 2026-04-08: the payment releases 160.00, April declares it and the paper ties both months', async () => {
    expect(await linesOf(pays.whole)).toEqual(['1130 160.00/0.00', '1135 0.00/160.00']);
    expect(fact(gMarch, doc.whole.id)).toBeUndefined();
    expect(fact(gApril, doc.whole.id)?.desglose.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(wpMarch.ledger.iva_acreditable).toBe('80.0000');
    expect(wpApril.ledger.iva_acreditable).toBe('240.0000');
    for (const w of [wpMarch, wpApril]) expect(w.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
  });

  it('T3 · paid in two halves, each month credits 80.00 and 1135 ends at 0.00 for the bill', async () => {
    expect(await linesOf(pays.half1)).toEqual(['1130 80.00/0.00', '1135 0.00/80.00']);
    expect(await linesOf(pays.half2)).toEqual(['1130 80.00/0.00', '1135 0.00/80.00']);
    expect(fact(gMarch, doc.halves.id)?.desglose.tasa16.iva).toBe('80.0000');
    expect(fact(gApril, doc.halves.id)?.desglose.tasa16.iva).toBe('80.0000');
  });

  it('T6 · unpaid at 03-31, March leaves it out whenever it is built, and says its VAT waits', () => {
    for (const built of [marchBefore, gMarch]) {
      expect(fact(built, doc.whole.id)).toBeUndefined();
      expect(built.hallazgos.filter((h) => h.documentId === doc.whole.id).map((h) => h.codigo)).toEqual([WAITS]);
    }
  });

  it('T9 · at 0 % it parks nothing and stays a fact of its bill month', async () => {
    expect(await linesOf(doc.zero.entry)).toEqual([]);
    expect(fact(gMarch, doc.zero.id)).toBeDefined();
    expect(fact(gApril, doc.zero.id)).toBeUndefined();
  });

  it('T4 · 1,160.00 on account, applied with `payment apply`: DR 1130 160.00 / CR 1135 160.00', async () => {
    const b = await typed();
    const onAccount = await payG(null, '1160.00', '2026-05-20');
    const applied = await applyVendorPayment(g.entityId, onAccount.paymentId, [{ documentId: b.id, amountApplied: '1160.00' }], g.userId);
    expect(await linesOf(applied.journalEntry!.id)).toEqual(['1130 160.00/0.00', '1135 0.00/160.00']);
  });

  it('T5 · `payment unapply` re-parks what the application stored, and `payment reverse` mirrors the release', async () => {
    const unapplied = await typed();
    const p1 = await payG(unapplied.id, '1160.00', '2026-05-20');
    const r1 = await unapplyVendorPayment(g.entityId, p1.paymentId, { billId: unapplied.id, reason: 'Wrong bill', date: '2026-05-25' }, g.userId);
    expect(await linesOf(r1.journalEntry.id)).toEqual(['1130 0.00/160.00', '1135 160.00/0.00']);

    const reversed = await typed();
    const p2 = await payG(reversed.id, '1160.00', '2026-05-20');
    await reverseVendorPayment(g.entityId, p2.paymentId, { reason: 'Transfer returned', date: '2026-05-25' }, g.userId);
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE entity_id = $1 AND reverses_entry_id = $2`, [g.entityId, p2.journalEntry!.id]
    );
    expect(await linesOf(rows[0].id)).toEqual(['1130 0.00/160.00', '1135 160.00/0.00']);
  });

  it('a PUE paid by cheque holds its VAT in 1135 until the bank cashes the cheque', async () => {
    const b = await typed();
    const p = await payG(b.id, '1160.00', '2026-05-20', 'check');
    expect(await linesOf(p.journalEntry!.id)).toEqual([]);
    const tx = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
       VALUES ($1,$2,'2026-06-03'::date,-1160,'debit','cheque',false)`,
      [tx, bank]
    );
    await conciliarCheque(g.entityId, p.paymentId, { transactionId: tx, userId: g.userId });
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE entity_id = $1 AND entry_date = '2026-06-03' AND status = 'posted'`, [g.entityId]
    );
    expect((await Promise.all(rows.map((r) => linesOf(r.id)))).flat()).toEqual(['1130 160.00/0.00', '1135 0.00/160.00']);
  });

  it('T7 · a draft against vendors with its VAT on 1130 is refused naming iva_pendiente_acreditar; born paid, 1135 is refused', async () => {
    const draft = (vat: string, credit: string): ApprovedLine[] => [
      { account_code: '6100', debit: 1000 }, { account_code: vat, debit: 160 }, { account_code: credit, credit: 1160 },
    ];
    const bankCode = Object.entries(g.cuentas).find(([, id]) => id === g.roles.banco)![0];
    const onAp = await approveDraft(draft('1130', '2110'));
    expect(onAp).toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
    expect((onAp as Error).message).toMatch(/iva_pendiente_acreditar/);
    expect(await approveDraft(draft('1135', bankCode))).toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
    expect(await approveDraft(draft('1135', '2110'))).toBeUndefined();
    expect(await approveDraft(draft('1130', bankCode))).toBeUndefined();
  });
});
