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
} from '../../src/services/payments/payment-service.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';

/**
 * T11 · MNE-001-037: `payment unapply`, against the real database.
 *
 * Until 105 a vendor payment applied to the wrong bill could not be undone:
 * payment_applications had no closure, so a duplicated 80,000 transfer left
 * the bill 'paid' forever. The unapply is a NEW, dated event: the row is
 * closed (never deleted), the bill is owed again, the cash goes back on
 * account and the IVA the application released is re-parked exactly.
 */

let f: Fixture;
const PAID_ON = '2026-08-15';

beforeAll(async () => {
  f = await crearInquilino('T11 payment unapply');
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function approvedBill(
  fx: Fixture,
  subtotal: string,
  iva: string,
  terms = 'PPD'
): Promise<{ billId: string; vendorId: string }> {
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,$11)`,
    [billId, fx.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, subtotal, iva, total, PAID_ON, fx.userId, terms]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a credito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, fx.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, fx.userId, { entityId: fx.entityId });
  return { billId, vendorId };
}

/** A payment recorded straight against its bill: the application is born with it. */
async function paidWithBill(fx: Fixture, billId: string, vendorId: string, amount: string): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: fx.entityId,
      counterpartyId: vendorId,
      paymentAmount: amount,
      paymentDate: PAID_ON,
      paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: amount }],
    },
    fx.userId
  );
  return r.paymentId;
}

async function linesOf(entryId: string): Promise<Map<string, { debit: string; credit: string }>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount),0)::text AS debit, COALESCE(SUM(l.credit_amount),0)::text AS credit
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 GROUP BY a.code`,
    [entryId]
  );
  return new Map(r.rows.map((x) => [x.code, { debit: new Decimal(x.debit).toFixed(2), credit: new Decimal(x.credit).toFixed(2) }]));
}

async function billRow(billId: string) {
  const r = await query<{ amount_due: string; amount_paid: string; status: string }>(
    `SELECT amount_due::text, amount_paid::text, status FROM bills WHERE id = $1`,
    [billId]
  );
  return r.rows[0];
}

describe('payment unapply: the duplicated 80,000 transfer can be undone, dated', () => {
  it('reopens the bill, dates the closed row, mirrors the ledger and re-parks the exact IVA', async () => {
    const own = await crearInquilino('T11 as of');
    const { billId, vendorId } = await approvedBill(own, '68965.52', '11034.48');
    const paymentId = await paidWithBill(own, billId, vendorId, '80000.00');

    const born = await query<{ iva_reclass_amount: string | null }>(
      `SELECT iva_reclass_amount::text FROM payment_applications WHERE payment_id = $1`,
      [paymentId]
    );
    expect(born.rows[0].iva_reclass_amount, 'an application born with its payment records the IVA it released').toBe('11034.4800');

    const r = await unapplyVendorPayment(
      own.entityId, paymentId,
      { billId, reason: 'Transferencia duplicada', date: '2026-08-20' },
      own.userId
    );

    expect(await billRow(billId)).toEqual({ amount_due: '80000.0000', amount_paid: '0.0000', status: 'approved' });
    expect(r.remainingOnAccount).toBe('80000.00');

    const row = await query<{ d: string; by: string; reason: string }>(
      `SELECT to_char(unapplied_at, 'YYYY-MM-DD') AS d, unapplied_by::text AS by, unapply_reason AS reason
         FROM payment_applications WHERE payment_id = $1`,
      [paymentId]
    );
    expect(row.rows).toEqual([{ d: '2026-08-20', by: own.userId, reason: 'Transferencia duplicada' }]);

    const entry = await query<{ d: string }>(
      `SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM journal_entries WHERE id = $1`,
      [r.journalEntry.id]
    );
    expect(entry.rows[0].d, 'the ledger carries the unapply on its date').toBe('2026-08-20');
    const lines = await linesOf(r.journalEntry.id);
    expect(lines.get('1150')).toEqual({ debit: '80000.00', credit: '0.00' });
    expect(lines.get('2110')).toEqual({ debit: '0.00', credit: '80000.00' });
    expect(lines.get('1135')).toEqual({ debit: '11034.48', credit: '0.00' });
    expect(lines.get('1130')).toEqual({ debit: '0.00', credit: '11034.48' });

    // The balance as of the unapply date: the subledger owes the bill again
    // and so does the control account, with no "manual entry" on it.
    const rec = await apReconcile(own.entityId, { asOf: '2026-08-20' });
    expect(rec.cuadra).toBe(true);
    expect(rec.partidas).toEqual([]);
  }, 120_000);

  it('puts the cash back on account: the same payment can be applied again, IVA and all', async () => {
    const { billId, vendorId } = await approvedBill(f, '1000.00', '160.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '1160.00');
    await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Aplicado al gasto equivocado' }, f.userId);

    const again = await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: billId, amountApplied: '1160.00' }], f.userId
    );
    expect(again.remanenteAnterior, 'a closed application no longer consumes the payment').toBe('1160.00');
    const lines = await linesOf(again.journalEntry!.id);
    expect(lines.get('1130')?.debit, 'the IVA base counts live applications only').toBe('160.00');
    expect(await billRow(billId)).toMatchObject({ amount_due: '0.0000', status: 'paid' });
  }, 120_000);

  it('a new payment on the reopened bill releases its IVA again', async () => {
    const { billId, vendorId } = await approvedBill(f, '1000.00', '160.00');
    const first = await paidWithBill(f, billId, vendorId, '1160.00');
    await unapplyVendorPayment(f.entityId, first, { billId, reason: 'Pago al proveedor equivocado' }, f.userId);

    const second = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: PAID_ON,
        paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: '1160.00' }] },
      f.userId
    );
    const lines = await linesOf(second.journalEntry!.id);
    expect(lines.get('1130')?.debit, 'the closed application is not prior payment').toBe('160.00');
  }, 120_000);

  it('an application that released no IVA stores 0, and unapplies re-parking nothing', async () => {
    const { billId, vendorId } = await approvedBill(f, '1000.00', '160.00', 'PUE');
    const pay = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: PAID_ON,
        paymentMethod: 'spei', applications: [], onAccount: true },
      f.userId
    );
    await applyVendorPayment(f.entityId, pay.paymentId, [{ documentId: billId, amountApplied: '1160.00' }], f.userId);
    const r = await unapplyVendorPayment(f.entityId, pay.paymentId, { billId, reason: 'Gasto equivocado' }, f.userId);
    expect(r.ivaReparked).toBe('0.00');
    const lines = await linesOf(r.journalEntry.id);
    expect(lines.has('1135')).toBe(false);
  }, 120_000);

  it('gives back the discount the application took', async () => {
    const { billId, vendorId } = await approvedBill(f, '1000.00', '160.00');
    const pay = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1100.00', paymentDate: PAID_ON,
        paymentMethod: 'spei', applications: [], onAccount: true },
      f.userId
    );
    await applyVendorPayment(
      f.entityId, pay.paymentId,
      [{ documentId: billId, amountApplied: '1100.00', discountAmount: '60.00' }], f.userId
    );
    const r = await unapplyVendorPayment(f.entityId, pay.paymentId, { billId, reason: 'Descuento no pactado' }, f.userId);

    const lines = await linesOf(r.journalEntry.id);
    expect(lines.get('1150')?.debit).toBe('1100.00');
    expect(lines.get('5200')?.debit).toBe('60.00');
    expect(lines.get('2110')?.credit).toBe('1160.00');
    expect(await billRow(billId)).toEqual({ amount_due: '1160.0000', amount_paid: '0.0000', status: 'approved' });
  }, 120_000);

  it('a dry run writes nothing', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    const r = await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Ensayo' }, f.userId, { dryRun: true });
    expect(r.document.saldoNuevo).toBe('116.00');
    expect(await billRow(billId)).toMatchObject({ amount_due: '0.0000', status: 'paid' });
    const live = await query(`SELECT 1 FROM payment_applications WHERE payment_id = $1 AND unapplied_at IS NULL`, [paymentId]);
    expect(live.rows).toHaveLength(1);
  }, 120_000);
});

describe('payment unapply refuses what it cannot undo exactly', () => {
  it('a date before the payment\'s last posted event, or in the future', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    await expect(
      unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'x', date: '2026-08-14' }, f.userId)
    ).rejects.toThrow(/2026-08-15/);
    await expect(
      unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'x', date: '2099-01-01' }, f.userId)
    ).rejects.toThrow(/future/);
  }, 120_000);

  it('a bill with nothing live from that payment', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Primera' }, f.userId);
    await expect(
      unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Segunda' }, f.userId)
    ).rejects.toThrow(/no live application/);
  }, 120_000);

  it('a row written before 105, which never stored the IVA it released', async () => {
    const { billId, vendorId } = await approvedBill(f, '100.00', '16.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '116.00');
    await query(`UPDATE payment_applications SET iva_reclass_amount = NULL WHERE payment_id = $1`, [paymentId]);
    await expect(
      unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'x' }, f.userId)
    ).rejects.toThrow(/predates migration 105/);
  }, 120_000);

  it('a bill closed short: the written-off balance is stored nowhere to give back', async () => {
    const { billId, vendorId } = await approvedBill(f, '1000.00', '160.00');
    const pay = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1000.00', paymentDate: PAID_ON,
        paymentMethod: 'spei', applications: [], onAccount: true },
      f.userId
    );
    await applyVendorPayment(
      f.entityId, pay.paymentId, [{ documentId: billId, amountApplied: '1000.00' }], f.userId,
      { modo: 'residual', shortPayReason: 'Nota de credito nunca emitida' }
    );
    await expect(
      unapplyVendorPayment(f.entityId, pay.paymentId, { billId, reason: 'x' }, f.userId)
    ).rejects.toThrow(/short/);
  }, 120_000);
});

describe('payment unapply from the terminal', () => {
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

  it('previews with --dry-run, then unapplies on the date given', async () => {
    const { billId, vendorId } = await approvedBill(f, '500.00', '80.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '580.00');
    const nums = await query<{ bill: string; pay: string }>(
      `SELECT b.bill_number AS bill, vp.payment_number AS pay
         FROM bills b, vendor_payments vp WHERE b.id = $1 AND vp.id = $2`,
      [billId, paymentId]
    );
    const { bill, pay } = nums.rows[0];
    const args = ['payment', 'unapply', pay, '--bill', bill, '--reason', 'Duplicate SPEI transfer', '--date', '2026-08-31'];

    const dry = await cli([...args, '--dry-run']);
    expect(dry.exitCode, dry.out).toBe(0);
    expect(dry.out).toContain(`Would unapply ${pay}`);
    expect(await billRow(billId)).toMatchObject({ status: 'paid' });

    const real = await cli([...args, '--json']);
    expect(real.exitCode, real.out).toBe(0);
    expect(real.out).toContain('"date": "2026-08-31"');
    expect(await billRow(billId)).toEqual({ amount_due: '580.0000', amount_paid: '0.0000', status: 'approved' });
  }, 120_000);

  it('a retry with the same --idempotency-key returns the recorded result and writes nothing', async () => {
    const { billId, vendorId } = await approvedBill(f, '500.00', '80.00');
    const paymentId = await paidWithBill(f, billId, vendorId, '580.00');
    const nums = await query<{ bill: string; pay: string }>(
      `SELECT b.bill_number AS bill, vp.payment_number AS pay
         FROM bills b, vendor_payments vp WHERE b.id = $1 AND vp.id = $2`,
      [billId, paymentId]
    );
    const { bill, pay } = nums.rows[0];
    const args = ['payment', 'unapply', pay, '--bill', bill, '--reason', 'Duplicate', '--idempotency-key', `k-${paymentId}`];

    expect((await cli(args)).exitCode).toBe(0);
    const again = await cli(args);
    expect(again.exitCode, again.out).toBe(0);
    expect(again.out).toContain('Idempotency hit');
    const entries = await query(
      `SELECT 1 FROM journal_entries WHERE source_id = $1 AND source_type = 'vendor_unapplication'`,
      [paymentId]
    );
    expect(entries.rows).toHaveLength(1);
  }, 120_000);
});
