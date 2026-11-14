import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import {
  createInvoice,
  deleteDraftInvoice,
  checkInvoiceSeries,
} from '../../src/services/ar/invoice-service.js';

/**
 * MNE-001-287 (#103): audit_log records the legal entity, and
 * `invoice series check` only explains a gap with a DELETE of the SAME entity.
 * Two entities of one tenant share folio numbers (INV-yyyy-0001 in each), so
 * the tenant alone cannot tell whose gap an audit row explains.
 */

let a: Fixture;
let b: Fixture;
let customerA: string;
let customerB: string;

const day = () => {
  const d = fechaEnPeriodo();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function customerFor(f: Fixture, number: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente SA', 'MXN', $4)`,
    [id, f.entityId, number, f.userId]
  );
  return id;
}

async function draft(f: Fixture, customerId: string) {
  const revenue = f.cuentas['4100'] ?? f.cuentas[Object.keys(f.cuentas)[0]];
  return createInvoice({
    entity_id: f.entityId,
    customer_id: customerId,
    invoice_date: day(),
    due_date: day(),
    currency_code: 'MXN',
    lines: [{ revenue_account_id: revenue, unit_price: '100.00', quantity: '1' }],
    created_by: f.userId,
  });
}

beforeAll(async () => {
  a = await crearInquilino('MNE-287 A');
  b = await crearEntidadHermana(a, 'MNE-287 B');
  customerA = await customerFor(a, 'C-287-A');
  customerB = await customerFor(b, 'C-287-B');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('audit_log.legal_entity_id', () => {
  it('is filled by the audit INSERT of an entity-scoped fact', async () => {
    const d = await draft(a, customerA);
    await deleteDraftInvoice(d.id, { entityId: a.entityId, reason: 'stores the entity' }, a.userId);
    const r = await query<{ legal_entity_id: string | null }>(
      `SELECT legal_entity_id FROM audit_log WHERE entity_type = 'invoices' AND entity_id = $1 AND action = 'delete'`,
      [d.id]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].legal_entity_id).toBe(a.entityId);
  });
});

describe('invoice series check scopes the explanation by entity', () => {
  it('does not explain a gap in A with a folio deleted in B (same number, same tenant)', async () => {
    // Entity A: folios 1 and 2 are issued as drafts; folio 1 vanishes with NO audit row.
    const a1 = await draft(a, customerA);
    await draft(a, customerA);
    await query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [a1.id]);
    await query(`DELETE FROM invoices WHERE id = $1`, [a1.id]);

    // Entity B: it was issued the SAME folio and deleted it properly, with a reason.
    let b1 = await draft(b, customerB);
    while (b1.invoice_number !== a1.invoice_number) b1 = await draft(b, customerB);
    await deleteDraftInvoice(b1.id, { entityId: b.entityId, reason: 'deleted in B' }, b.userId);

    const seriesB = await checkInvoiceSeries(b.entityId);
    const gapB = seriesB.flatMap((s) => s.explained).find((e) => e.folio === a1.invoice_number);
    expect(gapB?.reason, 'B explains its own deletion').toBe('deleted in B');

    const seriesA = await checkInvoiceSeries(a.entityId);
    const gapA = seriesA.find((s) => s.missing.includes(a1.invoice_number));
    expect(gapA, 'the folio is still missing in A').toBeDefined();
    expect(
      gapA!.explained.find((e) => e.folio === a1.invoice_number),
      'B\'s DELETE must not explain A\'s gap'
    ).toBeUndefined();
  });

  it('attributes a pre-324 DELETE row (NULL entity) through its customer: B\'s does not explain A\'s gap, A\'s does', async () => {
    const a1 = await draft(a, customerA);
    await draft(a, customerA);
    await query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [a1.id]);
    await query(`DELETE FROM invoices WHERE id = $1`, [a1.id]);

    // Legacy rows are appended without the entity, as before migration 324.
    const legacy = (customerId: string, reason: string) =>
      query(
        `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, old_values, reason)
         VALUES ($1, $2, $3, 'delete', 'invoices', $4, $5, $6)`,
        [uuidv4(), a.userId, a.tenantId, uuidv4(),
         JSON.stringify({ invoice_number: a1.invoice_number, customer_id: customerId }), reason]
      );
    await legacy(customerB, 'legacy row of B');
    const before = (await checkInvoiceSeries(a.entityId)).find((s) => s.missing.includes(a1.invoice_number));
    expect(
      before!.explained.find((e) => e.folio === a1.invoice_number),
      'a legacy row of B\'s customer must not explain A\'s gap'
    ).toBeUndefined();

    await legacy(customerA, 'legacy row of A');
    const after = (await checkInvoiceSeries(a.entityId)).find((s) => s.missing.includes(a1.invoice_number));
    const reasons = after!.explained.map((e) => e.reason);
    expect(reasons).toContain('legacy row of A');
    expect(reasons).not.toContain('legacy row of B');
  });
});
