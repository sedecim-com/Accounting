import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import {
  applyVendorPayment, recordVendorPayment, reverseVendorPayment, unapplyVendorPayment,
} from '../../src/services/payments/payment-service.js';

// ============================================================
// MNE-001-582 (#814) · THE RECEIVED SIDE NEEDS NO CAP AFTER A CREDIT NOTE.
//
// MNE-001-581 caps what an unapply or a reversal puts back into 2125 after an
// issued note, because an issued note can follow a collection in full and take
// its IVA from 2120. A received note cannot: it is refused above what the bill
// still owes (`refusalOf`), and its VAT leaves 1135 first (`splitNoteVat`). So
// `payment unapply` and `payment reverse` already leave 1135 at the VAT of the
// balance owed again. These cases are green today; they turn red if either
// guard goes. Hand figures on the fixture PPD bill of 9,280.00 (8,000.00 +
// 1,280.00, ratio 16/116) and the golden note of 2,320.00 (2,000.00 + 320.00),
// dated 2026-09-10. Every party is synthetic.
// ============================================================

const cfdi = (...file: string[]) => fs.readFileSync(path.join(__dirname, '..', ...file), 'utf8');
const BILL = cfdi('fixtures', 'cfdi', 'factura-consultoria-2001.xml');
const NOTE = cfdi('golden', 'cfdi', 'nota-credito-ppd.xml');
const VENDOR_RFC = 'SIN060101AB1';
const svc = new PreRegistrationService();
type Row = Record<string, unknown>;

let f: Fixture;
let vendorId: string;

const rows = async <T extends Row = Row>(sql: string, params: unknown[]) => (await query<T>(sql, params)).rows;
const upload = (xml: string) => svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
const post = (n: { pre: Row }) => svc.processToAccounting(n.pre, f.userId);

/** The fixture bill under a fresh UUID, posted from the inbox: 1,280.00 parked in 1135. */
async function bill(): Promise<{ id: string; uuid: string }> {
  const uuid = uuidv4().toUpperCase();
  const up = await upload(BILL.replace('F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80', uuid).replace('Folio="2001"', `Folio="${uuid.slice(0, 8)}"`));
  return { id: ((await post({ pre: up.preRegistration })).bill as { id: string }).id, uuid };
}

/** The golden note of 2,320.00 from the bill's vendor, naming `billUuid`, dated 2026-09-10. */
async function note(billUuid: string): Promise<{ uuid: string; pre: Row }> {
  const uuid = uuidv4().toUpperCase();
  const up = await upload(NOTE.replace('55E5E5E5-0005-4E05-8E05-E5E5E5E5E005', uuid).replace('22B2B2B2-0002-4B02-8B02-B2B2B2B2B002', billUuid)
    .replace('CON850101AB3', VENDOR_RFC).replace('Folio="501"', `Folio="${uuid.slice(0, 8)}"`).replaceAll('2026-08-20', '2026-09-10'));
  return { uuid, pre: up.preRegistration };
}

/** A SPEI payment of `amount` applied whole to the bill. */
async function pay(billId: string, amount: string, date: string): Promise<string> {
  const paid = await recordVendorPayment(
    { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: date, paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: amount }] },
    f.userId
  );
  return paid.paymentId;
}

/** 1135 and 1130 of the whole entity, debit minus credit; each case reads its own movement. */
async function vat(): Promise<{ pending: string; creditable: string }> {
  const net = async (code: string) => (await rows<{ net: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::numeric(19,2)::text AS net
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
      WHERE je.entity_id = $1 AND l.account_id = $2`,
    [f.entityId, f.cuentas[code]]
  ))[0].net;
  return { pending: await net('1135'), creditable: await net('1130') };
}
const moved = (before: { pending: string; creditable: string }, after: { pending: string; creditable: string }) => ({
  pending: (Number(after.pending) - Number(before.pending)).toFixed(2),
  creditable: (Number(after.creditable) - Number(before.creditable)).toFixed(2),
});
const dueOf = async (billId: string) => (await rows<{ due: string }>(`SELECT amount_due::text AS due FROM bills WHERE id = $1 AND entity_id = $2`, [billId, f.entityId]))[0].due;
const entriesOf = async (reference: string) =>
  rows(`SELECT id FROM journal_entries WHERE entity_id = $1 AND reference = $2`, [f.entityId, reference]);
const unapply = (paymentId: string, billId: string) =>
  unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Applied to the wrong bill', date: '2026-09-25' }, f.userId);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-582 received unapply after a note');
  const email = (await rows<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId]))[0].email;
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'lineas_factura_desde', 'conceptos_cfdi', email);
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-582', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4, $5)`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId, f.cuentas['6100']]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('A · a note cannot follow a payment of the whole balance (#814 own case)', () => {
  it('paid in full, the note waits for a person: nothing posts and 1135 stays at 0', async () => {
    const start = await vat();
    const b = await bill(); // parks 1,280.00
    await pay(b.id, '9280.00', '2026-09-05');
    const n = await note(b.uuid);
    await expect(post(n)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    expect(await entriesOf(n.uuid)).toEqual([]);
    expect(moved(start, await vat())).toEqual({ pending: '0.00', creditable: '1280.00' });
  }, 90_000);

  it('partly paid, a note above what the bill still owes is refused (exceeds_balance) and nothing posts', async () => {
    const b = await bill();
    // 7,000.00 releases 1,280.00 x 7,000.00 / 9,280.00 = 965.5172; the bill owes 2,280.00.
    await pay(b.id, '7000.00', '2026-09-05');
    const before = await vat();
    const n = await note(b.uuid);
    await expect(post(n)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    const [refused] = await rows<{ error_message: string }>(`SELECT error_message FROM pre_registrations WHERE id = $1`, [n.pre.id]);
    expect(refused.error_message).toMatch(/is for 2320\.00 and bill \S+ owes 2280\.00/);
    expect(await entriesOf(n.uuid)).toEqual([]);
    expect(await dueOf(b.id)).toBe('2280.0000');
    expect(await vat()).toEqual(before);
  }, 90_000);
});

describe('after a note, undoing a payment puts back into 1135 the VAT of the balance owed again', () => {
  it('B · 4,640.00 paid, the note, the payment unapplied: 1135 holds 960.00 = 6,960.00 x 16/116; paid again, it releases 960.00', async () => {
    const start = await vat();
    const b = await bill(); // parks 1,280.00
    const p = await pay(b.id, '4640.00', '2026-09-05'); // releases 640.00
    await post(await note(b.uuid)); // 320.00 out of 1135: 640.00 is parked
    const r = await unapply(p, b.id);
    expect(r.ivaReparked).toBe('640.00');
    expect(await dueOf(b.id)).toBe('6960.0000');
    expect(moved(start, await vat())).toEqual({ pending: '960.00', creditable: '0.00' });
    // Settled by cash and the note, the last payment releases all that is parked.
    await pay(b.id, '6960.00', '2026-09-26');
    expect(moved(start, await vat())).toEqual({ pending: '0.00', creditable: '960.00' });
  }, 90_000);

  it('C · the note first, 6,960.00 paid (releases 960.00), unapplied: 1135 holds 960.00', async () => {
    const start = await vat();
    const b = await bill(); // parks 1,280.00
    await post(await note(b.uuid));
    const p = await pay(b.id, '6960.00', '2026-09-15');
    expect(moved(start, await vat())).toEqual({ pending: '0.00', creditable: '960.00' });
    expect((await unapply(p, b.id)).ivaReparked).toBe('960.00');
    expect(moved(start, await vat())).toEqual({ pending: '960.00', creditable: '0.00' });
  }, 90_000);

  it('E · 4,640.00, the note, 2,320.00 settles; the first unapplied: 1135 holds 640.00 and 1130 320.00 = 2,320.00 x 16/116', async () => {
    const start = await vat();
    const b = await bill(); // parks 1,280.00
    const p1 = await pay(b.id, '4640.00', '2026-09-05'); // 640.00
    await post(await note(b.uuid)); // 320.00 out of 1135
    await pay(b.id, '2320.00', '2026-09-15'); // settles: releases the 320.00 parked
    expect(moved(start, await vat())).toEqual({ pending: '0.00', creditable: '960.00' });
    // Owed again 9,280.00 - 2,320.00 - 2,320.00 = 4,640.00: its VAT is 960.00 - 320.00 = 640.00.
    expect((await unapply(p1, b.id)).ivaReparked).toBe('640.00');
    expect(await dueOf(b.id)).toBe('4640.0000');
    expect(moved(start, await vat())).toEqual({ pending: '640.00', creditable: '320.00' });
  }, 90_000);

  it('F · B with the payment reversed instead: the mirrors leave 1135 at 960.00 and 1130 at 0', async () => {
    const start = await vat();
    const b = await bill(); // parks 1,280.00
    const p = await pay(b.id, '4640.00', '2026-09-05');
    await post(await note(b.uuid));
    await reverseVendorPayment(f.entityId, p, { reason: 'The transfer came back', date: '2026-09-25' }, f.userId);
    expect(await dueOf(b.id)).toBe('6960.0000');
    expect(moved(start, await vat())).toEqual({ pending: '960.00', creditable: '0.00' });
  }, 90_000);
});

describe('a real short pay is still refused', () => {
  it('a note whose entry was reversed by hand explains nothing: the bill still owes less, and the unapply is refused', async () => {
    const b = await bill();
    const p = await pay(b.id, '4640.00', '2026-09-05');
    const n = await note(b.uuid);
    await post(n);
    const [entry] = await entriesOf(n.uuid);
    // `entry reverse` mirrors the note but gives the bill nothing back: 2,320.00 is owed by no row.
    await reverseJournalEntry(String(entry.id), f.userId, { reason: 'Note entered twice' });
    expect(await dueOf(b.id)).toBe('2320.0000');
    await expect(unapplyVendorPayment(f.entityId, p, { billId: b.id, reason: 'x' }, f.userId))
      .rejects.toThrow(/closed short \(2320\.00 written off\)/);
  }, 90_000);

  it('9,000.00 applied with --mode residual on a bill with no note: 280.00 written off, and the unapply is refused as closed short', async () => {
    const b = await bill();
    const paid = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '9000.00', paymentDate: '2026-09-05',
        paymentMethod: 'spei', applications: [], onAccount: true },
      f.userId
    );
    await applyVendorPayment(
      f.entityId, paid.paymentId, [{ documentId: b.id, amountApplied: '9000.00' }], f.userId,
      { modo: 'residual', shortPayReason: 'The vendor waived the rest' }
    );
    // The application is posted today, so both undos are dated today.
    await expect(unapplyVendorPayment(f.entityId, paid.paymentId, { billId: b.id, reason: 'x' }, f.userId))
      .rejects.toThrow(/closed short \(280\.00 written off\)/);
    await expect(reverseVendorPayment(f.entityId, paid.paymentId, { reason: 'x' }, f.userId))
      .rejects.toThrow(/closed short \(280\.00 written off\)/);
  }, 90_000);
});
