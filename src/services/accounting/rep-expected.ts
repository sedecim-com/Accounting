import type pg from 'pg';
import { decideMetodoPago, type DocumentSide, type MetodoPagoDecision } from './iva-cash-basis.js';

// ============================================================
// MNE-001-125 (#327) · WHICH PAYMENTS OF A PERIOD ACTUALLY AWAIT A REP
//
// The close checklist used to count every non-void payment without a
// linked REP. That fired two false alerts:
//
//   · a collection of a PUE invoice ("cobro sin REP emitido"): a PUE
//     document is settled at issuance and never takes a REP;
//   · a supplier payment whose IVA the payment itself had already moved
//     1135 → 1130, reported as "IVA still parked in 1135".
//
// A REP is expected for a payment when its money MOVED (status completed)
// and at least one LIVE application settles a document the ledger treats
// as PPD. The method is decided by `decideMetodoPago`, the same pure
// function the posting path uses, over the same signals (the CFDI mirror,
// then the PUE/PPD token in terms or memo), so the checklist and the ledger
// can never disagree about whether a document was PUE.
//
// NOTE: unapplied payments are not counted. With no document behind them
// they are advances, and an advance is supported by a CFDI de anticipo, not
// by a REP; the application that eventually settles a PPD document makes
// the payment count from then on.
// ============================================================

/** Runs one scoped query; the close passes its own transaction-aware runner. */
export type RunQuery = <T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[]
) => Promise<{ rows: T[] }>;

/**
 * Whether one settled document makes its payment await a REP. Pure.
 *
 * - received: when the ledger treats the bill as PPD (the conservative
 *   default for a bill with no method is PPD, so doubt still counts).
 * - issued: only for a STAMPED invoice, because a REP relates to a CFDI
 *   and there is none to relate to otherwise. PPD counts; so does a stamped
 *   invoice whose method nothing states, listed with the doubt rather than
 *   hiding a REP that may be our own obligation.
 */
export function awaitsRep(side: DocumentSide, decision: MetodoPagoDecision, stamped: boolean): boolean {
  if (side === 'received') return decision.metodo === 'PPD';
  return stamped && (decision.metodo === 'PPD' || decision.assumed);
}

interface SettledDocumentRow {
  payment_id: string;
  cfdi_metodo: string | null;
  terms: string | null;
  memo: string | null;
  stamped: boolean;
  [column: string]: unknown;
}

const PERIOD_RANGE = `BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2 AND entity_id = $1)
                          AND (SELECT end_date   FROM fiscal_periods WHERE id = $2 AND entity_id = $1)`;

// The bill's CFDI method comes through the pre-registration that produced
// it, exactly as resolveBillMetodoPago reads it.
const RECEIVED_SQL = `
  SELECT vp.id AS payment_id, x.metodo_pago AS cfdi_metodo, b.terms, b.memo, true AS stamped
    FROM vendor_payments vp
    JOIN payment_applications pa ON pa.payment_id = vp.id AND pa.unapplied_at IS NULL
    JOIN bills b ON b.id = pa.bill_id AND b.entity_id = vp.entity_id
    LEFT JOIN LATERAL (
      SELECT xd.metodo_pago
        FROM pre_registrations p
        JOIN xml_documents xd ON xd.id = p.xml_document_id
       WHERE p.bill_id = b.id AND p.entity_id = vp.entity_id
       ORDER BY p.created_at DESC
       LIMIT 1) x ON true
   WHERE vp.entity_id = $1 AND vp.cfdi_uuid IS NULL AND vp.status = 'completed'
     AND vp.payment_date ${PERIOD_RANGE}`;

const ISSUED_SQL = `
  SELECT cp.id AS payment_id, x.metodo_pago AS cfdi_metodo, i.terms, i.memo,
         (i.cfdi_uuid IS NOT NULL) AS stamped
    FROM customer_payments cp
    JOIN payment_allocations pa ON pa.payment_id = cp.id AND pa.unapplied_at IS NULL
    JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = cp.entity_id
    LEFT JOIN LATERAL (
      SELECT xd.metodo_pago
        FROM xml_documents xd
       WHERE xd.cfdi_uuid = i.cfdi_uuid AND xd.entity_id = cp.entity_id
       LIMIT 1) x ON true
   WHERE cp.entity_id = $1 AND cp.cfdi_uuid IS NULL AND cp.status = 'completed'
     AND cp.payment_date ${PERIOD_RANGE}`;

async function countSide(
  runQuery: RunQuery,
  side: DocumentSide,
  entityId: string,
  periodId: string
): Promise<number> {
  const { rows } = await runQuery<SettledDocumentRow>(
    side === 'received' ? RECEIVED_SQL : ISSUED_SQL,
    [entityId, periodId]
  );
  const awaiting = new Set<string>();
  for (const row of rows) {
    const decision = decideMetodoPago(side, {
      cfdiMetodoPago: row.cfdi_metodo,
      terms: row.terms,
      memo: row.memo,
    });
    if (awaitsRep(side, decision, row.stamped)) awaiting.add(row.payment_id);
  }
  return awaiting.size;
}

/** Payments of the period still waiting for their REP: received from suppliers, issued by us. */
export async function countPaymentsAwaitingRep(
  runQuery: RunQuery,
  entityId: string,
  periodId: string
): Promise<{ received: number; issued: number }> {
  const received = await countSide(runQuery, 'received', entityId, periodId);
  const issued = await countSide(runQuery, 'issued', entityId, periodId);
  return { received, issued };
}
