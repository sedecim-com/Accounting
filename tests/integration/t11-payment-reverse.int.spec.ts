import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import {
  recordVendorPayment,
  applyVendorPayment,
  unapplyVendorPayment,
  reverseVendorPayment,
} from '../../src/services/payments/payment-service.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';

/**
 * T11 · MNE-001-128: `payment reverse`, against the real database.
 *
 * `payment unapply` (MNE-001-037) puts the cash of a misapplied payment back
 * on account; it does not undo the payment. A duplicated 80,000 transfer that
 * the vendor or the bank sends back needs the whole payment undone: every
 * entry it posted gets its NIF B-1 mirror, dated, the bills it settled are
 * owed again, its live applications are closed on that date, and the payment
 * is 'reversed' (it happened and was undone), never deleted.
 */

let f: Fixture;
const PAID_ON = '2026-08-15';

beforeAll(async () => {
  f = await crearInquilino('T11 payment reverse');
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function approvedBill(fx: Fixture, subtotal: string, iva: string): Promise<{ billId: string; vendorId: string }> {
  const total = new Decimal(subtotal).plus(iva).toFixed(2);
  const billId = uuidv4();
  const vendorId = uuidv4();
  const tag = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor T11','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, fx.entityId, `V-${tag}`, fx.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,'PPD')`,
    [billId, fx.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, subtotal, iva, total, PAID_ON, fx.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a credito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, fx.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, fx.userId, { entityId: fx.entityId });
  return { billId, vendorId };
}

async function paidWithBill(fx: Fixture, billId: string, vendorId: string, amount: string): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: fx.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: PAID_ON,
      paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: amount }],
    },
    fx.userId
  );
  return r.paymentId;
}

async function onAccount(fx: Fixture, vendorId: string, amount: string): Promise<string> {
  const r = await recordVendorPayment(
    { entityId: fx.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: PAID_ON,
      paymentMethod: 'spei', applications: [], onAccount: true },
    fx.userId
  );
  return r.paymentId;
}

async function billRow(billId: string) {
  const r = await query<{ amount_due: string; amount_paid: string; status: string }>(
    `SELECT amount_due::text, amount_paid::text, status FROM bills WHERE id = $1`,
    [billId]
  );
  return r.rows[0];
}

async function paymentRow(paymentId: string) {
  const r = await query<{ status: string; reversed_on: string | null }>(
    `SELECT status, to_char(reversed_at, 'YYYY-MM-DD') AS reversed_on FROM vendor_payments WHERE id = $1`,
    [paymentId]
  );
  return r.rows[0];
}

/** Every entry the payment posted, with the date of its mirror (NULL = not reversed). */
async function entriesOf(paymentId: string) {
  const r = await query<{ source_type: string; mirror_on: string | null }>(
    `SELECT je.source_type, to_char(m.entry_date, 'YYYY-MM-DD') AS mirror_on
       FROM journal_entries je
       LEFT JOIN journal_entries m ON m.id = je.reversed_by_entry_id
      WHERE je.source_id = $1 AND je.status = 'posted'
      ORDER BY je.created_at`,
    [paymentId]
  );
  return r.rows;
}

/** Per account, what the payment's entries and their mirrors leave behind: nothing, once reversed. */
async function netLeftOf(paymentId: string): Promise<Record<string, string>> {
  const r = await query<{ code: string; net: string }>(
    `SELECT a.code, SUM(COALESCE(l.debit_amount,0) - COALESCE(l.credit_amount,0))::text AS net
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.source_id = $1
         OR je.reverses_entry_id IN (SELECT id FROM journal_entries WHERE source_id = $1)
      GROUP BY a.code`,
    [paymentId]
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, new Decimal(x.net).toFixed(2)]));
}

describe('payment reverse: the duplicated 80,000 transfer comes back', () => {
  it('reopens the bill, dates the closed row, and mirrors the ledger with a reversing entry on that date', async () => {
    const own = await crearInquilino('T11 reverse as of');
    const { billId, vendorId } = await approvedBill(own, '68965.52', '11034.48');
    const paymentId = await paidWithBill(own, billId, vendorId, '80000.00');

    const r = await reverseVendorPayment(
      own.entityId, paymentId, { reason: 'Transferencia duplicada devuelta', date: '2026-08-20' }, own.userId
    );

    expect(await billRow(billId), 'the bill is owed again').toEqual({ amount_due: '80000.0000', amount_paid: '0.0000', status: 'approved' });
    expect(r.documents.map((d) => [d.numero, d.saldoNuevo])).toHaveLength(1);
    expect(r.documents[0].saldoNuevo).toBe('80000.00');

    const row = await query<{ d: string; by: string; reason: string }>(
      `SELECT to_char(unapplied_at, 'YYYY-MM-DD') AS d, unapplied_by::text AS by, unapply_reason AS reason
         FROM payment_applications WHERE payment_id = $1`,
      [paymentId]
    );
    expect(row.rows).toEqual([{ d: '2026-08-20', by: own.userId, reason: 'Reversed: Transferencia duplicada devuelta' }]);
    expect(await paymentRow(paymentId)).toEqual({ status: 'reversed', reversed_on: '2026-08-20' });

    expect(await entriesOf(paymentId), 'the payment entry has its mirror, dated').toEqual([
      { source_type: 'vendor_payment', mirror_on: '2026-08-20' },
    ]);
    expect(r.reversals).toHaveLength(1);
    const left = await netLeftOf(paymentId);
    for (const [code, net] of Object.entries(left)) expect(net, `account ${code}`).toBe('0.00');
    expect(Object.keys(left)).toEqual(expect.arrayContaining(['2110', '1130', '1135']));

    const rec = await apReconcile(own.entityId, { asOf: '2026-08-20' });
    expect(rec.cuadra).toBe(true);
    expect(rec.partidas).toEqual([]);
  }, 120_000);

  it('mirrors every event of the payment and reopens only what is still applied, discount included', async () => {
    const { billId: first, vendorId } = await approvedBill(f, '1000.00', '160.00');
    const { billId: second } = await approvedBill(f, '1000.00', '160.00');
    const paymentId = await onAccount(f, vendorId, '1100.00');
    await applyVendorPayment(f.entityId, paymentId, [{ documentId: first, amountApplied: '1100.00' }], f.userId);
    await unapplyVendorPayment(f.entityId, paymentId, { billId: first, reason: 'Gasto equivocado' }, f.userId);
    await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: second, amountApplied: '1100.00', discountAmount: '60.00' }], f.userId
    );

    const r = await reverseVendorPayment(f.entityId, paymentId, { reason: 'Devuelto por el banco' }, f.userId);

    expect(r.reversals).toHaveLength(4);
    expect((await entriesOf(paymentId)).every((e) => e.mirror_on !== null)).toBe(true);
    expect(await billRow(first), 'already reopened by the unapply: untouched').toEqual({ amount_due: '1160.0000', amount_paid: '0.0000', status: 'approved' });
    expect(await billRow(second), 'reopened by what was applied plus the discount').toEqual({ amount_due: '1160.0000', amount_paid: '0.0000', status: 'approved' });
    for (const [code, net] of Object.entries(await netLeftOf(paymentId))) expect(net, `account ${code}`).toBe('0.00');
    const live = await query(`SELECT 1 FROM payment_applications WHERE payment_id = $1 AND unapplied_at IS NULL`, [paymentId]);
    expect(live.rows).toHaveLength(0);
  }, 120_000);

  it('a dry run writes nothing', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    const r = await reverseVendorPayment(f.entityId, paymentId, { reason: 'Ensayo' }, f.userId, { dryRun: true });
    expect(r.reversals).toHaveLength(1);
    expect(r.documents[0].saldoNuevo).toBe('116.00');
    expect(await billRow(billId)).toMatchObject({ amount_due: '0.0000', status: 'paid' });
    expect(await paymentRow(paymentId)).toEqual({ status: 'completed', reversed_on: null });
    expect((await entriesOf(paymentId))[0].mirror_on).toBeNull();
  }, 120_000);
});

describe('payment reverse refuses what it cannot undo exactly', () => {
  it('a payment already reversed', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    await reverseVendorPayment(f.entityId, paymentId, { reason: 'Primera' }, f.userId);
    await expect(
      reverseVendorPayment(f.entityId, paymentId, { reason: 'Segunda' }, f.userId)
    ).rejects.toThrow(/'reversed'/);
  }, 120_000);

  it('a date before the payment\'s last posted event, or in the future, or no reason', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    await expect(
      reverseVendorPayment(f.entityId, paymentId, { reason: 'x', date: '2026-08-14' }, f.userId)
    ).rejects.toThrow(/2026-08-15/);
    await expect(
      reverseVendorPayment(f.entityId, paymentId, { reason: 'x', date: '2099-01-01' }, f.userId)
    ).rejects.toThrow(/future/);
    await expect(
      reverseVendorPayment(f.entityId, paymentId, { reason: '  ' }, f.userId)
    ).rejects.toThrow(/why/);
  }, 120_000);

  it('a bill closed short: the written-off balance is stored nowhere to give back', async () => {
    const { billId, vendorId } = await approvedBill(f, '1000.00', '160.00');
    const paymentId = await onAccount(f, vendorId, '1000.00');
    await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: billId, amountApplied: '1000.00' }], f.userId,
      { modo: 'residual', shortPayReason: 'Nota de credito nunca emitida' }
    );
    await expect(
      reverseVendorPayment(f.entityId, paymentId, { reason: 'x' }, f.userId)
    ).rejects.toThrow(/short/);
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'completed' });
  }, 120_000);
});

describe('payment reverse from the terminal', () => {
  const plain = {
    dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
    red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
  };

  async function cli(argv: string[]): Promise<{ exitCode?: number; out: string }> {
    let exitCode: number | undefined;
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const p = new Command('mnemosine');
      registerPaymentCommands(p, {
        palette: plain,
        shutdown: (c: number) => { exitCode = c; },
        reportError: (e: unknown) => { out.push(`${(e as Error).message}\n`); },
      });
      await p.parseAsync(['node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId, '-y']);
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
    return { exitCode, out: out.join('') };
  }

  async function numbersOf(billId: string, paymentId: string): Promise<{ bill: string; pay: string }> {
    const r = await query<{ bill: string; pay: string }>(
      `SELECT b.bill_number AS bill, vp.payment_number AS pay
         FROM bills b, vendor_payments vp WHERE b.id = $1 AND vp.id = $2`,
      [billId, paymentId]
    );
    return r.rows[0];
  }

  it('previews with --dry-run, then reverses on the date given', async () => {
    const { billId, vendorId } = await approvedBill(f, '500.00', '80.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '580.00');
    const { bill, pay } = await numbersOf(billId, paymentId);
    const args = ['payment', 'reverse', pay, '--reason', 'Duplicate SPEI transfer returned', '--date', '2026-08-31'];

    const dry = await cli([...args, '--dry-run']);
    expect(dry.exitCode, dry.out).toBe(0);
    expect(dry.out).toContain(`Would reverse ${pay}`);
    expect(dry.out).toContain(bill);
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'completed' });

    const real = await cli([...args, '--json']);
    expect(real.exitCode, real.out).toBe(0);
    expect(real.out).toContain('"date": "2026-08-31"');
    expect(await paymentRow(paymentId)).toEqual({ status: 'reversed', reversed_on: '2026-08-31' });
    expect(await billRow(billId)).toEqual({ amount_due: '580.0000', amount_paid: '0.0000', status: 'approved' });
  }, 120_000);

  it('a retry with the same --idempotency-key returns the recorded result and writes nothing', async () => {
    const { billId, vendorId } = await approvedBill(f, '500.00', '80.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '580.00');
    const { pay } = await numbersOf(billId, paymentId);
    const args = ['payment', 'reverse', pay, '--reason', 'Duplicate', '--idempotency-key', `k-${paymentId}`];

    expect((await cli(args)).exitCode).toBe(0);
    const again = await cli(args);
    expect(again.exitCode, again.out).toBe(0);
    expect(again.out).toContain('Idempotency hit');
    const mirrors = await query(
      `SELECT 1 FROM journal_entries WHERE reverses_entry_id IN (SELECT id FROM journal_entries WHERE source_id = $1)`,
      [paymentId]
    );
    expect(mirrors.rows).toHaveLength(1);
  }, 120_000);
});
