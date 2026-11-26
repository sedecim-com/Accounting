import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
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
 * MNE-001-754 · That is the default of the panel key `vendor_undo_iva_month`
 * (`undo_month`). Under `payment_month` the application counts in no month, as
 * if it had never existed: the month it counted in is amended (CFF art. 32),
 * the month of the undo takes nothing out, and since the ledger did move 1130
 * in both, the tie-out names the cause in each, and names all of the gap.
 * Every case runs under both answers, each in its own tenant.
 *
 * Every bill is 1,000.00 + 160.00 = 1,160.00, PPD, its VAT parked in 1135,
 * dated 2026-04-06; every payment is a transfer of 2026-04-20 against its
 * bill, 1,160.00, unless told. The figures are worked by hand in each case.
 * All data is synthetic.
 */

const KEY = 'vendor_undo_iva_month';
type Answer = 'undo_month' | 'payment_month';

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

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** A posted PPD bill dated 2026-04-06, its VAT parked in 1135: 1,000.00 + 160.00 unless told. */
async function bill(of = vendorId, subtotal = '1000.00', vat = '160.00'): Promise<{ id: string; uuid: string; number: string }> {
  const b = await seedBill(f, { vendorId: of, method: 'PPD', vatCode: '1135', date: BILLED, subtotal, vat });
  // seeded-bill.ts numbers each bill from its UUID.
  return { ...b, number: `BILL-${b.uuid.slice(0, 8)}` };
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
type Month = Awaited<ReturnType<typeof month>>;

/** The tie-out's causes that name this bill. */
const named = (m: Month, number: string): string[] =>
  m.tieOut.flatMap((t) => t.split('; ')).filter((c) => c.includes(number));

/** Under payment_month the tie-out speaks, and its causes account for all of its gap. */
function wholeGapNamed(m: Month): void {
  expect(m.tieOut).toHaveLength(1);
  const [, gap, explained] = /De la diferencia de (-?[\d.]+), estos documentos explican (-?[\d.]+)/.exec(m.tieOut[0]) ?? [];
  expect(explained, m.tieOut[0]).toBe(gap);
}

/** How many statements a build runs, and how many of them read the key. */
async function reads(build: (client: pg.PoolClient) => Promise<unknown>): Promise<{ statements: number; ofKey: number }> {
  return withTransaction(async (client) => {
    const seen = { statements: 0, ofKey: 0 };
    const counting = new Proxy(client, {
      get(target, prop): unknown {
        const v: unknown = Reflect.get(target, prop);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => unknown).bind(target);
        if (prop !== 'query') return fn;
        return (...args: unknown[]): unknown => {
          seen.statements += 1;
          if (Array.isArray(args[1]) && args[1].includes(KEY)) seen.ofKey += 1;
          return fn(...args);
        };
      },
    });
    await build(counting);
    return seen;
  });
}

describe.each<Answer>(['undo_month', 'payment_month'])('vendor_undo_iva_month = %s', (answer) => {
  const amend = answer === 'payment_month';

  beforeAll(async () => {
    // The paper's tie-out reads the whole entity's 1130: under undo_month every case leaves the ledger and the paper agreeing.
    f = await crearInquilino(`MNE-001-682 vendor undo month, ${answer}`);
    await seedPolicies({ tenantId: f.tenantId });
    if (amend) await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY, answer, 'it@example.test');
    bank = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1,$2,'Cheques','Banco',$3,'MXN','checking')`,
      [bank, f.entityId, f.roles.banco]
    );
    vendorId = await vendor('V-682', 'SIN060101AB1');
  }, 240_000);

  it('U1 · paid in April and unapplied on May 12th: April keeps it and May takes it out, or, amended, neither counts it', async () => {
    const b = await bill();
    const paymentId = await pay(b.id);
    const before = await month(4, b.id);
    const undo = await unapply(paymentId, b.id);

    const [april, may, june] = [await month(4, b.id), await month(5, b.id), await month(6, b.id)];
    expect(figures(before), 'April built before the unapply').toEqual(WHOLE);
    expect(figures(june)).toEqual(NOTHING);
    expect(june.tieOut).toEqual([]);
    if (!amend) {
      expect(figures(april), 'April built after the unapply').toEqual(WHOLE);
      expect(april.entries).toEqual([await ownEntry(paymentId)]);
      expect(figures(may)).toEqual(TAKEN_OUT);
      expect(may.entries, 'May traces the entry that took the IVA out of 1130').toEqual([undo]);
      expect([april.tieOut, may.tieOut], 'the ledger credited 1130 in May, and so do the papers').toEqual([[], []]);
      expect(april.undone).toEqual([]);
      expect(may.undone).toHaveLength(1);
      for (const s of ['1160.0000', '2026-04-20', 'CFF art. 32', `${KEY} = undo_month`]) expect(may.undone[0]).toContain(s);
      return;
    }
    // Amended: April no longer counts it, May takes nothing out, and the ledger moved 160.00 in each.
    expect([figures(april), figures(may)]).toEqual([NOTHING, NOTHING]);
    for (const m of [april, may]) {
      wholeGapNamed(m);
      expect(named(m, b.number), `month ${m === april ? 4 : 5}`).toHaveLength(1);
      expect(named(m, b.number)[0]).toContain(`${KEY} = payment_month`);
      expect(named(m, b.number)[0]).toContain('CFF art. 32');
    }
    expect(named(april, b.number)[0]).toMatch(/2026-05-12.*\(-160\.0000\)\.?$/);
    expect(named(may, b.number)[0]).toMatch(/2026-04-20.*\(160\.0000\)\.?$/);
    expect([april.undone, may.undone].map((n) => n.length), 'the notice in the month it counted in and in the month of the undo').toEqual([1, 1]);
    for (const s of ['1160.0000', '2026-05-12', 'CFF art. 32', `${KEY} = payment_month`]) expect(april.undone[0]).toContain(s);
    for (const s of ['1160.0000', '2026-04-20', 'CFF art. 32', `${KEY} = payment_month`]) expect(may.undone[0]).toContain(s);
  }, 240_000);

  it('U2 · paid in April and reversed on May 12th: the same two months, May traced to the mirror', async () => {
    const b = await bill();
    const paymentId = await pay(b.id);
    const mirrors = await reverse(paymentId);

    const [april, may] = [await month(4, b.id), await month(5, b.id)];
    if (!amend) {
      expect([figures(april), april.entries]).toEqual([WHOLE, [await ownEntry(paymentId)]]);
      expect([figures(may), may.entries]).toEqual([TAKEN_OUT, [...mirrors].sort()]);
      expect([april.tieOut, may.tieOut]).toEqual([[], []]);
      expect(may.undone).toHaveLength(1);
      return;
    }
    expect([figures(april), figures(may)]).toEqual([NOTHING, NOTHING]);
    for (const m of [april, may]) {
      wholeGapNamed(m);
      expect(named(m, b.number)).toHaveLength(1);
    }
    expect([april.undone.length, may.undone.length]).toEqual([1, 1]);
  }, 240_000);

  it('U3 · an undo dated in the payment\'s own month nets to 0.00 there: April shows neither bill', async () => {
    const [unapplied, reversed] = [await bill(), await bill()];
    await unapply(await pay(unapplied.id), unapplied.id, '2026-04-27');
    await reverse(await pay(reversed.id), '2026-04-27');

    for (const b of [unapplied, reversed]) {
      const [april, may] = [await month(4, b.id), await month(5, b.id)];
      expect([figures(april), figures(may)]).toEqual([NOTHING, NOTHING]);
      if (!amend) expect([april.tieOut, may.tieOut]).toEqual([[], []]);
      expect([named(april, b.number), named(may, b.number)], 'the ledger netted it in April too').toEqual([[], []]);
      expect([april.undone, may.undone]).toEqual([[], []]);
    }
  }, 240_000);

  it('U4 · the IVA withheld to the vendor follows the same months: 106.67 in April, −106.67 in May, or none', async () => {
    const b = await bill();
    // Two thirds of 160.00, as the vendor's CFDI rounds it.
    await query(`UPDATE xml_documents SET total_iva_retenido = 106.67 WHERE cfdi_uuid = $1 AND entity_id = $2`, [b.uuid, f.entityId]);
    await unapply(await pay(b.id), b.id);

    const [april, may] = [await month(4, b.id), await month(5, b.id)];
    if (!amend) {
      expect([april.withheld, may.withheld]).toEqual(['106.6700', '-106.6700']);
      expect([figures(april), figures(may)]).toEqual([WHOLE, TAKEN_OUT]);
      return;
    }
    expect([april.withheld, may.withheld]).toEqual([null, null]);
    expect([figures(april), figures(may)]).toEqual([NOTHING, NOTHING]);
  }, 240_000);

  it('U5 · unapplied in May and applied again on June 9th: June adds it, whatever the answer', async () => {
    const b = await bill();
    const paymentId = await pay(b.id);
    await unapply(paymentId, b.id);
    const again = await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: b.id, amountApplied: '1160.00' }], f.userId, { date: '2026-06-09' }
    );

    const [april, may, june] = [await month(4, b.id), await month(5, b.id), await month(6, b.id)];
    expect([figures(april), figures(may), figures(june)]).toEqual(amend ? [NOTHING, NOTHING, WHOLE] : [WHOLE, TAKEN_OUT, WHOLE]);
    expect(june.entries).toEqual([again.journalEntry?.id]);
    expect(june.tieOut).toEqual([]);
    if (!amend) expect([april.tieOut, may.tieOut]).toEqual([[], []]);
    else for (const m of [april, may]) wholeGapNamed(m);
  }, 240_000);

  it('U6 · two transfers of 580.00 in April, one unapplied in May: May gives back half, or April counts only the other', async () => {
    const b = await bill();
    await pay(b.id, { amount: '580.00' });
    await unapply(await pay(b.id, { amount: '580.00' }), b.id);

    const [april, may] = [await month(4, b.id), await month(5, b.id)];
    // 1,000.00 × 580 / 1,160 = 500.00 and 160.00 × 580 / 1,160 = 80.00.
    const HALF = { paper: '500.0000 / 80.0000', diot: '500.0000 / 80.0000' };
    if (!amend) {
      expect(figures(april)).toEqual(WHOLE);
      expect(figures(may)).toEqual({ paper: '-500.0000 / -80.0000', diot: '-500.0000 / -80.0000' });
      expect([april.tieOut, may.tieOut]).toEqual([[], []]);
      return;
    }
    expect([figures(april), figures(may)]).toEqual([HALF, NOTHING]);
    expect(named(april, b.number)[0]).toMatch(/\(-80\.0000\)\.?$/);
    expect(named(may, b.number)[0]).toMatch(/\(80\.0000\)\.?$/);
    for (const m of [april, may]) wholeGapNamed(m);
  }, 240_000);

  it('U7 · a cheque nobody cashed, reversed in May, never credited anything: no month shows its bill', async () => {
    const b = await bill();
    await reverse(await pay(b.id, { method: 'check' }));

    for (const m of [4, 5]) {
      const r = await month(m, b.id);
      expect(figures(r), `month ${m}`).toEqual(NOTHING);
      if (!amend) expect(r.tieOut, `month ${m}`).toEqual([]);
      expect(named(r, b.number), `month ${m}`).toEqual([]);
    }
  }, 240_000);

  it('U8 · the SAT file: undone, the third party nets inside its record and is refused when negative; amended, no month is negative', async () => {
    const other = await vendor('V-682-B', 'SIN070202CD2');
    const [x, y] = [await bill(other), await bill(other, '2000.00', '320.00')];
    await unapply(await pay(x.id, { of: other }), x.id);
    await pay(y.id, { of: other, amount: '2320.00', date: '2026-05-15' });

    const may = await month(5, x.id);
    expect(figures(may)).toEqual(amend ? NOTHING : TAKEN_OUT);
    if (!amend) expect(may.tieOut).toEqual([]);
    const row = may.diotBuilt.renglones.find((r) => r.tercero.vendorId === other);
    // Undone: 2,000.00 − 1,000.00 and 320.00 − 160.00. Amended: Y alone.
    const [base, iva] = amend ? ['2000', '320'] : ['1000', '160'];
    expect([row?.desglose.tasa16.base, row?.desglose.tasa16.iva]).toEqual([`${base}.0000`, `${iva}.0000`]);

    const { file, refusals } = serializeSatBatch(may.diotBuilt, { proportion: 'taxed_only' });
    const record = file.split('\r\n').map((l) => l.split('|')).find((r) => r[2] === 'SIN070202CD2');
    expect([record?.[11], record?.[21]], 'fields 12 and 22: the value of the acts at 16 % and its IVA, netted').toEqual([base, iva]);
    if (amend) {
      // A month counts only what still stands applied: it never goes down.
      expect(refusals).toEqual([]);
      return;
    }
    // The first vendor's May only takes out what the cases above undid.
    expect(refusals.map((r) => r.vendorIds)).toEqual([[vendorId]]);
    expect(refusals[0].message.key).toBe('error.DIOT_NO_ENTREGABLE.sat_batch.negative_net');
  }, 240_000);

  it('the DIOT and the workpaper each read the key once a month, whatever the number of applications', async () => {
    const scope = { tenantId: f.tenantId, entityId: f.entityId };
    const wp = await reads((client) => buildIvaWorkpaper({ ...scope, year: 2026, month: 5, client }));
    const diot = await reads((client) => construirDiot({ ...scope, anio: 2026, mes: 5, client }));
    expect([wp.ofKey, diot.ofKey]).toEqual([1, 1]);
  }, 240_000);
});
