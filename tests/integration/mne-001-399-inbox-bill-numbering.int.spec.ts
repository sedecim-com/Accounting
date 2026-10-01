import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
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
// approved through processToAccounting.
// ============================================================

const XML = fs.readFileSync(path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8');
const UUID_IN_XML = /UUID="([0-9A-Fa-f-]{36})"/.exec(XML)![1];
const service = new PreRegistrationService();

let f: Fixture;
let vendorId: string;
let expenseAccountId: string;

beforeAll(async () => {
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
    expect(december).toBe('BILL-2026-00004');
  });

  it('never draws the same number for concurrent approvals', async () => {
    const preRegs: Record<string, unknown>[] = [];
    for (let i = 0; i < 4; i++) preRegs.push(await readyPreReg('2026-08-01'));
    const results = await Promise.all(preRegs.map((p) => service.processToAccounting(p, f.userId)));
    const numbers = results.map((r) => r.bill!.bill_number as string).sort();
    expect(numbers).toEqual([5, 6, 7, 8].map((n) => `BILL-2026-0000${n}`));
  });

  it('numbers a vendor created from the inbox with the entity counter, not COUNT(*)', async () => {
    const preReg = await readyPreReg('2026-08-01');
    await query(
      `UPDATE pre_registrations SET vendor_id = NULL, is_new_vendor = true,
              suggested_vendor_data = '{"company_name":"Nuevo SA","tax_id":"NUE010101AAA"}'::jsonb WHERE id = $1`,
      [preReg.id]
    );
    const fresh = (await query<Record<string, unknown>>(`SELECT * FROM pre_registrations WHERE id = $1`, [preReg.id])).rows[0];
    await service.processToAccounting(fresh, f.userId, { permitirProveedorNuevo: true });
    const v = await query<{ vendor_number: string }>(
      `SELECT vendor_number FROM vendors WHERE entity_id = $1 AND tax_id = 'NUE010101AAA'`, [f.entityId]
    );
    expect(v.rows[0].vendor_number).toBe('V-2026-00001');
  });
});
