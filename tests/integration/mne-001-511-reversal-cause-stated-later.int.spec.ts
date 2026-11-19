import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, reverseCustomerPayment, getCustomerPayment, stateReversalCause,
} from '../../src/services/payments/payment-service.js';
import { NotFoundError, ValidationError } from '../../src/utils/errors.js';

/**
 * MNE-001-511 (#701, part 3/3) · THE CAUSE OF A REVERSAL, STATED AFTERWARDS.
 *
 * A receipt reversed with no cause gets one later: written once with the
 * instant of the statement, audited, and posting nothing. What MNE-001-510
 * will read is `reversal_cause_stated_at > reversed_at`. Receipts and
 * reversals go through the service; no figure is computed here, the tests
 * assert that none moves.
 */

const CARD_WARNING = 'receipt.reverse.warning.card_not_collected';

let mx: Fixture;
let us: Fixture;
let customerId: string;

async function newCustomer(f: Fixture, currency: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Late Cause Payer SA', $4, $5)`,
    [id, f.entityId, `C-511-${id.slice(0, 6)}`, currency, f.userId]
  );
  return id;
}

/** A PPD invoice of 1,000.00 + 160.00 collected whole by `method` on 2026-05-20, and reversed (with `cause`, or with none). */
async function reversed(method = 'ach', cause?: string): Promise<{ id: string; invoiceId: string }> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: '2026-05-10', due_date: '2026-05-10',
    currency_code: 'MXN', terms: 'PPD', created_by: mx.userId,
    lines: [{ revenue_account_id: mx.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
  });
  const invoiceId = (await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId })).invoice.id;
  const r = await recordCustomerPayment({
    entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '1160.00',
    paymentDate: '2026-05-20', paymentMethod: method,
    applications: [{ documentId: invoiceId, amountApplied: '1160.00' }],
  }, mx.userId);
  await reverseCustomerPayment(mx.entityId, r.paymentId, { reason: 'returned by the bank', cause }, mx.userId);
  return { id: r.paymentId, invoiceId };
}

async function stored(id: string) {
  const r = await query<{ status: string; cause: string | null; stated: Date | null; reversed: Date | null }>(
    `SELECT status, reversal_cause AS cause, reversal_cause_stated_at AS stated, reversed_at AS reversed
       FROM customer_payments WHERE id = $1`, [id]
  );
  return r.rows[0];
}

async function auditRows(id: string) {
  const r = await query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string | null }>(
    `SELECT old_values, new_values, reason FROM audit_log
      WHERE entity_type = 'customer_payments' AND entity_id = $1 AND new_values->>'evento' = 'state_reversal_cause'`, [id]
  );
  return r.rows;
}

async function entryCount(f: Fixture): Promise<number> {
  const r = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM journal_entries WHERE entity_id = $1', [f.entityId]);
  return r.rows[0].n;
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-511 late cause MX');
  us = await crearInquilino('MNE-001-511 late cause US', { pais: 'US' });
  customerId = await newCustomer(mx, 'MXN');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt cause record states afterwards the cause of a receipt reversed with none', () => {
  it('S1 · taken_back with a reason: written once with its instant, audited, and nothing posts or moves', async () => {
    const { id, invoiceId } = await reversed();
    const before = await stored(id);
    expect(before).toMatchObject({ status: 'reversed', cause: null, stated: null });
    const entries = await entryCount(mx);

    const r = await stateReversalCause(mx.entityId, id, { cause: 'taken_back', reason: 'disputed after it was paid' }, mx.userId);
    expect(r).toMatchObject({ paymentId: id, cause: 'taken_back', warnings: [] });

    const row = await stored(id);
    expect(row).toMatchObject({ status: 'reversed', cause: 'taken_back', reversed: before.reversed });
    expect(row.stated!.getTime()).toBeGreaterThan(row.reversed!.getTime());
    expect(r.statedAt).toEqual(row.stated);
    expect(await entryCount(mx)).toBe(entries);
    const inv = await query<{ status: string; due: string }>('SELECT status, amount_due::text AS due FROM invoices WHERE id = $1', [invoiceId]);
    expect(inv.rows[0]).toEqual({ status: 'sent', due: '1160.0000' });
    const alloc = await query<{ unapply_reason: string }>('SELECT unapply_reason FROM payment_allocations WHERE payment_id = $1', [id]);
    expect(alloc.rows.map((a) => a.unapply_reason)).toEqual(['Reversed (cause not stated): returned by the bank']);

    const audit = await auditRows(id);
    expect(audit).toHaveLength(1);
    expect(audit[0].old_values).toEqual({ reversal_cause: null });
    expect(audit[0].new_values).toMatchObject({ reversal_cause: 'taken_back' });
    expect(new Date(audit[0].new_values.reversal_cause_stated_at as string)).toEqual(row.stated);
    expect(audit[0].reason).toBe('disputed after it was paid');

    const shown = await getCustomerPayment(mx.entityId, id);
    expect(shown.reversal_cause).toBe('taken_back');
    expect(shown.reversal_cause_stated_at).toEqual(row.stated);
  });

  it('S2 · a second statement, and a receipt reversed with its cause: refused naming the stored cause, nothing changes', async () => {
    const { id } = await reversed();
    await stateReversalCause(mx.entityId, id, { cause: 'taken_back', reason: 'first' }, mx.userId);
    const first = await stored(id);
    const again = stateReversalCause(mx.entityId, id, { cause: 'not_collected', reason: 'second thoughts' }, mx.userId);
    await expect(again).rejects.toBeInstanceOf(ValidationError);
    await expect(again).rejects.toThrow(/taken_back/);
    expect(await stored(id)).toEqual(first);
    expect(await auditRows(id)).toHaveLength(1);

    const withCause = await reversed('credit_card', 'not_collected');
    const atReversal = await stored(withCause.id);
    await expect(stateReversalCause(mx.entityId, withCause.id, { cause: 'taken_back', reason: 'late' }, mx.userId))
      .rejects.toThrow(/not_collected/);
    expect(await stored(withCause.id)).toEqual(atReversal);
    expect(await auditRows(withCause.id)).toHaveLength(0);
  });

  it('S3 · a receipt that is not reversed is refused, and keeps no cause', async () => {
    const r = await recordCustomerPayment({
      entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '300.00', paymentDate: '2026-05-21',
      paymentMethod: 'ach', applications: [], onAccount: true,
    }, mx.userId);
    await expect(stateReversalCause(mx.entityId, r.paymentId, { cause: 'taken_back', reason: 'too early' }, mx.userId))
      .rejects.toBeInstanceOf(ValidationError);
    expect(await stored(r.paymentId)).toMatchObject({ status: 'completed', cause: null, stated: null });
    expect(await auditRows(r.paymentId)).toHaveLength(0);
  });

  it('S4 · read from another entity, the receipt does not exist', async () => {
    const { id } = await reversed();
    await expect(stateReversalCause(us.entityId, id, { cause: 'taken_back', reason: 'not mine' }, us.userId))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(await stored(id)).toMatchObject({ status: 'reversed', cause: null, stated: null });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('S5 · the dry run answers as the real run and writes neither the columns nor the audit row', async () => {
    const { id } = await reversed();
    const r = await stateReversalCause(mx.entityId, id, { cause: 'taken_back', reason: 'looking first' }, mx.userId, { dryRun: true });
    expect(r).toMatchObject({ paymentId: id, cause: 'taken_back', warnings: [] });
    expect(r.statedAt).toBeInstanceOf(Date);
    expect(await stored(id)).toMatchObject({ status: 'reversed', cause: null, stated: null });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('S6 · a cause outside the two is refused naming both; not_collected warns on a card and not on a transfer', async () => {
    const ach = await reversed();
    const bounced = stateReversalCause(mx.entityId, ach.id, { cause: 'bounced', reason: 'typo' }, mx.userId);
    await expect(bounced).rejects.toBeInstanceOf(ValidationError);
    await expect(bounced).rejects.toThrow(/not_collected.*taken_back/);
    expect(await stored(ach.id)).toMatchObject({ cause: null, stated: null });

    const quiet = await stateReversalCause(mx.entityId, ach.id, { cause: 'not_collected', reason: 'returned unpaid' }, mx.userId);
    expect(quiet.warnings).toEqual([]);
    const card = await reversed('credit_card');
    const warned = await stateReversalCause(mx.entityId, card.id, { cause: 'not_collected', reason: 'declined' }, mx.userId);
    expect(warned.warnings).toEqual([CARD_WARNING]);
    expect(await stored(card.id)).toMatchObject({ cause: 'not_collected' });
  });

  it('S7 · the write refuses a receipt that got a cause under it', async () => {
    const { id } = await reversed();
    const race = withTransaction(async (client) => {
      // The harness cannot run two sessions past the row lock, so the cause
      // appears on this same transaction right before the guarded write.
      const staged = Object.create(client) as pg.PoolClient;
      staged.query = (async (text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && text.includes('SET reversal_cause = $3')) {
          await client.query(
            `UPDATE customer_payments SET reversal_cause = 'not_collected', reversal_cause_stated_at = NOW() WHERE id = $1`, [id]
          );
        }
        return (client.query as (...a: unknown[]) => unknown)(text, ...rest);
      }) as pg.PoolClient['query'];
      return stateReversalCause(mx.entityId, id, { cause: 'taken_back', reason: 'race' }, mx.userId, { client: staged });
    });
    await expect(race).rejects.toMatchObject({ code: 'REVERSAL_CAUSE_RACE' });
    expect(await stored(id)).toMatchObject({ status: 'reversed', cause: null, stated: null });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('S8 · a cheque left with no cause, and an entity off Mexican books, both accept the statement', async () => {
    // A cheque reversed before migration 327 has no cause: staged by SQL, since the service gives a cheque its default.
    const byCheck = await reversed('check');
    await query('UPDATE customer_payments SET reversal_cause = NULL, reversal_cause_stated_at = NULL WHERE id = $1', [byCheck.id]);
    const r = await stateReversalCause(mx.entityId, byCheck.id, { cause: 'not_collected', reason: 'returned for funds' }, mx.userId);
    expect(r).toMatchObject({ cause: 'not_collected', warnings: [] });
    expect(await stored(byCheck.id)).toMatchObject({ status: 'reversed', cause: 'not_collected' });

    const payer = await newCustomer(us, 'USD');
    const rec = await recordCustomerPayment({
      entityId: us.entityId, counterpartyId: payer, paymentAmount: '500.00', paymentDate: '2026-05-20',
      paymentMethod: 'wire', currencyCode: 'USD', applications: [], onAccount: true,
    }, us.userId);
    await reverseCustomerPayment(us.entityId, rec.paymentId, { reason: 'recalled' }, us.userId);
    const abroad = await stateReversalCause(us.entityId, rec.paymentId, { cause: 'taken_back', reason: 'recalled by the bank' }, us.userId);
    expect(abroad).toMatchObject({ cause: 'taken_back', warnings: [] });
    expect(await stored(rec.paymentId)).toMatchObject({ status: 'reversed', cause: 'taken_back' });
  });
});
