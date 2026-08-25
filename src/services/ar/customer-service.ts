import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { generateEntryNumber } from '../../utils/sequence.js';
import type { Customer } from '../../types/index.js';

// ============================================================
// CUSTOMERS (AR master data) — domain service
//
// Extracted from the Express handlers so the REST API, the CLI and
// the agent reach one implementation. Behaviour is preserved exactly
// as the routes had it; what this file ADDS is what the routes could
// not express:
//
//   - THE OPEN BALANCE. A customer row alone says nothing about what
//     the customer owes. The balance is computed from the invoices,
//     never stored, so it cannot drift from the subsidiary ledger.
//   - ARCHIVING IS NOT DELETING, and it is not free: a customer with
//     open documents cannot be archived, exactly as an account with
//     history cannot be retired. A caller that can justify itself may
//     override it, and the override is recorded.
//   - THE REASON IS PERSISTED. `audit_log.reason` has existed since
//     001_core_schema.sql:454 and the HTTP audit middleware never
//     filled it (middleware/audit.ts:5 writes new_values only). Any
//     caller that supplies an audit context here writes the reason,
//     the old values and the new values. The REST surface passes no
//     audit context, so its single middleware row is unchanged.
//
// Money stays a decimal STRING end to end: Postgres numerics arrive as
// strings and are never parsed into a float on the way out.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The invoice statuses that make a document part of the open subsidiary
 * ledger, and therefore part of what a customer owes.
 *
 * A `draft` is NOT a receivable: it has not been issued and has not touched
 * the general ledger, so counting it would make the auxiliary stop tying to
 * the control account. `void` and `cancelled` are gone; `paid` has nothing
 * left; `uncollectible` was written off to bad debt and is no longer an
 * asset. What remains is this list — the same set the wake gate already
 * uses for overdue receivables (src/ai/jobs/wake-gate.ts:201).
 */
export const OPEN_INVOICE_STATUSES = [
  'pending', 'sent', 'viewed', 'partially_paid', 'overdue',
] as const;

/**
 * The mirror image, for a reconstruction at a PAST date: statuses that mean
 * the document never was a receivable at all. A `paid` invoice belongs in an
 * as-of balance — it may well have been open on the reference date — so the
 * question there is not "is it open now?" but "did it exist and survive?".
 */
export const NEVER_RECEIVABLE_STATUSES = ['draft', 'void', 'cancelled'] as const;

/** The only columns a caller may change; order matches the historical route. */
export const CUSTOMER_UPDATABLE_FIELDS = [
  'company_name', 'first_name', 'last_name', 'email', 'phone',
  'payment_terms', 'credit_limit', 'credit_status', 'is_active', 'notes',
] as const;
export type CustomerUpdatableField = (typeof CUSTOMER_UPDATABLE_FIELDS)[number];
export type CustomerPatch = Partial<Record<CustomerUpdatableField, unknown>>;

/**
 * Who is changing what, and why. Supplying it writes the audit row the HTTP
 * middleware cannot write: it never sees a `reason` and never reads the row
 * before the update, so it has no old values to record.
 */
export interface AuditContext {
  userId: string;
  tenantId: string;
  reason?: string;
  /** Constrained by audit_log's CHECK; 'update' covers archive and restore. */
  action?: 'create' | 'update' | 'delete';
}

export interface CustomerBalance {
  /** Sum of amount_due over open documents, as a decimal string. */
  open_balance: string;
  /** The part of it already past due at the reference date. */
  overdue_balance: string;
  open_documents: number;
  oldest_due_date: string | null;
}

export interface CustomerFilters {
  /** Matches company_name, customer_number, first_name or last_name. */
  search?: string;
  isActive?: boolean;
  /** One or more credit states: approved, on_hold, suspended. */
  creditStatuses?: string[];
  /**
   * Compute and attach the open balance. Off by default so the HTTP
   * response keeps exactly the columns it always had.
   */
  withBalance?: boolean;
  /** Only customers with something past due at `asOf`. Implies withBalance. */
  overdueOnly?: boolean;
  /** Only customers owing more than this (decimal string). Implies withBalance. */
  balanceGreaterThan?: string;
  /** Reference date for "overdue"; defaults to today. */
  asOf?: string;
  limit?: number;
  offset?: number;
}

export interface CustomerListPage {
  rows: Array<Customer & Partial<CustomerBalance>>;
  /** Total matching rows before limit/offset, so truncation is never silent. */
  total: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What one invoice still owes, and what makes it count as an open document.
 *
 * Two modes, because "what do they owe?" and "what did they owe on 31 March?"
 * are different questions:
 *
 *   NOW (`reconstruct: false`) reads the maintained `amount_due` and the open
 *   statuses. It is the balance every other AR surface shows.
 *
 *   AS OF A DATE (`reconstruct: true`) rebuilds it: what was billed on
 *   documents dated on or before the reference date, minus the cash actually
 *   applied by then — allocations carry no date of their own, so the payment's
 *   date is the one that counts. The known limit, stated rather than hidden:
 *   a document VOIDED after the reference date is treated as never having been
 *   open, because the void carries no date either.
 */
function openDocumentExpr(
  asOfParam: string,
  statusParam: string,
  reconstruct: boolean
): { amount: string; where: string } {
  if (!reconstruct) {
    return {
      amount: 'i.amount_due',
      where: `i.status = ANY(${statusParam}::text[])`,
    };
  }
  return {
    amount: `(i.total_amount - COALESCE((
        SELECT SUM(pa.amount_applied)
        FROM payment_allocations pa
        JOIN customer_payments p ON p.id = pa.payment_id
        WHERE pa.invoice_id = i.id AND p.payment_date <= ${asOfParam}::date AND p.status <> 'void'
      ), 0))`,
    where: `i.status <> ALL(${statusParam}::text[]) AND i.invoice_date <= ${asOfParam}::date`,
  };
}

/**
 * The open-document aggregate, as a lateral subquery. One pass over the
 * invoices per customer instead of a query per row, and the same expression
 * for the list, the detail and the archive guard — three places that must
 * never disagree about what a customer owes.
 */
function balanceLateral(
  customerRef: string,
  asOfParam: string,
  statusParam: string,
  reconstruct: boolean
): string {
  const { amount, where } = openDocumentExpr(asOfParam, statusParam, reconstruct);
  return `LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(d.amount), 0) AS open_balance,
             COALESCE(SUM(CASE WHEN i.due_date < ${asOfParam}::date THEN d.amount ELSE 0 END), 0) AS overdue_balance,
             COUNT(*)::int AS open_documents,
             MIN(i.due_date) FILTER (WHERE i.due_date < ${asOfParam}::date) AS oldest_due_date
      FROM invoices i
      CROSS JOIN LATERAL (SELECT ${amount} AS amount) d
      WHERE i.customer_id = ${customerRef}
        AND d.amount > 0
        AND ${where}
    ) bal ON true`;
}

/** The status list the aggregate binds, which flips meaning with the mode. */
function statusesFor(reconstruct: boolean): string[] {
  return reconstruct ? [...NEVER_RECEIVABLE_STATUSES] : [...OPEN_INVOICE_STATUSES];
}

export async function listCustomers(
  entityId: string,
  filters: CustomerFilters = {}
): Promise<CustomerListPage> {
  const where: string[] = ['c.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  if (filters.isActive !== undefined) {
    where.push(`c.is_active = $${i++}`);
    params.push(filters.isActive);
  }
  if (filters.search) {
    where.push(
      `(c.company_name ILIKE $${i} OR c.customer_number ILIKE $${i} OR c.first_name ILIKE $${i} OR c.last_name ILIKE $${i})`
    );
    params.push(`%${filters.search}%`);
    i++;
  }
  if (filters.creditStatuses?.length) {
    where.push(`c.credit_status = ANY($${i++}::text[])`);
    params.push(filters.creditStatuses);
  }

  const needsBalance =
    filters.withBalance === true ||
    filters.overdueOnly === true ||
    filters.balanceGreaterThan !== undefined;

  let join = '';
  let balanceColumns = '';
  if (needsBalance) {
    const reconstruct = filters.asOf !== undefined;
    const asOfParam = `$${i++}`;
    params.push(filters.asOf ?? today());
    const statusParam = `$${i++}`;
    params.push(statusesFor(reconstruct));
    join = ` ${balanceLateral('c.id', asOfParam, statusParam, reconstruct)}`;
    balanceColumns =
      ', bal.open_balance, bal.overdue_balance, bal.open_documents, bal.oldest_due_date';

    if (filters.overdueOnly) where.push('bal.overdue_balance > 0');
    if (filters.balanceGreaterThan !== undefined) {
      where.push(`bal.open_balance > $${i++}`);
      params.push(filters.balanceGreaterThan);
    }
  }

  const from = `FROM customers c${join} WHERE ${where.join(' AND ')}`;

  const counted = await query<{ count: string }>(`SELECT COUNT(*) AS count ${from}`, params);
  const total = parseInt(counted.rows[0].count, 10);

  const limit = filters.limit ?? total;
  const offset = filters.offset ?? 0;
  const rows = await query<Customer & Partial<CustomerBalance>>(
    `SELECT c.*${balanceColumns} ${from}
     ORDER BY COALESCE(c.company_name, c.first_name)
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );

  return { rows: rows.rows, total };
}

export interface GetCustomerOptions {
  withBalance?: boolean;
  /** Open invoices and the latest payments, for the customer's file card. */
  includeDocuments?: boolean;
  asOf?: string;
  /** How many recent payments to attach with includeDocuments. */
  paymentLimit?: number;
}

export async function getCustomerById(
  id: string,
  opts: GetCustomerOptions = {}
): Promise<Record<string, unknown> | null> {
  const result = await query<Customer>('SELECT * FROM customers WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  const customer = result.rows[0] as unknown as Record<string, unknown>;

  if (opts.withBalance || opts.includeDocuments) {
    Object.assign(customer, await getCustomerBalance(id, opts.asOf));
  }
  if (opts.includeDocuments) {
    customer.open_invoices = await listCustomerOpenInvoices(id, opts.asOf);
    customer.recent_payments = await listCustomerRecentPayments(id, opts.paymentLimit ?? 5);
  }
  return customer;
}

/** What one customer owes, computed from the documents and never stored. */
export async function getCustomerBalance(
  customerId: string,
  asOf?: string
): Promise<CustomerBalance> {
  const reconstruct = asOf !== undefined;
  const result = await query<CustomerBalance>(
    `SELECT bal.open_balance, bal.overdue_balance, bal.open_documents, bal.oldest_due_date
     FROM (SELECT $1::uuid AS id) c
     ${balanceLateral('c.id', '$2', '$3', reconstruct)}`,
    [customerId, asOf ?? today(), statusesFor(reconstruct)]
  );
  return result.rows[0];
}

/** The documents behind the balance, on the same two-mode footing. */
export async function listCustomerOpenInvoices(
  customerId: string,
  asOf?: string
): Promise<Record<string, unknown>[]> {
  const reconstruct = asOf !== undefined;
  const { amount, where } = openDocumentExpr('$2', '$3', reconstruct);
  const result = await query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.status,
            i.total_amount, i.amount_paid, d.amount AS amount_due,
            ($2::date - i.due_date) AS days_overdue
     FROM invoices i
     CROSS JOIN LATERAL (SELECT ${amount} AS amount) d
     WHERE i.customer_id = $1 AND d.amount > 0 AND ${where}
     ORDER BY i.due_date ASC`,
    [customerId, asOf ?? today(), statusesFor(reconstruct)]
  );
  return result.rows as Record<string, unknown>[];
}

export async function listCustomerRecentPayments(
  customerId: string,
  limit = 5
): Promise<Record<string, unknown>[]> {
  const result = await query(
    `SELECT id, payment_number, payment_date, payment_amount, payment_method, status
     FROM customer_payments
     WHERE customer_id = $1
     ORDER BY payment_date DESC, payment_number DESC
     LIMIT $2`,
    [customerId, limit]
  );
  return result.rows as Record<string, unknown>[];
}

/**
 * Resolves what a person types — a customer number, a name, or a uuid —
 * inside one entity. Names are ambiguous by nature, so an ambiguous match
 * is a conflict that lists the candidates, never a silent first-row pick.
 */
export async function resolveCustomer(entityId: string, ref: string): Promise<Customer> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('A customer reference is required.');

  if (UUID_RE.test(trimmed)) {
    const byId = await query<Customer>(
      'SELECT * FROM customers WHERE id = $1 AND entity_id = $2',
      [trimmed, entityId]
    );
    if (byId.rows.length === 0) throw new NotFoundError('Customer', trimmed);
    return byId.rows[0];
  }

  const byNumber = await query<Customer>(
    'SELECT * FROM customers WHERE customer_number = $1 AND entity_id = $2',
    [trimmed, entityId]
  );
  if (byNumber.rows.length === 1) return byNumber.rows[0];

  const byName = await query<Customer>(
    `SELECT * FROM customers
     WHERE entity_id = $1
       AND (company_name ILIKE $2 OR first_name ILIKE $2 OR last_name ILIKE $2
            OR (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) ILIKE $2)
     ORDER BY COALESCE(company_name, first_name)`,
    [entityId, `%${trimmed}%`]
  );
  if (byName.rows.length === 1) return byName.rows[0];
  if (byName.rows.length === 0) throw new NotFoundError('Customer', trimmed);

  throw new ConflictError(
    `"${trimmed}" matches ${byName.rows.length} customers: ` +
      byName.rows
        .slice(0, 5)
        .map((c) => `${c.customer_number} (${c.company_name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()})`)
        .join(', ') +
      '. Use the customer number or the id.'
  );
}

export interface CreateCustomerInput {
  entity_id: string;
  created_by: string;
  company_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  tax_id?: string | null;
  tax_id_type?: string | null;
  email?: string | null;
  phone?: string | null;
  billing_address?: Record<string, unknown> | null;
  shipping_address?: Record<string, unknown> | null;
  payment_terms?: string | null;
  credit_limit?: string | number | null;
  currency_code?: string | null;
  default_revenue_account_id?: string | null;
  default_ar_account_id?: string | null;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  if (!input.company_name && !input.first_name) {
    throw new ValidationError('company_name or first_name is required');
  }

  // Historical numbering, kept byte for byte: C-<year>-<count+1>. It is
  // COUNT-based and therefore race-prone, which is why the unique violation
  // below is translated instead of surfacing as an unhandled 500.
  const counted = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM customers WHERE entity_id = $1',
    [input.entity_id]
  );
  const customerNumber = generateEntryNumber('C', parseInt(counted.rows[0].count, 10));

  try {
    const result = await query<Customer>(
      `INSERT INTO customers (
        id, entity_id, customer_number, company_name, first_name, last_name,
        tax_id, tax_id_type, email, phone,
        billing_address, shipping_address, payment_terms,
        credit_limit, currency_code, default_revenue_account_id,
        default_ar_account_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        uuidv4(), input.entity_id, customerNumber,
        input.company_name || null, input.first_name || null, input.last_name || null,
        input.tax_id || null, input.tax_id_type || null, input.email || null, input.phone || null,
        input.billing_address ? JSON.stringify(input.billing_address) : null,
        input.shipping_address ? JSON.stringify(input.shipping_address) : null,
        input.payment_terms || 'Net 30', input.credit_limit || null,
        input.currency_code || 'USD', input.default_revenue_account_id || null,
        input.default_ar_account_id || null, input.created_by,
      ]
    );
    return result.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new ConflictError(
        `Customer number ${customerNumber} already exists in this entity. ` +
          'The number is derived from the customer count, so two simultaneous ' +
          'creations draw the same one; retry.'
      );
    }
    throw err;
  }
}

export interface UpdateCustomerOptions {
  audit?: AuditContext;
}

export async function updateCustomer(
  id: string,
  patch: CustomerPatch,
  opts: UpdateCustomerOptions = {}
): Promise<Customer> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  for (const field of CUSTOMER_UPDATABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    sets.push(`${field} = $${i++}`);
    params.push(patch[field]);
  }
  if (sets.length === 0) throw new ValidationError('No valid fields to update');

  // Only read the previous values when someone is going to record them:
  // the HTTP path must keep making exactly one round trip.
  const before = opts.audit ? await getCustomerById(id) : null;

  sets.push('updated_at = NOW()');
  params.push(id);
  const sql = `UPDATE customers SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`;

  // Sin auditoría, un solo viaje: es la ruta HTTP caliente.
  if (!opts.audit) {
    const result = await query<Customer>(sql, params);
    if (result.rows.length === 0) throw new NotFoundError('Customer', id);
    return result.rows[0];
  }

  // Con auditoría, cambio y rastro se confirman juntos. Antes eran dos
  // query() sueltos: si el renglón de auditoría fallaba, el cliente quedaba
  // modificado sin constancia de quién lo hizo ni por qué.
  const audit = opts.audit;
  const result = await withTransaction(async (client) => {
    const r = await client.query<Customer>(sql, params);
    if (r.rows.length === 0) throw new NotFoundError('Customer', id);
    await registrarAuditoria(client, {
      tenantId: audit.tenantId,
      userId: audit.userId,
      action: audit.action ?? 'update',
      entityType: 'customers',
      entityId: id,
      oldValues: pick(before, Object.keys(patch)),
      newValues: patch as Record<string, unknown>,
      reason: audit.reason ?? null,
    });
    return r;
  });
  return result.rows[0];
}

export interface ArchiveCustomerOptions {
  /** Archive despite open documents. The override is what --force means. */
  allowWithBalance?: boolean;
  audit?: AuditContext;
}

/**
 * Deactivates a customer. Refuses while the customer still owes something:
 * an archived customer disappears from the pickers, and a receivable whose
 * counterparty cannot be selected is a receivable nobody will collect.
 */
export async function archiveCustomer(
  id: string,
  opts: ArchiveCustomerOptions = {}
): Promise<{ customer: Customer; balance: CustomerBalance }> {
  const balance = await getCustomerBalance(id);
  if (balance.open_documents > 0 && !opts.allowWithBalance) {
    throw new ValidationError(
      `Cannot archive a customer with ${balance.open_documents} open document(s) ` +
        `totalling ${balance.open_balance}. Collect or void them first, or override with --force and a --reason.`
    );
  }
  const customer = await updateCustomer(
    id,
    { is_active: false },
    { audit: opts.audit ? { action: 'update', ...opts.audit } : undefined }
  );
  return { customer, balance };
}

export async function restoreCustomer(
  id: string,
  opts: UpdateCustomerOptions = {}
): Promise<Customer> {
  return updateCustomer(id, { is_active: true }, opts);
}

/** The audited fields only: an audit row is a diff, not a copy of the table. */
function pick(
  row: Record<string, unknown> | null,
  keys: string[]
): Record<string, unknown> | null {
  if (!row) return null;
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

/** A customer's display name, from whichever of the three columns is filled. */
export function customerLabel(row: {
  company_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  if (row.company_name) return row.company_name;
  return [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
}
