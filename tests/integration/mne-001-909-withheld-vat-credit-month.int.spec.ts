import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordVendorPayment, unapplyVendorPayment } from '../../src/services/payments/payment-service.js';
import { buildIvaWorkpaper, type IvaWorkpaperOptions } from '../../src/services/fiscal/iva-workpaper.js';
import { generateFilingWorkpaper } from '../../src/services/fiscal/filing-workpaper.js';
import { construirDiot } from '../../src/services/sat/diot/diot-service.js';
import { textIn, ValidationError } from '../../src/utils/errors.js';

/**
 * MNE-001-909 (#1075), part 1 of 2 · THE IVA WITHHELD TO A VENDOR IS CREDITED
 * AFTER ITS REMITTANCE (LIVA art. 5o. fr. IV), under the panel key
 * `withheld_vat_credit_month`: `after_remittance` (the default) or
 * `payment_month` (the paper before the key).
 *
 * The acceptance's case, by hand: fees of 10,000.00 + 1,600.00 from a natural
 * person, less 1,000.00 of ISR and 1,066.67 of IVA withheld: 9,533.33 owed,
 * paid whole on 2026-01-20. The ledger debits 1130 with 1,600.00 that day. By
 * law January credits 1,600.00 − 1,066.67 = 533.33 and the 1,066.67 is credited
 * in the return after the one that remitted it: February's, since January's
 * return remits it (art. 1o.-A). That credit belongs to February's paper and
 * to no other. All data is synthetic.
 */

const KEY = 'withheld_vat_credit_month';
type Remitted = NonNullable<IvaWorkpaperOptions['withheldVatRemittances']>;

let f: Fixture;
let bank: string;
let vendorId: string;

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function tenant(name: string, answer?: 'payment_month'): Promise<void> {
  f = await crearInquilino(name);
  await seedPolicies({ tenantId: f.tenantId });
  if (answer) await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY, answer, 'it@example.test');
  bank = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Cheques','Banco',$3,'MXN','checking')`,
    [bank, f.entityId, f.roles.banco]
  );
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-909', 'Synthetic Fees Vendor', 'SIN060101AB1', 'rfc', 'MXN', $3)`,
    [vendorId, f.entityId, f.userId]
  );
}

/** A PPD bill with its VAT parked in 1135 and both withholdings posted; the fees of the acceptance unless told. */
async function bill(date: string, o: { subtotal?: string; vat?: string; isr?: string; vatWithheld?: string } = {}) {
  const b = await seedBill(f, {
    vendorId, method: 'PPD', vatCode: '1135', date, subtotal: o.subtotal ?? '10000.00', vat: o.vat ?? '1600.00',
    withheld: { isr: o.isr ?? '1000.00', vat: o.vatWithheld ?? '1066.67' },
  });
  return { ...b, number: `BILL-${b.uuid.slice(0, 8)}` };
}

async function pay(billId: string, amount: string, date: string): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: date, paymentMethod: 'spei',
      bankAccountId: bank, applications: [{ documentId: billId, amountApplied: amount }],
    },
    f.userId
  );
  return r.paymentId;
}

/** What one month's paper says of the IVA paid at 16 % and of the IVA withheld to vendors. */
async function paper(month: number, remitted: Remitted = [], client?: pg.PoolClient) {
  const wp = await buildIvaWorkpaper({
    tenantId: f.tenantId, entityId: f.entityId, year: 2026, month, withheldVatRemittances: remitted, client,
  });
  const about = (code: string): string[] => wp.findings.filter((h) => h.codigo === code).map((h) => textIn(h.mensaje, 'en'));
  return {
    wp,
    paid16: `${wp.figures.creditable.tasa16.base} / ${wp.figures.creditable.tasa16.iva}`,
    withheld: { awaiting: wp.withheldVat.awaitingRemittance, credited: wp.withheldVat.credited, notCredited: wp.withheldVat.notCredited },
    line: (key: string) => wp.settlement?.lines.find((l) => l.key === key),
    tieOut: about('IVA-WP-CREDITABLE-VS-LEDGER'),
    awaits: about('IVA-WP-WITHHELD-VAT-AWAITS-REMITTANCE'),
    notCredited: about('IVA-WP-WITHHELD-VAT-NOT-CREDITED'),
    credited: about('IVA-WP-WITHHELD-VAT-CREDITED'),
  };
}
const NONE = { awaiting: '0.0000', credited: [], notCredited: [] };

/** The tie-out speaks once, and its causes account for all of its gap, which is `gap`. */
function gapNamed(tieOut: string[], gap: string, naming: string): void {
  expect(tieOut).toHaveLength(1);
  const [, difference, explained] = /De la diferencia de (-?[\d.]+), estos documentos explican (-?[\d.]+)/.exec(tieOut[0]) ?? [];
  expect([difference, explained], tieOut[0]).toEqual([gap, gap]);
  expect(tieOut[0]).toContain(naming);
}

async function refusal(run: Promise<unknown>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).messageKey?.key ?? '';
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

describe('withheld_vat_credit_month = after_remittance (the default)', () => {
  let fees: Awaited<ReturnType<typeof bill>>;
  const JANUARY: Remitted = [{ period: '2026-01', acknowledgement: 'ACUSE-ENE-0001' }];

  beforeAll(async () => {
    await tenant('MNE-001-909 after_remittance');
    fees = await bill('2026-01-08');
    await pay(fees.id, '9533.33', '2026-01-20');
  }, 240_000);

  it('W1 · January credits 533.33 and holds 1,066.67 back; February credits it once its remittance is captured', async () => {
    const january = await paper(1);
    expect(january.wp.ledger.iva_acreditable, 'the ledger debited 1130 with the whole IVA on payment').toBe('1600.0000');
    expect(january.paid16).toBe('10000.0000 / 533.3300');
    expect(january.withheld).toEqual({ ...NONE, awaiting: '1066.6700' });
    expect(january.line('creditable.tasa16.iva')).toEqual({ key: 'creditable.tasa16.iva', cents: '533.33', whole: '533', sign: -1 });
    expect(january.line('creditable.withheld_awaiting_remittance')).toMatchObject({ cents: '1066.67', sign: 0 });
    expect(january.wp.settlement?.resultCents, 'nothing charged: 533.33 in favour').toBe('-533.33');
    gapNamed(january.tieOut, '-1066.6700', `${KEY} = after_remittance`);
    expect(january.awaits).toHaveLength(1);
    for (const s of ['1066.6700', fees.number, 'art. 5o. fr. IV', 'the paper of 2026-02, and on no other', '--withheld-vat-remitted 2026-01:<acuse>']) {
      expect(january.awaits[0]).toContain(s);
    }

    const february = await paper(2, JANUARY);
    expect(february.paid16, 'the act was paid in January: only its IVA waits').toBe('0.0000 / 1066.6700');
    expect(february.withheld).toEqual({ ...NONE, credited: [{ ...JANUARY[0], amount: '1066.6700' }] });
    expect(february.line('creditable.tasa16.iva')).toMatchObject({ cents: '1066.67', whole: '1067', sign: -1 });
    expect(february.line('creditable.withheld_remitted')).toMatchObject({ cents: '1066.67', sign: 0 });
    gapNamed(february.tieOut, '1066.6700', 'acuse ACUSE-ENE-0001');
    expect(february.credited).toHaveLength(1);
    for (const s of ['1066.6700', 'acuse ACUSE-ENE-0001', 'checked neither it nor the amount remitted']) expect(february.credited[0]).toContain(s);
    expect(february.wp.contributions.creditable.filter((c) => c.documentId === fees.id).map((c) => [c.breakdown.tasa16.iva, c.entryIds]))
      .toEqual([['1066.6700', []]]);
  }, 240_000);

  it('W2 · never stated: no month credits it, and February\'s paper, the one it belongs on, names it and says how to credit it there', async () => {
    const [february, march] = [await paper(2), await paper(3)];
    expect([february.paid16, march.paid16]).toEqual(['0.0000 / 0.0000', '0.0000 / 0.0000']);
    expect(february.withheld).toEqual({ ...NONE, notCredited: [{ period: '2026-01', amount: '1066.6700' }] });
    for (const s of ['1066.6700', '2026-01', fees.number, 'on this paper, the one of 2026-02, and on no other', 'generate this paper again', 'complementary return of 2026-02']) {
      expect(february.notCredited[0]).toContain(s);
    }
    expect([february.tieOut, march.tieOut], 'neither the paper nor the ledger moved').toEqual([[], []]);
    // March speaks of February alone, which withheld nothing: January's credit never moves to it.
    expect(march.withheld).toEqual(NONE);
  }, 240_000);

  it('W3 · one paper, one credit: stated twice on February\'s paper it is credited once, and March\'s paper refuses it, naming February\'s', async () => {
    const twice = await paper(2, [...JANUARY, ...JANUARY]);
    expect(twice.paid16, 'remitted late, it is still February\'s: its paper generated again').toBe('0.0000 / 1066.6700');
    expect(twice.withheld.credited).toEqual([{ ...JANUARY[0], amount: '1066.6700' }]);
    const refused = async (remitted: Remitted, month: number): Promise<[string, unknown]> => {
      const error = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month, withheldVatRemittances: remitted })
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      return [(error as ValidationError).messageKey?.key ?? '', (error as ValidationError).messageKey?.params];
    };
    const OTHER = 'filing.workpaper.withheld_vat.remittance_other_month';
    expect(await refused(JANUARY, 3)).toEqual([OTHER, { period: '2026-01', belongs: '2026-02', month: '2026-03', before: '2026-02' }]);
    expect((await refused(JANUARY, 1))[0], 'never in its own month').toBe(OTHER);
    expect((await refused([{ period: '2026-03', acknowledgement: 'A' }], 2))[0], 'nor a later month\'s on an earlier paper').toBe(OTHER);
    const INVALID = 'filing.workpaper.withheld_vat.remittance_invalid';
    expect((await refused([...JANUARY, { period: '2026-01', acknowledgement: 'ANOTHER' }], 2))[0], 'two acuses are not one statement').toBe(INVALID);
    expect((await refused([{ period: '2026-01', acknowledgement: ' ' }], 2))[0]).toBe(INVALID);
    expect((await refused([{ period: 'enero', acknowledgement: 'A' }], 2))[0]).toBe(INVALID);
    // A month that withheld nothing credits nothing, and says so.
    const nothing = await buildIvaWorkpaper({
      tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 3, withheldVatRemittances: [{ period: '2026-02', acknowledgement: 'A' }],
    });
    expect(nothing.findings.map((h) => h.codigo)).toContain('IVA-WP-WITHHELD-VAT-NOTHING-WITHHELD');
    expect(nothing.withheldVat.credited).toEqual([]);
  }, 240_000);

  it('W4 · a bill paid in two halves: each half credits 800.00 in its month and holds 1,600.00 back for the return after its remittance', async () => {
    // A lease of 30,000.00 + 4,800.00, less 3,000.00 of ISR and 3,200.00 of IVA withheld: 28,600.00, paid 14,300.00 twice.
    // Each half carries 4,800.00 / 2 = 2,400.00 of IVA, of which 3,200.00 / 2 = 1,600.00 withheld and 800.00 paid to the lessor.
    const lease = await bill('2026-05-05', { subtotal: '30000.00', vat: '4800.00', isr: '3000.00', vatWithheld: '3200.00' });
    await pay(lease.id, '14300.00', '2026-05-20');
    await pay(lease.id, '14300.00', '2026-07-15');
    const remitted = (period: string): Remitted => [{ period, acknowledgement: `ACUSE-${period}` }];
    const [may, june, july, august] = [await paper(5), await paper(6, remitted('2026-05')), await paper(7), await paper(8, remitted('2026-07'))];
    expect([may.paid16, june.paid16, july.paid16, august.paid16])
      .toEqual(['15000.0000 / 800.0000', '0.0000 / 1600.0000', '15000.0000 / 800.0000', '0.0000 / 1600.0000']);
    expect([may.withheld.awaiting, july.withheld.awaiting]).toEqual(['1600.0000', '1600.0000']);
    expect(june.withheld.credited).toEqual([{ period: '2026-05', acknowledgement: 'ACUSE-2026-05', amount: '1600.0000' }]);
    gapNamed(may.tieOut, '-1600.0000', 'after_remittance');
    gapNamed(august.tieOut, '1600.0000', 'ACUSE-2026-07');
  }, 240_000);

  it('W5 · an undo is never held back: the month of the unapply takes the whole 1,600.00 out, as the ledger does', async () => {
    const undone = await bill('2026-09-03');
    const payment = await pay(undone.id, '9533.33', '2026-09-10');
    await unapplyVendorPayment(f.entityId, payment, { billId: undone.id, reason: 'Synthetic: applied to the wrong bill', date: '2026-10-12' }, f.userId);
    const [september, october] = [await paper(9), await paper(10)];
    expect([september.paid16, october.paid16]).toEqual(['10000.0000 / 533.3300', '-10000.0000 / -1600.0000']);
    expect(october.withheld).toEqual({ ...NONE, notCredited: [{ period: '2026-09', amount: '1066.6700' }] });
    expect(october.tieOut).toEqual([]);
  }, 240_000);

  it('W6 · the DIOT does not read the key: January declares the bill whole with its IVA withheld, and February nothing', async () => {
    const of = async (m: number) => (await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: m }))
      .renglones.flatMap((r) => r.documentos).filter((d) => d.billId === fees.id)
      .map((d) => `${d.desglose.tasa16.base} / ${d.desglose.tasa16.iva} / ${d.ivaRetenido}`);
    expect([await of(1), await of(2)]).toEqual([['10000.0000 / 1600.0000 / 1066.6700'], []]);
  }, 240_000);

  it('W7 · the filing workpaper prints the acuse as typed beside the amount, and the key is read once; a month\'s bills with no IVA withheld cost the next paper nothing', async () => {
    const scope = { tenantId: f.tenantId, entityId: f.entityId, year: 2026 };
    const fw = await generateFilingWorkpaper({ ...scope, month: 2, forms: ['iva'], withheldVatRemittances: JANUARY });
    expect(fw.sections[0].lines.find((l) => l.key === 'creditable.withheld_remitted')?.source).toMatchObject({ kind: 'captured', ref: 'withheld_vat' });
    expect(fw.sections[0].inputs.withheld_vat).toMatchObject({
      policy: KEY, value: 'after_remittance', awaitingRemittance: '0.0000', credited: '2026-01:ACUSE-ENE-0001=1066.6700', notCredited: null,
      checkedBySystem: false,
    });
    const before = await reads((client) => paper(12, [], client));
    expect(before.ofKey).toBe(1);
    for (const n of [1, 2, 3]) {
      const plain = await seedBill(f, { vendorId, method: 'PPD', vatCode: '1135', date: `2026-11-0${n}` });
      await pay(plain.id, '1160.00', '2026-11-20');
    }
    expect((await reads((client) => paper(12, [], client))).statements, 'November is read for its withheld bills alone').toBe(before.statements);
  }, 240_000);
});

describe('withheld_vat_credit_month = payment_month', () => {
  beforeAll(async () => {
    await tenant('MNE-001-909 payment_month', 'payment_month');
    const fees = await bill('2026-01-08');
    await pay(fees.id, '9533.33', '2026-01-20');
  }, 240_000);

  it('P1 · the paper is the one before the key: 1,600.00 in January, nothing in February, no new line, no finding, no capture', async () => {
    const [january, february] = [await paper(1), await paper(2)];
    expect([january.paid16, february.paid16]).toEqual(['10000.0000 / 1600.0000', '0.0000 / 0.0000']);
    expect([january.withheld, february.withheld]).toEqual([NONE, NONE]);
    expect([january.tieOut, february.tieOut]).toEqual([[], []]);
    expect(january.wp.findings.filter((h) => h.politica === KEY)).toEqual([]);
    // The figures and the lines of the paper before the key, by name and in their order.
    expect(Object.keys(january.wp.figures)).toEqual([
      'charged', 'chargedNotSubject', 'creditable', 'withheldByCustomers', 'withheldToRemit', 'priorBalanceInFavor', 'proration',
    ]);
    const boxes = (side: string): string[] => ['tasa16', 'tasa8', 'tasa0', 'exento'].flatMap((r) => [`${side}.${r}.base`, `${side}.${r}.iva`]);
    expect(january.wp.settlement?.lines.map((l) => l.key)).toEqual([
      ...boxes('charged'), 'charged.no_objeto.base', ...boxes('creditable'), 'withheld_by_customers', 'prior_balance_in_favor', 'withheld_to_remit',
    ]);
    expect(january.line('creditable.tasa16.iva')).toEqual({ key: 'creditable.tasa16.iva', cents: '1600.00', whole: '1600', sign: -1 });
    expect(january.line('withheld_to_remit'), 'what the month\'s entries credited to 2142').toMatchObject({ cents: '1066.67', sign: 0 });
    expect(january.wp.settlement?.resultCents).toBe('-1600.00');
    const fw = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 1, forms: ['iva'] });
    expect(Object.keys(fw.sections[0].inputs)).toEqual(['prior_balance_in_favor', 'proration']);
    expect(await refusal(buildIvaWorkpaper({
      tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 2, withheldVatRemittances: [{ period: '2026-01', acknowledgement: 'A' }],
    }))).toBe('filing.workpaper.withheld_vat.remittance_not_asked');
  }, 240_000);
});
