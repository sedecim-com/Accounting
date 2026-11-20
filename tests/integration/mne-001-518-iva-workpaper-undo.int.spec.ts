import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, applyCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-518 (#666) · THE IVA WORKPAPER TREATS EACH UNDO OF A COLLECTION BY
// WHAT HAPPENED TO THE MONEY, AND EACH MONTH NAMES THE LATER EVENT THAT MOVED IT
//
// The answer of 17 Nov 2026 on #666 (comment 6948200519), every figure by hand:
//
//   1. Unapply: the cash stays with the firm, so its IVA stays caused (LIVA
//      art. 1-B). May keeps 1,000.00 / 160.00; June lists the ended share
//      (−1,000.00 / −160.00) and the same cash back on account (+1,000.00 /
//      +160.00), netting 0. Since MNE-001-574 the ledger keeps the 160.00
//      caused too (the owner's «Mantener causado», #623 comment 7013109077),
//      so June is silent. Reapplied, the cash on account is netted where it
//      is applied, in the paper and in the ledger.
//   2. Cheque reversal: a returned cheque was never cashed (art. 1-B, second
//      paragraph): the receipt counts in no month, and each month names it.
//   3. Any other method: the collection month keeps its IVA and the reversal
//      takes none out; both name it, and a person decides.
//
// One entity per story, a PPD invoice of 1,160.00 (1,000.00 + 160.00) issued
// 2026-05-10 and collected in full on 2026-05-20, unless a case says otherwise.
// ============================================================

const day = (month: number, d: number, year = 2026): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

interface Book {
  f: Fixture;
  customerId: string;
}

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-518 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Undo Paper SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-518-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

async function ppd(b: Book, date = day(5, 10)): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: 'PPD',
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: '1000.00', tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

async function collect(b: Book, invoiceIds: string[], method = 'spei', date = day(5, 20), bankAccountId?: string) {
  return recordCustomerPayment(
    {
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: (1160 * invoiceIds.length).toFixed(2),
      paymentDate: date, paymentMethod: method, ...(bankAccountId ? { bankAccountId } : {}),
      applications: invoiceIds.map((documentId) => ({ documentId, amountApplied: '1160.00' })),
    },
    b.f.userId
  );
}

/** A cheque whose own entry caused its IVA, as one posted before MNE-001-556 did. */
async function markAsCheck(paymentId: string): Promise<void> {
  await query(`UPDATE customer_payments SET payment_method = 'check' WHERE id = $1`, [paymentId]);
}

const unapply = (b: Book, paymentId: string, invoiceId: string, date: string) =>
  unapplyCustomerPayment(b.f.entityId, paymentId, { invoiceId, reason: 'wrong invoice', date }, b.f.userId);

const apply = (b: Book, paymentId: string, invoiceId: string, date: string) =>
  applyCustomerPayment(b.f.entityId, paymentId, [{ documentId: invoiceId, amountApplied: '1160.00' }], b.f.userId, { date });

/** `receipt reverse` has no --date: its mirrors take the clock's day. */
async function reverseOn(b: Book, paymentId: string, date: string) {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(`${date}T12:00:00`));
  try {
    return await reverseCustomerPayment(b.f.entityId, paymentId, { reason: 'returned' }, b.f.userId);
  } finally {
    vi.useRealTimers();
  }
}

const paper = (b: Book, month: number, year = 2026): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year, month });

const codes = (wp: IvaWorkpaper): string[] => wp.findings.map((h) => h.codigo);
const finding = (wp: IvaWorkpaper, code: string) => wp.findings.find((h) => h.codigo === code);
const reversalOf = (wp: IvaWorkpaper, paymentId: string) =>
  wp.findings.find((h) => h.codigo === 'IVA-WP-RECEIPT-REVERSED' && h.documentId === paymentId);

const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});
const contribution = (wp: IvaWorkpaper, id: string) => wp.contributions.charged.find((c) => c.documentId === id);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('rule 1 · an unapply moves no IVA while the firm holds the cash', () => {
  it('May keeps its share; June lists the ended share and the cash back, traced to the unapply, and the ledger agrees', async () => {
    const b = await book('unapply');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    const undone = await unapply(b, receipt.paymentId, inv, day(6, 10));

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');

    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(june, inv)).toMatchObject({
      documentKind: 'invoice', breakdown: { tasa16: { base: '-1000.0000', iva: '-160.0000' } },
    });
    expect(contribution(june, receipt.paymentId)).toMatchObject({
      documentKind: 'receipt', breakdown: { tasa16: { base: '1000.0000', iva: '160.0000' } },
    });
    expect(contribution(june, inv)?.entryIds).toContain(undone.journalEntry.id);
    expect(contribution(june, receipt.paymentId)?.entryIds).toEqual([undone.journalEntry.id]);
    // MNE-001-574: the ledger keeps the share caused, so 2120 does not move and June is silent.
    expect(june.ledger.iva_trasladado).toBe('0.0000');
    expect(codes(june)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 120_000);

  it('reapplied in the same month, June nets to 0 and is silent', async () => {
    const b = await book('reapplied in June');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    await unapply(b, receipt.paymentId, inv, day(6, 10));
    await apply(b, receipt.paymentId, inv, day(6, 20));

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(june.ledger.iva_trasladado).toBe('0.0000');
    for (const wp of [may, june]) expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 120_000);

  it('reapplied in July, July adds 0, and the application takes the cash already taxed in the ledger too', async () => {
    const b = await book('reapplied in July');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    await unapply(b, receipt.paymentId, inv, day(6, 10));
    await apply(b, receipt.paymentId, inv, day(7, 5));

    const [may, june, july] = [await paper(b, 5), await paper(b, 6), await paper(b, 7)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(july)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(july, inv)?.breakdown.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(contribution(july, receipt.paymentId)?.breakdown.tasa16).toEqual({ base: '-1000.0000', iva: '-160.0000' });
    // MNE-001-574: the application nets the 160.00 the cash carries against the share it releases.
    expect(july.ledger.iva_trasladado).toBe('0.0000');
    for (const wp of [june, july]) expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 120_000);

  it('a partial unapply nets only its own iva_reclass_amount', async () => {
    const b = await book('partial');
    const [one, two] = [await ppd(b), await ppd(b)];
    const receipt = await collect(b, [one, two]);
    await unapply(b, receipt.paymentId, one, day(6, 10));

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '2000.00', iva: '320.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(june, one)?.breakdown.tasa16).toEqual({ base: '-1000.0000', iva: '-160.0000' });
    expect(contribution(june, two)).toBeUndefined();
    expect(contribution(june, receipt.paymentId)?.breakdown.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(june.ledger.iva_trasladado).toBe('0.0000');
  }, 120_000);

  it('undone in its own month, the share still counts there: only a cheque reversal counts in no month', async () => {
    const b = await book('own month');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    await unapply(b, receipt.paymentId, inv, day(5, 25));
    const may = await paper(b, 5);
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 120_000);

  // MNE-001-574 posts what this case used to simulate with a synthetic entry: 2120 is not debited.
  it('the ledger does not re-park, so the month is silent', async () => {
    const b = await book('no re-park');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    await unapply(b, receipt.paymentId, inv, day(6, 10));
    const june = await paper(b, 6);
    expect(june.ledger.iva_trasladado).toBe('0.0000');
    expect(codes(june)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(june, receipt.paymentId)?.breakdown.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
  }, 120_000);
});

describe('rule 2 · a cheque reversal counts in no month', () => {
  it('May drops the share, names the reversal and the amended return; June counts nothing and names its mirror', async () => {
    const b = await book('cheque reversal');
    const gl = uuidv4();
    await query(
      `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
       VALUES ($1, '1110-518', 'Bank 518', 'asset', 'current_assets', $2, 'MXN', 'debit', $3)`,
      [gl, b.f.entityId, b.f.userId]
    );
    const bank = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1, $2, 'Bank 518', 'Bank', $3, 'MXN', 'checking')`,
      [bank, b.f.entityId, gl]
    );
    const credit = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
       VALUES ($1, $2, '2026-05-25', '1160.00', 'credit', 'synthetic deposit', false)`,
      [credit, bank]
    );
    const inv = await ppd(b);
    const receipt = await collect(b, [inv], 'check', day(5, 20), bank);
    await recordCustomerCheckCashing(b.f.entityId, receipt.paymentId, { transactionId: credit, userId: b.f.userId });
    expect(at16(await paper(b, 5))).toEqual({ base: '1000.00', iva: '160.00' });

    const reversed = await reverseOn(b, receipt.paymentId, day(6, 10));
    const mirror = reversed.reversals.find((r) => r.of === receipt.journalEntry!.entry_number)!.entryNumber;

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    const inMay = reversalOf(may, receipt.paymentId);
    expect(inMay?.mensaje).toContain('2026-06-10');
    expect(inMay?.mensaje).toContain(mirror);
    expect(inMay?.mensaje).toContain('1000.0000');
    expect(inMay?.mensaje).toContain('160.0000');
    expect(inMay?.mensaje).toContain('complementaria');
    expect(finding(may, 'IVA-WP-CHARGED-VS-LEDGER')?.mensaje).toContain(receipt.paymentNumber);

    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(june.ledger.iva_trasladado).toBe('160.0000');
    expect(reversalOf(june, receipt.paymentId)?.mensaje).toContain(mirror);
    expect(finding(june, 'IVA-WP-CHARGED-VS-LEDGER')?.mensaje).toContain(receipt.paymentNumber);
  }, 120_000);

  it('reversed in its own month, it counts in no month', async () => {
    const b = await book('cheque own month');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    await markAsCheck(receipt.paymentId);
    await reverseOn(b, receipt.paymentId, day(5, 28));
    const may = await paper(b, 5);
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(reversalOf(may, receipt.paymentId)).toBeDefined();
  }, 120_000);

  it('reversed across the year end, both months name the December return', async () => {
    const b = await book('year end');
    const fy = uuidv4();
    await query(
      `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
       VALUES ($1, $2, 2027, '2027-01-01', '2027-12-31', true, 'open')`,
      [fy, b.f.entityId]
    );
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
       VALUES ($1, $2, $3, 1, 'Periodo 1/2027', '2027-01-01', '2027-01-31', 'open')`,
      [uuidv4(), fy, b.f.entityId]
    );
    const inv = await ppd(b, day(12, 10));
    const receipt = await collect(b, [inv], 'spei', day(12, 15));
    await markAsCheck(receipt.paymentId);
    await reverseOn(b, receipt.paymentId, day(1, 10, 2027));

    const [december, january] = [await paper(b, 12), await paper(b, 1, 2027)];
    expect(at16(december)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(december, receipt.paymentId)?.mensaje).toContain('2026-12');
    expect(reversalOf(january, receipt.paymentId)?.mensaje).toContain('2026-12');
  }, 120_000);
});

describe('rule 3 · a reversal by any other method takes no IVA out', () => {
  it('by credit_card, May keeps 1,000.00 / 160.00 and June counts 0, and both name it', async () => {
    const b = await book('card reversal');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv], 'credit_card');
    const reversed = await reverseOn(b, receipt.paymentId, day(6, 10));
    const mirror = reversed.reversals.find((r) => r.of === receipt.journalEntry!.entry_number)!.entryNumber;

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(reversalOf(may, receipt.paymentId)?.mensaje).toContain(mirror);
    expect(reversalOf(may, receipt.paymentId)?.mensaje).toContain('art. 7');
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(june, receipt.paymentId)?.mensaje).toContain(mirror);
  }, 120_000);

  it('reversed in its own month by spei, the share stays in May', async () => {
    const b = await book('spei own month');
    const inv = await ppd(b);
    const receipt = await collect(b, [inv]);
    await reverseOn(b, receipt.paymentId, day(5, 28));
    const may = await paper(b, 5);
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(reversalOf(may, receipt.paymentId)).toBeDefined();
  }, 120_000);
});

describe('an advance of 1,160.00 reversed on 2026-06-10', () => {
  const advance = async (b: Book) =>
    recordCustomerPayment(
      {
        entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: day(5, 10),
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      b.f.userId
    );

  it('by spei stays in May', async () => {
    const b = await book('advance spei');
    const receipt = await advance(b);
    await reverseOn(b, receipt.paymentId, day(6, 10));
    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(may, receipt.paymentId)).toBeDefined();
    expect(reversalOf(june, receipt.paymentId)).toBeDefined();
  }, 120_000);

  it('by cheque counts in no month', async () => {
    const b = await book('advance cheque');
    const receipt = await advance(b);
    await markAsCheck(receipt.paymentId);
    await reverseOn(b, receipt.paymentId, day(6, 10));
    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(may, receipt.paymentId)?.mensaje).toContain('complementaria');
  }, 120_000);
});
