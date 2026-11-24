import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, getClient, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';

/**
 * MNE-001-677 (#787, part 1 of 3): migration 344 gives a vendor application
 * the column for the day it was applied, and nothing else. Against real
 * Postgres; all data is synthetic.
 *
 *   T1  the column is a DATE, nullable, with no default, and carries its comment
 *   T2  a row that was there before the migration reads NULL and keeps its
 *       amount and its created_at; the file runs a second time without error
 */

const FILE = path.join(
  __dirname, '..', '..', 'src', 'database', 'migrations',
  '344_a_vendor_application_keeps_the_day_it_was_applied.sql'
);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-677: payment_applications.applied_on (migration 344)', () => {
  it('T1: the column is a nullable DATE with no default, and its comment says what a NULL means', async () => {
    const { rows } = await query<{ data_type: string; is_nullable: string; column_default: string | null; comment: string | null }>(
      `SELECT c.data_type, c.is_nullable, c.column_default,
              col_description('public.payment_applications'::regclass, c.ordinal_position) AS comment
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = 'payment_applications' AND c.column_name = 'applied_on'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('date');
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].column_default).toBeNull();
    expect(rows[0].comment).toMatch(/NULL on rows written before/);
    expect(rows[0].comment).toMatch(/payment_date/);
  });

  it('T2: a row written before the migration reads NULL, unchanged, and the file is safe to run twice', async () => {
    const f = await crearInquilino('MNE-001-677');
    const vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
        payment_terms, currency_code, created_by)
       VALUES ($1,$2,$3,'Proveedor 677','XEXX010101000','rfc','Net 30','MXN',$4)`,
      [vendorId, f.entityId, `V-677-${vendorId.slice(0, 8)}`, f.userId]
    );
    // A PPD bill of 1,160.00 (VAT 160.00) of 10 March, and a payment on
    // account of 1,160.00 of 20 March: the example of issue #787.
    const bill = await seedBill(f, { vendorId, method: 'PPD', vatCode: '1135', date: '2026-03-10' });
    const paymentId = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
        currency_code, payment_method, payment_date, status, created_by)
       VALUES ($1,$2,$3,$4,1160,'MXN','spei','2026-03-20','completed',$5)`,
      [paymentId, f.entityId, `VPMT-677-${paymentId.slice(0, 6)}`, vendorId, f.userId]
    );

    const sql = fs.readFileSync(FILE, 'utf-8');
    const applicationId = uuidv4();
    const client = await getClient();
    try {
      // One transaction, rolled back: the table as it was at 343, a row
      // written on it, then the migration. DDL is transactional in Postgres,
      // so the suite's database is left as it was found.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [f.tenantId]);
      await client.query('ALTER TABLE payment_applications DROP COLUMN applied_on');
      await client.query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied) VALUES ($1,$2,$3,1160)`,
        [applicationId, paymentId, bill.id]
      );
      const before = await client.query<{ amount: string; created: string }>(
        `SELECT amount_applied::text AS amount, created_at::text AS created FROM payment_applications WHERE id = $1`,
        [applicationId]
      );

      await client.query(sql);
      const after = await client.query<{ applied_on: string | null; amount: string; created: string }>(
        `SELECT applied_on::text AS applied_on, amount_applied::text AS amount, created_at::text AS created
           FROM payment_applications WHERE id = $1`,
        [applicationId]
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].applied_on).toBeNull();
      expect(after.rows[0].amount).toBe('1160.0000');
      expect(after.rows[0].amount).toBe(before.rows[0].amount);
      expect(after.rows[0].created).toBe(before.rows[0].created);

      // IF NOT EXISTS: a second run is a no-op, and the row still reads NULL.
      await client.query(sql);
      const again = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM payment_applications WHERE id = $1 AND applied_on IS NULL`,
        [applicationId]
      );
      expect(again.rows[0].n).toBe('1');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // The rollback took the row with it and left the column in place.
    const left = await query<{ n: string }>(
      `SELECT COUNT(applied_on)::text AS n FROM payment_applications WHERE payment_id = $1`,
      [paymentId]
    );
    expect(left.rows[0].n).toBe('0');
  });
});
