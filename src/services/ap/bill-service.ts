import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { daysBetween, toCalendarDate } from '../../utils/calendar-date.js';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { AccountingError, ErrorCodes, NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { postBillEntry } from '../accounting/ar-ap-posting.js';
import { VAT_OVERCREDIT_CORRECTION_SOURCE } from '../accounting/iva-cash-basis.js';
import { reverseWithinTransaction } from '../accounting/posting.js';
import { getPolicy } from '../policy/policy-service.js';
import { todayFor } from '../policy/today.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../xml-ingestion/received-credit-note.js';
import { billCfdiPaidInCash, cashLimitFinding, type CashDeductibilityFinding } from './cash-deductibility.js';
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
  /** Percent, as `bill_lines.tax_rate` (066) stores it; null only when no amount carries it. */
  tax_rate: string | null;
  factor_type: 'tasa';
  /** The DIOT's value of the acts: the line amount, the base by construction. */
  acts_value: string;
}

/**
 * The VAT rate a manual line declares through the two amounts its author typed
 * (#284). The catalog rates win within one cent, the tolerance the DIOT uses to
 * measure the same thing; anything else is stored as the ratio itself, so an
 * off-catalog rate lands in the DIOT's own "other rates" box, visible.
 */
function rateOfLine(lineAmount: Decimal, tax: Decimal): string | null {
  if (tax.isZero()) return '0.00';
  if (lineAmount.lte(0)) return null;
  const cent = new Decimal('0.01');
  const known = [16, 8].find((r) => lineAmount.times(r).dividedBy(100).minus(tax).abs().lte(cent));
  return new Decimal(known ?? tax.dividedBy(lineAmount).times(100)).toFixed(2);
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
      tax_rate: rateOfLine(lineAmount, lineTax),
      factor_type: 'tasa' as const,
      acts_value: lineAmount.toFixed(4),
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
        `INSERT INTO bill_lines (id, bill_id, line_number, account_id, item_id, description, quantity, unit_price, line_amount, tax_amount, total_amount, cost_center_id, project_id,
           tax_rate, tipo_factor, valor_actos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          uuidv4(), billId, line.line_number, line.account_id, line.item_id || null,
          line.description || null, line.quantity, line.unit_price, line.line_amount,
          line.tax_amount, line.total_amount, line.cost_center_id || null, line.project_id || null,
          line.tax_rate, line.factor_type, line.acts_value,
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
  /**
   * MNE-001-345 · LISR art. 27 fr. III: the bill's CFDI says cash and the total
   * is above the limit in force on the bill date. Informative; the entry is
   * unchanged and the reviewer decides on the reclassification.
   */
  deductibilityFindings: CashDeductibilityFinding[];
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
  /**
   * The entity the bill must belong to. REQUIRED, and on purpose (TEN-11, #235).
   *
   * It used to be optional, documented as "the CLI always passes it" — and the
   * REST route didn't. `POST /v1/bills/:id/approve` called `approveBill(id,
   * userId)` with no options, so the UPDATE carried no entity at all: measured
   * against Postgres, a session granted only company A approved company B's
   * bill and left a POSTED journal entry in B's ledger, consuming B's first
   * folio. A unit test had pinned the omission as "the REST contract".
   *
   * A boundary parameter that is optional is one somebody forgets, and then
   * documents as the correct way to call. It is a named field, not a
   * positional one: `id` and `entityId` are both UUID strings and would swap
   * without the compiler noticing.
   */
  entityId: string;
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
 * For a Mexican entity postBillEntry sends a bill's IVA to
 * `iva_pendiente_acreditar` (1135), PUE or PPD (MNE-001-492); it only
 * reaches `iva_acreditable` when a vendor payment applies the bill. The
 * MetodoPago is still read and written into the entry's description; a
 * bill with NO MetodoPago is tagged PPD (assumed).
 *
 * REMAINING LIMIT: the release only fires through the vendor-payment path
 * that writes `payment_applications` (POST /v1/bills/payments). Paying a
 * bill by any other route leaves its IVA parked in 1135, where the monthly
 * return will under-credit rather than over-credit.
 */
export async function approveBill(
  id: string,
  userId: string,
  opts: ApproveBillOptions
): Promise<ApproveBillResult> {
  const dryRun = opts.dryRun === true;
  try {
    const payload = await withTransaction(async (client) => {
      // The entity predicate is ALWAYS there — no branch that builds it only
      // when an entity was given. If `entityId` ever arrives undefined, pg sends
      // NULL, `entity_id = NULL` matches nothing, and the caller gets a 404:
      // it fails closed instead of approving across the boundary.
      const result = await client.query<Bill>(
        `UPDATE bills SET status = 'approved', approved_by = $1, approved_at = NOW()
         WHERE id = $2 AND entity_id = $3 AND status IN ('draft', 'pending_approval') RETURNING *`,
        [userId, id, opts.entityId]
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
        legalEntityId: approved.entity_id,
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

      // A bill has no payment method of its own; the only one known at approval is
      // the CFDI's FormaPago. The parameter is read only when that says cash.
      const cfdiUuid = (approved as Bill & { cfdi_uuid?: string | null }).cfdi_uuid ?? null;
      const deductibilityFindings = (await billCfdiPaidInCash(client, approved.entity_id, cfdiUuid, approved.id))
        ? await cashLimitFinding(client, {
            entityId: approved.entity_id,
            billNumber: approved.bill_number,
            amount: approved.total_amount,
            currency: approved.currency_code,
            onDate: toCalendarDate(approved.bill_date),
            source: 'bill_approve',
            billIds: [approved.id],
            proposeDrafts: !dryRun,
          })
        : [];

      const out = {
        bill: approved,
        entry,
        entryLines,
        attestation: entry ? { entityId: approved.entity_id, entryId: entry.id } : null,
        deductibilityFindings,
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
// VOID — the way back across the ledger boundary (MNE-001-947, #1079)
// ---------------------------------------------------------------

/** Approved by hand or posted from the inbox, and owed whole: what `voidBill` accepts. */
export const VOIDABLE_STATUSES = ['approved', 'posted'] as const;
/** Panel key: the date of the mirror. Its only reader is `voidBill`. */
export const BILL_VOID_MIRROR_DATE_KEY = 'bill_void_mirror_date';

export interface VoidBillOptions {
  /** The entity the bill must belong to, inside the SQL: a sibling's bill answers as a missing one. */
  entityId: string;
  /** Why. It goes on the mirror's description and on the audit row. */
  reason: string;
  /** Post the real mirror, return it, write nothing. */
  dryRun?: boolean;
}

export interface VoidBillResult {
  bill: Bill;
  /** Null when the bill never posted (a zero total). `posted` is false when the entry had been reversed by hand. */
  mirror: { id: string; entryNumber: string; date: string; posted: boolean } | null;
  mirrorLines: Array<{ account_code: string; account_name: string; debit_amount: string | null; credit_amount: string | null }>;
  /** Fire attestEntryAsync with this AFTER the transaction commits. */
  attestation: { entityId: string; entryId: string } | null;
  dryRun: boolean;
}

class VoidDryRunRollback extends Error {
  constructor(readonly payload: Omit<VoidBillResult, 'dryRun'>) {
    super('dry run');
    this.name = 'VoidDryRunRollback';
  }
}

/**
 * Voids an approved bill that is owed whole, in one transaction: the mirror of
 * its entry (NIF B-1, a correction by reversal), the bill at `void` with 0.00
 * due, and its audit row. The twin of `voidInvoice`. It cancels nothing before
 * the SAT.
 *
 * The mirror takes back every line the bill's own entry posted: the expense,
 * the payable, the VAT parked in 1135 (PUE or PPD, MNE-001-492) and any IEPS
 * or withholding line that entry carries, in the mirror's month. Nothing a
 * payment posted is touched: a bill with a live application is refused, and
 * `payment unapply`, which the refusal names, puts back in 1135 the VAT that
 * payment released. A bill with another entry standing on it (a received
 * credit note, a VAT over-credit correction) is refused too, and so is one
 * born from the opening balance, whose entry is the whole opening's.
 * An entry somebody already reversed by hand gets no second mirror: the bill
 * is closed against the one that stands, which is what unblocks the close.
 *
 * THE DATE is the panel's (`bill_void_mirror_date`). `void_date`, the default:
 * today in the entity's zone. `bill_date`: the day of the bill's entry; when
 * no open period holds that day, the panel's closed-period key decides, and
 * only its current-period answer dates it today (`mirrorDay`). Never before
 * the entry it mirrors.
 */
export async function voidBill(id: string, userId: string, opts: VoidBillOptions): Promise<VoidBillResult> {
  if (!opts.reason.trim()) {
    throw new ValidationError({ key: 'error.VALIDATION_ERROR.schema.void_reason_required' }, 'reason');
  }
  try {
    const payload = await withTransaction(async (client) => {
      // The bill is locked inside its entity; the guards are read after the
      // lock, so they see what committed while this statement waited for it.
      const { rows: [found] } = await client.query<{
        bill_number: string; status: string; journal_entry_id: string | null; tenant_id: string;
      }>(
        `SELECT b.bill_number, b.status, b.journal_entry_id, le.tenant_id
           FROM bills b JOIN legal_entities le ON le.id = b.entity_id
          WHERE b.id = $1 AND b.entity_id = $2
            FOR UPDATE OF b`,
        [id, opts.entityId]
      );
      if (!found) throw new NotFoundError('Bill', id);
      const bill = found.bill_number;
      const { rows: [live] } = await client.query<{ applications: number; notes: number }>(
        `SELECT (SELECT count(*) FROM payment_applications pa
                  WHERE pa.bill_id = $1 AND pa.unapplied_at IS NULL)::int AS applications,
                (SELECT count(*) FROM journal_entries n
                  WHERE n.source_type = ANY($3::text[]) AND n.source_id = $1 AND n.entity_id = $2
                    AND n.status = 'posted' AND n.reversed_by_entry_id IS NULL)::int AS notes`,
        [id, opts.entityId, [VENDOR_CREDIT_NOTE_SOURCE, VAT_OVERCREDIT_CORRECTION_SOURCE]]
      );
      if (live.applications > 0 || live.notes > 0) {
        throw new ConflictError({ key: 'bill.void.settled', params: { bill, ...live } });
      }
      if (!(VOIDABLE_STATUSES as readonly string[]).includes(found.status)) {
        throw new ConflictError({ key: 'bill.void.not_voidable', params: { bill, status: found.status } });
      }

      const ctx = { tenantId: found.tenant_id, entityId: opts.entityId };
      let mirror: VoidBillResult['mirror'] = null;
      if (found.journal_entry_id) {
        // FOR UPDATE because reverseWithinTransaction expects the caller to hold it.
        const { rows: [entry] } = await client.query<JournalEntry>(
          'SELECT * FROM journal_entries WHERE id = $1 AND entity_id = $2 FOR UPDATE',
          [found.journal_entry_id, opts.entityId]
        );
        if (entry.source_type === 'opening_balance') {
          throw new ConflictError({ key: 'bill.void.opening', params: { bill } });
        }
        // A mirror somebody posted by hand, while it stands. One that was itself
        // reversed is not found, and the engine then refuses a second mirror.
        const { rows: [byHand] } = entry.reversed_by_entry_id
          ? await client.query<{ id: string; entry_number: string; day: string }>(
              `SELECT id, entry_number, to_char(entry_date, 'YYYY-MM-DD') AS day FROM journal_entries
                WHERE id = $1 AND entity_id = $2 AND status = 'posted' AND reversed_by_entry_id IS NULL`,
              [entry.reversed_by_entry_id, opts.entityId]
            )
          : { rows: [] };
        if (byHand) {
          mirror = { id: byHand.id, entryNumber: byHand.entry_number, date: byHand.day, posted: false };
        } else {
          const date = await mirrorDay(client, ctx, bill, toCalendarDate(entry.entry_date));
          const posted = await reverseWithinTransaction(
            client, entry, userId, `Bill ${bill} voided: ${opts.reason}`, date
          );
          mirror = { id: posted.id, entryNumber: posted.entry_number, date, posted: true };
        }
      }

      const voided = await client.query<Bill>(
        `UPDATE bills SET status = 'void', amount_due = 0, updated_at = NOW()
          WHERE id = $1 AND entity_id = $2 AND status = ANY($3::text[]) AND amount_paid = 0
          RETURNING *`,
        [id, opts.entityId, [...VOIDABLE_STATUSES]]
      );
      if (voided.rowCount !== 1) throw new ConflictError({ key: 'bill.void.race', params: { bill } });

      await registrarAuditoria(client, {
        tenantId: found.tenant_id, legalEntityId: opts.entityId, userId,
        action: 'void', entityType: 'bills', entityId: id,
        oldValues: { status: found.status },
        newValues: { status: 'void', bill_number: bill, reversal_entry_id: mirror?.id ?? null, mirror_date: mirror?.date ?? null },
        reason: opts.reason,
      });

      const lines = mirror
        ? await client.query<VoidBillResult['mirrorLines'][number]>(
            `SELECT a.code AS account_code, a.name AS account_name, l.debit_amount, l.credit_amount
               FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
              WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
            [mirror.id]
          )
        : null;
      const out = {
        bill: voided.rows[0],
        mirror,
        mirrorLines: lines?.rows ?? [],
        attestation: mirror?.posted ? { entityId: opts.entityId, entryId: mirror.id } : null,
      };
      if (opts.dryRun) throw new VoidDryRunRollback(out);
      return out;
    });
    return { ...payload, dryRun: false };
  } catch (err) {
    if (err instanceof VoidDryRunRollback) return { ...err.payload, dryRun: true };
    throw err;
  }
}

/** The day `voidBill` dates its mirror, by the panel; `entryDay` is the day of the entry it mirrors. */
async function mirrorDay(
  client: PoolClient, ctx: { tenantId: string; entityId: string }, bill: string, entryDay: string
): Promise<string> {
  const today = await todayFor(ctx, { client });
  const actDay = today < entryDay ? entryDay : today;
  if ((await getPolicy(ctx, BILL_VOID_MIRROR_DATE_KEY, client)).value !== 'bill_date') return actDay;
  // The engine's own predicate (createJournalEntry): a period that still takes postings.
  const open = await client.query(
    `SELECT 1 FROM fiscal_periods
      WHERE entity_id = $1 AND start_date <= $2::date AND end_date >= $2::date AND status NOT IN ('hard_close', 'locked')`,
    [ctx.entityId, entryDay]
  );
  if (open.rows.length > 0) return entryDay;
  if ((await getPolicy(ctx, 'cfdi_periodo_cerrado', client)).value === 'periodo_actual') return actDay;
  throw new AccountingError(ErrorCodes.PERIOD_CLOSED, { key: 'bill.void.closed_period', params: { bill, date: entryDay } });
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
    // #243 · El día se cuenta en el CALENDARIO, no restando milisegundos.
    // `paymentDate` es una cadena (medianoche UTC) y `bill.bill_date` el Date
    // que pg construye de una columna DATE (medianoche LOCAL): restarlos mezcla
    // dos orígenes que difieren en el desfase del huso. Medido con un gasto del
    // 1 de agosto, 2/10 Net 30, pagado el 12 —el día ONCE, fuera de ventana—:
    // UTC contestaba 11 y Mexico_City, Tijuana y New_York contestaban 10, y
    // concedían un descuento vencido del 2 %.
    const daysUntilPayment = daysBetween(bill.bill_date, paymentDate);
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
