import { query, withTransaction } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import { markInvoiceCfdiCancelled } from '../sat/cfdi-status.js';

// ============================================================
// THE SAT'S CANCELLATIONS, FROM THE CENSUS TO THE BOOKS (MNE-001-144, #441)
//
// The census (sat_cfdi_census) holds the SAT's metadata status of every CFDI
// it lists: Estatus 0 is `sat_status = 'cancelled'`. Before this file that
// status stayed in the census: the mirror (xml_documents) and the invoice
// learned a cancellation only from the one-by-one status query
// (src/services/sat/cfdi-status.ts). These functions take it from the census,
// for every CFDI of a window of issue dates, whatever load brought it:
//
//   markCensusCancellations   the mirror gets sat_validation_status
//                             'cancelled' and sat_estado 'Cancelado' in one
//                             guarded UPDATE, and each issued CFDI goes
//                             through the #313 bridge to its invoice,
//                             unchanged. The bridge is called from the census
//                             row, because an invoice this system stamped has
//                             no xml_documents row.
//   cancelledCfdiFindings     each cancelled CFDI of the window, of any type,
//                             that a posted invoice, credit note or bill still
//                             carries, named by that document. Computed on
//                             every run; nothing is stored and nothing is
//                             reversed: status, entry and balance are the
//                             accountant's call.
//
// The window is [from, to], ISO dates, inclusive, as reconcileCensus reads it.
// A mark is never undone here: a cancellation the SAT stated stays stated.
// Bills carry no CFDI status yet (#643): a received cancellation reaches the
// mirror and the finding, not the bill.
// ============================================================

export interface CancellationMarks {
  /** Mirror rows (xml_documents) this call marked cancelled. */
  mirror: number;
  /** Invoices the #313 bridge marked cfdi_status 'cancelled'. */
  invoices: number;
}

export interface CancelledCfdiFinding {
  source: 'invoice' | 'credit_note' | 'bill';
  /** The document's own number. */
  number: string;
  uuid: string;
  /** The document's date, YYYY-MM-DD. */
  date: string;
}

const CANCELLED_OF_WINDOW = `
    SELECT c.cfdi_uuid::text AS u, c.direction
      FROM sat_cfdi_census c
      JOIN legal_entities le ON le.id = c.entity_id AND le.tenant_id = $2
     WHERE c.entity_id = $1 AND c.sat_status = 'cancelled'
       AND c.issued_at >= $3::date AND c.issued_at < ($4::date + 1)`;

/**
 * Marks what the census of [from, to] says the SAT cancelled: the mirror,
 * then the invoice through the #313 bridge. A second call over the same
 * window moves nothing.
 */
export async function markCensusCancellations(
  scope: EntityScope, from: string, to: string
): Promise<CancellationMarks> {
  const args = [scope.entityId, scope.tenantId, from, to];

  const mirror = await withTransaction(async (client) => {
    const expected = await client.query<{ id: string }>(
      `SELECT x.id
         FROM xml_documents x
         JOIN (${CANCELLED_OF_WINDOW}) k ON k.u = lower(x.cfdi_uuid)
        WHERE x.entity_id = $1 AND x.sat_validation_status IS DISTINCT FROM 'cancelled'
        FOR UPDATE OF x`,
      args
    );
    if (expected.rows.length === 0) return 0;
    // Guarded (invariant 3): the entity and its tenant in the statement, the
    // state predicate that skips a row already cancelled, and the count of
    // the rows locked above.
    const marked = await client.query(
      `UPDATE xml_documents xd
          SET sat_validation_status = 'cancelled', sat_estado = 'Cancelado', updated_at = NOW()
         FROM (${CANCELLED_OF_WINDOW}) k
        WHERE xd.entity_id = $1 AND lower(xd.cfdi_uuid) = k.u
          AND xd.sat_validation_status IS DISTINCT FROM 'cancelled'`,
      args
    );
    if (marked.rowCount !== expected.rows.length) {
      throw new Error(`Census cancellation marked ${marked.rowCount} of ${expected.rows.length} mirror rows`);
    }
    return expected.rows.length;
  });

  const issued = await query<{ u: string }>(`${CANCELLED_OF_WINDOW} AND c.direction = 'issued' ORDER BY c.cfdi_uuid`, args);
  let invoices = 0;
  for (const row of issued.rows) {
    invoices += await markInvoiceCfdiCancelled(scope.entityId, row.u);
  }
  return { mirror, invoices };
}

/**
 * Every posted document that still carries a CFDI the census of [from, to]
 * says the SAT cancelled. «Posted» is what reconcile.ts calls booked: the
 * document points at a posted entry and is not void or cancelled in the books.
 */
export async function cancelledCfdiFindings(
  scope: EntityScope, from: string, to: string
): Promise<CancelledCfdiFinding[]> {
  const r = await query<CancelledCfdiFinding>(
    `WITH cancelled AS (${CANCELLED_OF_WINDOW}),
     carriers AS (
       SELECT 'invoice' AS source, i.invoice_number AS number, lower(i.cfdi_uuid) AS u, i.invoice_date AS d,
              'issued' AS direction
         FROM invoices i
         JOIN journal_entries je ON je.id = i.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
        WHERE i.entity_id = $1 AND i.cfdi_uuid IS NOT NULL AND i.status NOT IN ('void', 'cancelled')
       UNION ALL
       SELECT 'credit_note', n.credit_note_number, lower(n.cfdi_uuid), n.credit_date, 'issued'
         FROM credit_notes n
         JOIN journal_entries je ON je.id = n.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
        WHERE n.entity_id = $1 AND n.cfdi_uuid IS NOT NULL AND n.status <> 'void'
       UNION ALL
       SELECT 'bill', b.bill_number, lower(b.cfdi_uuid), b.bill_date, 'received'
         FROM bills b
         JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
        WHERE b.entity_id = $1 AND b.cfdi_uuid IS NOT NULL AND b.status NOT IN ('void', 'cancelled')
     )
     SELECT d.source, d.number, d.u AS uuid, to_char(d.d, 'YYYY-MM-DD') AS date
       FROM carriers d
       JOIN cancelled k ON k.u = d.u AND k.direction = d.direction
      ORDER BY d.d, d.number`,
    [scope.entityId, scope.tenantId, from, to]
  );
  return r.rows;
}
