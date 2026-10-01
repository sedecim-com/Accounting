import type pg from 'pg';
import { calendarDateIn } from '../../utils/calendar-date.js';
import { currentTenant, query } from '../../database/connection.js';
import { getPolicy, type PolicyContext } from './policy-service.js';
import { getPolicySpec, TIME_ZONE_POLICY_KEY } from './pending-catalog.js';

/**
 * THE ONE RESOLVER OF "TODAY" (#242).
 *
 * Every date the system fills in by itself is the calendar day in the zone of
 * the `zona_horaria` policy — the entity's row when it has one, the firm's
 * otherwise, and `America/Mexico_City` when nobody answered. `getPolicy`
 * already applies that precedence.
 *
 * `ctx` is null only for a reader with no entity in hand (`getTaxParameters`,
 * whose callers are expected to pass the act date): it gets the panel's
 * declared default, which is still a zone and never the UTC day.
 *
 * `client` reads inside the caller's transaction; `now` exists for tests.
 */
export async function todayFor(
  ctx: PolicyContext | null,
  opts: { client?: pg.PoolClient; now?: Date } = {}
): Promise<string> {
  return calendarDateIn(await zoneFor(ctx, opts.client), opts.now);
}

/**
 * The `zona_horaria` in force for a context (entity row, else the firm's, else
 * the panel default), for renderers that format many instants and must not
 * read the policy once per row (MNE-001-290).
 */
export async function zoneFor(ctx: PolicyContext | null, client?: pg.PoolClient): Promise<string> {
  return ctx ? (await getPolicy(ctx, TIME_ZONE_POLICY_KEY, client)).value : defaultTimeZone();
}

/**
 * "Today" for a reader that holds an entity id but not its tenant (#242,
 * MNE-001-111): the aging reports, `invoice list` and `customer list`.
 *
 * The request's tenant is used when there is one; otherwise the entity's own
 * row says whose it is. An entity id nobody has gets the panel's default zone:
 * the caller's own entity-scoped query then returns nothing anyway, and a read
 * must not fail for the date it would have used on an empty page.
 */
export async function todayForEntity(entityId: string, opts: { now?: Date } = {}): Promise<string> {
  return calendarDateIn(await zoneForEntity(entityId), opts.now);
}

/**
 * The zone of an entity the caller holds only by id, for formatting instants
 * (MNE-001-290). Same tenant resolution and same fallback as `todayForEntity`.
 */
export async function zoneForEntity(entityId: string): Promise<string> {
  const tenantId =
    currentTenant() ??
    (await query<{ tenant_id: string }>('SELECT tenant_id FROM legal_entities WHERE id = $1', [entityId]))
      .rows[0]?.tenant_id;
  return zoneFor(tenantId ? { tenantId, entityId } : null);
}

/**
 * "Today" for a reader that holds only a customer id (`customer show`, the
 * archive guard): the day of the entity the customer belongs to.
 */
export async function todayForCustomer(customerId: string, opts: { now?: Date } = {}): Promise<string> {
  const r = await query<{ entity_id: string; tenant_id: string }>(
    `SELECT c.entity_id, e.tenant_id
       FROM customers c JOIN legal_entities e ON e.id = c.entity_id
      WHERE c.id = $1`,
    [customerId]
  );
  const row = r.rows[0];
  return todayFor(row ? { tenantId: row.tenant_id, entityId: row.entity_id } : null, opts);
}

function defaultTimeZone(): string {
  const spec = getPolicySpec(TIME_ZONE_POLICY_KEY);
  if (!spec) throw new Error(`Policy "${TIME_ZONE_POLICY_KEY}" is missing from the catalog`);
  return spec.defaultValue;
}
