import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-459 (#623, part 3/8) · EVERY ALLOCATION RECORDS THE IVA IT RELEASED.
 *
 * A new allocation stores what it moved from 2125 to 2120, 0 included, on
 * any entity, so `receipt unapply` gives back a stored fact and never an
 * estimate: a PUE invoice leaves 2120 and 2125 alone, and a PPD one re-parks
 * exactly what it released. The withheld net of an issued invoice goes by
 * that invoice: record, unapply, then apply with `--withholding`. The leaves
 * run in-process against Postgres; every figure is computed by hand.
 */

let mx: Fixture;
let us: Fixture;
let customerId: string;
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

async function newCustomer(f: Fixture, currency: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Exact Payer SA', $4, $5)`,
    [id, f.entityId, `C-459-${id.slice(0, 6)}`, currency, f.userId]
  );
  return id;
}

/** An issued invoice of `price` plus 16 %; `terms` 'PPD' parks its IVA, null reads as PUE. */
async function invoice(f: Fixture, customer: string, currency: string, price: string, terms: string | null) {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customer, invoice_date: DAY, due_date: DAY,
    currency_code: currency, terms,
    lines: [{
      revenue_account_id: f.roles.ingreso, description: 'Synthetic fees',
      quantity: '1', unit_price: price, tax_rate: '16.0000',
    }],
    created_by: f.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** What each live row of the payment stored as released IVA. */
async function storedIva(paymentNumber: string, f: Fixture = mx): Promise<(string | null)[]> {
  const r = await query<{ iva: string | null }>(
    `SELECT pa.iva_reclass_amount::text AS iva
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE cp.entity_id = $1 AND cp.payment_number = $2 AND pa.unapplied_at IS NULL`,
    [f.entityId, paymentNumber]
  );
  return r.rows.map((x) => x.iva);
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

/** The credit balances of 2120 (IVA caused) and 2125 (IVA parked). */
async function vat(): Promise<{ caused: string; parked: string }> {
  const r = await query<{ code: string; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
      WHERE a.entity_id = $1 AND a.code IN ('2120', '2125') GROUP BY a.code`,
    [mx.entityId]
  );
  const of = (code: string): string => Number(r.rows.find((x) => x.code === code)?.b ?? 0).toFixed(4);
  return { caused: of('2120'), parked: of('2125') };
}

const moved = (before: { caused: string; parked: string }, after: { caused: string; parked: string }) => ({
  caused: (Number(after.caused) - Number(before.caused)).toFixed(4),
  parked: (Number(after.parked) - Number(before.parked)).toFixed(4),
});

const unapply = (pmt: string, inv: string) =>
  receipt(['unapply', pmt, '--invoice', inv, '--reason', 'applied again with its withholding']);

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-459 exact unapply MX');
  us = await crearInquilino('MNE-001-459 exact unapply US', { pais: 'US' });
  customerId = await newCustomer(mx, 'MXN');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('every new allocation of a collection stores the IVA it released, 0 included', () => {
  it('a PUE invoice collected by receipt record, then applied by receipt apply: 0 stored, and no unapply moves 2120 or 2125', async () => {
    const inv = await invoice(mx, customerId, 'MXN', '1000.00', null);
    const before = await vat();

    const recorded = await receipt(['record', inv.number, '--amount', '1160.00', '--date', DAY]);
    const pmt = recorded.payment_number;
    expect(await storedIva(pmt)).toEqual(['0.0000']);

    const first = await unapply(pmt, inv.number);
    expect(first.iva_reparked).toBe('0.0000');
    expect(await linesOf(first.entry_number)).toEqual({ '1120': [1160, 0], '2150': [0, 1160] });

    const applied = await receipt(['apply', pmt, '--invoice', `${inv.number}:1160.00`]);
    expect(await storedIva(pmt)).toEqual(['0.0000']);
    expect(await linesOf(applied.journal_entry)).toEqual({ '2150': [1160, 0], '1120': [0, 1160] });

    const second = await unapply(pmt, inv.number);
    expect(second.iva_reparked).toBe('0.0000');
    expect(await linesOf(second.entry_number)).toEqual({ '1120': [1160, 0], '2150': [0, 1160] });
    expect(moved(before, await vat())).toEqual({ caused: '0.0000', parked: '0.0000' });
  }, 120_000);

  it('a PPD invoice re-parks exactly what it released: 80.00 of a half collected', async () => {
    const inv = await invoice(mx, customerId, 'MXN', '1000.00', 'PPD');
    const before = await vat();

    const recorded = await receipt(['record', inv.number, '--amount', '580.00', '--date', DAY]);
    expect(await storedIva(recorded.payment_number)).toEqual(['80.0000']);
    expect(moved(before, await vat())).toEqual({ caused: '80.0000', parked: '-80.0000' });

    const undone = await unapply(recorded.payment_number, inv.number);
    expect(undone.iva_reparked).toBe('80.0000');
    expect(moved(before, await vat())).toEqual({ caused: '0.0000', parked: '0.0000' });
  }, 120_000);

  it('one receipt over a PPD and a PUE invoice: the PPD row stores its release and the PUE row 0', async () => {
    const ppd = await invoice(mx, customerId, 'MXN', '1000.00', 'PPD');
    const pue = await invoice(mx, customerId, 'MXN', '1000.00', null);
    const r = await recordCustomerPayment(
      {
        entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '2320.00', paymentDate: DAY,
        paymentMethod: 'spei',
        applications: [
          { documentId: ppd.id, amountApplied: '1160.00' },
          { documentId: pue.id, amountApplied: '1160.00' },
        ],
      },
      mx.userId
    );
    expect((await storedIva(r.paymentNumber)).sort()).toEqual(['0.0000', '160.0000']);
  }, 120_000);

  it('an entity off Mexican books stores 0 on both paths, and its unapply is no estimate', async () => {
    const customer = await newCustomer(us, 'USD');
    const inv = await invoice(us, customer, 'USD', '1000.00', 'PPD');
    const r = await recordCustomerPayment(
      {
        entityId: us.entityId, counterpartyId: customer, paymentAmount: '1160.00', paymentDate: DAY,
        paymentMethod: 'wire', applications: [{ documentId: inv.id, amountApplied: '1160.00' }],
      },
      us.userId
    );
    expect(await storedIva(r.paymentNumber, us)).toEqual(['0.0000']);

    const undone = await unapplyCustomerPayment(
      us.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong invoice' }, us.userId
    );
    expect([undone.ivaReAparcado, undone.ivaEstimado]).toEqual(['0.0000', false]);

    await applyCustomerPayment(us.entityId, r.paymentId, [{ documentId: inv.id, amountApplied: '1160.00' }], us.userId);
    expect(await storedIva(r.paymentNumber, us)).toEqual(['0.0000']);
  }, 120_000);
});

// Fees of 10,000.00 + 1,600.00. The customer transfers 9,533.33 and withholds
// ISR 1,000.00 (10 %) and IVA 1,066.67 (two thirds of 1,600.00).
describe('the withheld net goes by its invoice: record, unapply, apply with --withholding', () => {
  const route = async (terms: string | null) => {
    const inv = await invoice(mx, customerId, 'MXN', '10000.00', terms);
    const before = await vat();
    const recorded = await receipt(['record', inv.number, '--amount', '9533.33', '--date', DAY]);
    const pmt = recorded.payment_number;
    const storedAtRecord = await storedIva(pmt);
    const undone = await unapply(pmt, inv.number);
    const afterUnapply = moved(before, await vat());
    const applied = await receipt([
      'apply', pmt, '--invoice', `${inv.number}:9533.33`,
      '--withholding', 'isr:1000.00', '--withholding', 'iva:1066.67',
    ]);
    return {
      storedAtRecord, undone, afterUnapply, applied,
      unapplyLines: await linesOf(undone.entry_number),
      applyLines: await linesOf(applied.journal_entry),
      storedAtApply: await storedIva(pmt),
      end: moved(before, await vat()),
    };
  };

  it('PUE: the unapply writes no IVA line, and the application closes 11,600.00 with the cash and both withholdings', async () => {
    const r = await route(null);

    expect(r.storedAtRecord).toEqual(['0.0000']);
    expect(r.unapplyLines).toEqual({ '1120': [9533.33, 0], '2150': [0, 9533.33] });
    expect(r.applyLines).toEqual({
      '2150': [9533.33, 0], '1145': [1000, 0], '1146': [1066.67, 0], '1120': [0, 11600],
    });
    expect(r.applied).toMatchObject({ amount_due_after: '0.00', invoice_status: 'paid' });
    expect(r.storedAtApply).toEqual(['0.0000']);
    // The invoice caused its 1,600.00 at issue, before `before` was read.
    expect(r.end).toEqual({ caused: '0.0000', parked: '0.0000' });
  }, 120_000);

  it('PPD: the record releases 1,314.9421, the unapply re-parks that, and the application releases 1,600.0000', async () => {
    const r = await route('PPD');

    // 1,600 × 9,533.33 / 11,600 = 1,314.9421
    expect(r.storedAtRecord).toEqual(['1314.9421']);
    expect(r.undone.iva_reparked).toBe('1314.9421');
    expect(r.unapplyLines).toEqual({
      '1120': [9533.33, 0], '2150': [0, 9533.33], '2120': [1314.9421, 0], '2125': [0, 1314.9421],
    });
    expect(r.afterUnapply).toEqual({ caused: '0.0000', parked: '0.0000' });
    expect(r.applyLines).toEqual({
      '2150': [9533.33, 0], '1145': [1000, 0], '1146': [1066.67, 0], '1120': [0, 11600],
      '2125': [1600, 0], '2120': [0, 1600],
    });
    expect(r.storedAtApply).toEqual(['1600.0000']);
    // 2120 ends at the invoice's 1,600.00 and 2125, which held them, at 0.
    expect(r.end).toEqual({ caused: '1600.0000', parked: '-1600.0000' });
  }, 120_000);
});
