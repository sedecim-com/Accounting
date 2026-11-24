import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-604 (#792, a gap in #870's risks) · UNAPPLYING A ROW THAT TOOK IEPS
 * FROM THE CASH ON ACCOUNT GIVES THAT TAKE BACK.
 *
 * The cash back on account carries the IEPS its collection caused (590), and
 * an application of it nets that IEPS, e, against the share the invoice
 * releases, r: CR 2180 r − e. That application collected nothing (LIEPS art.
 * 10, art. 5o.-C; LIVA art. 1-B), so its unapply gives the cash back with the
 * e it carried, net of the share released on it, as the IVA restores c
 * (MNE-001-461). The application stores e on the ledger, by row
 * (`ieps_release.allocation_id`), and the unapply reads it back.
 *
 * A is PPD: 1,000.00 + IEPS 8 % 80.00 on 2181, and IVA 16 % on 1,080.00 =
 * 172.80, so 1,252.80. C is PPD 1,000.00 + 160.00 with no IEPS. D is PPD
 * 1,000.00 + IEPS 40.00 + IVA 16 % on 1,040.00 = 166.40, so 1,206.40. Dates are
 * in 2026; receipts are by transfer. Every figure is computed by hand.
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

/** An issued PPD invoice of 1,000.00 at 16 %; with `ieps`, a line of 80.00 (or `iepsAmount`) on 2181 as #699's fixture. */
async function invoice(o: { ieps?: boolean; iepsAmount?: string; date?: string } = {}): Promise<{ id: string; number: string }> {
  const date = o.date ?? '2026-05-10';
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: 'PPD',
    lines: [
      { revenue_account_id: mx.cuentas['4100'] ?? mx.roles.ingreso, description: 'Synthetic goods', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' },
      ...(o.ieps === false ? [] : [{ revenue_account_id: mx.cuentas['2181'], description: 'IEPS transferred', quantity: '1', unit_price: o.iepsAmount ?? '80.00', tax_rate: '16.0000' }]),
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
  mx = await crearInquilino('MNE-001-604 IEPS take back MX');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic IEPS Take Payer SA', 'MXN', $4)`,
    [customerId, mx.entityId, `C-604-${customerId.slice(0, 6)}`, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** 590's P1 up to the unapply: the cash back on account, 1,252.80 carrying 172.80 of IVA and 80.00 of IEPS. */
async function poolOnAccount(): Promise<{ a: { id: string; number: string }; p: string }> {
  const a = await invoice();
  const p = await record(a.number, '1252.80');
  await unapply(p.payment_number, a.number);
  return { a, p: p.payment_number };
}

describe('U1 · the acceptance case: 590\'s P3, its application to C unapplied', () => {
  it('the unapply gives the 74.0741 C took back to 2180, and the pool carries 80.00 again', async () => {
    const before = await balances();
    const { a, p } = await poolOnAccount();
    const c = await invoice({ ieps: false, date: '2026-05-22' });

    // c = 172.80 × 1,160 / 1,252.80 = 160.0000 and e = 80 × 1,160 / 1,252.80 = 74.0741; C releases g 160 and r 0.
    const toC = await apply(p, `${c.number}:1160.00`, '2026-05-25');
    expect(await linesOf(toC.journal_entry)).toEqual({
      '2150': dr('925.9259'), '2125': dr('160'), '2180': dr('74.0741'), '1120': cr('1160'),
    });
    expect(await since(before)).toMatchObject({ '2180': '5.9259', '2150': '74.0741' });

    // The cash goes back with the 74.0741 it carried: 2150 gets only 1,160.00 − 160.00 − 74.0741.
    const undone = await unapply(p, c.number, '2026-05-26');
    expect(await linesOf(undone.entry_number)).toEqual({
      '1120': dr('1160'), '2150': cr('925.9259'), '2125': cr('160'), '2180': cr('74.0741'),
    });
    expect(await since(before)).toMatchObject({
      '2120': '172.8000', '2125': '332.8000', '2150': '1000.0000', '2180': '80.0000', '2181': '80.0000',
    });

    // The whole pool to A: its 80.00 nets against the 80.00 the cash carries, so 2180 does not move.
    const toA = await apply(p, `${a.number}:1252.80`, '2026-05-27');
    expect(await linesOf(toA.journal_entry)).toEqual({
      '2150': dr('1000'), '2125': dr('172.80'), '2181': dr('80'), '1120': cr('1252.80'),
    });
    expect(await since(before)).toMatchObject({
      '2120': '172.8000', '2125': '160.0000', '2150': '0.0000', '2180': '80.0000', '2181': '0.0000',
    });
  }, 180_000);
});

describe('U2 · an invoice with less IEPS than the cash carries (r ≠ e)', () => {
  it('the unapply gives back e net of D\'s own 40.00, which goes back to 2181', async () => {
    const before = await balances();
    const { p } = await poolOnAccount();
    const d = await invoice({ iepsAmount: '40.00', date: '2026-05-22' });
    expect(await since(before)).toMatchObject({ '2181': '120.0000', '2125': '339.2000' });

    // c = 172.80 × 1,206.40 / 1,252.80 = 166.40 and e = 80 × 1,206.40 / 1,252.80 = 77.0370; D releases 166.40 and 40.00.
    const toD = await apply(p, `${d.number}:1206.40`, '2026-05-25');
    expect(await linesOf(toD.journal_entry)).toEqual({
      '2150': dr('962.9630'), '2125': dr('166.40'), '2181': dr('40'), '2180': dr('37.0370'), '1120': cr('1206.40'),
    });
    expect(await since(before)).toMatchObject({ '2180': '42.9630', '2181': '80.0000', '2150': '37.0370' });

    // back = 77.0370 − 40.00 = 37.0370 to 2180; D's 40.00 back to 2181; 2150 gets 1,206.40 − 166.40 − 77.0370.
    const undone = await unapply(p, d.number, '2026-05-26');
    expect(await linesOf(undone.entry_number)).toEqual({
      '1120': dr('1206.40'), '2150': cr('962.9630'), '2125': cr('166.40'), '2181': cr('40'), '2180': cr('37.0370'),
    });
    expect(await since(before)).toMatchObject({
      '2120': '172.8000', '2125': '339.2000', '2150': '1000.0000', '2180': '80.0000', '2181': '120.0000',
    });
  }, 180_000);
});
