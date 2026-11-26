import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
  getCustomerPayment,
  transferCustomerCredit,
  stateReversalCause,
  listCustomerPayments,
} from '../../src/services/payments/payment-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { buildProvisionalIncomeTaxWorkpaper } from '../../src/services/fiscal/provisional-income-tax.js';
import { listPaymentsAwaitingRep } from '../../src/services/accounting/rep-expected.js';
import { textIn, type AppError } from '../../src/utils/errors.js';

// ============================================================
// MNE-001-499 (#695, part 2/2) · THE TRANSFERRED CREDIT SETTLES B'S INVOICES,
// AND `receipt reverse <TRF>` UNDOES IT, AGAINST POSTGRES.
//
// B's IVA (2125 → 2120) and IEPS (2181 → 2180) are caused when the credit
// extinguishes B's invoice (LIVA art. 1o.-B; LIEPS art. 5o.-C), on the
// application's own day (applied_on, MNE-001-460/423), through the ordinary
// `receipt apply`. A treated advance moves with its base and IVA split, and
// the IVA it caused is not caused again. Hand figures from the plan; every
// party is synthetic.
// ============================================================

const REASON = 'Convenio 15-jun';
const DAY = '2026-06-15';

let f: Fixture;
let iso: Fixture;
let customerA: string;
let customerB: string;
let isoA: string;
let isoB: string;

async function customer(fx: Fixture, number: string, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, $4, 'MXN', $5)`,
    [id, fx.entityId, number, name, fx.userId]
  );
  return id;
}

/** An issued invoice to `customerId` at 16 %: `base` of service and, with `ieps`, an IEPS line on 2181 as #699's fixture. */
async function invoice(
  fx: Fixture, customerId: string, date: string, terms: 'PUE' | 'PPD',
  o: { base?: string; ieps?: string } = {}
): Promise<{ id: string; number: string }> {
  const draft = await createInvoice({
    entity_id: fx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms,
    lines: [
      { revenue_account_id: fx.roles.ingreso, description: 'Synthetic service', quantity: '1', unit_price: o.base ?? '1000.00', tax_rate: '16.0000' },
      ...(o.ieps ? [{ revenue_account_id: fx.cuentas['2181'], description: 'IEPS transferred', quantity: '1', unit_price: o.ieps, tax_rate: '16.0000' }] : []),
    ],
    created_by: fx.userId,
  });
  const issued = (await issueInvoice(draft.id, fx.userId, { entityId: fx.entityId })).invoice;
  return { id: issued.id, number: issued.invoice_number };
}

/** 498's setup: a PUE invoice collected whole by SPEI on 05-20 and unapplied on 05-25, its cash back on account. */
async function unappliedReceipt(fx: Fixture, customerId: string, base = '1000.00'): Promise<{ id: string; number: string }> {
  const s1 = await invoice(fx, customerId, '2026-05-20', 'PUE', { base });
  const amount = new Decimal(base).times('1.16').toFixed(2);
  const r = await recordCustomerPayment(
    {
      entityId: fx.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: '2026-05-20',
      paymentMethod: 'spei', applications: [{ documentId: s1.id, amountApplied: amount }],
    },
    fx.userId
  );
  await unapplyCustomerPayment(
    fx.entityId, r.paymentId, { invoiceId: s1.id, reason: 'applied to the wrong customer', date: '2026-05-25' }, fx.userId
  );
  return { id: r.paymentId, number: r.paymentNumber };
}

const transfer = (fx: Fixture, sourceId: string, to: string, amount: string, dryRun = false) =>
  transferCustomerCredit(fx.entityId, sourceId, { customerId: to, amount, date: DAY, reason: REASON }, fx.userId, { dryRun });

const apply = (fx: Fixture, paymentId: string, invoiceId: string, amount: string, date: string) =>
  applyCustomerPayment(fx.entityId, paymentId, [{ documentId: invoiceId, amountApplied: amount }], fx.userId, { date });

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a refusal');
}

const onAccountOf = async (fx: Fixture, ref: string) => (await getCustomerPayment(fx.entityId, ref)).unapplied_amount;

type Codes = '1120' | '2120' | '2125' | '2150' | '2180' | '2181';
const CODES: Codes[] = ['1120', '2120', '2125', '2150', '2180', '2181'];

/** Credit balances of the posted ledger on the accounts this task moves, and whether every entry foots. */
async function balances(fx: Fixture): Promise<Record<Codes, string>> {
  const r = await query<{ code: Codes; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
      WHERE a.entity_id = $1 AND a.code = ANY($2::text[]) GROUP BY a.code`,
    [fx.entityId, CODES]
  );
  return Object.fromEntries(CODES.map((c) => [c, new Decimal(r.rows.find((x) => x.code === c)?.b ?? 0).toFixed(2)])) as Record<Codes, string>;
}

const since = async (fx: Fixture, before: Record<Codes, string>) => {
  const now = await balances(fx);
  return Object.fromEntries(CODES.map((k) => [k, new Decimal(now[k]).minus(before[k]).toFixed(2)])) as Record<Codes, string>;
};

/** Every posted entry of the entity foots, and so does the whole ledger. */
async function expectLedgerFoots(fx: Fixture): Promise<void> {
  const r = await query<{ unbalanced: string; total: string }>(
    `SELECT COUNT(*) FILTER (WHERE d <> c)::text AS unbalanced, COALESCE(SUM(d - c), 0)::numeric(19,2)::text AS total
       FROM (SELECT je.id, SUM(COALESCE(l.debit_amount, 0)) AS d, SUM(COALESCE(l.credit_amount, 0)) AS c
               FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
              WHERE je.entity_id = $1 AND je.status = 'posted' GROUP BY je.id) x`,
    [fx.entityId]
  );
  expect(r.rows[0]).toEqual({ unbalanced: '0', total: '0.00' });
}

const stamp = (id: string) =>
  query(`UPDATE invoices SET cfdi_uuid = $2, cfdi_status = 'stamped' WHERE id = $1`, [id, uuidv4().toUpperCase()]);

const paper = (fx: Fixture, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: fx.tenantId, entityId: fx.entityId, year: 2026, month });
const ivaOf = (wp: IvaWorkpaper, ids: string[]) =>
  wp.contributions.charged.filter((c) => ids.includes(c.documentId))
    .reduce((s, c) => s.plus(c.breakdown.tasa16?.iva ?? 0), new Decimal(0)).toFixed(2);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-499 transferred credit');
  iso = await crearInquilino('MNE-001-499 isolated ISR');
  customerA = await customer(f, 'C-499-A', 'Cliente Cedente SA');
  customerB = await customer(f, 'C-499-B', 'Cliente Cesionario SA');
  isoA = await customer(iso, 'C-499-IA', 'Cedente Aislado SA');
  isoB = await customer(iso, 'C-499-IB', 'Cesionario Aislado SA');
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('S1-S4 · TRF-1 of 1,160.00 settles B\'s PPD invoice in June', () => {
  let source: { id: string; number: string };
  let trf: string;
  let trfNumber: string;
  let invoiceB: { id: string; number: string };

  beforeAll(async () => {
    source = await unappliedReceipt(f, customerA);
    const r = await transfer(f, source.id, customerB, '1160.00');
    trf = r.transferId;
    trfNumber = r.transferNumber;
    invoiceB = await invoice(f, customerB, '2026-06-01', 'PPD');
    await stamp(invoiceB.id);
  }, 180_000);

  it('S1 · applied on 06-20: the invoice is paid, 160.00 moves from 2125 to 2120 and June\'s paper counts it', async () => {
    const juneBefore = ivaOf(await paper(f, 6), [invoiceB.id]);
    const before = await balances(f);
    const r = await apply(f, trf, invoiceB.id, '1160.00', '2026-06-20');
    expect(r.date).toBe('2026-06-20');
    expect(r.remanenteNuevo).toBe('0.00');
    const inv = (await query<{ status: string; due: string }>(
      `SELECT status, amount_due::text AS due FROM invoices WHERE id = $1`, [invoiceB.id]
    )).rows[0];
    expect(inv).toEqual({ status: 'paid', due: '0.0000' });
    expect(await since(f, before)).toEqual({
      '1120': '1160.00', '2120': '160.00', '2125': '-160.00', '2150': '-1160.00', '2180': '0.00', '2181': '0.00',
    });
    expect(juneBefore).toBe('0.00');
    expect(ivaOf(await paper(f, 6), [invoiceB.id])).toBe('160.00');
    await expectLedgerFoots(f);
  }, 120_000);

  it('S1 · `rep missing list --direction issued` names TRF-1 for B, and A\'s receipt still cannot settle B\'s invoice (#664)', async () => {
    const { awaiting } = await listPaymentsAwaitingRep(query, f.entityId);
    const issued = awaiting.filter((p) => p.direction === 'issued' && p.payment_number === trfNumber);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ counterparty: 'Cliente Cesionario SA', method: 'PPD' });

    const other = await invoice(f, customerB, '2026-06-01', 'PPD');
    const fresh = await unappliedReceipt(f, customerA);
    const e = await refusal(apply(f, fresh.id, other.id, '100.00', '2026-06-20'));
    expect(e.messageKey?.key).toBe('receipt.apply.other_customer');
  }, 120_000);

  it('S2 · a TRF applied in July counts in July, and June does not move (the allocation keeps its own day)', async () => {
    const second = await unappliedReceipt(f, customerA);
    const t2 = await transfer(f, second.id, customerB, '1160.00');
    const invoiceB2 = await invoice(f, customerB, '2026-06-01', 'PPD');
    const june = ivaOf(await paper(f, 6), [invoiceB2.id, t2.transferId]);
    await apply(f, t2.transferId, invoiceB2.id, '1160.00', '2026-07-03');
    expect(june).toBe('0.00');
    expect(ivaOf(await paper(f, 6), [invoiceB2.id, t2.transferId])).toBe('0.00');
    expect(ivaOf(await paper(f, 7), [invoiceB2.id, t2.transferId])).toBe('160.00');
  }, 180_000);

  it('S3 · a target invoice not in MXN is refused before any write', async () => {
    const third = await unappliedReceipt(f, customerA);
    const t3 = await transfer(f, third.id, customerB, '100.00');
    const usd = await invoice(f, customerB, '2026-06-01', 'PPD');
    await query(`UPDATE invoices SET currency_code = 'USD' WHERE id = $1`, [usd.id]);
    const e = await refusal(apply(f, t3.transferId, usd.id, '100.00', '2026-06-20'));
    expect(e.message).toContain('USD');
    expect(await onAccountOf(f, t3.transferId)).toBe('100.00');
  }, 180_000);

  it('S4 · A\'s receipt cannot be reversed while TRF-1 lives, and TRF-1 cannot while it is applied', async () => {
    const a = await refusal(reverseCustomerPayment(f.entityId, source.id, { reason: 'bounced', cause: 'taken_back' }, f.userId));
    expect(a.messageKey?.key).toBe('receipt.reverse.has_transfer');
    expect(a.message).toContain(trfNumber);
    const t = await refusal(reverseCustomerPayment(f.entityId, trf, { reason: 'wrong customer' }, f.userId));
    expect(t.messageKey?.key).toBe('receipt.reverse.transfer_applied');
    expect(t.message).toContain(invoiceB.number);
  }, 120_000);
});

describe('S4 · `receipt reverse <TRF> --reason` mirrors the transfer and gives A its 1,160.00 back', () => {
  it('a TRF applied to a PUE invoice and unapplied is reversed: only its own entry is mirrored', async () => {
    const source = await unappliedReceipt(f, customerA);
    const t = await transfer(f, source.id, customerB, '1160.00');
    const pue = await invoice(f, customerB, '2026-06-16', 'PUE');
    await apply(f, t.transferId, pue.id, '1160.00', '2026-06-20');
    await unapplyCustomerPayment(f.entityId, t.transferId, { invoiceId: pue.id, reason: 'wrong invoice', date: '2026-06-21' }, f.userId);

    const cause = await refusal(reverseCustomerPayment(f.entityId, t.transferId, { reason: 'x', cause: 'taken_back' }, f.userId));
    expect(cause.messageKey?.key).toBe('receipt.reverse.transfer_cause');

    const dry = await reverseCustomerPayment(f.entityId, t.transferId, { reason: 'agreement cancelled' }, f.userId, { dryRun: true });
    expect(dry.reversals).toHaveLength(1);
    expect(await onAccountOf(f, source.id)).toBe('0.00');

    const before = await balances(f);
    const r = await reverseCustomerPayment(f.entityId, t.transferId, { reason: 'agreement cancelled' }, f.userId);
    expect(r.reversals).toEqual([{ entryNumber: expect.any(String), of: t.journalEntry.entry_number }]);
    expect(r.documentosReabiertos).toEqual([]);
    expect(await since(f, before)).toEqual({
      '1120': '0.00', '2120': '0.00', '2125': '0.00', '2150': '0.00', '2180': '0.00', '2181': '0.00',
    });
    const row = (await query<{ status: string; mirrored: boolean }>(
      `SELECT cp.status, (je.reversed_by_entry_id IS NOT NULL) AS mirrored
         FROM customer_payments cp JOIN journal_entries je ON je.id = cp.journal_entry_id WHERE cp.id = $1`,
      [t.transferId]
    )).rows[0];
    expect(row).toEqual({ status: 'reversed', mirrored: true });
    expect(await onAccountOf(f, source.id)).toBe('1160.00');
    expect(await onAccountOf(f, t.transferId)).toBe('0.00');
    const audit = (await query<{ reason: string; new_values: Record<string, unknown> }>(
      `SELECT reason, new_values FROM audit_log
        WHERE entity_type = 'customer_payments' AND entity_id = $1 AND new_values ->> 'evento' = 'reverse'`, [t.transferId]
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'agreement cancelled', new_values: { evento: 'reverse', status: 'reversed' } });
    // A's receipt can be reversed again now that its credit is back.
    await reverseCustomerPayment(f.entityId, source.id, { reason: 'bounced', cause: 'taken_back' }, f.userId, { dryRun: true });
    await expectLedgerFoots(f);
  }, 180_000);

  it('S6 · ISR-WP-ADVANCES counts neither the transfer\'s 2150 credit nor its mirror\'s', async () => {
    const source = await unappliedReceipt(iso, isoA);
    const t = await transferCustomerCredit(iso.entityId, source.id, { customerId: isoB, amount: '1160.00', date: DAY, reason: REASON }, iso.userId);
    await reverseCustomerPayment(iso.entityId, t.transferId, { reason: 'agreement cancelled' }, iso.userId);
    const mirrored = (await query<{ d: string }>(
      `SELECT to_char(m.entry_date, 'YYYY-MM-DD') AS d FROM journal_entries o JOIN journal_entries m ON m.id = o.reversed_by_entry_id
        WHERE o.id = $1`, [t.journalEntry.id]
    )).rows[0].d;
    const year = Number(mirrored.slice(0, 4));
    const month = Number(mirrored.slice(5, 7));
    const wp = await buildProvisionalIncomeTaxWorkpaper({ tenantId: iso.tenantId, entityId: iso.entityId, year, month });
    // The unapply's 1,160.00 of 05-25 is the only credit to 2150 that collected anything.
    expect(wp.advancesCollected).toEqual(year === 2026 ? [{ code: '2150', amount: '1160.0000' }] : []);
  }, 180_000);
});

describe('S5 · a 16 % advance of 1,160.00 (base 1,000.00, IVA 160.00): 580.00 moves with base 500.00 and IVA 80.00', () => {
  it('B\'s application cancels 80.00, A\'s remaining 580.00 cancels only 80.00, and the IVA is caused once', async () => {
    const before = await balances(f);
    const advance = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customerA, paymentAmount: '1160.00', paymentDate: '2026-05-20',
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      f.userId
    );
    const invoiceA = await invoice(f, customerA, '2026-06-01', 'PPD');
    const invoiceB = await invoice(f, customerB, '2026-06-01', 'PPD');

    const t = await transfer(f, advance.paymentId, customerB, '580.00');
    expect(t.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['2150', '500.00', '0.00'], ['2150', '0.00', '500.00']]);
    expect(t.advance).toEqual({ base: '500.00', iva: '80.00' });
    const row = (await query<Record<string, string>>(
      `SELECT advance_factor_type AS factor, advance_tax_rate::text AS rate, advance_base_amount::text AS base,
              advance_iva_amount::text AS iva, payment_amount::text AS amount
         FROM customer_payments WHERE id = $1`, [t.transferId]
    )).rows[0];
    expect(row).toEqual({ factor: 'tasa', rate: '16.00', base: '500.0000', iva: '80.0000', amount: '580.0000' });
    expect(await onAccountOf(f, advance.paymentId)).toBe('580.00');

    await apply(f, t.transferId, invoiceB.id, '580.00', '2026-06-20');
    await apply(f, advance.paymentId, invoiceA.id, '580.00', '2026-06-20');
    const taken = (await query<{ payment_id: string; base: string; iva: string }>(
      `SELECT payment_id::text, advance_base_amount::text AS base, advance_iva_amount::text AS iva
         FROM payment_allocations WHERE payment_id = ANY($1::uuid[]) AND unapplied_at IS NULL ORDER BY payment_id = $2 DESC`,
      [[t.transferId, advance.paymentId], t.transferId]
    )).rows.map((x) => [x.payment_id, x.base, x.iva]);
    expect(taken).toEqual([[t.transferId, '500.0000', '80.0000'], [advance.paymentId, '500.0000', '80.0000']]);

    // From the setup: 2150 back to 0.00, 2120 holds the 160.00 caused in May once, 2125 the halves still owed.
    expect(await since(f, before)).toEqual({
      '1120': '-1160.00', '2120': '160.00', '2125': '160.00', '2150': '0.00', '2180': '0.00', '2181': '0.00',
    });
    // June: each half released (80.00) nets against the advance's 80.00 it cancels, and the TRF row collected nothing.
    const june = await paper(f, 6);
    expect(ivaOf(june, [t.transferId, invoiceB.id])).toBe('0.00');
    expect(ivaOf(june, [advance.paymentId, invoiceA.id])).toBe('0.00');
    expect(ivaOf(await paper(f, 5), [advance.paymentId])).toBe('160.00');
    await expectLedgerFoots(f);
  }, 240_000);
});

describe('S5 · the telescope closes across the transfer', () => {
  it('of a 16 % advance of 100.00 (IVA 13.79), 0.50 takes 0.0690 (13.79 × 0.5 / 100 = 0.06895, half up) and A\'s 99.50 the rest, 13.7210', async () => {
    const advance = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customerA, paymentAmount: '100.00', paymentDate: '2026-05-20',
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      f.userId
    );
    const t = await transfer(f, advance.paymentId, customerB, '0.50');
    const stored = (await query<{ base: string; iva: string }>(
      `SELECT advance_base_amount::text AS base, advance_iva_amount::text AS iva FROM customer_payments WHERE id = $1`, [t.transferId]
    )).rows[0];
    expect(stored).toEqual({ base: '0.4310', iva: '0.0690' });
    const invoiceA = await invoice(f, customerA, '2026-06-01', 'PPD');
    await apply(f, advance.paymentId, invoiceA.id, '99.50', '2026-06-20');
    // Read alone, 13.79 × 99.5 / 100 = 13.72105 would round to 13.7211, and the two would cancel 13.7901.
    const taken = (await query<{ iva: string }>(
      `SELECT advance_iva_amount::text AS iva FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL`,
      [advance.paymentId]
    )).rows.map((x) => x.iva);
    expect(taken).toEqual(['13.7210']);
  }, 180_000);
});

describe('S5 · a TRF\'s advance was received on its source\'s day', () => {
  it('B\'s PUE invoice of 05-10, before A\'s advance of 05-20: May declared both, so the June application says so', async () => {
    const advance = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customerA, paymentAmount: '1160.00', paymentDate: '2026-05-20',
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      f.userId
    );
    const pue = await invoice(f, customerB, '2026-05-10', 'PUE');
    const t = await transfer(f, advance.paymentId, customerB, '580.00');
    const r = await apply(f, t.transferId, pue.id, '580.00', '2026-06-20');
    expect(r.documentos[0]).toMatchObject({ advanceIva: '80.00', advanceIvaTwiceIn: '2026-05' });
  }, 180_000);
});

describe('S5 · a treated TRF reversed gives A its whole advance back', () => {
  it('A then cancels its 160.00 whole, and no month\'s paper reads the reversed TRF as a collection', async () => {
    const advance = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customerA, paymentAmount: '1160.00', paymentDate: '2026-05-20',
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16',
      },
      f.userId
    );
    const t = await transfer(f, advance.paymentId, customerB, '580.00');
    await reverseCustomerPayment(f.entityId, t.transferId, { reason: 'agreement cancelled' }, f.userId);
    expect(await onAccountOf(f, advance.paymentId)).toBe('1160.00');
    const invoiceA = await invoice(f, customerA, '2026-06-01', 'PPD');
    // The credit came back on the mirror's day (B1 of #937), so A applies it from then on.
    const mirror = (await query<{ d: string }>(
      `SELECT to_char(m.entry_date, 'YYYY-MM-DD') AS d FROM journal_entries o JOIN journal_entries m ON m.id = o.reversed_by_entry_id
        WHERE o.id = $1`, [t.journalEntry.id]
    )).rows[0].d;
    const r = await apply(f, advance.paymentId, invoiceA.id, '1160.00', mirror);
    expect(r.documentos[0]).toMatchObject({ advanceIva: '160.00' });
    const june = await paper(f, 6);
    expect(ivaOf(june, [t.transferId])).toBe('0.00');
    expect(june.findings.filter((h) => textIn(h.mensaje, 'es').includes(t.transferNumber))).toEqual([]);
  }, 180_000);
});

describe('S7 · B\'s invoice with IEPS: 2180 and 2120 end where one collection puts them', () => {
  it('apply moves 80.00 to 2180 and 172.80 to 2120; the unapply keeps both caused, the reverse is refused, and applying again nets them', async () => {
    const source = await unappliedReceipt(f, customerA, '1080.00');
    expect(await onAccountOf(f, source.id)).toBe('1252.80');
    const t = await transfer(f, source.id, customerB, '1252.80');
    const ieps = await invoice(f, customerB, '2026-06-01', 'PPD', { ieps: '80.00' });
    const before = await balances(f);
    const collected = {
      '1120': '1252.80', '2120': '172.80', '2125': '-172.80', '2150': '-1252.80', '2180': '80.00', '2181': '-80.00',
    };

    await apply(f, t.transferId, ieps.id, '1252.80', '2026-06-20');
    expect(await since(f, before)).toEqual(collected);

    await unapplyCustomerPayment(f.entityId, t.transferId, { invoiceId: ieps.id, reason: 'wrong invoice', date: '2026-06-21' }, f.userId);
    const after = await since(f, before);
    expect(after['2180']).toBe('80.00');
    expect(after['2120']).toBe('172.80');
    const e = await refusal(reverseCustomerPayment(f.entityId, t.transferId, { reason: 'agreement cancelled' }, f.userId));
    expect(e.messageKey?.key).toBe('receipt.reverse.transfer_carries_caused');
    expect(e.message).toContain(t.transferNumber);

    await apply(f, t.transferId, ieps.id, '1252.80', '2026-06-22');
    expect(await since(f, before)).toEqual(collected);
    await expectLedgerFoots(f);
  }, 240_000);
});

describe('review of #937 · B1, B2, N1, N2', () => {
  it('B1 · after its TRF is reversed, A cannot apply the returned credit before the mirror\'s day', async () => {
    const source = await unappliedReceipt(f, customerA);
    const t = await transfer(f, source.id, customerB, '1160.00');
    await reverseCustomerPayment(f.entityId, t.transferId, { reason: 'agreement cancelled' }, f.userId);
    const mirror = (await query<{ d: string }>(
      `SELECT to_char(m.entry_date, 'YYYY-MM-DD') AS d FROM journal_entries o JOIN journal_entries m ON m.id = o.reversed_by_entry_id
        WHERE o.id = $1`, [t.journalEntry.id]
    )).rows[0].d;
    const invoiceA = await invoice(f, customerA, '2026-06-01', 'PPD');
    const e = await refusal(apply(f, source.id, invoiceA.id, '1160.00', '2026-06-20'));
    expect(e.messageKey?.key).toBe('receipt.apply.date_before_last_event');
    expect(e.message).toContain(mirror);
    expect(await onAccountOf(f, source.id)).toBe('1160.00');
  }, 180_000);

  it('B2 · a reversed TRF takes no cause afterwards: it moved no money', async () => {
    const source = await unappliedReceipt(f, customerA);
    const t = await transfer(f, source.id, customerB, '1160.00');
    await reverseCustomerPayment(f.entityId, t.transferId, { reason: 'agreement cancelled' }, f.userId);
    const e = await refusal(stateReversalCause(f.entityId, t.transferId, { cause: 'not_collected', reason: 'x' }, f.userId));
    expect(e.messageKey?.key).toBe('receipt.cause.balance_transfer');
    expect(e.message).toContain(t.transferNumber);
    const row = (await query<{ cause: string | null }>(
      'SELECT reversal_cause AS cause FROM customer_payments WHERE id = $1', [t.transferId]
    )).rows[0];
    expect(row.cause).toBeNull();
  }, 180_000);

  it('N1 · --needs-rep lists a TRF applied to a stamped PPD invoice, as rep missing list does, and not one unapplied', async () => {
    const source = await unappliedReceipt(f, customerA);
    const applied = await transfer(f, source.id, customerB, '600.00');
    const idle = await transfer(f, source.id, customerB, '560.00');
    const ppd = await invoice(f, customerB, '2026-06-01', 'PPD');
    await stamp(ppd.id);
    await apply(f, applied.transferId, ppd.id, '600.00', '2026-06-20');
    const listed = (await listCustomerPayments(f.entityId, { needsRep: true, limit: 500 })).rows.map((r) => r.payment_number);
    const awaiting = (await listPaymentsAwaitingRep(query, f.entityId)).awaiting.map((p) => p.payment_number);
    expect(awaiting).toContain(applied.transferNumber);
    expect(listed).toContain(applied.transferNumber);
    expect(listed).not.toContain(idle.transferNumber);
  }, 180_000);

  it('N2 · an untreated TRF\'s own kept pool was received on its own day, not its source\'s', async () => {
    const source = await unappliedReceipt(f, customerA);
    const t = await transfer(f, source.id, customerB, '1160.00');
    const ppd = await invoice(f, customerB, '2026-06-01', 'PPD');
    const pue = await invoice(f, customerB, '2026-06-10', 'PUE');
    await apply(f, t.transferId, ppd.id, '1160.00', '2026-06-20');
    await unapplyCustomerPayment(f.entityId, t.transferId, { invoiceId: ppd.id, reason: 'wrong invoice', date: '2026-06-21' }, f.userId);
    // The pool's IVA (160.00) was caused in June, on B's application; the PUE of 06-10 caused its own in June too.
    const r = await apply(f, t.transferId, pue.id, '1160.00', '2026-07-03');
    expect(r.documentos[0]).toMatchObject({ advanceIvaTwiceIn: '2026-06' });
  }, 180_000);
});
