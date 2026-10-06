import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, closeDatabase, getClient } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  PreRegistrationService,
  registrarFacturaDeBorradorAprobado,
} from '../../src/services/xml-ingestion/pre-registration-service.js';
import { createVendor } from '../../src/services/ap/vendor-service.js';
import { createBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

// ============================================================
// MNE-001-399 (#432) · THE INBOX NUMBERS BILLS WITH THE ENTITY'S ATOMIC COUNTER
//
// The inbox used COUNT(*) + 1 over every bill and the server clock's year, so
// it collided with `bill create` (nextEntityNumber), raced under concurrency,
// counted every year together and put a December CFDI approved in January in
// the next year's series. Each test drives the real path: an uploaded CFDI
// approved through processToAccounting or the draft approval. Every test
// builds its own entity, so each one passes alone (-t) and in any order.
//
// The review of the PR found that moving only the inbox vendor path to the
// counter collided with `vendor create` (COUNT-based); now every vendor writer
// shares `vendor_<year>` and migration 176 reseeds the counters from the
// numbers already issued.
// ============================================================

const XML = fs.readFileSync(path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8');
const UUID_IN_XML = /UUID="([0-9A-Fa-f-]{36})"/.exec(XML)![1];
const RESEED = fs.readFileSync(
  path.resolve(__dirname, '../../src/database/migrations/176_bill_and_vendor_counters_cover_the_numbers_already_issued.sql'),
  'utf-8'
);
const service = new PreRegistrationService();
const YEAR = new Date().getFullYear();

let f: Fixture;
let vendorId: string;
let expenseAccountId: string;

beforeEach(async () => {
  f = await crearInquilino('MNE-001-399 inbox numbering');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by)
     VALUES ($1, $2, 'V-TEST-399', 'Proveedor 399', $3)`,
    [vendorId, f.entityId, f.userId]
  );
  expenseAccountId = (await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`, [f.entityId]
  )).rows[0].id;
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

/** Uploads a fresh CFDI and leaves its pre-registration ready, dated `documentDate`. */
async function readyPreReg(documentDate: string): Promise<Record<string, unknown>> {
  const uuid = uuidv4().toUpperCase();
  await service.processXMLUpload(f.entityId, XML.replace(UUID_IN_XML, uuid), 'api', f.userId);
  const id = (await query<{ id: string }>(
    `SELECT p.id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows[0].id;
  await query(
    `UPDATE pre_registrations
        SET vendor_id = $2, status = 'ready', default_account_id = $3, document_date = $4, document_type = 'bill'
      WHERE id = $1`,
    [id, vendorId, expenseAccountId, documentDate]
  );
  return (await query<Record<string, unknown>>(`SELECT * FROM pre_registrations WHERE id = $1`, [id])).rows[0];
}

async function approve(documentDate: string): Promise<string> {
  const preReg = await readyPreReg(documentDate);
  const r = await service.processToAccounting(preReg, f.userId);
  return r.bill!.bill_number as string;
}

/** The approval of an AI draft of a ready pre-registration (the second caller), committed or rolled back. */
async function approveDraft(documentDate: string, commit: boolean): Promise<string> {
  const preReg = await readyPreReg(documentDate);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const bill = await registrarFacturaDeBorradorAprobado(client, {
      tenantId: f.tenantId, entityId: f.entityId, preRegistrationId: String(preReg.id),
      approvedLines: [
        { account_code: '6100', debit: 3500, description: 'Consulting' },
        { account_code: '1135', debit: 560 },
        { account_code: '2110', credit: 4060 },
      ],
      approvedDescription: 'Approved draft', userId: f.userId,
      accountIdByCode: new Map((await client.query<{ code: string; id: string }>(
        'SELECT code, id FROM accounts WHERE entity_id = $1', [f.entityId])).rows.map((a) => [a.code, a.id])),
    });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return bill.billNumber;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function manualBill(billDate: string): Promise<string> {
  const bill = await createBill({
    entity_id: f.entityId,
    vendor_id: vendorId,
    bill_date: billDate,
    due_date: billDate,
    lines: [{ account_id: expenseAccountId, description: 'manual', quantity: 1, unit_price: 100 }],
    created_by: f.userId,
  } as never);
  return bill.bill_number;
}

/** A ready pre-registration of a vendor nobody registered; the caller may authorize its creation. */
async function newVendorPreReg(rfc: string): Promise<Record<string, unknown>> {
  const preReg = await readyPreReg('2026-08-01');
  await query(
    `UPDATE pre_registrations SET vendor_id = NULL, is_new_vendor = true,
            suggested_vendor_data = $2::jsonb WHERE id = $1`,
    [preReg.id, JSON.stringify({ company_name: 'Nuevo SA', tax_id: rfc })]
  );
  return (await query<Record<string, unknown>>(`SELECT * FROM pre_registrations WHERE id = $1`, [preReg.id])).rows[0];
}

const vendorNumberOf = async (rfc: string): Promise<string> =>
  (await query<{ vendor_number: string }>(
    `SELECT vendor_number FROM vendors WHERE entity_id = $1 AND tax_id = $2`, [f.entityId, rfc]
  )).rows[0].vendor_number;

afterEach(() => {
  vi.useRealTimers();
});

describe('MNE-001-399 · inbox bill numbering', () => {
  it('takes the next number of the counter bill create uses, and a later bill create does not collide', async () => {
    const first = await manualBill('2026-03-01');
    const inbox = await approve('2026-03-02');
    const later = await manualBill('2026-03-03');
    expect([first, inbox, later]).toEqual(['BILL-2026-00001', 'BILL-2026-00002', 'BILL-2026-00003']);
  });

  it('puts a CFDI dated 2026-12-31 in the 2026 series even when approved in January 2027, and does not count other years', async () => {
    expect(await manualBill('2025-05-01')).toBe('BILL-2025-00001');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-01-05T12:00:00') });
    const december = await approve('2026-12-31');
    vi.useRealTimers();
    expect(december).toBe('BILL-2026-00001');
  });

  it('never draws the same number for concurrent approvals', async () => {
    const preRegs: Record<string, unknown>[] = [];
    for (let i = 0; i < 4; i++) preRegs.push(await readyPreReg('2026-08-01'));
    const results = await Promise.all(preRegs.map((p) => service.processToAccounting(p, f.userId)));
    const numbers = results.map((r) => r.bill!.bill_number as string).sort();
    expect(numbers).toEqual([1, 2, 3, 4].map((n) => `BILL-2026-0000${n}`));
  });

  it('numbers a bill approved through the draft path with the same counter', async () => {
    const first = await manualBill('2026-03-01');
    const draft = await approveDraft('2026-03-02', true);
    const later = await manualBill('2026-03-03');
    expect([first, draft, later]).toEqual(['BILL-2026-00001', 'BILL-2026-00002', 'BILL-2026-00003']);
  });

  it('returns the number when the approving transaction rolls back (draft path)', async () => {
    const rolledBack = await approveDraft('2026-03-02', false);
    expect(rolledBack).toBe('BILL-2026-00001');
    expect(await manualBill('2026-03-03')).toBe('BILL-2026-00001');
  });

  it('returns the number when the inbox approval fails after drawing it', async () => {
    const preReg = await readyPreReg('2026-03-02');
    // A dangling account: the bill_lines insert fails AFTER the number was drawn.
    await expect(
      service.processToAccounting({ ...preReg, default_account_id: uuidv4() }, f.userId)
    ).rejects.toThrow();
    expect(await manualBill('2026-03-03')).toBe('BILL-2026-00001');
  });

  it('numbers a vendor created from the inbox with the entity counter, in the creation year', async () => {
    await service.processToAccounting(await newVendorPreReg('NUE010101AAA'), f.userId, { permitirProveedorNuevo: true });
    expect(await vendorNumberOf('NUE010101AAA')).toBe(`V-${YEAR}-00001`);
  });

  it('does not collide with vendors made by `vendor create` (the case the review found)', async () => {
    const made: unknown[] = [];
    for (const [i, rfc] of ['AAA010101AA1', 'BBB010101BB2'].entries()) {
      const v = await createVendor({
        entity_id: f.entityId, company_name: `Alta ${i}`, tax_id: rfc, tax_id_type: 'rfc', created_by: f.userId,
      } as never);
      made.push(v.vendor_number);
    }
    expect(made).toEqual([`V-${YEAR}-00001`, `V-${YEAR}-00002`]);
    await service.processToAccounting(await newVendorPreReg('NUE010101AAA'), f.userId, { permitirProveedorNuevo: true });
    expect(await vendorNumberOf('NUE010101AAA')).toBe(`V-${YEAR}-00003`);
    const after = await createVendor({
      entity_id: f.entityId, company_name: 'Alta 3', tax_id: 'CCC010101CC3', tax_id_type: 'rfc', created_by: f.userId,
    } as never);
    expect(after.vendor_number).toBe(`V-${YEAR}-00004`);
  });

  it('migration 176 lifts the counters above numbers the old code issued outside them', async () => {
    // What the COUNT-based writers left behind: no counter row, high numbers.
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, bill_date, due_date, subtotal, tax_amount, total_amount, amount_due, status, created_by)
       VALUES ($1, $2, 'BILL-2026-00121', $3, '2026-03-01', '2026-03-01', 100, 0, 100, 100, 'posted', $4)`,
      [uuidv4(), f.entityId, vendorId, f.userId]
    );
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by)
       VALUES ($1, $2, $3, 'Old COUNT vendor', $4)`,
      [uuidv4(), f.entityId, `V-${YEAR}-00050`, f.userId]
    );
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(RESEED);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await manualBill('2026-03-02')).toBe('BILL-2026-00122');
    await service.processToAccounting(await newVendorPreReg('NUE010101AAA'), f.userId, { permitirProveedorNuevo: true });
    expect(await vendorNumberOf('NUE010101AAA')).toBe(`V-${YEAR}-00051`);
  });
});
