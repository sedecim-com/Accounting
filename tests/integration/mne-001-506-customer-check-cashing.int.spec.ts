import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import {
  recordCustomerCheckCashing, CUSTOMER_CHECK_CASHING_SOURCE,
} from '../../src/services/banking/treasury-posting.js';
import { ValidationError } from '../../src/utils/errors.js';

/**
 * MNE-001-506 (#700, part 1/4) · A CUSTOMER CHEQUE KEEPS THE DAY THE BANK CASHED IT.
 *
 * The receipt holds the bank credit that paid the cheque and that credit's
 * date, together. Until part 2 holds the IVA of a cheque back, the receipt's
 * own entry has released it, so a cashing recorded here posts no entry.
 * Receipts go through the service; only the bank lines are inserted.
 */

let mx: Fixture;
let sister: Fixture;
let customerId: string;
let account: string;
let nextGl = 0;

async function bankAccount(f: Fixture, name: string, currency = 'MXN'): Promise<string> {
  nextGl += 1;
  const gl = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, $3, 'asset', 'current_assets', $4, $5, 'debit', $6)`,
    [gl, `1110-5${nextGl}`, `Bank ${name}`, f.entityId, currency, f.userId]
  );
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, $5, 'checking')`,
    [id, f.entityId, name, gl, currency]
  );
  return id;
}

/** A line of the bank statement. */
async function bankLine(inAccount: string, date: string, amount: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, $3::date, $4, $5, 'synthetic deposit', false)`,
    [id, inAccount, date, amount, amount.startsWith('-') ? 'debit' : 'credit']
  );
  return id;
}

/** A receipt of 1,160.00 by `method` on 2026-05-30 that settles one new PPD invoice of 1,000.00 + 160.00. */
async function receipt(method = 'check', bankAccountId: string | null = account): Promise<{ id: string; invoiceId: string }> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: '2026-05-10', due_date: '2026-05-10',
    currency_code: 'MXN', terms: 'PPD', created_by: mx.userId,
    lines: [{ revenue_account_id: mx.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
  });
  const invoiceId = (await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId })).invoice.id;
  const r = await recordCustomerPayment({
    entityId: mx.entityId, counterpartyId: customerId, paymentAmount: '1160.00', paymentDate: '2026-05-30',
    paymentMethod: method, bankAccountId, applications: [{ documentId: invoiceId, amountApplied: '1160.00' }],
  }, mx.userId);
  return { id: r.paymentId, invoiceId };
}

async function cashing(id: string): Promise<{ date: string | null; tx: string | null }> {
  const r = await query<{ date: string | null; tx: string | null }>(
    'SELECT check_cashed_date::text AS date, check_cashed_tx_id AS tx FROM customer_payments WHERE id = $1', [id]
  );
  return r.rows[0];
}

async function cashingEntries(id: string) {
  const r = await query<{ id: string; date: string; period: string; lines: { role: string; debit: string | null; credit: string | null }[] }>(
    `SELECT je.id, je.entry_date::text AS date, je.fiscal_period_id AS period,
            (SELECT json_agg(json_build_object('role', ar.role, 'debit', l.debit_amount::text, 'credit', l.credit_amount::text)
                             ORDER BY l.line_number)
               FROM journal_entry_lines l
               JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
              WHERE l.journal_entry_id = je.id) AS lines
       FROM journal_entries je
      WHERE je.entity_id = $1 AND je.source_type = $2 AND je.source_id = $3`,
    [mx.entityId, CUSTOMER_CHECK_CASHING_SOURCE, id]
  );
  return r.rows;
}

const record = (id: string, transactionId: string, f: Fixture = mx, dryRun = false) =>
  recordCustomerCheckCashing(f.entityId, id, { transactionId, userId: f.userId, dryRun });

/** Refused with `key`, and the receipt still holds no cashing. */
async function refused(id: string, transactionId: string, key: string): Promise<void> {
  const error = await record(id, transactionId).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).messageKey?.key).toBe(`bank.check.cashing.refused.${key}`);
  expect(await cashing(id)).toEqual({ date: null, tx: null });
  expect(await cashingEntries(id)).toEqual([]);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-506 cheque cashing MX');
  sister = await crearEntidadHermana(mx, 'MNE-001-506 sister');
  account = await bankAccount(mx, 'Operating 506');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Cheque Payer SA', 'MXN', $4)`,
    [customerId, mx.entityId, `C-506-${customerId.slice(0, 6)}`, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a customer cheque keeps the day the bank cashed it', () => {
  it('T1 · a cheque whose receipt already released its IVA: the credit and its date are kept together, and no entry is posted', async () => {
    const { id } = await receipt();
    const credit = await bankLine(account, '2026-06-01', '1160.00');

    const rehearsal = await record(id, credit, mx, true);
    expect(rehearsal).toMatchObject({ dryRun: true, cashedOn: '2026-06-01', entryId: null });
    expect(await cashing(id)).toEqual({ date: null, tx: null });

    const r = await record(id, credit);
    expect(r).toMatchObject({
      receiptId: id, cashedOn: '2026-06-01', released: '0.0000', byInvoice: [], entryId: null, entryNumber: null,
      note: 'bank.check.cashing.note.already_released', dryRun: false,
    });
    expect(r.transaction).toMatchObject({ id: credit, date: '2026-06-01', amount: '1160.0000' });
    expect(await cashing(id)).toEqual({ date: '2026-06-01', tx: credit });
    expect(await cashingEntries(id)).toEqual([]);
    const audit = await query<{ new_values: Record<string, unknown> }>(
      `SELECT new_values FROM audit_log WHERE entity_type = 'customer_payments' AND entity_id = $1 AND legal_entity_id = $2`,
      [id, mx.entityId]
    );
    expect(audit.rows.map((x) => x.new_values)).toContainEqual(
      expect.objectContaining({ check_cashed_date: '2026-06-01', check_cashed_tx_id: credit, iva_released: '0.0000', journal_entry_id: null })
    );

    // T2 · a second recording, against the same credit or a new one.
    for (const tx of [credit, await bankLine(account, '2026-06-02', '1160.00')]) {
      const again = await record(id, tx).catch((e: unknown) => e);
      expect((again as ValidationError).messageKey?.key).toBe('bank.check.cashing.refused.already_cashed');
    }
    expect(await cashing(id)).toEqual({ date: '2026-06-01', tx: credit });

    // T2 · the credit another receipt holds as its cashing.
    await refused((await receipt()).id, credit, 'credit_used');
  });

  it('T2 · refused, nothing written: an earlier credit, another amount, a charge, another account', async () => {
    const { id } = await receipt();
    await refused(id, await bankLine(account, '2026-05-29', '1160.00'), 'credit_before_receipt');
    await refused(id, await bankLine(account, '2026-06-01', '1159.99'), 'amount_differs');
    await refused(id, await bankLine(account, '2026-06-01', '-1160.00'), 'amount_differs');
    await refused(id, await bankLine(await bankAccount(mx, 'Savings 506'), '2026-06-01', '1160.00'), 'other_account');
  });

  it('T2 · refused, nothing written: a receipt by transfer, and a reversed cheque', async () => {
    const credit = await bankLine(account, '2026-06-01', '1160.00');
    await refused((await receipt('spei')).id, credit, 'not_a_cheque');
    const bounced = await receipt();
    await reverseCustomerPayment(mx.entityId, bounced.id, { reason: 'returned unpaid', cause: 'not_collected' }, mx.userId);
    await refused(bounced.id, credit, 'not_completed');
  });

  it('T2 · another entity of the same tenant reads the receipt, and the credit, as not found', async () => {
    const { id } = await receipt();
    // The sister's own credit, so the receipt is the only thing it cannot see.
    const foreign = await bankLine(await bankAccount(sister, 'Sister 506'), '2026-06-01', '1160.00');
    await expect(record(id, foreign, sister)).rejects.toThrow(/Customer Payment .* not found/);
    await expect(record(id, foreign)).rejects.toThrow(/Bank Transaction .* not found/);
    expect(await cashing(id)).toEqual({ date: null, tx: null });
  });

  it('T2 · a receipt that names no account takes a credit of any account in its currency, and no other currency', async () => {
    const { id } = await receipt('check', null);
    await refused(id, await bankLine(await bankAccount(mx, 'Dollars 506', 'USD'), '2026-06-01', '1160.00'), 'currency_differs');
    const credit = await bankLine(account, '2026-06-03', '1160.00');
    await record(id, credit);
    expect(await cashing(id)).toEqual({ date: '2026-06-03', tx: credit });
  });

  it('T3 · the database rejects the date without the credit', async () => {
    const { id } = await receipt();
    await expect(
      query(`UPDATE customer_payments SET check_cashed_date = '2026-06-01' WHERE id = $1`, [id])
    ).rejects.toThrow(/customer_payments_check_cashing_whole/);
  });
});

/**
 * The release itself. No service leaves a cheque's IVA unreleased before
 * part 2, so the allocation is put by hand in the state part 2 will write:
 * 0 stored, which is «nothing released yet». The ledger of these receipts
 * is therefore not a real one; what is pinned is the entry the cashing posts.
 */
describe('a cashing releases what the allocation says is not released yet', () => {
  async function heldCheck(): Promise<{ id: string; invoiceId: string }> {
    const r = await receipt();
    await query('UPDATE payment_allocations SET iva_reclass_amount = 0 WHERE payment_id = $1', [r.id]);
    return r;
  }

  it('posts DR 2125 / CR 2120 on the credit\'s day, in that day\'s period, and stores it on the allocation', async () => {
    const { id, invoiceId } = await heldCheck();
    const r = await record(id, await bankLine(account, '2026-06-01', '1160.00'));
    expect(r).toMatchObject({ released: '160.0000', note: null });
    expect(r.byInvoice).toEqual([expect.objectContaining({ invoiceId, amount: '160.0000' })]);

    const entries = await cashingEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: r.entryId, date: '2026-06-01', period: mx.periodos[6] });
    expect(entries[0].lines).toEqual([
      { role: 'iva_trasladado_no_cobrado', debit: '160.0000', credit: null },
      { role: 'iva_trasladado', debit: null, credit: '160.0000' },
    ]);
    const stored = await query<{ iva: string }>('SELECT iva_reclass_amount::text AS iva FROM payment_allocations WHERE payment_id = $1', [id]);
    expect(stored.rows).toEqual([{ iva: '160.0000' }]);
  });

  it('an allocation that stores no figure counts as released: its cashing posts nothing', async () => {
    const { id } = await receipt();
    await query('UPDATE payment_allocations SET iva_reclass_amount = NULL WHERE payment_id = $1', [id]);
    const r = await record(id, await bankLine(account, '2026-06-01', '1160.00'));
    expect(r).toMatchObject({ released: '0.0000', entryId: null, note: 'bank.check.cashing.note.already_released' });
    expect(await cashingEntries(id)).toEqual([]);
  });

  it('a closed month refuses the cashing while there is IVA to post, and writes nothing', async () => {
    const { id } = await heldCheck();
    const credit = await bankLine(account, '2026-07-01', '1160.00');
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [mx.periodos[7]]);
    try {
      await refused(id, credit, 'period_closed');
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [mx.periodos[7]]);
    }
    const stored = await query<{ iva: string }>('SELECT iva_reclass_amount::text AS iva FROM payment_allocations WHERE payment_id = $1', [id]);
    expect(stored.rows).toEqual([{ iva: '0.0000' }]);
  });
});
