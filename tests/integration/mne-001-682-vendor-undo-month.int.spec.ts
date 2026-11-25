import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import {
  recordVendorPayment, applyVendorPayment, unapplyVendorPayment, reverseVendorPayment,
} from '../../src/services/payments/payment-service.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { construirDiot } from '../../src/services/sat/diot/diot-service.js';
import { serializeSatBatch } from '../../src/services/sat/diot/sat-batch.js';

/**
 * MNE-001-682 (#855) · THE DIOT AND THE IVA WORKPAPER TAKE OUT AN UNAPPLIED OR
 * REVERSED VENDOR PAYMENT IN THE MONTH IT WAS UNDONE.
 *
 * `payment unapply` re-parks the IVA its application credited (1130 → 1135)
 * and `payment reverse` mirrors every entry of the payment, both dated on the
 * day of the undo, which the application row stores (`unapplied_at`). The DIOT
 * (LIVA art. 32 fr. VIII) and the workpaper follow the ledger: the month the
 * application counted in keeps what it declared, the month of the undo takes it
 * out, and `IVA-WP-CREDITABLE-VS-LEDGER` is silent in both.
 *
 * Every bill is 1,000.00 + 160.00 = 1,160.00, PPD, its VAT parked in 1135,
 * dated 2026-04-06; every payment is a transfer of 2026-04-20 against its
 * bill, 1,160.00, unless told. The figures are worked by hand in each case.
 * All data is synthetic.
 */

let f: Fixture;
let bank: string;
let vendorId: string;
const BILLED = '2026-04-06';
const PAID = '2026-04-20';
const UNDONE = '2026-05-12';

async function vendor(number: string, rfc: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6)`,
    [id, f.entityId, number, `Synthetic Vendor ${number} SA`, rfc, f.userId]
  );
  return id;
}

beforeAll(async () => {
  // The paper's tie-out reads the whole entity's 1130: every case here leaves the ledger and the paper agreeing.
  f = await crearInquilino('MNE-001-682 vendor undo month');
  await seedPolicies({ tenantId: f.tenantId });
  bank = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Cheques','Banco',$3,'MXN','checking')`,
    [bank, f.entityId, f.roles.banco]
  );
  vendorId = await vendor('V-682', 'SIN060101AB1');
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** A posted PPD bill dated 2026-04-06, its VAT parked in 1135: 1,000.00 + 160.00 unless told. */
async function bill(of = vendorId, subtotal = '1000.00', vat = '160.00'): Promise<{ id: string; uuid: string }> {
  return seedBill(f, { vendorId: of, method: 'PPD', vatCode: '1135', date: BILLED, subtotal, vat });
}

/** `amount` paid against `billId` on `date`. */
async function pay(
  billId: string, o: { amount?: string; method?: 'spei' | 'check'; of?: string; date?: string } = {}
): Promise<string> {
  const amount = o.amount ?? '1160.00';
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: o.of ?? vendorId, paymentAmount: amount, paymentDate: o.date ?? PAID,
      paymentMethod: o.method ?? 'spei', bankAccountId: bank,
      ...(o.method === 'check' ? { checkNumber: uuidv4().slice(0, 6) } : {}),
      applications: [{ documentId: billId, amountApplied: amount }],
    },
    f.userId
  );
  return r.paymentId;
}

/** `payment unapply --date`: the id of its entry. */
async function unapply(paymentId: string, billId: string, date = UNDONE): Promise<string> {
  const r = await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Synthetic: applied to the wrong bill', date }, f.userId);
  return r.journalEntry.id;
}

/** `payment reverse --date`: the ids of the mirrors it posted. */
async function reverse(paymentId: string, date = UNDONE): Promise<string[]> {
  const r = await reverseVendorPayment(f.entityId, paymentId, { reason: 'Synthetic: the transfer came back', date }, f.userId);
  return r.attestations.map((a) => a.entryId);
}

async function ownEntry(paymentId: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT journal_entry_id AS id FROM vendor_payments WHERE id = $1 AND entity_id = $2`, [paymentId, f.entityId]
  );
  return r.rows[0].id;
}

/** What one month's paper and DIOT say of one bill. */
async function month(m: number, billId: string) {
  const scope = { tenantId: f.tenantId, entityId: f.entityId };
  const wp = await buildIvaWorkpaper({ ...scope, year: 2026, month: m });
  const diot = await construirDiot({ ...scope, anio: 2026, mes: m });
  const inPaper = wp.contributions.creditable.find((c) => c.documentId === billId);
  const inDiot = diot.renglones.flatMap((r) => r.documentos).find((d) => d.billId === billId);
  return {
    paper: inPaper ? `${inPaper.breakdown.tasa16.base} / ${inPaper.breakdown.tasa16.iva}` : null,
    diot: inDiot ? `${inDiot.desglose.tasa16.base} / ${inDiot.desglose.tasa16.iva}` : null,
    withheld: inDiot?.ivaRetenido ?? null,
    entries: [...(inPaper?.entryIds ?? [])].sort(),
    tieOut: wp.findings.filter((h) => h.codigo === 'IVA-WP-CREDITABLE-VS-LEDGER').map((h) => h.mensaje),
    undone: diot.hallazgos.filter((h) => h.codigo === 'DIOT-PAYMENT-UNDONE' && h.documentId === billId).map((h) => h.mensaje),
    diotBuilt: diot,
  };
}
const NOTHING = { paper: null, diot: null };
const WHOLE = { paper: '1000.0000 / 160.0000', diot: '1000.0000 / 160.0000' };
const TAKEN_OUT = { paper: '-1000.0000 / -160.0000', diot: '-1000.0000 / -160.0000' };
const figures = (x: { paper: string | null; diot: string | null }) => ({ paper: x.paper, diot: x.diot });

describe('a vendor application undone in a later month leaves that month, never the one it counted in', () => {
  it('U1 · paid in April and unapplied on May 12th: April keeps 1,000.00 / 160.00 whenever it is built, May takes it out', async () => {
    const b = await bill();
    const paymentId = await pay(b.id);
    const before = await month(4, b.id);
    const undo = await unapply(paymentId, b.id);

    const [april, may, june] = [await month(4, b.id), await month(5, b.id), await month(6, b.id)];
    expect([figures(before), figures(april)], 'April built before the unapply and after it').toEqual([WHOLE, WHOLE]);
    expect(april.entries).toEqual([await ownEntry(paymentId)]);
    expect(figures(may)).toEqual(TAKEN_OUT);
    expect(may.entries, 'May traces the entry that took the IVA out of 1130').toEqual([undo]);
    expect(figures(june)).toEqual(NOTHING);
    expect([april.tieOut, may.tieOut, june.tieOut], 'the ledger credited 1130 in May, and so do the papers').toEqual([[], [], []]);
    expect(april.undone).toEqual([]);
    expect(may.undone).toHaveLength(1);
    expect(may.undone[0]).toContain('1160.0000');
    expect(may.undone[0]).toContain('2026-04-20');
    expect(may.undone[0]).toContain('CFF art. 32');
  }, 240_000);

  it('U2 · paid in April and reversed on May 12th: the same two months, May traced to the mirror', async () => {
    const b = await bill();
    const paymentId = await pay(b.id);
    const mirrors = await reverse(paymentId);

    const [april, may] = [await month(4, b.id), await month(5, b.id)];
    expect([figures(april), april.entries]).toEqual([WHOLE, [await ownEntry(paymentId)]]);
    expect([figures(may), may.entries]).toEqual([TAKEN_OUT, [...mirrors].sort()]);
    expect([april.tieOut, may.tieOut]).toEqual([[], []]);
    expect(may.undone).toHaveLength(1);
  }, 240_000);

  it('U3 · an undo dated in the payment\'s own month nets to 0.00 there: April shows neither bill', async () => {
    const [unapplied, reversed] = [await bill(), await bill()];
    await unapply(await pay(unapplied.id), unapplied.id, '2026-04-27');
    await reverse(await pay(reversed.id), '2026-04-27');

    for (const b of [unapplied, reversed]) {
      const [april, may] = [await month(4, b.id), await month(5, b.id)];
      expect([figures(april), figures(may)]).toEqual([NOTHING, NOTHING]);
      expect([april.tieOut, may.tieOut]).toEqual([[], []]);
    }
  }, 240_000);

  it('U4 · the IVA withheld to the vendor follows the same months: 106.67 in April, −106.67 in May', async () => {
    const b = await bill();
    // Two thirds of 160.00, as the vendor's CFDI rounds it.
    await query(`UPDATE xml_documents SET total_iva_retenido = 106.67 WHERE cfdi_uuid = $1 AND entity_id = $2`, [b.uuid, f.entityId]);
    await unapply(await pay(b.id), b.id);

    const [april, may] = [await month(4, b.id), await month(5, b.id)];
    expect([april.withheld, may.withheld]).toEqual(['106.6700', '-106.6700']);
    expect([figures(april), figures(may)]).toEqual([WHOLE, TAKEN_OUT]);
  }, 240_000);

  it('U5 · unapplied in May and applied again on June 9th: April adds, May takes out, June adds again', async () => {
    const b = await bill();
    const paymentId = await pay(b.id);
    await unapply(paymentId, b.id);
    const again = await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: b.id, amountApplied: '1160.00' }], f.userId, { date: '2026-06-09' }
    );

    const [april, may, june] = [await month(4, b.id), await month(5, b.id), await month(6, b.id)];
    expect([figures(april), figures(may), figures(june)]).toEqual([WHOLE, TAKEN_OUT, WHOLE]);
    expect(june.entries).toEqual([again.journalEntry?.id]);
    expect([april.tieOut, may.tieOut, june.tieOut]).toEqual([[], [], []]);
  }, 240_000);

  it('U6 · two transfers of 580.00 in April, one unapplied in May: May gives back half, −500.00 / −80.00', async () => {
    const b = await bill();
    await pay(b.id, { amount: '580.00' });
    await unapply(await pay(b.id, { amount: '580.00' }), b.id);

    const [april, may] = [await month(4, b.id), await month(5, b.id)];
    expect(figures(april)).toEqual(WHOLE);
    // 1,000.00 × 580 / 1,160 = 500.00 and 160.00 × 580 / 1,160 = 80.00.
    expect(figures(may)).toEqual({ paper: '-500.0000 / -80.0000', diot: '-500.0000 / -80.0000' });
    expect([april.tieOut, may.tieOut]).toEqual([[], []]);
  }, 240_000);

  it('U7 · a cheque nobody cashed, reversed in May, never credited anything: no month shows its bill', async () => {
    const b = await bill();
    await reverse(await pay(b.id, { method: 'check' }));

    for (const m of [4, 5]) {
      const r = await month(m, b.id);
      expect(figures(r), `month ${m}`).toEqual(NOTHING);
      expect(r.tieOut, `month ${m}`).toEqual([]);
    }
  }, 240_000);

  it('U8 · the DIOT nets a negative document inside its third party, and the SAT file refuses a third party whose month nets negative', async () => {
    const other = await vendor('V-682-B', 'SIN070202CD2');
    const [x, y] = [await bill(other), await bill(other, '2000.00', '320.00')];
    await unapply(await pay(x.id, { of: other }), x.id);
    await pay(y.id, { of: other, amount: '2320.00', date: '2026-05-15' });

    const may = await month(5, x.id);
    expect(figures(may)).toEqual(TAKEN_OUT);
    expect(may.tieOut).toEqual([]);
    const row = may.diotBuilt.renglones.find((r) => r.tercero.vendorId === other);
    // 2,000.00 − 1,000.00 and 320.00 − 160.00.
    expect([row?.desglose.tasa16.base, row?.desglose.tasa16.iva]).toEqual(['1000.0000', '160.0000']);

    const { file, refusals } = serializeSatBatch(may.diotBuilt, { proportion: 'taxed_only' });
    const record = file.split('\r\n').map((l) => l.split('|')).find((r) => r[2] === 'SIN070202CD2');
    expect([record?.[11], record?.[21]], 'fields 12 and 22: the value of the acts at 16 % and its IVA, netted').toEqual(['1000', '160']);
    // The first vendor's May only takes out what the cases above undid.
    expect(refusals.map((r) => r.vendorIds)).toEqual([[vendorId]]);
    expect(refusals[0].message).toContain('desaplicado o reversado');
  }, 240_000);
});
