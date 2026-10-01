import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { olvidarAlcances, entityScope } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { findBestMatch } from '../../src/services/banking/matching.js';
import bankReconciliationRouter from '../../src/api/rest/routes/bank-reconciliation.js';

// MNE-001-284 (#97): the shared auto-match engine compared |amount| only, so a
// -1,160 bank charge was auto-applied to a 1,160 receivable of the same day.
// A deposit may only match AR (invoices); a charge may only match AP (bills).

let f: Fixture;
let account: string;
const date = () => fechaEnPeriodo();

async function invoice(total: string): Promise<string> {
  const id = uuidv4();
  const cust = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente','MXN',$4)`,
    [cust, f.entityId, `C-${cust.slice(0, 8)}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid, currency_code, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$5,1000,160,$6,$6,0,'MXN','sent',$7)`,
    [id, f.entityId, `INV-${id.slice(0, 8)}`, cust, date(), total, f.userId]
  );
  return id;
}

async function bill(total: string): Promise<string> {
  const id = uuidv4();
  const vendor = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
       payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [vendor, f.entityId, `V-${vendor.slice(0, 8)}`, f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,1000,160,$5,$5,'MXN',$6,$6,'approved',$7)`,
    [id, f.entityId, `BILL-${id.slice(0, 8)}`, vendor, total, date(), f.userId]
  );
  return id;
}

function bankGl(): string {
  return f.roles.banco ?? Object.values(f.cuentas)[0];
}

// A posted entry with a DEBIT on the bank's GL account (a deposit booked in the books).
async function bankDebitLine(amount: string): Promise<string> {
  const id = uuidv4();
  const other = Object.values(f.cuentas).find((c) => c !== bankGl())!;
  await query(
    `INSERT INTO journal_entries (id, entry_number, entry_type, entity_id, fiscal_period_id,
       entry_date, posted_date, status, total_debits, total_credits, description, created_by, posted_by)
     VALUES ($1, $2, 'standard', $3, $4, $5::date, $5::date, 'posted', $6, $6, 'Deposit in books', $7, $7)`,
    [id, `DIR-${id.slice(0, 8)}`, f.entityId, f.periodos[8], date(), amount, f.userId]
  );
  const line = await query<{ id: string }>(
    `INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_amount, credit_amount)
     VALUES ($1, 1, $2, $3, NULL), ($1, 2, $4, NULL, $3) RETURNING id`,
    [id, bankGl(), amount, other]
  );
  return line.rows[0].id;
}

async function bankTx(amount: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, bank_transaction_id, transaction_date,
       amount, transaction_type, description, is_matched)
     VALUES ($1,$2,$3,$4,$5::numeric,$6,'Movimiento',false)`,
    [id, account, `TX-${id.slice(0, 8)}`, date(), amount, Number(amount) < 0 ? 'debit' : 'credit']
  );
  return id;
}

async function best(txId: string): Promise<string | undefined> {
  const tx = await query('SELECT * FROM bank_transactions WHERE id = $1', [txId]);
  const r = await findBestMatch(account, tx.rows[0] as never, entityScope(f.tenantId, f.entityId));
  return r?.match_id;
}

async function autoMatch(): Promise<number> {
  const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(f));
  try {
    const r = await pedir(s, 'POST', `/v1/bank-accounts/${account}/auto-match`);
    expect(r.status).toBe(200);
    return (r.body.data as { matched: number }).matched;
  } finally {
    await s.cerrar();
  }
}

async function reset(): Promise<void> {
  await query('DELETE FROM reconciliation_matches WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE bank_account_id = $1)', [account]);
  await query('DELETE FROM bank_transactions WHERE bank_account_id = $1', [account]);
  await query(`UPDATE invoices SET status = 'paid' WHERE entity_id = $1`, [f.entityId]);
  await query(`UPDATE bills SET status = 'paid' WHERE entity_id = $1`, [f.entityId]);
}

beforeAll(async () => {
  olvidarAlcances();
  f = await crearInquilino('MNE-001-284 match direction');
  account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1,$2,'Operativa','Banco de prueba',$3,'MXN')`,
    [account, f.entityId, bankGl()]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('MNE-001-284 · the match direction is part of the match', () => {
  it('a -1,160 charge is not auto-applied to a 1,160 receivable of the same day (REST)', async () => {
    await reset();
    const inv = await invoice('1160.00');
    const tx = await bankTx('-1160.00');
    expect(await autoMatch()).toBe(0);
    const row = await query<{ is_matched: boolean }>(
      'SELECT is_matched FROM bank_transactions WHERE id = $1',
      [tx]
    );
    expect(row.rows[0].is_matched).toBe(false);
    expect(await best(tx)).not.toBe(inv);
  });

  it('a +1,160 deposit is not matched to a 1,160 payable, but is to the receivable', async () => {
    await reset();
    const b = await bill('1160.00');
    const tx = await bankTx('1160.00');
    expect(await best(tx)).not.toBe(b);
    const inv = await invoice('1160.00');
    expect(await best(tx)).toBe(inv);
  });

  it('a -1,160 charge still matches a 1,160 payable', async () => {
    await reset();
    const b = await bill('1160.00');
    const tx = await bankTx('-1160.00');
    expect(await best(tx)).toBe(b);
  });

  it('a -2,230 charge is not auto-applied to a DEBIT book line on the bank account (REST)', async () => {
    await reset();
    await bankDebitLine('2230.00');
    const tx = await bankTx('-2230.00');
    expect(await best(tx)).toBeUndefined();
    expect(await autoMatch()).toBe(0);
    const row = await query<{ is_matched: boolean }>(
      'SELECT is_matched FROM bank_transactions WHERE id = $1',
      [tx]
    );
    expect(row.rows[0].is_matched).toBe(false);
  });

  it('a +2,230 deposit still matches the DEBIT book line on the bank account', async () => {
    await reset();
    const tx = await bankTx('2230.00');
    const line = await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE account_id = $1 AND debit_amount = 2230`,
      [bankGl()]
    );
    expect(await best(tx)).toBe(line.rows[0].id);
  });
});
