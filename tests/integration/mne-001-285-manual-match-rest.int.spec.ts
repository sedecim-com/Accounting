import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { MATCHED_ENTITY_TYPES } from '../../src/database/enums.js';
import bankReconciliationRouter from '../../src/api/rest/routes/bank-reconciliation.js';

// MNE-001-285: POST /bank-accounts/transactions/:id/match requires matched_amount
// (a positive decimal, 422 otherwise, never a stored 0), answers 404 when the document
// is another entity's (all five document kinds), seals the movement (409 on a second
// match) and flags a partial match.

type Kind = (typeof MATCHED_ENTITY_TYPES)[number];

let a: Fixture;
let b: Fixture;
let account: string;

async function customerFor(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente','MXN',$4)`,
    [id, f.entityId, `C-${uuidv4().slice(0, 8)}`, f.userId]
  );
  return id;
}

async function vendorFor(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor','MXN',$4)`,
    [id, f.entityId, `V-${uuidv4().slice(0, 8)}`, f.userId]
  );
  return id;
}

/** One document of each matchable kind, owned by `f`. */
async function documentsFor(f: Fixture): Promise<Record<Kind, string>> {
  const tag = uuidv4().slice(0, 8);
  const customer = await customerFor(f);
  const vendor = await vendorFor(f);
  const ids = { invoice: uuidv4(), bill: uuidv4(), customer_payment: uuidv4(), vendor_payment: uuidv4(), journal_entry_line: uuidv4() };
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid, currency_code, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$5,1000,160,1160,1160,0,'MXN','sent',$6)`,
    [ids.invoice, f.entityId, `INV-${tag}`, customer, fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, bill_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid, currency_code, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$5,1000,160,1160,1160,0,'MXN','approved',$6)`,
    [ids.bill, f.entityId, `B-${tag}`, vendor, fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount,
       currency_code, payment_method, payment_date, created_by)
     VALUES ($1,$2,$3,$4,1160,'MXN','wire',$5,$6)`,
    [ids.customer_payment, f.entityId, `CP-${tag}`, customer, fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
       currency_code, payment_method, payment_date, created_by)
     VALUES ($1,$2,$3,$4,1160,'MXN','wire',$5,$6)`,
    [ids.vendor_payment, f.entityId, `VP-${tag}`, vendor, fechaEnPeriodo(), f.userId]
  );
  const je = uuidv4();
  await query(
    `INSERT INTO journal_entries (id, entry_number, entry_type, entity_id, fiscal_period_id, entry_date, created_by)
     VALUES ($1,$2,'standard',$3,$4,$5,$6)`,
    [je, `JE-${tag}`, f.entityId, f.periodos[9] ?? Object.values(f.periodos)[0], fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit_amount)
     VALUES ($1,$2,1,$3,1160)`,
    [ids.journal_entry_line, je, Object.values(f.cuentas)[0]]
  );
  return ids;
}

async function newTx(amount = '1160.00'): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, bank_transaction_id, transaction_date,
       amount, transaction_type, description)
     VALUES ($1,$2,$3,$4,$5,'credit','Deposito')`,
    [id, account, `TX-${uuidv4().slice(0, 8)}`, fechaEnPeriodo(), amount]
  );
  return id;
}

async function post(tx: string, body: Record<string, unknown>): Promise<number> {
  const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
  try {
    const r = await pedir(s, 'POST', `/v1/bank-accounts/transactions/${tx}/match`, body);
    return r.status;
  } finally {
    await s.cerrar();
  }
}

const rowsOf = async (tx: string): Promise<Array<{ matched_amount: string; is_partial: boolean }>> =>
  (await query<{ matched_amount: string; is_partial: boolean }>(
    'SELECT matched_amount, is_partial FROM reconciliation_matches WHERE bank_transaction_id = $1',
    [tx]
  )).rows;

let docsA: Record<Kind, string>;
let docsB: Record<Kind, string>;

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('MNE-001-285 A');
  b = await crearEntidadHermana(a, 'MNE-001-285 B');
  account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1,$2,'Operativa','Banco de prueba',$3,'MXN')`,
    [account, a.entityId, a.roles.banco ?? Object.values(a.cuentas)[0]]
  );
  docsA = await documentsFor(a);
  docsB = await documentsFor(b);
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('REST manual match', () => {
  it('rejects a body without matched_amount with 422 and stores nothing', async () => {
    const tx = await newTx();
    expect(await post(tx, { matched_entity_type: 'invoice', matched_entity_id: docsA.invoice })).toBe(422);
    expect(await rowsOf(tx)).toHaveLength(0);
  });

  it.each(['', 'abc', 'NaN', '1e400', 1e30, -5, '-5', 0, '0', '0.00', '1.23456', null])(
    'rejects matched_amount %j with 422 and stores nothing (never a 500, NaN, negative or zero row)',
    async (junk) => {
      const tx = await newTx();
      const status = await post(tx, { matched_entity_type: 'invoice', matched_entity_id: docsA.invoice, matched_amount: junk });
      expect(status).toBe(422);
      expect(await rowsOf(tx)).toHaveLength(0);
    }
  );

  it.each(MATCHED_ENTITY_TYPES)('answers 404 for a %s of another entity and stores nothing', async (kind) => {
    const tx = await newTx();
    const status = await post(tx, { matched_entity_type: kind, matched_entity_id: docsB[kind], matched_amount: '1160.00' });
    expect(status).toBe(404);
    expect(await rowsOf(tx)).toHaveLength(0);
  });

  it('answers 404 for a document that does not exist', async () => {
    const tx = await newTx();
    expect(await post(tx, { matched_entity_type: 'bill', matched_entity_id: uuidv4(), matched_amount: '1160.00' })).toBe(404);
  });

  it.each(MATCHED_ENTITY_TYPES)('matches the caller own %s and stores the given amount', async (kind) => {
    const tx = await newTx();
    expect(await post(tx, { matched_entity_type: kind, matched_entity_id: docsA[kind], matched_amount: '1160.00' })).toBe(200);
    const rows = await rowsOf(tx);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].matched_amount)).toBe(1160);
    expect(rows[0].is_partial).toBe(false);
  });

  it('accepts the number form and flags a partial match', async () => {
    const tx = await newTx();
    expect(await post(tx, { matched_entity_type: 'invoice', matched_entity_id: docsA.invoice, matched_amount: 500.5 })).toBe(200);
    const rows = await rowsOf(tx);
    expect(Number(rows[0].matched_amount)).toBe(500.5);
    expect(rows[0].is_partial).toBe(true);
  });

  it('refuses an amount larger than the bank transaction with 422 and stores nothing', async () => {
    const tx = await newTx('100.00');
    expect(await post(tx, { matched_entity_type: 'invoice', matched_entity_id: docsA.invoice, matched_amount: '100.01' })).toBe(422);
    expect(await rowsOf(tx)).toHaveLength(0);
  });

  it('answers 409 to a second match of the same transaction and keeps one row', async () => {
    const tx = await newTx();
    const body = { matched_entity_type: 'invoice', matched_entity_id: docsA.invoice, matched_amount: '10.00' };
    expect(await post(tx, body)).toBe(200);
    expect(await post(tx, body)).toBe(409);
    expect(await rowsOf(tx)).toHaveLength(1);
  });
});
