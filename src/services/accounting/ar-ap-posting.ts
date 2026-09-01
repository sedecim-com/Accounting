import Decimal from 'decimal.js';
import type pg from 'pg';
import { createJournalEntry } from './posting.js';
import { AccountingError } from '../../utils/errors.js';
import { JournalEntryType } from '../../types/index.js';
import type { JournalEntry, Invoice, InvoiceLine, Bill, BillLine } from '../../types/index.js';
import {
  entityUsesCashBasisIva,
  resolveInvoiceMetodoPago,
  resolveBillMetodoPago,
  ivaReclassificationsFor,
  ivaRoleFor,
  reclassRoles,
  describeMetodo,
  ivaTreatmentNote,
  type MetodoPagoDecision,
} from './iva-cash-basis.js';

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
// cxc, cxp, banco and the IVA roles. A per-line account on the
// document always wins over the generic role. Amounts post as
// stored on the document (functional currency); multicurrency
// nuances still belong to the CFDI ingestion path.
//
// IVA IS ON A CASH BASIS FOR MEXICAN ENTITIES. Which IVA role a
// document's tax lands in is decided by the CFDI MetodoPago and
// read off the taxonomy (see iva-cash-basis.ts): PUE posts to
// iva_trasladado / iva_acreditable, PPD parks in
// iva_trasladado_no_cobrado (2125) / iva_pendiente_acreditar
// (1135) and is released by the payment that applies the document.
// A non-Mexican entity is untouched by any of this and keeps
// posting its tax exactly where it always did.
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
      `No hay cuenta mapeada al rol "${role}" en esta entidad. ` +
        `Siembra la contabilidad con: mnemosine init --section identity ` +
        `(o revisa qué falta con: mnemosine doctor)`
    );
  }
  return id;
}

/**
 * Appends " · MetodoPago missing: X assumed" so the assumption is legible in
 * the ledger itself, not only in a log line nobody reads at close.
 */
function withAssumptionNote(base: string, decision: MetodoPagoDecision | null): string {
  return decision?.assumed ? `${base} · MetodoPago missing: ${decision.metodo} assumed` : base;
}

/**
 * DR cxc (total) · CR revenue per line · CR the IVA role the MetodoPago
 * selects: iva_trasladado for PUE, iva_trasladado_no_cobrado for PPD.
 */
export async function postInvoiceEntry(
  client: pg.PoolClient,
  invoice: Invoice,
  lines: InvoiceLine[],
  userId: string
): Promise<JournalEntry | null> {
  if (invoice.journal_entry_id) return null; // already posted (idempotent)
  if (!new Decimal(invoice.total_amount).greaterThan(0)) return null;

  const cashBasis = await entityUsesCashBasisIva(client, invoice.entity_id);
  const metodo = cashBasis ? await resolveInvoiceMetodoPago(client, invoice) : null;
  const ivaRole = metodo ? ivaRoleFor('issued', metodo.metodo) : 'iva_trasladado';

  const roles = await roleAccounts(client, invoice.entity_id, ['cxc', ivaRole, 'ingreso']);

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
      account_id: requireRole(roles, ivaRole),
      debit_amount: null,
      credit_amount: invoice.tax_amount,
      description: metodo
        ? `IVA ${describeMetodo(metodo)} - Invoice ${invoice.invoice_number} · ${ivaTreatmentNote('issued', metodo)}`
        : `Tax - Invoice ${invoice.invoice_number}`,
    });
  }

  const entry = await createJournalEntry(
    invoice.entity_id,
    new Date(invoice.invoice_date),
    JournalEntryType.AUTO_INVOICE,
    withAssumptionNote(`Invoice ${invoice.invoice_number}`, metodo),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'invoice', sourceId: invoice.id, reference: invoice.invoice_number }
  );

  await client.query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2', [entry.id, invoice.id]);
  return entry;
}

/**
 * CR cxp (total) · DR expense per line · DR the IVA role the MetodoPago
 * selects: iva_acreditable for PUE, iva_pendiente_acreditar for PPD.
 */
export async function postBillEntry(
  client: pg.PoolClient,
  bill: Bill,
  lines: BillLine[],
  userId: string
): Promise<JournalEntry | null> {
  if (bill.journal_entry_id) return null;
  if (!new Decimal(bill.total_amount).greaterThan(0)) return null;

  const cashBasis = await entityUsesCashBasisIva(client, bill.entity_id);
  const metodo = cashBasis ? await resolveBillMetodoPago(client, bill) : null;
  const ivaRole = metodo ? ivaRoleFor('received', metodo.metodo) : 'iva_acreditable';

  const roles = await roleAccounts(client, bill.entity_id, ['cxp', ivaRole, 'gasto']);

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
      account_id: requireRole(roles, ivaRole),
      debit_amount: bill.tax_amount,
      credit_amount: null,
      description: metodo
        ? `IVA ${describeMetodo(metodo)} - Bill ${bill.bill_number} · ${ivaTreatmentNote('received', metodo)}`
        : `Creditable IVA - Bill ${bill.bill_number}`,
    });
  }

  const entry = await createJournalEntry(
    bill.entity_id,
    new Date(bill.bill_date),
    JournalEntryType.AUTO_BILL,
    withAssumptionNote(`Bill ${bill.bill_number}`, metodo),
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

/**
 * The IVA a payment releases, as lines appended to the payment's OWN entry.
 *
 * A separate "reclassification entry" was the obvious alternative and is the
 * wrong one: the cash movement and the tax it triggers are one event, and
 * only one entry per payment survives a reversal intact — voiding the payment
 * would otherwise unwind the cash and leave the IVA moved. The pair is
 * self-balancing, so the payment entry still foots.
 *
 * Returns an empty array when the entity is not Mexican, when nothing was
 * applied to a PPD document, or when the payment carries no allocations yet.
 */
async function ivaReclassLines(
  client: pg.PoolClient,
  side: 'issued' | 'received',
  payment: PaymentRow
): Promise<{ lines: JeLine[]; documents: string[] }> {
  if (!(await entityUsesCashBasisIva(client, payment.entity_id))) {
    return { lines: [], documents: [] };
  }

  const items = await ivaReclassificationsFor(client, side, payment.entity_id, payment.id);
  if (items.length === 0) return { lines: [], documents: [] };

  const { from, to } = reclassRoles(side);
  const roles = await roleAccounts(client, payment.entity_id, [from, to]);
  const label = side === 'issued' ? 'Invoice' : 'Bill';
  const event = side === 'issued' ? 'collection' : 'payment';

  // The two pending accounts sit on OPPOSITE sides of the balance sheet, so
  // draining them takes opposite entries: 2125 "IVA Trasladado No Cobrado" is
  // a liability, emptied by a DEBIT; 1135 "IVA Pendiente de Acreditar" is an
  // asset, emptied by a CREDIT. Getting this backwards balances just as well
  // and inverts both accounts, which is why it is spelled out here.
  const pending = { role: from, id: requireRole(roles, from) };
  const due = { role: to, id: requireRole(roles, to) };
  const debited = side === 'issued' ? pending : due;
  const credited = side === 'issued' ? due : pending;

  const lines: JeLine[] = [];
  for (const item of items) {
    const tail = `${label} ${item.documentNumber}`;
    const note = (r: { role: string }): string =>
      r === pending
        ? `IVA released from ${r.role} on ${event} - ${tail}`
        : `IVA now in ${r.role} (PPD ${event}) - ${tail}`;
    lines.push({
      account_id: debited.id,
      debit_amount: item.amount,
      credit_amount: null,
      description: note(debited),
    });
    lines.push({
      account_id: credited.id,
      debit_amount: null,
      credit_amount: item.amount,
      description: note(credited),
    });
  }
  return { lines, documents: items.map((i) => i.documentNumber) };
}

/**
 * DR bank · CR cxc, plus — for every PPD invoice this collection applies to —
 * DR iva_trasladado_no_cobrado · CR iva_trasladado for the collected share.
 * The IVA on a PPD sale is caused when the money arrives, and this is where
 * it arrives.
 */
export async function postCustomerPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const roles = await roleAccounts(client, payment.entity_id, ['cxc']);
  const iva = await ivaReclassLines(client, 'issued', payment);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
    JournalEntryType.AUTO_PAYMENT,
    iva.documents.length
      ? `Customer payment ${payment.payment_number} · IVA caused on collection: ${iva.documents.join(', ')}`
      : `Customer payment ${payment.payment_number}`,
    [
      { account_id: bankId, debit_amount: payment.payment_amount, credit_amount: null, description: `Payment received ${payment.payment_number}` },
      { account_id: requireRole(roles, 'cxc'), debit_amount: null, credit_amount: payment.payment_amount, description: `AR settlement ${payment.payment_number}` },
      ...iva.lines,
    ],
    userId,
    { autoPost: true, client, sourceType: 'customer_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  await client.query('UPDATE customer_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}

/**
 * DR cxp · CR bank, plus — for every PPD bill this payment applies to —
 * DR iva_acreditable · CR iva_pendiente_acreditar for the paid share. Under
 * LIVA art. 5 the input IVA becomes creditable here, not when the bill
 * arrived.
 */
export async function postVendorPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const roles = await roleAccounts(client, payment.entity_id, ['cxp']);
  const iva = await ivaReclassLines(client, 'received', payment);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
    JournalEntryType.AUTO_PAYMENT,
    iva.documents.length
      ? `Vendor payment ${payment.payment_number} · IVA creditable on payment: ${iva.documents.join(', ')}`
      : `Vendor payment ${payment.payment_number}`,
    [
      { account_id: requireRole(roles, 'cxp'), debit_amount: payment.payment_amount, credit_amount: null, description: `AP settlement ${payment.payment_number}` },
      { account_id: bankId, debit_amount: null, credit_amount: payment.payment_amount, description: `Payment made ${payment.payment_number}` },
      ...iva.lines,
    ],
    userId,
    { autoPost: true, client, sourceType: 'vendor_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  await client.query('UPDATE vendor_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}
