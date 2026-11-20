import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
} from '../../src/services/payments/payment-service.js';

/**
 * MNE-001-517 (#665) · `receipt unapply` RE-PARKS ONLY WHAT WAS PARKED.
 *
 * An allocation that stored no IVA gets a pro-rata estimate only when its
 * invoice is PPD and the entity keeps cash-basis IVA books. A PUE invoice
 * (see receipt-withholding.int.spec.ts) and an entity off Mexican books
 * re-park nothing; a stored amount is not re-parked at all since MNE-001-574,
 * which keeps it caused as stored, 0 included (MNE-001-459 stores it on every
 * new row). Every invoice
 * here is 1,000.00 + 160.00 of tax, so half of it carries 80.00.
 */

let mx: Fixture;
let us: Fixture;
let mxCustomer: string;
const DAY = '2026-08-15';
const NOTE = /pro-rata estimate/;

async function newCustomer(f: Fixture, currency: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Unapply Payer SA', $4, $5)`,
    [id, f.entityId, `C-517-${id.slice(0, 6)}`, currency, f.userId]
  );
  return id;
}

async function invoice(f: Fixture, customerId: string, currency: string, terms: string | null): Promise<string> {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: DAY, due_date: DAY,
    currency_code: currency, terms,
    lines: [{
      revenue_account_id: f.roles.ingreso, description: 'Synthetic service',
      quantity: '1', unit_price: '1000.00', tax_rate: '16.0000',
    }],
    created_by: f.userId,
  });
  return (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice.id;
}

/** Cash on account, then applied to the invoice in the given slices. */
async function collected(f: Fixture, customerId: string, invoiceId: string, slices: string[]): Promise<string> {
  const total = slices.reduce((s, x) => s + Number(x), 0).toFixed(2);
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId, counterpartyId: customerId, paymentAmount: total, paymentDate: DAY,
      paymentMethod: 'spei', applications: [], onAccount: true,
    },
    f.userId
  );
  for (const amountApplied of slices) {
    await applyCustomerPayment(f.entityId, r.paymentId, [{ documentId: invoiceId, amountApplied }], f.userId);
  }
  return r.paymentId;
}

/** What each live row of the payment stored as released IVA. */
async function storedIva(paymentId: string): Promise<(string | null)[]> {
  const r = await query<{ iva: string | null }>(
    `SELECT iva_reclass_amount::text AS iva FROM payment_allocations
      WHERE payment_id = $1 AND unapplied_at IS NULL ORDER BY iva_reclass_amount NULLS LAST`,
    [paymentId]
  );
  return r.rows.map((x) => x.iva);
}

/** Forgets the stored IVA of one live row, as a row written before migration 049. */
async function forgetIva(paymentId: string): Promise<void> {
  await query(
    `UPDATE payment_allocations SET iva_reclass_amount = NULL
      WHERE id = (SELECT id FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL LIMIT 1)`,
    [paymentId]
  );
}

async function linesOf(entryId: string): Promise<Record<string, { debit: number; credit: number; text: string }>> {
  const r = await query<{ account_id: string; debit: string; credit: string; text: string }>(
    `SELECT account_id, COALESCE(debit_amount, 0)::text AS debit, COALESCE(credit_amount, 0)::text AS credit,
            description AS text
       FROM journal_entry_lines WHERE journal_entry_id = $1`,
    [entryId]
  );
  return Object.fromEntries(
    r.rows.map((l) => [l.account_id, { debit: Number(l.debit), credit: Number(l.credit), text: l.text }])
  );
}

const unapply = (f: Fixture, paymentId: string, invoiceId: string, dryRun = false) =>
  unapplyCustomerPayment(f.entityId, paymentId, { invoiceId, reason: 'wrong invoice' }, f.userId, { dryRun });

/** The IVA pair of a Mexican unapply: DR 2120 / CR 2125 for `amount`. */
async function expectRepark(entryId: string, amount: number, estimated: boolean): Promise<void> {
  const lines = await linesOf(entryId);
  const caused = lines[mx.cuentas['2120']];
  const parked = lines[mx.cuentas['2125']];
  expect([caused.debit, caused.credit]).toEqual([amount, 0]);
  expect([parked.debit, parked.credit]).toEqual([0, amount]);
  for (const line of [caused, parked]) {
    if (estimated) expect(line.text).toMatch(NOTE);
    else expect(line.text).not.toMatch(NOTE);
  }
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-517 unapply MX');
  us = await crearInquilino('MNE-001-517 unapply US', { pais: 'US' });
  mxCustomer = await newCustomer(mx, 'MXN');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt unapply re-parks only the IVA that was parked', () => {
  it('T2 · an entity off Mexican books: the cash goes back on account and no tax line is written', async () => {
    const customerId = await newCustomer(us, 'USD');
    const invoiceId = await invoice(us, customerId, 'USD', null);
    const paymentId = await collected(us, customerId, invoiceId, ['1160.00']);

    const r = await unapply(us, paymentId, invoiceId);

    expect(await linesOf(r.journalEntry.id)).toEqual({
      [us.roles.cxc]: expect.objectContaining({ debit: 1160, credit: 0 }),
      [us.roles.anticipo_clientes]: expect.objectContaining({ debit: 0, credit: 1160 }),
    });
    expect(r.ivaReAparcado).toBe('0.0000');
    expect(r.ivaEstimado).toBe(false);
  }, 120_000);

  it('T3 · a PPD row that stored no IVA: 80.00 estimated, and the dry run and the entry say so', async () => {
    const invoiceId = await invoice(mx, mxCustomer, 'MXN', 'PPD');
    const paymentId = await collected(mx, mxCustomer, invoiceId, ['580.00']);
    await forgetIva(paymentId);

    const rehearsal = await unapply(mx, paymentId, invoiceId, true);
    expect(rehearsal.ivaReAparcado).toBe('80.0000');
    expect(rehearsal.ivaEstimado).toBe(true);
    expect(await storedIva(paymentId)).toEqual([null]); // nothing written: the row is still live

    const r = await unapply(mx, paymentId, invoiceId);
    expect(r.ivaReAparcado).toBe('80.0000');
    expect(r.ivaEstimado).toBe(true);
    await expectRepark(r.journalEntry.id, 80, true);
    expect(await storedIva(paymentId)).toEqual([]);
  }, 120_000);

  // MNE-001-574 (#792): a stored release stays caused, the cash back on account carrying it (LIVA art. 1-B).
  it('T4 · a row that stored its IVA keeps exactly that caused: 2125 takes it back, 2120 does not move', async () => {
    const invoiceId = await invoice(mx, mxCustomer, 'MXN', 'PPD');
    const paymentId = await collected(mx, mxCustomer, invoiceId, ['580.00']);
    expect(await storedIva(paymentId)).toEqual(['80.0000']);

    const r = await unapply(mx, paymentId, invoiceId);
    expect([r.ivaReAparcado, r.ivaKeptCaused, r.ivaEstimado]).toEqual(['0.0000', '80.0000', false]);
    const lines = await linesOf(r.journalEntry.id);
    expect(lines[mx.cuentas['2120']]).toBeUndefined();
    expect([lines[mx.cuentas['2125']].debit, lines[mx.cuentas['2125']].credit]).toEqual([0, 80]);
    expect(lines[mx.cuentas['2125']].text).not.toMatch(NOTE);
  }, 120_000);

  it('T5 · stored and forgotten rows on one PPD invoice: 40 kept caused, and the 40 estimated re-parked with the note', async () => {
    const invoiceId = await invoice(mx, mxCustomer, 'MXN', 'PPD');
    const paymentId = await collected(mx, mxCustomer, invoiceId, ['290.00', '290.00']);
    await forgetIva(paymentId);
    expect(await storedIva(paymentId)).toEqual(['40.0000', null]);

    const r = await unapply(mx, paymentId, invoiceId);
    expect([r.ivaReAparcado, r.ivaKeptCaused, r.ivaEstimado]).toEqual(['40.0000', '40.0000', true]);
    const lines = await linesOf(r.journalEntry.id);
    const caused = lines[mx.cuentas['2120']];
    const parked = lines[mx.cuentas['2125']];
    expect([caused.debit, caused.credit]).toEqual([40, 0]);
    expect([parked.debit, parked.credit]).toEqual([0, 80]);
    for (const line of [caused, parked]) expect(line.text).toMatch(NOTE);
  }, 120_000);

  // MNE-001-459 ended the limit T6 used to pin: this invoice parked nothing at
  // issue, so its collection released nothing, and the row now says so with a
  // stored 0 instead of a null the unapply had to estimate.
  it('T6 · a PPD release capped to 0 stores 0, and its unapply re-parks nothing', async () => {
    const invoiceId = await invoice(mx, mxCustomer, 'MXN', null); // no method: IVA caused in 2120
    await query(`UPDATE invoices SET terms = 'PPD' WHERE id = $1 AND entity_id = $2`, [invoiceId, mx.entityId]);
    const paymentId = await collected(mx, mxCustomer, invoiceId, ['580.00']);
    expect(await storedIva(paymentId)).toEqual(['0.0000']);

    const r = await unapply(mx, paymentId, invoiceId);
    expect(r.ivaReAparcado).toBe('0.0000');
    expect(r.ivaEstimado).toBe(false);
    const lines = await linesOf(r.journalEntry.id);
    expect(lines[mx.cuentas['2120']]).toBeUndefined();
    expect(lines[mx.cuentas['2125']]).toBeUndefined();
  }, 120_000);
});
