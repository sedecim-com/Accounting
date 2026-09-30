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
let entityB: string;

async function vendor(
  n: string,
  taxId: string | null,
  is1099 = true,
  taxIdType: string | null = taxId ? 'ein' : null,
  entityId: string = f.entityId
) {
  const id = uuidv4();
  ids[n] = id;
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, is_1099_vendor,
       currency_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8)`,
    [id, entityId, n, `Vendor ${n}`, taxId, taxIdType, is1099, f.userId]
  );
}

async function pay(
  n: string,
  amount: string,
  date: string,
  opts: { method?: string; status?: string; ccy?: string; entityId?: string } = {}
) {
  await query(
    `INSERT INTO vendor_payments (entity_id, payment_number, vendor_id, payment_amount, currency_code,
       payment_method, payment_date, status, reversed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      opts.entityId ?? f.entityId,
      uuidv4().slice(0, 12),
      ids[n],
      amount,
      opts.ccy ?? 'USD',
      opts.method ?? 'ach',
      date,
      opts.status ?? 'completed',
      opts.status === 'reversed' ? date : null,
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
  await vendor('V-BADTIN', '1234', true); // ein-typed but malformed
  await vendor('V-RFC', 'XAXX010101000', true, 'rfc'); // a tax id the model cannot check as a US TIN
  await vendor('V-NOHYPHEN', '123456789'); // a valid EIN written without the hyphen
  await vendor('V-ROUND', null);
  await vendor('V-STALE', '33-3333333');
  // A second entity in the SAME tenant, with its own 1099 vendor.
  entityB = uuidv4();
  await query(
    `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
       incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active)
     SELECT $1, tenant_id, organization_id, 'Entity B', entity_type, tax_id, tax_id_type,
            incorporation_country, functional_currency, accounting_standard, 1, true
       FROM legal_entities WHERE id = $2`,
    [entityB, f.entityId]
  );
  await vendor('V-B', '44-4444444', true, 'ein', entityB);
  await pay('V-B', '7000.00', '2025-06-01', { entityId: entityB });
  await pay('V-BADTIN', '800.00', '2025-06-01');
  await pay('V-RFC', '800.00', '2025-06-01');
  await pay('V-NOHYPHEN', '800.00', '2025-06-01');
  await pay('V-ROUND', '1000.03', '2025-06-01'); // 24 % = 240.0072, rounds to 240.01
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
  await pay('V-EXCL', '9000.00', '2025-06-01', { status: 'reversed' });
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
      tinStatus: 'missing',
      backupWithholding: { rate: '0.2400', amount: '240.0000' },
    });
  });

  it('rounds the backup withholding to cents', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    const g = r.generated.find((x) => x.vendorId === ids['V-ROUND'])!;
    expect(g.backupWithholding).toEqual({ rate: '0.2400', amount: '240.0100' });
  });

  it('does not tell the firm to withhold from a payee whose tax id it cannot check', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    for (const n of ['V-BADTIN', 'V-RFC']) {
      const g = r.generated.find((x) => x.vendorId === ids[n])!;
      expect(g).toMatchObject({ hasTin: false, tinStatus: 'unverifiable', status: 'draft', backupWithholding: null });
    }
    const row = await query<{ data: { tin_missing: boolean; tin_status: string } }>(
      `SELECT data FROM tax_form_filings WHERE entity_id = $1 AND form_type = '1099_nec'
        AND tax_year = 2025 AND vendor_id = $2`,
      [f.entityId, ids['V-RFC']]
    );
    expect(row.rows[0].data).toMatchObject({ tin_missing: false, tin_status: 'unverifiable' });
  });

  it('accepts a valid EIN written without the hyphen, by the vendor service rule', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    const g = r.generated.find((x) => x.vendorId === ids['V-NOHYPHEN'])!;
    expect(g).toMatchObject({ hasTin: true, tinStatus: 'valid', status: 'ready' });
  });

  it('reports the non-USD payments it leaves out instead of dropping them', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(r.excluded).toEqual([{ vendorId: ids['V-EXCL'], currency: 'EUR', count: 1, total: '9000.0000' }]);
  });

  it('withdraws a draft/ready filing whose payment was later reversed', async () => {
    await pay('V-STALE', '1000.00', '2025-05-01');
    const first = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(first.generated.map((g) => g.vendorId)).toContain(ids['V-STALE']);
    await query(
      `UPDATE vendor_payments SET status = 'reversed', reversed_at = '2025-05-02'
        WHERE vendor_id = $1`,
      [ids['V-STALE']]
    );
    const second = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(second.withdrawn).toEqual([ids['V-STALE']]);
    const rows = await query(
      `SELECT 1 FROM tax_form_filings WHERE entity_id = $1 AND form_type = '1099_nec'
        AND tax_year = 2025 AND vendor_id = $2`,
      [f.entityId, ids['V-STALE']]
    );
    expect(rows.rowCount).toBe(0);
  });

  it('never returns or writes a vendor of another entity of the same tenant', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(r.generated.map((g) => g.vendorId)).not.toContain(ids['V-B']);
    const leak = await query(
      `SELECT 1 FROM tax_form_filings WHERE entity_id = $1 AND vendor_id = $2`,
      [f.entityId, ids['V-B']]
    );
    expect(leak.rowCount).toBe(0);
    const b = await generate1099Nec(f.tenantId, entityB, 2025);
    expect(b.generated.map((g) => g.vendorId)).toEqual([ids['V-B']]);
  });

  it('leaves out a vendor under the threshold, a non-1099 vendor, and card, void, reversed and foreign payments', async () => {
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    const got = r.generated.map((g) => g.vendorId);
    expect(got.sort()).toEqual(
      [ids['V-TIN'], ids['V-NOTIN'], ids['V-BADTIN'], ids['V-RFC'], ids['V-NOHYPHEN'], ids['V-ROUND']].sort()
    );
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
    expect(count.rows[0].n).toBe('6');
    await query(
      `UPDATE tax_form_filings SET status = 'filed' WHERE entity_id = $1 AND form_type = '1099_nec'
        AND tax_year = 2025 AND vendor_id = $2`,
      [f.entityId, ids['V-TIN']]
    );
    await pay('V-TIN', '100.00', '2025-12-01');
    const r = await generate1099Nec(f.tenantId, f.entityId, 2025);
    expect(r.locked).toEqual([
      { vendorId: ids['V-TIN'], status: 'filed', storedTotal: '700.0000', currentTotal: '800.0000', changed: true },
    ]);
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
