import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import bankReconciliationRouter from '../../src/api/rest/routes/bank-reconciliation.js';

// MNE-001-285: POST /bank-accounts/transactions/:id/match requires matched_amount
// (422, never a stored 0) and answers 404 when the document is another entity's.

let a: Fixture;
let b: Fixture;
let txOfA: string;
let invoiceOfA: string;
let invoiceOfB: string;

async function invoiceFor(f: Fixture): Promise<string> {
  const customer = uuidv4();
  const id = uuidv4();
  const tag = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente','MXN',$4)`,
    [customer, f.entityId, `C-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid, currency_code, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$5,1000,160,1160,1160,0,'MXN','sent',$6)`,
    [id, f.entityId, `INV-${tag}`, customer, fechaEnPeriodo(), f.userId]
  );
  return id;
}

async function post(body: Record<string, unknown>): Promise<number> {
  const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
  try {
    const r = await pedir(s, 'POST', `/v1/bank-accounts/transactions/${txOfA}/match`, body);
    return r.status;
  } finally {
    await s.cerrar();
  }
}

const rowsOfA = async (): Promise<Array<{ matched_amount: string }>> =>
  (await query<{ matched_amount: string }>(
    'SELECT matched_amount FROM reconciliation_matches WHERE bank_transaction_id = $1',
    [txOfA]
  )).rows;

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('MNE-001-285 A');
  b = await crearEntidadHermana(a, 'MNE-001-285 B');
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1,$2,'Operativa','Banco de prueba',$3,'MXN')`,
    [account, a.entityId, a.roles.banco ?? Object.values(a.cuentas)[0]]
  );
  txOfA = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, bank_transaction_id, transaction_date,
       amount, transaction_type, description)
     VALUES ($1,$2,$3,$4,1160.00,'credit','Deposito')`,
    [txOfA, account, `TX-${uuidv4().slice(0, 8)}`, fechaEnPeriodo()]
  );
  invoiceOfA = await invoiceFor(a);
  invoiceOfB = await invoiceFor(b);
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('REST manual match', () => {
  it('rejects a body without matched_amount with 422 and stores nothing', async () => {
    const status = await post({ matched_entity_type: 'invoice', matched_entity_id: invoiceOfA });
    expect(status).toBe(422);
    expect(await rowsOfA()).toHaveLength(0);
  });

  it('answers 404 for a document of another entity and stores nothing', async () => {
    const status = await post({
      matched_entity_type: 'invoice',
      matched_entity_id: invoiceOfB,
      matched_amount: '1160.00',
    });
    expect(status).toBe(404);
    expect(await rowsOfA()).toHaveLength(0);
  });

  it('answers 404 for a document that does not exist', async () => {
    const status = await post({
      matched_entity_type: 'bill',
      matched_entity_id: uuidv4(),
      matched_amount: '1160.00',
    });
    expect(status).toBe(404);
  });

  it('matches the caller own document and stores the given amount', async () => {
    const status = await post({
      matched_entity_type: 'invoice',
      matched_entity_id: invoiceOfA,
      matched_amount: '1160.00',
    });
    expect(status).toBe(200);
    const rows = await rowsOfA();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].matched_amount)).toBe(1160);
  });
});
