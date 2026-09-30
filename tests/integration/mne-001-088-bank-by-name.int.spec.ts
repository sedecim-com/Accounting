import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createCustomer } from '../../src/services/ar/customer-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createVendor } from '../../src/services/ap/vendor-service.js';
import { createBill, approveBill } from '../../src/services/ap/bill-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { recordVendorPayment, recordCustomerPayment } from '../../src/services/payments/payment-service.js';

// ============================================================
// MNE-001-088 (#327) · `--bank` ACCEPTS THE ACCOUNT NAME.
//
// `payment create --bank "<name>"` handed the name straight to the INSERT
// and the operator read Postgres' "invalid input syntax for type uuid". The
// same flag on `receipt record` did the same. Worse, a well-formed uuid of an
// account that is not this entity's was never checked by the CLI: it reached
// the service, which silently fell back to the `banco` role.
//
// Both leaves now resolve `--bank` the way every `bank` leaf resolves
// `--account`: by id or by name, scoped to the entity inside the SQL.
// ============================================================

let f: Fixture;
let other: Fixture;
let customerId: string;
let vendorId: string;
let bankId: string;
let foreignBankId: string;
let exactBankId: string;

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

async function run(argv: string[]): Promise<{ exitCode?: number; err: string }> {
  let exitCode: number | undefined;
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    const deps = {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
    };
    registerReceiptCommand(p, deps);
    registerPaymentCommands(p, deps);
    try {
      await p.parseAsync(['node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId, '-y']);
    } catch (e) {
      err.push(`${(e as Error).message}\n`);
      exitCode = exitCodeFor(e);
    }
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, err: err.join('') };
}

async function bankAccount(
  fixture: Fixture, name: string, currency = 'MXN', active = true
): Promise<string> {
  // Each bank account owns its GL account (uq_bank_accounts_gl): the first one
  // takes the `banco` role's, the rest get a subaccount of their own.
  const taken = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM bank_accounts WHERE entity_id = $1', [fixture.entityId]
  );
  let gl = fixture.roles.banco;
  if (taken.rows[0].n !== '0') {
    gl = uuidv4();
    await query(
      `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, normal_balance, created_by)
       VALUES ($1, $2, $3, 'asset', 'current_assets', $4, 'debit', $5)`,
      [gl, `11${taken.rows[0].n.padStart(2, '0')}9`, `Banco ${name}`, fixture.entityId, fixture.userId]
    );
  }
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
     VALUES ($1, $2, $3, 'BBVA', $4, $5, $6)`,
    [id, fixture.entityId, name, gl, currency, active]
  );
  return id;
}

async function approvedBill(): Promise<string> {
  const bill = await createBill({
    entity_id: f.entityId, vendor_id: vendorId, created_by: f.userId,
    bill_date: '2026-07-10', due_date: '2026-08-10', currency_code: 'MXN',
    lines: [{
      account_id: f.cuentas['6100'], description: 'Refacciones',
      quantity: '1', unit_price: '8000.00', tax_amount: '1280.00',
    }],
  });
  await approveBill(bill.id, f.userId, { entityId: f.entityId });
  return bill.bill_number;
}

async function issuedInvoice(): Promise<string> {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, created_by: f.userId,
    invoice_date: '2026-07-15', due_date: '2026-08-15', currency_code: 'MXN',
    lines: [{
      description: 'Servicios', quantity: '1', unit_price: '10000.00',
      tax_rate: '16', revenue_account_id: f.cuentas['4100'],
    }],
  });
  await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  const r = await query<{ invoice_number: string }>(
    'SELECT invoice_number FROM invoices WHERE id = $1', [draft.id]
  );
  return r.rows[0].invoice_number;
}

const billPayments = async (docNumber: string) =>
  (await query<{ bank_account_id: string | null }>(
    `SELECT vp.bank_account_id
       FROM vendor_payments vp
       JOIN payment_applications pa ON pa.payment_id = vp.id
       JOIN bills b ON b.id = pa.bill_id
      WHERE b.bill_number = $1 AND vp.entity_id = $2`,
    [docNumber, f.entityId]
  )).rows;

const invoicePayments = async (docNumber: string) =>
  (await query<{ bank_account_id: string | null }>(
    `SELECT cp.bank_account_id
       FROM customer_payments cp
       JOIN payment_allocations pa ON pa.payment_id = cp.id
       JOIN invoices i ON i.id = pa.invoice_id
      WHERE i.invoice_number = $1 AND cp.entity_id = $2`,
    [docNumber, f.entityId]
  )).rows;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-088 · --bank by name');
  other = await crearInquilino('MNE-001-088 · another tenant');
  const customer = await createCustomer({
    entity_id: f.entityId, company_name: 'Grupo Alameda SA de CV',
    tax_id: 'XAXX010101000', currency_code: 'MXN', created_by: f.userId,
  });
  customerId = customer.id as string;
  const vendor = await createVendor({
    entity_id: f.entityId, company_name: 'Refacciones del Bajio SA',
    tax_id: 'XAXX010101000', currency_code: 'MXN', created_by: f.userId,
  });
  vendorId = vendor.id as string;
  bankId = await bankAccount(f, 'BBVA Operativa');
  foreignBankId = await bankAccount(other, 'BBVA Ajena');
  // The common Mexican setup: one bank, a peso and a dollar account, where the
  // first account's full name is a substring of the second's.
  exactBankId = await bankAccount(f, 'BBVA');
  await bankAccount(f, 'BBVA USD', 'USD');
  await bankAccount(f, 'Santander Cerrada', 'MXN', false);
}, 60_000);

afterAll(async () => {
  await drainAttestations(5000).catch(() => undefined);
  await closeDatabase();
});

describe('payment create --bank', () => {
  it('resolves the bank account by its name', async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', 'BBVA Operativa']);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).not.toContain('invalid input syntax');
    expect(await billPayments(docNumber)).toEqual([{ bank_account_id: bankId }]);
  });

  it("an exact name wins over another account's name that contains it", async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', 'BBVA']);
    expect(r.exitCode, r.err).toBe(0);
    expect(await billPayments(docNumber)).toEqual([{ bank_account_id: exactBankId }]);
  });

  it('a fragment that resolves names the account it chose', async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', 'Operativa']);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).toContain('Bank account: BBVA Operativa');
    expect(await billPayments(docNumber)).toEqual([{ bank_account_id: bankId }]);
  });

  it('LIKE wildcards in the name are literal, not patterns', async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', 'BBVA_Operativa']);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toContain('BBVA_Operativa');
    expect(await billPayments(docNumber)).toEqual([]);
  });

  it('an inactive account takes no new payment', async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', 'Santander']);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toContain('inactiva');
    expect(await billPayments(docNumber)).toEqual([]);
  });

  it('an unknown name is a not-found, not a Postgres error, and writes nothing', async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', 'Banco Inexistente']);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).not.toContain('invalid input syntax');
    expect(r.err).toContain('Banco Inexistente');
    expect(await billPayments(docNumber)).toEqual([]);
  });

  it("another entity's account id does not resolve, and writes nothing", async () => {
    const docNumber = await approvedBill();
    const r = await run(['payment', 'create', docNumber, '--amount', '1000', '--bank', foreignBankId]);
    expect(r.exitCode).not.toBe(0);
    expect(await billPayments(docNumber)).toEqual([]);
  });
});

describe('receipt record --bank', () => {
  it('resolves the bank account by its name', async () => {
    const docNumber = await issuedInvoice();
    const r = await run(['receipt', 'record', docNumber, '--amount', '1000', '--bank', 'BBVA Operativa']);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).toContain('Bank account: BBVA Operativa');
    expect(await invoicePayments(docNumber)).toEqual([{ bank_account_id: bankId }]);
  });

  it('an unknown name is a not-found, not a Postgres error, and writes nothing', async () => {
    const docNumber = await issuedInvoice();
    const r = await run(['receipt', 'record', docNumber, '--amount', '1000', '--bank', 'Banco Inexistente']);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).not.toContain('invalid input syntax');
    expect(r.err).toContain('Banco Inexistente');
    expect(await invoicePayments(docNumber)).toEqual([]);
  });

  it("another entity's account id does not resolve, and writes nothing", async () => {
    const docNumber = await issuedInvoice();
    const r = await run(['receipt', 'record', docNumber, '--amount', '1000', '--bank', foreignBankId]);
    expect(r.exitCode).not.toBe(0);
    expect(await invoicePayments(docNumber)).toEqual([]);
  });

  it("an exact name wins over another account's name that contains it", async () => {
    const docNumber = await issuedInvoice();
    const r = await run(['receipt', 'record', docNumber, '--amount', '1000', '--bank', 'BBVA']);
    expect(r.exitCode, r.err).toBe(0);
    expect(await invoicePayments(docNumber)).toEqual([{ bank_account_id: exactBankId }]);
  });

  it('an inactive account takes no new receipt', async () => {
    const docNumber = await issuedInvoice();
    const r = await run(['receipt', 'record', docNumber, '--amount', '1000', '--bank', 'Santander']);
    expect(r.exitCode).not.toBe(0);
    expect(await invoicePayments(docNumber)).toEqual([]);
  });
});

// The CLI is one caller; REST hands `bank_account_id` straight to the service.
// The scope has to fail closed there too, before anything is written.
describe('the payment services refuse a bank account of another entity', () => {
  it('recordVendorPayment', async () => {
    const docNumber = await approvedBill();
    const bill = await query<{ id: string }>(
      'SELECT id FROM bills WHERE bill_number = $1 AND entity_id = $2', [docNumber, f.entityId]
    );
    await expect(recordVendorPayment({
      entityId: f.entityId, paymentAmount: '1000.00', paymentDate: '2026-07-20',
      paymentMethod: 'spei', bankAccountId: foreignBankId,
      applications: [{ documentId: bill.rows[0].id, amountApplied: '1000.00' }],
    }, f.userId)).rejects.toThrow(/Bank Account/);
    expect(await billPayments(docNumber)).toEqual([]);
  });

  it('recordCustomerPayment', async () => {
    const docNumber = await issuedInvoice();
    const inv = await query<{ id: string }>(
      'SELECT id FROM invoices WHERE invoice_number = $1 AND entity_id = $2', [docNumber, f.entityId]
    );
    await expect(recordCustomerPayment({
      entityId: f.entityId, paymentAmount: '1000.00', paymentDate: '2026-07-20',
      paymentMethod: 'spei', bankAccountId: foreignBankId,
      applications: [{ documentId: inv.rows[0].id, amountApplied: '1000.00' }],
    }, f.userId)).rejects.toThrow(/Bank Account/);
    expect(await invoicePayments(docNumber)).toEqual([]);
  });
});
