import { query } from '../../database/connection.js';

/**
 * THE SAT'S WORD REACHES THE BILL (MNE-001-431, #643).
 *
 * When the SAT reports a CFDI as «Cancelado», the bill of the entity that
 * carries its UUID gets `cfdi_cancellation_noted_at` (migration 340): the
 * moment this system learned it. The bill's counterpart of the #313 invoice
 * bridge (`markInvoiceCfdiCancelled`, src/services/sat/cfdi-status.ts), called
 * right after it by every path that marks the mirror or the census: the census
 * marks (src/services/sat-census/cancellations.ts), the `cfdi status sync`
 * sweep and validateAndUpdate.
 *
 * Guarded UPDATE (invariant 3): the entity in the statement and a predicate
 * that skips a bill already marked, so the same cancellation again moves zero
 * rows and a mark never reverts. The UUID is compared by lower(), because the
 * mirror and bills keep the XML's letter case and the census reads back lower
 * case. Zero rows is a legitimate answer: most CFDI have no bill. The count is
 * returned so the caller reports what moved.
 *
 * It does not touch status, amount_due, the entry or the balance: what the
 * cancelled CFDI means for the books is the accountant's call.
 */
export async function markBillCfdiCancelled(entityId: string, cfdiUuid: string): Promise<number> {
  const r = await query(
    `UPDATE bills
        SET cfdi_cancellation_noted_at = NOW(), updated_at = NOW()
      WHERE entity_id = $1
        AND lower(cfdi_uuid) = lower($2)
        AND cfdi_cancellation_noted_at IS NULL`,
    [entityId, cfdiUuid]
  );
  return r.rowCount ?? 0;
}
