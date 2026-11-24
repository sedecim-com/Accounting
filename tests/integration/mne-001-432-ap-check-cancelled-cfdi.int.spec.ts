import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { markBillCfdiCancelled } from '../../src/services/ap/bill-cfdi-cancellation.js';
import { runApChecks } from '../../src/services/ap/ap-checks.js';

// ============================================================
// MNE-001-432 (#643), against a real database: `ap check` names each open
// bill with an amount due whose received CFDI carries the cancellation mark
// of MNE-001-431, and nothing else. MNE-001-610 adds its second probe on the
// same bench: each paid bill with no balance that carries the mark.
//
// Every mark is written by markBillCfdiCancelled, the mark's only writer, so
// a probe that read any other value would find nothing here. Each bill is
// 1,000.00 + 160.00 VAT = 1,160.00; P2 paid 400.00 and owes 760.00. P7 is a
// reversed opening (void, nothing due) and P8 was settled by a received credit
// note (paid, no cash: amount_paid 0, nothing due). All data is synthetic.
// ============================================================

let a: Fixture;
let b: Fixture;
let empty: Fixture;
const uuid = (n: number): string => `AAAAAAAA-4320-4000-8000-00000000000${n}`;

async function vendor(fx: Fixture, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, payment_terms, currency_code, created_by)
     VALUES ($1, $2, $3, $4, 'SIN060101AB1', 'rfc', 'Net 30', 'MXN', $5)`,
    [id, fx.entityId, `V-432-${id.slice(0, 8)}`, name, fx.userId]
  );
  return id;
}

/**
 * A bill of `fx` with its status and what it paid of 1,160.00, marked when asked through the real writer.
 * Its amount due is 1,160.00 less what it paid, unless `due` says otherwise.
 */
async function bill(
  fx: Fixture, vendorId: string, number: string, status: string, paid: number, cfdi: string, marked: boolean,
  due: number = 1160 - paid
): Promise<void> {
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_paid, amount_due,
       currency_code, bill_date, due_date, status, cfdi_uuid, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,$5::numeric,$9::numeric,'MXN','2026-08-15','2026-09-14',$6,$7,$8)`,
    [uuidv4(), fx.entityId, number, vendorId, paid, status, cfdi, fx.userId, due]
  );
  if (marked) expect(await markBillCfdiCancelled(fx.entityId, cfdi)).toBe(1);
}

beforeAll(async () => {
  a = await crearInquilino('MNE-001-432 ap check names the marked bill');
  b = await crearEntidadHermana(a, 'MNE-001-432 sister entity, same UUID');
  empty = await crearEntidadHermana(a, 'MNE-001-432 entity with no marks');
  const va = await vendor(a, 'Proveedor Sintético Uno');
  const vb = await vendor(b, 'Proveedor Sintético Dos');

  await bill(a, va, 'P1-432', 'posted', 0, uuid(1), true);
  await bill(a, va, 'P2-432', 'partially_paid', 400, uuid(2), true);
  await bill(a, va, 'P3-432', 'paid', 1160, uuid(3), true);
  await bill(a, va, 'P4-432', 'approved', 0, uuid(4), false);
  await bill(a, va, 'P5-432', 'void', 0, uuid(5), true);
  await bill(a, va, 'P6-432', 'paid', 1160, uuid(6), false);
  await bill(a, va, 'P7-432', 'void', 0, uuid(7), true, 0);
  await bill(a, va, 'P8-432', 'paid', 0, uuid(8), true, 0);
  // The same UUID as P1 on a bill of B, in lower case: the bridge marks it for B only.
  await bill(b, vb, 'B1-432', 'approved', 0, uuid(1).toLowerCase(), true);
  // And P3's, paid, on B: the paid probe names it for B only.
  await bill(b, vb, 'B2-432', 'paid', 1160, uuid(3).toLowerCase(), true);
});

afterAll(async () => {
  await closeDatabase();
});

describe('ap check · cancelled-cfdi-open', () => {
  it('names each open bill of the entity with the mark and an amount due, with number, vendor, UUID and balance', async () => {
    const r = await runApChecks(a.entityId);
    expect(r.results.map((x) => x.name)).toEqual(['cancelled-cfdi-open', 'cancelled-cfdi-paid']);
    const [probe] = r.results;
    expect(probe).toMatchObject({ level: 'warning', count: 2 });
    expect(probe.bills.map(({ noted_on: _, ...rest }) => rest)).toEqual([
      { bill_number: 'P1-432', vendor: 'Proveedor Sintético Uno', cfdi_uuid: uuid(1), amount_due: '1160.00', currency: 'MXN' },
      { bill_number: 'P2-432', vendor: 'Proveedor Sintético Uno', cfdi_uuid: uuid(2), amount_due: '760.00', currency: 'MXN' },
    ]);
    for (const x of probe.bills) expect(x.noted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The paid probe warns too (MNE-001-610): two warnings, no blocking.
    expect(r).toMatchObject({ blocking: 0, warnings: 2 });
  });

  it('names the sister entity its own bill only', async () => {
    const [probe] = (await runApChecks(b.entityId, { checks: ['cancelled-cfdi-open'] })).results;
    expect(probe.count).toBe(1);
    expect(probe.bills.map((x) => x.bill_number)).toEqual(['B1-432']);
  });

  it('is clean for an entity with no marked bill', async () => {
    const r = await runApChecks(empty.entityId);
    expect(r.results).toHaveLength(2);
    for (const probe of r.results) expect(probe).toMatchObject({ level: 'clean', count: 0, bills: [] });
    expect(r).toMatchObject({ blocking: 0, warnings: 0 });
  });

  it('refuses an unknown check by name', async () => {
    await expect(runApChecks(a.entityId, { checks: ['missing-terms'] })).rejects.toMatchObject({ code: 'UNKNOWN_CHECK' });
  });
});

describe('ap check · cancelled-cfdi-paid (MNE-001-610)', () => {
  it('names each paid bill of the entity with the mark and nothing due, with number, vendor, UUID, what was paid and the day of the mark', async () => {
    const [probe] = (await runApChecks(a.entityId, { checks: ['cancelled-cfdi-paid'] })).results;
    expect(probe).toMatchObject({ name: 'cancelled-cfdi-paid', level: 'warning', count: 2 });
    expect(probe.detailKey).toBe('ap.check.cancelled_cfdi_paid.found');
    // P3 paid the whole 1,160.00; P8 was settled by a credit note, so no cash was paid.
    // P6 is paid with no mark, P7 is void with nothing due, P2 still owes: none of them.
    expect(probe.bills.map(({ noted_on: _, ...rest }) => rest)).toEqual([
      { bill_number: 'P3-432', vendor: 'Proveedor Sintético Uno', cfdi_uuid: uuid(3), amount_paid: '1160.00', currency: 'MXN' },
      { bill_number: 'P8-432', vendor: 'Proveedor Sintético Uno', cfdi_uuid: uuid(8), amount_paid: '0.00', currency: 'MXN' },
    ]);
    for (const x of probe.bills) expect(x.noted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('names the sister entity its own paid bill only, though it carries the same UUID as P3', async () => {
    const [probe] = (await runApChecks(b.entityId, { checks: ['cancelled-cfdi-paid'] })).results;
    expect(probe).toMatchObject({ level: 'warning', count: 1 });
    expect(probe.bills.map((x) => x.bill_number)).toEqual(['B2-432']);
  });

  it('runs alone when asked, and the open probe still leaves the paid bills out', async () => {
    const r = await runApChecks(a.entityId, { checks: ['cancelled-cfdi-paid'] });
    expect(r.results.map((x) => x.name)).toEqual(['cancelled-cfdi-paid']);
    expect(r).toMatchObject({ blocking: 0, warnings: 1 });
    const [open] = (await runApChecks(a.entityId, { checks: ['cancelled-cfdi-open'] })).results;
    expect(open.bills.map((x) => x.bill_number)).toEqual(['P1-432', 'P2-432']);
  });
});
