import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, applyCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-590 (#792) · A PLAIN RECEIPT UNAPPLIED FROM A PPD INVOICE KEEPS ITS
 * IEPS CAUSED, AND THAT IEPS IS CAUSED ONCE.
 *
 * IEPS on a sale is caused «en el momento en el que se cobren las
 * contraprestaciones y sobre el monto de lo cobrado» (LIEPS art. 10), with
 * LIVA's tests of collection (art. 5o.-C). An unapply returns no money, so the
 * IEPS caused on the cash stays in 2180. The invoice is owed again, so its
 * IEPS goes back to 2181. The cash back on account carries the IEPS, as it
 * carries the IVA (MNE-001-574), and a later application nets it against the
 * share it releases: CR 2180 r − e, DR when negative, no line at zero.
 *
 * Invoice A (and B) is PPD: 1,000.00 + IEPS 8 % 80.00 on 2181, and IVA 16 %
 * on 1,080.00 = 172.80, so 1,252.80. C is PPD 1,000.00 + 160.00 with no IEPS.
 * Dates are in 2026; receipts are by transfer. Every figure is computed by hand.
 */

let mx: Fixture;
let customerId: string;
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Runs `receipt <argv> --json -y` in process as the binary would. */
async function leaf(argv: string[]): Promise<Record<string, string>> {
  const out: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, { palette: plain, shutdown: () => undefined, reportError: (e: unknown) => { errors.push(e); } });
    await program.parseAsync(['node', 'mnemosine', 'receipt', ...argv, '-e', mx.entityId, '-t', mx.tenantId, '-y', '--json']);
  } catch (e) {
    errors.push(e);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) throw new Error(`receipt ${argv.join(' ')} → ${exitCodeFor(errors[0])}: ${(errors[0] as Error).message}`);
  return (JSON.parse(out.join('')) as { rows: Record<string, string>[] }).rows[0];
}

/** An issued PPD invoice of 1,000.00 at 16 %; with `ieps`, a line of 80.00 on 2181 as #699's fixture. */
async function invoice(o: { ieps?: boolean; date?: string } = {}): Promise<{ id: string; number: string }> {
  const date = o.date ?? '2026-05-10';
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: 'PPD',
    lines: [
      { revenue_account_id: mx.cuentas['4100'] ?? mx.roles.ingreso, description: 'Synthetic goods', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' },
      ...(o.ieps === false ? [] : [{ revenue_account_id: mx.cuentas['2181'], description: 'IEPS 8 % transferred', quantity: '1', unit_price: '80.00', tax_rate: '16.0000' }]),
    ],
    created_by: mx.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** A posted entry's lines by account code, each as [debit, credit] at 4 dp. */
async function linesOf(entry: string): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND (je.entry_number = $2 OR je.id::text = $2)
      GROUP BY a.code`,
    [mx.entityId, entry]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [new Decimal(l.debit).toFixed(4), new Decimal(l.credit).toFixed(4)]]));
}

/** Only the tax lines of an entry: 2120, 2125, 2180 and 2181. */
async function taxLinesOf(entry: string): Promise<Record<string, [string, string]>> {
  const all = await linesOf(entry);
  return Object.fromEntries(Object.entries(all).filter(([code]) => ['2120', '2125', '2180', '2181'].includes(code)));
}

const dr = (x: string): [string, string] => [new Decimal(x).toFixed(4), '0.0000'];
const cr = (x: string): [string, string] => ['0.0000', new Decimal(x).toFixed(4)];

type Codes = '2120' | '2125' | '2150' | '2180' | '2181';
/** Credit balances of the posted ledger on the five accounts this task moves. */
async function balances(): Promise<Record<Codes, string>> {
  const r = await query<{ code: Codes; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
      WHERE a.entity_id = $1 AND a.code IN ('2120', '2125', '2150', '2180', '2181') GROUP BY a.code`,
    [mx.entityId]
  );
  const of = (c: Codes) => new Decimal(r.rows.find((x) => x.code === c)?.b ?? 0).toFixed(4);
  return { '2120': of('2120'), '2125': of('2125'), '2150': of('2150'), '2180': of('2180'), '2181': of('2181') };
}

const since = async (before: Record<Codes, string>) => {
  const now = await balances();
  return Object.fromEntries((Object.keys(now) as Codes[]).map((k) => [k, new Decimal(now[k]).minus(before[k]).toFixed(4)]));
};

const record = (inv: string, amount: string, date = '2026-05-15') => leaf(['record', inv, '--amount', amount, '--date', date]);
const unapply = (pmt: string, inv: string, date = '2026-05-20') =>
  leaf(['unapply', pmt, '--invoice', inv, '--reason', 'applied to the wrong sale', '--date', date]);
const apply = (pmt: string, target: string, date = '2026-05-25') => leaf(['apply', pmt, '--invoice', target, '--date', date]);

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-590 kept IEPS MX');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Kept IEPS Payer SA', 'MXN', $4)`,
    [customerId, mx.entityId, `C-590-${customerId.slice(0, 6)}`, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('P1 · the issue\'s case: collected, unapplied, applied to B, and A collected again in June', () => {
  it('each invoice\'s IEPS is caused once: May causes 80.00 and June 80.00', async () => {
    const before = await balances();
    const a = await invoice();
    expect(await since(before)).toMatchObject({ '2181': '80.0000', '2180': '0.0000' });

    const p = await record(a.number, '1252.80');
    expect(await taxLinesOf(p.journal_entry)).toEqual({ '2125': dr('172.80'), '2120': cr('172.80'), '2181': dr('80'), '2180': cr('80') });
    expect(await since(before)).toMatchObject({ '2180': '80.0000', '2181': '0.0000', '2150': '0.0000' });

    // The IEPS stays caused in 2180, and A's 80.00 goes back to 2181 because A is owed again.
    const undone = await unapply(p.payment_number, a.number);
    expect(await linesOf(undone.entry_number)).toEqual({
      '1120': dr('1252.80'), '2150': cr('1000'), '2125': cr('172.80'), '2181': cr('80'),
    });
    expect(await since(before)).toMatchObject({ '2180': '80.0000', '2181': '80.0000', '2150': '1000.0000' });

    const b = await invoice({ date: '2026-05-22' });
    expect(await since(before)).toMatchObject({ '2180': '80.0000', '2181': '160.0000', '2150': '1000.0000' });

    // The cash carries 172.80 of IVA and 80.00 of IEPS, both caused: B's shares net against them.
    const toB = await apply(p.payment_number, `${b.number}:1252.80`);
    expect(await linesOf(toB.journal_entry)).toEqual({
      '2150': dr('1000'), '2125': dr('172.80'), '2181': dr('80'), '1120': cr('1252.80'),
    });
    const may = await since(before);
    expect(may).toMatchObject({ '2180': '80.0000', '2181': '80.0000', '2150': '0.0000' });

    const q = await record(a.number, '1252.80', '2026-06-10');
    expect(await taxLinesOf(q.journal_entry)).toEqual({ '2125': dr('172.80'), '2120': cr('172.80'), '2181': dr('80'), '2180': cr('80') });
    const end = await since(before);
    expect(end).toMatchObject({ '2120': '345.6000', '2125': '0.0000', '2150': '0.0000', '2180': '160.0000', '2181': '0.0000' });
    expect(new Decimal(end['2180']).minus(may['2180']).toFixed(4)).toBe('80.0000');
  }, 180_000);
});

describe('P2 · a partial: 626.40 to B, twice', () => {
  it('each half takes 40.00 of the cash\'s IEPS against B\'s 40.00, the second the remainder', async () => {
    const before = await balances();
    const a = await invoice();
    const p = await record(a.number, '1252.80');
    await unapply(p.payment_number, a.number);
    const b = await invoice({ date: '2026-05-22' });

    // c = 172.80 × 626.40 / 1,252.80 = 86.40 and e = 80 × 626.40 / 1,252.80 = 40.00; B releases 86.40 and 40.00.
    const first = await apply(p.payment_number, `${b.number}:626.40`, '2026-05-25');
    expect(await linesOf(first.journal_entry)).toEqual({
      '2150': dr('500'), '2125': dr('86.40'), '2181': dr('40'), '1120': cr('626.40'),
    });
    expect(await since(before)).toMatchObject({ '2180': '80.0000', '2181': '120.0000', '2150': '500.0000' });

    const second = await apply(p.payment_number, `${b.number}:626.40`, '2026-05-26');
    expect(await linesOf(second.journal_entry)).toEqual({
      '2150': dr('500'), '2125': dr('86.40'), '2181': dr('40'), '1120': cr('626.40'),
    });
    expect(await since(before)).toMatchObject({ '2120': '172.8000', '2125': '172.8000', '2150': '0.0000', '2180': '80.0000', '2181': '80.0000' });
  }, 180_000);
});

describe('P3 · the cash goes to C, which carries no IEPS, and the rest back to A', () => {
  it('C takes 74.0741 of IEPS out of 2180, and the last 92.80 takes the remainder against A\'s own share', async () => {
    const before = await balances();
    const a = await invoice();
    const p = await record(a.number, '1252.80');
    await unapply(p.payment_number, a.number);
    const c = await invoice({ ieps: false, date: '2026-05-22' });

    // c = 172.80 × 1,160 / 1,252.80 = 160.0000 and e = 80 × 1,160 / 1,252.80 = 74.0741; C releases g 160 and r 0.
    const toC = await apply(p.payment_number, `${c.number}:1160.00`, '2026-05-25');
    expect(await linesOf(toC.journal_entry)).toEqual({
      '2150': dr('925.9259'), '2125': dr('160'), '2180': dr('74.0741'), '1120': cr('1160'),
    });
    expect(await since(before)).toMatchObject({ '2180': '5.9259', '2181': '80.0000', '2150': '74.0741' });

    // The pool keeps 92.80 carrying 12.80 and 5.9259; A releases 12.80 and 80 × 92.80 / 1,252.80 = 5.9259.
    const toA = await apply(p.payment_number, `${a.number}:92.80`, '2026-05-26');
    expect(await linesOf(toA.journal_entry)).toEqual({
      '2150': dr('74.0741'), '2125': dr('12.80'), '2181': dr('5.9259'), '1120': cr('92.80'),
    });
    // 2180 holds A's share of the 92.80 collected, and 2181 the IEPS of A's 1,160.00 still owed.
    expect(await since(before)).toMatchObject({
      '2120': '172.8000', '2125': '160.0000', '2150': '0.0000', '2180': '5.9259', '2181': '74.0741',
    });
  }, 180_000);
});

describe('P4 · applied again to the same invoice, and a reversal', () => {
  it('the IEPS goes back to 2181 and the application takes it again: the balances end as before the unapply', async () => {
    const before = await balances();
    const a = await invoice();
    const p = await record(a.number, '1252.80');
    await unapply(p.payment_number, a.number);

    const again = await apply(p.payment_number, `${a.number}:1252.80`);
    expect(await linesOf(again.journal_entry)).toEqual({
      '2150': dr('1000'), '2125': dr('172.80'), '2181': dr('80'), '1120': cr('1252.80'),
    });
    expect(await since(before)).toMatchObject({ '2120': '172.8000', '2125': '0.0000', '2150': '0.0000', '2180': '80.0000', '2181': '0.0000' });
  }, 120_000);

  it('a reversal after the unapply mirrors every entry: 2181 holds A\'s 80.00 and 2180 nothing', async () => {
    const before = await balances();
    const a = await invoice();
    const p = await record(a.number, '1252.80');
    await unapply(p.payment_number, a.number);
    const id = (await query<{ id: string }>(
      `SELECT id FROM customer_payments WHERE entity_id = $1 AND payment_number = $2`, [mx.entityId, p.payment_number]
    )).rows[0].id;
    await reverseCustomerPayment(mx.entityId, id, { reason: 'bounced transfer', cause: 'not_collected' }, mx.userId);
    expect(await since(before)).toMatchObject({ '2120': '0.0000', '2125': '172.8000', '2150': '0.0000', '2180': '0.0000', '2181': '80.0000' });
  }, 120_000);
});

describe('P5 · what does not change', () => {
  it('a receipt with a treatment re-parks the IEPS on unapply, 2180 Dr 80 / 2181 Cr 80, as before', async () => {
    const a = await invoice();
    const r = await recordCustomerPayment(
      {
        entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '1252.80', paymentDate: '2026-05-15',
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      mx.userId
    );
    const applied = await applyCustomerPayment(mx.entityId, r.paymentId, [{ documentId: a.id, amountApplied: '1252.80' }], mx.userId, { date: '2026-05-20' });
    expect((await taxLinesOf(applied.journalEntry!.id))['2181']).toEqual(dr('80'));
    const undone = await unapplyCustomerPayment(mx.entityId, r.paymentId, { invoiceId: a.id, reason: 'wrong sale', date: '2026-05-25' }, mx.userId);
    const lines = await taxLinesOf(undone.journalEntry.id);
    expect([lines['2180'], lines['2181']]).toEqual([dr('80'), cr('80')]);
    expect(undone.iepsReparked).toBe('80.0000');
  }, 120_000);
});
