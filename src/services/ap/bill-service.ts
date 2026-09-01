import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { postBillEntry } from '../accounting/ar-ap-posting.js';
import { parsePaymentTerms } from './vendor-service.js';
import type { Bill, BillLine, JournalEntry, JournalEntryLine } from '../../types/index.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';

// ============================================================
// VENDOR BILLS — domain service
//
// Extracted from src/api/rest/routes/bills.ts. The arithmetic,
// the numbering and the transaction boundaries are the route's,
// moved without changing them: line amount = qty × price, tax is
// per line and additive, the bill number comes from the atomic
// per-entity counter, and the header plus every line commit
// together or not at all.
//
// What the extraction adds is the part a CLI needs and an HTTP
// handler never had:
//
//   - A BILL CAN BE FOUND BY WHAT A PERSON HAS. Nobody holds a
//     uuid; they hold BILL-2026-00007 or the vendor's own folio.
//   - APPROVAL CAN BE SHOWN BEFORE IT IS DONE. `approveBill` in
//     dry-run mode runs the REAL posting — role lookup, fiscal
//     period, balance validation, entry numbering — inside a
//     transaction it then rolls back. A preview that reimplements
//     the engine is a preview that can disagree with it; this one
//     cannot.
//
// Approval is where a bill stops being a document and becomes a
// liability in the ledger (postBillEntry → createJournalEntry).
// That is irreversible: nothing here is agent-invocable.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses that still admit approval, straight from the route's guard. */
export const APPROVABLE_STATUSES = ['draft', 'pending_approval'] as const;
/** A bill may only be re-coded while it is still a document, not a liability. */
export const EDITABLE_STATUSES = ['draft', 'pending_approval'] as const;

/**
 * Which date startDate/endDate mean. `document` is bill_date — the only date
 * every bill has. `posting` is the date its journal entry hit the ledger, so
 * it necessarily excludes bills that were never approved: that is the accrual
 * cutoff question, and answering it with bill_date is how a period gets
 * closed on the wrong set of documents.
 */
export type BillDateBasis = 'document' | 'posting';

export interface BillFilters {
  vendorId?: string;
  /** One status or several; the REST surface passes one. */
  status?: string | string[];
  /** Inclusive bounds. Applied to bill_date unless dateBasis says otherwise. */
  startDate?: string;
  endDate?: string;
  dateBasis?: BillDateBasis;
  /** Everything falling due on or before this date — the payment-run question. */
  dueBefore?: string;
  /** Matches bill number, the vendor's own invoice number, or the vendor name. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface BillListPage {
  rows: Record<string, unknown>[];
  /** Total matching rows before limit/offset, so truncation is never silent. */
  total: number;
}

export async function listBills(entityId: string, filters: BillFilters = {}): Promise<BillListPage> {
  const where: string[] = ['b.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  if (filters.vendorId) {
    where.push(`b.vendor_id = $${i++}`);
    params.push(filters.vendorId);
  }
  if (filters.status !== undefined) {
    // An empty status is no status: the route this came from filtered on
    // `if (status)`, so `?status=` meant "unfiltered", not "match the empty
    // string" — which matches nothing and would answer a well-formed request
    // with a silently empty list.
    const statuses = (Array.isArray(filters.status) ? filters.status : [filters.status]).filter(
      (s) => typeof s === 'string' && s.trim() !== ''
    );
    if (statuses.length > 0) {
      where.push(`b.status = ANY($${i++})`);
      params.push(statuses);
    }
  }
  const dateColumn = filters.dateBasis === 'posting' ? 'je.entry_date' : 'b.bill_date';
  if (filters.startDate) {
    where.push(`${dateColumn} >= $${i++}`);
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    where.push(`${dateColumn} <= $${i++}`);
    params.push(filters.endDate);
  }
  if (filters.dueBefore) {
    where.push(`b.due_date <= $${i++}`);
    params.push(filters.dueBefore);
  }
  if (filters.search) {
    where.push(`(b.bill_number ILIKE $${i} OR b.vendor_invoice_number ILIKE $${i} OR v.company_name ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i++;
  }
  const whereClause = `WHERE ${where.join(' AND ')}`;
  // The entry join only appears when the posting date is being filtered on:
  // an INNER join would silently drop every unapproved bill from a plain list.
  const joins =
    'LEFT JOIN vendors v ON v.id = b.vendor_id' +
    (filters.dateBasis === 'posting' ? ' LEFT JOIN journal_entries je ON je.id = b.journal_entry_id' : '');

  const counted = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM bills b ${joins} ${whereClause}`,
    params
  );
  const total = parseInt(counted.rows[0].count, 10);

  const limit = filters.limit ?? total;
  const offset = filters.offset ?? 0;
  const result = await query<Bill & { vendor_name: string }>(
    `SELECT b.*, v.company_name as vendor_name
     FROM bills b ${joins}
     ${whereClause} ORDER BY b.bill_date DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );

  return { rows: result.rows as unknown as Record<string, unknown>[], total };
}

export interface GetBillOptions {
  includeLines?: boolean;
  /**
   * Resolve each line's account to its code and name. Off by default because
   * the REST surface has always returned bill_lines exactly as stored, and a
   * reader in a terminal needs the code, not a uuid.
   */
  includeLineAccounts?: boolean;
  /** The journal entry approval produced, with its lines. */
  includeJournal?: boolean;
  /** The CFDI this bill came from, when it arrived through the ingestion path. */
  includeCfdi?: boolean;
}

export async function getBillById(
  id: string,
  opts: GetBillOptions = {}
): Promise<Record<string, unknown> | null> {
  const result = await query<Bill & { vendor_name: string }>(
    `SELECT b.*, v.company_name as vendor_name
     FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const bill = result.rows[0] as unknown as Record<string, unknown>;

  if (opts.includeLines) {
    const lines = opts.includeLineAccounts
      ? await query<BillLine>(
          `SELECT l.*, a.code AS account_code, a.name AS account_name
           FROM bill_lines l LEFT JOIN accounts a ON a.id = l.account_id
           WHERE l.bill_id = $1 ORDER BY l.line_number`,
          [id]
        )
      : await query<BillLine>(
          'SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number',
          [id]
        );
    bill.lines = lines.rows;
  }

  if (opts.includeJournal && bill.journal_entry_id) {
    // bills.journal_entry_id has been a FK to journal_entries since 002 and
    // nothing ever read it back: an approved bill could not show its entry.
    const entry = await query<JournalEntry>(
      `SELECT id, entry_number, entry_type, entry_date, status, description, posted_date
       FROM journal_entries WHERE id = $1`,
      [bill.journal_entry_id]
    );
    if (entry.rows.length > 0) {
      const lines = await query<JournalEntryLine & { account_code: string; account_name: string }>(
        `SELECT l.line_number, a.code AS account_code, a.name AS account_name,
                l.debit_amount, l.credit_amount, l.description
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
        [bill.journal_entry_id]
      );
      bill.journal_entry = { ...entry.rows[0], lines: lines.rows };
    }
  }

  if (opts.includeCfdi) {
    // The only link between a bill and its XML is pre_registrations.bill_id,
    // written by the ingestion path. A bill captured by hand has none.
    const cfdi = await query(
      `SELECT x.cfdi_uuid, x.document_type, x.cfdi_serie, x.cfdi_folio, x.cfdi_fecha,
              x.emisor_rfc, x.emisor_nombre, x.total, x.moneda
       FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
       WHERE p.bill_id = $1
       ORDER BY x.cfdi_fecha DESC`,
      [id]
    );
    bill.cfdi = cfdi.rows;
  }

  return bill;
}

/**
 * Resolves what a person actually holds: a bill number, the vendor's own
 * folio, or a uuid — inside one entity. An ambiguous vendor folio is a
 * conflict, not a first match: approving the wrong bill posts a liability.
 */
export async function resolveBill(entityId: string, ref: string): Promise<Bill> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('No bill was given.', 'bill');

  if (UUID_RE.test(trimmed)) {
    const byId = await query<Bill>('SELECT * FROM bills WHERE id = $1 AND entity_id = $2', [trimmed, entityId]);
    if (byId.rows.length === 0) throw new NotFoundError('Bill', trimmed);
    return byId.rows[0];
  }

  const found = await query<Bill>(
    `SELECT * FROM bills
     WHERE entity_id = $1 AND (upper(bill_number) = upper($2) OR upper(vendor_invoice_number) = upper($2))
     ORDER BY bill_date DESC`,
    [entityId, trimmed]
  );
  if (found.rows.length === 1) return found.rows[0];
  if (found.rows.length === 0) throw new NotFoundError('Bill', trimmed);

  const list = found.rows.slice(0, 10).map((b) => `  - ${b.bill_number}  ${b.total_amount}  ${String(b.bill_date).slice(0, 10)}`).join('\n');
  throw new ConflictError(
    `"${trimmed}" matches ${found.rows.length} bills. Use the bill number:\n${list}`
  );
}

// ---------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------

export interface BillLineInput {
  account_id: string;
  item_id?: string | null;
  description?: string | null;
  quantity?: string | number;
  unit_price: string | number;
  tax_amount?: string | number;
  cost_center_id?: string | null;
  project_id?: string | null;
}

export interface CreateBillInput {
  entity_id: string;
  vendor_id: string;
  created_by: string;
  bill_date: string;
  due_date: string;
  lines: BillLineInput[];
  vendor_invoice_number?: string | null;
  currency_code?: string | null;
  terms?: string | null;
  description?: string | null;
  attachments?: unknown[];
}

export interface ComputedBillLine extends BillLineInput {
  line_number: number;
  quantity: string;
  unit_price: string;
  line_amount: string;
  tax_amount: string;
  total_amount: string;
}

export interface ComputedBill {
  lines: ComputedBillLine[];
  subtotal: string;
  tax_amount: string;
  total_amount: string;
}

/**
 * The arithmetic, alone and without a database: qty × price per line, tax
 * additive per line, and the header as the sum of its lines. Decimal all the
 * way — money never touches a float.
 */
export function computeBill(lines: BillLineInput[]): ComputedBill {
  if (!lines || lines.length === 0) {
    throw new ValidationError('A bill needs at least one line.', 'lines');
  }

  let subtotal = new Decimal(0);
  let taxAmount = new Decimal(0);

  const processed = lines.map((line, i) => {
    // `||`, not `??`: the route defaulted an absent OR empty quantity to 1 and
    // an absent OR empty tax to 0. With `??`, `quantity: ""` reaches Decimal
    // and throws where the API used to create the bill.
    const qty = new Decimal(line.quantity || 1);
    const price = new Decimal(line.unit_price);
    const lineAmount = qty.times(price);
    const lineTax = new Decimal(line.tax_amount || 0);
    const totalAmt = lineAmount.plus(lineTax);

    subtotal = subtotal.plus(lineAmount);
    taxAmount = taxAmount.plus(lineTax);

    return {
      ...line,
      line_number: i + 1,
      quantity: qty.toFixed(4),
      unit_price: price.toFixed(4),
      line_amount: lineAmount.toFixed(4),
      tax_amount: lineTax.toFixed(4),
      total_amount: totalAmt.toFixed(4),
    };
  });

  return {
    lines: processed,
    subtotal: subtotal.toFixed(4),
    tax_amount: taxAmount.toFixed(4),
    total_amount: subtotal.plus(taxAmount).toFixed(4),
  };
}

export async function createBill(input: CreateBillInput): Promise<Bill> {
  const computed = computeBill(input.lines);

  return withTransaction(async (client) => {
    const billNumber = await nextEntityNumber(client, input.entity_id, 'bill', 'BILL', input.bill_date);
    const billId = uuidv4();

    await client.query(
      `INSERT INTO bills (
        id, entity_id, bill_number, vendor_id, vendor_invoice_number,
        subtotal, tax_amount, total_amount, amount_due,
        currency_code, bill_date, due_date, status, description, terms,
        attachments, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14,$15,$16)`,
      [
        billId, input.entity_id, billNumber, input.vendor_id, input.vendor_invoice_number || null,
        computed.subtotal, computed.tax_amount, computed.total_amount, computed.total_amount,
        input.currency_code || 'USD', input.bill_date, input.due_date,
        input.description || null, input.terms || null,
        JSON.stringify(input.attachments || []), input.created_by,
      ]
    );

    for (const line of computed.lines) {
      await client.query(
        `INSERT INTO bill_lines (id, bill_id, line_number, account_id, item_id, description, quantity, unit_price, line_amount, tax_amount, total_amount, cost_center_id, project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          uuidv4(), billId, line.line_number, line.account_id, line.item_id || null,
          line.description || null, line.quantity, line.unit_price, line.line_amount,
          line.tax_amount, line.total_amount, line.cost_center_id || null, line.project_id || null,
        ]
      );
    }

    const result = await client.query<Bill>('SELECT * FROM bills WHERE id = $1', [billId]);
    return result.rows[0];
  });
}

// ---------------------------------------------------------------
// LINE CODING
// ---------------------------------------------------------------

export interface BillLinePatch {
  account_id?: string;
  cost_center_id?: string | null;
  project_id?: string | null;
  description?: string | null;
}

/**
 * Re-codes one line of a bill that has not been approved yet. Amounts are
 * deliberately absent: changing what a line costs changes the header and the
 * vendor's own document, which is `bill edit` — a command with no backend.
 * Coding, which is ours to decide, is the part that moves here.
 */
export async function setBillLine(
  billId: string,
  lineNumber: number,
  patch: BillLinePatch
): Promise<{ bill: Bill; line: BillLine }> {
  const fields = (['account_id', 'cost_center_id', 'project_id', 'description'] as const)
    .filter((f) => patch[f] !== undefined);
  if (fields.length === 0) {
    throw new ValidationError('Nothing to change: pass an account, a cost center, a project or a description.');
  }

  return withTransaction(async (client) => {
    const billResult = await client.query<Bill>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId]);
    if (billResult.rows.length === 0) throw new NotFoundError('Bill', billId);
    const bill = billResult.rows[0];

    if (!(EDITABLE_STATUSES as readonly string[]).includes(bill.status)) {
      throw new ValidationError(
        `Bill ${bill.bill_number} is "${bill.status}": its coding is already in the ledger. ` +
          'Re-coding a posted bill is a reclassification entry, not an edit.',
        'status'
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const field of fields) {
      sets.push(`${field} = $${i++}`);
      params.push(patch[field]);
    }
    params.push(billId, lineNumber);

    const updated = await client.query<BillLine>(
      `UPDATE bill_lines SET ${sets.join(', ')} WHERE bill_id = $${i++} AND line_number = $${i} RETURNING *`,
      params
    );
    if (updated.rows.length === 0) {
      throw new NotFoundError('Bill line', `${bill.bill_number} line ${lineNumber}`);
    }
    return { bill, line: updated.rows[0] };
  });
}

// ---------------------------------------------------------------
// APPROVAL — the ledger boundary
// ---------------------------------------------------------------

export interface ApproveBillResult {
  bill: Bill;
  /** Null when the bill was already posted or has a zero total. */
  entry: JournalEntry | null;
  entryLines: Array<Record<string, unknown>>;
  /** Fire attestEntryAsync with this AFTER the transaction commits. */
  attestation: { entityId: string; entryId: string } | null;
  /** True when everything above was computed and then rolled back. */
  dryRun: boolean;
}

/** Sentinel: the only way to leave a transaction with its work computed and undone. */
class DryRunRollback extends Error {
  constructor(readonly payload: Omit<ApproveBillResult, 'dryRun'>) {
    super('dry run');
    this.name = 'DryRunRollback';
  }
}

export interface ApproveBillOptions {
  /** Refuses to approve a bill belonging to another entity. The CLI always passes it. */
  entityId?: string;
  /** Compute the real entry, show it, write nothing. */
  dryRun?: boolean;
}

/**
 * Approves a bill and recognizes the liability in the same transaction:
 * DR expense per line + DR creditable IVA / CR accounts payable.
 *
 * Idempotent twice over: the UPDATE only matches a bill still in an
 * approvable status, and postBillEntry returns null when the bill already
 * carries a journal_entry_id.
 *
 * IVA IS NOW ON A CASH BASIS, and that is decided in the engine, not here.
 * For a Mexican entity postBillEntry reads the CFDI MetodoPago and sends a
 * PPD bill's IVA to `iva_pendiente_acreditar` (1135); it only reaches
 * `iva_acreditable` when a vendor payment applies the bill. A PUE bill is
 * creditable at once, as before. A bill with NO MetodoPago is treated as
 * PPD — the conservative reading, which cannot bring a credit forward —
 * and the entry says so in its description.
 *
 * REMAINING LIMIT: the release only fires through the vendor-payment path
 * that writes `payment_applications` (POST /v1/bills/payments). Paying a
 * bill by any other route leaves its IVA parked in 1135, where the monthly
 * return will under-credit rather than over-credit.
 */
export async function approveBill(
  id: string,
  userId: string,
  opts: ApproveBillOptions = {}
): Promise<ApproveBillResult> {
  const dryRun = opts.dryRun === true;
  try {
    const payload = await withTransaction(async (client) => {
      const params: unknown[] = [userId, id];
      let scope = '';
      if (opts.entityId) {
        params.push(opts.entityId);
        scope = ` AND entity_id = $${params.length}`;
      }
      const result = await client.query<Bill>(
        `UPDATE bills SET status = 'approved', approved_by = $1, approved_at = NOW()
         WHERE id = $2${scope} AND status IN ('draft', 'pending_approval') RETURNING *`,
        params
      );
      if (result.rows.length === 0) throw new NotFoundError('Bill', id);
      const approved = result.rows[0];

      const linesResult = await client.query<BillLine>(
        'SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number',
        [id]
      );
      const entry = await postBillEntry(client, approved, linesResult.rows, userId);

      let entryLines: Array<Record<string, unknown>> = [];
      if (entry) {
        const lines = await client.query(
          `SELECT l.line_number, a.code AS account_code, a.name AS account_name,
                  l.debit_amount, l.credit_amount, l.description
           FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
           WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
          [entry.id]
        );
        entryLines = lines.rows as Record<string, unknown>[];
      }

      // R1: aprobar la factura del proveedor deja su rastro propio — antes
      // sólo el asiento derivado quedaba auditado.
      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, approved.entity_id),
        userId,
        action: 'approve',
        entityType: 'bills',
        entityId: approved.id,
        oldValues: { status: 'draft' },
        newValues: {
          status: 'approved',
          bill_number: (approved as { bill_number?: string }).bill_number ?? null,
          journal_entry_id: entry?.id ?? null,
        },
      });

      const out = {
        bill: approved,
        entry,
        entryLines,
        attestation: entry ? { entityId: approved.entity_id, entryId: entry.id } : null,
      };
      // Everything above really happened; throwing is what undoes it. A
      // preview that ran the engine cannot disagree with the engine.
      if (dryRun) throw new DryRunRollback(out);
      return out;
    });
    return { ...payload, dryRun: false };
  } catch (err) {
    if (err instanceof DryRunRollback) return { ...err.payload, dryRun: true };
    throw err;
  }
}

// ---------------------------------------------------------------
// EARLY PAYMENT DISCOUNT
// ---------------------------------------------------------------

export interface DiscountResult {
  discountAmount: string;
  paymentAmount: string;
  applied: boolean;
}

/**
 * The `2/10 net 30` calculation the bills route did inline. Same rule, same
 * rounding: the discount applies when the payment lands within the discount
 * window counted from the bill date.
 *
 * Currently has no caller in src/. Its only one was POST /:id/schedule-payment,
 * withdrawn because it scheduled nothing; the arithmetic itself was never the
 * problem and is kept, tested, for whoever wires the real payment run. Its
 * destination is `discount_amount` on POST /v1/bills/payments — the call that
 * actually moves amount_due and posts the entry.
 */
export function earlyPaymentDiscount(
  bill: { amount_due: string; bill_date: Date | string; terms?: string | null },
  paymentDate: string
): DiscountResult {
  let paymentAmount = new Decimal(bill.amount_due);
  let discountAmount = new Decimal(0);
  let applied = false;

  const terms = parsePaymentTerms(bill.terms ?? '');
  if (terms.discountPct !== null && terms.discountDays !== null) {
    const daysUntilPayment = Math.floor(
      (new Date(paymentDate).getTime() - new Date(bill.bill_date).getTime()) / 86400000
    );
    if (daysUntilPayment <= terms.discountDays) {
      discountAmount = paymentAmount.times(terms.discountPct).dividedBy(100);
      paymentAmount = paymentAmount.minus(discountAmount);
      applied = true;
    }
  }

  return {
    discountAmount: discountAmount.toFixed(4),
    paymentAmount: paymentAmount.toFixed(4),
    applied,
  };
}
