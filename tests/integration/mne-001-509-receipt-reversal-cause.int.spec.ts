import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, reverseCustomerPayment, getCustomerPayment, type ResultadoReversa,
} from '../../src/services/payments/payment-service.js';
import { ValidationError } from '../../src/utils/errors.js';

/**
 * MNE-001-509 (#701, part 1/3) · A REVERSED RECEIPT SAYS WHAT HAPPENED TO THE MONEY.
 *
 * `not_collected`: the money never became the firm's. `taken_back`: it
 * arrived and was taken away. The receipt keeps the cause with the instant
 * it was stated, and the audit row, the mirrors and the closed allocations
 * name it. Receipts go through the service, never through SQL.
 */

const CARD_WARNING = 'receipt.reverse.warning.card_not_collected';
const NO_CAUSE_WARNING = 'receipt.reverse.warning.cause_not_stated';

let mx: Fixture;
let us: Fixture;
let customerId: string;

async function newCustomer(f: Fixture, currency: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Reversal Payer SA', $4, $5)`,
    [id, f.entityId, `C-509-${id.slice(0, 6)}`, currency, f.userId]
  );
  return id;
}

/** A PPD invoice of 1,000.00 + 160.00, issued and posted on `date`. */
async function ppdInvoice(date = '2026-05-10'): Promise<string> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: 'PPD', created_by: mx.userId,
    lines: [{ revenue_account_id: mx.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
  });
  return (await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId })).invoice.id;
}

/** A receipt by `method` that settles one new PPD invoice each 1,160.00 (`invoices` of them), collected on `date`. */
async function collected(method: string, invoices = 1, date = '2026-05-20'): Promise<{ id: string; invoiceIds: string[] }> {
  const invoiceIds: string[] = [];
  for (let i = 0; i < invoices; i++) invoiceIds.push(await ppdInvoice(date));
  const r = await recordCustomerPayment({
    entityId: mx.entityId, counterpartyId: customerId, paymentAmount: (1160 * invoices).toFixed(2),
    paymentDate: date, paymentMethod: method,
    applications: invoiceIds.map((documentId) => ({ documentId, amountApplied: '1160.00' })),
  }, mx.userId);
  return { id: r.paymentId, invoiceIds };
}

async function stored(id: string) {
  const r = await query<{ status: string; cause: string | null; stated: Date | null; reversed: Date | null }>(
    `SELECT status, reversal_cause AS cause, reversal_cause_stated_at AS stated, reversed_at AS reversed
       FROM customer_payments WHERE id = $1`, [id]
  );
  return r.rows[0];
}

/** What the reversal wrote on each mirror and on each closed allocation. */
async function notes(id: string, r: ResultadoReversa, f: Fixture = mx): Promise<{ mirrors: string[]; allocations: string[] }> {
  const m = await query<{ description: string }>(
    'SELECT description FROM journal_entries WHERE entity_id = $1 AND entry_number = ANY($2::text[])',
    [f.entityId, r.reversals.map((x) => x.entryNumber)]
  );
  const a = await query<{ unapply_reason: string }>('SELECT unapply_reason FROM payment_allocations WHERE payment_id = $1', [id]);
  return { mirrors: m.rows.map((x) => x.description), allocations: a.rows.map((x) => x.unapply_reason) };
}

async function auditRows(id: string) {
  const r = await query<{ new_values: Record<string, unknown> }>(
    `SELECT new_values FROM audit_log WHERE entity_type = 'customer_payments' AND entity_id = $1`, [id]
  );
  return r.rows.map((x) => x.new_values);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-509 reversal cause MX');
  us = await crearInquilino('MNE-001-509 reversal cause US', { pais: 'US' });
  customerId = await newCustomer(mx, 'MXN');
  // The year before the fixture's, open: T9 reverses in the year after the collection.
  const fy = uuidv4();
  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, 2025, '2025-01-01', '2025-12-31', true, 'open')`, [fy, mx.entityId]
  );
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
     SELECT gen_random_uuid(), $1, $2, m, 'Periodo ' || m || '/2025', make_date(2025, m, 1),
            (make_date(2025, m, 1) + INTERVAL '1 month - 1 day')::date, 'open'
       FROM generate_series(1, 12) AS m`, [fy, mx.entityId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt reverse states its cause', () => {
  it('T1 · taken_back on a card: mirrors as before, and the receipt, the audit, the mirrors and the allocations carry the cause', async () => {
    const { id, invoiceIds } = await collected('credit_card');
    const r = await reverseCustomerPayment(mx.entityId, id, { reason: 'chargeback 4853', cause: 'taken_back' }, mx.userId);
    expect(r).toMatchObject({ cause: 'taken_back', causeDefaulted: false, warnings: [] });
    expect(r.reversals.length).toBe(1);
    const inv = await query<{ status: string; due: string }>('SELECT status, amount_due::text AS due FROM invoices WHERE id = $1', [invoiceIds[0]]);
    expect(inv.rows[0]).toEqual({ status: 'sent', due: '1160.0000' });

    const row = await stored(id);
    expect(row).toMatchObject({ status: 'reversed', cause: 'taken_back' });
    expect(row.stated).toEqual(row.reversed);
    expect(row.stated).not.toBeNull();
    expect(await auditRows(id)).toContainEqual(expect.objectContaining({ evento: 'reverse', status: 'reversed', reversal_cause: 'taken_back' }));
    const shown = await getCustomerPayment(mx.entityId, id);
    expect(shown.reversal_cause).toBe('taken_back');
    expect(shown.reversal_cause_stated_at).toEqual(row.stated);

    const n = await notes(id, r);
    expect(n.mirrors).toHaveLength(1);
    expect(n.allocations).toEqual(['Reversed (taken back): chargeback 4853']);
    for (const text of [...n.mirrors, ...n.allocations]) {
      expect(text).toContain('Reversed (taken back): chargeback 4853');
      expect(text).not.toContain('NSF');
    }
  });

  it('T2 · not_collected is stored; on a card the result warns, on a transfer it does not', async () => {
    const card = await collected('credit_card');
    const onCard = await reverseCustomerPayment(mx.entityId, card.id, { reason: 'never settled', cause: 'not_collected' }, mx.userId);
    expect(onCard).toMatchObject({ cause: 'not_collected', causeDefaulted: false, warnings: [CARD_WARNING] });
    expect((await stored(card.id)).cause).toBe('not_collected');

    const ach = await collected('ach');
    const onAch = await reverseCustomerPayment(mx.entityId, ach.id, { reason: 'returned', cause: 'not_collected' }, mx.userId);
    expect(onAch.warnings).toEqual([]);
    expect((await stored(ach.id)).cause).toBe('not_collected');
  });

  it('T3 · a third value is refused naming the two, and nothing is written', async () => {
    const { id } = await collected('credit_card');
    const refusal = reverseCustomerPayment(mx.entityId, id, { reason: 'x', cause: 'bounced' }, mx.userId);
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toThrow(/not_collected.*taken_back/);
    expect(await stored(id)).toMatchObject({ status: 'completed', cause: null, reversed: null });
    expect(await auditRows(id)).not.toContainEqual(expect.objectContaining({ evento: 'reverse' }));
    const mirrors = await query(
      `SELECT 1 FROM journal_entries WHERE entity_id = $1 AND source_type = 'customer_payment' AND source_id = $2 AND reversed_by_entry_id IS NOT NULL`,
      [mx.entityId, id]
    );
    expect(mirrors.rows).toHaveLength(0);
  });

  it('T4 · T5 · T6 · with no cause a cheque takes not_collected and a transfer takes none; the dry run says the same and writes nothing', async () => {
    const byCheck = await collected('check');
    const dryCheck = await reverseCustomerPayment(mx.entityId, byCheck.id, { reason: 'returned unpaid' }, mx.userId, { dryRun: true });
    expect(dryCheck).toMatchObject({ cause: 'not_collected', causeDefaulted: true, warnings: [] });
    expect(await stored(byCheck.id)).toMatchObject({ status: 'completed', cause: null });
    const onCheck = await reverseCustomerPayment(mx.entityId, byCheck.id, { reason: 'returned unpaid' }, mx.userId);
    expect(onCheck).toMatchObject({ cause: 'not_collected', causeDefaulted: true, warnings: [] });
    expect((await stored(byCheck.id)).cause).toBe('not_collected');
    expect((await notes(byCheck.id, onCheck)).allocations).toEqual(['Reversed (not collected): returned unpaid']);

    const ach = await collected('ach');
    const dryAch = await reverseCustomerPayment(mx.entityId, ach.id, { reason: 'recalled' }, mx.userId, { dryRun: true });
    expect(dryAch).toMatchObject({ cause: null, causeDefaulted: false, warnings: [NO_CAUSE_WARNING] });
    expect(await stored(ach.id)).toMatchObject({ status: 'completed', cause: null });
    const onAch = await reverseCustomerPayment(mx.entityId, ach.id, { reason: 'recalled' }, mx.userId);
    expect(onAch).toMatchObject({ cause: null, causeDefaulted: false, warnings: [NO_CAUSE_WARNING] });
    expect(await stored(ach.id)).toMatchObject({ status: 'reversed', cause: null, stated: null });
    const n = await notes(ach.id, onAch);
    expect(n.allocations).toEqual(['Reversed (cause not stated): recalled']);
    expect(n.mirrors[0]).toContain('Reversed (cause not stated): recalled');

    const card = await collected('credit_card');
    const dryCard = await reverseCustomerPayment(mx.entityId, card.id, { reason: 'chargeback', cause: 'taken_back' }, mx.userId, { dryRun: true });
    expect(dryCard).toMatchObject({ cause: 'taken_back', causeDefaulted: false, warnings: [] });
    expect(await stored(card.id)).toMatchObject({ status: 'completed', cause: null });
    expect(await auditRows(card.id)).not.toContainEqual(expect.objectContaining({ evento: 'reverse' }));
  });

  it('T7 · the database ties the cause to its date, to its two values and to a reversed receipt', async () => {
    const { id } = await collected('ach');
    const write = (set: string) => query(`UPDATE customer_payments SET ${set} WHERE id = $1`, [id]);
    await expect(write(`reversal_cause = 'taken_back', reversal_cause_stated_at = NOW()`))
      .rejects.toThrow(/customer_payments_reversal_cause_only_reversed/);
    await expect(write(`status = 'reversed', reversed_at = NOW(), reversal_cause = 'taken_back'`))
      .rejects.toThrow(/customer_payments_reversal_cause_dated/);
    await expect(write(`status = 'reversed', reversed_at = NOW(), reversal_cause = 'bounced', reversal_cause_stated_at = NOW()`))
      .rejects.toThrow(/customer_payments_reversal_cause_known/);
    expect(await stored(id)).toMatchObject({ status: 'completed', cause: null });
  });

  it('T8 · the write refuses a receipt whose status changed under it', async () => {
    const { id } = await collected('ach');
    const race = withTransaction(async (client) => {
      // The harness cannot run two sessions past the row lock, so the status
      // changes on this same transaction right before the guarded write.
      const staged = Object.create(client) as pg.PoolClient;
      staged.query = (async (text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && text.includes(`SET status = 'reversed'`)) {
          await client.query(`UPDATE customer_payments SET status = 'void' WHERE id = $1`, [id]);
        }
        return (client.query as (...a: unknown[]) => unknown)(text, ...rest);
      }) as pg.PoolClient['query'];
      return reverseCustomerPayment(mx.entityId, id, { reason: 'race', cause: 'taken_back' }, mx.userId, { client: staged });
    });
    await expect(race).rejects.toMatchObject({ code: 'REVERSE_RACE' });
    expect(await stored(id)).toMatchObject({ status: 'completed', cause: null });
  });

  it('T9 · a receipt over two invoices, collected last year: one cause on the receipt, and both allocations name it', async () => {
    const { id, invoiceIds } = await collected('credit_card', 2, '2025-12-15');
    const r = await reverseCustomerPayment(mx.entityId, id, { reason: 'chargeback', cause: 'taken_back' }, mx.userId);
    expect(r.documentosReabiertos.map((d) => d.id).sort()).toEqual([...invoiceIds].sort());
    const row = await stored(id);
    expect(row.cause).toBe('taken_back');
    expect(row.stated!.getUTCFullYear()).toBeGreaterThan(2025);
    expect((await notes(id, r)).allocations).toEqual(Array(2).fill('Reversed (taken back): chargeback'));
  });

  it('T10 · an entity that does not keep Mexican books stores the cause the same way', async () => {
    const payer = await newCustomer(us, 'USD');
    const rec = await recordCustomerPayment({
      entityId: us.entityId, counterpartyId: payer, paymentAmount: '500.00', paymentDate: '2026-05-20',
      paymentMethod: 'wire', currencyCode: 'USD', applications: [], onAccount: true,
    }, us.userId);
    const r = await reverseCustomerPayment(us.entityId, rec.paymentId, { reason: 'recalled by the bank', cause: 'taken_back' }, us.userId);
    expect(r).toMatchObject({ cause: 'taken_back', causeDefaulted: false, warnings: [] });
    expect(await stored(rec.paymentId)).toMatchObject({ status: 'reversed', cause: 'taken_back' });
    expect((await notes(rec.paymentId, r, us)).mirrors[0]).toContain('Reversed (taken back): recalled by the bank');

    // The no-cause warning speaks of the IVA paper, which these books do not have.
    const again = await recordCustomerPayment({
      entityId: us.entityId, counterpartyId: payer, paymentAmount: '500.00', paymentDate: '2026-05-21',
      paymentMethod: 'wire', currencyCode: 'USD', applications: [], onAccount: true,
    }, us.userId);
    const bare = await reverseCustomerPayment(us.entityId, again.paymentId, { reason: 'recalled' }, us.userId);
    expect(bare).toMatchObject({ cause: null, causeDefaulted: false, warnings: [] });
    expect(await stored(again.paymentId)).toMatchObject({ status: 'reversed', cause: null });
  });
});
