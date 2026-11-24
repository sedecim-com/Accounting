import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { todayFor } from '../../src/services/policy/today.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-678 (#787, part 2/3) · A VENDOR APPLICATION IS DATED.
 *
 * `payment apply --date` (default: today in the entity's zone) dates the
 * entry, the application (`applied_on`, migration 344) and the bill's last
 * payment. What would put the application before what it depends on is
 * refused, names the date and writes nothing. `payment create` stores the
 * payment's own date on each application. The leaves run in-process against
 * Postgres.
 *
 * Every bill is a seeded PPD with its VAT parked in 1135; the figures are
 * worked by hand in each case.
 */

let mx: Fixture;
let vendorId: string;
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Runs `payment <argv> --yes --json` as the binary would and returns its first row. */
async function payment(argv: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerPaymentCommands(program, {
      palette: plain,
      shutdown: () => undefined,
      reportError: (e: unknown) => { errors.push(e); },
    });
    await program.parseAsync(['node', 'mnemosine', 'payment', ...argv, '-e', mx.entityId, '-t', mx.tenantId, '-y', '--json']);
  } catch (e) {
    errors.push(e);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) throw new Error(`payment ${argv.join(' ')} → ${exitCodeFor(errors[0])}: ${(errors[0] as Error).message}`);
  return (JSON.parse(out.join('')) as { rows: Record<string, unknown>[] }).rows[0];
}

/** A posted PPD bill dated `day`, its VAT parked in 1135: 1,000.00 + 160.00 unless told otherwise. */
async function bill(day: string, subtotal = '1000.00', vat = '160.00'): Promise<{ id: string; number: string }> {
  const { id } = await seedBill(mx, { vendorId, method: 'PPD', vatCode: '1135', date: day, subtotal, vat });
  const r = await query<{ bill_number: string }>(`SELECT bill_number FROM bills WHERE id = $1 AND entity_id = $2`, [id, mx.entityId]);
  return { id, number: r.rows[0].bill_number };
}

/** Cash paid to the vendor on account on `day`, naming no bill. */
async function onAccount(day: string, amount = '1160.00'): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: mx.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: day,
      paymentMethod: 'spei', applications: [], onAccount: true,
    },
    mx.userId
  );
  return r.paymentNumber;
}

async function entryDate(entryNumber: unknown): Promise<string> {
  const r = await query<{ d: string }>(
    `SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM journal_entries WHERE entity_id = $1 AND entry_number = $2`,
    [mx.entityId, entryNumber]
  );
  return r.rows[0].d;
}

/** What an entry moved, per account code, as [debit, credit]. */
async function linesOf(entryNumber: unknown): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::numeric(18,2)::text AS debit,
            COALESCE(SUM(l.credit_amount), 0)::numeric(18,2)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.entry_number = $2
      GROUP BY a.code`,
    [mx.entityId, entryNumber]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [l.debit, l.credit] as [string, string]]));
}

/** The day each application of a payment stored, oldest first. */
async function appliedOn(paymentNumber: string): Promise<(string | null)[]> {
  const r = await query<{ d: string | null }>(
    `SELECT to_char(pa.applied_on, 'YYYY-MM-DD') AS d
       FROM payment_applications pa JOIN vendor_payments vp ON vp.id = pa.payment_id
      WHERE vp.entity_id = $1 AND vp.payment_number = $2
      ORDER BY pa.created_at`,
    [mx.entityId, paymentNumber]
  );
  return r.rows.map((row) => row.d);
}

async function billRow(billId: string): Promise<{ due: string; status: string; last_paid: string | null }> {
  const r = await query<{ due: string; status: string; last_paid: string | null }>(
    `SELECT amount_due::numeric(18,2)::text AS due, status, to_char(last_payment_date, 'YYYY-MM-DD') AS last_paid
       FROM bills WHERE id = $1 AND entity_id = $2`,
    [billId, mx.entityId]
  );
  return r.rows[0];
}

/** What the payment has written: its applications and its entries. */
async function written(paymentNumber: string): Promise<{ applications: number; entries: number }> {
  const r = await query<{ a: string; e: string }>(
    `SELECT (SELECT COUNT(*) FROM payment_applications WHERE payment_id = vp.id)::text AS a,
            (SELECT COUNT(*) FROM journal_entries WHERE entity_id = vp.entity_id AND source_id = vp.id)::text AS e
       FROM vendor_payments vp WHERE vp.entity_id = $1 AND vp.payment_number = $2`,
    [mx.entityId, paymentNumber]
  );
  return { applications: Number(r.rows[0].a), entries: Number(r.rows[0].e) };
}

const OWED = { due: '1160.00', status: 'posted', last_paid: null };

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-678 dated vendor application MX');
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-678', 'Synthetic Dated Vendor SA', 'SIN060101AB1', 'rfc', 'MXN', $3)`,
    [vendorId, mx.entityId, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('payment apply --date dates the application', () => {
  it('a payment of March 20th applied --date 2026-05-10 posts that day and stamps it on the row and on the bill', async () => {
    const b = await bill('2026-03-10');
    const vp = await onAccount('2026-03-20');

    const out = await payment(['apply', vp, '--bill', b.number, '--amount', '1160.00', '--date', '2026-05-10']);

    expect(out.date).toBe('2026-05-10');
    expect(await entryDate(out.journal_entry)).toBe('2026-05-10');
    // DR 2110 1,160.00 / CR 1150 1,160.00, and the bill's 160.00 of VAT: DR 1130 / CR 1135.
    expect(await linesOf(out.journal_entry)).toEqual({
      '2110': ['1160.00', '0.00'],
      '1150': ['0.00', '1160.00'],
      '1130': ['160.00', '0.00'],
      '1135': ['0.00', '160.00'],
    });
    expect(await appliedOn(vp)).toEqual(['2026-05-10']);
    expect(await billRow(b.id)).toEqual({ due: '0.00', status: 'paid', last_paid: '2026-05-10' });
  });

  it('two applications of one payment in two months: 580.00 each, 80.00 of VAT each, each on its day', async () => {
    const b = await bill('2026-03-10');
    const vp = await onAccount('2026-03-20');

    const april = await payment(['apply', vp, '--bill', b.number, '--amount', '580.00', '--date', '2026-04-10']);
    const may = await payment(['apply', vp, '--bill', b.number, '--amount', '580.00', '--date', '2026-05-10']);

    // 160.00 × 580.00 / 1,160.00 = 80.00 for each half.
    for (const [out, day] of [[april, '2026-04-10'], [may, '2026-05-10']] as const) {
      expect(await entryDate(out.journal_entry)).toBe(day);
      expect(await linesOf(out.journal_entry)).toEqual({
        '2110': ['580.00', '0.00'],
        '1150': ['0.00', '580.00'],
        '1130': ['80.00', '0.00'],
        '1135': ['0.00', '80.00'],
      });
    }
    expect(await appliedOn(vp)).toEqual(['2026-04-10', '2026-05-10']);
    expect(await billRow(b.id)).toEqual({ due: '0.00', status: 'paid', last_paid: '2026-05-10' });
  });

  it('--dry-run carries the day and writes nothing', async () => {
    const b = await bill('2026-03-10');
    const vp = await onAccount('2026-03-20');
    const before = await written(vp);

    const out = await payment(['apply', vp, '--bill', b.number, '--amount', '1160.00', '--date', '2026-05-10', '--dry-run']);

    expect(out).toMatchObject({ date: '2026-05-10', dry_run: true });
    expect(await written(vp)).toEqual(before);
    expect(await billRow(b.id)).toEqual(OWED);
  });

  it('the bill\'s last payment is never moved back, and payment create stores the payment\'s own date', async () => {
    // 2,000.00 + 320.00 = 2,320.00, paid in two halves of 1,160.00.
    const b = await bill('2026-03-10', '2000.00', '320.00');
    const created = await recordVendorPayment(
      {
        entityId: mx.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: '2026-06-15',
        paymentMethod: 'spei', applications: [{ documentId: b.id, amountApplied: '1160.00' }],
      },
      mx.userId
    );
    expect(await appliedOn(created.paymentNumber)).toEqual(['2026-06-15']);
    expect(await entryDate(created.journalEntry!.entry_number)).toBe('2026-06-15');
    expect((await billRow(b.id)).last_paid).toBe('2026-06-15');

    const earlier = await onAccount('2026-04-01');
    await payment(['apply', earlier, '--bill', b.number, '--amount', '1160.00', '--date', '2026-04-20']);

    expect(await appliedOn(earlier)).toEqual(['2026-04-20']);
    expect(await billRow(b.id)).toEqual({ due: '0.00', status: 'paid', last_paid: '2026-06-15' });
  });

  it('the discount window is read on the payment\'s day, not on the application\'s', async () => {
    // 2/10 net 30 on 1,160.00 dated July 1st: 2 % = 23.20, so 1,136.80 of cash settles it.
    // Paid on July 8th (day 7, inside the window) and applied on July 25th (day 24, outside).
    const b = await bill('2026-07-01');
    await query(`UPDATE bills SET terms = '2/10 net 30' WHERE id = $1 AND entity_id = $2`, [b.id, mx.entityId]);
    const vp = await onAccount('2026-07-08', '1136.80');

    const out = await payment([
      'apply', vp, '--bill', b.number, '--amount', '1136.80', '--discount', '23.20', '--date', '2026-07-25',
    ]);

    expect(out.discounts_outside_terms).toEqual([]);
    expect(await appliedOn(vp)).toEqual(['2026-07-25']);
    expect(await billRow(b.id)).toEqual({ due: '0.00', status: 'paid', last_paid: '2026-07-25' });
  });
});

describe('a date that would put the application before what it depends on is refused, writing nothing', () => {
  it('a date before the payment', async () => {
    const b = await bill('2026-06-01');
    const vp = await onAccount('2026-06-10');
    const before = await written(vp);
    await expect(
      payment(['apply', vp, '--bill', b.number, '--amount', '1160.00', '--date', '2026-06-09'])
    ).rejects.toThrow(new RegExp(`${vp} was last posted on 2026-06-10: an application dated 2026-06-09 would apply its cash before that happened`));
    expect(await written(vp)).toEqual(before);
    expect(await billRow(b.id)).toEqual(OWED);
  });

  it('a date before the payment\'s last application', async () => {
    const b = await bill('2026-03-10');
    const vp = await onAccount('2026-03-20');
    await payment(['apply', vp, '--bill', b.number, '--amount', '580.00', '--date', '2026-05-10']);
    const before = await written(vp);
    await expect(
      payment(['apply', vp, '--bill', b.number, '--amount', '580.00', '--date', '2026-04-30'])
    ).rejects.toThrow(/was last posted on 2026-05-10: an application dated 2026-04-30/);
    expect(await written(vp)).toEqual(before);
    expect(await billRow(b.id)).toEqual({ due: '580.00', status: 'partially_paid', last_paid: '2026-05-10' });
  });

  it('a date before the bill', async () => {
    const vp = await onAccount('2026-06-10');
    const b = await bill('2026-06-15');
    const before = await written(vp);
    await expect(
      payment(['apply', vp, '--bill', b.number, '--amount', '1160.00', '--date', '2026-06-12'])
    ).rejects.toThrow(new RegExp(`${b.number} is dated 2026-06-15: cash applied on 2026-06-12 would settle it before the bill existed`));
    expect(await written(vp)).toEqual(before);
    expect(await billRow(b.id)).toEqual(OWED);
  });

  it('a date after today in the entity\'s zone', async () => {
    const b = await bill('2026-06-01');
    const vp = await onAccount('2026-06-10');
    const today = await todayFor({ tenantId: mx.tenantId, entityId: mx.entityId });
    const tomorrow = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1))
      .toISOString().slice(0, 10);
    const before = await written(vp);
    await expect(
      payment(['apply', vp, '--bill', b.number, '--amount', '1160.00', '--date', tomorrow])
    ).rejects.toThrow(new RegExp(`${vp} cannot be applied on ${tomorrow}: that is after today \\(${today}\\)`));
    expect(await written(vp)).toEqual(before);
    expect(await billRow(b.id)).toEqual(OWED);
  });

  it('a date in a hard-closed period', async () => {
    const b = await bill('2026-01-05');
    const vp = await onAccount('2026-01-10');
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2`, [mx.periodos[2], mx.entityId]);
    const before = await written(vp);
    await expect(
      payment(['apply', vp, '--bill', b.number, '--amount', '1160.00', '--date', '2026-02-15'])
    ).rejects.toThrow(new RegExp(`${vp} cannot be applied on 2026-02-15: that day has no open fiscal period`));
    expect(await written(vp)).toEqual(before);
    expect(await billRow(b.id)).toEqual(OWED);
  });
});

// Last: it gives the entity its own zone and a fixed clock.
describe('with no --date the day is today in the entity\'s zone', () => {
  it('payment apply and payment unapply take Tokyo\'s day while the process clock is still on the day before', async () => {
    const b = await bill('2026-10-01');
    const vp = await onAccount('2026-10-05');
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options, default_value,
          status, resolved_value, resolved_by, resolved_at, source)
       VALUES ($1, $2, 'zona_horaria', 'operativa', 'q', 'i', '[]'::jsonb, 'America/Mexico_City',
               'resolved', 'Asia/Tokyo', 'test', NOW(), 'test')`,
      [mx.tenantId, mx.entityId]
    );
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-31T16:00:00Z')); // Oct 31 16:00 UTC and 10:00 CDMX, Nov 1 01:00 Tokyo

      const applied = await payment(['apply', vp, '--bill', b.number, '--amount', '1160.00']);
      expect(applied.date).toBe('2026-11-01');
      expect(await entryDate(applied.journal_entry)).toBe('2026-11-01');
      expect(await appliedOn(vp)).toEqual(['2026-11-01']);
      expect((await billRow(b.id)).last_paid).toBe('2026-11-01');

      const undone = await payment(['unapply', vp, '--bill', b.number, '--reason', 'synthetic']);
      expect(undone.date).toBe('2026-11-01');
      expect(await entryDate(undone.journal_entry)).toBe('2026-11-01');
    } finally {
      vi.useRealTimers();
      await query(
        `DELETE FROM policy_decisions WHERE tenant_id = $1 AND entity_id = $2 AND key = 'zona_horaria'`,
        [mx.tenantId, mx.entityId]
      );
    }
  });
});
