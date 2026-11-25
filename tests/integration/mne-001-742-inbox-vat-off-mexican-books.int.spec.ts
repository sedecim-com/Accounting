import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';

// ============================================================
// MNE-001-742 (#692) · THE INBOX ASKS THE ENTITY BEFORE IT PARKS VAT
//
// The bill is the fixture of 9,280.00 (8,000.00 + 1,280.00), PPD as written
// and PUE with its one attribute changed, posted from the inbox (`bill inbox
// run` and `POST /v1/pre-registrations/:id/process` both end in
// `processToAccounting`).
//
// `moved` was seeded with the Mexican chart and then declared off Mexican
// books, as T11b of mne-001-489 does: it has 1130 and 1135. `born` was
// seeded off Mexican books: its neutral chart has 1136 for the tax of a
// purchase and no role for a parked one.
// ============================================================

const BILL = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const VENDOR_RFC = 'SIN060101AB1';
const svc = new PreRegistrationService();
type Method = 'PPD' | 'PUE';
interface Books { f: Fixture; vendorId: string }

let moved: Books;
let born: Books;

const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await query<T>(sql, params)).rows;

async function books(name: string, options?: Parameters<typeof crearInquilino>[1]): Promise<Books> {
  const f = await crearInquilino(name, options);
  const ctx = { tenantId: f.tenantId, entityId: f.entityId };
  const [{ email }] = await rows<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId]);
  await seedPolicies(ctx);
  await resolvePolicy(ctx, 'lineas_factura_desde', 'conceptos_cfdi', email);
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-742', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4, $5)`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId, f.cuentas['6100']]
  );
  return { f, vendorId };
}

const declare = ({ f }: Books, country: string, standard: string) => query(
  `UPDATE legal_entities SET incorporation_country = $1, accounting_standard = $2 WHERE id = $3 AND tenant_id = $4`,
  [country, standard, f.entityId, f.tenantId]
);

/** The fixture bill under a fresh UUID, uploaded and posted from the inbox: its bill and its entry's reference. */
async function inbox({ f }: Books, method: Method): Promise<{ id: string; uuid: string }> {
  enterTenant(f.tenantId);
  const uuid = uuidv4().toUpperCase();
  const up = await svc.processXMLUpload(
    f.entityId,
    BILL.replace('F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80', uuid).replace('Folio="2001"', `Folio="${uuid.slice(0, 8)}"`)
      .replace('MetodoPago="PPD"', `MetodoPago="${method}"`),
    'manual_upload', f.userId
  );
  return { id: ((await svc.processToAccounting(up.preRegistration, f.userId)).bill as { id: string }).id, uuid };
}

/** The lines of a posted entry as `code debit/credit`, ordered by account code (every code is digits). */
const linesOf = async ({ f }: Books, entryId: string) => (await rows<{ lines: string[] }>(
  `SELECT array_agg(a.code || ' ' || COALESCE(l.debit_amount, 0)::text || '/' || COALESCE(l.credit_amount, 0)::text
                    ORDER BY a.code COLLATE "C", COALESCE(l.debit_amount, 0), COALESCE(l.credit_amount, 0)) AS lines
     FROM journal_entry_lines l
     JOIN accounts a ON a.id = l.account_id
     JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
    WHERE je.entity_id = $1 AND je.id = $2`,
  [f.entityId, entryId]
))[0].lines;

const billEntry = async (b: Books, billId: string) => linesOf(
  b, (await rows<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM bills WHERE id = $1 AND entity_id = $2`, [billId, b.f.entityId]))[0].journal_entry_id
);

/** What the entity's ledger holds in an account, debit positive. */
const held = async ({ f }: Books, code: string) => (await rows<{ net: string }>(
  `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::numeric(19,2)::text AS net
     FROM journal_entry_lines l
     JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
     JOIN accounts a ON a.id = l.account_id
    WHERE je.entity_id = $1 AND a.code = $2`,
  [f.entityId, code]
))[0].net;

/** The whole bill paid by transfer: the payment's own lines. */
async function payInFull(b: Books, billId: string): Promise<string[]> {
  const paid = await recordVendorPayment(
    { entityId: b.f.entityId, counterpartyId: b.vendorId, paymentAmount: '9280.00', paymentDate: '2026-08-31', paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: '9280.00', discountAmount: '0' }] },
    b.f.userId
  );
  return linesOf(b, paid.journalEntry!.id);
}

beforeAll(async () => {
  moved = await books('MNE-001-742 moved off Mexican books');
  await declare(moved, 'US', 'us_gaap');
  born = await books('MNE-001-742 born off Mexican books', { pais: 'US', moneda: 'MXN' });
  // NOTE: the fixture gives a US entity an EIN; a CFDI names its receiver by RFC, and the inbox refuses one
  // the entity is not a party to.
  await query(`UPDATE legal_entities SET tax_id = 'XAXX010101000', tax_id_type = 'rfc' WHERE id = $1 AND tenant_id = $2`, [born.f.entityId, born.f.tenantId]);
}, 240_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('an entity that does not keep Mexican books', () => {
  it.each<Method>(['PPD', 'PUE'])('a received %s posts its 1,280.00 of VAT to the creditable role, and its payment strands nothing in 1135', async (method) => {
    const bill = await inbox(moved, method);
    expect(await billEntry(moved, bill.id)).toEqual(['1130 1280.0000/0', '2110 0/9280.0000', '6100 8000.0000/0']);
    // The release asks the entity too, so the payment moves no VAT: whatever the bill parked would stay.
    expect(await payInFull(moved, bill.id)).toEqual(['1111 0/9280.0000', '2110 9280.0000/0']);
    expect(await held(moved, '1135')).toBe('0.00');
  }, 120_000);

  it('seeded with the neutral chart, which has no role for parked VAT, the bill posts its VAT to 1136 instead of waiting', async () => {
    expect(born.f.roles.iva_pendiente_acreditar).toBeUndefined();
    for (const method of ['PPD', 'PUE'] as const) {
      const bill = await inbox(born, method);
      expect(await billEntry(born, bill.id)).toEqual(['1136 1280.0000/0', '2110 0/9280.0000', '6100 8000.0000/0']);
    }
  }, 120_000);
});

describe('an entity that keeps Mexican books', () => {
  it.each<Method>(['PPD', 'PUE'])('a received %s parks its 1,280.00 in 1135, as before, and its payment releases it', async (method) => {
    await declare(moved, 'MX', 'mx_nif');
    try {
      const bill = await inbox(moved, method);
      expect(await billEntry(moved, bill.id)).toEqual(['1135 1280.0000/0', '2110 0/9280.0000', '6100 8000.0000/0']);
      expect(await payInFull(moved, bill.id)).toEqual(['1111 0/9280.0000', '1130 1280.0000/0', '1135 0/1280.0000', '2110 9280.0000/0']);
    } finally {
      await declare(moved, 'US', 'us_gaap');
    }
  }, 120_000);
});
