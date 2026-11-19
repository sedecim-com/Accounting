import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-422 (#623, part 5/8) · AN ADVANCE APPLIED TO A PUE INVOICE.
 *
 * The advance caused its IVA when it was collected (LIVA art. 1-B), so
 * applying it to the invoice of its sale cancels that IVA against 2120
 * instead of causing it a second time: 2150 Dr the base, 2120 Dr the IVA /
 * 1120 Cr the cash, the entry of the TipoRelacion 07 egreso
 * (`egreso_emitido_aplicacion_anticipo`, cfdi-taxonomy.ts). The allocation
 * stores both, so unapply and reverse give back exactly that. The leaves run
 * in-process against Postgres; every figure is computed by hand.
 */

let mx: Fixture;
let customerId: string;
const CUSTOMER = 'Synthetic Advance Applied SA';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/**
 * Runs `receipt <argv> --json` as the binary would: its first row, what it
 * wrote to stderr and the question it asked. With `confirm` the leaf asks
 * and the answer is yes; without it `-y` is appended.
 */
async function receipt(argv: string[], confirm = false) {
  const out: string[] = [];
  const err: string[] = [];
  const errors: unknown[] = [];
  const asked: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, {
      palette: plain,
      shutdown: () => undefined,
      reportError: (e: unknown) => { errors.push(e); },
      ...(confirm ? { confirm: async (q: string) => { asked.push(q); return true; } } : {}),
    });
    const tail = ['-e', mx.entityId, '-t', mx.tenantId, '--json', ...(confirm ? [] : ['-y'])];
    await program.parseAsync(['node', 'mnemosine', 'receipt', ...argv, ...tail]);
  } catch (e) {
    errors.push(e);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) {
    const e = errors[0] as Error & { code?: string };
    throw Object.assign(new Error(`receipt ${argv.join(' ')} → ${exitCodeFor(e)}: ${e.message}`), { code: e.code });
  }
  const row = (JSON.parse(out.join('')) as { rows: Record<string, string>[] }).rows[0];
  return { row, err: err.join(''), asked: asked.join('\n') };
}

const row = async (argv: string[]) => (await receipt(argv)).row;

/** An advance with no invoice, recorded from the terminal at 16 %. */
const advance = async (amount: string, date: string) =>
  row(['record', '--customer', CUSTOMER, '--amount', amount, '--tax-rate', '16', '--date', date]);

/** An issued sale of `price` at `rate`; `terms` 'PPD' parks its IVA, null reads as PUE. */
async function invoice(price: string, date: string, opts: { rate?: string; terms?: string | null } = {}) {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: opts.terms ?? null,
    lines: [{
      revenue_account_id: mx.roles.ingreso, description: 'Synthetic sale',
      quantity: '1', unit_price: price, tax_rate: opts.rate ?? '16.0000',
    }],
    created_by: mx.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** The lines of a posted entry by account code: [debit, credit]. */
async function linesOf(entryNumber: string): Promise<Record<string, [number, number]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.entry_number = $2 AND je.status = 'posted'
      GROUP BY a.code`,
    [mx.entityId, entryNumber]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [Number(l.debit), Number(l.credit)]]));
}

/** Credit balances of 2150, 2120 and 2125, to four decimals. */
async function liabilities(): Promise<Record<'2150' | '2120' | '2125', string>> {
  const r = await query<{ code: string; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
      WHERE a.entity_id = $1 AND a.code IN ('2150', '2120', '2125') GROUP BY a.code`,
    [mx.entityId]
  );
  const of = (code: string): string => Number(r.rows.find((x) => x.code === code)?.b ?? 0).toFixed(4);
  return { '2150': of('2150'), '2120': of('2120'), '2125': of('2125') };
}

const moved = (before: Record<string, string>, after: Record<string, string>) =>
  Object.fromEntries(Object.keys(after).map((k) => [k, (Number(after[k]) - Number(before[k])).toFixed(4)]));

/** What each allocation of the receipt took from its advance, live and closed, in order. */
async function taken(paymentNumber: string): Promise<[string, string, boolean][]> {
  const r = await query<{ base: string; iva: string; live: boolean }>(
    `SELECT pa.advance_base_amount::text AS base, pa.advance_iva_amount::text AS iva, pa.unapplied_at IS NULL AS live
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE cp.entity_id = $1 AND cp.payment_number = $2 ORDER BY pa.created_at`,
    [mx.entityId, paymentNumber]
  );
  return r.rows.map((x) => [x.base, x.iva, x.live]);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-422 advance applied MX');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, $4, 'MXN', $5)`,
    [customerId, mx.entityId, `C-422-${customerId.slice(0, 6)}`, CUSTOMER, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('an advance applied to a PUE invoice cancels the IVA it caused instead of causing it twice', () => {
  it('1,160.00 at 16 % applied in full to 5,800.00: 2150 Dr 1,000.00, 2120 Dr 160.00 / 1120 Cr 1,160.00; 2120 ends at the sale\'s 800.00', async () => {
    const before = await liabilities();
    const pmt = (await advance('1160.00', '2026-08-10')).payment_number;
    const inv = await invoice('5000.00', '2026-08-20');

    const applied = await row(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-20']);
    expect(applied).toMatchObject({ advance_iva_cancelled: '160.00', amount_due_after: '4640.00' });
    expect(await linesOf(applied.journal_entry)).toEqual({ '2150': [1000, 0], '2120': [160, 0], '1120': [0, 1160] });
    expect(await taken(pmt)).toEqual([['1000.0000', '160.0000', true]]);
    expect(moved(before, await liabilities())).toEqual({ '2150': '0.0000', '2120': '800.0000', '2125': '0.0000' });
  }, 120_000);

  it('in three parts of 386.67, 386.67 and 386.66 it cancels 53.3338, 53.3338 and 53.3324: 160.0000, with no cent left', async () => {
    const before = await liabilities();
    const pmt = (await advance('1160.00', '2026-08-10')).payment_number;
    const inv = await invoice('5000.00', '2026-08-20');

    for (const part of ['386.67', '386.67', '386.66']) {
      await row(['apply', pmt, '--invoice', `${inv.number}:${part}`, '--date', '2026-08-21']);
    }
    // 160 × 386.67 / 1,160 = 53.3338; 160 × 773.34 / 1,160 = 106.6676, less 53.3338; the last takes the rest.
    expect(await taken(pmt)).toEqual([
      ['333.3362', '53.3338', true], ['333.3362', '53.3338', true], ['333.3276', '53.3324', true],
    ]);
    expect(moved(before, await liabilities())).toEqual({ '2150': '0.0000', '2120': '800.0000', '2125': '0.0000' });
  }, 120_000);

  it('2,320.00 applied by 1,160.00 cancels 160.00, and the rest stays on account with its own 160.00', async () => {
    const before = await liabilities();
    const pmt = (await advance('2320.00', '2026-08-10')).payment_number;
    const inv = await invoice('5000.00', '2026-08-20');

    const applied = await row(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-20']);
    expect(applied).toMatchObject({ advance_iva_cancelled: '160.00', on_account_after: '1160.00' });
    // 2,000.00 base and 320.00 IVA collected; half of each still owed to the customer or the SAT.
    expect(moved(before, await liabilities())).toEqual({ '2150': '1000.0000', '2120': '960.0000', '2125': '0.0000' });
  }, 120_000);

  it('applied to a sale at 0 % it cancels its IVA the same way, and that sale leaves nothing in 2120', async () => {
    const before = await liabilities();
    const pmt = (await advance('1160.00', '2026-08-10')).payment_number;
    const inv = await invoice('5000.00', '2026-08-20', { rate: '0.0000' });

    const applied = await row(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-20']);
    expect(await linesOf(applied.journal_entry)).toEqual({ '2150': [1000, 0], '2120': [160, 0], '1120': [0, 1160] });
    expect(moved(before, await liabilities())).toEqual({ '2150': '0.0000', '2120': '0.0000', '2125': '0.0000' });
  }, 120_000);
});

describe('unapply and reverse give back exactly what the application stored', () => {
  it('receipt unapply mirrors it, applying again cancels the same 160.00, and receipt reverse leaves 2150, 2120 and 2125 as if there had been no advance', async () => {
    const inv = await invoice('5000.00', '2026-08-20');
    const before = await liabilities();
    const pmt = (await advance('1160.00', '2026-08-10')).payment_number;

    await row(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-20']);
    const undone = await row(['unapply', pmt, '--invoice', inv.number, '--reason', 'wrong amount', '--date', '2026-08-21']);
    expect(undone).toMatchObject({ advance_iva_restored: '160.00', iva_reparked: '0.0000' });
    expect(await linesOf(undone.entry_number)).toEqual({ '1120': [1160, 0], '2150': [0, 1000], '2120': [0, 160] });
    expect(moved(before, await liabilities())).toEqual({ '2150': '1000.0000', '2120': '160.0000', '2125': '0.0000' });

    const again = await row(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-22']);
    expect(again.advance_iva_cancelled).toBe('160.00');
    expect(await taken(pmt)).toEqual([['1000.0000', '160.0000', false], ['1000.0000', '160.0000', true]]);

    const id = (await query<{ id: string }>('SELECT id FROM customer_payments WHERE payment_number = $1 AND entity_id = $2', [pmt, mx.entityId])).rows[0].id;
    const reversed = await reverseCustomerPayment(mx.entityId, id, { reason: 'the transfer was taken back', cause: 'taken_back' }, mx.userId);
    // The record, the application, the unapply and the second application.
    expect(reversed.reversals).toHaveLength(4);
    expect(moved(before, await liabilities())).toEqual({ '2150': '0.0000', '2120': '0.0000', '2125': '0.0000' });
  }, 120_000);
});

describe('the edges of an application', () => {
  it('cancelling it on a PUE invoice dated on or before the advance, in a later month, warns in the dry run, the confirmation, --json and the entry', async () => {
    // Fees of 10,000.00 + 1,600.00 invoiced on May 20th; the customer's net of
    // 9,533.33, recorded as an advance on May 31st: 9,533.33 / 1.16 = 8,218.39 and 1,314.94.
    const inv = await invoice('10000.00', '2026-05-20');
    const before = await liabilities();
    const pmt = (await advance('9533.33', '2026-05-31')).payment_number;
    const args = ['apply', pmt, '--invoice', `${inv.number}:9533.33`,
      '--withholding', 'isr:1000.00', '--withholding', 'iva:1066.67', '--date', '2026-06-02'];

    const preview = await receipt([...args, '--dry-run']);
    expect(preview.err).toContain('2026-05');
    expect(preview.row).toMatchObject({ advance_iva_cancelled: '1314.94', dry_run: true });
    expect(preview.row.warning).toContain('1314.94');

    const applied = await receipt(args, true);
    expect(applied.asked).toContain('1314.94');
    expect(applied.row.warning).toContain('2026-05');
    expect(await linesOf(applied.row.journal_entry)).toEqual({
      '2150': [8218.39, 0], '2120': [1314.94, 0], '1145': [1000, 0], '1146': [1066.67, 0], '1120': [0, 11600],
    });
    const description = await query<{ d: string }>(
      'SELECT description AS d FROM journal_entries WHERE entity_id = $1 AND entry_number = $2',
      [mx.entityId, applied.row.journal_entry]
    );
    expect(description.rows[0].d).toContain('2026-05');
    // The invoice caused its 1,600.00 before `before` was read; the advance's IVA is cancelled.
    expect(moved(before, await liabilities())).toEqual({ '2150': '0.0000', '2120': '0.0000', '2125': '0.0000' });
  }, 120_000);

  it('an invoice dated after the advance, or in the same month, does not warn', async () => {
    const pmt = (await advance('1160.00', '2026-08-10')).payment_number;
    const inv = await invoice('1000.00', '2026-08-05');
    const applied = await receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-25']);
    expect(applied.row.warning).toBeNull();
    expect(applied.err).toBe('');
  }, 120_000);

  it('applying part of an advance to a PPD invoice is refused until part 6/8, naming the reason, and nothing is written', async () => {
    const pmt = (await advance('1160.00', '2026-08-10')).payment_number;
    const inv = await invoice('5000.00', '2026-08-20', { terms: 'PPD' });
    const before = await liabilities();
    await expect(row(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-08-20']))
      .rejects.toMatchObject({ code: 'ADVANCE_TO_PPD_NOT_WIRED' });
    expect(await taken(pmt)).toEqual([]);
    expect(await liabilities()).toEqual(before);
  }, 120_000);
});
