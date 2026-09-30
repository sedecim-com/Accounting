import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { generate1099Nec } from '../../src/services/ap/form-1099-nec.js';

// ============================================================
// MNE-001-332 · #124 — 1099-NEC FROM WHAT WAS PAID TO 1099 VENDORS, AGAINST
// POSTGRES. The threshold and the backup rate come from migration 250 with no
// seeder. All data is synthetic.
// ============================================================

let f: Fixture;
const ids: Record<string, string> = {};

async function vendor(n: string, taxId: string | null, is1099 = true) {
  const id = uuidv4();
  ids[n] = id;
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, is_1099_vendor,
       currency_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8)`,
    [id, f.entityId, n, `Vendor ${n}`, taxId, taxId ? 'ein' : null, is1099, f.userId]
  );
}

async function pay(
  n: string,
  amount: string,
  date: string,
  opts: { method?: string; status?: string; ccy?: string } = {}
) {
  await query(
    `INSERT INTO vendor_payments (entity_id, payment_number, vendor_id, payment_amount, currency_code,
       payment_method, payment_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      f.entityId,
      uuidv4().slice(0, 12),
      ids[n],
      amount,
      opts.ccy ?? 'USD',
      opts.method ?? 'ach',
      date,
      opts.status ?? 'completed',
      f.userId,
    ]
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-332 1099-NEC');
  await vendor('V-TIN', '12-3456789');
  await vendor('V-NOTIN', null);
  await vendor('V-LOW', '98-7654321');
  await vendor('V-NOFLAG', '11-1111111', false);
  await vendor('V-EXCL', '22-2222222');
  // 2025: threshold 600.
  await pay('V-TIN', '400.00', '2025-03-01');
  await pay('V-TIN', '300.00', '2025-11-20');
  await pay('V-TIN', '5000.00', '2026-01-05'); // another year
  await pay('V-NOTIN', '1000.00', '2025-06-01');
  await pay('V-LOW', '599.99', '2025-06-01');
  await pay('V-NOFLAG', '9000.00', '2025-06-01');
  // Excluded kinds for V-EXCL: card, void, foreign currency.
  await pay('V-EXCL', '9000.00', '2025-06-01', { method: 'credit_card' });
  await pay('V-EXCL', '9000.00', '2025-06-01', { status: 'void' });
  await pay('V-EXCL', '9000.00', '2025-06-01', { ccy: 'EUR' });
  // 2026: threshold 2 000.
  await pay('V-NOTIN', '1500.00', '2026-02-01');
  await pay('V-LOW', '2000.00', '2026-02-01');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-332 · 1099-NEC from payments', () => {
  it('files a ready 1099-NEC for a vendor with a TIN over the 600 threshold, by payment year', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(r.threshold).toBe('600.0000');
    const tin = r.generated.find((g) => g.vendorId === ids['V-TIN'])!;
    expect(tin).toMatchObject({ totalPaid: '700.0000', hasTin: true, status: 'ready', backupWithholding: null });
    const row = await query<{ status: string; data: { recipient: { tin_last4: string } } }>(
      `SELECT status, data FROM tax_form_filings WHERE entity_id = $1 AND form_type = '1099_nec'
        AND tax_year = 2025 AND vendor_id = $2`,
      [f.entityId, ids['V-TIN']]
    );
    expect(row.rows[0].status).toBe('ready');
    expect(row.rows[0].data.recipient.tin_last4).toBe('6789');
  });

  it('flags backup withholding at 24 % for a vendor with no TIN, and keeps the row as draft', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    const g = r.generated.find((x) => x.vendorId === ids['V-NOTIN'])!;
    expect(g).toMatchObject({
      hasTin: false,
      status: 'draft',
      backupWithholding: { rate: '0.2400', amount: '240.0000' },
    });
  });

  it('leaves out a vendor under the threshold, a non-1099 vendor, and card, void and foreign payments', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    const got = r.generated.map((g) => g.vendorId);
    expect(got.sort()).toEqual([ids['V-TIN'], ids['V-NOTIN']].sort());
  });

  it('reads the threshold in force on the year end: 2 000 for 2026', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2026);
    expect(r.threshold).toBe('2000.0000');
    const byId = new Map(r.generated.map((g) => [g.vendorId, g]));
    expect(byId.get(ids['V-TIN'])!.totalPaid).toBe('5000.0000');
    expect(byId.get(ids['V-LOW'])!.totalPaid).toBe('2000.0000');
    expect(byId.has(ids['V-NOTIN'])).toBe(false); // 1 500 < 2 000
  });

  it('is idempotent and never rewrites a filing already filed', async () => {
    await generate1099Nec(f.tenantId, f.entityId, 2025);
    const count = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tax_form_filings
        WHERE entity_id = $1 AND form_type = '1099_nec' AND tax_year = 2025`,
      [f.entityId]
    );
    expect(count.rows[0].n).toBe('2');
    await query(
      `UPDATE tax_form_filings SET status = 'filed' WHERE entity_id = $1 AND form_type = '1099_nec'
        AND tax_year = 2025 AND vendor_id = $2`,
      [f.entityId, ids['V-TIN']]
    );
    await pay('V-TIN', '100.00', '2025-12-01');
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(r.locked).toEqual([ids['V-TIN']]);
    const row = await query<{ status: string; data: { box_1_nonemployee_compensation: string } }>(
      `SELECT status, data FROM tax_form_filings WHERE entity_id = $1 AND form_type = '1099_nec'
        AND tax_year = 2025 AND vendor_id = $2`,
      [f.entityId, ids['V-TIN']]
    );
    expect(row.rows[0].status).toBe('filed');
    expect(row.rows[0].data.box_1_nonemployee_compensation).toBe('700.0000');
  });

  it('does not see another tenant entity', async () => {
    const other = await crearInquilino('MNE-001-332 other');
    const r = await generate1099Nec(other.tenantId, f.entityId, 2025);
    expect(r.generated).toEqual([]);
  });
});
