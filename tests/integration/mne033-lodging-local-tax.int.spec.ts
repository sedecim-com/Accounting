import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';

// ============================================================
// MNE-001-033 · #102 — A HOTEL CFDI REACHES THE LEDGER.
//
// A received lodging CFDI (1 000 + 160 IVA + 30 ISH = 1 190, the ISH in the
// ImpuestosLocales complement) was refused at upload as «Total calculation
// mismatch». Here it goes through `bill inbox run` (upload, then
// processToAccounting) against Postgres, and the posted entry is read back.
// All data is synthetic.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'hospedaje-ish-4001.xml'), 'utf8');
const FIXTURE_UUID = '4A1B2C3D-5E6F-4071-8293-A4B5C6D7E8F9';
const HOTEL_RFC = 'HOS060101AB1';

let f: Fixture;
const svc = new PreRegistrationService();

beforeAll(async () => {
  f = await crearInquilino('MNE-001-033 lodging ISH');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
       created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-HOS', 'Hotel Sintetico SA de CV', $3, 'rfc', 'MXN', $4,
       (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
    [uuidv4(), f.entityId, HOTEL_RFC, f.userId]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a received lodging CFDI through the inbox', () => {
  it('posts 1 190 with the ISH on a line of its own, and the bill owes the whole total', async () => {
    const xml = FIXTURE.replace(FIXTURE_UUID, uuidv4().toUpperCase());
    const up = await svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
    const r = await svc.processToAccounting(up.preRegistration, f.userId);
    const bill = r.bill as { total_amount: string; journal_entry_id: string };
    expect(bill.total_amount).toBe('1190.0000');

    const lines = (
      await query<{ code: string; debit: string | null; credit: string | null; description: string }>(
        `SELECT a.code, jl.debit_amount::text AS debit, jl.credit_amount::text AS credit, jl.description
           FROM journal_entry_lines jl JOIN accounts a ON a.id = jl.account_id
          WHERE jl.journal_entry_id = $1
          ORDER BY jl.line_number`,
        [bill.journal_entry_id]
      )
    ).rows.map((l) => ({ code: l.code, debit: l.debit, credit: l.credit, local: /^Local taxes/.test(l.description) }));

    expect(lines).toEqual([
      { code: '6100', debit: '1000.0000', credit: null, local: false },
      { code: '6100', debit: '30.0000', credit: null, local: true },
      { code: '1130', debit: '160.0000', credit: null, local: false },
      { code: '2110', debit: null, credit: '1190.0000', local: false },
    ]);
  }, 90_000);
});
