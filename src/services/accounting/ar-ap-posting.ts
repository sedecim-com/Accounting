import Decimal from 'decimal.js';
import type pg from 'pg';
import { createJournalEntry } from './posting.js';
import { AccountingError } from '../../utils/errors.js';
import { JournalEntryType } from '../../types/index.js';
import type { JournalEntry, Invoice, InvoiceLine, Bill, BillLine } from '../../types/index.js';

// ============================================================
// AR/AP → GL POSTING
// Document-driven journal entries: invoices, vendor bills and
// their payments. Every function runs on the CALLER's transaction
// client so the document update and the entry commit together,
// and each is idempotent behind the document's journal_entry_id
// (plus the uq_je_document_source partial unique index as backstop).
// The caller must fire attestEntryAsync AFTER commit.
//
// Accounts resolve through account_roles (seeded per entity):
// cxc, cxp, banco, iva_trasladado, iva_acreditable. A per-line
// account on the document always wins over the generic role.
// Amounts post as stored on the document (functional currency);
// the CFDI ingestion path owns PUE/PPD and multicurrency nuances.
// ============================================================

async function roleAccounts(
  client: pg.PoolClient,
  entityId: string,
  roles: string[]
): Promise<Map<string, string>> {
  const result = await client.query<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles
     WHERE entity_id = $1 AND role = ANY($2) AND qualifier IS NULL`,
    [entityId, roles]
  );
  return new Map(result.rows.map((r) => [r.role, r.account_id]));
}

interface JeLine {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
  cost_center_id?: string;
  project_id?: string;
}

function requireRole(map: Map<string, string>, role: string): string {
  const id = map.get(role);
  if (!id) {
    throw new AccountingError(
      'MISSING_ROLE_ACCOUNT',
      `No account is mapped to role "${role}" for this entity — seed the account roles first (mnemosine init runs seedAccountRoles)`
    );
  }
  return id;
}

/** DR cxc (total) · CR revenue per line · CR iva_trasladado. */
export async function postInvoiceEntry(
  client: pg.PoolClient,
  invoice: Invoice,
  lines: InvoiceLine[],
  userId: string
): Promise<JournalEntry | null> {
  if (invoice.journal_entry_id) return null; // already posted (idempotent)
  if (!new Decimal(invoice.total_amount).greaterThan(0)) return null;

  const roles = await roleAccounts(client, invoice.entity_id, ['cxc', 'iva_trasladado', 'ingreso']);

  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxc'),
      debit_amount: invoice.total_amount,
      credit_amount: null,
      description: `Invoice ${invoice.invoice_number}`,
    },
    ...lines.map((line) => ({
      account_id: line.revenue_account_id || requireRole(roles, 'ingreso'),
      debit_amount: null,
      credit_amount: line.line_amount,
      description: line.description || `Invoice ${invoice.invoice_number} - line ${line.line_number}`,
      cost_center_id: line.cost_center_id || undefined,
      project_id: line.project_id || undefined,
    })),
  ];
  if (new Decimal(invoice.tax_amount || '0').greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'iva_trasladado'),
      debit_amount: null,
      credit_amount: invoice.tax_amount,
      description: `Tax - Invoice ${invoice.invoice_number}`,
    });
  }

  const entry = await createJournalEntry(
    invoice.entity_id,
    new Date(invoice.invoice_date),
    JournalEntryType.AUTO_INVOICE,
    `Invoice ${invoice.invoice_number}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'invoice', sourceId: invoice.id, reference: invoice.invoice_number }
  );

  await client.query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2', [entry.id, invoice.id]);
  return entry;
}

/** CR cxp (total) · DR expense per line · DR iva_acreditable. */
export async function postBillEntry(
  client: pg.PoolClient,
  bill: Bill,
  lines: BillLine[],
  userId: string
): Promise<JournalEntry | null> {
  if (bill.journal_entry_id) return null;
  if (!new Decimal(bill.total_amount).greaterThan(0)) return null;

  const roles = await roleAccounts(client, bill.entity_id, ['cxp', 'iva_acreditable', 'gasto']);

  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxp'),
      debit_amount: null,
      credit_amount: bill.total_amount,
      description: `Bill ${bill.bill_number}`,
    },
    ...lines.map((line) => ({
      account_id: line.account_id || requireRole(roles, 'gasto'),
      debit_amount: line.line_amount,
      credit_amount: null,
      description: line.description || `Bill ${bill.bill_number} - line ${line.line_number}`,
      cost_center_id: line.cost_center_id || undefined,
      project_id: line.project_id || undefined,
    })),
  ];
  if (new Decimal(bill.tax_amount || '0').greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'iva_acreditable'),
      debit_amount: bill.tax_amount,
      credit_amount: null,
      description: `Creditable IVA - Bill ${bill.bill_number}`,
    });
  }

  const entry = await createJournalEntry(
    bill.entity_id,
    new Date(bill.bill_date),
    JournalEntryType.AUTO_BILL,
    `Bill ${bill.bill_number}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'bill', sourceId: bill.id, reference: bill.bill_number }
  );

  await client.query('UPDATE bills SET journal_entry_id = $1 WHERE id = $2', [entry.id, bill.id]);
  return entry;
}

/** The bank's GL account: the linked bank account's gl_account_id, else the banco role. */
async function bankGlAccount(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string | null
): Promise<string> {
  if (bankAccountId) {
    const result = await client.query<{ gl_account_id: string | null }>(
      'SELECT gl_account_id FROM bank_accounts WHERE id = $1 AND entity_id = $2',
      [bankAccountId, entityId]
    );
    if (result.rows[0]?.gl_account_id) return result.rows[0].gl_account_id;
  }
  const roles = await roleAccounts(client, entityId, ['banco']);
  return requireRole(roles, 'banco');
}

interface PaymentRow {
  id: string;
  entity_id: string;
  payment_number: string;
  payment_amount: string;
  payment_date: Date | string;
  bank_account_id: string | null;
  journal_entry_id: string | null;
}

/** DR bank · CR cxc. */
export async function postCustomerPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const roles = await roleAccounts(client, payment.entity_id, ['cxc']);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
    JournalEntryType.AUTO_PAYMENT,
    `Customer payment ${payment.payment_number}`,
    [
      { account_id: bankId, debit_amount: payment.payment_amount, credit_amount: null, description: `Payment received ${payment.payment_number}` },
      { account_id: requireRole(roles, 'cxc'), debit_amount: null, credit_amount: payment.payment_amount, description: `AR settlement ${payment.payment_number}` },
    ],
    userId,
    { autoPost: true, client, sourceType: 'customer_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  await client.query('UPDATE customer_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}

/** DR cxp · CR bank. */
export async function postVendorPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const roles = await roleAccounts(client, payment.entity_id, ['cxp']);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
    JournalEntryType.AUTO_PAYMENT,
    `Vendor payment ${payment.payment_number}`,
    [
      { account_id: requireRole(roles, 'cxp'), debit_amount: payment.payment_amount, credit_amount: null, description: `AP settlement ${payment.payment_number}` },
      { account_id: bankId, debit_amount: null, credit_amount: payment.payment_amount, description: `Payment made ${payment.payment_number}` },
    ],
    userId,
    { autoPost: true, client, sourceType: 'vendor_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  await client.query('UPDATE vendor_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}
