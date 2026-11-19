import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import {
  recordCustomerCheckCashing, recordCustomerChecksCashing, CUSTOMER_CHECK_CASHING_SOURCE,
} from '../../src/services/banking/treasury-posting.js';
import { crearGrupoDeCotejo } from '../../src/services/banking/match-service.js';
import { entityScope } from '../../src/database/scope.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-507 (#700, task 2) · THE IVA PAPER COUNTS A CUSTOMER CHEQUE IN THE
// MONTH OF ITS CASHING, AND SETTLES NO MONTH THAT MAY HOLD ONE UNRECORDED
//
// A price paid by cheque, and its IVA, is paid the day the cheque is cashed
// (LIVA art. 1-B, second paragraph). Since MNE-001-556 the ledger holds a
// cheque's IVA in 2125 until `bank check reconcile --receipt` records the
// bank credit that cashed it; the paper now counts it there too.
//
// One entity per story: an MXN account whose May and June 2026 statements are
// imported, a PPD invoice of 1,000.00 + 160.00 issued 2026-05-10, and a
// cheque of 1,160.00 received for it on 2026-05-30, unless a case says
// otherwise. Receipts go through the service; only the bank's statements and
// lines are inserted, as the 506 spec does.
// ============================================================

const day = (month: number, d: number): string => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

interface Book {
  f: Fixture;
  customerId: string;
  account: string;
}

let nextGl = 0;

async function bankAccount(f: Fixture, name: string, currency = 'MXN'): Promise<string> {
  nextGl += 1;
  const gl = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, $3, 'asset', 'current_assets', $4, $5, 'debit', $6)`,
    [gl, `1110-7${nextGl}`, `Bank ${name}`, f.entityId, currency, f.userId]
  );
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, $5, 'checking')`,
    [id, f.entityId, name, gl, currency]
  );
  return id;
}

/** An imported statement of `account` for one month. */
async function statement(b: Book, month: number, account = b.account, currency = 'MXN'): Promise<void> {
  const end = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  await query(
    `INSERT INTO bank_statements (entity_id, bank_account_id, period_start, period_end, opening_balance, closing_balance,
                                  currency_code, source_format, file_sha256, imported_by)
     VALUES ($1, $2, $3::date, $4::date, 0, 0, $5, 'manual', $6, $7)`,
    [b.f.entityId, account, day(month, 1), day(month, end), currency, uuidv4().replace(/-/g, '').padEnd(64, '0'), b.f.userId]
  );
}

/** A line of the bank statement. */
async function bankLine(account: string, date: string, amount: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, $3::date, $4, 'credit', 'synthetic deposit', false)`,
    [id, account, date, amount]
  );
  return id;
}

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-507 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Cheque Paper SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-507-${customerId.slice(0, 6)}`, f.userId]
  );
  const b = { f, customerId, account: await bankAccount(f, `Operating 507 ${name}`) };
  await statement(b, 5);
  await statement(b, 6);
  return b;
}

async function ppd(b: Book): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: day(5, 10), due_date: day(5, 10),
    currency_code: 'MXN', terms: 'PPD',
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: '1000.00', tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

/** A receipt of 2026-05-30 that settles `invoiceId` (or `amount` of it). */
async function collect(
  b: Book, invoiceId: string, method = 'check', amount = '1160.00', bankAccountId: string | null = b.account, checkNumber = 'CHQ-507'
) {
  return recordCustomerPayment(
    {
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: day(5, 30),
      paymentMethod: method, bankAccountId, checkNumber: method === 'check' ? checkNumber : null,
      applications: [{ documentId: invoiceId, amountApplied: amount }],
    },
    b.f.userId
  );
}

const cash = (b: Book, receiptId: string, credit: string) =>
  recordCustomerCheckCashing(b.f.entityId, receiptId, { transactionId: credit, userId: b.f.userId });

/** `receipt reverse` has no --date: its mirrors take the clock's day. */
async function reverseOn(b: Book, paymentId: string, date: string) {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(`${date}T12:00:00`));
  try {
    return await reverseCustomerPayment(b.f.entityId, paymentId, { reason: 'returned unpaid' }, b.f.userId);
  } finally {
    vi.useRealTimers();
  }
}

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });

const codes = (wp: IvaWorkpaper): string[] => wp.findings.map((h) => h.codigo);
const NOT_CASHED = 'IVA-WP-CHEQUE-NOT-CASHED';
const MAY_BE_CASHED = 'IVA-WP-CHEQUE-CASHING-UNRECORDED';
const checkFinding = (wp: IvaWorkpaper, paymentId: string) =>
  wp.findings.find((h) => [NOT_CASHED, MAY_BE_CASHED].includes(h.codigo) && h.documentId === paymentId);
const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});
const contribution = (wp: IvaWorkpaper, id: string) => wp.contributions.charged.find((c) => c.documentId === id);

/** A month that warns of the cheque, and settles. */
function warns(wp: IvaWorkpaper, paymentId: string): string {
  const h = checkFinding(wp, paymentId);
  expect(h).toMatchObject({ codigo: NOT_CASHED, severidad: 'aviso' });
  expect(wp.settlement).not.toBeNull();
  return h!.mensaje;
}

/** A month that blocks on the cheque, and settles nothing. */
function blocks(wp: IvaWorkpaper, paymentId: string): string {
  const h = checkFinding(wp, paymentId);
  expect(h).toMatchObject({ codigo: MAY_BE_CASHED, severidad: 'bloqueante' });
  expect(wp.settlement).toBeNull();
  expect(wp.blockedBy).toContain(MAY_BE_CASHED);
  return h!.mensaje;
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a cheque counts in the month the bank cashed it', () => {
  it('May counts nothing for the invoice; June counts 1,000.00 / 160.00 traced to the cashing entry; the ledger agrees in both', async () => {
    const b = await book('cashed');
    const inv = await ppd(b);
    const receipt = await collect(b, inv);
    const cashed = await cash(b, receipt.paymentId, await bankLine(b.account, day(6, 1), '1160.00'));
    expect(cashed).toMatchObject({ released: '160.0000' });

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(may, inv)).toBeUndefined();
    expect(may.ledger.iva_trasladado).toBe('0.0000');

    expect(at16(june)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(contribution(june, inv)?.entryIds).toEqual([cashed.entryId]);
    const kinds = await query<{ source_type: string }>(
      'SELECT source_type FROM journal_entries WHERE id = $1 AND entity_id = $2', [cashed.entryId, b.f.entityId]
    );
    expect(kinds.rows[0].source_type).toBe(CUSTOMER_CHECK_CASHING_SOURCE);
    expect(june.ledger.iva_trasladado).toBe('-160.0000');

    for (const wp of [may, june]) {
      expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
      expect(checkFinding(wp, receipt.paymentId)).toBeUndefined();
      expect(wp.settlement).not.toBeNull();
    }
  }, 120_000);

  it('a cheque posted before the hold keeps its receipt day, as its entry did', async () => {
    const b = await book('posted before');
    const inv = await ppd(b);
    const receipt = await collect(b, inv, 'spei');
    await query(`UPDATE customer_payments SET payment_method = 'check' WHERE id = $1`, [receipt.paymentId]);
    await cash(b, receipt.paymentId, await bankLine(b.account, day(6, 1), '1160.00'));

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(contribution(may, inv)?.entryIds).toEqual([receipt.journalEntry!.id]);
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    for (const wp of [may, june]) {
      expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
      expect(checkFinding(wp, receipt.paymentId)).toBeUndefined();
    }
  }, 120_000);
});

describe('a cheque with no cashing recorded', () => {
  it('May warns with the cheque, its date and IVA, and settles; June, holding a credit of its amount, blocks', async () => {
    const b = await book('not cashed');
    const inv = await ppd(b);
    const receipt = await collect(b, inv);
    const credit = await bankLine(b.account, day(6, 1), '1160.00');

    const may = await paper(b, 5);
    const said = warns(may, receipt.paymentId);
    expect(said).toContain('CHQ-507');
    expect(said).toContain(receipt.paymentNumber);
    expect(said).toContain('2026-05-30');
    expect(said).toContain('160.0000');
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');

    const june = await paper(b, 6);
    const blocked = blocks(june, receipt.paymentId);
    expect(blocked).toContain('CHQ-507');
    expect(blocked).toContain('2026-05-30');
    expect(blocked).toContain('160.0000');
    expect(blocked).toContain(credit);
    expect(blocked).toContain('bank check reconcile --receipt');
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
  }, 120_000);

  it('a grouped credit of 1,740.00 is open for it too, and June blocks', async () => {
    const b = await book('grouped credit');
    const receipt = await collect(b, await ppd(b));
    const credit = await bankLine(b.account, day(6, 1), '1740.00');
    expect(warns(await paper(b, 5), receipt.paymentId)).toContain('160.0000');
    expect(blocks(await paper(b, 6), receipt.paymentId)).toContain(credit);
  }, 120_000);

  it('June warns and settles when its statement holds no open credit: a smaller one, or one another cheque holds as its cashing', async () => {
    const b = await book('no open credit');
    const receipt = await collect(b, await ppd(b));
    await bankLine(b.account, day(6, 2), '1159.99');
    const held = await bankLine(b.account, day(6, 3), '1160.00');
    const other = await collect(b, await ppd(b), 'check', '1160.00', b.account, 'CHQ-OTHER');
    await cash(b, other.paymentId, held);

    warns(await paper(b, 6), receipt.paymentId);
  }, 120_000);

  it('a credit matched to the cheque itself is open; one matched to another receipt is not', async () => {
    const b = await book('matched credit');
    const receipt = await collect(b, await ppd(b));
    const transfer = await collect(b, await ppd(b), 'spei');
    const scope = entityScope(b.f.tenantId, b.f.entityId);
    const toOther = await bankLine(b.account, day(6, 4), '1160.00');
    await crearGrupoDeCotejo(scope, { cuentaId: b.account, banco: [toOther], libros: [{ tipo: 'customer_payment', id: transfer.paymentId }] }, { userId: b.f.userId });
    warns(await paper(b, 6), receipt.paymentId);

    const toItself = await bankLine(b.account, day(6, 5), '1160.00');
    await crearGrupoDeCotejo(scope, { cuentaId: b.account, banco: [toItself], libros: [{ tipo: 'customer_payment', id: receipt.paymentId }] }, { userId: b.f.userId });
    expect(blocks(await paper(b, 6), receipt.paymentId)).toContain(toItself);
  }, 120_000);

  it('a month its account\'s statement does not cover blocks, with no credit at all', async () => {
    const b = await book('no statement');
    const receipt = await collect(b, await ppd(b));
    const july = await paper(b, 7);
    expect(blocks(july, receipt.paymentId)).toContain('estado de cuenta');
  }, 120_000);

  it('a receipt with no account (a REP) looks at every account in its currency, and only in it', async () => {
    const b = await book('no account');
    const savings = await bankAccount(b.f, 'Savings 507');
    const dollars = await bankAccount(b.f, 'Dollars 507', 'USD');
    for (const m of [5, 6]) await statement(b, m, savings);
    const receipt = await collect(b, await ppd(b), 'check', '1160.00', null);
    await bankLine(dollars, day(5, 31), '1160.00');
    warns(await paper(b, 5), receipt.paymentId);

    const credit = await bankLine(savings, day(6, 6), '1160.00');
    expect(blocks(await paper(b, 6), receipt.paymentId)).toContain(credit);
  }, 120_000);

  it('a cheque cashed once the credit is recorded stops blocking, and its month counts it', async () => {
    const b = await book('cashed later');
    const receipt = await collect(b, await ppd(b));
    const credit = await bankLine(b.account, day(6, 1), '1160.00');
    blocks(await paper(b, 6), receipt.paymentId);
    await recordCustomerChecksCashing(b.f.entityId, [receipt.paymentId], { transactionId: credit, userId: b.f.userId });
    const june = await paper(b, 6);
    expect(checkFinding(june, receipt.paymentId)).toBeUndefined();
    expect(june.settlement).not.toBeNull();
    expect(at16(june)).toEqual({ base: '1000.00', iva: '160.00' });
  }, 120_000);
});

describe('the undo of a cheque before its cashing', () => {
  it('unapplied on 2026-05-31 and cashed on 2026-06-01: May lists no ended share and no taxed cash; June counts the cash on account as received that day', async () => {
    const b = await book('unapplied');
    const inv = await ppd(b);
    const receipt = await collect(b, inv);
    await unapplyCustomerPayment(b.f.entityId, receipt.paymentId, { invoiceId: inv, reason: 'wrong invoice', date: day(5, 31) }, b.f.userId);
    await cash(b, receipt.paymentId, await bankLine(b.account, day(6, 1), '1160.00'));

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(may, inv)).toBeUndefined();
    expect(contribution(may, receipt.paymentId)).toBeUndefined();

    expect(contribution(june, inv)).toBeUndefined();
    expect(contribution(june, receipt.paymentId)).toMatchObject({
      documentKind: 'receipt', breakdown: { tasa16: { base: '1000.0000', iva: '160.0000' } },
    });
    expect(at16(june)).toEqual({ base: '1000.00', iva: '160.00' });
  }, 120_000);

  it('reversed before any cashing, no month counts or names it', async () => {
    const b = await book('reversed');
    const inv = await ppd(b);
    const receipt = await collect(b, inv);
    await reverseOn(b, receipt.paymentId, day(6, 10));

    for (const wp of [await paper(b, 5), await paper(b, 6)]) {
      expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
      expect(wp.findings.filter((h) => h.documentId === receipt.paymentId)).toEqual([]);
      expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
      expect(wp.settlement).not.toBeNull();
    }
  }, 120_000);
});

// MNE-001-558 records an advance received by cheque: its receipt holds it whole in 2150, and the cashing posts
// DR 2150 / CR 2120 for its IVA on the bank credit's day (#623, comment 6961035083).
describe('an advance received by cheque', () => {
  it('counts nothing in May and 1,000.00 / 160.00 in June, traced to the cashing entry, and the ledger agrees in both', async () => {
    const b = await book('advance');
    const receipt = await recordCustomerPayment(
      {
        entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: day(5, 30),
        paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-507-ADV',
        applications: [], onAccount: true, advanceTreatment: '16',
      },
      b.f.userId
    );
    const cashed = await cash(b, receipt.paymentId, await bankLine(b.account, day(6, 1), '1160.00'));
    expect(cashed).toMatchObject({ released: '160.0000', advanceIva: '160.0000' });

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(contribution(may, receipt.paymentId)).toBeUndefined();
    expect(may.ledger.iva_trasladado).toBe('0.0000');

    expect(at16(june)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(contribution(june, receipt.paymentId)).toMatchObject({
      documentKind: 'receipt', entryIds: [cashed.entryId], breakdown: { tasa16: { base: '1000.0000', iva: '160.0000' } },
    });
    expect(june.ledger.iva_trasladado).toBe('-160.0000');

    for (const wp of [may, june]) {
      expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
      expect(checkFinding(wp, receipt.paymentId)).toBeUndefined();
      expect(wp.settlement).not.toBeNull();
    }
  }, 120_000);
});
