import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-462 (#623, part 8/8) · THE EXCESS OF A COLLECTION IS AN ADVANCE.
 *
 * `receipt record <invoice> --amount … --on-account` leaves on account what
 * the invoice does not owe, and that cash is an advance whose IVA is caused
 * when it is collected (LIVA art. 1-B; the owner's answer 3 of 16 Nov 2026):
 * the base to 2150 and the IVA to 2120, at `--tax-rate` or the rate of the
 * invoice it collects (the highest of several, exempt when none carries IVA;
 * answer 2). Under «no re-park» (17 Nov 2026) the cash an unapply puts back
 * on such a receipt is a taxed advance too. The leaves run in-process against
 * Postgres; every figure is computed by hand.
 */

let mx: Fixture;
let customerId: string;
const CUSTOMER = 'Synthetic Excess On Account SA';
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

interface Line { price: string; rate?: string; code?: string }

/** An issued sale with one line per `lines`; `terms` 'PPD' parks its IVA, null reads as PUE. */
async function invoice(lines: Line[], opts: { terms?: string | null; date?: string } = {}) {
  const date = opts.date ?? '2026-08-05';
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: opts.terms ?? null,
    lines: lines.map((l) => ({
      revenue_account_id: mx.roles.ingreso, description: 'Synthetic sale',
      quantity: '1', unit_price: l.price, tax_rate: l.rate ?? '16.0000', tax_code: l.code ?? null,
    })),
    created_by: mx.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** The 1,160.00 sale of the acceptance: 1,000.00 at 16 %. */
const sale = (terms: string | null = null) => invoice([{ price: '1000.00' }], { terms });

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

async function descriptionOf(entryNumber: string): Promise<string> {
  const r = await query<{ description: string }>(
    `SELECT description FROM journal_entries WHERE entity_id = $1 AND entry_number = $2`,
    [mx.entityId, entryNumber]
  );
  return r.rows[0]?.description ?? '';
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

/** The treatment a receipt stored: factor type, rate, base and IVA. */
async function stored(paymentNumber: string): Promise<(string | null)[]> {
  const r = await query<{ t: string | null; r: string | null; b: string | null; i: string | null }>(
    `SELECT advance_factor_type AS t, advance_tax_rate::text AS r, advance_base_amount::text AS b, advance_iva_amount::text AS i
       FROM customer_payments WHERE entity_id = $1 AND payment_number = $2`,
    [mx.entityId, paymentNumber]
  );
  const x = r.rows[0];
  return [x.t, x.r, x.b, x.i];
}

async function receipts(): Promise<number> {
  const r = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM customer_payments WHERE entity_id = $1', [mx.entityId]);
  return Number(r.rows[0].n);
}

const record = (inv: string, amount: string, ...rest: string[]) =>
  ['record', inv, '--amount', amount, '--date', '2026-08-10', ...rest];

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-462 excess on account MX');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, $4, 'MXN', $5)`,
    [customerId, mx.entityId, `C-462-${customerId.slice(0, 6)}`, CUSTOMER, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the excess a collection leaves on account causes its IVA when collected, as an advance', () => {
  it('1,500.00 on a 1,160.00 invoice at 16 %: 1111 Dr 1,500.00 / 1120 Cr 1,160.00 / 2150 Cr 293.10 / 2120 Cr 46.90', async () => {
    const inv = await sale();
    const done = await receipt(record(inv.number, '1500.00', '--on-account'), true);
    // 340.00 / 1.16 = 293.1034, half up to 293.10; the IVA is the rest.
    expect(done.row).toMatchObject({
      on_account: '340.00', advance_base: '293.10', advance_iva: '46.90', advance_tax_rate: '16',
      advance_tax_rate_from: inv.number, advance_tax_rate_assumed: null,
    });
    expect(done.asked).toContain('base 293.10, IVA 46.90, rate 16 %');
    expect(done.asked).toContain(`rate of ${inv.number}`);
    expect(await linesOf(done.row.journal_entry)).toEqual({
      '1111': [1500, 0], '1120': [0, 1160], '2150': [0, 293.1], '2120': [0, 46.9],
    });
    expect(await stored(done.row.payment_number)).toEqual(['tasa', '16.00', '293.1000', '46.9000']);
  }, 120_000);

  it('the dry run shows the rate and its invoice and writes nothing', async () => {
    const inv = await sale();
    const before = await receipts();
    const preview = await row(record(inv.number, '1500.00', '--on-account', '--dry-run'));
    expect(preview).toMatchObject({
      dry_run: true, advance_base: '293.10', advance_iva: '46.90', advance_tax_rate: '16', advance_tax_rate_from: inv.number,
    });
    expect(await receipts()).toBe(before);
  }, 120_000);

  it('--tax-rate 0 overrides the invoice\'s: 2150 Cr 340.00 and no 2120 line', async () => {
    const inv = await sale();
    const done = await row(record(inv.number, '1500.00', '--on-account', '--tax-rate', '0'));
    expect(done).toMatchObject({ advance_base: '340.00', advance_iva: '0.00', advance_tax_rate: '0', advance_tax_rate_from: null });
    expect(await linesOf(done.journal_entry)).toEqual({ '1111': [1500, 0], '1120': [0, 1160], '2150': [0, 340] });
    expect(await stored(done.payment_number)).toEqual(['tasa', '0.00', '340.0000', '0.0000']);
  }, 120_000);

  it('--tax-rate without --on-account is refused, and nothing is written', async () => {
    const inv = await sale();
    const before = await receipts();
    await expect(receipt(record(inv.number, '1160.00', '--tax-rate', '16'))).rejects.toThrow(/goes with --on-account/);
    expect(await receipts()).toBe(before);
  }, 120_000);

  it('an invoice at 16 % and 0 % takes the highest, and the dry run, the confirmation, --json and the entry say it was assumed', async () => {
    const inv = await invoice([{ price: '1000.00' }, { price: '500.00', rate: '0.0000' }]);
    const preview = await row(record(inv.number, '2000.00', '--on-account', '--dry-run'));
    expect(preview).toMatchObject({ advance_tax_rate: '16', advance_tax_rate_assumed: 'highest' });
    const done = await receipt(record(inv.number, '2000.00', '--on-account'), true);
    expect(done.asked).toContain('the highest is assumed');
    expect(done.row).toMatchObject({ advance_base: '293.10', advance_iva: '46.90', advance_tax_rate_assumed: 'highest' });
    expect(await descriptionOf(done.row.journal_entry)).toContain(`advance at 16 %, from ${inv.number} (several rates: the highest assumed)`);
  }, 120_000);

  it('an invoice at 0 % and exempt carries no IVA at any rate: the excess is exempt, said as assumed', async () => {
    const inv = await invoice([{ price: '1000.00', rate: '0.0000' }, { price: '500.00', rate: '0.0000', code: 'exento' }]);
    const done = await row(record(inv.number, '1840.00', '--on-account'));
    expect(done).toMatchObject({ advance_base: '340.00', advance_iva: '0.00', advance_tax_rate: 'exempt', advance_tax_rate_assumed: 'exempt' });
    expect(await linesOf(done.journal_entry)).toEqual({ '1111': [1840, 0], '1120': [0, 1500], '2150': [0, 340] });
  }, 120_000);

  it('an invoice only at 0 %, or only exempt, leaves the whole excess in 2150 with that treatment', async () => {
    const zero = await invoice([{ price: '1000.00', rate: '0.0000' }]);
    const z = await row(record(zero.number, '1340.00', '--on-account'));
    expect(z).toMatchObject({ advance_base: '340.00', advance_iva: '0.00', advance_tax_rate: '0', advance_tax_rate_assumed: null });
    expect(await stored(z.payment_number)).toEqual(['tasa', '0.00', '340.0000', '0.0000']);

    const exempt = await invoice([{ price: '1000.00', rate: '0.0000', code: 'exento' }]);
    const e = await row(record(exempt.number, '1340.00', '--on-account'));
    expect(e).toMatchObject({ advance_tax_rate: 'exempt', advance_tax_rate_assumed: null });
    expect(await stored(e.payment_number)).toEqual(['exento', null, '340.0000', '0.0000']);
  }, 120_000);

  it('an invoice born from a CFDI outside the object of IVA leaves the excess as not-subject', async () => {
    const inv = await invoice([{ price: '1000.00', rate: '0.0000' }]);
    const xmlId = uuidv4();
    await query(
      `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc, receptor_rfc,
                                  import_source, subtotal, total, xml_content, xml_hash, processing_status)
       VALUES ($1, $2, 'cfdi_ingreso', $3, '4.0', '2026-08-05', 'XAXX010101000', 'XEXX010101000',
               'manual_upload', 1000, 1000, '<xml/>', $4, 'completed')`,
      [xmlId, mx.entityId, uuidv4(), uuidv4().replace(/-/g, '')]
    );
    // ObjetoImp 01: the CFDI transfers no tax, so its whole subtotal is no-objeto.
    await query(
      `INSERT INTO pre_registrations (entity_id, xml_document_id, source_type, document_type, document_date, subtotal,
                                      tax_amount, total_amount, tax_breakdown, lines, status, result_type, result_id)
       VALUES ($1, $2, 'xml_cfdi', 'invoice', '2026-08-05', 1000, 0, 1000, '{"traslados": []}'::jsonb, '[]'::jsonb,
               'completed', 'invoice', $3)`,
      [mx.entityId, xmlId, inv.id]
    );
    const done = await row(record(inv.number, '1340.00', '--on-account'));
    expect(done).toMatchObject({ advance_base: '340.00', advance_iva: '0.00', advance_tax_rate: 'not-subject' });
    expect(await stored(done.payment_number)).toEqual(['no_objeto', null, '340.0000', '0.0000']);
  }, 120_000);

  it('by cheque the excess goes whole to 2150 as before, and the leaf says why (#700)', async () => {
    const inv = await sale();
    const done = await receipt(record(inv.number, '1500.00', '--on-account', '--method', 'check'));
    expect(done.row).toMatchObject({ advance_tax_rate: null, on_account: '340.00' });
    expect(done.err).toContain('issue 700');
    expect(await linesOf(done.row.journal_entry)).toEqual({ '1111': [1500, 0], '1120': [0, 1160], '2150': [0, 340] });
  }, 120_000);

  it('by cheque a stated --tax-rate for the excess is refused, and nothing is written (#700)', async () => {
    // MNE-001-558 posts the IVA of an advance by cheque with no invoice on its cashing; the excess of a
    // collection is not carried by that path yet, so its stated treatment is refused rather than lost.
    const inv = await sale();
    const before = await receipts();
    await expect(receipt(record(inv.number, '1500.00', '--on-account', '--method', 'check', '--tax-rate', '16')))
      .rejects.toMatchObject({ code: 'EXCESS_BY_CHEQUE_NOT_WIRED' });
    expect(await receipts()).toBe(before);
  }, 120_000);

  it('an entity that does not keep Mexican books posts the excess as today, whole to its customer advances', async () => {
    const us = await crearInquilino('MNE-001-462 excess on account US', { pais: 'US' });
    const usCustomer = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1, $2, $3, 'Synthetic US Customer', 'USD', $4)`,
      [usCustomer, us.entityId, `C-462-${usCustomer.slice(0, 6)}`, us.userId]
    );
    const draft = await createInvoice({
      entity_id: us.entityId, customer_id: usCustomer, invoice_date: '2026-08-05', due_date: '2026-08-05',
      currency_code: 'USD', terms: null, created_by: us.userId,
      lines: [{ revenue_account_id: us.roles.ingreso, description: 'Sale', quantity: '1', unit_price: '1000.00', tax_rate: '0.0000' }],
    });
    const { invoice: issued } = await issueInvoice(draft.id, us.userId, { entityId: us.entityId });
    const r = await recordCustomerPayment({
      entityId: us.entityId, counterpartyId: usCustomer, paymentAmount: '1340.00', paymentDate: '2026-08-10',
      paymentMethod: 'ach', onAccount: true, advanceTreatmentFromInvoice: true,
      applications: [{ documentId: issued.id, amountApplied: '1000.00' }],
    }, us.userId);
    expect(r.advance).toBeNull();
    const lines = await query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit_amount), 0)::text AS credit FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_id = $2`,
      [r.journalEntry!.id, us.roles.anticipo_clientes ?? us.cuentas['2150']]
    );
    expect(Number(lines.rows[0].credit)).toBe(340);
  }, 120_000);
});

describe('in a mixed balance the cash an unapply puts back is a taxed advance (no re-park, 17 Nov 2026)', () => {
  it('the excess plus the 1,160.00 back: applying 1,160.00 then the last 340.00 cancels 160.0027 and 46.8973, and 2150 ends at 0', async () => {
    const before = await liabilities();
    const a = await sale();
    const b = await sale();
    const pmt = (await row(record(a.number, '1500.00', '--on-account'))).payment_number;

    // The record-time cash of a PUE invoice carried its IVA in the invoice's own 160.00; back on
    // account it is an advance at the receipt's 16 %: 1,160.00 / 1.16 = 1,000.00 and 160.00.
    const undone = await row(['unapply', pmt, '--invoice', a.number, '--reason', 'wrong invoice', '--date', '2026-08-11']);
    expect(undone).toMatchObject({ advance_iva_restored: '160.00', iva_reparked: '0.0000' });
    expect(await linesOf(undone.entry_number)).toEqual({ '1120': [1160, 0], '2150': [0, 1000], '2120': [0, 160] });

    // One advance of 1,500.00 with 206.90 of IVA: 206.90 × 1,160 / 1,500 = 160.0027; the last part takes the rest.
    const first = await row(['apply', pmt, '--invoice', `${b.number}:1160.00`, '--date', '2026-08-12']);
    expect(await linesOf(first.journal_entry)).toEqual({ '2150': [999.9973, 0], '2120': [160.0027, 0], '1120': [0, 1160] });
    const last = await row(['apply', pmt, '--invoice', `${a.number}:340.00`, '--date', '2026-08-12']);
    expect(await linesOf(last.journal_entry)).toEqual({ '2150': [293.1027, 0], '2120': [46.8973, 0], '1120': [0, 340] });

    // 2120 holds the two invoices' own IVA, and nothing is left of the advance.
    expect(moved(before, await liabilities())).toEqual({ '2150': '0.0000', '2120': '320.0000', '2125': '0.0000' });
  }, 120_000);

  it('on a PPD invoice the unapply re-parks nothing: 2150 Cr 1,000.00, 2125 Cr 160.00 and no 2120 line', async () => {
    const before = await liabilities();
    const a = await sale('PPD');
    const recorded = await row(record(a.number, '1500.00', '--on-account'));
    expect(await linesOf(recorded.journal_entry)).toEqual({
      '1111': [1500, 0], '1120': [0, 1160], '2150': [0, 293.1], '2125': [160, 0], '2120': [0, 206.9],
    });
    const undone = await row(['unapply', recorded.payment_number, '--invoice', a.number, '--reason', 'wrong invoice', '--date', '2026-08-11']);
    expect(undone).toMatchObject({ advance_iva_restored: '160.00', iva_reparked: '0.0000' });
    expect(await linesOf(undone.entry_number)).toEqual({ '1120': [1160, 0], '2150': [0, 1000], '2125': [0, 160] });
    // The IVA of all 1,500.00 collected stays caused; the invoice's share is parked again because it is owed again.
    expect(moved(before, await liabilities())).toEqual({ '2150': '1293.1000', '2120': '206.9000', '2125': '160.0000' });
  }, 120_000);
});
