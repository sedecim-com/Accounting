import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment, applyCustomerPayment, unapplyCustomerPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

/**
 * MNE-001-602 (#792, the «Cap, then key» risk of #858) · UNDER
 * plain_receipt_unapply_iva = repark_same_month, A PLAIN RECEIPT WITH ROWS OF
 * TWO MONTHS AND A CREDIT NOTE ON THE INVOICE: THE CAP IS SHARED FIRST, THEN
 * THE ROWS OF THE UNAPPLY'S MONTH RE-PARK THEIR SHARE.
 *
 *   S, PPD 1,000.00 + 160.00, issued 05-10. One receipt R of 1,160.00 by SPEI
 *   on 05-15 applies 696.00 that day (releases 160 × 696 / 1,160 = 96.00); the
 *   rest waits on account and is applied 232.00 on 06-05 (32.00) and 232.00 on
 *   06-10 (the last 32.00). N, 200.00 + 32.00, on 06-12 takes its 32 from 2120
 *   (MNE-001-575): 2120 160 − 32 = 128, 2125 0.
 *   Unapply R from S on 06-20: released 160; S owes 1,160 − 232 = 928 again,
 *   which carries 160 × 928 / 1,160 = 128, so 128 goes back to 2125 (581). The
 *   rows would keep [96, 32, 32]; `capKept` shares the cap of 128 by them:
 *   96 × 0.8 = 76.80, 25.60, and the last row the rest, 25.60. Then the key:
 *   the two June rows re-park (0), the May row keeps 76.80 (later month).
 *   Entry: 1120 Dr 1,160.00 / 2120 Dr 51.20 / 2125 Cr 128.00 / 2150 Cr
 *   1,083.20 (1,160 − 76.80). Ledger: 2125 128.00, 2120 128 − 51.20 = 76.80,
 *   2150 1,083.20. Markers [76.8000, null, null].
 *   The other order (key, then cap) would keep 96 ≤ 128, re-park 32 and leave
 *   2120 at 96.00: this case tells the two apart.
 *   The paper does not follow the key (585). May: 600.00 / 96.00, ties. June:
 *   the applications 400.00 / 64.00 less N 200.00 / 32.00 = 200.00 / 32.00;
 *   the May row ends 76.80 and puts 76.80 back on account. The ledger's June
 *   2120 credits 64 and debits 32 + 51.20, 19.20 net debit: the gap with the
 *   paper's 32.00 is 51.20, the re-park, and the tie-out names it.
 */

const KEY = 'plain_receipt_unapply_iva';
const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';

interface Book { f: Fixture; customerId: string }

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function book(): Promise<Book> {
  const f = await crearInquilino('MNE-001-602 mixed months');
  await seedPolicies({ tenantId: f.tenantId });
  await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY, 'repark_same_month', 'it@example.test');
  // The panel is read in the tenant of the context, as the binary sets it.
  enterTenant(f.tenantId);
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Mixed Months Payer SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-602-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

/** The credit balance of one account over the entity's posted entries, two decimals. */
async function balanceOf(b: Book, code: string): Promise<string> {
  return (await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::numeric(19,2)::text AS s
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = $2`,
    [b.f.entityId, b.f.cuentas[code]]
  )).rows[0].s;
}

/** One entry's lines by account code: debit minus credit, two decimals. */
async function linesOf(b: Book, entryId: string): Promise<Record<string, string>> {
  const r = await query<{ code: string; net: string }>(
    `SELECT a.code, SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::numeric(19,2)::text AS net
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1
      WHERE l.journal_entry_id = $2 GROUP BY a.code`,
    [b.f.entityId, entryId]
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}

const at16 = (wp: Awaited<ReturnType<typeof buildIvaWorkpaper>>) =>
  [Number(wp.figures.charged.tasa16.base).toFixed(2), Number(wp.figures.charged.tasa16.iva).toFixed(2)];

describe('repark_same_month with rows of two months and a credit note: the cap is shared first', () => {
  it('the May row keeps its share of the cap, the June rows re-park theirs, and the paper\'s gap is the re-park', async () => {
    const b = await book();
    const draft = await createInvoice({
      entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: '2026-05-10', due_date: '2026-05-10', currency_code: 'MXN',
      terms: 'PPD',
      lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic fees', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
      created_by: b.f.userId,
    });
    const s = (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
    const r = await recordCustomerPayment({
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: '2026-05-15',
      paymentMethod: 'spei', onAccount: true, applications: [{ documentId: s, amountApplied: '696.00' }],
    }, b.f.userId);
    for (const date of ['2026-06-05', '2026-06-10']) {
      await applyCustomerPayment(b.f.entityId, r.paymentId, [{ documentId: s, amountApplied: '232.00' }], b.f.userId, { date });
    }
    const cn = await createCreditNote({
      entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: s, type: 'devolucion',
      credit_date: '2026-06-12', subtotal: '200.00', tax_amount: '32.00',
    }, b.f.userId);
    await issueCreditNote(b.f.entityId, cn.id, b.f.userId);
    expect([await balanceOf(b, '2120'), await balanceOf(b, '2125')]).toEqual(['128.00', '0.00']);

    const undone = await unapplyCustomerPayment(b.f.entityId, r.paymentId, { invoiceId: s, reason: 'wrong sale', date: '2026-06-20' }, b.f.userId);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused, undone.keptBecause]).toEqual(['51.2000', '76.8000', 'later_month']);
    expect(await linesOf(b, undone.journalEntry.id)).toEqual({ '1120': '1160.00', '2120': '51.20', '2125': '-128.00', '2150': '-1083.20' });
    const rows = await query<{ applied_on: string; kept: string | null }>(
      `SELECT applied_on::text, unapply_kept_iva_amount::text AS kept FROM payment_allocations WHERE payment_id = $1 ORDER BY applied_on`,
      [r.paymentId]
    );
    expect(rows.rows.map((x) => [x.applied_on, x.kept === null ? null : new Decimal(x.kept).toFixed(4)])).toEqual([
      ['2026-05-15', '76.8000'], ['2026-06-05', null], ['2026-06-10', null],
    ]);
    expect([await balanceOf(b, '2125'), await balanceOf(b, '2120'), await balanceOf(b, '2150')]).toEqual(['128.00', '76.80', '1083.20']);

    const may = await buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month: 5 });
    expect(at16(may)).toEqual(['600.00', '96.00']);
    expect(may.findings.find((h) => h.codigo === TIE_OUT)).toBeUndefined();
    const june = await buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month: 6 });
    expect(at16(june)).toEqual(['200.00', '32.00']);
    // The paper's ledger is debit minus credit: 2120's June credits of 64 against its debits of 32 + 51.20.
    expect(new Decimal(june.ledger.iva_trasladado).toFixed(2)).toBe('19.20');
    const gap = june.findings.find((h) => h.codigo === TIE_OUT);
    expect(gap?.mensaje).toContain('el IVA de 51.2000');
    expect(gap?.mensaje).toContain('re-aparcó');
  }, 240_000);
});
