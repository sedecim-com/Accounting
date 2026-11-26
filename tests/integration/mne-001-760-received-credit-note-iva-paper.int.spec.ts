import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { createJournalEntry, drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-760 (#692) · THE IVA PAPER SUBTRACTS A RECEIVED CREDIT NOTE'S
// CREDITED VAT IN THE MONTH OF ITS ENTRY
//
// A received note takes its VAT out of 1135 up to what its bill still has
// parked, and the rest out of 1130 (MNE-001-555). The share out of 1130 had
// been credited, so the paper of the note's month takes it off the creditable
// side; the share out of 1135 was never credited, so nothing of it is.
//
// Every bill is a PPD of 1,000.00 + 160.00 dated 2026-04-06, seeded with its
// VAT in 1130, as the doors posted before cash-basis VAT (no door posts that
// today), and paid 1,044.00 on 2026-04-20, so it owes 116.00. Every note is
// 100.00 + 16.00 from the bill's vendor. Hand figures:
//
//   A  May: the note takes 16.00 from 1130. The paper reads 16 %: base
//      −100.00, VAT −16.00, traced to the note's entry; 1130 moved −16.00.
//   B  June: a hand reclassification moved 10.00 of the bill's VAT back to
//      1135 on 2026-04-30, so the note takes 10.00 from 1135 and 6.00 from
//      1130. The paper reads base −37.50 (100.00 × 6 / 16), VAT −6.00.
//   C  July: the note's entry is reversed on 2026-08-05. It counts in no
//      month: July and August each name it in the tie-out, July with the
//      amended return. A note reversed in its own month (September) leaves
//      nothing behind.
// ============================================================

const NOTE = fs.readFileSync(path.join(__dirname, '..', 'golden', 'cfdi', 'nota-credito-ppd.xml'), 'utf8');
const VENDOR_RFC = 'SIN060101AB1';
const svc = new PreRegistrationService();

let f: Fixture;
let vendorId: string;

const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await query<T>(sql, params)).rows;

/** The seeded bill, paid 1,044.00 on 2026-04-20: 116.00 left to owe. */
async function paidBill(): Promise<{ id: string; uuid: string; entryId: string }> {
  const bill = await seedBill(f, { vendorId, method: 'PPD', vatCode: '1130', date: '2026-04-06' });
  await recordVendorPayment(
    { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1044.00', paymentDate: '2026-04-20', paymentMethod: 'spei',
      applications: [{ documentId: bill.id, amountApplied: '1044.00' }] },
    f.userId
  );
  return bill;
}

/** The golden note, rewritten to 100.00 + 16.00 from the vendor on `billUuid`, dated `day`, uploaded and posted. */
async function postNote(billUuid: string, day: string): Promise<{ uuid: string; entryId: string; lines: string[] }> {
  const uuid = uuidv4().toUpperCase();
  const xml = NOTE.replace('55E5E5E5-0005-4E05-8E05-E5E5E5E5E005', uuid).replace('22B2B2B2-0002-4B02-8B02-B2B2B2B2B002', billUuid)
    .replace('CON850101AB3', VENDOR_RFC).replace('Folio="501"', `Folio="${uuid.slice(0, 8)}"`).replaceAll('2026-08-20', day)
    .replaceAll('2320.00', '116.00').replaceAll('2000.00', '100.00').replaceAll('320.00', '16.00');
  const up = await svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
  await svc.processToAccounting(up.preRegistration, f.userId);
  const [entry] = await rows<{ id: string; lines: string[] }>(
    `SELECT je.id::text,
            (SELECT array_agg(a.code || ' ' || COALESCE(l.debit_amount, 0)::text || '/' || COALESCE(l.credit_amount, 0)::text
                              ORDER BY a.code, COALESCE(l.debit_amount, 0), COALESCE(l.credit_amount, 0))
               FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = je.id) AS lines
       FROM journal_entries je
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.source_type = 'vendor_credit_note' AND je.reference = $2`,
    [f.entityId, uuid]
  );
  return { uuid, entryId: entry.id, lines: entry.lines };
}

const paper = (month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month });
const tieOut = (wp: IvaWorkpaper) => wp.findings.find((h) => h.codigo === 'IVA-WP-CREDITABLE-VS-LEDGER');
const noteLines = (wp: IvaWorkpaper) => wp.contributions.creditable.filter((c) => c.documentKind === 'credit_note');

beforeAll(async () => {
  f = await crearInquilino('MNE-001-760 received credit note on the IVA paper');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-760', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4, $5)`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId, f.cuentas['6100']]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the paper of the note\'s month', () => {
  it('A · the 16.00 the note took out of 1130 is a negative line traced to its entry, and the tie-out is silent', async () => {
    const bill = await paidBill();
    const note = await postNote(bill.uuid, '2026-05-12');
    expect(note.lines).toEqual(['1130 0/16.0000', '2110 116.0000/0', '6100 0/100.0000']);

    const may = await paper(5);
    expect(may.ledger.iva_acreditable).toBe('-16.0000');
    expect(tieOut(may)).toBeUndefined();
    expect(may.figures.creditable.tasa16).toEqual({ base: '-100.0000', iva: '-16.0000' });
    expect(noteLines(may).map((c) => [c.entryIds, c.breakdown.tasa16])).toEqual([[[note.entryId], { base: '-100.0000', iva: '-16.0000' }]]);

    // The DIOT is not changed by this task: the note's month declares no paid VAT for the bill.
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: 5 });
    expect(diot.renglones.flatMap((r) => r.documentos).filter((d) => d.billId === bill.id)).toEqual([]);
  }, 120_000);

  it('B · of a note that took 10.00 from 1135 and 6.00 from 1130, only the 6.00 is subtracted', async () => {
    const bill = await paidBill();
    // NOTE: by hand, so the split is partial: what `iva-ppd-reclass` writes, for 10.00 of the bill's VAT.
    await createJournalEntry(
      f.entityId, '2026-04-30', JournalEntryType.STANDARD, 'VAT of the bill back to pending (synthetic)',
      [
        { account_id: f.cuentas['1135'], debit_amount: '10.00', credit_amount: null, description: 'Pending' },
        { account_id: f.cuentas['1130'], debit_amount: null, credit_amount: '10.00', description: 'Creditable' },
      ],
      f.userId,
      { autoPost: true, sourceType: 'iva_reclass', sourceId: bill.entryId }
    );
    const note = await postNote(bill.uuid, '2026-06-09');
    expect(note.lines).toEqual(['1130 0/6.0000', '1135 0/10.0000', '2110 116.0000/0', '6100 0/100.0000']);

    const june = await paper(6);
    expect(june.ledger.iva_acreditable).toBe('-6.0000');
    expect(tieOut(june)).toBeUndefined();
    expect(june.figures.creditable.tasa16).toEqual({ base: '-37.5000', iva: '-6.0000' });
    expect(noteLines(june).map((c) => c.entryIds)).toEqual([[note.entryId]]);
  }, 120_000);

  it('C · a note whose entry is reversed counts in no month, and each month its entries moved 1130 names it', async () => {
    const bill = await paidBill();
    const note = await postNote(bill.uuid, '2026-07-08');
    await reverseJournalEntry(note.entryId, f.userId, { reason: 'Synthetic correction', reversalDate: '2026-08-05' });

    const july = await paper(7);
    expect(noteLines(july)).toEqual([]);
    expect(july.figures.creditable.tasa16.iva).toBe('0.0000');
    expect(tieOut(july)?.mensaje).toContain(note.uuid);
    expect(tieOut(july)?.mensaje).toContain('CFF art. 32');
    const august = await paper(8);
    expect(noteLines(august)).toEqual([]);
    expect(tieOut(august)?.mensaje).toContain(note.uuid);
    expect(tieOut(august)?.mensaje).not.toContain('CFF art. 32');

    const again = await paidBill();
    const same = await postNote(again.uuid, '2026-09-03');
    await reverseJournalEntry(same.entryId, f.userId, { reason: 'Synthetic correction', reversalDate: '2026-09-20' });
    const september = await paper(9);
    expect(noteLines(september)).toEqual([]);
    expect(tieOut(september)).toBeUndefined();
  }, 180_000);
});
