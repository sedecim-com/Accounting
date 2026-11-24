import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, applyCustomerPayment, unapplyCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-574 (#792, part 1/3) · A PLAIN RECEIPT UNAPPLIED FROM A PPD INVOICE
 * KEEPS ITS IVA CAUSED, AND THE CASH GOES BACK ON ACCOUNT CARRYING IT.
 *
 * An unapply moves no money, so the IVA the collection caused stays caused
 * (LIVA art. 1-B, first paragraph; only a return, discount or bonus takes it
 * back, art. 7): the owner's «Mantener causado» of 19 Nov 2026 (#623, comment
 * 7013109077). The cash goes back to 2150 for its base only, and a later
 * application nets that IVA against the share it releases (MNE-001-461), so
 * each invoice's IVA is caused once, in the ledger and in the IVA paper.
 *
 * Invoices are PPD, 1,000.00 + 160.00, issued 2026-05-10, unless a case says
 * otherwise; receipts are by transfer. Every figure is computed by hand.
 */

let mx: Fixture;
let us: Fixture;
let customerId: string;
let usCustomerId: string;
const ISSUED = '2026-05-10';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/**
 * Runs `receipt <argv>` in process as the binary would. With `confirm`, it
 * answers the question instead of `--yes` and keeps it.
 */
async function leaf(
  argv: string[],
  o: { json?: boolean; confirm?: boolean } = {}
): Promise<{ row: Record<string, string>; out: string; asked: string[] }> {
  const out: string[] = [];
  const asked: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, {
      palette: plain,
      shutdown: () => undefined,
      reportError: (e: unknown) => { errors.push(e); },
      ...(o.confirm ? { confirm: async (q: string) => { asked.push(q); return true; } } : {}),
    });
    await program.parseAsync([
      'node', 'mnemosine', 'receipt', ...argv, '-e', mx.entityId, '-t', mx.tenantId,
      ...(o.confirm ? [] : ['-y']), ...(o.json === false ? [] : ['--json']),
    ]);
  } catch (e) {
    errors.push(e);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) throw new Error(`receipt ${argv.join(' ')} → ${exitCodeFor(errors[0])}: ${(errors[0] as Error).message}`);
  const text = out.join('');
  return { row: o.json === false ? {} : (JSON.parse(text) as { rows: Record<string, string>[] }).rows[0], out: text, asked };
}

async function newCustomer(f: Fixture, currency: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Kept IVA Payer SA', $4, $5)`,
    [id, f.entityId, `C-574-${id.slice(0, 6)}`, currency, f.userId]
  );
  return id;
}

/** An issued invoice of `price` plus 16 %; with `ieps`, a line of 80.00 on 2181 as #699's fixture. */
async function invoice(
  o: { price?: string; terms?: string | null; f?: Fixture; customer?: string; ieps?: boolean } = {}
): Promise<{ id: string; number: string }> {
  const f = o.f ?? mx;
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: o.customer ?? customerId, invoice_date: ISSUED, due_date: ISSUED,
    currency_code: f === us ? 'USD' : 'MXN', terms: o.terms === undefined ? 'PPD' : o.terms,
    lines: [
      { revenue_account_id: f.cuentas['4100'] ?? f.roles.ingreso, description: 'Synthetic fees', quantity: '1', unit_price: o.price ?? '1000.00', tax_rate: '16.0000' },
      ...(o.ieps ? [{ revenue_account_id: f.cuentas['2181'], description: 'IEPS 8 % transferred', quantity: '1', unit_price: '80.00', tax_rate: '16.0000' }] : []),
    ],
    created_by: f.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** A posted entry's lines by account code, each as [debit, credit] at 4 dp. */
async function linesOf(entryNumber: string, f: Fixture = mx): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND (je.entry_number = $2 OR je.id::text = $2)
      GROUP BY a.code`,
    [f.entityId, entryNumber]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [new Decimal(l.debit).toFixed(4), new Decimal(l.credit).toFixed(4)]]));
}

const dr = (x: string): [string, string] => [new Decimal(x).toFixed(4), '0.0000'];
const cr = (x: string): [string, string] => ['0.0000', new Decimal(x).toFixed(4)];

type Codes = '2120' | '2125' | '2150' | '2180' | '2181';
/** Credit balances of the posted ledger on the five accounts this task moves. */
async function balances(f: Fixture = mx): Promise<Record<Codes, string>> {
  const r = await query<{ code: Codes; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
      WHERE a.entity_id = $1 AND a.code IN ('2120', '2125', '2150', '2180', '2181') GROUP BY a.code`,
    [f.entityId]
  );
  const of = (c: Codes) => new Decimal(r.rows.find((x) => x.code === c)?.b ?? 0).toFixed(4);
  return { '2120': of('2120'), '2125': of('2125'), '2150': of('2150'), '2180': of('2180'), '2181': of('2181') };
}

const since = async (before: Record<Codes, string>, f: Fixture = mx) => {
  const now = await balances(f);
  return Object.fromEntries((Object.keys(now) as Codes[]).map((k) => [k, new Decimal(now[k]).minus(before[k]).toFixed(4)]));
};

/** Each allocation of the receipt with what it stored, closed ones included, oldest first. */
async function rows(paymentNumber: string, f: Fixture = mx) {
  const r = await query<{ live: boolean; vat: string | null; base: string; iva: string; kept: string | null }>(
    `SELECT pa.unapplied_at IS NULL AS live, pa.iva_reclass_amount::text AS vat,
            pa.advance_base_amount::text AS base, pa.advance_iva_amount::text AS iva,
            pa.unapply_kept_iva_amount::text AS kept
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE cp.entity_id = $1 AND cp.payment_number = $2
      ORDER BY pa.created_at`,
    [f.entityId, paymentNumber]
  );
  return r.rows;
}

async function owes(invoiceId: string): Promise<string> {
  const r = await query<{ due: string }>(`SELECT amount_due::text AS due FROM invoices WHERE id = $1 AND entity_id = $2`, [invoiceId, mx.entityId]);
  return new Decimal(r.rows[0].due).toFixed(2);
}

const record = (inv: string, amount: string, date = '2026-05-15') =>
  leaf(['record', inv, '--amount', amount, '--date', date]);
const unapply = (pmt: string, inv: string, date = '2026-05-20') =>
  leaf(['unapply', pmt, '--invoice', inv, '--reason', 'applied to the wrong sale', '--date', date]);
const apply = (pmt: string, target: string, date = '2026-05-25', extra: string[] = []) =>
  leaf(['apply', pmt, '--invoice', target, '--date', date, ...extra]);

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-574 kept IVA MX');
  us = await crearInquilino('MNE-001-574 kept IVA US', { pais: 'US' });
  customerId = await newCustomer(mx, 'MXN');
  usCustomerId = await newCustomer(us, 'USD');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the default: the unapply keeps the IVA caused, and the cash on account carries it', () => {
  it('A · unapplied on 05-20: 2150 takes the base, 2125 the share, 2120 does not move; the dry run, the question and --json say so', async () => {
    const before = await balances();
    const inv = await invoice();
    const pmt = (await record(inv.number, '1160.00')).row.payment_number;
    expect((await rows(pmt)).map((r) => r.vat)).toEqual(['160.0000']);

    const args = ['unapply', pmt, '--invoice', inv.number, '--reason', 'applied to the wrong sale', '--date', '2026-05-20'];
    const dry = await leaf([...args, '--dry-run'], { json: false });
    expect(dry.out).toContain('IVA kept caused 160.0000 (LIVA art. 1-B)');
    expect(dry.out).not.toContain('re-parked');

    const done = await leaf(args, { confirm: true });
    expect(done.asked[0]).toContain('IVA kept caused 160.0000 (LIVA art. 1-B)');
    expect(done.row).toMatchObject({ iva_reparked: '0.0000', iva_kept_caused: '160.0000', advance_iva_restored: '0.00' });
    expect(await linesOf(done.row.entry_number)).toEqual({ '1120': dr('1160'), '2150': cr('1000'), '2125': cr('160') });
    expect(await since(before)).toMatchObject({ '2120': '160.0000', '2125': '160.0000', '2150': '1000.0000' });
    expect(await owes(inv.id)).toBe('1160.00');
    expect((await rows(pmt)).map((r) => r.kept)).toEqual(['160.0000']);
  }, 120_000);

  it('B · applied again on 05-25: the cash takes its IVA from the pool, and 2120 does not move', async () => {
    const before = await balances();
    const inv = await invoice();
    const pmt = (await record(inv.number, '1160.00')).row.payment_number;
    await unapply(pmt, inv.number);

    const again = await apply(pmt, `${inv.number}:1160.00`);
    expect(await linesOf(again.row.journal_entry)).toEqual({ '2150': dr('1000'), '2125': dr('160'), '1120': cr('1160') });
    expect((await rows(pmt)).filter((r) => r.live)).toEqual([
      { live: true, vat: '160.0000', base: '1000.0000', iva: '160.0000', kept: null },
    ]);
    expect(await since(before)).toMatchObject({ '2120': '160.0000', '2125': '0.0000', '2150': '0.0000' });
  }, 120_000);

  it('C · applied to another PPD invoice, and the first collected again by a new receipt: 2120 ends at 320.00', async () => {
    const before = await balances();
    const [inv, inv2] = [await invoice(), await invoice()];
    const pmt = (await record(inv.number, '1160.00')).row.payment_number;
    await unapply(pmt, inv.number);

    const moved = await apply(pmt, `${inv2.number}:1160.00`);
    expect(await linesOf(moved.row.journal_entry)).toEqual({ '2150': dr('1000'), '2125': dr('160'), '1120': cr('1160') });
    const fresh = await record(inv.number, '1160.00', '2026-05-28');
    const tax = await linesOf(fresh.row.journal_entry);
    expect([tax['2125'], tax['2120']]).toEqual([dr('160'), cr('160')]);
    expect(await since(before)).toMatchObject({ '2120': '320.0000', '2125': '0.0000', '2150': '0.0000' });
  }, 120_000);

  it('D · a partial of 580.00 unapplied and applied again in two halves: the telescope cancels 40 + 40, and 2120 does not move', async () => {
    const before = await balances();
    const inv = await invoice();
    const pmt = (await record(inv.number, '580.00')).row.payment_number;
    const undone = await unapply(pmt, inv.number);
    expect(undone.row).toMatchObject({ iva_reparked: '0.0000', iva_kept_caused: '80.0000' });
    expect(await linesOf(undone.row.entry_number)).toEqual({ '1120': dr('580'), '2150': cr('500'), '2125': cr('80') });

    for (const date of ['2026-05-25', '2026-05-26']) {
      const half = await apply(pmt, `${inv.number}:290.00`, date);
      expect(await linesOf(half.row.journal_entry)).toEqual({ '2150': dr('250'), '2125': dr('40'), '1120': cr('290') });
    }
    expect((await rows(pmt)).filter((r) => r.live).map((r) => [r.vat, r.iva])).toEqual([['40.0000', '40.0000'], ['40.0000', '40.0000']]);
    expect(await since(before)).toMatchObject({ '2120': '80.0000', '2125': '80.0000', '2150': '0.0000' });
  }, 120_000);

  // Fees of 10,000.00 + 1,600.00. The customer transfers 9,533.33 and later
  // states the withholdings, ISR 1,000.00 and IVA 1,066.67 (MNE-001-459).
  it('E · the withheld net: the unapply keeps 1,314.9421, and the application causes only the 285.0579 left', async () => {
    const before = await balances();
    const inv = await invoice({ price: '10000.00' });
    const pmt = (await record(inv.number, '9533.33')).row.payment_number;
    // 1,600 × 9,533.33 / 11,600 = 1,314.9421
    const undone = await unapply(pmt, inv.number);
    expect(undone.row).toMatchObject({ iva_reparked: '0.0000', iva_kept_caused: '1314.9421' });
    expect(await linesOf(undone.row.entry_number)).toEqual({ '1120': dr('9533.33'), '2150': cr('8218.3879'), '2125': cr('1314.9421') });

    const applied = await apply(pmt, `${inv.number}:9533.33`, '2026-05-25', ['--withholding', 'isr:1000.00', '--withholding', 'iva:1066.67']);
    expect(await linesOf(applied.row.journal_entry)).toEqual({
      '2150': dr('8218.3879'), '1145': dr('1000'), '1146': dr('1066.67'), '2125': dr('1600'),
      '1120': cr('11600'), '2120': cr('285.0579'),
    });
    expect(await since(before)).toMatchObject({ '2120': '1600.0000', '2125': '0.0000', '2150': '0.0000' });
  }, 120_000);

  it('F · a row that took cash from the pool gives its c back, and its plain part keeps its pro-rata share', async () => {
    const inv = await invoice();
    const inv3 = await invoice({ price: '1500.00' });
    const r = await recordCustomerPayment(
      {
        entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '1740.00', paymentDate: '2026-05-15',
        paymentMethod: 'spei', onAccount: true, applications: [{ documentId: inv.id, amountApplied: '1160.00' }],
      },
      mx.userId
    );
    await unapplyCustomerPayment(mx.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-05-20' }, mx.userId);

    // 580 plain first, then 1,160 from the pool with its 160; the share released is 240.
    const applied = await applyCustomerPayment(mx.entityId, r.paymentId, [{ documentId: inv3.id, amountApplied: '1740.00' }], mx.userId, { date: '2026-05-25' });
    expect(await linesOf(applied.journalEntry!.id)).toEqual({ '2150': dr('1580'), '2125': dr('240'), '1120': cr('1740'), '2120': cr('80') });

    // 240 × 580 / 1,740 = 80.0000 kept, and c = 160 given back: 2120 does not move.
    const undone = await unapplyCustomerPayment(mx.entityId, r.paymentId, { invoiceId: inv3.id, reason: 'wrong sale', date: '2026-05-28' }, mx.userId);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '80.0000']);
    expect(await linesOf(undone.journalEntry.id)).toEqual({ '1120': dr('1740'), '2150': cr('1500'), '2125': cr('240') });

    const pool = await query<{ cash: string; iva: string }>(
      `SELECT SUM(pa.amount_applied - pa.advance_base_amount - pa.advance_iva_amount)::text AS cash,
              SUM(pa.unapply_kept_iva_amount)::text AS iva
         FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $2
        WHERE pa.payment_id = $1 AND pa.unapply_kept_iva_amount IS NOT NULL`,
      [r.paymentId, mx.entityId]
    );
    expect([new Decimal(pool.rows[0].cash).toFixed(4), pool.rows[0].iva]).toEqual(['1740.0000', '240.0000']);
  }, 120_000);

  // MNE-001-590: the invoice is owed again, so its IEPS goes back to 2181, and the cash carries the 80.00 caused.
  it('J · the IEPS this receipt moved stays in 2180, goes back to 2181, and applying the cash again nets it', async () => {
    const before = await balances();
    const inv = await invoice({ ieps: true });
    const pmt = (await record(inv.number, '1252.80')).row.payment_number;
    const undone = await unapply(pmt, inv.number);
    expect(undone.row).toMatchObject({ iva_kept_caused: '172.8000' });
    expect(await linesOf(undone.row.entry_number)).toEqual({ '1120': dr('1252.80'), '2150': cr('1000'), '2125': cr('172.80'), '2181': cr('80') });
    expect(await since(before)).toMatchObject({ '2180': '80.0000', '2181': '80.0000' });

    const again = await apply(pmt, `${inv.number}:1252.80`);
    expect(await linesOf(again.row.journal_entry)).toEqual({ '2150': dr('1000'), '2125': dr('172.80'), '2181': dr('80'), '1120': cr('1252.80') });
    expect(await since(before)).toMatchObject({ '2120': '172.8000', '2125': '0.0000', '2150': '0.0000', '2180': '80.0000', '2181': '0.0000' });
  }, 120_000);
});

describe('G · the months: the paper and the ledger agree, and the tie-out is silent', () => {
  it('collected 05-15, unapplied 06-10, applied again 07-05: June and July move no 2120 and net 0 in the paper', async () => {
    const f = await crearInquilino('MNE-001-574 months');
    await seedPolicies({ tenantId: f.tenantId });
    const customer = await newCustomer(f, 'MXN');
    const inv = await invoice({ f, customer });
    const r = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customer, paymentAmount: '1160.00', paymentDate: '2026-05-15',
        paymentMethod: 'spei', applications: [{ documentId: inv.id, amountApplied: '1160.00' }],
      },
      f.userId
    );
    await unapplyCustomerPayment(f.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-06-10' }, f.userId);
    await applyCustomerPayment(f.entityId, r.paymentId, [{ documentId: inv.id, amountApplied: '1160.00' }], f.userId, { date: '2026-07-05' });

    const paper = (month: number): Promise<IvaWorkpaper> => buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month });
    const [may, june, july] = [await paper(5), await paper(6), await paper(7)];
    const at16 = (wp: IvaWorkpaper) => [Number(wp.figures.charged.tasa16.base).toFixed(2), Number(wp.figures.charged.tasa16.iva).toFixed(2)];
    expect(at16(may)).toEqual(['1000.00', '160.00']);
    expect(at16(june)).toEqual(['0.00', '0.00']);
    expect(at16(july)).toEqual(['0.00', '0.00']);
    const of = (wp: IvaWorkpaper, id: string) => wp.contributions.charged.find((c) => c.documentId === id)?.breakdown.tasa16;
    expect(of(june, inv.id)).toEqual({ base: '-1000.0000', iva: '-160.0000' });
    expect(of(june, r.paymentId)).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(of(july, inv.id)).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(of(july, r.paymentId)).toEqual({ base: '-1000.0000', iva: '-160.0000' });
    expect([june.ledger.iva_trasladado, july.ledger.iva_trasladado]).toEqual(['0.0000', '0.0000']);
    for (const wp of [may, june, july]) expect(wp.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 180_000);
});

describe('K · what does not change', () => {
  it('a PUE invoice: no IVA line, no marker, and applying again takes nothing from a pool', async () => {
    const inv = await invoice({ terms: null });
    const pmt = (await record(inv.number, '1160.00')).row.payment_number;
    const undone = await unapply(pmt, inv.number);
    expect(undone.row).toMatchObject({ iva_reparked: '0.0000', iva_kept_caused: '0.0000' });
    expect(await linesOf(undone.row.entry_number)).toEqual({ '1120': dr('1160'), '2150': cr('1160') });
    await apply(pmt, `${inv.number}:1160.00`);
    expect((await rows(pmt)).map((r) => [r.live, r.base, r.iva, r.kept])).toEqual([
      [false, '0.0000', '0.0000', null], [true, '0.0000', '0.0000', null],
    ]);
  }, 120_000);

  it('an entity off Mexican books: nothing is kept', async () => {
    const inv = await invoice({ f: us, customer: usCustomerId });
    const r = await recordCustomerPayment(
      {
        entityId: us.entityId, counterpartyId: usCustomerId, paymentAmount: '1160.00', paymentDate: '2026-05-15',
        paymentMethod: 'wire', applications: [{ documentId: inv.id, amountApplied: '1160.00' }],
      },
      us.userId
    );
    const undone = await unapplyCustomerPayment(us.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-05-20' }, us.userId);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '0.0000']);
    expect((await rows(r.paymentNumber, us)).map((x) => x.kept)).toEqual([null]);
  }, 120_000);

  it('a row written before 049 re-parks its 80.00 estimate with the note, as MNE-001-517 T3', async () => {
    const inv = await invoice();
    const pmt = (await record(inv.number, '580.00')).row.payment_number;
    await query(
      `UPDATE payment_allocations SET iva_reclass_amount = NULL
        WHERE payment_id = (SELECT id FROM customer_payments WHERE entity_id = $1 AND payment_number = $2)`,
      [mx.entityId, pmt]
    );
    const undone = await unapply(pmt, inv.number);
    expect(undone.row).toMatchObject({ iva_reparked: '80.0000', iva_kept_caused: '0.0000' });
    expect(await linesOf(undone.row.entry_number)).toEqual({ '1120': dr('580'), '2150': cr('580'), '2120': dr('80'), '2125': cr('80') });
    expect((await rows(pmt)).map((r) => r.kept)).toEqual([null]);
  }, 120_000);

  it('a receipt with a treatment is MNE-001-462\'s: its unapply stores no marker', async () => {
    const inv = await invoice();
    const r = await recordCustomerPayment(
      {
        entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '1160.00', paymentDate: '2026-05-15',
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      mx.userId
    );
    await applyCustomerPayment(mx.entityId, r.paymentId, [{ documentId: inv.id, amountApplied: '1160.00' }], mx.userId, { date: '2026-05-20' });
    const undone = await unapplyCustomerPayment(mx.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-05-25' }, mx.userId);
    expect(undone.ivaKeptCaused).toBe('0.0000');
    expect((await rows(r.paymentNumber)).map((x) => x.kept)).toEqual([null]);
  }, 120_000);

  it('another tenant cannot unapply the receipt: 404', async () => {
    const inv = await invoice();
    const pmt = (await record(inv.number, '1160.00')).row.payment_number;
    const id = (await query<{ id: string }>(`SELECT id FROM customer_payments WHERE entity_id = $1 AND payment_number = $2`, [mx.entityId, pmt])).rows[0].id;
    await expect(
      unapplyCustomerPayment(us.entityId, id, { invoiceId: inv.id, reason: 'not mine' }, us.userId)
    ).rejects.toMatchObject({ statusCode: 404 });
  }, 120_000);
});
