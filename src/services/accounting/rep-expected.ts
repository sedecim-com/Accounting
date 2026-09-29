import type pg from 'pg';
import { decideMetodoPago, type DocumentSide, type MetodoPagoDecision } from './iva-cash-basis.js';
import { keepsMexicanBooks } from '../jurisdiction/jurisdiction.js';

// ============================================================
// MNE-001-125 (#327) · WHICH PAYMENTS ACTUALLY AWAIT A REP
//
// The close checklist used to count every non-void payment without a
// linked REP. That fired two false alerts:
//
//   · a collection of a PUE invoice ("cobro sin REP emitido"): a PUE
//     document is settled at issuance and never takes a REP;
//   · a supplier payment reported as "IVA still parked in 1135", when the
//     payment itself releases the parked IVA to 1130.
//
// A REP is expected for a payment when its money MOVED (status completed)
// and at least one LIVE application settles a document the ledger treats
// as PPD. The method is decided by `decideMetodoPago`, the same pure
// function the posting path uses, over the same signals (the CFDI mirror,
// then the PUE/PPD token in terms or memo). Including its conservative
// default: a received bill with no method is PPD for the ledger, so it
// awaits a REP here too; an issued invoice with no method is PUE for the
// ledger (its IVA was recognized at issuance), so it does NOT await one
// here. That second case is not hidden either: it comes back in
// `unknownIssuedMethod`, so the close can say "the method is unknown"
// instead of asserting a REP obligation the ledger does not believe in.
//
// Collections only count on an invoice whose CFDI is really stamped
// (cfdi_status 'stamped'): a simulated stamp ('failed') or a cancelled
// CFDI keeps a uuid but there is no live CFDI to relate a REP to.
//
// Unapplied payments are not counted. With no document behind them they
// are advances, and an advance is supported by a CFDI de anticipo, not by
// a REP; the application that settles a PPD document makes the payment
// count from then on.
//
// The REP is a Mexican CFDI concept: an entity that does not keep Mexican
// books expects none, whatever its payments look like.
//
// ONE SOURCE: the close count (`getPeriodCloseStatus`), its explain output
// (`closing explain rep-missing`) and `rep missing list` all read this
// module, so the box and the two commands it points to cannot drift.
// ============================================================

/** Runs one scoped query; the close passes its own transaction-aware runner. */
export type RunQuery = <T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[]
) => Promise<{ rows: T[] }>;

/** One payment that awaits (or may await) a REP. Money as a string. */
export interface PaymentAwaitingRep {
  payment_id: string;
  direction: DocumentSide;
  payment_number: string;
  payment_date: string;
  counterparty: string;
  amount: string;
  currency_code: string;
  age_days: number;
  /** 'PPD' when a fact says so; 'desconocido' when the conservative default decided. */
  method: 'PPD' | 'desconocido';
}

export interface RepExpectation {
  /** Payments the ledger's own reading says await a REP. */
  awaiting: PaymentAwaitingRep[];
  /**
   * Collections of stamped invoices whose method nothing states: the ledger
   * treated them as PUE, so they are not counted, but if one was PPD its REP
   * is our own obligation.
   */
  unknownIssuedMethod: PaymentAwaitingRep[];
}

/** How a settled document bears on its payment's REP. Pure. */
export type RepVerdict = 'awaits' | 'unknown_method' | 'none';

/**
 * - received: awaits when the ledger treats the bill as PPD (stated or by
 *   the conservative default).
 * - issued: only a STAMPED invoice can take a REP. A stated PPD awaits one;
 *   no stated method is `unknown_method` (the ledger assumed PUE).
 */
export function repVerdict(side: DocumentSide, decision: MetodoPagoDecision, stamped: boolean): RepVerdict {
  if (side === 'received') return decision.metodo === 'PPD' ? 'awaits' : 'none';
  if (!stamped) return 'none';
  if (decision.assumed) return 'unknown_method';
  return decision.metodo === 'PPD' ? 'awaits' : 'none';
}

interface SettledDocumentRow {
  payment_id: string;
  payment_number: string;
  payment_date: string;
  counterparty: string;
  amount: string;
  currency_code: string;
  age_days: number;
  cfdi_metodo: string | null;
  terms: string | null;
  memo: string | null;
  stamped: boolean;
  [column: string]: unknown;
}

const PERIOD_FILTER = (alias: string) =>
  `AND ${alias}.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2 AND entity_id = $1)
                                AND (SELECT end_date   FROM fiscal_periods WHERE id = $2 AND entity_id = $1)`;

// The bill's CFDI method comes through the pre-registration that produced
// it, exactly as resolveBillMetodoPago reads it.
const RECEIVED_SQL = (period: string) => `
  SELECT vp.id AS payment_id, vp.payment_number, vp.payment_date::text AS payment_date,
         v.company_name AS counterparty, vp.payment_amount::text AS amount, vp.currency_code,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - vp.payment_date)) / 86400)::int AS age_days,
         x.metodo_pago AS cfdi_metodo, b.terms, b.memo, true AS stamped
    FROM vendor_payments vp
    JOIN vendors v ON v.id = vp.vendor_id
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
     ${period}
   ORDER BY vp.payment_date, vp.payment_number`;

const ISSUED_SQL = (period: string) => `
  SELECT cp.id AS payment_id, cp.payment_number, cp.payment_date::text AS payment_date,
         c.company_name AS counterparty, cp.payment_amount::text AS amount, cp.currency_code,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - cp.payment_date)) / 86400)::int AS age_days,
         x.metodo_pago AS cfdi_metodo, i.terms, i.memo,
         (i.cfdi_status = 'stamped') AS stamped
    FROM customer_payments cp
    JOIN customers c ON c.id = cp.customer_id
    JOIN payment_allocations pa ON pa.payment_id = cp.id AND pa.unapplied_at IS NULL
    JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = cp.entity_id
    LEFT JOIN LATERAL (
      SELECT xd.metodo_pago
        FROM xml_documents xd
       WHERE xd.cfdi_uuid = i.cfdi_uuid AND xd.entity_id = cp.entity_id
       LIMIT 1) x ON true
   WHERE cp.entity_id = $1 AND cp.cfdi_uuid IS NULL AND cp.status = 'completed'
     ${period}
   ORDER BY cp.payment_date, cp.payment_number`;

async function readSide(
  runQuery: RunQuery,
  side: DocumentSide,
  entityId: string,
  periodId: string | undefined
): Promise<RepExpectation> {
  const alias = side === 'received' ? 'vp' : 'cp';
  const period = periodId === undefined ? '' : PERIOD_FILTER(alias);
  const sql = side === 'received' ? RECEIVED_SQL(period) : ISSUED_SQL(period);
  const params = periodId === undefined ? [entityId] : [entityId, periodId];
  const { rows } = await runQuery<SettledDocumentRow>(sql, params);

  // A payment may settle several documents: the strongest verdict wins
  // (awaits > unknown_method > none), and a stated PPD beats a default.
  const byPayment = new Map<string, { row: SettledDocumentRow; verdict: RepVerdict; stated: boolean }>();
  const rank: Record<RepVerdict, number> = { none: 0, unknown_method: 1, awaits: 2 };
  for (const row of rows) {
    const decision = decideMetodoPago(side, { cfdiMetodoPago: row.cfdi_metodo, terms: row.terms, memo: row.memo });
    const verdict = repVerdict(side, decision, row.stamped);
    const stated = verdict === 'awaits' && !decision.assumed;
    const seen = byPayment.get(row.payment_id);
    if (!seen) {
      byPayment.set(row.payment_id, { row, verdict, stated });
      continue;
    }
    if (rank[verdict] > rank[seen.verdict]) seen.verdict = verdict;
    seen.stated ||= stated;
  }

  const result: RepExpectation = { awaiting: [], unknownIssuedMethod: [] };
  for (const { row, verdict, stated } of byPayment.values()) {
    if (verdict === 'none') continue;
    const payment: PaymentAwaitingRep = {
      payment_id: row.payment_id,
      direction: side,
      payment_number: row.payment_number,
      payment_date: row.payment_date,
      counterparty: row.counterparty,
      amount: row.amount,
      currency_code: row.currency_code,
      age_days: Number(row.age_days),
      method: stated ? 'PPD' : 'desconocido',
    };
    (verdict === 'awaits' ? result.awaiting : result.unknownIssuedMethod).push(payment);
  }
  return result;
}

/**
 * The payments without a REP, from both sides. With `periodId`, only the
 * payments dated inside that period of the entity (the close's view);
 * without it, every pending one (`rep missing list`).
 */
export async function listPaymentsAwaitingRep(
  runQuery: RunQuery,
  entityId: string,
  scope: { periodId?: string } = {}
): Promise<RepExpectation> {
  const entity = await runQuery<{ incorporation_country: string; accounting_standard: string }>(
    'SELECT incorporation_country, accounting_standard FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const row = entity.rows[0];
  if (!row || !keepsMexicanBooks(row.incorporation_country, row.accounting_standard)) {
    return { awaiting: [], unknownIssuedMethod: [] };
  }
  const received = await readSide(runQuery, 'received', entityId, scope.periodId);
  const issued = await readSide(runQuery, 'issued', entityId, scope.periodId);
  return {
    awaiting: [...received.awaiting, ...issued.awaiting],
    unknownIssuedMethod: issued.unknownIssuedMethod,
  };
}

/**
 * What the CLOSE watches, given the firm's `rep_faltante_recibido` answer:
 * with 'no_vigilar' the supplier side is not a close item (the payment
 * already credited the IVA; chasing the REP is left to `rep missing list`).
 * Shared by the checklist and `closing explain` so both drop the same rows.
 */
export function watchedAtClose(
  expectation: RepExpectation,
  receivedPolicy: unknown
): PaymentAwaitingRep[] {
  if (receivedPolicy !== 'no_vigilar') return expectation.awaiting;
  return expectation.awaiting.filter((p) => p.direction !== 'received');
}
