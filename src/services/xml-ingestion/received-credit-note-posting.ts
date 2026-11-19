import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { JournalEntryType, type JournalEntry } from '../../types/index.js';
import { toCalendarDate } from '../../utils/calendar-date.js';
import { AccountingError, NotFoundError } from '../../utils/errors.js';
import { attestEntryAsync, createJournalEntry } from '../accounting/posting.js';
import { entityUsesCashBasisIva, receivedVatStillParked, reclassRoles } from '../accounting/iva-cash-basis.js';
import { getPolicy } from '../policy/policy-service.js';
import { CFDIParser } from './cfdi-parser.js';
import { extractFacts } from './cfdi-facts.js';
import {
  PAYABLE, VENDOR_CREDIT_NOTE_SOURCE, noteVat, refusalOf, splitNoteVat, spreadCost,
  type ReceivedCreditNoteCost, type RelatedBill,
} from './received-credit-note.js';

// NOTE: its own file, not received-credit-note.ts: the lists of AP and of parked
// VAT import that module's source type, and these imports would close a cycle
// that leaves the lists without it.

/**
 * Posts the note of a pre-registration against the one bill it names, in one
 * transaction: the entry (source `vendor_credit_note`, the bill as its
 * `source_id`, the note's UUID as its `reference`) and the bill's balance.
 * Run again, it returns the entry it already posted and writes nothing.
 */
export async function postReceivedCreditNote(
  preReg: { entity_id: string; xml_document_id: string; document_date: Date | string },
  userId: string
): Promise<JournalEntry> {
  const entityId = preReg.entity_id;
  const { rows: [source] } = await query<{ xml_content: string | null; tax_id: string; tenant_id: string; currency: string }>(
    `SELECT x.xml_content, e.tax_id, e.tenant_id, e.functional_currency AS currency
       FROM xml_documents x JOIN legal_entities e ON e.id = x.entity_id
      WHERE x.id = $1 AND x.entity_id = $2`,
    [preReg.xml_document_id, entityId]
  );
  if (!source?.xml_content) throw new NotFoundError('XML of the credit note', preReg.xml_document_id);
  const note = extractFacts(new CFDIParser().parse(source.xml_content), source.tax_id);
  const ctx = { tenantId: source.tenant_id, entityId };

  const { entry, posted } = await withTransaction(async (client) => {
    // The lock serialises two runs of the same note: the second finds the entry of the first.
    const { rows: bills } = await client.query<RelatedBill & { id: string }>(
      `SELECT b.id, b.bill_number AS "billNumber", v.tax_id AS "vendorRfc", b.status, b.currency_code AS currency,
              b.currency_code <> $3 AS "foreignCurrency", b.amount_due::text AS "amountDue",
              b.tax_amount::text AS "taxAmount", b.total_amount::text AS "totalAmount",
              EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.bill_id = b.id AND pa.unapplied_at IS NULL
                         AND pa.iva_reclass_amount IS NULL) AS "hasApplicationWithoutRelease",
              (SELECT COALESCE(json_agg(json_build_object('accountId', bl.account_id, 'amount', bl.line_amount::text,
                        'roles', ARRAY(SELECT ar.role FROM account_roles ar
                                        WHERE ar.entity_id = b.entity_id AND ar.account_id = bl.account_id))), '[]'::json)
                 FROM bill_lines bl WHERE bl.bill_id = b.id) AS lines
         FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
        WHERE b.entity_id = $1 AND upper(b.cfdi_uuid) = ANY($2::text[]) FOR UPDATE OF b`,
      [entityId, note.uuidsRelacionados.map((uuid) => uuid.toUpperCase()), source.currency]
    );
    const [bill] = bills;
    const already = bills.length !== 1 ? null : await client.query<JournalEntry>(
      `SELECT * FROM journal_entries
        WHERE entity_id = $1 AND source_type = $2 AND source_id = $3 AND reference = $4 AND status = 'posted'`,
      [entityId, VENDOR_CREDIT_NOTE_SOURCE, bill.id, note.uuid]
    );
    if (already?.rows[0]) return { entry: already.rows[0], posted: false };
    const refusal = refusalOf(note, bills);
    if (refusal) throw new AccountingError('CFDI_REQUIERE_DECISION', refusal);

    // A note of a closed month reads the same key a bill does: only `periodo_actual` dates the entry today.
    const noteDay = toCalendarDate(preReg.document_date);
    const open = await client.query(
      `SELECT 1 FROM fiscal_periods
        WHERE entity_id = $1 AND start_date <= $2 AND end_date >= $2 AND status NOT IN ('hard_close', 'locked')`,
      [entityId, noteDay]
    );
    const today = open.rows.length === 0;
    if (today && (await getPolicy(ctx, 'cfdi_periodo_cerrado', client)).value !== 'periodo_actual') {
      throw new AccountingError('CFDI_REQUIERE_DECISION', {
        key: 'credit_note.received.closed_period', params: { note: note.uuid, date: noteDay },
      });
    }

    const vat = noteVat(note);
    // NOTE: an entity that does not keep Mexican books parks nothing, so its whole VAT leaves the creditable role.
    const cashBasis = await entityUsesCashBasisIva(client, entityId);
    const split = splitNoteVat(vat, cashBasis ? await receivedVatStillParked(client, entityId, bill.id) : 0);
    const policy = (await getPolicy(ctx, 'received_credit_note_cost', client)).value as ReceivedCreditNoteCost;
    const { from: pending, to: creditable } = reclassRoles('received');
    const roles = await client.query<{ role: string; account_id: string }>(
      `SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL AND role = ANY($2::text[])`,
      [entityId, ['cxp', pending, creditable, 'devolucion_compras']]
    );
    const accountOf = (role: string): string => {
      const account = roles.rows.find((row) => row.role === role);
      if (!account) throw new AccountingError('MISSING_ROLE_ACCOUNT', `The entity has no account with the role ${role}.`);
      return account.account_id;
    };
    const description = `Credit note ${note.uuid} on bill ${bill.billNumber}` +
      (today ? ` (note of ${noteDay}, posted today under cfdi_periodo_cerrado=periodo_actual)` : '');
    const credits = [
      { role: pending, amount: split.fromPending },
      { role: creditable, amount: split.fromCreditable },
      ...spreadCost(new Decimal(note.total).minus(vat), bill.lines, policy),
    ].filter((credit) => new Decimal(credit.amount).greaterThan(0));
    const total = new Decimal(note.total).toFixed(4);
    const entry = await createJournalEntry(
      entityId, today ? new Date() : noteDay, JournalEntryType.AUTO_BILL, description,
      [
        { account_id: accountOf('cxp'), debit_amount: total, credit_amount: null, description },
        ...credits.map((credit) => ({
          account_id: 'accountId' in credit ? credit.accountId : accountOf(credit.role),
          debit_amount: null, credit_amount: credit.amount, description,
        })),
      ],
      userId,
      { sourceType: VENDOR_CREDIT_NOTE_SOURCE, sourceId: bill.id, reference: note.uuid, autoPost: true, client }
    );
    // No cash was paid, so amount_paid stays; the guard is the WHERE (the row is locked, so it holds).
    const lowered = await client.query(
      `UPDATE bills SET amount_due = amount_due - $1, updated_at = NOW(),
              status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE status END
        WHERE id = $2 AND entity_id = $3 AND status = ANY($4::text[]) AND amount_due >= $1`,
      [total, bill.id, entityId, PAYABLE]
    );
    if (lowered.rowCount !== 1) throw new AccountingError('BILL_CHANGED', `Bill ${bill.billNumber} changed under its credit note; nothing was written.`);
    return { entry, posted: true };
  });
  // The transaction is this function's, so the attestation is too: only after the commit is the entry there.
  if (posted) attestEntryAsync(source.tenant_id, entityId, entry.id);
  return entry;
}
