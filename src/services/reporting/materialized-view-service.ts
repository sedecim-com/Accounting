import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { queryTrialBalanceRows, totalTrialBalance, LEDGER_SCALE } from './report-service.js';

// ============================================================
// REPORTING MATERIALIZED VIEWS — domain service
//
// mv_trial_balance and mv_account_balance_summary are refreshed by a
// trigger that fires on ONE transition only: an entry becoming `posted`
// (004_partitioning_and_views.sql:87,105; hardened SECURITY DEFINER in
// 024). Every other way rows reach the ledger — a migration, a bulk load,
// a status change that is not a posting, a restore — leaves the views
// behind, and they go stale WITHOUT SAYING SO. Nothing in the product
// reads them today, but `mnemosine doctor`, an external BI tool or a
// future report will, and a silently stale balance is worse than a
// missing one.
//
// So refreshing is a COMMAND, never a side effect of a read. A report
// that quietly rebuilt a materialized view would be a read that takes an
// ACCESS EXCLUSIVE-ish lock, costs seconds, and changes what the next
// reader sees. `report view show` tells you it is stale; `report view
// sync` fixes it, declared `escritura` and closed to the agent.
//
// The refresh itself goes through refresh_reporting_views(), a
// SECURITY DEFINER function added in 031: the runtime role
// (mnemosine_app) does not own the views, and only an owner may REFRESH
// one. Calling REFRESH directly from here fails with
// "must be owner of materialized view mv_trial_balance".
//
// R3: el dueño de las vistas es mnemosine_refresher (NOLOGIN, BYPASSRLS,
// rls-policies.sql). Un REFRESH corre la consulta definitoria COMO EL
// DUEÑO; cuando el dueño era mnemosine_owner (sujeto a RLS forzada), el
// refresco reconstruía la vista global con los lentes del inquilino
// casual de la sesión — o vacía sin inquilino: devolvía «hecho» y dejaba
// cero filas para todos, y solo el detector de deriva de abajo lo veía.
// ============================================================

/** The only names the refresh function accepts, mirrored from migration 031. */
export const REPORTING_VIEWS = ['mv_trial_balance', 'mv_account_balance_summary'] as const;
export type ReportingView = (typeof REPORTING_VIEWS)[number];

export function assertKnownViews(views: string[]): ReportingView[] {
  const unknown = views.filter((v) => !(REPORTING_VIEWS as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown reporting view(s): ${unknown.join(', ')}. Known: ${REPORTING_VIEWS.join(', ')}.`
    );
  }
  return views as ReportingView[];
}

export interface RefreshResult {
  view: ReportingView;
  concurrently: boolean;
  duration_ms: number;
}

/**
 * Rebuilds the named views (all of them by default).
 *
 * CONCURRENTLY keeps readers unblocked and is the default, matching the
 * trigger. It requires the unique index each view already carries
 * (010:66, 012:39) and it CANNOT populate a view that has never been
 * populated — that is the one case for --no-concurrently.
 */
export async function refreshReportingViews(
  opts: { views?: string[]; concurrently?: boolean } = {}
): Promise<RefreshResult[]> {
  const views = assertKnownViews(opts.views?.length ? opts.views : [...REPORTING_VIEWS]);
  const concurrently = opts.concurrently ?? true;

  const results: RefreshResult[] = [];
  for (const view of views) {
    const started = Date.now();
    await query('SELECT refresh_reporting_views($1, $2)', [[view], concurrently]);
    results.push({ view, concurrently, duration_ms: Date.now() - started });
  }
  return results;
}

export interface ReportingViewStatus {
  view: ReportingView;
  /** Rows the view holds for this entity. */
  rows: number;
  /** What the VIEW says the entity's posted debits and credits are. */
  view_debits: string;
  view_credits: string;
  /** What the LEDGER says right now. */
  ledger_debits: string;
  ledger_credits: string;
  /** Signed view − ledger, so the size of the drift is visible, not just its existence. */
  drift_debits: string;
  drift_credits: string;
  is_stale: boolean;
}

/**
 * Compares each view's totals for one entity against the live ledger.
 *
 * A caveat worth stating rather than hiding: mv_trial_balance is keyed by
 * fiscal period, so its totals only cover entries that carry a
 * fiscal_period_id belonging to this entity. A posted entry outside every
 * period shows up here as drift even when the view is perfectly fresh —
 * which is itself worth knowing.
 */
export async function getReportingViewStatus(entityId: string): Promise<ReportingViewStatus[]> {
  // EN CRUDO: este cotejo no es un informe. Las vistas materializan TODO lo
  // posteado, así que si la balanza obedeciera aquí al criterio del panel
  // —que puede dejar fuera los asientos de cierre— el cotejo denunciaría una
  // deriva inventada por la política, no por las vistas.
  const ledger = totalTrialBalance(
    await queryTrialBalanceRows(entityId, { ignoreClosingPolicy: true }),
    LEDGER_SCALE
  );

  const perView: Record<ReportingView, string> = {
    mv_trial_balance: `SELECT COUNT(*)::text AS rows,
                              COALESCE(SUM(total_debits), 0)::text AS debits,
                              COALESCE(SUM(total_credits), 0)::text AS credits
                       FROM mv_trial_balance WHERE entity_id = $1`,
    mv_account_balance_summary: `SELECT COUNT(*)::text AS rows,
                              COALESCE(SUM(total_debits), 0)::text AS debits,
                              COALESCE(SUM(total_credits), 0)::text AS credits
                       FROM mv_account_balance_summary WHERE entity_id = $1`,
  };

  const statuses: ReportingViewStatus[] = [];
  for (const view of REPORTING_VIEWS) {
    const result = await query<{ rows: string; debits: string; credits: string }>(
      perView[view],
      [entityId]
    );
    const row = result.rows[0];
    const driftDebits = new Decimal(row.debits).minus(ledger.total_debits);
    const driftCredits = new Decimal(row.credits).minus(ledger.total_credits);
    statuses.push({
      view,
      rows: parseInt(row.rows, 10),
      view_debits: new Decimal(row.debits).toFixed(LEDGER_SCALE),
      view_credits: new Decimal(row.credits).toFixed(LEDGER_SCALE),
      ledger_debits: ledger.total_debits,
      ledger_credits: ledger.total_credits,
      drift_debits: driftDebits.toFixed(LEDGER_SCALE),
      drift_credits: driftCredits.toFixed(LEDGER_SCALE),
      is_stale:
        driftDebits.abs().greaterThan('0.01') || driftCredits.abs().greaterThan('0.01'),
    });
  }
  return statuses;
}
