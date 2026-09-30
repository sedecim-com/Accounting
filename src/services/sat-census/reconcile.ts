import { query } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { NotFoundError } from '../../utils/errors.js';
import { completenessTypes, type CfdiType } from './census.js';

// ============================================================
// THE SAT CENSUS AGAINST THE BOOKS (MNE-001-119, #312)
//
// The census (sat_cfdi_census, MNE-001-096) says what the SAT knows exists;
// this reads it against what the entity has brought in and what it has
// POSTED, per CFDI UUID, in a window of issue dates:
//
//   to_fetch          the SAT lists it; nothing of it is in the system
//   to_post           it was brought in (xml_documents) but no posted entry
//                     carries it
//   cancelled_booked  the SAT says cancelled and the books still carry it
//   surplus           the books carry it and the SAT census does not list it
//                     (only where a load covered that direction: see below)
//   matched           the SAT lists it and the books carry it
//
// «BOOKED» is a fact of the subledgers, not of the file: an invoice, credit
// note or vendor bill that carries the UUID and points at a POSTED entry, a
// payment that carries the UUID of its REP, or a payroll receipt of a pay run
// with a posted entry. Booked wins over fetched: an invoice this system
// stamped itself has no xml_documents row and is not «missing».
//
// A CANCELLED CFDI THAT WAS NEVER BOOKED IS NOT A GAP; it is only counted.
//
// COVERAGE. A census row says a CFDI exists; only the record of a load can say
// the SAT was asked. The SAT hands issued and received out separately, so a
// direction no load of the window covered (sat_census_loads: rows of that
// direction, dates overlapping the window) is reported as NOT LOADED and its
// surplus is not computed: «the SAT lists nothing issued» and «nobody loaded
// the issued» must not read the same.
//
// Surplus looks at invoices, credit notes (issued) and vendor bills
// (received): the documents whose date is the CFDI's. A payment's date is the
// cash date, not the CFDI's, so payments only ever MATCH.
// ============================================================

export const CENSUS_GAP_POLICY_KEY = 'census_missing_at_close';

export type Direction = 'issued' | 'received';

export interface CensusItem {
  uuid: string;
  direction: Direction;
  cfdiType: CfdiType;
  issuedAt: string;
  amount: string;
}

export interface SurplusItem {
  uuid: string;
  direction: Direction;
  source: 'invoice' | 'credit_note' | 'bill';
  date: string;
  amount: string;
}

export interface CensusReconciliation {
  from: string;
  to: string;
  types: readonly CfdiType[];
  /** Whether a load of the window covered each direction. */
  covered: Record<Direction, boolean>;
  /** The entity has loaded any census at all (opt-in signal for the close). */
  hasLoads: boolean;
  toFetch: CensusItem[];
  toPost: CensusItem[];
  cancelledBooked: CensusItem[];
  surplus: SurplusItem[];
  matched: number;
  cancelledUnbooked: number;
}

/**
 * Every UUID the books carry, with the direction and, where known, date and amount.
 * The rows only: each query names its own `booked AS (...)`, because the schema
 * contract test finds CTE names in the text of the query it scans.
 */
const BOOKED_ROWS = `
    SELECT lower(i.cfdi_uuid) AS u, 'issued' AS direction, 'invoice' AS source,
           i.invoice_date AS d, i.total_amount AS amount
      FROM invoices i
      JOIN journal_entries je ON je.id = i.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
     WHERE i.entity_id = $1 AND i.cfdi_uuid IS NOT NULL AND i.status NOT IN ('void', 'cancelled')
    UNION ALL
    SELECT lower(n.cfdi_uuid), 'issued', 'credit_note', n.credit_date, n.total_amount
      FROM credit_notes n
      JOIN journal_entries je ON je.id = n.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
     WHERE n.entity_id = $1 AND n.cfdi_uuid IS NOT NULL AND n.status <> 'void'
    UNION ALL
    SELECT lower(b.cfdi_uuid), 'received', 'bill', b.bill_date, b.total_amount
      FROM bills b
      JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
     WHERE b.entity_id = $1 AND b.cfdi_uuid IS NOT NULL AND b.status NOT IN ('void', 'cancelled')
    UNION ALL
    SELECT lower(p.cfdi_uuid), 'issued', 'payment', NULL, NULL
      FROM customer_payments p WHERE p.entity_id = $1 AND p.cfdi_uuid IS NOT NULL AND p.status <> 'reversed'
    UNION ALL
    SELECT lower(p.cfdi_uuid), 'received', 'payment', NULL, NULL
      FROM vendor_payments p WHERE p.entity_id = $1 AND p.cfdi_uuid IS NOT NULL AND p.status <> 'reversed'
    UNION ALL
    SELECT lower(pc.cfdi_uuid::text), 'issued', 'payroll', NULL, NULL
      FROM paychecks pc
      JOIN pay_runs r ON r.id = pc.pay_run_id AND r.tenant_id = $2
      JOIN journal_entries je ON je.id = r.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
     WHERE pc.tenant_id = $2 AND pc.cfdi_uuid IS NOT NULL
`;

const SQL_CENSUS = `
  WITH booked AS (${BOOKED_ROWS}),
  fetched AS (SELECT DISTINCT lower(cfdi_uuid) AS u FROM xml_documents WHERE entity_id = $1)
  SELECT c.cfdi_uuid::text AS uuid, c.direction, c.cfdi_type AS "cfdiType",
         to_char(c.issued_at, 'YYYY-MM-DD HH24:MI:SS') AS "issuedAt", c.amount::text AS amount,
         (c.sat_status = 'cancelled') AS cancelled,
         EXISTS (SELECT 1 FROM booked b WHERE b.u = c.cfdi_uuid::text) AS booked,
         EXISTS (SELECT 1 FROM fetched f WHERE f.u = c.cfdi_uuid::text) AS fetched
    FROM sat_cfdi_census c
    JOIN legal_entities le ON le.id = c.entity_id AND le.tenant_id = $2
   WHERE c.entity_id = $1 AND c.cfdi_type = ANY($5::text[])
     AND c.issued_at >= $3::date AND c.issued_at < ($4::date + 1)
   ORDER BY c.issued_at, c.cfdi_uuid`;

const SQL_SURPLUS = `
  WITH booked AS (${BOOKED_ROWS})
  SELECT b.u AS uuid, b.direction, b.source, to_char(b.d, 'YYYY-MM-DD') AS date, b.amount::text AS amount
    FROM booked b
    JOIN legal_entities le ON le.id = $1 AND le.tenant_id = $2
   WHERE b.d >= $3::date AND b.d <= $4::date
     AND NOT EXISTS (SELECT 1 FROM sat_cfdi_census c WHERE c.entity_id = $1 AND c.cfdi_uuid::text = b.u)
   ORDER BY b.d, b.u`;

const SQL_COVERAGE = `
  SELECT COALESCE(SUM(l.issued_count), 0)::int AS issued, COALESCE(SUM(l.received_count), 0)::int AS received,
         (SELECT count(*)::int FROM sat_census_loads WHERE entity_id = $1) AS loads
    FROM legal_entities le
    LEFT JOIN sat_census_loads l ON l.entity_id = le.id
         AND l.first_issued_at < ($4::date + 1) AND l.last_issued_at >= $3::date
   WHERE le.id = $1 AND le.tenant_id = $2
   GROUP BY le.id`;

/**
 * Reads the census of [from, to] (ISO dates, inclusive) against the books.
 * `types` defaults to the ones the panel says count (`census_cfdi_types`).
 */
export async function reconcileCensus(
  scope: EntityScope, from: string, to: string, types?: readonly CfdiType[]
): Promise<CensusReconciliation> {
  const counted = types ?? (await completenessTypes({ tenantId: scope.tenantId, entityId: scope.entityId }));
  const args = [scope.entityId, scope.tenantId, from, to];
  const [rows, coverage] = await Promise.all([
    query<CensusItem & { cancelled: boolean; booked: boolean; fetched: boolean }>(SQL_CENSUS, [...args, [...counted]]),
    query<{ issued: number; received: number; loads: number }>(SQL_COVERAGE, args),
  ]);
  if (coverage.rows.length === 0) throw new NotFoundError('Legal entity', scope.entityId);
  const covered: Record<Direction, boolean> = {
    issued: coverage.rows[0].issued > 0, received: coverage.rows[0].received > 0,
  };

  const out: CensusReconciliation = {
    from, to, types: counted, covered, hasLoads: coverage.rows[0].loads > 0,
    toFetch: [], toPost: [], cancelledBooked: [], surplus: [], matched: 0, cancelledUnbooked: 0,
  };
  for (const { cancelled, booked, fetched, ...item } of rows.rows) {
    if (cancelled) {
      if (booked) out.cancelledBooked.push(item);
      else out.cancelledUnbooked++;
    } else if (booked) out.matched++;
    else (fetched ? out.toPost : out.toFetch).push(item);
  }
  const surplus = await query<SurplusItem>(SQL_SURPLUS, args);
  out.surplus = surplus.rows.filter((s) => covered[s.direction]);
  return out;
}

/**
 * How a gap weighs at close, by direction. Only the literal `block` for that
 * direction blocks; a value the panel does not know warns, because an odd
 * value cannot freeze a firm's close (same rule as the other close boxes).
 */
export function severityOfCensusGap(policyValue: string, direction: Direction): 'blocking' | 'warning' {
  if (policyValue === 'both_block') return 'blocking';
  if (policyValue === 'issued_blocks' && direction === 'issued') return 'blocking';
  return 'warning';
}

/** The panel's answer for `census_missing_at_close`. */
export async function censusGapPolicy(ctx: PolicyContext): Promise<string> {
  return (await getPolicy(ctx, CENSUS_GAP_POLICY_KEY)).value;
}

/** What is wrong in one direction: everything the SAT lists or the books carry that does not agree. */
export function gapsOf(r: CensusReconciliation, direction: Direction): number {
  const of = (xs: { direction: Direction }[]): number => xs.filter((x) => x.direction === direction).length;
  return of(r.toFetch) + of(r.toPost) + of(r.cancelledBooked);
}
