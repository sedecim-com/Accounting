import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The real engine, wrapped so one test can fail the entry AFTER the bill was
// written and the classifier said the CFDI is postable.
vi.mock('../../src/services/accounting/posting.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/accounting/posting.js')>();
  return { ...real, createJournalEntry: vi.fn(real.createJournalEntry) };
});

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  PreRegistrationService,
  PROVEEDOR_NUEVO_SIN_AUTORIZAR,
} from '../../src/services/xml-ingestion/pre-registration-service.js';
import { getClassificationTrail } from '../../src/services/xml-ingestion/cfdi-query-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { readSubledgerSide } from '../../src/services/accounting/period-close.js';

// ============================================================
// A HELD CFDI LEAVES NO BILL.
//
// `createBillFromPreReg` inserted `bills` and `bill_lines` with autocommit and
// only then asked the classifier. A CFDI held with CFDI_REQUIERE_DECISION kept
// a `posted` bill with its `amount_due` and no `journal_entry_id`: the AP
// subledger carried a payable the ledger never booked, `bill list` showed it,
// and running the same pre-registration again inserted a second one.
//
// The hold here is `gasto_vs_activo`, the blocking question a received CFDI
// over the capitalization threshold asks. Any blocking decision, a cancelled
// CFDI or a closed period takes the same path: CFDI_REQUIERE_DECISION.
// ============================================================

const service = new PreRegistrationService();

const GOLDEN = fs.readFileSync(path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8');

/**
 * The golden received cleaning service, scaled to 25,000: over the default
 * `umbral_capitalizacion_mxn` (20,000), so the blocking `gasto_vs_activo`
 * question holds it. Answering 50,000 releases it.
 */
function heldXml(uuid: string): string {
  return GOLDEN.replace('SubTotal="3500.00" Total="4060.00"', 'SubTotal="25000.00" Total="29000.00"')
    .replace('ValorUnitario="3500.00" Importe="3500.00"', 'ValorUnitario="25000.00" Importe="25000.00"')
    .replace('TotalImpuestosTrasladados="560.00"', 'TotalImpuestosTrasladados="4000.00"')
    .replace('Base="3500.00"', 'Base="25000.00"')
    .replace('Importe="560.00"', 'Importe="4000.00"')
    .replace('UUID="11A1A1A1-0001-4A01-8A01-A1A1A1A1A001"', `UUID="${uuid}"`);
}

/**
 * Uploads the CFDI; returns the pre-registration id. With `vendor` (the
 * default) the issuer is already in the catalog; without it the upload leaves
 * the issuer as a vendor to create, as it arrives from the SAT.
 */
async function upload(f: Fixture, uuid: string, o: { vendor?: boolean } = {}): Promise<string> {
  const r = await service.processXMLUpload(f.entityId, heldXml(uuid), 'api', f.userId);
  const id = r.preRegistration.id as string;
  let vendorId: string | null = null;
  if (o.vendor !== false) {
    vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, created_by)
       VALUES ($1, $2, 'V-0001', 'Limpieza Corporativa del Centro SA de CV', 'LIM040404LM8', 'rfc', $3)`,
      [vendorId, f.entityId, f.userId]
    );
  }
  const ready = await query(
    `UPDATE pre_registrations SET vendor_id = COALESCE($3, vendor_id), status = 'ready', default_account_id = $4
      WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId, vendorId, f.cuentas['6100']]
  );
  expect(ready.rowCount).toBe(1);
  return id;
}

/** `bill inbox run <id>`: the row is read fresh, as the CLI does, and run to accounting. */
async function run(
  f: Fixture,
  id: string,
  allowNewVendor = false
): Promise<{ bill?: Record<string, unknown> }> {
  const row = await query<Record<string, unknown>>(
    `SELECT * FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId]
  );
  return service.processToAccounting(row.rows[0], f.userId, { permitirProveedorNuevo: allowNewVendor });
}

async function billsOf(f: Fixture): Promise<Array<{ status: string; journal_entry_id: string | null; amount_due: string }>> {
  return (
    await query<{ status: string; journal_entry_id: string | null; amount_due: string }>(
      `SELECT status, journal_entry_id, amount_due FROM bills WHERE entity_id = $1`,
      [f.entityId]
    )
  ).rows;
}

async function billLinesOf(f: Fixture): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id WHERE b.entity_id = $1`,
    [f.entityId]
  );
  return Number(r.rows[0].n);
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a CFDI held for a decision leaves no bill', () => {
  let f: Fixture;
  let id: string;
  const uuid = uuidv4().toUpperCase();

  beforeAll(async () => {
    f = await crearInquilino('Held CFDI leaves no bill');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    id = await upload(f, uuid);
  });

  it('the hold writes no bill, no bill line and no entry; the pre-registration waits with its reason', async () => {
    await expect(run(f, id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });

    expect(await billsOf(f)).toEqual([]);
    expect(await billLinesOf(f)).toBe(0);
    const entries = await query(
      `SELECT 1 FROM journal_entries WHERE entity_id = $1 AND source_type = 'bill'`,
      [f.entityId]
    );
    expect(entries.rowCount).toBe(0);

    const preReg = await query<{ status: string; validation_status: string; bill_id: string | null }>(
      `SELECT status, validation_status, bill_id FROM pre_registrations WHERE id = $1`,
      [id]
    );
    expect(preReg.rows[0]).toEqual({ status: 'draft', validation_status: 'needs_review', bill_id: null });
  });

  it('the classifier trail of the held CFDI is kept: it is what the reviewer reads', async () => {
    const trail = await getClassificationTrail(f.entityId, uuid);
    expect(trail.status).toBe('pending');
    expect((trail.decisions as Array<{ id: string }>).map((d) => d.id)).toContain('gasto_vs_activo');
  });

  it('the AP subledger agrees with its control account after the hold', async () => {
    const side = await readSubledgerSide(f.entityId, 'ap-subledger-delta');
    expect(side).toMatchObject({ subledger: '0.00', balanced: true });
  });

  it('running the same pre-registration again is held again and still writes no bill', async () => {
    await expect(run(f, id)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    expect(await billsOf(f)).toEqual([]);
  });

  it('once the firm answers, the next run books exactly one bill, linked to its entry', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'umbral_capitalizacion_mxn', '50000', 'owner@test');

    const r = await run(f, id);

    const bills = await billsOf(f);
    expect(bills).toHaveLength(1);
    expect(bills[0].status).toBe('posted');
    expect(bills[0].journal_entry_id).toEqual(expect.any(String));
    expect(Number(bills[0].amount_due)).toBe(29000);
    expect(r.bill?.journal_entry_id).toBe(bills[0].journal_entry_id);
    const preReg = await query<{ status: string; bill_id: string }>(
      `SELECT status, bill_id FROM pre_registrations WHERE id = $1`,
      [id]
    );
    expect(preReg.rows[0]).toEqual({ status: 'completed', bill_id: r.bill?.id });
    expect(await readSubledgerSide(f.entityId, 'ap-subledger-delta')).toMatchObject({ balanced: true });
  });
});

describe('an entry that fails after the classifier said yes leaves no bill either', () => {
  let f: Fixture;
  let id: string;

  beforeAll(async () => {
    f = await crearInquilino('Entry fails after the bill');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'umbral_capitalizacion_mxn', '50000', 'owner@test');
    id = await upload(f, uuidv4().toUpperCase());
  });

  it('the failure rolls the bill back, and the retry books one bill', async () => {
    vi.mocked(createJournalEntry).mockRejectedValueOnce(new Error('the ledger refused the entry'));
    await expect(run(f, id)).rejects.toThrow('the ledger refused the entry');
    expect(await billsOf(f)).toEqual([]);
    expect(await billLinesOf(f)).toBe(0);

    await run(f, id);
    expect(await billsOf(f)).toHaveLength(1);
  });
});

describe('a vendor authorized in the held run is rolled back with the bill', () => {
  let f: Fixture;
  let id: string;

  beforeAll(async () => {
    f = await crearInquilino('Held CFDI with a new vendor');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    id = await upload(f, uuidv4().toUpperCase(), { vendor: false });
  });

  it('the hold leaves neither the vendor nor the bill: the run was one act', async () => {
    await expect(run(f, id, true)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    const vendors = await query(`SELECT 1 FROM vendors WHERE entity_id = $1`, [f.entityId]);
    expect(vendors.rowCount).toBe(0);
    expect(await billsOf(f)).toEqual([]);
  });

  it('the next run without the yes is refused for the vendor, not silently billed', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'umbral_capitalizacion_mxn', '50000', 'owner@test');
    await expect(run(f, id)).rejects.toMatchObject({ code: PROVEEDOR_NUEVO_SIN_AUTORIZAR });
    expect(await billsOf(f)).toEqual([]);

    await run(f, id, true);
    expect(await billsOf(f)).toHaveLength(1);
  });
});
