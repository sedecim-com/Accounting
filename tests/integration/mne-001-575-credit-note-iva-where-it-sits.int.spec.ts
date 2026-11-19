import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-575 (#801) · AN ISSUED CREDIT NOTE TAKES ITS IVA FROM WHERE ITS
// INVOICE'S IVA SITS: 2125 UP TO WHAT THE INVOICE STILL HAS PARKED, 2120 FOR
// THE REST (LIVA arts. 1-B and 7)
//
// One synthetic entity, November 2026, every invoice PPD at 16 %, every
// document posted by the real services:
//
//   A  S1 1,000 + 160 11-03, collected 1,160 11-05 (releases 160);
//      N1 100 + 16 11-20 → 2120 16
//   B  S2 2,000 + 320 11-03, collected 1,740 11-06 (releases 240, parks 80);
//      N2 750 + 120 11-21, applied 580 → 2125 80, 2120 40
//   C  S3 1,000 + 160 11-03, collected 580 11-07 (releases 80); N3 200 + 32
//      11-08 applied → 2125 32; collected 348 11-22: 160 × 928 / 1,160 − 80 = 48
//   D  S4 500 + 80 11-03, uncollected; N4 50 + 8 11-09 → 2125 8, as before
//   E  S5 1,000 + 160 11-03; N5a 600 + 96 11-08 applied → 2125 96; collected
//      464 11-09 (releases 64); N5b 100 + 16 11-23 → 2120 16
//   F  S6 1,000 + 160 11-03, collected 1,160 11-10, its stored release set to
//      NULL (a row written before MNE-001-459); N6 100 + 16 11-24 → 2120 16
//
//   November's paper: base 1,000 − 100 + 1,500 − 250 + 500 + 300 + 400 − 100
//   + 1,000 − 100 = 4,150; IVA 160 − 16 + 240 − 40 + 80 + 48 + 64 − 16 + 160
//   − 16 = 664 = 4,150 × 16 %. 2120 moves 752 released − 88 by notes = 664;
//   2125 ends at 1,040 parked − 752 released − 216 by notes = 72 (S4's 80 − 8).
// ============================================================

let f: Fixture;
let customerId: string;
const notes: Record<string, { id: string; number: string; entry: string }> = {};
let november: IvaWorkpaper;

const day = (d: number): string => `2026-11-${String(d).padStart(2, '0')}`;

async function sale(price: string): Promise<string> {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: day(3), due_date: day(3), currency_code: 'MXN',
    terms: 'PPD',
    lines: [{ revenue_account_id: f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price, tax_rate: '16' }],
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

async function note(key: string, invoice: string, subtotal: string, tax: string, date: string, apply?: string): Promise<void> {
  const cn = await createCreditNote({
    entity_id: f.entityId, customer_id: customerId, invoice_id: invoice, type: 'devolucion',
    credit_date: date, subtotal, tax_amount: tax,
  }, f.userId);
  const issued = await issueCreditNote(f.entityId, cn.id, f.userId);
  if (apply) await applyCreditNote(f.entityId, cn.id, [{ invoiceId: invoice, amount: apply }], f.userId);
  notes[key] = { id: cn.id, number: cn.credit_note_number, entry: issued.journalEntry!.id };
}

/** The note's entry by account code: debit minus credit, two decimals. */
async function linesOf(key: string): Promise<Record<string, string>> {
  const r = await query<{ code: string; net: string }>(
    `SELECT a.code, SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::numeric(19,2)::text AS net
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 GROUP BY a.code`,
    [notes[key].entry]
  );
  return Object.fromEntries(r.rows.map((row) => [row.code, row.net]));
}

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

const lineOf = (key: string) => november.contributions.charged.find((c) => c.documentId === notes[key].id);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-575 credit note IVA where it sits');
  await seedPolicies({ tenantId: f.tenantId });
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-575', 'Cliente Sintetico Notas PPD SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );

  const [s1, s2, s3, s4, s5, s6] = [
    await sale('1000.00'), await sale('2000.00'), await sale('1000.00'),
    await sale('500.00'), await sale('1000.00'), await sale('1000.00'),
  ];
  await collect(s1, '1160.00', day(5));
  await collect(s2, '1740.00', day(6));
  await collect(s3, '580.00', day(7));
  await note('N3', s3, '200.00', '32.00', day(8), '232.00');
  await note('N5a', s5, '600.00', '96.00', day(8), '696.00');
  await note('N4', s4, '50.00', '8.00', day(9));
  await collect(s5, '464.00', day(9));
  await collect(s6, '1160.00', day(10));
  const storedRelease = (value: string | null) => query(
    `UPDATE payment_allocations pa SET iva_reclass_amount = $3
       FROM customer_payments cp
      WHERE cp.id = pa.payment_id AND cp.entity_id = $1 AND pa.invoice_id = $2`,
    [f.entityId, s6, value]
  );
  await storedRelease(null);
  await note('N1', s1, '100.00', '16.00', day(20));
  await note('N2', s2, '750.00', '120.00', day(21), '580.00');
  await collect(s3, '348.00', day(22));
  await note('N5b', s5, '100.00', '16.00', day(23));
  await note('N6', s6, '100.00', '16.00', day(24));
  // Back to what the collection stored: the paper reads it, and only the note was to see a legacy row.
  await storedRelease('160.0000');

  november = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 11 });
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('an issued credit note takes its IVA from where its invoice\'s IVA sits (LIVA arts. 1-B and 7)', () => {
  it('A · on an invoice collected whole, the IVA restituted leaves 2120 and 2125 does not move', async () => {
    expect(await linesOf('N1')).toEqual({ '4400': '100.00', '2120': '16.00', '1120': '-116.00' });
  });

  it('B · partly collected, a note above the balance: 2125 up to what is parked, 2120 for the rest', async () => {
    expect(await linesOf('N2')).toEqual({ '4400': '750.00', '2125': '80.00', '2120': '40.00', '1120': '-870.00' });
  });

  it('C · partly collected, a note within the balance: all from 2125, and the last collection releases the rest', async () => {
    expect(await linesOf('N3')).toEqual({ '4400': '200.00', '2125': '32.00', '1120': '-232.00' });
  });

  it('D · on an invoice not collected, the posting is as before: 2125', async () => {
    expect(await linesOf('N4')).toEqual({ '4400': '50.00', '2125': '8.00', '1120': '-58.00' });
  });

  it('E · what an earlier note took from 2125 is no longer parked', async () => {
    expect(await linesOf('N5a')).toEqual({ '4400': '600.00', '2125': '96.00', '1120': '-696.00' });
    expect(await linesOf('N5b')).toEqual({ '4400': '100.00', '2120': '16.00', '1120': '-116.00' });
  });

  it('F · a live allocation that stored no release counts at its pro-rata share, and the line says so', async () => {
    expect(await linesOf('N6')).toEqual({ '4400': '100.00', '2120': '16.00', '1120': '-116.00' });
    const description = await query<{ d: string }>(
      `SELECT l.description AS d FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = $1 AND a.code = '2120'`,
      [notes.N6.entry]
    );
    expect(description.rows[0].d).toMatch(/estimated/);
  });

  it('2125 never goes negative: it ends at S4\'s 72.00, and 2120 at the 664.00 the month caused', async () => {
    expect(await balance('2125')).toBe('-72.00'); // a credit: S4's IVA still to be collected
    expect(await balance('2120')).toBe('-664.00');
  });

  it('the paper takes each note\'s 2120 share out of November, and its tie-out is silent', () => {
    expect({
      base: Number(november.figures.charged.tasa16.base).toFixed(2),
      iva: Number(november.figures.charged.tasa16.iva).toFixed(2),
    }).toEqual({ base: '4150.00', iva: '664.00' });
    expect(november.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(lineOf('N1')?.breakdown.tasa16).toEqual({ base: '-100.0000', iva: '-16.0000' });
    expect(lineOf('N2')?.breakdown.tasa16).toEqual({ base: '-250.0000', iva: '-40.0000' });
    expect(lineOf('N3')).toBeUndefined();
    expect(lineOf('N4')).toBeUndefined();
    expect(lineOf('N5b')?.breakdown.tasa16).toEqual({ base: '-100.0000', iva: '-16.0000' });
    expect(lineOf('N6')?.breakdown.tasa16).toEqual({ base: '-100.0000', iva: '-16.0000' });
  });

  it('the warning of MNE-001-566 is silent on every note this rule split: none debited 2125 beyond what was parked', () => {
    const named = november.findings
      .filter((h) => h.codigo === 'IVA-WP-CREDIT-NOTE-AFTER-COLLECTION')
      .map((h) => h.documentId);
    for (const key of ['N1', 'N2', 'N5b', 'N6']) expect(named, key).not.toContain(notes[key].id);
    expect(named).toEqual([]);
  });
});
