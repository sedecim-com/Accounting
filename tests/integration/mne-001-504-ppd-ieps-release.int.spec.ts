import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { ligarPagoREP } from '../../src/services/xml-ingestion/rep-linkage.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-504 (#699, part 1/2) · EACH COLLECTION MOVES ITS SHARE OF THE PARKED IEPS TO 2180.
 *
 * A PPD sale's IEPS is caused when it is collected and on what is collected
 * (LIEPS art. 10, with LIVA's tests of collection by art. 5o.-C). Part 2
 * parks it in its own role at issuance; this part moves it: each collection,
 * by `receipt record`, by its issued REP, by `receipt apply` of cash on
 * account or by the cashing of a held cheque, carries DR 2181 / CR 2180 for
 * its share beside the VAT's DR 2125 / CR 2120. An unapply gives back exactly
 * what that receipt moved, and a reversal unwinds both pairs.
 *
 * Until part 2 lands nothing parks IEPS, so the invoice of #669 (SubTotal
 * 1,000.00, IEPS 80.00, VAT 172.80, Total 1,252.80) is built here with the
 * 80.00 on a line of its own whose account is 2181, mapped by hand to the
 * uncollected role: its issuance is the entry part 2 will post. Every figure
 * is computed by hand.
 */

let mx: Fixture;
let bare: Fixture;
let customerId: string;
let bareCustomerId: string;
let account2181: string;
let bankAccountId: string;
const DAY = '2026-08-15';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Runs `receipt <argv> --yes --json` as the binary would and returns its first row. */
async function receipt(argv: string[]): Promise<Record<string, string>> {
  const out: string[] = [];
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
    });
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

async function newCustomer(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Beverages SA', 'MXN', $4)`,
    [id, f.entityId, `C-504-${id.slice(0, 6)}`, f.userId]
  );
  return id;
}

/**
 * The PPD invoice of #669 as part 2 will post it: DR 1120 1,252.80 /
 * CR 4100 1,000.00 / CR 2181 80.00 / CR 2125 172.80. With `iepsAccount`
 * 2180 it is the IEPS a manual entry already caused, which nothing parks.
 */
async function iepsInvoice(
  opts: { cfdiUuid?: string; iepsAccount?: string; withIeps?: boolean; f?: Fixture; customer?: string } = {}
): Promise<{ id: string; number: string; entryId: string }> {
  const f = opts.f ?? mx;
  const lines = [
    { revenue_account_id: f.cuentas['4100'], description: 'Synthetic soft drinks', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' },
    ...(opts.withIeps === false ? [] : [{
      revenue_account_id: opts.iepsAccount ?? account2181, description: 'IEPS 8 % transferred',
      quantity: '1', unit_price: '80.00', tax_rate: '16.0000',
    }]),
  ];
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: opts.customer ?? customerId, invoice_date: DAY, due_date: DAY,
    currency_code: 'MXN', terms: 'PPD', lines, created_by: f.userId,
  });
  if (opts.cfdiUuid) {
    await query(`UPDATE invoices SET cfdi_uuid = $1 WHERE id = $2 AND entity_id = $3`, [opts.cfdiUuid, draft.id, f.entityId]);
  }
  const { invoice } = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  const je = await query<{ id: string }>(
    `SELECT id FROM journal_entries WHERE entity_id = $1 AND source_type = 'invoice' AND source_id = $2`,
    [f.entityId, invoice.id]
  );
  return { id: invoice.id, number: invoice.invoice_number, entryId: je.rows[0].id };
}

/** A posted entry's lines by account code, each as [debit, credit] at 4 dp. */
async function linesOf(entry: { id?: string; number?: string }, f: Fixture = mx): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted'
        AND (je.id::text = $2 OR je.entry_number = $2)
      GROUP BY a.code`,
    [f.entityId, entry.id ?? entry.number]
  );
  return Object.fromEntries(
    r.rows.map((l) => [l.code, [new Decimal(l.debit).toFixed(4), new Decimal(l.credit).toFixed(4)] as [string, string]])
  );
}

/** Only the tax pairs of an entry: 2120, 2125, 2180 and 2181. */
async function taxLinesOf(entry: { id?: string; number?: string }, f: Fixture = mx): Promise<Record<string, [string, string]>> {
  const all = await linesOf(entry, f);
  return Object.fromEntries(Object.entries(all).filter(([code]) => ['2120', '2125', '2180', '2181'].includes(code)));
}

/** Credit balances of the posted ledger: VAT caused and parked, IEPS caused and parked. */
async function taxes(f: Fixture = mx): Promise<Record<'2120' | '2125' | '2180' | '2181', string>> {
  const r = await query<{ code: string; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
      WHERE a.entity_id = $1 AND a.code IN ('2120', '2125', '2180', '2181') GROUP BY a.code`,
    [f.entityId]
  );
  const of = (code: string): string => new Decimal(r.rows.find((x) => x.code === code)?.b ?? 0).toFixed(4);
  return { '2120': of('2120'), '2125': of('2125'), '2180': of('2180'), '2181': of('2181') };
}

function delta(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(after).map((k) => [k, new Decimal(after[k]).minus(before[k] ?? 0).toFixed(4)]));
}

async function collect(invoiceId: string, amount: string, method = 'spei'): Promise<{ id: string; entryId: string }> {
  const r = await recordCustomerPayment({
    entityId: mx.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: DAY,
    paymentMethod: method, bankAccountId: method === 'check' ? bankAccountId : undefined,
    applications: [{ documentId: invoiceId, amountApplied: amount }],
  }, mx.userId);
  return { id: r.paymentId, entryId: r.journalEntry?.id as string };
}

const released = (vat: string, ieps: string) => ({
  '2125': [vat, '0.0000'], '2120': ['0.0000', vat], '2181': [ieps, '0.0000'], '2180': ['0.0000', ieps],
});

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-504 PPD IEPS release');
  bare = await crearInquilino('MNE-001-504 no IEPS role');
  customerId = await newCustomer(mx);
  bareCustomerId = await newCustomer(bare);

  // 2181 and its role, by hand: the seed that writes them is part 2.
  account2181 = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, '2181', 'IEPS Trasladado No Cobrado', 'liability', 'current_liabilities', $2, 'MXN', 'credit', $3)`,
    [account2181, mx.entityId, mx.userId]
  );
  await query(
    `INSERT INTO account_roles (tenant_id, entity_id, role, account_id) VALUES ($1, $2, 'ieps_trasladado_no_cobrado', $3)`,
    [mx.tenantId, mx.entityId, account2181]
  );

  const gl = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, '1110-504', 'Bank cheques', 'asset', 'current_assets', $2, 'MXN', 'debit', $3)`,
    [gl, mx.entityId, mx.userId]
  );
  bankAccountId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, 'Cheques 504', 'Bank', $3, 'MXN', 'checking')`,
    [bankAccountId, mx.entityId, gl]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the invoice of #669 with its IEPS parked in 2181', () => {
  it('is issued as part 2 will post it, with tax_amount the VAT alone', async () => {
    const inv = await iepsInvoice();
    expect(await linesOf({ id: inv.entryId })).toEqual({
      '1120': ['1252.8000', '0.0000'], '4100': ['0.0000', '1000.0000'],
      '2181': ['0.0000', '80.0000'], '2125': ['0.0000', '172.8000'],
    });
    const row = await query<{ tax: string; total: string }>(
      `SELECT tax_amount::text AS tax, total_amount::text AS total FROM invoices WHERE id = $1`, [inv.id]
    );
    expect(row.rows[0]).toEqual({ tax: '172.8000', total: '1252.8000' });
  });
});

describe('each collection moves its share of the parked IEPS on the entry that moves its VAT', () => {
  it('two receipts of 626.40 by receipt record move 86.40 of VAT and 40.00 of IEPS each, and 2181 ends at 0.00', async () => {
    const before = await taxes();
    const inv = await iepsInvoice();

    const first = await receipt(['record', inv.number, '--amount', '626.40', '--date', DAY]);
    expect(await taxLinesOf({ number: first.journal_entry })).toEqual(released('86.4000', '40.0000'));
    const second = await receipt(['record', inv.number, '--amount', '626.40', '--date', DAY]);
    expect(await taxLinesOf({ number: second.journal_entry })).toEqual(released('86.4000', '40.0000'));

    expect(delta(before, await taxes())).toEqual({ '2120': '172.8000', '2125': '0.0000', '2180': '80.0000', '2181': '0.0000' });
  }, 120_000);

  it('400.00 then 852.80 move 25.5428 and then the exact remainder, 54.4572', async () => {
    const before = await taxes();
    const inv = await iepsInvoice();
    const a = await collect(inv.id, '400.00');
    expect((await taxLinesOf({ id: a.entryId }))['2181']).toEqual(['25.5428', '0.0000']);
    const b = await collect(inv.id, '852.80');
    expect((await taxLinesOf({ id: b.entryId }))['2181']).toEqual(['54.4572', '0.0000']);
    expect(delta(before, await taxes())['2181']).toBe('0.0000');
    expect(delta(before, await taxes())['2180']).toBe('80.0000');
  }, 120_000);

  it('an issued REP of 626.40 creates the receipt whose entry moves 86.40 and 40.00', async () => {
    const cfdiUuid = uuidv4();
    await iepsInvoice({ cfdiUuid });
    const r = await ligarPagoREP({
      tenantId: mx.tenantId, entityId: mx.entityId, userId: mx.userId,
      cfdiUuid: uuidv4(), direction: 'emitido', indice: 0,
      pago: {
        fechaPago: `${DAY}T12:00:00`, formaDePagoP: '03', monedaP: 'MXN', monto: 626.4,
        docsRelacionados: [{ uuid: cfdiUuid, impSaldoAnt: 1252.8, impPagado: 626.4, impSaldoInsoluto: 626.4, monedaDR: 'MXN' }],
      },
      fechaCfdi: new Date(`${DAY}T12:00:00Z`),
      monedaFuncional: 'MXN',
    });
    expect(r.accion, r.motivo).toBe('creado');
    const pay = await query<{ journal_entry_id: string }>(
      `SELECT journal_entry_id FROM customer_payments WHERE id = $1 AND entity_id = $2`, [r.paymentId, mx.entityId]
    );
    expect(await taxLinesOf({ id: pay.rows[0].journal_entry_id })).toEqual(released('86.4000', '40.0000'));
  }, 120_000);

  it('cash on account applied later by receipt apply moves the IEPS share with the VAT one', async () => {
    const inv = await iepsInvoice();
    const onAccount = await recordCustomerPayment({
      entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '626.40', paymentDate: DAY,
      paymentMethod: 'spei', applications: [], onAccount: true,
    }, mx.userId);
    expect(await taxLinesOf({ id: onAccount.journalEntry?.id as string })).toEqual({});

    const applied = await receipt(['apply', onAccount.paymentNumber, '--invoice', `${inv.number}:626.40`]);
    expect(await taxLinesOf({ number: applied.journal_entry })).toEqual(released('86.4000', '40.0000'));
  }, 120_000);
});

describe('an unapply gives back exactly the IEPS that receipt moved, and a reversal unwinds both pairs', () => {
  it('of three receipts the middle one is unapplied, applied again and unapplied again, each time by its own figure', async () => {
    const before = await taxes();
    const inv = await iepsInvoice();
    const a = await collect(inv.id, '400.00');
    const b = await receipt(['record', inv.number, '--amount', '300.00', '--date', DAY]);
    const c = await collect(inv.id, '552.80');
    // q4(80 × 400 / 1,252.80) = 25.5428; q4(80 × 700 / 1,252.80) = 44.6999; 80.
    expect((await taxLinesOf({ id: a.entryId }))['2181']).toEqual(['25.5428', '0.0000']);
    expect((await taxLinesOf({ number: b.journal_entry }))['2181']).toEqual(['19.1571', '0.0000']);
    expect((await taxLinesOf({ id: c.entryId }))['2181']).toEqual(['35.3001', '0.0000']);

    const undone = await receipt(['unapply', b.payment_number, '--invoice', inv.number, '--reason', 'applied to the wrong sale']);
    const unapplied = await taxLinesOf({ number: undone.entry_number });
    expect(unapplied['2180']).toEqual(['19.1571', '0.0000']);
    expect(unapplied['2181']).toEqual(['0.0000', '19.1571']);
    expect(delta(before, await taxes())['2181']).toBe('19.1571');

    // Applied again on top of 952.80 live: 80 − q4(80 × 952.80 / 1,252.80) = 80 − 60.8429.
    const again = await receipt(['apply', b.payment_number, '--invoice', `${inv.number}:300.00`]);
    expect((await taxLinesOf({ number: again.journal_entry }))['2181']).toEqual(['19.1571', '0.0000']);
    expect(delta(before, await taxes())['2181']).toBe('0.0000');

    const twice = await receipt(['unapply', b.payment_number, '--invoice', inv.number, '--reason', 'wrong again']);
    expect((await taxLinesOf({ number: twice.entry_number }))['2181']).toEqual(['0.0000', '19.1571']);
    expect(delta(before, await taxes())).toMatchObject({ '2180': '60.8429', '2181': '19.1571' });
  }, 180_000);

  it('a receipt that moved nothing gives nothing back, and its unapply reads no IEPS role', async () => {
    const inv = await iepsInvoice({ withIeps: false });
    const r = await receipt(['record', inv.number, '--amount', '580.00', '--date', DAY]);
    const undone = await receipt(['unapply', r.payment_number, '--invoice', inv.number, '--reason', 'no IEPS here']);
    const lines = await taxLinesOf({ number: undone.entry_number });
    expect(lines['2180']).toBeUndefined();
    expect(lines['2181']).toBeUndefined();
  }, 120_000);

  it('a reversed receipt unwinds its VAT pair and its IEPS pair', async () => {
    const before = await taxes();
    const inv = await iepsInvoice();
    const r = await collect(inv.id, '626.40');
    expect(delta(before, await taxes())).toEqual({ '2120': '86.4000', '2125': '86.4000', '2180': '40.0000', '2181': '40.0000' });

    await reverseCustomerPayment(mx.entityId, r.id, { reason: 'bounced transfer', cause: 'not_collected' }, mx.userId);
    expect(delta(before, await taxes())).toEqual({ '2120': '0.0000', '2125': '172.8000', '2180': '0.0000', '2181': '80.0000' });

    // The reversed receipt moved nothing, so the next collection moves the same share again.
    const next = await collect(inv.id, '626.40');
    expect(await taxLinesOf({ id: next.entryId })).toEqual(released('86.4000', '40.0000'));
  }, 120_000);
});

describe('a held customer cheque moves its IEPS when the bank cashes it, with its VAT', () => {
  it('the receipt moves neither tax; the cashing moves 86.40 and 40.00 on its own entry', async () => {
    const inv = await iepsInvoice();
    const held = await collect(inv.id, '626.40', 'check');
    expect(await taxLinesOf({ id: held.entryId })).toEqual({});

    const credit = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
       VALUES ($1, $2, '2026-08-20'::date, '626.40', 'credit', 'synthetic cheque deposit', false)`,
      [credit, bankAccountId]
    );
    const cashed = await recordCustomerCheckCashing(mx.entityId, held.id, { transactionId: credit, userId: mx.userId });
    expect(cashed.released).toBe('86.4000');
    expect(cashed.iepsReleased).toBe('40.0000');
    expect(await taxLinesOf({ id: cashed.entryId as string })).toEqual(released('86.4000', '40.0000'));
  }, 120_000);
});

describe('with nothing parked nothing changes', () => {
  it('IEPS a manual entry already put in 2180 is not moved again', async () => {
    const inv = await iepsInvoice({ iepsAccount: mx.cuentas['2180'] });
    const r = await collect(inv.id, '626.40');
    expect(await taxLinesOf({ id: r.entryId })).toEqual({ '2125': ['86.4000', '0.0000'], '2120': ['0.0000', '86.4000'] });
  }, 120_000);

  it('an entity without the uncollected role collects a PPD invoice exactly as before', async () => {
    const inv = await iepsInvoice({ f: bare, customer: bareCustomerId, withIeps: false });
    const r = await recordCustomerPayment({
      entityId: bare.entityId, counterpartyId: bareCustomerId, paymentAmount: '580.00', paymentDate: DAY,
      paymentMethod: 'spei', applications: [{ documentId: inv.id, amountApplied: '580.00' }],
    }, bare.userId);
    expect(await taxLinesOf({ id: r.journalEntry?.id as string }, bare)).toEqual({
      '2125': ['80.0000', '0.0000'], '2120': ['0.0000', '80.0000'],
    });
    const tagged = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
        WHERE je.entity_id = $1 AND l.tags ? 'ieps_release'`,
      [bare.entityId]
    );
    expect(tagged.rows[0].n).toBe('0');
  }, 120_000);
});
