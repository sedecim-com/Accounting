import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { generateFilingWorkpaper } from '../../src/services/fiscal/filing-workpaper.js';

// ============================================================
// MNE-001-565 (#799, part 1 of 2) · THE IVA PAPER TAKES AN ISSUED CREDIT
// NOTE'S IVA OUT OF THE MONTH ITS ENTRY MOVES 2120 (LIVA art. 7)
//
// One synthetic entity, 2026, every document posted by the real services
// (16 % IVA in brackets):
//
//   May  S1 PUE 10,000 (1,600) 05-05; N1 devolucion 1,000 + 160 05-18 and
//        N1b descuento 500 + 80 05-20 on S1; S3 PPD 2,000 (320) 05-12 and
//        N3 200 + 32 05-20 applied, uncollected: its 32 leaves 2125
//        → 10,000 − 1,000 − 500 = 8,500 / 1,600 − 160 − 80 = 1,360 = 2120
//   Jun  S3 collected 2,088 06-10: 320 × 2,088 / 2,320 = 288, base 1,800;
//        N2 300 + 48 06-05 on S1, a May invoice; N7 1,000 + 160 06-20 with
//        no invoice (PUE assumed)
//        → 1,800 − 300 − 1,000 = 500 / 288 − 48 − 160 = 80 = 2120; S3's
//        2125 ends at 0 (320 − 32 − 288)
//   Jul  S5 PUE 1,000 at 0 %, S6 PUE 500 exempt, N5 100 on S5, N6 50 on S6
//        → tasa0 900, exento 450; the proportion's acts 900 of 1,350
//   Aug  S8 PUE 3,000 (480) 08-03; N8 300 + 48 08-10, reversed 08-20; N9
//        200 + 32 08-25, reversed 09-04 → 3,000 / 480; 2120 moved 448, and
//        the tie-out names N9 (32); September names its mirror (−32)
//   Oct  ADV advance invoice 1,000 (160) 10-02, collected; FIN PUE 5,000
//        (800) 10-15; NA anticipo 1,000 + 160 10-20 on FIN
//        → 1,000 + 5,000 − 1,000 = 5,000 / 800 = 2120 (not caused twice)
//   Nov  S10 PPD 1,000 (160) 11-03, collected whole 11-05; N10 100 + 16
//        11-12 → 1,000 / 160; N10 nothing, and 2125 ends at −16
// ============================================================

let f: Fixture;
let customerId: string;
const notes: Record<string, { id: string; number: string; entry: string }> = {};

const day = (month: number, d: number): string => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function sale(terms: 'PUE' | 'PPD', price: string, date: string, tax: { rate?: string; code?: string } = { rate: '16' }): Promise<string> {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: date, due_date: date, currency_code: 'MXN', terms,
    lines: [{
      revenue_account_id: f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price,
      tax_rate: tax.rate ?? '0', tax_code: tax.code ?? null,
    }],
    created_by: f.userId,
  });
  return (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice.id;
}

const collect = (invoiceId: string, amount: string, date: string) =>
  recordCustomerPayment(
    { entityId: f.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: date,
      paymentMethod: 'spei', applications: [{ documentId: invoiceId, amountApplied: amount }] },
    f.userId
  );

/** Creates and issues a note; applies it to its invoice when `apply` is set. */
async function note(
  key: string, o: { invoice?: string; type?: string; subtotal: string; tax: string; date: string; apply?: boolean }
): Promise<void> {
  const cn = await createCreditNote({
    entity_id: f.entityId, customer_id: customerId, invoice_id: o.invoice ?? null, type: o.type ?? 'devolucion',
    credit_date: o.date, subtotal: o.subtotal, tax_amount: o.tax,
  }, f.userId);
  const issued = await issueCreditNote(f.entityId, cn.id, f.userId);
  if (o.apply && o.invoice) {
    const total = (Number(o.subtotal) + Number(o.tax)).toFixed(2);
    await applyCreditNote(f.entityId, cn.id, [{ invoiceId: o.invoice, amount: total }], f.userId);
  }
  notes[key] = { id: cn.id, number: cn.credit_note_number, entry: issued.journalEntry!.id };
}

/** ADV as an approved advance CFDI leaves it (MNE-001-515's helper), with its line so the paper can split it. */
async function advanceInvoice(date: string): Promise<void> {
  const id = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, amount_paid, currency_code, invoice_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, '1000.00', '160.00', '1160.00', '1160.00', '0.00', 'MXN', $5, $5, 'sent', $6)`,
    [id, f.entityId, `ADV-${id.slice(0, 8)}`, customerId, date, f.userId]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price, revenue_account_id,
       tax_rate, tax_amount, line_amount, total_amount)
     VALUES ($1, $2, 1, 'Advance', 1, 1000, $3, 16, 160, 1000, 1160)`,
    [uuidv4(), id, f.cuentas['2150']]
  );
  const entry = await createJournalEntry(
    f.entityId, date, 'auto_invoice' as never, 'Advance CFDI',
    [
      { account_id: f.cuentas['1120'], debit_amount: '1160.00', credit_amount: null },
      { account_id: f.cuentas['2150'], debit_amount: null, credit_amount: '1000.00' },
      { account_id: f.cuentas['2120'], debit_amount: null, credit_amount: '160.00' },
    ] as never,
    f.userId,
    { autoPost: true, sourceType: 'invoice', sourceId: id }
  );
  await query(`UPDATE invoices SET journal_entry_id = $1 WHERE id = $2 AND entity_id = $3`, [entry.id, id, f.entityId]);
  await collect(id, '1160.00', date);
}

const papers: Record<number, IvaWorkpaper> = {};
const paper = (month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month });
const codes = (wp: IvaWorkpaper): string[] => wp.findings.map((h) => h.codigo);
const box = (wp: IvaWorkpaper, rate: 'tasa16' | 'tasa0' | 'exento') => ({
  base: Number(wp.figures.charged[rate].base).toFixed(2),
  iva: Number(wp.figures.charged[rate].iva).toFixed(2),
});
const lineOf = (wp: IvaWorkpaper, key: string) => wp.contributions.charged.find((c) => c.documentId === notes[key].id);
const chargedGap = (wp: IvaWorkpaper) => wp.findings.find((h) => h.codigo === 'IVA-WP-CHARGED-VS-LEDGER');

/** Net movement of one account over the entity's posted entries, debit positive. */
async function balance(code: string): Promise<string> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::numeric(19,2)::text AS s
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = $2`,
    [f.entityId, f.cuentas[code]]
  );
  return r.rows[0].s;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-565 credit notes in the IVA paper');
  await seedPolicies({ tenantId: f.tenantId });
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-565', 'Cliente Sintetico Notas SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );

  const s1 = await sale('PUE', '10000.00', day(5, 5));
  await note('N1', { invoice: s1, subtotal: '1000.00', tax: '160.00', date: day(5, 18), apply: true });
  await note('N1b', { invoice: s1, type: 'descuento', subtotal: '500.00', tax: '80.00', date: day(5, 20), apply: true });
  const s3 = await sale('PPD', '2000.00', day(5, 12));
  await note('N3', { invoice: s3, subtotal: '200.00', tax: '32.00', date: day(5, 20), apply: true });

  await collect(s3, '2088.00', day(6, 10));
  await note('N2', { invoice: s1, type: 'descuento', subtotal: '300.00', tax: '48.00', date: day(6, 5), apply: true });
  await note('N7', { subtotal: '1000.00', tax: '160.00', date: day(6, 20) });

  const s5 = await sale('PUE', '1000.00', day(7, 3), { rate: '0' });
  const s6 = await sale('PUE', '500.00', day(7, 3), { code: 'exento' });
  await note('N5', { invoice: s5, subtotal: '100.00', tax: '0', date: day(7, 15), apply: true });
  await note('N6', { invoice: s6, subtotal: '50.00', tax: '0', date: day(7, 15), apply: true });

  const s8 = await sale('PUE', '3000.00', day(8, 3));
  await note('N8', { invoice: s8, subtotal: '300.00', tax: '48.00', date: day(8, 10) });
  await reverseJournalEntry(notes.N8.entry, f.userId, { reason: 'CFDI cancelled', reversalDate: day(8, 20) });
  await note('N9', { invoice: s8, subtotal: '200.00', tax: '32.00', date: day(8, 25) });
  await reverseJournalEntry(notes.N9.entry, f.userId, { reason: 'CFDI cancelled', reversalDate: day(9, 4) });

  await advanceInvoice(day(10, 2));
  const finalSale = await sale('PUE', '5000.00', day(10, 15));
  await note('NA', { invoice: finalSale, type: 'anticipo', subtotal: '1000.00', tax: '160.00', date: day(10, 20), apply: true });

  const s10 = await sale('PPD', '1000.00', day(11, 3));
  await collect(s10, '1160.00', day(11, 5));
  await note('N10', { invoice: s10, subtotal: '100.00', tax: '16.00', date: day(11, 12) });

  for (const m of [5, 6, 7, 8, 9, 10, 11]) papers[m] = await paper(m);
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('an issued credit note in the IVA paper (LIVA art. 7)', () => {
  it('C1 · May: two notes on a PUE invoice come out at their rate, traced to their entries, and 2120 ties out', () => {
    const may = papers[5];
    expect(box(may, 'tasa16')).toEqual({ base: '8500.00', iva: '1360.00' });
    expect(may.ledger.iva_trasladado).toBe('-1360.0000');
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(lineOf(may, 'N1')).toMatchObject({
      documentKind: 'credit_note', documentNumber: notes.N1.number, entryIds: [notes.N1.entry],
      breakdown: { tasa16: { base: '-1000.0000', iva: '-160.0000' } },
    });
    expect(lineOf(may, 'N1b')?.breakdown.tasa16).toEqual({ base: '-500.0000', iva: '-80.0000' });
    expect(may.settlement?.resultCents).toBe('1360.00');
  });

  it('C2 · a note in a later month than its invoice counts in its own month, and one with no invoice is PUE at its own rate', () => {
    const june = papers[6];
    expect(box(june, 'tasa16')).toEqual({ base: '500.00', iva: '80.00' });
    expect(june.ledger.iva_trasladado).toBe('-80.0000');
    expect(codes(june)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(lineOf(june, 'N2')?.breakdown.tasa16).toEqual({ base: '-300.0000', iva: '-48.0000' });
    expect(codes(june)).not.toContain('DIOT-TASA-MEDIDA'); // its own figures state 16 %
    expect(lineOf(june, 'N7')).toMatchObject({ entryIds: [notes.N7.entry], breakdown: { tasa16: { base: '-1000.0000', iva: '-160.0000' } } });
  });

  it('C3 · a note on a PPD invoice not yet collected takes nothing out: the later collection releases less', async () => {
    expect(lineOf(papers[5], 'N3')).toBeUndefined();
    expect(lineOf(papers[6], 'N3')).toBeUndefined();
    // June's 500 / 80 is S3's 1,800 / 288 less N2's 300 / 48 and N7's 1,000 / 160.
    expect(await balance('2125')).toBe('16.00'); // 0 from S3 (320 − 32 − 288); +16 from N10, see C7
  });

  it('C4 · July: notes at 0 % and exempt lower their bases, and the proportion of art. 5 fr. V with them', () => {
    const july = papers[7];
    expect(box(july, 'tasa0')).toEqual({ base: '900.00', iva: '0.00' });
    expect(box(july, 'exento')).toEqual({ base: '450.00', iva: '0.00' });
    expect(july.ledger.iva_trasladado).toBe('0.0000');
    expect(codes(july)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(july.findings.find((h) => h.codigo === 'IVA-WP-ZERO-RATE-UNVERIFIED')?.mensaje).toContain('900.0000');
    expect(july.figures.proration).toMatchObject({ taxedActs: '900.0000', totalActs: '1350.0000' });
  });

  it('C5 · a cancelled note counts in no month, and the months its entries moved name it', () => {
    const aug = papers[8];
    expect(box(aug, 'tasa16')).toEqual({ base: '3000.00', iva: '480.00' });
    expect(aug.ledger.iva_trasladado).toBe('-448.0000');
    expect(lineOf(aug, 'N8')).toBeUndefined();
    expect(lineOf(aug, 'N9')).toBeUndefined();
    const gap = chargedGap(aug)?.mensaje ?? '';
    expect(gap).toContain(notes.N9.number);
    expect(gap).toContain('32.0000');
    expect(gap).toContain('CFF art. 32');
    expect(gap).not.toContain(notes.N8.number); // reversed within its month: nothing to name

    const sep = papers[9];
    expect(box(sep, 'tasa16')).toEqual({ base: '0.00', iva: '0.00' });
    expect(sep.ledger.iva_trasladado).toBe('-32.0000');
    expect(chargedGap(sep)?.mensaje).toContain(notes.N9.number);
    expect(chargedGap(sep)?.mensaje).toContain('-32.0000');
  });

  it('C6 · an anticipo note is no return, but its IVA leaves the month: the advance is not caused twice', () => {
    const oct = papers[10];
    expect(box(oct, 'tasa16')).toEqual({ base: '5000.00', iva: '800.00' });
    expect(oct.ledger.iva_trasladado).toBe('-800.0000');
    expect(codes(oct)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(lineOf(oct, 'NA')?.breakdown.tasa16).toEqual({ base: '-1000.0000', iva: '-160.0000' });
  });

  it('C7 · a note on a PPD invoice already collected: its entry debits 2125, so the paper takes nothing out (part 2 warns)', async () => {
    // FIXME(#799): the posting takes the 16 from 2125, where nothing was
    // parked, and the IVA stays in 2120. Part 2 (MNE-001-566) names it.
    const nov = papers[11];
    expect(box(nov, 'tasa16')).toEqual({ base: '1000.00', iva: '160.00' });
    expect(lineOf(nov, 'N10')).toBeUndefined();
    expect(codes(nov)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  });

  it('C8 · the filing workpaper traces the note line to the note and its entry', async () => {
    const wp = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 5, forms: ['iva'] });
    const line = wp.sections[0].lines.find((l) => l.key === 'charged.tasa16.iva');
    const doc = line?.source.documents?.find((d) => d.documentId === notes.N1.id);
    expect(doc).toMatchObject({ documentKind: 'credit_note', documentNumber: notes.N1.number, amount: '-160.0000' });
    expect(doc?.entries.map((e) => [e.entryId, e.net])).toEqual([[notes.N1.entry, '160.0000']]);
  });
});
