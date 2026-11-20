import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { contabilizarComisiones, FEE_VAT_RELEASE_SOURCE } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { generateFilingWorkpaper } from '../../src/services/fiscal/filing-workpaper.js';

// ============================================================
// MNE-001-566 (#799, part 2 of 2) · A BANK FEE'S IVA IS CREDITABLE IN THE
// MONTH OF THE CHARGE (LIVA arts. 1-B and 5 fr. III; MNE-001-041)
//
// One synthetic entity, 2026. The charge is the payment, so the paper's
// creditable side counts what the fee's entries moved to 1130, net of their
// mirrors; a fee entry reversed in a later month counts in no month, and each
// month its entry or its mirror moved 1130 names it:
//
//   Mar  F1 bank fee 348.00 on 03-31 at 16 % → 300 + 48, released to 1130
//        F2 bank fee 116.00 on 03-15 at 16 % → 100 + 16, released, and the
//           release reversed on 04-02
//        A1 iva-comision adjustment 32.00 on 03-20 → 1130 32, base 32 / 0.16 = 200
//        → creditable tasa16 300 + 200 = 500 / 48 + 32 = 80; 1130 moved
//          48 + 16 + 32 = 96, the 16 named (F2); result 0 − 80 = −80
//   Apr  F2's mirror on 04-02 (1130 −16)
//        F3 bank fee 108.00 on 04-20 at 8 % → 100 + 8
//        A2 iva-comision 16.00 on 04-10, posted, mirrored the same day, and
//           posted again (a reopened reconciliation) → counts once, 100 / 16
//        → tasa8 100 / 8, tasa16 100 / 16; 1130 moved −16 + 8 + 16 − 16 +
//          16 = 8, against the paper's 24: the 16 named (F2's mirror)
// ============================================================

let f: Fixture;
let bankAccount: string;
let sessionId: string;
const fees: Record<string, string> = {};
const adjustments: Record<string, { id: string; entry: string }> = {};
const papers: Record<number, IvaWorkpaper> = {};

const paper = (month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month });
const box = (wp: IvaWorkpaper, rate: 'tasa16' | 'tasa8') => ({
  base: Number(wp.figures.creditable[rate].base).toFixed(2),
  iva: Number(wp.figures.creditable[rate].iva).toFixed(2),
});
const finding = (wp: IvaWorkpaper, code: string) => wp.findings.find((h) => h.codigo === code)?.mensaje ?? '';

async function fee(key: string, date: string, amount: string): Promise<void> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, description, transaction_type)
     VALUES ($1, $2, $3, $4, $5, 'fee')`,
    [id, bankAccount, date, `-${amount}`, `COMISION SINTETICA ${key}`]
  );
  fees[key] = id;
}

/** An iva-comision adjustment as `bank reconciliation post` leaves it: its row and its entry, DR 1130 / CR bank. */
async function adjustmentEntry(id: string, date: string, amount: string): Promise<string> {
  const entry = await createJournalEntry(
    f.entityId, new Date(`${date}T00:00:00`), JournalEntryType.AUTO_RECONCILIATION, 'Synthetic bank fee IVA',
    [
      { account_id: f.roles.iva_acreditable, debit_amount: amount, credit_amount: null, description: 'fee IVA' },
      { account_id: f.roles.banco, debit_amount: null, credit_amount: amount, description: 'bank' },
    ],
    f.userId,
    { autoPost: true, sourceType: 'bank_reconciliation', sourceId: id, reference: date }
  );
  await query(`UPDATE reconciliation_adjustments SET journal_entry_id = $1 WHERE id = $2 AND entity_id = $3`, [entry.id, id, f.entityId]);
  return entry.id;
}

async function adjustment(key: string, date: string, amount: string): Promise<void> {
  const id = uuidv4();
  await query(
    `INSERT INTO reconciliation_adjustments (id, entity_id, reconciliation_session_id, tipo, importe, created_by)
     VALUES ($1, $2, $3, 'iva-comision', $4, $5)`,
    [id, f.entityId, sessionId, `-${amount}`, f.userId]
  );
  adjustments[key] = { id, entry: await adjustmentEntry(id, date, amount) };
}

const postFees = (month: string, rate: string) =>
  contabilizarComisiones(f.entityId, bankAccount, { periodo: month, iva: { modo: 'tasa', tasa: rate }, userId: f.userId });

beforeAll(async () => {
  f = await crearInquilino('MNE-001-566 bank fee IVA in the IVA paper');
  await seedPolicies({ tenantId: f.tenantId });
  bankAccount = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
     VALUES ($1, $2, 'Cuenta Sintetica', 'Banco Sintetico', $3, 'MXN', true)`,
    [bankAccount, f.entityId, f.roles.banco]
  );
  sessionId = uuidv4();
  await query(
    `INSERT INTO reconciliation_sessions (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
     VALUES ($1, $2, $3, '2026-03-01', '2026-04-30', 0, 0)`,
    [sessionId, bankAccount, f.entityId]
  );

  await fee('F1', '2026-03-31', '348.00');
  await fee('F2', '2026-03-15', '116.00');
  await postFees('2026-03', '0.16');
  await adjustment('A1', '2026-03-20', '32.00');
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM journal_entries WHERE entity_id = $1 AND source_type = $2 AND source_id = $3`,
    [f.entityId, FEE_VAT_RELEASE_SOURCE, fees.F2]
  );
  await reverseJournalEntry(rows[0].id, f.userId, { reason: 'Synthetic correction', reversalDate: '2026-04-02' });

  await fee('F3', '2026-04-20', '108.00');
  await postFees('2026-04', '0.08');
  await adjustment('A2', '2026-04-10', '16.00');
  await reverseJournalEntry(adjustments.A2.entry, f.userId, { reason: 'Reconciliation reopened', reversalDate: '2026-04-10' });
  adjustments.A2.entry = await adjustmentEntry(adjustments.A2.id, '2026-04-10', '16.00');

  for (const m of [3, 4]) papers[m] = await paper(m);
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe("a bank fee's IVA in the IVA paper (LIVA arts. 1-B and 5 fr. III)", () => {
  it('C1 · March: a released fee and a posted iva-comision adjustment are creditable in the month of the charge', () => {
    const march = papers[3];
    expect(box(march, 'tasa16')).toEqual({ base: '500.00', iva: '80.00' });
    expect(march.ledger.iva_acreditable).toBe('96.0000');
    const kinds = march.contributions.creditable.map((c) => [c.documentKind, c.breakdown.tasa16.base, c.breakdown.tasa16.iva]);
    expect(kinds).toEqual(expect.arrayContaining([['bank_fee', '300.0000', '48.0000'], ['bank_fee', '200.0000', '32.0000']]));
    expect(march.contributions.creditable.find((c) => c.documentId === fees.F2)).toBeUndefined();
    expect(march.settlement?.resultCents).toBe('-80.00');
  });

  it('C2 · a fee entry reversed in a later month counts in no month, and both months name it', () => {
    const gap = finding(papers[3], 'IVA-WP-CREDITABLE-VS-LEDGER');
    expect(gap).toContain('reversada el 2026-04-02');
    expect(gap).toContain('-16.0000');
    expect(gap).toContain('CFF art. 32');

    const april = papers[4];
    expect(april.ledger.iva_acreditable).toBe('8.0000');
    const aprilGap = finding(april, 'IVA-WP-CREDITABLE-VS-LEDGER');
    expect(aprilGap).toContain('el espejo');
    expect(aprilGap).toContain('(16.0000)');
    expect(aprilGap).not.toContain('CFF art. 32');
  });

  it('C3 · April: a fee at 8 % keeps its rate, and an adjustment mirrored and posted again counts once', () => {
    const april = papers[4];
    expect(box(april, 'tasa8')).toEqual({ base: '100.00', iva: '8.00' });
    expect(box(april, 'tasa16')).toEqual({ base: '100.00', iva: '16.00' });
    const a2 = april.contributions.creditable.filter((c) => c.documentId === adjustments.A2.id);
    expect(a2.map((c) => c.entryIds)).toEqual([[adjustments.A2.entry]]);
  });

  it('C4 · every month lists the fees whose bank CFDI must be in hand before filing (LIVA art. 5 fr. II)', () => {
    const march = finding(papers[3], 'IVA-WP-BANK-FEE-CFDI');
    expect(march).toContain('art. 5 fr. II');
    expect(march).toContain('48.0000');
    expect(march).toContain('32.0000');
    expect(march).toContain('16 %'); // the adjustment's base is derived at 16 %
    const april = finding(papers[4], 'IVA-WP-BANK-FEE-CFDI');
    expect(april).toContain('8.0000');
    expect(april).toContain('16.0000');
  });

  it('C5 · the filing workpaper traces the fee to its entry on 1130', async () => {
    const wp = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 3, forms: ['iva'] });
    const line = wp.sections[0].lines.find((l) => l.key === 'creditable.tasa16.iva');
    const doc = line?.source.documents?.find((d) => d.documentId === fees.F1);
    expect(doc).toMatchObject({ documentKind: 'bank_fee', amount: '48.0000' });
    expect(doc?.entries.map((e) => [e.entryDate, e.sourceType, e.net])).toEqual([['2026-03-31', FEE_VAT_RELEASE_SOURCE, '48.0000']]);
  });
});
