import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, listPending, getPolicy } from '../../src/services/policy/policy-service.js';
import { getPolicySpec, type PolicySpec } from '../../src/services/policy/pending-catalog.js';
import { renderPolicies } from '../../src/cli/pending-command.js';
import { leerPanel } from '../../src/ai/tools/policy-tools.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * I10 (#152) · THE PANEL'S WORDING COMES FROM THE CATALOG, AND READING IT
 * WRITES NOTHING.
 *
 * `seedPolicies` copies question, impact, options and default_rationale into
 * every `policy_decisions` row with ON CONFLICT DO NOTHING, so a tenant seeded
 * before a rewording keeps the old text forever. The acceptance criterion is
 * two claims at once, and this file measures both against Postgres:
 *
 *   1. What the readers PAINT is the catalog's text, not the row's stale copy.
 *   2. `policy_decisions` does not change by a single byte while they do it.
 *
 * Claim 2 alone would be vacuous — a reader that paints the stale copy also
 * writes nothing. Claim 1 alone would not exclude a "fix" that refreshes the
 * row on read. Together they pin the only shape the issue allows: the row
 * keeps state, the catalog owns the words, and nobody syncs one into the other.
 */

let f: Fixture;
let ctx: AgentContext;

/** Two live catalog keys, both with options and a default rationale. */
const AGED_KEYS = ['umbral_capitalizacion_mxn', 'politica_restaurantes'] as const;
/** One aged row whose seeded default also drifted from the catalog's (a valid option). */
const DRIFTED_DEFAULT = { key: 'umbral_capitalizacion_mxn', value: '50000' } as const;

/**
 * Stale text that cannot occur in the catalog. Every aged column carries the
 * same marker so a single `not.toContain` covers all four of them.
 */
const STALE = 'STALE-I10';

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

/** Undo `renderPolicies`' wrapping: the catalog prose is compared as one run of words. */
const flat = (lines: string[]): string => lines.join(' ').replace(/\s+/g, ' ');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function specOf(key: string): PolicySpec {
  const spec = getPolicySpec(key);
  if (!spec) throw new Error(`fixture error: "${key}" is not in the catalog`);
  return spec;
}

interface Fingerprint {
  /** md5 over `row_to_json` of every row of the tenant, ordered by id. */
  rows: string;
  /**
   * md5 over each row's `id:xmin`. Stricter than `rows`: a rewrite that stores
   * the very same bytes leaves `row_to_json` identical but creates a new row
   * version. The last test in this file measures that difference instead of
   * assuming it.
   */
  versions: string;
  count: number;
}

async function fingerprint(tenantId: string): Promise<Fingerprint> {
  const { rows } = await query<Fingerprint>(
    `SELECT md5(string_agg(row_to_json(p)::text, E'\\n' ORDER BY p.id)) AS rows,
            md5(string_agg(p.id::text || ':' || p.xmin::text, ',' ORDER BY p.id)) AS versions,
            count(*)::int AS count
       FROM policy_decisions p
      WHERE p.tenant_id = $1`,
    [tenantId]
  );
  return rows[0];
}

let seeded: Fingerprint;
let aged: Fingerprint;

beforeAll(async () => {
  f = await crearInquilino('I10 panel wording');
  ctx = {
    entityId: f.entityId, entityName: 'I10 panel wording', tenantId: f.tenantId,
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };

  // Tenant scope (entity_id NULL), which is what `pending` and the init wizard seed.
  await seedPolicies({ tenantId: f.tenantId });
  seeded = await fingerprint(f.tenantId);

  // THE REAL CASE THIS SLICE FIXES: a tenant seeded before the catalog was
  // reworded. Every seeded wording column goes stale. The state columns are
  // left alone, because they are not wording.
  for (const key of AGED_KEYS) {
    const spec = specOf(key);
    const staleOptions = spec.options.map((o) => ({ value: o.value, label: `${STALE} label for ${o.value}` }));
    await query(
      `UPDATE policy_decisions
          SET question = $3, impact = $4, options = $5::jsonb, default_rationale = $6
        WHERE tenant_id = $1 AND key = $2 AND entity_id IS NULL`,
      [
        f.tenantId, key,
        `${STALE} question for ${key}?`,
        `${STALE} impact for ${key}.`,
        JSON.stringify(staleOptions),
        `${STALE} rationale for ${key}.`,
      ]
    );
  }
  // And one row whose seeded DEFAULT also differs from today's catalog. Without
  // it, "the value is still the row's seeded default" below would be measured
  // against a row and a catalog that agree, and would pass even if getPolicy
  // took the default from the catalog.
  await query(
    `UPDATE policy_decisions SET default_value = $3
      WHERE tenant_id = $1 AND key = $2 AND entity_id IS NULL`,
    [f.tenantId, DRIFTED_DEFAULT.key, DRIFTED_DEFAULT.value]
  );
  aged = await fingerprint(f.tenantId);
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('I10 · the panel paints the catalog and leaves policy_decisions untouched', () => {
  it('the fixture is the real case: the rows the readers receive carry stale wording', async () => {
    // If the aging UPDATE had matched nothing, every assertion below would pass
    // against rows that already hold the catalog text.
    expect(seeded.count, 'the seed inserted no rows').toBeGreaterThan(0);
    expect(aged.count).toBe(seeded.count);
    expect(aged.rows, 'the fingerprint did not see the wording change').not.toBe(seeded.rows);

    const pending = await listPending({ tenantId: f.tenantId });
    for (const key of AGED_KEYS) {
      const row = pending.find((p) => p.key === key);
      expect(row, `${key} is not pending`).toBeDefined();
      expect(row!.question).toContain(STALE);
      expect(row!.impact).toContain(STALE);
      expect(row!.default_rationale).toContain(STALE);
      expect(JSON.stringify(row!.options)).toContain(STALE);
    }
    // listPending is a SELECT; it is also one of the readers under test.
    expect(await fingerprint(f.tenantId)).toEqual(aged);
  }, 60_000);

  it('`pending -v` (renderPolicies over listPending) paints the catalog, and writes nothing', async () => {
    const pending = await listPending({ tenantId: f.tenantId });
    const text = flat(renderPolicies(pending, plain, { verbose: true }));

    expect(text, 'a stale seeded copy reached the screen').not.toContain(STALE);
    for (const key of AGED_KEYS) {
      const spec = specOf(key);
      expect(text).toContain(oneLine(spec.question));
      expect(text).toContain(oneLine(spec.impact));
      expect(text).toContain(oneLine(spec.defaultRationale));
      for (const o of spec.options) expect(text).toContain(oneLine(`${o.value} — ${o.label}`));
    }

    expect(await fingerprint(f.tenantId)).toEqual(aged);
  }, 60_000);

  it("the agent's panel (leerPanel) paints the catalog, and writes nothing", async () => {
    const panel = await leerPanel(ctx);

    expect(JSON.stringify(panel), 'a stale seeded copy reached the agent').not.toContain(STALE);
    for (const key of AGED_KEYS) {
      const spec = specOf(key);
      const p = panel.policies.find((x) => x.key === key);
      expect(p, `${key} missing from the panel`).toBeDefined();
      expect(p!.status).toBe('unanswered');
      expect(p!.question).toBe(spec.question);
      // Unanswered policies carry their options: those must be the catalog's too.
      expect(p!.options).toEqual(spec.options.map(({ value, label }) => ({ value, label })));
    }

    expect(await fingerprint(f.tenantId)).toEqual(aged);
  }, 60_000);

  it('getPolicy on the two aged keys answers with the catalog wording, and writes nothing', async () => {
    const drifted = specOf(DRIFTED_DEFAULT.key);
    expect(drifted.options.map((o) => o.value), 'the drifted default must be a real option').toContain(DRIFTED_DEFAULT.value);
    expect(DRIFTED_DEFAULT.value, 'the drift must actually differ from the catalog').not.toBe(drifted.defaultValue);
    for (const key of AGED_KEYS) {
      const spec = specOf(key);
      const effective = await getPolicy({ tenantId: f.tenantId, entityId: f.entityId }, key);
      expect(effective.defined).toBe(false);
      // Behaviour is untouched: the value is still the row's seeded default,
      // which for DRIFTED_DEFAULT is deliberately NOT the catalog's.
      const rowDefault = key === DRIFTED_DEFAULT.key ? DRIFTED_DEFAULT.value : spec.defaultValue;
      expect(effective.value).toBe(rowDefault);
      expect(effective.question).toBe(spec.question);
      expect(effective.rationale).toBe(spec.defaultRationale);
    }

    expect(await fingerprint(f.tenantId)).toEqual(aged);
  }, 60_000);

  it('the version fingerprint is not decoration: a same-bytes rewrite moves it and row_to_json misses it', async () => {
    // Runs LAST on purpose: it writes. It measures that `versions` catches a
    // reader "refreshing" a row with text identical to what is stored — a
    // write `rows` alone would let through.
    const before = await fingerprint(f.tenantId);
    await query(
      `UPDATE policy_decisions SET question = question
        WHERE tenant_id = $1 AND key = $2 AND entity_id IS NULL`,
      [f.tenantId, AGED_KEYS[0]]
    );
    const after = await fingerprint(f.tenantId);
    expect(after.rows, 'row_to_json saw a same-bytes rewrite').toBe(before.rows);
    expect(after.versions, 'xmin did not move on a rewrite').not.toBe(before.versions);
  }, 60_000);
});
