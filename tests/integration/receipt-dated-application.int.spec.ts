import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice, listInvoices } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { todayFor } from '../../src/services/policy/today.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-460 (#623, part 4/8) · AN APPLICATION AND AN UNAPPLY ARE DATED.
 *
 * `receipt apply --date` and `receipt unapply --date` (default: today in the
 * entity's zone) date the entry, the allocation (`applied_on`, migration 332)
 * and the invoice's last payment, and an unapply its closure
 * (`unapplied_at`), so a balance read "as of" a day sees the ledger and the
 * subledger move together. What would put an event before what it depends on
 * is refused and writes nothing. The leaves run in-process against Postgres.
 */

let mx: Fixture;
let customerId: string;
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

/** An issued PUE invoice of 1,000.00 + 16 % dated `day`. */
async function invoice(day: string): Promise<{ id: string; number: string }> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: day, due_date: day,
    currency_code: 'MXN', terms: null,
    lines: [{
      revenue_account_id: mx.roles.ingreso, description: 'Synthetic service',
      quantity: '1', unit_price: '1000.00', tax_rate: '16.0000',
    }],
    created_by: mx.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** Cash on account with no invoice and no IVA treatment, received on `day`. */
async function onAccount(day: string, amount = '1160.00'): Promise<string> {
  const r = await recordCustomerPayment(
    {
      entityId: mx.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: day,
      paymentMethod: 'spei', applications: [], onAccount: true,
    },
    mx.userId
  );
  return r.paymentNumber;
}

async function entryDate(entryNumber: string): Promise<string> {
  const r = await query<{ d: string }>(
    `SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM journal_entries WHERE entity_id = $1 AND entry_number = $2`,
    [mx.entityId, entryNumber]
  );
  return r.rows[0].d;
}

/** Every allocation of a receipt, oldest first, with its two days. */
async function allocations(paymentNumber: string): Promise<{ applied_on: string | null; unapplied_on: string | null }[]> {
  const r = await query<{ applied_on: string | null; unapplied_on: string | null }>(
    `SELECT to_char(pa.applied_on, 'YYYY-MM-DD') AS applied_on, to_char(pa.unapplied_at, 'YYYY-MM-DD') AS unapplied_on
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE cp.entity_id = $1 AND cp.payment_number = $2
      ORDER BY pa.created_at`,
    [mx.entityId, paymentNumber]
  );
  return r.rows;
}

async function lastPaymentDate(invoiceId: string): Promise<string | null> {
  const r = await query<{ d: string | null }>(
    `SELECT to_char(last_payment_date, 'YYYY-MM-DD') AS d FROM invoices WHERE id = $1 AND entity_id = $2`,
    [invoiceId, mx.entityId]
  );
  return r.rows[0].d;
}

/** What the receipt has written: its allocations and its entries. */
async function written(paymentNumber: string): Promise<{ allocations: number; entries: number }> {
  const r = await query<{ a: string; e: string }>(
    `SELECT (SELECT COUNT(*) FROM payment_allocations WHERE payment_id = cp.id)::text AS a,
            (SELECT COUNT(*) FROM journal_entries WHERE entity_id = cp.entity_id AND source_id = cp.id)::text AS e
       FROM customer_payments cp WHERE cp.entity_id = $1 AND cp.payment_number = $2`,
    [mx.entityId, paymentNumber]
  );
  return { allocations: Number(r.rows[0].a), entries: Number(r.rows[0].e) };
}

/** What `invoice list --as-of` says the invoice owed at the end of `asOf`. */
async function owedAsOf(invoiceNumber: string, asOf: string): Promise<number | undefined> {
  const { rows } = await listInvoices(mx.entityId, { customerId, asOf, withAging: true });
  const row = rows.find((r) => r.invoice_number === invoiceNumber) as unknown as { amount_due_as_of: string } | undefined;
  return row === undefined ? undefined : Number(row.amount_due_as_of);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-460 dated application MX');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-460-001', 'Synthetic Dated Payer SA', 'MXN', $3)`,
    [customerId, mx.entityId, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt apply --date and receipt unapply --date date the event', () => {
  let inv: { id: string; number: string };
  let pmt: string;

  beforeAll(async () => {
    inv = await invoice('2026-05-05');
    pmt = await onAccount('2026-05-10');
  });

  it('apply --date 2026-05-20 posts on that day and stamps it on the allocation and on the invoice', async () => {
    const out = await receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-05-20']);

    expect(out.date).toBe('2026-05-20');
    expect(await entryDate(out.journal_entry)).toBe('2026-05-20');
    expect(await allocations(pmt)).toEqual([{ applied_on: '2026-05-20', unapplied_on: null }]);
    expect(await lastPaymentDate(inv.id)).toBe('2026-05-20');
  });

  it('invoice list --as-of between the receipt and the application still shows the invoice owed', async () => {
    // Read by the receipt's day this was already settled on May 10.
    expect(await owedAsOf(inv.number, '2026-05-15')).toBe(1160);
    expect(await owedAsOf(inv.number, '2026-05-20')).toBe(0);
  });

  it('unapply before the application it undoes is refused, and nothing is written', async () => {
    const before = await written(pmt);
    await expect(
      receipt(['unapply', pmt, '--invoice', inv.number, '--reason', 'wrong invoice', '--date', '2026-05-15'])
    ).rejects.toThrow(/last posted on 2026-05-20: an unapply dated 2026-05-15 would undo it before it happened/);
    expect(await written(pmt)).toEqual(before);
  });

  it('unapply --date 2026-05-25 posts its mirror and closes the allocation on that day', async () => {
    const out = await receipt(['unapply', pmt, '--invoice', inv.number, '--reason', 'wrong invoice', '--date', '2026-05-25']);

    expect(out.date).toBe('2026-05-25');
    expect(await entryDate(out.entry_number)).toBe('2026-05-25');
    expect(await allocations(pmt)).toEqual([{ applied_on: '2026-05-20', unapplied_on: '2026-05-25' }]);
    // Owed again from the unapply's day on, settled between the two.
    expect(await owedAsOf(inv.number, '2026-05-24')).toBe(0);
    expect(await owedAsOf(inv.number, '2026-05-25')).toBe(1160);
  });
});

describe('a date that would put the event before what it depends on is refused, writing nothing', () => {
  it('an application dated before the receipt', async () => {
    const inv = await invoice('2026-06-01');
    const pmt = await onAccount('2026-06-10');
    const before = await written(pmt);
    await expect(
      receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-06-09'])
    ).rejects.toThrow(/last posted on 2026-06-10: an application dated 2026-06-09 would apply its cash before that happened/);
    expect(await written(pmt)).toEqual(before);
  });

  it('an application dated before its invoice', async () => {
    const pmt = await onAccount('2026-06-10');
    const inv = await invoice('2026-06-15');
    const before = await written(pmt);
    await expect(
      receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-06-12'])
    ).rejects.toThrow(new RegExp(`${inv.number} is dated 2026-06-15: cash applied on 2026-06-12 would settle it before the sale existed`));
    expect(await written(pmt)).toEqual(before);
    expect(await lastPaymentDate(inv.id)).toBeNull();
  });

  it('a date in the future of the entity\'s today', async () => {
    const inv = await invoice('2026-06-01');
    const pmt = await onAccount('2026-06-10');
    const today = await todayFor({ tenantId: mx.tenantId, entityId: mx.entityId });
    const tomorrow = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1))
      .toISOString().slice(0, 10);
    const before = await written(pmt);
    await expect(
      receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', tomorrow])
    ).rejects.toThrow(new RegExp(`cannot be applied on ${tomorrow}: that is after today \\(${today}\\)`));
    expect(await written(pmt)).toEqual(before);

    await receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-06-10']);
    const applied = await written(pmt);
    await expect(
      receipt(['unapply', pmt, '--invoice', inv.number, '--reason', 'synthetic', '--date', tomorrow])
    ).rejects.toThrow(new RegExp(`cannot be unapplied on ${tomorrow}: that is after today`));
    expect(await written(pmt)).toEqual(applied);
  });

  it('a date in a hard-closed period', async () => {
    const inv = await invoice('2026-03-05');
    const pmt = await onAccount('2026-03-10');
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2`, [mx.periodos[4], mx.entityId]);
    const before = await written(pmt);
    await expect(
      receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`, '--date', '2026-04-15'])
    ).rejects.toThrow(/No open fiscal period found for the entry date/);
    expect(await written(pmt)).toEqual(before);
    expect(await lastPaymentDate(inv.id)).toBeNull();
  });
});

describe('the allocation\'s day where nobody gave one', () => {
  it('receipt record applies on the receipt\'s own date', async () => {
    const inv = await invoice('2026-07-01');
    const out = await receipt(['record', inv.number, '--amount', '1160.00', '--date', '2026-07-12']);
    expect(await allocations(out.payment_number)).toEqual([{ applied_on: '2026-07-12', unapplied_on: null }]);
  });

  it('receipt apply with no --date applies today in the entity\'s zone', async () => {
    const inv = await invoice('2026-07-01');
    const pmt = await onAccount('2026-07-02');
    const today = await todayFor({ tenantId: mx.tenantId, entityId: mx.entityId });
    const out = await receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`]);
    expect(out.date).toBe(today);
    expect(await entryDate(out.journal_entry)).toBe(today);
    expect(await allocations(pmt)).toEqual([{ applied_on: today, unapplied_on: null }]);
  });

  it('a row written before migration 332 is read by its receipt\'s date, as before', async () => {
    const inv = await invoice('2026-07-01');
    const out = await receipt(['record', inv.number, '--amount', '1160.00', '--date', '2026-07-12']);
    await query(
      `UPDATE payment_allocations SET applied_on = NULL
        WHERE payment_id = (SELECT id FROM customer_payments WHERE entity_id = $1 AND payment_number = $2)`,
      [mx.entityId, out.payment_number]
    );
    expect(await owedAsOf(inv.number, '2026-07-11')).toBe(1160);
    expect(await owedAsOf(inv.number, '2026-07-12')).toBe(0);
  });
});

describe('MNE-001-504 · the IEPS a PPD application moved, and the unapply\'s day', () => {
  /** A dated entry's lines on 2180 and 2181, each as [debit, credit]. */
  async function iepsLinesOf(entryNumber: string): Promise<Record<string, [string, string]>> {
    const r = await query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::numeric(18,4)::text AS debit,
              COALESCE(SUM(l.credit_amount), 0)::numeric(18,4)::text AS credit
         FROM journal_entry_lines l
         JOIN journal_entries je ON je.id = l.journal_entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE je.entity_id = $1 AND je.entry_number = $2 AND a.code IN ('2180', '2181')
        GROUP BY a.code`,
      [mx.entityId, entryNumber]
    );
    return Object.fromEntries(r.rows.map((l) => [l.code, [l.debit, l.credit] as [string, string]]));
  }

  // MNE-001-574 (#792): the unapply moves no money, so the IEPS stays caused with the IVA (LIEPS art. 5o.-C).
  it('unapply --date of a PPD application whose invoice parked IEPS posts on that day and keeps the IEPS caused', async () => {
    // 2181 and its role come from the seed (MNE-001-505). The invoice of
    // #669 posts CR 4100 1,000.00 / CR 2181 80.00 / CR 2125 172.80.
    const seeded = await query<{ account_id: string }>(
      `SELECT account_id FROM account_roles WHERE entity_id = $1 AND role = 'ieps_trasladado_no_cobrado'`,
      [mx.entityId]
    );
    expect(seeded.rows).toHaveLength(1);
    const account2181 = seeded.rows[0].account_id;
    const draft = await createInvoice({
      entity_id: mx.entityId, customer_id: customerId, invoice_date: '2026-08-01', due_date: '2026-08-01',
      currency_code: 'MXN', terms: 'PPD',
      lines: [
        { revenue_account_id: mx.roles.ingreso, description: 'Synthetic soft drinks', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' },
        { revenue_account_id: account2181, description: 'IEPS 8 % transferred', quantity: '1', unit_price: '80.00', tax_rate: '16.0000' },
      ],
      created_by: mx.userId,
    });
    const { invoice: inv } = await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId });
    const pmt = await onAccount('2026-08-02', '1252.80');

    const applied = await receipt(['apply', pmt, '--invoice', `${inv.invoice_number}:1252.80`, '--date', '2026-08-05']);
    expect(await entryDate(applied.journal_entry)).toBe('2026-08-05');
    expect(await iepsLinesOf(applied.journal_entry)).toEqual({ '2181': ['80.0000', '0.0000'], '2180': ['0.0000', '80.0000'] });

    const undone = await receipt(['unapply', pmt, '--invoice', inv.invoice_number, '--reason', 'wrong sale', '--date', '2026-08-10']);
    expect(undone.date).toBe('2026-08-10');
    expect(await entryDate(undone.entry_number)).toBe('2026-08-10');
    expect(await iepsLinesOf(undone.entry_number)).toEqual({});
    expect(await allocations(pmt)).toEqual([{ applied_on: '2026-08-05', unapplied_on: '2026-08-10' }]);
  });
});
