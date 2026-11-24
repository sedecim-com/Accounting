import { query } from '../../database/connection.js';
import type { Queryable } from '../../utils/sequence.js';

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

/**
 * A BILL BORN FROM A CFDI ALREADY CANCELLED (MNE-001-601, #643).
 *
 * The bridge above looks for a bill that exists when the cancellation
 * arrives. When the mirror or the census of the same entity already reports
 * the CFDI cancelled and the bill comes after (the census said so first, the
 * background check that ingest starts answered before the bill was written,
 * a draft approved later, an opening bill), this is called on the bill's own
 * transaction, right after it is written, so the mark is part of its birth.
 * The takeover of an opening bill calls it too, after it drops the mark of a
 * UUID the bill no longer carries, so the bill is measured again against the
 * new one.
 *
 * Guarded UPDATE (invariant 3): the bill and its entity in the statement, the
 * mark only when there is none, and the mirror and the census read within the
 * bill's own entity, matched as migration 340's backfill matches them. A bill
 * with no cfdi_uuid never matches. By id it moves 0 or 1 rows, and that is
 * checked. It does not touch status, amount_due, the entry or the balance.
 */
export async function noteBillCfdiAlreadyCancelled(db: Queryable, entityId: string, billId: string): Promise<number> {
  const r = await db.query(
    `UPDATE bills b
        SET cfdi_cancellation_noted_at = NOW()
      WHERE b.id = $2
        AND b.entity_id = $1
        AND b.cfdi_cancellation_noted_at IS NULL
        AND (EXISTS (SELECT 1 FROM xml_documents x
                      WHERE x.entity_id = b.entity_id
                        AND lower(x.cfdi_uuid) = lower(b.cfdi_uuid)
                        AND x.sat_validation_status = 'cancelled')
          OR EXISTS (SELECT 1 FROM sat_cfdi_census c
                      WHERE c.entity_id = b.entity_id
                        AND c.cfdi_uuid::text = lower(b.cfdi_uuid)
                        AND c.sat_status = 'cancelled'))`,
    [entityId, billId]
  );
  const moved = r.rowCount ?? 0;
  if (moved > 1) throw new Error(`The cancellation mark of bill ${billId} moved ${moved} rows; it must move at most one.`);
  return moved;
}
