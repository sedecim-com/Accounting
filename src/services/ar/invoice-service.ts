import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { nextEntityNumber, formatDocumentNumber } from '../../utils/sequence.js';
import { postInvoiceEntry } from '../accounting/ar-ap-posting.js';
import { voidJournalEntryInTx } from '../accounting/posting.js';
import { OPEN_INVOICE_STATUSES } from './customer-service.js';
import type { Invoice, InvoiceLine, JournalEntry } from '../../types/index.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';

// ============================================================
// CUSTOMER INVOICES — domain service
//
// Extracted from the Express handlers. Three things this file settles
// that the routes left tangled:
//
//   1. ISSUING IS NOT SENDING. The AR/revenue entry used to be posted
//      inside `POST /:id/send` (invoices.ts:237), so the only way to
//      put an invoice in the ledger was to claim it had been delivered.
//      `issueInvoice` posts, and takes `markSent` for the callers that
//      really are delivering. The delivery evidence is sent_at/sent_to;
//      an issue that did not deliver leaves both untouched.
//
//      The status it moves to is 'sent' because that is this schema's
//      name for "issued and open": the aged-receivables report
//      (routes/reports.ts:205), the agent's aging tool
//      (ai/tools/report-tools.ts:217) and bank matching
//      (services/banking/matching.ts:280) all read that value and none
//      of them reads 'pending'. Inventing a different status here would
//      post an invoice to the ledger and hide it from every AR report.
//
//   2. THE POSTING ROUTE IS THE ONLY ROUTE. `postInvoiceEntry` (the
//      single AR→GL path, ar-ap-posting.ts:58) is idempotent behind
//      invoices.journal_entry_id, so issuing twice posts once.
//
//   3. VOIDING HAS PRECONDITIONS. A stamped CFDI cannot be voided
//      locally — that is a cancellation before the PAC — and an invoice
//      with cash applied to it cannot be voided without unapplying
//      first. The HTTP route never checked either; it keeps its exact
//      behaviour by opting out explicitly, so the rule is stated in one
//      place and the legacy leniency is visible at the call site.
//
// Nothing here stamps, cancels before the SAT, or sends anything: an
// invoice created by this service is a LOCAL document.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses that can no longer be issued or voided into the ledger. */
export const TERMINAL_INVOICE_STATUSES = ['void', 'cancelled'] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface InvoiceFilters {
  customerId?: string;
  /** One or more lifecycle states. */
  statuses?: string[];
  /** Inclusive bounds, on whichever date `dateBasis` names. */
  since?: string;
  until?: string;
  /**
   * WHICH date the bounds and `asOf` mean. 'document' is the invoice's own
   * date and is the default, because that is what the HTTP surface has always
   * filtered on. 'posting' is the date the entry hit the general ledger — an
   * invoice that never posted has none and drops out, which is exactly what
   * filtering by posting date means.
   */
  dateBasis?: 'document' | 'posting';
  /** Matches invoice_number or the customer's company name. */
  search?: string;
  /**
   * Only open invoices at least this many days past due at `asOf`.
   * 0 means "due today or earlier". Implies an open status and a balance.
   */
  overdueDays?: number;
  /**
   * Reference date. Restricts to invoices dated on or before it and, with
   * `withAging`, reconstructs the balance as it stood that day from the
   * cash actually applied by then.
   */
  asOf?: string;
  /** Attach days_overdue (and amount_due_as_of when asOf is set). */
  withAging?: boolean;
  limit?: number;
  offset?: number;
}

export interface InvoiceListPage {
  rows: Array<Invoice & { customer_name?: string | null }>;
  total: number;
}

export async function listInvoices(
  entityId: string,
  filters: InvoiceFilters = {}
): Promise<InvoiceListPage> {
  const where: string[] = ['i.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  if (filters.customerId) {
    where.push(`i.customer_id = $${i++}`);
    params.push(filters.customerId);
  }
  if (filters.statuses?.length) {
    where.push(`i.status = ANY($${i++}::text[])`);
    params.push(filters.statuses);
  }
  // The basis says which date the FILTERS mean, so with no date filter it
  // means nothing and the ledger join is not paid for.
  const hasDateFilter = Boolean(filters.since || filters.until || filters.asOf);
  const onPostingDate = filters.dateBasis === 'posting' && hasDateFilter;
  const dateColumn = onPostingDate ? 'je.entry_date' : 'i.invoice_date';

  if (filters.since) {
    where.push(`${dateColumn} >= $${i++}`);
    params.push(filters.since);
  }
  if (filters.until) {
    where.push(`${dateColumn} <= $${i++}`);
    params.push(filters.until);
  }
  if (filters.search) {
    where.push(`(i.invoice_number ILIKE $${i} OR c.company_name ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i++;
  }

  const asOfValue = filters.asOf ?? today();

  if (filters.asOf) {
    where.push(`${dateColumn} <= $${i++}::date`);
    params.push(filters.asOf);
  }
  if (filters.overdueDays !== undefined) {
    // "N days overdue" is only meaningful for a document that is still open
    // and still owes something, so the filter carries both conditions.
    const dateParam = i++;
    const daysParam = i++;
    where.push(`i.due_date <= ($${dateParam}::date - $${daysParam}::int)`);
    params.push(asOfValue, filters.overdueDays);
    where.push('i.amount_due > 0');
    where.push(`i.status = ANY($${i++}::text[])`);
    params.push([...OPEN_INVOICE_STATUSES]);
  }

  // The ledger join only appears when the filters are keyed to the posting
  // date; a LEFT JOIN on the entry's primary key cannot multiply rows.
  const ledgerJoin = onPostingDate ? ' LEFT JOIN journal_entries je ON je.id = i.journal_entry_id' : '';
  const from = `FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id${ledgerJoin} WHERE ${where.join(' AND ')}`;

  // The count binds exactly the WHERE parameters: Postgres rejects a bind
  // that supplies more parameters than the statement references.
  const counted = await query<{ count: string }>(`SELECT COUNT(*) as count ${from}`, params);
  const total = parseInt(counted.rows[0].count, 10);

  const rowParams = [...params];
  let extra = '';
  if (filters.withAging) {
    const asOfParam = `$${rowParams.length + 1}`;
    rowParams.push(asOfValue);
    extra = `, (${asOfParam}::date - i.due_date) AS days_overdue`;
    if (filters.asOf) {
      // The balance as it stood on the reference date: what was billed minus
      // the cash actually applied by then. Allocations carry no date of their
      // own, so the payment's date is the one that counts.
      extra +=
        `, (i.total_amount - COALESCE((
             SELECT SUM(pa.amount_applied)
             FROM payment_allocations pa
             JOIN customer_payments p ON p.id = pa.payment_id
             WHERE pa.invoice_id = i.id AND p.payment_date <= ${asOfParam}::date AND p.status <> 'void'
           ), 0)) AS amount_due_as_of`;
    }
  }

  const limit = filters.limit ?? total;
  const offset = filters.offset ?? 0;
  const limitParam = rowParams.length + 1;
  rowParams.push(limit, offset);

  const rows = await query<Invoice & { customer_name: string }>(
    `SELECT i.*, c.company_name as customer_name${extra}
     ${from}
     ORDER BY i.invoice_date DESC
     LIMIT $${limitParam} OFFSET $${limitParam + 1}`,
    rowParams
  );

  return { rows: rows.rows, total };
}

export interface GetInvoiceOptions {
  /** Attach the invoice lines. The HTTP surface always does. */
  includeLines?: boolean;
  /** Attach the cash applied to it, payment by payment. */
  includeAllocations?: boolean;
  /** Attach the general-ledger entry this invoice produced, if any. */
  includeLedger?: boolean;
}

export async function getInvoiceById(
  id: string,
  opts: GetInvoiceOptions = {}
): Promise<Record<string, unknown> | null> {
  const ledgerColumns = opts.includeLedger
    ? ', je.entry_number AS journal_entry_number, je.status AS journal_entry_status, je.entry_date AS journal_entry_date'
    : '';
  const ledgerJoin = opts.includeLedger
    ? ' LEFT JOIN journal_entries je ON je.id = i.journal_entry_id'
    : '';

  const result = await query<Invoice>(
    `SELECT i.*, c.company_name as customer_name, c.email as customer_email${ledgerColumns}
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id${ledgerJoin}
     WHERE i.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const invoice = result.rows[0] as unknown as Record<string, unknown>;

  if (opts.includeLines !== false) {
    const lines = await query<InvoiceLine>(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number',
      [id]
    );
    invoice.lines = lines.rows;
  }
  if (opts.includeAllocations) {
    invoice.payment_allocations = await listInvoiceAllocations(id);
  }
  return invoice;
}

/** The cash applied to an invoice: the half of `invoice show` the route omitted. */
export async function listInvoiceAllocations(
  invoiceId: string
): Promise<Record<string, unknown>[]> {
  const result = await query(
    `SELECT pa.id, pa.amount_applied, pa.discount_amount, pa.created_at,
            p.payment_number, p.payment_date, p.payment_method, p.status AS payment_status
     FROM payment_allocations pa
     JOIN customer_payments p ON p.id = pa.payment_id
     WHERE pa.invoice_id = $1
     ORDER BY p.payment_date ASC`,
    [invoiceId]
  );
  return result.rows as Record<string, unknown>[];
}

/** Resolves an invoice number or uuid inside one entity. */
export async function resolveInvoice(entityId: string, ref: string): Promise<Invoice> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('An invoice reference is required.');

  const result = UUID_RE.test(trimmed)
    ? await query<Invoice>('SELECT * FROM invoices WHERE id = $1 AND entity_id = $2', [trimmed, entityId])
    : await query<Invoice>(
        'SELECT * FROM invoices WHERE invoice_number = $1 AND entity_id = $2',
        [trimmed, entityId]
      );
  if (result.rows.length === 0) throw new NotFoundError('Invoice', trimmed);
  return result.rows[0];
}

export interface InvoiceLineInput {
  item_id?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  unit_price: string | number;
  revenue_account_id: string;
  tax_code?: string | null;
  tax_rate?: string | number | null;
  cost_center_id?: string | null;
  project_id?: string | null;
  cfdi_product_code?: string | null;
  cfdi_unit_code?: string | null;
}

export interface CreateInvoiceInput {
  entity_id: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  currency_code?: string | null;
  lines: InvoiceLineInput[];
  terms?: string | null;
  memo?: string | null;
  po_number?: string | null;
  created_by: string;
}

/**
 * Creates a DRAFT invoice with its lines and a folio drawn from the entity's
 * atomic counter. Nothing is posted and nothing is stamped: the document
 * exists only here until someone issues it.
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  if (!input.lines?.length) throw new ValidationError('At least 1 line required');

  return withTransaction(async (client) => {
    const invoiceNumber = await nextEntityNumber(client, input.entity_id, 'invoice', 'INV');

    let subtotal = new Decimal(0);
    let taxAmount = new Decimal(0);

    const processedLines = input.lines.map((line, i) => {
      const qty = new Decimal((line.quantity as number) || 1);
      const price = new Decimal(line.unit_price as number);
      const lineAmount = qty.times(price);
      const lineTax = line.tax_rate
        ? lineAmount.times(new Decimal(line.tax_rate as number).dividedBy(100))
        : new Decimal(0);
      const totalAmt = lineAmount.plus(lineTax);

      subtotal = subtotal.plus(lineAmount);
      taxAmount = taxAmount.plus(lineTax);

      return {
        line_number: i + 1,
        item_id: line.item_id || null,
        description: line.description || '',
        quantity: qty.toFixed(4),
        unit_price: price.toFixed(4),
        revenue_account_id: line.revenue_account_id,
        tax_code: line.tax_code || null,
        tax_rate: line.tax_rate || null,
        tax_amount: lineTax.toFixed(4),
        line_amount: lineAmount.toFixed(4),
        total_amount: totalAmt.toFixed(4),
        cost_center_id: line.cost_center_id || null,
        project_id: line.project_id || null,
        cfdi_product_code: line.cfdi_product_code || null,
        cfdi_unit_code: line.cfdi_unit_code || null,
      };
    });

    const totalAmount = subtotal.plus(taxAmount);
    const invoiceId = uuidv4();

    await client.query(
      `INSERT INTO invoices (
        id, entity_id, invoice_number, customer_id,
        subtotal, tax_amount, total_amount, amount_due,
        currency_code, invoice_date, due_date,
        status, terms, memo, po_number, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $13, $14, $15)`,
      [
        invoiceId, input.entity_id, invoiceNumber, input.customer_id,
        subtotal.toFixed(4), taxAmount.toFixed(4), totalAmount.toFixed(4), totalAmount.toFixed(4),
        input.currency_code || 'USD', input.invoice_date, input.due_date,
        input.terms || null, input.memo || null, input.po_number || null, input.created_by,
      ]
    );

    for (const line of processedLines) {
      await client.query(
        `INSERT INTO invoice_lines (
          id, invoice_id, line_number, item_id, description,
          quantity, unit_price, revenue_account_id,
          tax_code, tax_rate, tax_amount, line_amount, total_amount,
          cost_center_id, project_id, cfdi_product_code, cfdi_unit_code
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          uuidv4(), invoiceId, line.line_number, line.item_id, line.description,
          line.quantity, line.unit_price, line.revenue_account_id,
          line.tax_code, line.tax_rate, line.tax_amount, line.line_amount, line.total_amount,
          line.cost_center_id, line.project_id, line.cfdi_product_code, line.cfdi_unit_code,
        ]
      );
    }

    const result = await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    return result.rows[0];
  });
}

export interface IssueInvoiceOptions {
  /**
   * La entidad del llamador. OBLIGATORIA, y por eso está en el tipo: la
   * pertenencia se comprueba DENTRO del SQL, no después. Antes esta función
   * recibía sólo el id y `POST /v1/invoices/:id/...` se lo pasaba crudo, así
   * que conocer un UUID bastaba para emitir o anular la factura de otra
   * entidad —y contraasentar su ingreso en el mayor ajeno—. Con el campo en
   * el tipo, un llamador sin alcance no compila.
   */
  entityId: string;
  /**
   * Also stamp the delivery fields (sent_at, sent_to). Only a caller that
   * actually delivered the document may pass this: `invoice issue` does not.
   */
  markSent?: boolean;
  sentTo?: string;
  /**
   * Refuse to issue a void, cancelled or already-paid invoice. The HTTP
   * /send route never checked, and keeps that behaviour by leaving it off.
   */
  enforceStatusGuard?: boolean;
  /**
   * Compute the whole effect — folio, entry, lines — and roll it back.
   * Not a simulation: the real posting code runs, so a missing account role
   * or a closed period fails here exactly as it would for real.
   */
  dryRun?: boolean;
}

export interface PostedLine {
  line_number: number;
  account_code: string;
  account_name: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string | null;
}

export interface IssueInvoiceResult {
  invoice: Invoice;
  /** The entry that posted, or null when the invoice was already posted. */
  entry: JournalEntry | null;
  /**
   * The entry's lines, read inside the transaction. That is what makes
   * `--dry-run` show the real posting instead of a re-derived guess: the
   * rows below are the ones that were written and then rolled back.
   */
  entryLines: PostedLine[];
  alreadyPosted: boolean;
  dryRun: boolean;
  /** For the caller to fire attestEntryAsync AFTER commit. */
  attest: { entityId: string; entryId: string } | null;
}

/** Internal sentinel: unwinds the transaction after computing a dry run. */
class DryRunRollback extends Error {
  constructor(readonly result: IssueInvoiceResult) {
    super('dry-run');
    this.name = 'DryRunRollback';
  }
}

/**
 * Posts DR accounts receivable / CR revenue per line / CR VAT payable through
 * the single AR posting path and moves the invoice to an open state.
 */
export async function issueInvoice(
  invoiceId: string,
  userId: string,
  opts: IssueInvoiceOptions
): Promise<IssueInvoiceResult> {
  try {
    return await withTransaction(async (client) => {
      const result = await issueInvoiceInTx(client, invoiceId, userId, opts);
      if (opts.dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}

async function issueInvoiceInTx(
  client: pg.PoolClient,
  invoiceId: string,
  userId: string,
  opts: IssueInvoiceOptions
): Promise<IssueInvoiceResult> {
  // El filtro y el candado, en la MISMA sentencia: cero filas significa a la
  // vez «no existe» y «no es de tu entidad», y no hay rama que los distinga.
  const found = await client.query<Invoice>(
    'SELECT * FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE',
    [invoiceId, opts.entityId]
  );
  if (found.rows.length === 0) throw new NotFoundError('Invoice', invoiceId);
  const invoice = found.rows[0];

  if (opts.enforceStatusGuard) {
    if ((TERMINAL_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) {
      throw new ValidationError(
        `Invoice ${invoice.invoice_number} is ${invoice.status} and cannot be issued.`
      );
    }
  }

  const alreadyPosted = Boolean(invoice.journal_entry_id);

  if (opts.markSent) {
    await client.query(
      `UPDATE invoices SET status = 'sent', sent_at = NOW(), sent_to = $1 WHERE id = $2 AND entity_id = $3`,
      [opts.sentTo || '', invoiceId, opts.entityId]
    );
  } else {
    // Issuing does not deliver: sent_at and sent_to stay as they are.
    await client.query(`UPDATE invoices SET status = 'sent' WHERE id = $1 AND entity_id = $2`, [invoiceId, opts.entityId]);
  }

  const lines = await client.query<InvoiceLine>(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number',
    [invoiceId]
  );
  const entry = await postInvoiceEntry(client, invoice, lines.rows, userId);

  let entryLines: PostedLine[] = [];
  if (entry) {
    const posted = await client.query<PostedLine>(
      `SELECT jel.line_number, a.code AS account_code, a.name AS account_name,
              jel.debit_amount, jel.credit_amount, jel.description
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1
       ORDER BY jel.line_number`,
      [entry.id]
    );
    entryLines = posted.rows;
  }

  // R1: el ciclo de vida deja SU rastro — antes sólo el asiento derivado
  // quedaba auditado, y «quién emitió la factura» no estaba en ninguna parte.
  await registrarAuditoria(client, {
    tenantId: await tenantDe(client, invoice.entity_id),
    userId,
    action: 'update',
    entityType: 'invoices',
    entityId: invoiceId,
    oldValues: { status: invoice.status },
    newValues: {
      status: 'sent',
      invoice_number: invoice.invoice_number,
      journal_entry_id: entry?.id ?? invoice.journal_entry_id ?? null,
    },
  });

  const after = await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  return {
    invoice: after.rows[0],
    entry,
    entryLines,
    alreadyPosted,
    dryRun: opts.dryRun === true,
    attest: entry ? { entityId: invoice.entity_id, entryId: entry.id } : null,
  };
}

export interface VoidInvoiceOptions {
  /**
   * La entidad del llamador. OBLIGATORIA, y por eso está en el tipo: la
   * pertenencia se comprueba DENTRO del SQL, no después. Antes esta función
   * recibía sólo el id y `POST /v1/invoices/:id/...` se lo pasaba crudo, así
   * que conocer un UUID bastaba para emitir o anular la factura de otra
   * entidad —y contraasentar su ingreso en el mayor ajeno—. Con el campo en
   * el tipo, un llamador sin alcance no compila.
   */
  entityId: string;
  /**
   * Allow voiding an invoice that carries a CFDI UUID. Locally voiding a
   * stamped document does not cancel it before the SAT, so the default is
   * to refuse and point at `cfdi cancel`. The HTTP route passes true to
   * keep the behaviour it has always had.
   */
  allowStamped?: boolean;
  /** Allow voiding an invoice with cash applied to it. Same reasoning. */
  allowApplied?: boolean;
  /** Recorded on the reversal; the HTTP route passes none, as before. */
  reason?: string;
  dryRun?: boolean;
}

export interface VoidInvoiceResult {
  invoice: Invoice;
  reversalEntryId: string | null;
  dryRun: boolean;
  attest: { entityId: string; entryId: string } | null;
}

class VoidDryRunRollback extends Error {
  constructor(readonly result: VoidInvoiceResult) {
    super('dry-run');
    this.name = 'VoidDryRunRollback';
  }
}

/**
 * Voids an invoice and annuls its ledger entry with a linked reversal
 * (NIF B-1), in one transaction. A paid or already void invoice is not
 * found — the historical contract, preserved.
 */
export async function voidInvoice(
  invoiceId: string,
  userId: string,
  opts: VoidInvoiceOptions
): Promise<VoidInvoiceResult> {
  // The guard reads before the transaction opens, so a payment applied in the
  // same instant could still slip past it. That window is the same one the
  // cash-application path already lives with (it does not lock the invoice
  // either), and closing it belongs with that family, not here.
  if (!opts.allowStamped || !opts.allowApplied) {
    const guard = await query<{ cfdi_uuid: string | null; cfdi_status: string | null; applied: string }>(
      `SELECT i.cfdi_uuid, i.cfdi_status,
              COALESCE((SELECT SUM(pa.amount_applied) FROM payment_allocations pa
                        WHERE pa.invoice_id = i.id), 0)::text AS applied
       FROM invoices i WHERE i.id = $1`,
      [invoiceId]
    );
    if (guard.rows.length === 0) throw new NotFoundError('Invoice', invoiceId);
    const { cfdi_uuid: uuid, cfdi_status: cfdiStatus, applied } = guard.rows[0];

    if (!opts.allowStamped && (uuid || cfdiStatus === 'stamped')) {
      throw new ConflictError(
        `Invoice carries CFDI ${uuid ?? '(stamped)'}. Voiding it here would not cancel it ` +
          'before the SAT; cancel the CFDI with its SAT reason code first.'
      );
    }
    if (!opts.allowApplied && new Decimal(applied).greaterThan(0)) {
      throw new ConflictError(
        `Invoice has ${applied} of cash applied to it. Unapply the payment before voiding.`
      );
    }
  }

  try {
    return await withTransaction(async (client) => {
      const updated = await client.query<Invoice>(
        `UPDATE invoices SET status = 'void'
          WHERE id = $1 AND entity_id = $2 AND status NOT IN ('paid', 'void') RETURNING *`,
        [invoiceId, opts.entityId]
      );
      if (updated.rows.length === 0) throw new NotFoundError('Invoice', invoiceId);
      const voided = updated.rows[0];

      let attest: { entityId: string; entryId: string } | null = null;
      let reversalEntryId: string | null = null;
      if (voided.journal_entry_id) {
        const memo = opts.reason
          ? `Invoice ${voided.invoice_number} voided: ${opts.reason}`
          : `Invoice ${voided.invoice_number} voided`;
        const { reversal } = await voidJournalEntryInTx(
          client, voided.journal_entry_id, userId, memo
        );
        if (reversal) {
          reversalEntryId = reversal.id;
          attest = { entityId: voided.entity_id, entryId: reversal.id };
        }
      }

      // R1: la anulación deja su rastro con la razón — antes sólo el
      // asiento espejo quedaba auditado.
      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, voided.entity_id),
        userId,
        action: 'void',
        entityType: 'invoices',
        entityId: voided.id,
        newValues: {
          status: 'void',
          invoice_number: voided.invoice_number,
          reversal_entry_id: reversalEntryId,
        },
        reason: opts.reason ?? null,
      });

      const result: VoidInvoiceResult = {
        invoice: voided,
        reversalEntryId,
        dryRun: opts.dryRun === true,
        attest,
      };
      if (opts.dryRun) throw new VoidDryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof VoidDryRunRollback) return err.result;
    throw err;
  }
}

/**
 * The folio counters an entity has drawn from. `entity_sequences` is the only
 * series registry this system has: one atomic counter per document type
 * (utils/sequence.ts:12), with no prefix column — the prefix lives at the call
 * site, so it is mapped here from the five that exist.
 */
export const SEQUENCE_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  invoice: 'INV',
  customer_payment: 'PMT',
  bill: 'BILL',
  vendor_payment: 'VPMT',
  journal_entry: 'JE',
});

export interface SequenceRow {
  document_type: string;
  issued: number;
  last_number: string | null;
  next_number: string;
  updated_at: Date | null;
}

export async function listEntitySequences(entityId: string): Promise<SequenceRow[]> {
  const result = await query<{ name: string; value: string; updated_at: Date }>(
    'SELECT name, value, updated_at FROM entity_sequences WHERE entity_id = $1 ORDER BY name',
    [entityId]
  );
  return result.rows.map((row) => {
    const issued = parseInt(row.value, 10);
    const prefix = SEQUENCE_PREFIXES[row.name] ?? row.name.toUpperCase();
    return {
      document_type: row.name,
      issued,
      last_number: issued > 0 ? formatDocumentNumber(prefix, issued) : null,
      next_number: formatDocumentNumber(prefix, issued + 1),
      updated_at: row.updated_at ?? null,
    };
  });
}
