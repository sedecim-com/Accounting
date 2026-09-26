import { query } from '../../database/connection.js';
import type { JwtPayload } from '../../types/index.js';
import { UnauthorizedError, ValidationError } from '../../utils/errors.js';

// ============================================================
// THE FIRM PORTFOLIO (W1 · issue #117)
//
// One row per legal entity the caller may read: its current period, how many
// ended periods are still open, and how many AI drafts and questions wait on a
// person. It is the first screen of the browser board, and the only
// cross-entity read of the API.
//
// WHICH ENTITIES. The token's granted entities, intersected with the token's
// tenant, inside the SQL (AGENTS.md invariant 4). The tenant is the firm: no
// firm object is invented, and a different answer to that product question
// would only change where the entity set comes from, not this boundary.
//
// Two things never choose the set, and both are under behavioural mutants in
// src/plan/conducta.ts (portfolio-rows-are-token-entities-within-tenant):
//
//   · The request. `x-entity-id` (resolved into req.entityId), route params,
//     the body and the query string neither narrow nor widen it. A query key
//     is refused outright rather than ignored, so nobody starts relying on a
//     selector that does nothing.
//   · Row-level security. The integration suite and the conduct scenario run
//     as superuser, where RLS is inert; the predicate below is the boundary
//     that is always there. `accessible_entities` has no foreign key, so a
//     token can name an entity of another tenant, and only
//     `e.tenant_id = $2` keeps it out.
//
// The counts use the predicates of the CLI pending board
// (src/ai/pending-service.ts), so a figure here can be checked against the
// board entity by entity. `ended_open_periods` counts status 'open' only, as
// the board does; soft_close is not counted, and the name says so. The close
// engine's own definition (open plus soft_close) is a different question.
//
// Deliberately absent: tax_id, credential expiry and queued external ops (no
// /v1 route exposes them today, so each would be new exposure), and close
// readiness (it needs periods:close and runs per period).
// ============================================================

/** A UUID in its textual form. Anything else cannot be bound as uuid[]. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parts of a request the portfolio may read. Express's Request satisfies it. */
export interface PortfolioRequest {
  user?: Pick<JwtPayload, 'tenant_id' | 'entities'>;
  query?: object;
}

/** The scope of one portfolio read, derived only from the verified token. */
export interface PortfolioCaller {
  tenantId: string;
  /** Distinct, lowercased, UUID-shaped entity ids from the token. */
  entityIds: string[];
  /** Token entity ids that are not UUIDs and were dropped before the query. */
  malformed: number;
}

export interface PortfolioPeriod {
  id: string;
  name: string;
  status: string;
  start_date: string;
  end_date: string;
}

export interface PortfolioRow {
  entity_id: string;
  name: string;
  is_active: boolean;
  /** The latest regular period that has started by as_of_date, or null. */
  current_period: PortfolioPeriod | null;
  /** Periods with status 'open' whose end_date is before as_of_date. */
  ended_open_periods: number;
  /** ai_drafts with status 'pending_review'. */
  pending_drafts: number;
  /** ai_questions with status 'pending'. */
  pending_questions: number;
}

export interface Portfolio {
  rows: PortfolioRow[];
  /** The database's CURRENT_DATE, read in the same statement, YYYY-MM-DD. */
  asOfDate: string;
  /** Token entity ids that produced no row: malformed, unknown or of another tenant. */
  unresolved: number;
}

/**
 * The portfolio scope of a request: the token's tenant and entities, nothing
 * else.
 *
 * It never reads `entityId`, headers, params or the body. A query string with
 * any key is a 422, because the set is not selectable.
 */
export function portfolioCallerOf(request: PortfolioRequest): PortfolioCaller {
  if (!request.user) {
    throw new UnauthorizedError();
  }
  if (Object.keys(request.query ?? {}).length > 0) {
    throw new ValidationError(
      'GET /v1/portfolio takes no query parameters: the portfolio is the entities your token grants'
    );
  }
  const tenantId = request.user.tenant_id;
  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    throw new UnauthorizedError('The token carries no valid tenant');
  }
  const requested = request.user.entities;
  const ids = Array.isArray(requested) ? requested : [];
  const wellFormed = ids.filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id));
  return {
    tenantId: tenantId.toLowerCase(),
    entityIds: [...new Set(wellFormed.map((id) => id.toLowerCase()))],
    malformed: ids.length - wellFormed.length,
  };
}

interface PortfolioRecord {
  as_of_date: string;
  entity_id: string | null;
  name: string;
  is_active: boolean;
  current_period_id: string | null;
  current_period_name: string | null;
  current_period_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  ended_open_periods: number;
  pending_drafts: number;
  pending_questions: number;
}

/**
 * One read-only, set-based statement for the whole portfolio.
 *
 * The LEFT JOIN from `today` guarantees as_of_date even when the token grants
 * nothing that resolves; that lone row has a null entity_id and is dropped
 * here. Child counts are correlated on the verified entity row, with a tenant
 * check on the tables that carry tenant_id (fiscal_periods has none, so it is
 * scoped through `e`).
 */
export async function listPortfolio(caller: PortfolioCaller): Promise<Portfolio> {
  const result = await query<PortfolioRecord>(
    `WITH today AS (SELECT CURRENT_DATE AS as_of)
     SELECT to_char(t.as_of, 'YYYY-MM-DD') AS as_of_date,
            e.id AS entity_id,
            e.name,
            e.is_active,
            cp.id AS current_period_id,
            cp.period_name AS current_period_name,
            cp.status AS current_period_status,
            to_char(cp.start_date, 'YYYY-MM-DD') AS current_period_start,
            to_char(cp.end_date, 'YYYY-MM-DD') AS current_period_end,
            (SELECT count(*) FROM fiscal_periods fp
              WHERE fp.entity_id = e.id AND fp.status = 'open'
                AND fp.end_date < t.as_of)::int AS ended_open_periods,
            (SELECT count(*) FROM ai_drafts d
              WHERE d.entity_id = e.id AND d.tenant_id = e.tenant_id AND d.status = 'pending_review')::int AS pending_drafts,
            (SELECT count(*) FROM ai_questions q
              WHERE q.entity_id = e.id AND q.tenant_id = e.tenant_id AND q.status = 'pending')::int AS pending_questions
       FROM today t
       LEFT JOIN legal_entities e ON e.id = ANY($1::uuid[]) AND e.tenant_id = $2
       LEFT JOIN LATERAL (
         SELECT p.id, p.period_name, p.status, p.start_date, p.end_date
           FROM fiscal_periods p
          WHERE p.entity_id = e.id AND p.period_type = 'regular' AND p.start_date <= t.as_of
          ORDER BY p.start_date DESC
          LIMIT 1
       ) cp ON true
      ORDER BY e.name, e.id`,
    [caller.entityIds, caller.tenantId]
  );

  const asOfDate = result.rows[0]?.as_of_date ?? '';
  const rows: PortfolioRow[] = result.rows
    .filter((r): r is PortfolioRecord & { entity_id: string } => r.entity_id !== null)
    .map((r) => ({
      entity_id: r.entity_id,
      name: r.name,
      is_active: r.is_active,
      current_period:
        r.current_period_id === null
          ? null
          : {
              id: r.current_period_id,
              name: r.current_period_name ?? '',
              status: r.current_period_status ?? '',
              start_date: r.current_period_start ?? '',
              end_date: r.current_period_end ?? '',
            },
      ended_open_periods: r.ended_open_periods,
      pending_drafts: r.pending_drafts,
      pending_questions: r.pending_questions,
    }));

  return {
    rows,
    asOfDate,
    unresolved: caller.malformed + caller.entityIds.length - rows.length,
  };
}
