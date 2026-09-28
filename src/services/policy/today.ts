import type pg from 'pg';
import { calendarDateIn } from '../../utils/calendar-date.js';
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
  const zone = ctx
    ? (await getPolicy(ctx, TIME_ZONE_POLICY_KEY, opts.client)).value
    : defaultTimeZone();
  return calendarDateIn(zone, opts.now);
}

function defaultTimeZone(): string {
  const spec = getPolicySpec(TIME_ZONE_POLICY_KEY);
  if (!spec) throw new Error(`Policy "${TIME_ZONE_POLICY_KEY}" is missing from the catalog`);
  return spec.defaultValue;
}
